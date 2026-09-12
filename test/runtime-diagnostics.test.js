import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeDiagnostics } from "../lib/runtime-diagnostics.js";

test("diagnostics retain metadata only and preserve query results and errors", async () => {
  let now = 0;
  const logs=[];
  const d=new RuntimeDiagnostics({now:()=>now,write:x=>logs.push(x)});
  const error=Object.assign(new Error("private comment"),{code:"40P01"});
  let fail=false;
  const pool={async query(){now+=1200;if(fail)throw error;return {rows:[1]};}};
  d.instrument(pool,"general");
  assert.deepEqual(await pool.query("SELECT 'private comment'",["private ID"]),{rows:[1]});
  fail=true;
  await assert.rejects(pool.query("SELECT 'secret'"),e=>e===error);
  const input={ready:true,pools:{},pending:0,visitPending:0,activeStream:true,memory:{rss:1048576,heapUsed:1048576}};
  assert.equal(d.sample(input),true);
  assert.equal(d.sample(input),false);
  assert.equal(d.active.size,0);
  assert.equal(d.failed,1);
  assert.ok(logs[0].includes("40P01"));
  assert.doesNotMatch(logs[0],/private|secret/);
  now+=60000;
  assert.equal(d.sample(input),true);
  for(let i=0;i<20;i++)await pool.query("SELECT 1").catch(()=>{});
  assert.equal(d.recent.length,12);
});

test("blocked queries remain visible and idle sampling is five minutes", async () => {
  let now=0,release;
  const logs=[];
  const d=new RuntimeDiagnostics({now:()=>now,write:x=>logs.push(x)});
  const pool={query:()=>new Promise(r=>{release=r;})};
  d.instrument(pool,"writer");
  const pending=pool.query("WITH inserted AS (private)");
  now=5000;
  const input={ready:true,pools:{},pending:0,visitPending:0,activeStream:false,memory:{rss:0,heapUsed:0}};
  d.sample(input);
  assert.equal(JSON.parse(logs[0].split("] ")[1]).active[0].ms,5000);
  now+=60000;
  assert.equal(d.sample(input),false);
  now+=240000;
  assert.equal(d.sample(input),true);
  release({rows:[]});await pending;
  assert.equal(d.active.size,0);
});
