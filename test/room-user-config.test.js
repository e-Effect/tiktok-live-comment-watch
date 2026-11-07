import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';

function powershell(script) {
  const result=spawnSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  return result.stdout;
}

test('roomUser example is opt-in for visits and stay',()=>{
  assert.deepEqual(JSON.parse(readFileSync(new URL('../collector/windows/collector-roomuser.example.json',import.meta.url),'utf8')),
    {enabled:false,trackStay:false});
});

test('Windows config distinguishes missing, read errors, malformed JSON, types and explicit disable; repairs recover',
  {skip:process.platform!=='win32'},()=>{
  powershell(String.raw`
    $ErrorActionPreference='Stop'
    . (Join-Path (Get-Location) 'collector/windows/RoomUserVisits.ps1')
    $fixture=Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($fixture)
    $script:roomUserControlPath=Join-Path $fixture 'control.json'
    function Check($Expected,$Enabled=$false,$Stay=$false,$Field='') {
      $script:roomUserCheckedAt=[DateTime]::MinValue
      $actual=Get-RoomUserVisitsEnabled
      if ($actual -ne $Enabled -or $script:roomUserStayEnabled -ne $Stay -or
          $script:roomUserDiagnostics.configStatus -ne $Expected -or
          $script:roomUserDiagnostics.configInvalidField -ne $Field) {
        throw ($script:roomUserDiagnostics|ConvertTo-Json -Compress)
      }
      if (-not $script:roomUserDiagnostics.configCheckedAt -or -not $script:roomUserDiagnostics.configChangedAt) {throw 'Missing check timestamps'}
    }
    try {
      Check 'missing'
      foreach ($raw in @('', '{', '{"enabled":true,"trackStay":false,}broken')) {
        [IO.File]::WriteAllText($script:roomUserControlPath,$raw)
        Check 'invalid-json'
      }
      foreach ($raw in @('[]','null','true','1','"true"','[{"enabled":true,"trackStay":true}]')) {
        [IO.File]::WriteAllText($script:roomUserControlPath,$raw)
        Check 'invalid-values' $false $false 'root'
      }
      foreach ($raw in @('{}','{"trackStay":true}','{"enabled":"true","trackStay":true}',
          '{"enabled":1,"trackStay":true}','{"enabled":null,"trackStay":false}',
          '{"enabled":[],"trackStay":true}')) {
        [IO.File]::WriteAllText($script:roomUserControlPath,$raw)
        Check 'invalid-values' $false $false 'enabled'
      }
      foreach ($raw in @('{"enabled":true}','{"enabled":true,"trackStay":"true"}',
          '{"enabled":false,"trackStay":1}','{"enabled":true,"trackStay":null}',
          '{"enabled":true,"trackStay":{}}')) {
        [IO.File]::WriteAllText($script:roomUserControlPath,$raw)
        Check 'invalid-values' $false $false 'trackStay'
      }
      [IO.File]::WriteAllText($script:roomUserControlPath,'{"enabled":true,"trackStay":true}')
      $locked=[IO.File]::Open($script:roomUserControlPath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
      try { Check 'read-error' } finally { $locked.Dispose() }
      Check 'enabled' $true $true
      if ($script:roomUserDiagnostics.stopReason -ne '') {throw 'Wrong active reason'}
      $changed=$script:roomUserDiagnostics.configChangedAt
      Check 'enabled' $true $true
      if ($changed -ne $script:roomUserDiagnostics.configChangedAt) {throw 'Unchanged config changed timestamp'}
      [IO.File]::WriteAllText($script:roomUserControlPath,'{"enabled":true,"trackStay":false}')
      if (-not (Get-RoomUserVisitsEnabled) -or -not $script:roomUserStayEnabled) {throw 'Five-second cache ignored'}
      Check 'enabled' $true $false
      if ($script:roomUserDiagnostics.stopReason -ne 'track-stay-disabled') {throw 'Wrong stay reason'}
      [IO.File]::WriteAllText($script:roomUserControlPath,'{"enabled":false,"trackStay":true}')
      Check 'disabled'
      if ($script:roomUserDiagnostics.stopReason -ne 'disabled') {throw 'Wrong disabled reason'}
      [IO.File]::Delete($script:roomUserControlPath)
      $before=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      $script:roomUserCheckedAt=[DateTime]::MinValue
      $events=@(Get-RoomUserVisitEnvelopes -Envelope ([pscustomobject]@{data=@{}}) -StreamUsername host)
      if ($events.Count -or $script:roomUserDiagnostics.lastReceivedAt -lt $before) {throw 'Disabled reception not diagnosed'}
      Check 'missing'
      [IO.File]::WriteAllText($script:roomUserControlPath,'{"enabled":true,"trackStay":true}')
      Check 'enabled' $true $true
    } finally { [IO.Directory]::Delete($fixture,$true) }
  `);
});

test('Windows diagnostics and idle delivery close stay intervals on every stop; ordinary queued events still deliver',
  {skip:process.platform!=='win32'},()=>{
  const output=powershell(String.raw`
    $ErrorActionPreference='Stop'
    . (Join-Path (Get-Location) 'collector/windows/RoomUserVisits.ps1')
    $tokens=$null;$errors=$null
    $ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'collector/windows/TikFinityCollector.ps1'),[ref]$tokens,[ref]$errors)
    if ($errors.Count) {throw ($errors|Out-String)}
    foreach ($name in @('Get-CollectorDiagnostics','Invoke-CollectorDeliveryPump','Add-PendingEvent','Add-DiagnosticCount')) {
      $fn=$ast.Find({param($n)$n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
      Invoke-Expression $fn.Extent.Text
    }
    $fixture=Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($fixture)
    $script:roomUserControlPath=Join-Path $fixture 'control.json'
    $script:pendingPath=Join-Path $fixture 'pending.jsonl'
    $script:pending=New-Object 'System.Collections.Generic.Queue[string]'
    $script:roomUserVisitsAvailable=$true;$script:collectorStreamAvailable=$false
    $script:deliveryTask=$null;$script:deliveryRetryAt=[DateTime]::MinValue
    $script:lastDeliveryAttemptAt=[DateTime]::UtcNow
    $script:forwardedCounts=@{};$script:deliveryHistory=@()
    function Complete-CollectorDelivery {}
    function Save-PendingEventsIfDue {}
    function Start-CollectorDelivery {param($Config,$Heartbeat);$script:sent=$script:pending.ToArray()}
    $ids=New-Object 'System.Collections.Generic.HashSet[string]'
    [void]$ids.Add('700000000000000011')
    $base=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    try {
      $case=0
      foreach ($stop in @('disabled','invalid-json','invalid-values','missing','read-error','stay-only')) {
        [IO.File]::WriteAllText($script:roomUserControlPath,'{"enabled":true,"trackStay":true}')
        $script:roomUserCheckedAt=[DateTime]::MinValue
        [void](Get-RoomUserVisitsEnabled)
        $at=$base+$case*10000
        Update-RoomUserStay 'host:one' 'one' $ids $at
        Update-RoomUserStay 'host:one' 'one' $ids ($at+1000)
        $script:verifiedRoomId='700000000000000001'
        $script:verifiedRoomUntil=$base+600000
        $lock=$null
        switch ($stop) {
          'disabled' {[IO.File]::WriteAllText($script:roomUserControlPath,'{"enabled":false,"trackStay":false}')}
          'invalid-json' {[IO.File]::WriteAllText($script:roomUserControlPath,'{')}
          'invalid-values' {[IO.File]::WriteAllText($script:roomUserControlPath,'{"enabled":"true","trackStay":true}')}
          'missing' {[IO.File]::Delete($script:roomUserControlPath)}
          'read-error' {$lock=[IO.File]::Open($script:roomUserControlPath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
          'stay-only' {[IO.File]::WriteAllText($script:roomUserControlPath,'{"enabled":true,"trackStay":false}')}
        }
        try {
          $script:roomUserCheckedAt=[DateTime]::MinValue
          # Exercise both the diagnostics-first bug and the idle pump path.
          if ($case%2 -eq 0) {$diagnostics=Get-CollectorDiagnostics}
          else {Invoke-CollectorDeliveryPump -Config @{}}
          if ($script:roomUserStayTracks.Count) {throw ('Open tracks after '+$stop)}
          if ($stop -ne 'stay-only' -and $script:verifiedRoomId) {throw 'Old verified room retained'}
          [void](Add-PendingEvent -Raw '{"event":"chat","data":{"comment":"ordinary"}}')
          [void](Add-PendingEvent -Raw '{"event":"gift","data":{"giftId":1}}')
          Invoke-CollectorDeliveryPump -Config @{}
          if (-not $script:sent -or $script:sent.Count -ne $script:pending.Count) {throw 'Ordinary delivery stopped'}
        } finally {if ($lock) {$lock.Dispose()}}
        [IO.File]::WriteAllText($script:roomUserControlPath,'{"enabled":true,"trackStay":true}')
        $script:roomUserCheckedAt=[DateTime]::MinValue
        Invoke-CollectorDeliveryPump -Config @{}
        if (-not $script:roomUserEnabled -or -not $script:roomUserStayEnabled) {throw 'Repair did not recover'}
        Update-RoomUserStay 'host:one' 'one' $ids ($at+3000)
        Update-RoomUserStay 'host:one' 'one' $ids ($at+4000)
        Close-RoomUserStay
        $case++
      }
      $script:pending.ToArray() | ForEach-Object {$_|ConvertFrom-Json} | ConvertTo-Json -Depth 8 -Compress
    } finally {[IO.Directory]::Delete($fixture,$true)}
  `);
  const events=JSON.parse(output.trim());
  const stays=events.filter(x=>x.event==='roomUserStay');
  assert.equal(stays.length,12);
  assert.ok(stays.every(x=>x.data.lastAt-x.data.firstAt===1000),'No stopped interval may be bridged');
  assert.equal(events.filter(x=>x.event==='chat').length,6);
  assert.equal(events.filter(x=>x.event==='gift').length,6);
});

test('server exposes bounded config diagnostics, supports older collectors and omits config/exception contents',()=>{
  const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
  const start=source.indexOf('  updateCollectorDiagnostics(raw)');
  const method=source.slice(start,source.indexOf('  ingestionDiagnosticsSnapshot()',start));
  const session=vm.runInNewContext(`new(class {${method}})()`,{
    pipelineTimestamp:value=>typeof value==='number'&&Number.isFinite(value)&&value>0?value:null,Date,
  });
  const now=Date.now();
  for (const status of ['missing','read-error','invalid-json','invalid-values','disabled','enabled','module-missing']) {
    session.updateCollectorDiagnostics({roomUserVisits:{enabled:status==='enabled',stayEnabled:false,
      configStatus:status,configInvalidField:'trackStay',stopReason:status==='enabled'?'track-stay-disabled':status==='disabled'?'disabled':status==='module-missing'?'module-missing':'config-'+status,
      configCheckedAt:now,configChangedAt:now-1,lastReceivedAt:now-2,lastSnapshotAt:now-3,
      configContents:'private-key',error:'private-path'}});
    const result=session.collectorDiagnostics.roomUserVisits;
    assert.equal(result.configStatus,status);
    assert.equal(result.configInvalidField,'trackStay');
    assert.equal(result.configCheckedAt,now);
    assert.equal(result.lastReceivedAt,now-2);
    assert.doesNotMatch(JSON.stringify(result),/private/);
  }
  session.updateCollectorDiagnostics({roomUserVisits:{enabled:true}});
  assert.equal(session.collectorDiagnostics.roomUserVisits.configStatus,'unknown');
  assert.equal(session.collectorDiagnostics.roomUserVisits.configCheckedAt,null);
  session.updateCollectorDiagnostics({roomUserVisits:{configStatus:'private',stopReason:'private',configInvalidField:'private'}});
  assert.doesNotMatch(JSON.stringify(session.collectorDiagnostics.roomUserVisits),/private/);
});
