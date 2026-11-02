$script:roomUserCheckedAt = [DateTime]::MinValue
$script:roomUserEnabled = $false
$script:roomUserQueued = @{}
$script:roomUserDiagnostics = [ordered]@{ enabled=$false; snapshots=0; candidates=0; queued=0; duplicate=0; missingRoomId=0; invalidIdentity=0; lastRoomId=''; lastSnapshotAt=$null }

function Get-RoomUserVisitsEnabled {
    if (([DateTime]::UtcNow - $script:roomUserCheckedAt).TotalSeconds -ge 5) {
        $script:roomUserCheckedAt = [DateTime]::UtcNow
        $script:roomUserEnabled = $false
        try {
            $control = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'collector-roomuser.json')) | ConvertFrom-Json
            $script:roomUserEnabled = $control.enabled -eq $true
        } catch { }
    }
    $script:roomUserDiagnostics.enabled = $script:roomUserEnabled
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
    param($Envelope,[string]$StreamUsername)
    if (-not (Get-RoomUserVisitsEnabled)) { return }
    $data = $Envelope.data
    $script:roomUserDiagnostics.snapshots++
    $at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $script:roomUserDiagnostics.lastSnapshotAt = $at
    $roomId = Get-RoomUserText @($data.roomId,$data.room_id,$data.common.roomId,$data.common.room_id,$Envelope.roomId)
    # Never guess the LIVE from a ranking ID, user ID, or viewer count.
    if ($roomId -notmatch '^[\w:-]{1,100}$' -or $roomId -eq '0') { $script:roomUserDiagnostics.missingRoomId++; return }
    $script:roomUserDiagnostics.lastRoomId = $roomId
    $scope = $StreamUsername.ToLowerInvariant() + ':' + $roomId
    if (-not $script:roomUserQueued.ContainsKey($scope)) {
        if ($script:roomUserQueued.Count -ge 4) { $script:roomUserQueued.Clear() }
        $script:roomUserQueued[$scope] = New-Object 'System.Collections.Generic.HashSet[string]'
    }
    $inSnapshot = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($list in @('topViewers','ranksList','ranks','seats')) {
        $entries = @($data.$list)
        foreach ($entry in @($entries | Select-Object -First 200)) {
            if ($null -eq $entry) { continue }
            $user = $entry.user
            if ($null -eq $user) { $user = $entry }
            $numeric = Get-RoomUserText @($user.userId,$user.id)
            $unique = (Get-RoomUserText @($user.uniqueId,$user.displayId,$user.unique_id)).TrimStart('@')
            if ($unique -notmatch '^[a-zA-Z0-9._]{1,120}$' -or $unique -match '^(unknown|anonymous|null|undefined)$') { $unique = '' }
            $id = if ($numeric -match '^\d{5,30}$') { $numeric } else { '' }
            if (-not $id) { $script:roomUserDiagnostics.invalidIdentity++; continue }
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
}

function Confirm-RoomUserVisitQueued {
    param($Envelope,[string]$StreamUsername)
    $scope = $StreamUsername.ToLowerInvariant() + ':' + $Envelope.data.roomId
    if ($script:roomUserQueued.ContainsKey($scope)) {
        [void]$script:roomUserQueued[$scope].Add([string]$Envelope.data.user.id)
        $script:roomUserDiagnostics.queued++
    }
}
