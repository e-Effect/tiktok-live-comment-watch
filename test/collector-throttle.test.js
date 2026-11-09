import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('collector batches requests and respects 429 Retry-After without losing queued events',{skip:process.platform!=='win32'},()=>{
  const script=String.raw`
  $ErrorActionPreference='Stop';Add-Type -AssemblyName System.Net.Http
  $tokens=$null;$errors=$null
  $ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'collector/windows/TikFinityCollector.ps1'),[ref]$tokens,[ref]$errors)
  if($errors.Count){throw ($errors|Out-String)}
  foreach($name in @('Start-CollectorDelivery','Complete-CollectorDelivery')){
    $fn=$ast.Find({param($n)$n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
    Invoke-Expression $fn.Extent.Text
  }
  function Save-DeliveryHistory {}
  function Write-CollectorStatus {}
  $script:deliveryTask=$null;$script:deliveryRetryAt=[DateTime]::MinValue
  $script:lastDeliveryAttemptAt=[DateTime]::UtcNow;$script:deliveryMinimumIntervalMs=2000
  if(Start-CollectorDelivery -Config ([pscustomobject]@{})){throw 'Rapid request was not batched'}
  $script:pending=New-Object 'System.Collections.Generic.Queue[string]';$script:pending.Enqueue('preserved-id')
  $script:deliveryBatchCount=1;$script:deliveryFailureCount=0;$script:deliveryHistory=@()
  $response=[System.Net.Http.HttpResponseMessage]::new([Enum]::ToObject([System.Net.HttpStatusCode],429))
  $response.Content=New-Object System.Net.Http.StringContent('<html>challenge payload must not be retained</html>')
  $response.Headers.RetryAfter=[System.Net.Http.Headers.RetryConditionHeaderValue]::new([TimeSpan]::FromSeconds(180))
  $completion=New-Object 'System.Threading.Tasks.TaskCompletionSource[System.Net.Http.HttpResponseMessage]';$completion.SetResult($response)
  $script:deliveryTask=$completion.Task;$script:deliveryRequest=$null
  [void](Complete-CollectorDelivery)
  if($script:pending.Peek() -ne 'preserved-id'){throw 'Pending event was discarded'}
  if(($script:deliveryRetryAt-[DateTime]::UtcNow).TotalSeconds -lt 179){throw ('Retry-After was ignored: '+$script:lastRenderError+' '+($script:deliveryHistory|ConvertTo-Json -Compress))}
  if($script:lastRenderError -match '<html>|challenge payload'){throw 'Challenge HTML leaked into diagnostics'}
  if($script:deliveryHistory[-1].httpStatus -ne 429){throw 'Rate limit not classified'}
  $fixture=[IO.Path]::GetTempFileName()
  try{
    $now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    [IO.File]::WriteAllText($fixture,('[{"at":'+$now+',"httpStatus":503,"retrySeconds":3,"recoveredAt":null},{"at":'+$now+',"httpStatus":429,"retrySeconds":10,"recoveredAt":null}]'))
    $deliveryHistoryPath=$fixture;$deliveryRetryAt=[DateTime]::MinValue
    $source=[IO.File]::ReadAllText((Join-Path (Get-Location) 'collector/windows/TikFinityCollector.ps1'))
    $start=$source.IndexOf('$deliveryHistory = @()');$end=$source.IndexOf('$lastStatusWriteAt =')
    Invoke-Expression $source.Substring($start,$end-$start)
    if($deliveryHistory.Count -ne 2 -or $deliveryHistory[-1].httpStatus -ne 429){throw 'Restart nested the failure history'}
    # Compare the restored deadline itself, not time left after PowerShell startup
    # and filesystem work. A slow CI runner must not shorten the expected window.
    $expectedRetryAt=[DateTimeOffset]::FromUnixTimeMilliseconds($now).UtcDateTime.AddSeconds(120)
    if($deliveryRetryAt -ne $expectedRetryAt){throw ('Restart discarded the existing cooldown: expected '+$expectedRetryAt.ToString('o')+' actual '+$deliveryRetryAt.ToString('o'))}
  }finally{[IO.File]::Delete($fixture)}
  Write-Output 'PASS'
  `;
  const r=spawnSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/PASS/);
});
