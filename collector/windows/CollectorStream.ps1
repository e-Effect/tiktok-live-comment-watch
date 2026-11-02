$script:streamSocket = $null
$script:streamConnectTask = $null
$script:streamConnectCancel = $null
$script:streamReceiveTask = $null
$script:streamSendTask = $null
$script:streamReceiveBuffer = New-Object byte[] 16384
$script:streamReceiveMemory = New-Object IO.MemoryStream
$script:streamBatchId = ''
$script:streamBatchCount = 0
$script:streamBatchAt = [DateTime]::MinValue
$script:streamRetryAt = [DateTime]::MinValue
$script:streamFailures = 0
$script:transportCheckedAt = [DateTime]::MinValue
$script:transportMode = 'http'

function Get-CollectorTransport {
    if (([DateTime]::UtcNow - $script:transportCheckedAt).TotalSeconds -lt 5) { return $script:transportMode }
    $script:transportCheckedAt = [DateTime]::UtcNow
    $script:transportMode = 'http'
    try {
        $control = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'collector-transport.json')) | ConvertFrom-Json
        if ($control.mode -eq 'websocket') { $script:transportMode = 'websocket' }
    } catch { }
    return $script:transportMode
}

function Reset-CollectorStream {
    if ($script:streamSocket) { $script:streamSocket.Abort(); $script:streamSocket.Dispose() }
    if ($script:streamConnectCancel) { $script:streamConnectCancel.Dispose() }
    $script:streamSocket = $null; $script:streamConnectTask = $null; $script:streamConnectCancel = $null
    $script:streamReceiveTask = $null; $script:streamSendTask = $null
    $script:streamBatchId = ''; $script:streamBatchCount = 0
    $script:streamReceiveMemory.SetLength(0)
}

function Get-CollectorStreamState {
    if ($script:streamConnectTask) { return 'connecting' }
    if ($script:streamSocket -and $script:streamSocket.State -eq [Net.WebSockets.WebSocketState]::Open) {
        if ($script:streamBatchId) { return 'sending' }
        if ($script:lastRenderSuccessAt) { return 'connected' }
    }
    return 'offline'
}

function Invoke-CollectorStreamPump {
    param($Config, [bool]$Heartbeat = $false)
    if ((Get-CollectorTransport) -ne 'websocket') {
        if ($script:streamSocket) { Reset-CollectorStream }
        return $false
    }
    # A pending HTTP batch must finish before switching transports.
    if ($null -ne $script:deliveryTask) { [void](Complete-CollectorDelivery); return $true }
    $now = [DateTime]::UtcNow
    if ($now -lt $script:deliveryRetryAt -or $now -lt $script:streamRetryAt) { return $true }
    try {
        if (-not $script:streamSocket) {
            $uri = [UriBuilder]::new([string]$Config.endpoint)
            $uri.Scheme = if ($uri.Scheme -eq 'http') { 'ws' } else { 'wss' }
            $uri.Path = '/api/collector/stream'; $uri.Query = ''
            $script:streamSocket = New-Object Net.WebSockets.ClientWebSocket
            $script:streamSocket.Options.KeepAliveInterval = [TimeSpan]::FromSeconds(20)
            $script:streamSocket.Options.SetRequestHeader('Authorization', 'Bearer ' + [string]$Config.key)
            $script:streamConnectCancel = New-Object Threading.CancellationTokenSource
            $script:streamConnectCancel.CancelAfter(10000)
            $script:streamConnectTask = $script:streamSocket.ConnectAsync($uri.Uri, $script:streamConnectCancel.Token)
        }
        if ($script:streamConnectTask) {
            if (-not $script:streamConnectTask.IsCompleted) { return $true }
            [void]$script:streamConnectTask.GetAwaiter().GetResult()
            $script:streamConnectTask = $null
        }
        if ($script:streamSocket.State -ne [Net.WebSockets.WebSocketState]::Open) { throw 'Collector stream closed' }
        if ($script:streamReceiveTask -and $script:streamReceiveTask.IsCompleted) {
            $received = $script:streamReceiveTask.GetAwaiter().GetResult()
            $script:streamReceiveTask = $null
            if ($received.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) { throw 'Collector stream closed' }
            $script:streamReceiveMemory.Write($script:streamReceiveBuffer, 0, $received.Count)
            if ($script:streamReceiveMemory.Length -gt 65536) { throw 'Collector acknowledgement exceeds limit' }
            if ($received.EndOfMessage) {
                $ack = [Text.Encoding]::UTF8.GetString($script:streamReceiveMemory.ToArray()) | ConvertFrom-Json
                $script:streamReceiveMemory.SetLength(0)
                if (-not $script:streamBatchId -or $ack.batchId -ne $script:streamBatchId -or $ack.durable -ne $true) { throw 'Collector batch was not confirmed' }
                for ($i=0; $i -lt $script:streamBatchCount; $i++) { [void]$script:pending.Dequeue() }
                if ($script:streamBatchCount) { $script:pendingFileDirty = $true }
                $script:deliveryAccepted += [long]$ack.accepted; $script:deliveryDropped += [long]$ack.dropped
                $script:lastRenderSuccessAt = [DateTime]::UtcNow.ToString('o'); $script:lastRenderError = ''
                $script:streamBatchId = ''; $script:streamBatchCount = 0; $script:streamFailures = 0
                if ($script:deliveryHistory.Count -and -not $script:deliveryHistory[-1].recoveredAt) {
                    $script:deliveryHistory[-1].recoveredAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); Save-DeliveryHistory
                }
                Write-CollectorStatus -State 'connected' -Message 'Realtime delivery confirmed; queued IDs retained until ACK.' -PendingCount $script:pending.Count
            }
        }
        if (-not $script:streamReceiveTask) {
            $segment = [ArraySegment[byte]]::new($script:streamReceiveBuffer)
            $script:streamReceiveTask = $script:streamSocket.ReceiveAsync($segment,[Threading.CancellationToken]::None)
        }
        if ($script:streamSendTask) {
            if (-not $script:streamSendTask.IsCompleted) { return $true }
            [void]$script:streamSendTask.GetAwaiter().GetResult(); $script:streamSendTask = $null
        }
        if ($script:streamBatchId) {
            if (($now - $script:streamBatchAt).TotalSeconds -gt 15) { throw 'Collector acknowledgement timed out' }
            return $true
        }
        if (($now - $script:lastDeliveryAttemptAt).TotalMilliseconds -lt 100) { return $true }
        if ($script:pending.Count -eq 0 -and -not $Heartbeat -and ($now - $script:lastDeliveryAttemptAt).TotalSeconds -lt 30) { return $true }
        $take = [Math]::Min(100,$script:pending.Count)
        $events = @($script:pending.ToArray() | Select-Object -First $take | ForEach-Object { $_ | ConvertFrom-Json })
        $script:streamBatchId = [Guid]::NewGuid().ToString('N'); $script:streamBatchCount = $take; $script:streamBatchAt = $now
        $payload = @{batchId=$script:streamBatchId;streamUsername=[string]$Config.streamUsername;collectorId=[string]$env:COMPUTERNAME;heartbeat=($take -eq 0);events=@($events);diagnostics=(Get-CollectorDiagnostics)} | ConvertTo-Json -Depth 100 -Compress
        $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
        if ($bytes.Length -gt 1900000) { throw 'Collector batch exceeds limit' }
        $script:lastDeliveryAttemptAt = $now
        $script:streamSendTask = $script:streamSocket.SendAsync([ArraySegment[byte]]::new($bytes),[Net.WebSockets.WebSocketMessageType]::Text,$true,[Threading.CancellationToken]::None)
    } catch {
        $script:streamFailures++
        $limited = $_.Exception.ToString() -match '\b429\b'
        $seconds = if ($limited) { 120 } else { [Math]::Min(60,3*[Math]::Pow(2,[Math]::Min(5,$script:streamFailures-1))) }
        $script:streamRetryAt = [DateTime]::UtcNow.AddSeconds($seconds)
        $script:lastRenderError = 'Realtime transfer unavailable; pending IDs are retained.'
        $script:deliveryHistory = @($script:deliveryHistory | Select-Object -Last 19) + @([pscustomobject]@{at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();kind='websocket';httpStatus=$(if($limited){429}else{$null});errorType=$_.Exception.GetBaseException().GetType().Name;pending=$script:pending.Count;retrySeconds=$seconds;recoveredAt=$null})
        Save-DeliveryHistory; Reset-CollectorStream
        Write-CollectorStatus -State 'waiting' -Message $script:lastRenderError -PendingCount $script:pending.Count -Force
    }
    return $true
}
