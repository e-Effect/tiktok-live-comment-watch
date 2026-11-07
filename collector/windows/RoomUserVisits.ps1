$script:roomUserCheckedAt = [DateTime]::MinValue
$script:roomUserEnabled = $false
$script:roomUserStayEnabled = $false
$script:roomUserStayScope = ''
$script:roomUserStayRoom = ''
$script:roomUserStayTracks = @{}
$script:roomUserQueued = @{}
$script:roomUserControlPath = Join-Path $PSScriptRoot 'collector-roomuser.json'
$script:roomUserDiagnostics = [ordered]@{ enabled=$false; stayEnabled=$false; stayQueued=0; stayWriteFailures=0; snapshots=0; rankingFrames=0; verifiedRoomFrames=0; roomLookupStatus='idle'; candidates=0; queued=0; duplicate=0; missingRoomId=0; invalidIdentity=0; lastRoomId=''; lastSnapshotAt=$null }
$script:roomUserDiagnostics.configStatus = 'unchecked'
$script:roomUserDiagnostics.configInvalidField = ''
$script:roomUserDiagnostics.configCheckedAt = $null
$script:roomUserDiagnostics.configChangedAt = $null
$script:roomUserDiagnostics.stopReason = 'config-unchecked'
$script:roomUserDiagnostics.lastReceivedAt = $null
$script:roomLookupTask = $null
$script:roomLookupRequest = $null
$script:roomLookupGeneration = 0
$script:roomLookupSentGeneration = 0
$script:roomLookupNextAt = 0
$script:verifiedRoomId = ''
$script:verifiedRoomUntil = 0

function Reset-VerifiedRoom {
    $script:roomLookupGeneration++
    $script:verifiedRoomId = ''
    $script:verifiedRoomUntil = 0
    $script:roomLookupNextAt = 0
}

function Update-VerifiedRoom {
    param($Config,[long]$At)
    if ($script:roomLookupTask -and $script:roomLookupTask.IsCompleted) {
        try {
            $response = $script:roomLookupTask.GetAwaiter().GetResult()
            try {
                if ($script:roomLookupGeneration -eq $script:roomLookupSentGeneration) {
                    $script:verifiedRoomId = ''
                    $script:verifiedRoomUntil = 0
                    if ($response.IsSuccessStatusCode) {
                        $info = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
                        if ([string]$info.roomId -match '^\d{15,25}$' -and [int]$info.validForMs -gt 0) {
                            $script:verifiedRoomId = [string]$info.roomId
                            $script:verifiedRoomUntil = $script:roomLookupStartedAt + [Math]::Min(22000,[int]$info.validForMs)
                        }
                        $script:roomUserDiagnostics.roomLookupStatus = if ($script:verifiedRoomId) { 'verified' } else { 'not-verified' }
                    } else { $script:roomUserDiagnostics.roomLookupStatus = 'http-error' }
                }
            } finally { $response.Dispose() }
        } catch { $script:roomUserDiagnostics.roomLookupStatus = 'request-error' }
        finally {
            $script:roomLookupRequest.Dispose()
            $script:roomLookupRequest = $null
            $script:roomLookupTask = $null
        }
    }
    if ($script:roomLookupTask -or $At -lt $script:roomLookupNextAt) { return }
    $script:roomLookupNextAt = $At + 12000
    $endpoint = [string]$Config.endpoint
    if ($endpoint -notmatch '^https://[^/]+/api/collector/events$') { return }
    $url = $endpoint -replace '/events$',('/live-room?username=' + [Uri]::EscapeDataString([string]$Config.streamUsername))
    try {
        $script:roomLookupRequest = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $url)
        $script:roomLookupRequest.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer',[string]$Config.key)
        $script:roomLookupSentGeneration = $script:roomLookupGeneration
        $script:roomLookupStartedAt = $At
        $script:roomLookupTask = $http.SendAsync($script:roomLookupRequest)
    } catch {
        $script:roomUserDiagnostics.roomLookupStatus = 'request-error'
        if ($script:roomLookupRequest) { $script:roomLookupRequest.Dispose(); $script:roomLookupRequest = $null }
    }
}

function Get-RoomUserVisitsEnabled {
    if (([DateTime]::UtcNow - $script:roomUserCheckedAt).TotalSeconds -ge 5) {
        $script:roomUserCheckedAt = [DateTime]::UtcNow
        $enabled = $false
        $stayEnabled = $false
        $status = 'read-error'
        $invalidField = ''
        $rawControl = $null
        try {
            $rawControl = [IO.File]::ReadAllText($script:roomUserControlPath)
        } catch {
            $cause = $_.Exception.GetBaseException()
            if ($cause -is [IO.FileNotFoundException] -or $cause -is [IO.DirectoryNotFoundException]) { $status = 'missing' }
        }
        if ($null -ne $rawControl) {
            try {
                if ([string]::IsNullOrWhiteSpace($rawControl)) { throw 'Empty JSON' }
                $control = ConvertFrom-Json -InputObject $rawControl -ErrorAction Stop
                $status = 'invalid-values'
                if (-not $rawControl.TrimStart().StartsWith('{') -or $control -isnot [pscustomobject]) { $invalidField = 'root' }
                elseif ($control.enabled -isnot [bool]) { $invalidField = 'enabled' }
                elseif ($control.trackStay -isnot [bool]) { $invalidField = 'trackStay' }
                else {
                    $enabled = $control.enabled
                    $stayEnabled = $enabled -and $control.trackStay
                    $status = if ($enabled) { 'enabled' } else { 'disabled' }
                }
            } catch { $status = 'invalid-json'; $invalidField = '' }
        }
        # End at the last actual observation, never at the config-check time.
        # This also runs when diagnostics or an idle pump discovers the change.
        if (-not $stayEnabled) { Close-RoomUserStay }
        if ($script:roomUserEnabled -and -not $enabled) { Reset-VerifiedRoom }
        $checkedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $reason = if ($status -eq 'enabled') { if ($stayEnabled) { '' } else { 'track-stay-disabled' } }
                  elseif ($status -eq 'disabled') { 'disabled' } else { 'config-' + $status }
        if ($status -ne $script:roomUserDiagnostics.configStatus -or $reason -ne $script:roomUserDiagnostics.stopReason -or
            $invalidField -ne $script:roomUserDiagnostics.configInvalidField) {
            $script:roomUserDiagnostics.configChangedAt = $checkedAt
        }
        $script:roomUserEnabled = $enabled
        $script:roomUserStayEnabled = $stayEnabled
        $script:roomUserDiagnostics.configStatus = $status
        $script:roomUserDiagnostics.configInvalidField = $invalidField
        $script:roomUserDiagnostics.configCheckedAt = $checkedAt
        $script:roomUserDiagnostics.stopReason = $reason
    }
    $script:roomUserDiagnostics.enabled = $script:roomUserEnabled
    $script:roomUserDiagnostics.stayEnabled = $script:roomUserStayEnabled
    return $script:roomUserEnabled
}

function Get-RoomUserText {
    param([object[]]$Values)
    foreach ($value in $Values) {
        if ($null -ne $value -and -not [string]::IsNullOrWhiteSpace([string]$value)) { return ([string]$value).Trim() }
    }
    return ''
}

function Get-RoomUserVisitEnvelopes {
    param($Envelope,[string]$StreamUsername,$Config)
    $script:roomUserDiagnostics.lastReceivedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if (-not (Get-RoomUserVisitsEnabled)) { Close-RoomUserStay; return }
    $data = $Envelope.data
    $script:roomUserDiagnostics.snapshots++
    $at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($script:roomUserDiagnostics.lastSnapshotAt -and $at - $script:roomUserDiagnostics.lastSnapshotAt -gt 15000) {
        Reset-VerifiedRoom
    }
    $script:roomUserDiagnostics.lastSnapshotAt = $at
    $rankingKnown = $data.topViewers -is [array] -or $data.ranksList -is [array] -or $data.ranks -is [array]
    if ($rankingKnown) { $script:roomUserDiagnostics.rankingFrames++ }
    $roomId = Get-RoomUserText @($data.roomId,$data.room_id,$data.common.roomId,$data.common.room_id,$Envelope.roomId)
    if ((-not $roomId -or $roomId -eq '0') -and $Config -and ($rankingKnown -or $data.seats -is [array])) {
        Update-VerifiedRoom -Config $Config -At $at
        if ($at -lt $script:verifiedRoomUntil) {
            $roomId = $script:verifiedRoomId
            $script:roomUserDiagnostics.verifiedRoomFrames++
        }
    }
    # Never guess the LIVE from a ranking ID, user ID, or viewer count.
    if ($roomId -notmatch '^[\w:-]{1,100}$' -or $roomId -eq '0') { $script:roomUserDiagnostics.missingRoomId++; return }
    $script:roomUserDiagnostics.lastRoomId = $roomId
    $scope = $StreamUsername.ToLowerInvariant() + ':' + $roomId
    if (-not $script:roomUserQueued.ContainsKey($scope)) {
        if ($script:roomUserQueued.Count -ge 4) { $script:roomUserQueued.Clear() }
        $script:roomUserQueued[$scope] = New-Object 'System.Collections.Generic.HashSet[string]'
    }
    $inSnapshot = New-Object 'System.Collections.Generic.HashSet[string]'
    $ranked = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($list in @('topViewers','ranksList','ranks','seats')) {
        $entries = @($data.$list)
        foreach ($entry in @($entries | Select-Object -First 200)) {
            if ($null -eq $entry) { continue }
            $user = $entry.user
            if ($null -eq $user) { $user = $entry }
            $numeric = Get-RoomUserText @($user.userId,$user.id,$user.user_id,$user.idStr)
            $unique = (Get-RoomUserText @($user.uniqueId,$user.displayId,$user.unique_id)).TrimStart('@')
            if ($unique -notmatch '^[a-zA-Z0-9._]{1,120}$' -or $unique -match '^(unknown|anonymous|null|undefined)$') { $unique = '' }
            $id = if ($numeric -match '^\d{5,30}$') { $numeric } else { '' }
            if (-not $id) { $script:roomUserDiagnostics.invalidIdentity++; continue }
            if ($list -ne 'seats') { [void]$ranked.Add($id) }
            if (-not $inSnapshot.Add($id)) { continue }
            $script:roomUserDiagnostics.candidates++
            if ($script:roomUserQueued[$scope].Contains($id)) { $script:roomUserDiagnostics.duplicate++; continue }
            $nickname = Get-RoomUserText @($user.nickname,$user.nickName,$unique,$id)
            $nestedAvatar = ''
            if ($user.avatarThumb -and $user.avatarThumb.urlList) { $nestedAvatar = $user.avatarThumb.urlList[0] }
            $avatar = Get-RoomUserText @($user.avatarUrl,$user.profilePictureUrl,$nestedAvatar)
            $hash = [Security.Cryptography.SHA256]::Create()
            try { $key = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes('roomUser:'+$scope+':'+$id)))).Replace('-','').ToLowerInvariant() } finally { $hash.Dispose() }
            [pscustomobject]@{
                event='roomUserVisit'; collectorEventId=('roomUser-'+$key)
                data=[pscustomobject]@{
                    roomUserVisitVersion=1; roomId=$roomId; snapshotList=$list; snapshotAt=$at; at=$at
                    user=[pscustomobject]@{ id=$id; userId=$id; uniqueId=$unique; nickname=$nickname.Substring(0,[Math]::Min(200,$nickname.Length)); avatarUrl=$avatar.Substring(0,[Math]::Min(1000,$avatar.Length)) }
                }
            }
        }
    }
    if (-not $script:roomUserStayEnabled) { Close-RoomUserStay }
    elseif ($rankingKnown) { Update-RoomUserStay -Scope $scope -RoomId $roomId -Ranked $ranked -At $at }
}

function Flush-IdleRoomUserStay {
    [void](Get-RoomUserVisitsEnabled)
    if ($script:roomUserStayTracks.Count -and $script:roomUserDiagnostics.lastSnapshotAt -and
        [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $script:roomUserDiagnostics.lastSnapshotAt -gt 45000) {
        Close-RoomUserStay
    }
}

function Write-RoomUserStaySegment {
    param([string]$UserId,$Track)
    if ($Track.last -le $Track.first) { return }
    $event = @{
        event='roomUserStay'
        collectorEventId=('roomStay-'+$script:roomUserStayRoom+'-'+$UserId+'-'+$Track.first+'-'+$Track.last)
        data=@{roomId=$script:roomUserStayRoom; userId=$UserId; firstAt=$Track.first; lastAt=$Track.last}
    }
    try {
        [void](Add-PendingEvent -Raw ($event | ConvertTo-Json -Depth 4 -Compress))
        $script:roomUserDiagnostics.stayQueued++
        Add-DiagnosticCount -Bucket $script:forwardedCounts -Name 'roomUserStay'
    } catch { $script:roomUserDiagnostics.stayWriteFailures++ }
}

function Close-RoomUserStay {
    foreach ($id in @($script:roomUserStayTracks.Keys)) {
        Write-RoomUserStaySegment -UserId $id -Track $script:roomUserStayTracks[$id]
        $script:roomUserStayTracks.Remove($id)
    }
    $script:roomUserStayScope = ''
    $script:roomUserStayRoom = ''
}

function Update-RoomUserStay {
    param([string]$Scope,[string]$RoomId,$Ranked,[long]$At)
    if ($script:roomUserStayScope -ne $Scope) { Close-RoomUserStay }
    $script:roomUserStayScope = $Scope
    $script:roomUserStayRoom = $RoomId
    foreach ($id in @($script:roomUserStayTracks.Keys)) {
        $track = $script:roomUserStayTracks[$id]
        # Do not extend an interval over an absent sample or an upstream gap.
        if (-not $Ranked.Contains($id) -or $At -lt $track.last -or $At-$track.last -gt 45000) {
            Write-RoomUserStaySegment -UserId $id -Track $track
            $script:roomUserStayTracks.Remove($id)
        }
    }
    foreach ($id in $Ranked) {
        if (-not $script:roomUserStayTracks.ContainsKey($id)) {
            $script:roomUserStayTracks[$id] = @{first=$At;last=$At}
            continue
        }
        $track = $script:roomUserStayTracks[$id]
        $track.last = $At
        if ($At-$track.first -ge 60000) {
            Write-RoomUserStaySegment -UserId $id -Track $track
            $track.first = $At
        }
    }
}

function Confirm-RoomUserVisitQueued {
    param($Envelope,[string]$StreamUsername)
    $scope = $StreamUsername.ToLowerInvariant() + ':' + $Envelope.data.roomId
    if ($script:roomUserQueued.ContainsKey($scope)) {
        [void]$script:roomUserQueued[$scope].Add([string]$Envelope.data.user.id)
        $script:roomUserDiagnostics.queued++
    }
}
