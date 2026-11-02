import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {PGlite} from '@electric-sql/pglite';
import {normalizeCollectorEvent} from '../lib/external-collector.js';
import {roomUserVisitEventId} from '../lib/room-user-visits.js';
import {EventStore} from '../lib/event-store.js';

const input={event:'roomUserVisit',collectorEventId:'stable',data:{
  roomUserVisitVersion:1,roomId:'room-one',snapshotList:'topViewers',snapshotAt:Date.parse('2026-11-03T00:00:00Z'),
  user:{id:'123456',uniqueId:'viewer',nickname:'Viewer'},
}};
test('compact roomUser visits require an actual identity, room and supported list',()=>{
  const event=normalizeCollectorEvent(input);
  assert.equal(event.type,'roomUserVisit');assert.equal(event.roomId,'room-one');
  assert.equal(event.data.user.id,'123456');assert.equal(event.at,input.data.snapshotAt);
  assert.deepEqual(input.data.user,{id:'123456',uniqueId:'viewer',nickname:'Viewer'});
  for(const patch of [{roomId:''},{user:{nickname:'not-an-id'}},{snapshotList:'suggestions'},{snapshotAt:0},
    {user:{id:7123456789012345678,uniqueId:'viewer'}},{roomUserVisitVersion:0}]){
    assert.equal(normalizeCollectorEvent({...input,data:{...input.data,...patch}}),null);
  }
  assert.equal(normalizeCollectorEvent({event:'roomUser',data:{viewerCount:50}}),null);
});

test('PowerShell only queues previously unseen IDs, uses stable retry IDs and obeys rollback',{skip:process.platform!=='win32'},()=>{
  const script=String.raw`
    $ErrorActionPreference='Stop'
    . (Join-Path (Get-Location) 'collector/windows/RoomUserVisits.ps1')
    function Get-RoomUserVisitsEnabled { return $true }
    $raw='{"data":{"roomId":"700000000000000001","viewerCount":100,"topViewers":[{"user":{"userId":"700000000000000011","uniqueId":"one","nickname":"One"}},{"user":null}],"ranks":[{"user":{"id":"700000000000000011","displayId":"one"}},{"user":{"id":"700000000000000012","displayId":"two"}},{"user":{"nickname":"not an ID"}}]}}'
    $e=$raw|ConvertFrom-Json
    $first=@(Get-RoomUserVisitEnvelopes -Envelope $e -StreamUsername 'host')
    if($first.Count -ne 2){throw ('Expected two users, got '+$first.Count)}
    $retry=@(Get-RoomUserVisitEnvelopes -Envelope $e -StreamUsername 'host')
    if($retry[0].collectorEventId -ne $first[0].collectorEventId){throw 'Retry ID changed'}
    foreach($v in $first){Confirm-RoomUserVisitQueued -Envelope $v -StreamUsername 'host'}
    for($i=0;$i -lt 50;$i++){if(@(Get-RoomUserVisitEnvelopes -Envelope $e -StreamUsername 'host').Count){throw 'Duplicate snapshot emitted'}}
    $e.data.roomId='700000000000000002'
    $next=@(Get-RoomUserVisitEnvelopes -Envelope $e -StreamUsername 'host')
    if($next.Count -ne 2 -or $next[0].collectorEventId -eq $first[0].collectorEventId){throw 'New LIVE did not get separate visits'}
    $e.data.roomId=''
    if(@(Get-RoomUserVisitEnvelopes -Envelope $e -StreamUsername 'host').Count){throw 'Missing room must not be guessed'}
    function Get-RoomUserVisitsEnabled { return $false }
    $e.data.roomId='700000000000000003'
    if(@(Get-RoomUserVisitEnvelopes -Envelope $e -StreamUsername 'host').Count){throw 'Rollback ignored'}
    $first|ConvertTo-Json -Depth 8 -Compress
  `;
  const result=spawnSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  const events=JSON.parse(result.stdout.trim());
  assert.equal(events.length,2);for(const raw of events)assert.ok(normalizeCollectorEvent(raw));
  assert.ok(Buffer.byteLength(result.stdout)<2500,'No repeated raw snapshot payload');
});

test('roomUser does not create entry timing, trigger alerts or replay an existing listener',()=>{
  const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
  const attach=source.slice(source.indexOf('  attachLiveHandlers('),source.indexOf('  markSeen('));
  const mark=source.slice(source.indexOf('  markSeen('),source.indexOf('  markHeartMe('));
  const alerts=[],queued=[],visits=[],users=new Map();
  const session=vm.runInNewContext(`new(class{
    constructor(){this.userStats=users;this.viewerStats={knownJoins:0};this.pendingVisitChecks=new Map();this.recordingEnabled=true;}
    getUserStat(id,nickname){return users.get(id)||{userId:id,nickname};}
    broadcastPresence(){}
    recordVisit(...args){visits.push(args)}
    queueDatabaseEvent(e){queued.push(e)}
    flushPendingDatabaseEvents(){return Promise.resolve()}
    currentEventSource(){return 'live'}
    emitNormalized(){}
    ${attach} ${mark}
  })()`,{users,queued,visits,roomUserVisitEventId,personFromEvent:d=>({userId:d.user.id,uniqueId:d.user.uniqueId,nickname:d.user.nickname}),
    pipelineTimestamps:()=>({}),entryDetection:()=>({}),isAnonymousListenerIdentity:()=>false,
    screenshotWatch:{accept:()=>alerts.push('screenshot')},attentionAlerts:{accept:()=>alerts.push('attention')},
    welcomeAlerts:{accept:()=>alerts.push('welcome')},queueMicrotask,Date});
  const connection=new EventEmitter();session.attachLiveHandlers(connection);
  const event=normalizeCollectorEvent(input);
  connection.emit('roomUserVisit',event.data);connection.emit('roomUserVisit',event.data);
  assert.equal(queued.length,1);assert.equal(queued[0].type,'room_user_visit');assert.equal(visits.length,0);
  assert.equal(users.get('123456').entryEventCount,0);assert.equal(users.get('123456').explicitEntryDetection,undefined);
  assert.deepEqual(alerts,[]);assert.equal(session.viewerStats.knownJoins,1);
  users.set('known',{userId:'known',hasJoined:true});
  connection.emit('roomUserVisit',{...event.data,user:{id:'known'}});
  assert.equal(queued.length,1);
});

test('a batch spanning two LIVE rooms never attributes both sets of users to one room',async()=>{
  const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('async function ingestCollectorBatch('),source.indexOf('const server = createServer('));
  const sessions=new Map(),stored=[],acknowledged=[];
  const makeSession=roomId=>({
    roomId,id:roomId,recordingEnabled:true,status:'live',updateCollectorDiagnostics(){},
    noteIngestion(){},persistSession(){},broadcastSummary(){},
    collectorBridge:{emit(type,data){stored.push({roomId,type,userId:data.user?.id})}},
    async awaitCollectorDurability(){acknowledged.push(roomId);return roomId!=='room-one'},
  });
  const ingest=vm.runInNewContext(code+';ingestCollectorBatch',{
    normalizeTikTokUsername:x=>x,isValidUsername:()=>true,normalizeCollectorEvent,
    collectorSessionForEvents:(_,events)=>{const roomId=events[0].roomId;if(!sessions.has(roomId))sessions.set(roomId,makeSession(roomId));return sessions.get(roomId)},
    isDuplicateCollectorEvent:()=>false,activateCollectorSession(){},Date,Set,
  });
  const reply=await ingest({streamUsername:'host',events:[input,{...input,collectorEventId:'other',
    data:{...input.data,roomId:'room-two',user:{id:'654321',uniqueId:'two'}}}]});
  assert.deepEqual(stored.map(row=>row.roomId),['room-one','room-two']);
  assert.equal(acknowledged.length,2);assert.equal(reply.durable,false,'Both rooms must be durably acknowledged');
});

test('real PostgreSQL persists the LIVE and provenance once across snapshots, normal entries and reconnects',async()=>{
  const db=new PGlite(),store=new EventStore();store.ready=true;
  store.pool=db;store.writePool=db;store.visitPool=db;store.resolveListenerId=async id=>id;
  try{
    await db.exec(`
      CREATE TABLE live_sessions(id text PRIMARY KEY,stream_username text,room_id text,started_at timestamptz,status text,auto_resume bool);
      CREATE TABLE viewer_visits(session_id text,stream_username text,user_id text,nickname text,first_seen_at timestamptz,last_seen_at timestamptz,first_source text,PRIMARY KEY(session_id,user_id));
      CREATE TABLE listeners(user_id text PRIMARY KEY,latest_unique_id text,latest_nickname text,avatar_url text,first_seen_at timestamptz,last_seen_at timestamptz,updated_at timestamptz);
      CREATE TABLE listener_aliases(user_id text,unique_id text,nickname text,first_seen_at timestamptz,last_seen_at timestamptz,seen_count bigint,PRIMARY KEY(user_id,unique_id,nickname));
      CREATE TABLE listener_stream_stats(stream_username text,user_id text,visit_count bigint DEFAULT 0,first_seen_at timestamptz,last_seen_at timestamptz,PRIMARY KEY(stream_username,user_id));
      CREATE TABLE live_events(event_key text PRIMARY KEY,session_id text,stream_username text,event_type text,event_at timestamptz,user_id text,unique_id text,nickname text,avatar_url text,source text,payload jsonb);
      CREATE TABLE live_event_inbox(event_key text PRIMARY KEY,session_data jsonb,event_data jsonb,received_at timestamptz DEFAULT NOW());
    `);
    const session={id:'first',roomId:'room-one',username:'host',startedAt:input.data.snapshotAt};
    const event={id:'snapshot-one',type:'room_user_visit',userId:'123456',uniqueId:'viewer',nickname:'Viewer',
      at:input.data.snapshotAt,source:'roomUser',payload:{roomId:'room-one',snapshotList:'topViewers',detection:'snapshot'}};
    assert.equal(await store.stageEvents(session,[event]),true);
    for(let i=0;i<3;i++)assert.equal(await store.recordEvent(session,{...event}),true,store.lastError);
    assert.equal((await db.query('SELECT * FROM viewer_visits')).rows.length,1);
    assert.equal((await db.query('SELECT * FROM live_events')).rows.length,1);
    assert.equal((await db.query('SELECT * FROM live_event_inbox')).rows.length,0);
    assert.equal(Number((await db.query('SELECT visit_count FROM listener_stream_stats')).rows[0].visit_count),1);
    assert.equal((await db.query('SELECT first_source FROM viewer_visits')).rows[0].first_source,'roomUser');
    // A normal entry afterwards remains the same LIVE.
    const result=await store.recordVisitBatch(session,[{userId:'123456',nickname:'Viewer',at:event.at+1000,source:'member'}]);
    assert.equal(result.get('123456').visitCount,1);
    assert.equal(await store.recordEvent({...session,id:'reconnect'},{...event}),true,store.lastError);
    assert.equal((await db.query('SELECT * FROM viewer_visits')).rows.length,1);
    // A known person already seen through another event is not inserted again.
    await db.exec("INSERT INTO viewer_visits VALUES ('first','host','known','Known',NOW(),NOW(),'member')");
    assert.equal(await store.recordEvent(session,{...event,id:'known',userId:'known'}),true);
    assert.equal((await db.query("SELECT * FROM viewer_visits WHERE user_id='known'")).rows.length,1);
    // A different actual LIVE counts once more, including after process recovery.
    const next={...session,id:'second',roomId:'room-two',startedAt:event.at+86400000};
    const second={...event,id:'snapshot-two',at:event.at+86400000,payload:{...event.payload,roomId:'room-two'}};
    await store.stageEvents(next,[second]);await store.recoverInbox();
    assert.equal((await db.query("SELECT * FROM viewer_visits WHERE user_id='123456'")).rows.length,2);
    assert.equal(Number((await db.query("SELECT visit_count FROM listener_stream_stats WHERE user_id='123456'")).rows[0].visit_count),2);
    const history=await store.listenerHistory('123456',{kind:'visits',username:'host'});
    assert.equal(history.total,2);
    assert.equal(history.items[0].broadcasts[0].roomId,'room-two');
    assert.deepEqual(history.items[0].broadcasts[0].sources,['roomUser']);
    assert.equal(await store.recordEvent({...next,roomId:'wrong'},second),false);
    assert.equal((await db.query("SELECT * FROM viewer_visits WHERE user_id='123456'")).rows.length,2);
    // Fail the atomic write, preserve the durable inbox, then recover once.
    await db.exec(`CREATE FUNCTION fail_roomuser_stats() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.user_id='failure' THEN RAISE EXCEPTION 'fixture failure'; END IF;RETURN NEW;END $$;
      CREATE TRIGGER fail_roomuser_stats BEFORE INSERT ON listener_stream_stats
      FOR EACH ROW EXECUTE FUNCTION fail_roomuser_stats();`);
    const failure={...event,id:'failure',userId:'failure'};
    await store.stageEvents(session,[failure]);
    assert.equal(await store.recordEvent(session,failure),false);
    assert.equal((await db.query("SELECT * FROM viewer_visits WHERE user_id='failure'")).rows.length,0);
    assert.equal((await db.query("SELECT * FROM live_event_inbox")).rows.length,1);
    await db.exec('DROP TRIGGER fail_roomuser_stats ON listener_stream_stats');
    await store.recoverInbox();
    assert.equal((await db.query("SELECT * FROM viewer_visits WHERE user_id='failure'")).rows.length,1);
    assert.equal((await db.query("SELECT * FROM live_event_inbox")).rows.length,0);
  }finally{await db.close();}
});
