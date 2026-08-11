param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'collector-config.json')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$statusPath = Join-Path $PSScriptRoot 'collector-status.json'
$logPath = Join-Path $PSScriptRoot 'collector.log'
$tikFinityUrl = 'ws://127.0.0.1:21213/'
$allowedEvents = @(
    'chat', 'comment', 'gift', 'member', 'join', 'follow', 'share', 'social',
    'like', 'subscribe', 'subscription', 'superfan', 'superfanjoin',
    'roomuser', 'roomuserseq', 'streamend', 'control', 'room'
)
$http = New-Object System.Net.Http.HttpClient
$http.Timeout = [TimeSpan]::FromSeconds(70)
$pending = New-Object 'System.Collections.Generic.Queue[string]'

function Write-CollectorStatus {
    param([string]$State, [string]$Message, [int]$PendingCount = 0)
    $now = [DateTime]::Now.ToString('o')
    $status = [ordered]@{
        state = $State
        message = $Message
        pending = $PendingCount
        updatedAt = $now
    }
    $status | ConvertTo-Json -Compress | Set-Content -LiteralPath $statusPath -Encoding UTF8
    "[$now] $State - $Message" | Add-Content -LiteralPath $logPath -Encoding UTF8
    if ((Get-Item -LiteralPath $logPath -ErrorAction SilentlyContinue).Length -gt 1048576) {
        Get-Content -LiteralPath $logPath -Tail 500 | Set-Content -LiteralPath "$logPath.tmp" -Encoding UTF8
        Move-Item -LiteralPath "$logPath.tmp" -Destination $logPath -Force
    }
}

function Read-CollectorConfig {
    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        throw "Missing config file: $ConfigPath"
    }
    $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace([string]$config.endpoint)) { throw 'Missing endpoint.' }
    if ([string]::IsNullOrWhiteSpace([string]$config.key)) { throw 'Missing key.' }
    if ([string]::IsNullOrWhiteSpace([string]$config.streamUsername)) { throw 'Missing streamUsername.' }
    return $config
}

function Send-CollectorPayload {
    param($Config, [object[]]$Events, [bool]$Heartbeat = $false)
    $payload = [ordered]@{
        streamUsername = [string]$Config.streamUsername
        collectorId = [string]$env:COMPUTERNAME
        heartbeat = $Heartbeat
        events = @($Events)
    } | ConvertTo-Json -Depth 100 -Compress

    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, [string]$Config.endpoint)
    $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', [string]$Config.key)
    $request.Content = [System.Net.Http.StringContent]::new($payload, [Text.Encoding]::UTF8, 'application/json')
    try {
        $response = $http.SendAsync($request).GetAwaiter().GetResult()
        $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) {
            throw "Render response $([int]$response.StatusCode): $text"
        }
        return $text
    }
    finally {
        $request.Dispose()
    }
}

function Flush-PendingEvents {
    param($Config)
    if ($pending.Count -eq 0) { return }
    $take = [Math]::Min(25, $pending.Count)
    $rawBatch = $pending.ToArray() | Select-Object -First $take
    $events = @()
    foreach ($raw in $rawBatch) {
        try { $events += ($raw | ConvertFrom-Json) } catch {}
    }
    if ($events.Count -eq 0) {
        for ($i = 0; $i -lt $take; $i++) { [void]$pending.Dequeue() }
        return
    }
    $responseText = Send-CollectorPayload -Config $Config -Events $events
    $delivery = $responseText | ConvertFrom-Json
    if ($delivery.durable -ne $true) { return $false }
    for ($i = 0; $i -lt $take; $i++) { [void]$pending.Dequeue() }
    return $true
}

Write-CollectorStatus -State 'starting' -Message 'Waiting for TikFinity.'

while ($true) {
    $socket = $null
    try {
        $config = Read-CollectorConfig
        $socket = New-Object System.Net.WebSockets.ClientWebSocket
        $socket.ConnectAsync([Uri]$tikFinityUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
        [void](Send-CollectorPayload -Config $config -Events @() -Heartbeat $true)
        while ($pending.Count -gt 0) {
            if (-not (Flush-PendingEvents -Config $config)) { break }
        }
        Write-CollectorStatus -State 'connected' -Message 'Connected to TikFinity and Render.' -PendingCount $pending.Count

        $buffer = New-Object byte[] 65536
        while ($socket.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
            $memory = New-Object System.IO.MemoryStream
            do {
                $segment = [System.ArraySegment[byte]]::new($buffer)
                $receiveTask = $socket.ReceiveAsync($segment, [Threading.CancellationToken]::None)
                while (-not $receiveTask.Wait(60000)) {
                    [void](Send-CollectorPayload -Config $config -Events @() -Heartbeat $true)
                    while ($pending.Count -gt 0) {
                        if (-not (Flush-PendingEvents -Config $config)) { break }
                    }
                    Write-CollectorStatus -State 'connected' -Message 'Connected to TikFinity; waiting for events.' -PendingCount $pending.Count
                }
                $result = $receiveTask.GetAwaiter().GetResult()
                if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { break }
                $memory.Write($buffer, 0, $result.Count)
            } while (-not $result.EndOfMessage)

            if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
                $memory.Dispose()
                break
            }
            $raw = [Text.Encoding]::UTF8.GetString($memory.ToArray())
            $memory.Dispose()
            try {
                $event = $raw | ConvertFrom-Json
                $eventType = [string]$event.event
                if ([string]::IsNullOrWhiteSpace($eventType)) { $eventType = [string]$event.type }
                if ([string]::IsNullOrWhiteSpace($eventType)) { $eventType = [string]$event.eventType }
            }
            catch {
                $eventType = ''
            }
            if ($allowedEvents -contains $eventType.ToLowerInvariant()) {
                if ($pending.Count -ge 5000) { [void]$pending.Dequeue() }
                $pending.Enqueue($raw)
                Flush-PendingEvents -Config $config
                Write-CollectorStatus -State 'receiving' -Message "Received: $eventType" -PendingCount $pending.Count
            }
        }
    }
    catch {
        Write-CollectorStatus -State 'waiting' -Message $_.Exception.Message -PendingCount $pending.Count
    }
    finally {
        if ($socket) { $socket.Dispose() }
    }
    Start-Sleep -Seconds 3
}
