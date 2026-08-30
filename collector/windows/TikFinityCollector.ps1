param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'collector-config.json')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$statusPath = Join-Path $PSScriptRoot 'collector-status.json'
$logPath = Join-Path $PSScriptRoot 'collector.log'
$pendingPath = Join-Path $PSScriptRoot 'collector-pending.jsonl'
$receiptPendingPath = Join-Path $PSScriptRoot 'receipt-pending.jsonl'
$tikFinityUrl = 'ws://127.0.0.1:21213/'
$allowedEvents = @(
    'chat', 'comment', 'gift', 'member', 'join', 'follow', 'share', 'social',
    'like', 'subscribe', 'subscription', 'superfan', 'superfanjoin',
    'roomuser', 'roomuserseq', 'streamend', 'control', 'room'
)
$http = New-Object System.Net.Http.HttpClient
$http.Timeout = [TimeSpan]::FromSeconds(15)
$receiptHttp = New-Object System.Net.Http.HttpClient
$receiptHttp.Timeout = [TimeSpan]::FromMilliseconds(750)
$lastReceiptAttemptAt = [DateTime]::MinValue
$pending = New-Object 'System.Collections.Generic.Queue[string]'
$lastPendingFlushAt = [DateTime]::MinValue
$receiptPending = New-Object 'System.Collections.Generic.Queue[string]'
$receiptPendingKeys = New-Object 'System.Collections.Generic.HashSet[string]'
$collectorStartedAt = [DateTime]::UtcNow.ToString('o')
$receivedCounts = @{}
$forwardedCounts = @{}
$unknownCounts = @{}
$receiptDiagnostics = [ordered]@{
    reachable = $false
    printerReady = $false
    printerVerified = $false
    tikfinity = 'unknown'
    queueCount = 0
    sharedReceiptPendingCount = 0
    checkedAt = $null
}

function Add-DiagnosticCount {
    param([hashtable]$Bucket, [string]$Name)
    $key = ([string]$Name).Trim().ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($key)) { $key = '(blank)' }
    if ($key.Length -gt 60) { $key = $key.Substring(0, 60) }
    if ($Bucket.ContainsKey($key)) { $Bucket[$key] = [int64]$Bucket[$key] + 1 }
    else { $Bucket[$key] = [int64]1 }
}

function Get-CollectorDiagnostics {
    return [ordered]@{
        startedAt = $script:collectorStartedAt
        updatedAt = [DateTime]::UtcNow.ToString('o')
        receivedByType = $script:receivedCounts
        forwardedByType = $script:forwardedCounts
        unknownByType = $script:unknownCounts
        pendingEvents = $script:pending.Count
        pendingReceiptEvents = $script:receiptPending.Count
        receipt = $script:receiptDiagnostics
    }
}

function Write-CollectorStatus {
    param([string]$State, [string]$Message, [int]$PendingCount = 0)
    $now = [DateTime]::Now.ToString('o')
    $status = [ordered]@{
        state = $State
        message = $Message
        pending = $PendingCount
        updatedAt = $now
        diagnostics = Get-CollectorDiagnostics
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
        diagnostics = Get-CollectorDiagnostics
    } | ConvertTo-Json -Depth 100 -Compress

    Send-LocalReceiptPayload -Config $Config -Events $Events -Heartbeat $Heartbeat

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

function Send-LocalReceiptPayload {
    param($Config, [object[]]$Events, [bool]$Heartbeat = $false)

    $receiptEndpoint = 'http://127.0.0.1:3210/api/collector/events'
    if ($Config.PSObject.Properties.Name -contains 'receiptEndpoint') {
        $configured = [string]$Config.receiptEndpoint
        if ($configured -eq 'off') { return }
        if (-not [string]::IsNullOrWhiteSpace($configured)) { $receiptEndpoint = $configured }
    }

    $newGiftCount = 0
    foreach ($event in @($Events)) {
        $eventType = [string]$event.event
        if ([string]::IsNullOrWhiteSpace($eventType)) { $eventType = [string]$event.type }
        if ([string]::IsNullOrWhiteSpace($eventType)) { $eventType = [string]$event.eventType }
        if ($eventType -ieq 'gift') {
            $rawGift = $event | ConvertTo-Json -Depth 100 -Compress
            if ($script:receiptPendingKeys.Add($rawGift)) {
                if ($script:receiptPending.Count -ge 500) {
                    $removed = $script:receiptPending.Dequeue()
                    [void]$script:receiptPendingKeys.Remove($removed)
                }
                $script:receiptPending.Enqueue($rawGift)
                $newGiftCount++
            }
        }
    }
    if ($newGiftCount -gt 0) { Save-ReceiptPending }

    $now = [DateTime]::UtcNow
    if (-not $Heartbeat -and $newGiftCount -eq 0 -and ($now - $script:lastReceiptAttemptAt).TotalSeconds -lt 30) {
        return
    }
    $script:lastReceiptAttemptAt = $now

    $take = [Math]::Min(25, $script:receiptPending.Count)
    $receiptEvents = @()
    foreach ($rawGift in ($script:receiptPending.ToArray() | Select-Object -First $take)) {
        try { $receiptEvents += ($rawGift | ConvertFrom-Json) } catch {}
    }
    $localPayload = [ordered]@{
        collectorId = [string]$env:COMPUTERNAME
        heartbeat = $Heartbeat -or $receiptEvents.Count -eq 0
        events = @($receiptEvents)
    } | ConvertTo-Json -Depth 100 -Compress
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, $receiptEndpoint)
    $request.Content = [System.Net.Http.StringContent]::new($localPayload, [Text.Encoding]::UTF8, 'application/json')
    try {
        $response = $receiptHttp.SendAsync($request).GetAwaiter().GetResult()
        [void]$response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $success = $response.IsSuccessStatusCode
        $response.Dispose()
        if (-not $success) { return }
        for ($index = 0; $index -lt $take; $index++) {
            $removed = $script:receiptPending.Dequeue()
            [void]$script:receiptPendingKeys.Remove($removed)
        }
        if ($take -gt 0) { Save-ReceiptPending }
        if ($Heartbeat) { Update-ReceiptDiagnostics -ReceiptEndpoint $receiptEndpoint }
    }
    catch {
        # Receipt printing is local and optional; Render delivery must continue even while it is closed.
    }
    finally {
        $request.Dispose()
    }
}

function Update-ReceiptDiagnostics {
    param([string]$ReceiptEndpoint)
    $statusEndpoint = $ReceiptEndpoint -replace '/api/collector/events$', '/api/status'
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $statusEndpoint)
    try {
        $response = $receiptHttp.SendAsync($request).GetAwaiter().GetResult()
        $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) { throw "Receipt status $([int]$response.StatusCode)" }
        $status = $text | ConvertFrom-Json
        $script:receiptDiagnostics = [ordered]@{
            reachable = $true
            printerReady = $status.printerReady -eq $true
            printerVerified = $status.printerVerified -eq $true
            printer = [string]$status.printer
            tikfinity = [string]$status.tikfinity
            queueCount = [int]$status.queueCount
            sharedReceiptPendingCount = [int]$status.sharedReceiptPendingCount
            lastEvent = [string]$status.lastEvent
            lastPrintAt = [string]$status.lastPrintAt
            lastPrintError = [string]$status.lastPrintError
            checkedAt = [DateTime]::UtcNow.ToString('o')
        }
        $response.Dispose()
    }
    catch {
        $script:receiptDiagnostics = [ordered]@{
            reachable = $false
            printerReady = $false
            printerVerified = $false
            tikfinity = 'unknown'
            queueCount = $script:receiptPending.Count
            sharedReceiptPendingCount = 0
            error = $_.Exception.Message
            checkedAt = [DateTime]::UtcNow.ToString('o')
        }
    }
    finally {
        $request.Dispose()
    }
}

function Save-ReceiptPending {
    $tempPath = "$receiptPendingPath.tmp"
    @($script:receiptPending.ToArray()) | Set-Content -LiteralPath $tempPath -Encoding UTF8
    Move-Item -LiteralPath $tempPath -Destination $receiptPendingPath -Force
}

function Load-ReceiptPending {
    if (-not (Test-Path -LiteralPath $receiptPendingPath)) { return }
    foreach ($line in Get-Content -LiteralPath $receiptPendingPath -Encoding UTF8) {
        $raw = [string]$line
        if ([string]::IsNullOrWhiteSpace($raw) -or -not $script:receiptPendingKeys.Add($raw)) { continue }
        $script:receiptPending.Enqueue($raw)
    }
}

function Save-PendingEvents {
    $tempPath = "$pendingPath.tmp"
    @($script:pending.ToArray()) | Set-Content -LiteralPath $tempPath -Encoding UTF8
    Move-Item -LiteralPath $tempPath -Destination $pendingPath -Force
}

function Load-PendingEvents {
    if (-not (Test-Path -LiteralPath $pendingPath)) { return }
    foreach ($line in Get-Content -LiteralPath $pendingPath -Encoding UTF8) {
        $raw = [string]$line
        if ([string]::IsNullOrWhiteSpace($raw)) { continue }
        try {
            [void]($raw | ConvertFrom-Json)
            $script:pending.Enqueue($raw)
        }
        catch {
            "[$([DateTime]::Now.ToString('o'))] skipped unreadable pending event" | Add-Content -LiteralPath $logPath -Encoding UTF8
        }
    }
}

function Add-PendingEvent {
    param([string]$Raw)
    if ([string]::IsNullOrWhiteSpace($Raw)) { return }
    $Raw | Add-Content -LiteralPath $pendingPath -Encoding UTF8
    $script:pending.Enqueue($Raw)
}

function Flush-PendingEvents {
    param($Config)
    if ($pending.Count -eq 0) { return }
    $script:lastPendingFlushAt = [DateTime]::UtcNow
    $take = [Math]::Min(25, $pending.Count)
    $rawBatch = $pending.ToArray() | Select-Object -First $take
    $events = @()
    foreach ($raw in $rawBatch) {
        try { $events += ($raw | ConvertFrom-Json) } catch {}
    }
    if ($events.Count -eq 0) {
        for ($i = 0; $i -lt $take; $i++) { [void]$pending.Dequeue() }
        Save-PendingEvents
        return
    }
    $responseText = Send-CollectorPayload -Config $Config -Events $events
    $delivery = $responseText | ConvertFrom-Json
    if ($delivery.durable -ne $true) { return $false }
    for ($i = 0; $i -lt $take; $i++) { [void]$pending.Dequeue() }
    Save-PendingEvents
    return $true
}

Load-PendingEvents
Load-ReceiptPending
Write-CollectorStatus -State 'starting' -Message 'Waiting for TikFinity.' -PendingCount ($pending.Count + $receiptPending.Count)

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
                $lastHeartbeatAt = [DateTime]::UtcNow
                while (-not $receiveTask.Wait(250)) {
                    $now = [DateTime]::UtcNow
                    if ($pending.Count -gt 0 -and ($now - $script:lastPendingFlushAt).TotalMilliseconds -ge 200) {
                        [void](Flush-PendingEvents -Config $config)
                    }
                    if (($now - $lastHeartbeatAt).TotalSeconds -ge 60) {
                        [void](Send-CollectorPayload -Config $config -Events @() -Heartbeat $true)
                        $lastHeartbeatAt = $now
                        while ($pending.Count -gt 0) {
                            if (-not (Flush-PendingEvents -Config $config)) { break }
                        }
                        Write-CollectorStatus -State 'connected' -Message 'Connected to TikFinity; waiting for events.' -PendingCount $pending.Count
                    }
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
            Add-DiagnosticCount -Bucket $script:receivedCounts -Name $eventType
            if ($allowedEvents -contains $eventType.ToLowerInvariant()) {
                Add-DiagnosticCount -Bucket $script:forwardedCounts -Name $eventType
                Add-PendingEvent -Raw $raw
                if ($pending.Count -ge 25) { [void](Flush-PendingEvents -Config $config) }
                Write-CollectorStatus -State 'receiving' -Message "Received: $eventType" -PendingCount $pending.Count
            }
            else {
                Add-DiagnosticCount -Bucket $script:unknownCounts -Name $eventType
                Write-CollectorStatus -State 'connected' -Message "Ignored event type: $eventType" -PendingCount $pending.Count
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
