import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('receipt pump never awaits pending HTTP and only dequeues acknowledged batch', {skip:process.platform!=='win32'},()=>{
  const script = `
  $ErrorActionPreference='Stop'
  Add-Type -AssemblyName System.Net.Http
  $tokens=$null;$errors=$null
  $ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'collector/windows/TikFinityCollector.ps1'),[ref]$tokens,[ref]$errors)
  if($errors.Count){throw ($errors | Out-String)}
  foreach($name in @('Send-LocalReceiptPayload','Complete-ReceiptDelivery','Update-ReceiptDiagnostics')){
    $fn=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
    Invoke-Expression $fn.Extent.Text
  }
  function Save-ReceiptPending {}
  $script:receiptPending=New-Object 'System.Collections.Generic.Queue[string]'
  $script:receiptPendingKeys=New-Object 'System.Collections.Generic.HashSet[string]'
  foreach($v in @('a','b','c')){$script:receiptPending.Enqueue($v);[void]$script:receiptPendingKeys.Add($v)}
  $completion=New-Object 'System.Threading.Tasks.TaskCompletionSource[System.Net.Http.HttpResponseMessage]'
  $script:receiptDeliveryTask=$completion.Task
  $script:receiptDeliveryCount=2
  $script:receiptStatusTask=$null
  $script:receiptDeliveryRequest=New-Object System.Net.Http.HttpRequestMessage
  $clock=[Diagnostics.Stopwatch]::StartNew()
  Send-LocalReceiptPayload -Config ([pscustomobject]@{}) -Events @() -Heartbeat $false
  if($clock.ElapsedMilliseconds -gt 500){throw 'Pending HTTP blocked receive pump'}
  if($script:receiptPending.Count -ne 3){throw 'Unacknowledged batch removed'}
  $response=New-Object System.Net.Http.HttpResponseMessage([System.Net.HttpStatusCode]::OK)
  $completion.SetResult($response)
  Complete-ReceiptDelivery
  if($script:receiptPending.Count -ne 1 -or $script:receiptPending.Peek() -ne 'c'){throw 'Wrong batch removed'}
  $completion=New-Object 'System.Threading.Tasks.TaskCompletionSource[System.Net.Http.HttpResponseMessage]'
  $script:receiptDeliveryTask=$completion.Task;$script:receiptDeliveryCount=1
  $completion.SetException([Exception]::new('offline'))
  Complete-ReceiptDelivery
  if($script:receiptPending.Count -ne 1){throw 'Failed batch lost'}
  Write-Output 'PASS'
  `;
  const r=spawnSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/PASS/);
});
