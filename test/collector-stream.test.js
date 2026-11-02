import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {WebSocket} from 'ws';
import {attachCollectorStream} from '../lib/collector-stream.js';

test('stream authenticates, preserves durable ACK and accepts retries',async()=>{
  const server=createServer(),received=new Set();
  const stream=attachCollectorStream(server,{authorize:r=>r.headers.authorization==='Bearer test-only',ingest:async body=>{
    body.events.forEach(e=>received.add(e.id));return {durable:true,accepted:body.events.length,dropped:0};
  }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='ws://127.0.0.1:'+server.address().port+'/api/collector/stream';
  try{
    const denied=await new Promise(resolve=>{const ws=new WebSocket(url);ws.on('unexpected-response',(_r,res)=>{resolve(res.statusCode);res.destroy();});ws.on('error',()=>{});});assert.equal(denied,401);
    const client=new WebSocket(url,{headers:{Authorization:'Bearer test-only'}});await new Promise(resolve=>client.once('open',resolve));
    for(let i=0;i<2;i++){
      const reply=new Promise(resolve=>client.once('message',bytes=>resolve(JSON.parse(bytes))));
      client.send(JSON.stringify({batchId:'retry-'+i,events:[{id:'stable'}]}));assert.equal((await reply).durable,true);
    }
    assert.equal(received.size,1);client.close();
  }finally{stream.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('PowerShell stream drains a burst without two-second waits and replays a lost ACK safely',{skip:process.platform!=='win32'},async()=>{
  const server=createServer(),recorded=new Set();let lost=false,latestSocket,requests=0;
  server.on('connection',socket=>{latestSocket=socket;});
  const stream=attachCollectorStream(server,{authorize:r=>r.headers.authorization==='Bearer fixture-key',ingest:async body=>{
    requests++;body.events.forEach(e=>recorded.add(e.collectorEventId));
    if(!lost&&body.events.length){lost=true;latestSocket.destroy();}
    return {durable:true,accepted:body.events.length,dropped:0};
  }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const script=String.raw`
  $ErrorActionPreference='Stop';Add-Type -AssemblyName System.Net.Http
  . (Join-Path (Get-Location) 'collector/windows/CollectorStream.ps1')
  function Get-CollectorTransport {return 'websocket'}
  function Get-CollectorDiagnostics {return @{pendingEvents=$script:pending.Count}}
  function Write-CollectorStatus {}
  function Save-DeliveryHistory {}
  $script:pending=New-Object 'System.Collections.Generic.Queue[string]'
  for($i=0;$i -lt 120;$i++){$script:pending.Enqueue((@{event='chat';collectorEventId=('fixture-'+$i);data=@{comment='test'}}|ConvertTo-Json -Compress))}
  $script:deliveryTask=$null;$script:deliveryRetryAt=[DateTime]::MinValue;$script:lastDeliveryAttemptAt=[DateTime]::MinValue
  $script:deliveryAccepted=0;$script:deliveryDropped=0;$script:deliveryHistory=@();$script:lastRenderSuccessAt=$null
  $config=[pscustomobject]@{endpoint='http://127.0.0.1:${server.address().port}/api/collector/events';key='fixture-key';streamUsername='fixture'}
  $clock=[Diagnostics.Stopwatch]::StartNew()
  try{
    while($script:pending.Count -and $clock.ElapsedMilliseconds -lt 12000){[void](Invoke-CollectorStreamPump -Config $config);Start-Sleep -Milliseconds 10}
    if($script:pending.Count){throw ('Queue remained: '+$script:pending.Count+' '+$script:lastRenderError)}
    Write-Output ('PASS '+$clock.ElapsedMilliseconds)
  }finally{Reset-CollectorStream}
  `;
  try{
    const result=await new Promise(resolve=>{
      const child=spawn('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')]);let stdout='',stderr='';
      child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('exit',status=>resolve({status,stdout,stderr}));
    });
    assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/PASS/);assert.equal(recorded.size,120);assert.ok(requests>=3);
  }finally{stream.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
