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
    'streamend', 'control', 'room'
)
$localOnlyEvents = @('roomuser', 'roomuserseq')
$http = New-Object System.Net.Http.HttpClient
$http.Timeout = [TimeSpan]::FromSeconds(15)
$receiptHttp = New-Object System.Net.Http.HttpClient
$receiptHttp.Timeout = [TimeSpan]::FromMilliseconds(750)
$lastReceiptAttemptAt = [DateTime]::MinValue
$pending = New-Object 'System.Collections.Generic.Queue[string]'
$receiptPending = New-Object 'System.Collections.Generic.Queue[string]'
$receiptPendingKeys = New-Object 'System.Collections.Generic.HashSet[string]'
$collectorStartedAt = [DateTime]::UtcNow.ToString('o')
$receivedCounts = @{}
$forwardedCounts = @{}
$unknownCounts = @{}
$deliveryAccepted = [int64]0
$deliveryDropped = [int64]0
$deliveryTask = $null
$deliveryRequest = $null
$deliveryBatchCount = 0
$deliveryRetryAt = [DateTime]::MinValue
$deliveryFailureCount = 0
$lastDeliveryAttemptAt = [DateTime]::MinValue
$lastRenderSuccessAt = $null
$lastRenderError = ''
$lastStatusWriteAt = [DateTime]::MinValue
$lastStatusLogAt = [DateTime]::MinValue
$lastPendingSaveAt = [DateTime]::UtcNow
$pendingFileDirty = $false
$lastReceiptHeartbeatAt = [DateTime]::MinValue
$lastReceivedEventType = ''
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
        serverAccepted = $script:deliveryAccepted
        serverDropped = $script:deliveryDropped
        pendingEvents = $script:pending.Count
        pendingReceiptEvents = $script:receiptPending.Count
        deliveryInFlight = $null -ne $script:deliveryTask
        renderState = if ($null -ne $script:deliveryTask) { 'sending' } elseif ($script:pending.Count -gt 0) { 'buffering' } else { 'connected' }
        lastRenderSuccessAt = $script:lastRenderSuccessAt
        lastRenderError = $script:lastRenderError
        renderRetryAt = if ($script:deliveryRetryAt -gt [DateTime]::UtcNow) { $script:deliveryRetryAt.ToString('o') } else { $null }
        receipt = $script:receiptDiagnostics
    }
}

function Write-CollectorStatus {
    param([string]$State, [string]$Message, [int]$PendingCount = 0, [switch]$Force)
    $nowValue = [DateTime]::Now
    if (-not $Force -and ($nowValue - $script:lastStatusWriteAt).TotalMilliseconds -lt 1000) { return }
    $script:lastStatusWriteAt = $nowValue
    $now = $nowValue.ToString('o')
    $status = [ordered]@{
        state = $State
        message = $Message
        pending = $PendingCount
        updatedAt = $now
        diagnostics = Get-CollectorDiagnostics
    }
    $status | ConvertTo-Json -Compress | Set-Content -LiteralPath $statusPath -Encoding UTF8
    if ($Force -or ($nowValue - $script:lastStatusLogAt).TotalSeconds -ge 10) {
        $script:lastStatusLogAt = $nowValue
        "[$now] $State - $Message" | Add-Content -LiteralPath $logPath -Encoding UTF8
        if ((Get-Item -LiteralPath $logPath -ErrorAction SilentlyContinue).Length -gt 1048576) {
            Get-Content -LiteralPath $logPath -Tail 500 | Set-Content -LiteralPath "$logPath.tmp" -Encoding UTF8
            Move-Item -LiteralPath "$logPath.tmp" -Destination $logPath -Force
        }
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

function Start-CollectorDelivery {
    param($Config, [bool]$Heartbeat = $false)
    if ($null -ne $script:deliveryTask) { return $false }
    if ([DateTime]::UtcNow -lt $script:deliveryRetryAt) { return $false }

    $take = [Math]::Min(25, $script:pending.Count)
    if ($take -eq 0 -and -not $Heartbeat) { return $false }
    $rawBatch = @($script:pending.ToArray() | Select-Object -First $take)
    $events = @()
    foreach ($raw in $rawBatch) {
        try { $events += ($raw | ConvertFrom-Json) } catch {}
    }
    if ($take -gt 0 -and $events.Count -eq 0) {
        for ($index = 0; $index -lt $take; $index++) { [void]$script:pending.Dequeue() }
        $script:pendingFileDirty = $true
        Save-PendingEventsIfDue -Force
        return $false
    }

    $payload = [ordered]@{
        streamUsername = [string]$Config.streamUsername
        collectorId = [string]$env:COMPUTERNAME
        heartbeat = $Heartbeat -and $events.Count -eq 0
        events = @($events)
        diagnostics = Get-CollectorDiagnostics
    } | ConvertTo-Json -Depth 100 -Compress
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, [string]$Config.endpoint)
    $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', [string]$Config.key)
    $request.Content = [System.Net.Http.StringContent]::new($payload, [Text.Encoding]::UTF8, 'application/json')
    $script:deliveryRequest = $request
    $script:deliveryBatchCount = $take
    $script:lastDeliveryAttemptAt = [DateTime]::UtcNow
    try {
        # Keep the HTTP request asynchronous. TikFinity's WebSocket must keep
        # being read while Render is slow or temporarily unavailable.
        $script:deliveryTask = $http.SendAsync($request)
        return $true
    }
    catch {
        $request.Dispose()
        $script:deliveryRequest = $null
        $script:deliveryBatchCount = 0
        throw
    }
}

function Complete-CollectorDelivery {
    if ($null -eq $script:deliveryTask -or -not $script:deliveryTask.IsCompleted) { return $false }
    $response = $null
    $completedBatchCount = $script:deliveryBatchCount
    $deliverySucceeded = $false
    try {
        $response = $script:deliveryTask.GetAwaiter().GetResult()
        $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) {
            throw "Render response $([int]$response.StatusCode): $text"
        }
        $delivery = $text | ConvertFrom-Json
        if ($delivery.durable -ne $true) { throw 'Render did not confirm durable storage.' }
        $script:deliveryAccepted += [int64]([Math]::Max(0, [int]$delivery.accepted))
        $script:deliveryDropped += [int64]([Math]::Max(0, [int]$delivery.dropped))
        for ($index = 0; $index -lt $script:deliveryBatchCount; $index++) {
            if ($script:pending.Count -gt 0) { [void]$script:pending.Dequeue() }
        }
        if ($script:deliveryBatchCount -gt 0) { $script:pendingFileDirty = $true }
        $script:deliveryFailureCount = 0
        $script:deliveryRetryAt = [DateTime]::MinValue
        $script:lastRenderSuccessAt = [DateTime]::UtcNow.ToString('o')
        $script:lastRenderError = ''
        $deliverySucceeded = $true
    }
    catch {
        $script:deliveryFailureCount++
        $delaySeconds = [Math]::Min(60, [Math]::Max(3, [Math]::Pow(2, [Math]::Min(5, $script:deliveryFailureCount - 1)) * 3))
        $script:deliveryRetryAt = [DateTime]::UtcNow.AddSeconds($delaySeconds)
        $script:lastRenderError = $_.Exception.Message
        Write-CollectorStatus -State 'receiving' -Message "Render is unavailable; buffering $($script:pending.Count) events locally." -PendingCount $script:pending.Count -Force
    }
    finally {
        if ($response) { $response.Dispose() }
        if ($script:deliveryRequest) { $script:deliveryRequest.Dispose() }
        $script:deliveryTask = $null
        $script:deliveryRequest = $null
        $script:deliveryBatchCount = 0
    }
    if ($deliverySucceeded) {
        $state = if ($completedBatchCount -gt 0) { 'receiving' } else { 'connected' }
        $message = if ($script:pending.Count -gt 0) {
            "Delivered $completedBatchCount events; $($script:pending.Count) remain buffered."
        }
        elseif ($completedBatchCount -gt 0) {
            "Delivered $completedBatchCount events; local buffer is empty."
        }
        else {
            'Connected to TikFinity and Render; waiting for events.'
        }
        Write-CollectorStatus -State $state -Message $message -PendingCount $script:pending.Count
    }
    return $true
}

function Invoke-CollectorDeliveryPump {
    param($Config, [bool]$Heartbeat = $false)
    [void](Complete-CollectorDelivery)
    Save-PendingEventsIfDue
    if ($null -ne $script:deliveryTask -or [DateTime]::UtcNow -lt $script:deliveryRetryAt) { return }
    $heartbeatDue = $Heartbeat -or ([DateTime]::UtcNow - $script:lastDeliveryAttemptAt).TotalSeconds -ge 60
    if ($script:pending.Count -gt 0) {
        [void](Start-CollectorDelivery -Config $Config)
    }
    elseif ($heartbeatDue) {
        [void](Start-CollectorDelivery -Config $Config -Heartbeat $true)
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
    $lines = [string[]]@($script:receiptPending.ToArray())
    [IO.File]::WriteAllLines($tempPath, $lines, [Text.Encoding]::UTF8)
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
    $lines = [string[]]@($script:pending.ToArray())
    [IO.File]::WriteAllLines($tempPath, $lines, [Text.Encoding]::UTF8)
    Move-Item -LiteralPath $tempPath -Destination $pendingPath -Force
}

function Save-PendingEventsIfDue {
    param([switch]$Force)
    if (-not $script:pendingFileDirty) { return }
    $now = [DateTime]::UtcNow
    if (-not $Force -and ($now - $script:lastPendingSaveAt).TotalMilliseconds -lt 1000) { return }
    Save-PendingEvents
    $script:lastPendingSaveAt = $now
    $script:pendingFileDirty = $false
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
    $queuedRaw = $Raw
    try {
        $eventEnvelope = $Raw | ConvertFrom-Json
        $receivedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        if (-not ($eventEnvelope.PSObject.Properties.Name -contains 'collectorEventId')) {
            $eventEnvelope | Add-Member -NotePropertyName collectorEventId -NotePropertyValue ([Guid]::NewGuid().ToString('N'))
        }
        if (-not ($eventEnvelope.PSObject.Properties.Name -contains 'collectorReceivedAt')) {
            $eventEnvelope | Add-Member -NotePropertyName collectorReceivedAt -NotePropertyValue $receivedAt
        }
        $queuedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        if ($eventEnvelope.PSObject.Properties.Name -contains 'collectorQueuedAt') {
            $eventEnvelope.collectorQueuedAt = $queuedAt
        }
        else {
            $eventEnvelope | Add-Member -NotePropertyName collectorQueuedAt -NotePropertyValue $queuedAt
        }
        $queuedRaw = $eventEnvelope | ConvertTo-Json -Depth 100 -Compress
    }
    catch {
        # The caller already validates normal TikFinity envelopes. Keep the raw
        # value as a last-resort queue entry if a future payload shape differs.
    }
    $queuedRaw | Add-Content -LiteralPath $pendingPath -Encoding UTF8
    $script:pending.Enqueue($queuedRaw)
    return $queuedRaw
}

Load-PendingEvents
Load-ReceiptPending
Write-CollectorStatus -State 'starting' -Message 'Waiting for TikFinity.' -PendingCount ($pending.Count + $receiptPending.Count) -Force

while ($true) {
    $socket = $null
    try {
        $config = Read-CollectorConfig
        $socket = New-Object System.Net.WebSockets.ClientWebSocket
        $socket.ConnectAsync([Uri]$tikFinityUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
        Invoke-CollectorDeliveryPump -Config $config -Heartbeat $true
        Send-LocalReceiptPayload -Config $config -Events @() -Heartbeat $true
        $script:lastReceiptHeartbeatAt = [DateTime]::UtcNow
        Write-CollectorStatus -State 'connected' -Message 'Connected to TikFinity; Render delivery runs in background.' -PendingCount $pending.Count -Force

        $buffer = New-Object byte[] 65536
        while ($socket.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
            $memory = New-Object System.IO.MemoryStream
            do {
                $segment = [System.ArraySegment[byte]]::new($buffer)
                $receiveTask = $socket.ReceiveAsync($segment, [Threading.CancellationToken]::None)
                while (-not $receiveTask.Wait(50)) {
                    $now = [DateTime]::UtcNow
                    Invoke-CollectorDeliveryPump -Config $config
                    if (-not [string]::IsNullOrWhiteSpace($script:lastReceivedEventType) -and ($now - $script:lastStatusWriteAt.ToUniversalTime()).TotalMilliseconds -ge 1000) {
                        Write-CollectorStatus -State 'receiving' -Message "Received: $($script:lastReceivedEventType)" -PendingCount $pending.Count
                        $script:lastReceivedEventType = ''
                    }
                    if (($now - $script:lastReceiptHeartbeatAt).TotalSeconds -ge 60) {
                        Send-LocalReceiptPayload -Config $config -Events @() -Heartbeat $true
                        $script:lastReceiptHeartbeatAt = $now
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
            $script:lastReceivedEventType = $eventType
            if ($localOnlyEvents -contains $eventType.ToLowerInvariant()) {
                # Viewer-count events contain no dependable full viewer roster.
                # Keep the local diagnostic count, but do not use disk/network
                # bandwidth for data that is no longer shown by the viewer.
                $script:lastReceivedEventType = ''
            }
            elseif ($allowedEvents -contains $eventType.ToLowerInvariant()) {
                Add-DiagnosticCount -Bucket $script:forwardedCounts -Name $eventType
                $queuedRaw = Add-PendingEvent -Raw $raw
                if ($eventType -ieq 'gift') {
                    try { Send-LocalReceiptPayload -Config $config -Events @(($queuedRaw | ConvertFrom-Json)) -Heartbeat $false } catch {}
                }
                Invoke-CollectorDeliveryPump -Config $config
                Write-CollectorStatus -State 'receiving' -Message "Received: $eventType" -PendingCount $pending.Count
            }
            else {
                Add-DiagnosticCount -Bucket $script:unknownCounts -Name $eventType
                Write-CollectorStatus -State 'connected' -Message "Ignored event type: $eventType" -PendingCount $pending.Count
            }
        }
    }
    catch {
        # Only a TikFinity/WebSocket failure reaches this outer handler.
        # Render delivery failures are absorbed by the background pump so they
        # cannot disconnect TikFinity or stop comment collection.
        Write-CollectorStatus -State 'waiting' -Message $_.Exception.Message -PendingCount $pending.Count -Force
    }
    finally {
        if ($socket) { $socket.Dispose() }
        Save-PendingEventsIfDue -Force
    }
    Start-Sleep -Seconds 3
}
