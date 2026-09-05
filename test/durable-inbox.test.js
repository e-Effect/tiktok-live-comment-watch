import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { EventStore } from "../lib/event-store.js";

const source = await readFile(new URL("../server.js", import.meta.url), "utf8");
function sessionHarness(store) {
  const methods = source.slice(source.indexOf("  async awaitCollectorDurability()"), source.indexOf("  persistSession(options)"));
  const Harness = new Function("eventStore", `return class {
    constructor() { this.id='test'; this.recordingEnabled=true; this.pendingDatabaseEvents=[]; this.databaseFlushPromise=null; this.queued=[]; }
    noteIngestion() {}
    enqueuePersistence(event) { this.queued.push(event); }
    ${methods}
  }`)(store);
  return new Harness();
}

test("collector ACK waits for inbox commit, not listener aggregation", async () => {
  let commit;
  const committed = new Promise(resolve => { commit = resolve; });
  const h = sessionHarness({ status: () => ({ready:true}), stageEvents: () => committed });
  h.queueDatabaseEvent({id:"a", type:"gift"});
  let acknowledged = false;
  const ack = h.awaitCollectorDurability().then(value => { acknowledged=value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(acknowledged,false);
  assert.equal(h.queued.length,0);
  commit(true);
  await ack;
  assert.equal(acknowledged,true);
  assert.equal(h.queued.length,1);
});

test("failed durable append keeps the PC copy and retries without losing events", async () => {
  let succeeds=false;
  const h=sessionHarness({status:()=>({ready:true}),stageEvents:async()=>succeeds});
  h.queueDatabaseEvent({id:"a",type:"comment"});
  assert.equal(await h.awaitCollectorDurability(),false);
  assert.equal(h.pendingDatabaseEvents.length,1);
  succeeds=true;
  assert.equal(await h.awaitCollectorDurability(),true);
  assert.equal(h.pendingDatabaseEvents.length,0);
  assert.equal(h.queued.length,1);
});

test("arrivals during an inbox append are included before acknowledgement", async () => {
  let commit;
  let calls=0;
  const h=sessionHarness({status:()=>({ready:true}),stageEvents:()=>++calls===1
    ? new Promise(resolve=>{commit=resolve;}) : Promise.resolve(true)});
  h.queueDatabaseEvent({id:"a",type:"gift"});
  const ack=h.awaitCollectorDurability();
  h.queueDatabaseEvent({id:"b",type:"comment"});
  commit(true);
  assert.equal(await ack,true);
  assert.deepEqual(h.queued.map(e=>e.id),["a","b"]);
});

test("durable batch has stable keys and commits once for multiple events", async () => {
  const store=new EventStore(); store.ready=true;
  const queries=[];
  store.pool={query:async(sql,args)=>{queries.push({sql,args});return {rows:[]};}};
  assert.equal(await store.stageEvents({id:"s",username:"u",startedAt:1},[{id:"a"},{id:"b"}]),true);
  assert.equal(queries.length,1);
  assert.match(queries[0].sql,/ON CONFLICT \(event_key\) DO NOTHING/);
  assert.deepEqual(JSON.parse(queries[0].args[1]).map(e=>e.key),["s:a","s:b"]);
});

test("restart recovers only persisted inbox contents, with no realtime side effects", async () => {
  const store=new EventStore(); store.ready=true;
  const events=[];
  store.pool={query:async()=>({rows:[]})};
  store.pendingInbox=async(limit,excluded)=>{assert.deepEqual(excluded,["active"]);return [{session:{id:"s",username:"u",startedAt:1},event:{id:"a"}}];};
  store.recordEvent=async(s,e)=>{events.push(`${s.id}:${e.id}`);return true;};
  await store.recoverInbox(["active"]);
  assert.deepEqual(events,["s:a"]);
  assert.equal(store.status().inboxRecovery.recovered,1);
});

test("inbox removal and idempotent listener totals use the same SQL transaction", async () => {
  const store=new EventStore();store.ready=true;
  let sql="";
  store.pool={query:async text=>{sql=text;return {rows:[]};}};
  await store.recordEvent({id:"s",username:"u"},{id:"a",type:"comment",at:1,userId:"test"});
  assert.match(sql,/consumed_inbox AS \(\s*DELETE FROM live_event_inbox WHERE event_key = \$1/);
  assert.match(sql,/ON CONFLICT \(event_key\) DO NOTHING/);
  assert.match(sql,/FROM inserted WHERE user_id <> ''/);
});

test("failed recovery remains visible in diagnostics", async () => {
  const store=new EventStore();store.ready=true;
  store.pool={query:async()=>({rows:[]})};
  store.pendingInbox=async()=>[{session:{id:"s",username:"u",startedAt:1},event:{id:"a"}}];
  store.recordEvent=async()=>{store.lastError="test write failure";return false;};
  await store.recoverInbox();
  assert.equal(store.status().inboxRecovery.lastError,"test write failure");
  assert.equal(store.status().inboxRecovery.recovered,0);
});

test("unknown latency is excluded instead of counted as zero", () => {
  const start=source.indexOf("function summarizeLatencyMetric(");
  const end=source.indexOf("function pipelineTimestamps(",start);
  const summarize=new Function(`${source.slice(start,end)};return summarizeLatencyMetric;`)();
  assert.equal(summarize([{ms:null},{},{ms:100}],"ms").average,100);
  assert.equal(summarize([{ms:100},{ms:null}],"ms").latest,null);
  assert.equal(summarize([{ms:0}],"ms").average,0);
});
