export const screenshotRecordsSchema = `CREATE TABLE IF NOT EXISTS screenshot_listener_records (
  stream_username TEXT NOT NULL, tiktok_id TEXT NOT NULL, user_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '', enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(stream_username,tiktok_id)
);`;

export function recordHandle(value) {
  const id=String(value||'').trim().replace(/^@/,'').toLowerCase();
  if (!/^[a-z0-9._]{2,32}$/.test(id) || id==='unknown') throw Object.assign(new Error('TikTok IDを確認してください'),{status:400});
  return id;
}

export function recordIds(text) {
  const ids=[...new Set(String(text||'').split(/[\s,、;]+/).filter(Boolean).map(recordHandle))];
  if (!ids.length || ids.length>100) throw Object.assign(new Error('一度に1〜100件のIDを登録してください'),{status:400});
  return ids;
}

// Match reservations independently of notification switches; never invent a listener.
export function screenshotListenerCondition(alias='l',scope='$1') {
  return `${alias}.user_id IN (
    SELECT r.user_id FROM screenshot_listener_records r WHERE r.user_id<>'' AND (${scope}='' OR r.stream_username=LOWER(${scope}))
    UNION SELECT p.user_id FROM screenshot_listener_records r JOIN listeners p ON LOWER(p.latest_unique_id)=r.tiktok_id
      WHERE r.user_id='' AND (${scope}='' OR r.stream_username=LOWER(${scope}))
    UNION SELECT a.user_id FROM screenshot_listener_records r JOIN listener_aliases a ON LOWER(a.unique_id)=r.tiktok_id
      WHERE r.user_id='' AND (${scope}='' OR r.stream_username=LOWER(${scope}))
  ) AND EXISTS (SELECT 1 FROM listener_stream_stats h WHERE h.user_id=${alias}.user_id
    AND (${scope}='' OR LOWER(h.stream_username)=LOWER(${scope}))
    AND (h.visit_count>0 OR h.comment_count>0 OR h.gift_count>0 OR h.like_count>0 OR h.follow_count>0 OR h.share_count>0))`;
}

function requireReady(store) {
  if (!store.ready) throw Object.assign(new Error('データベースに接続できません。履歴の照合は未完了です。'),{status:503});
}

export async function recordHistory(store, scope, records) {
  requireReady(store);
  if (!records.length) return [];
  const ids=records.map(r=>r.tiktok_id);
  const bound=records.map(r=>r.user_id).filter(Boolean);
  const {rows}=await store.pool.query(`WITH matches AS (
    SELECT LOWER(latest_unique_id) AS handle,user_id FROM listeners WHERE LOWER(latest_unique_id)=ANY($1::text[])
    UNION SELECT LOWER(unique_id),user_id FROM listener_aliases WHERE LOWER(unique_id)=ANY($1::text[])
  ) SELECT l.user_id,l.latest_unique_id,l.latest_nickname,m.handle,
    EXISTS(SELECT 1 FROM listener_stream_stats s WHERE s.user_id=l.user_id AND LOWER(s.stream_username)=$3
      AND (s.visit_count>0 OR s.comment_count>0 OR s.gift_count>0 OR s.like_count>0 OR s.follow_count>0 OR s.share_count>0)) AS has_history
    FROM listeners l LEFT JOIN matches m ON m.user_id=l.user_id
    WHERE m.user_id IS NOT NULL OR l.user_id=ANY($2::text[])`,[ids,bound,scope]);
  return records.map(record=>{
    const candidates=[...new Map(rows.filter(r=>record.user_id ? r.user_id===record.user_id : r.handle===record.tiktok_id).map(r=>[r.user_id,r])).values()];
    const match=candidates.length===1?candidates[0]:null;
    return {...record, history: candidates.length>1?'ambiguous':candidates.some(r=>r.has_history)?'found':'none',
      user_id:match?.user_id||record.user_id||'',nickname:match?.latest_nickname||'',current_id:match?.latest_unique_id||''};
  });
}

export async function listScreenshotRecords(store,scope) {
  requireReady(store);
  const {rows}=await store.pool.query('SELECT * FROM screenshot_listener_records WHERE stream_username=$1 ORDER BY created_at DESC,tiktok_id LIMIT 1000',[scope]);
  return recordHistory(store,scope,rows);
}

export async function addScreenshotRecords(store,scope,input) {
  requireReady(store);
  const ids=recordIds(input.ids), source=String(input.source||'スクショ').trim().slice(0,160);
  const records=await recordHistory(store,scope,ids.map(tiktok_id=>({tiktok_id,user_id:''})));
  // Records are independent of listeners: reserving an ID never creates a visit.
  const {rows:limits}=await store.pool.query(`SELECT COUNT(*)::int AS total,
    COUNT(*) FILTER(WHERE stream_username=$1)::int AS scoped,
    COUNT(*) FILTER(WHERE stream_username=$1 AND tiktok_id=ANY($2::text[]))::int AS existing
    FROM screenshot_listener_records`,[scope,ids]);
  const added=ids.length-Number(limits[0]?.existing||0);
  if (Number(limits[0]?.total||0)+added>5000 || Number(limits[0]?.scoped||0)+added>1000) throw Object.assign(new Error('記録IDの登録上限に達しました'),{status:409});
  await store.pool.query(`INSERT INTO screenshot_listener_records(stream_username,tiktok_id,user_id,source,enabled)
    SELECT $1,x->>'id',x->>'userId',$2,(x->>'enabled')::boolean FROM jsonb_array_elements($3::jsonb) x
    ON CONFLICT(stream_username,tiktok_id) DO UPDATE SET source=EXCLUDED.source,
      user_id=CASE WHEN screenshot_listener_records.user_id='' THEN EXCLUDED.user_id ELSE screenshot_listener_records.user_id END,updated_at=NOW()`,
    [scope,source,JSON.stringify(records.map(r=>({id:r.tiktok_id,userId:r.user_id,enabled:r.history==='none'})))]);
}

export async function toggleScreenshotRecord(store,scope,input) {
  requireReady(store);
  if (typeof input.enabled!=='boolean') throw Object.assign(new Error('通知設定を確認してください'),{status:400});
  const id=recordHandle(input.id);
  const {rowCount}=await store.pool.query('UPDATE screenshot_listener_records SET enabled=$3,updated_at=NOW() WHERE stream_username=$1 AND tiktok_id=$2',[scope,id,input.enabled]);
  if (!rowCount) throw Object.assign(new Error('記録IDが見つかりません'),{status:404});
}

export class ScreenshotWatch {
  constructor() { this.records=new Map();this.seen=new Map();this.alerts=new Map();this.bindings=new Map(); }
  replace(rows) {
    this.records=new Map(rows.filter(r=>r.enabled).map(r=>{
      const key=`${r.stream_username}:${r.tiktok_id}`;
      return [key,{...r,user_id:r.user_id||this.bindings.get(key)?.user_id||''}];
    }));
    this.byUser=new Map([...this.records.values()].filter(r=>r.user_id).map(r=>[`${r.stream_username}:${r.user_id}`,r]));
  }
  match(scope,person) {
    const handle=String(person.uniqueId||'').replace(/^@/,'').toLowerCase();
    let record=this.records.get(`${scope.toLowerCase()}:${handle}`);
    if (record?.user_id && record.user_id!==String(person.userId)) record=null;
    if (!record) record=this.byUser?.get(`${scope.toLowerCase()}:${person.userId}`);
    // A bound numeric ID survives handle changes and prevents matching a reused handle.
    if (record?.user_id && record.user_id!==String(person.userId)) return null;
    if (record && person.userId && !record.user_id && person.userId!=='unknown') {
      record.user_id=String(person.userId);
      this.byUser?.set(`${record.stream_username}:${record.user_id}`,record);
      this.bindings.set(`${record.stream_username}:${record.tiktok_id}`,record);
    }
    return record||null;
  }
  accept(scope,sessionId,person,at,now=Date.now()) {
    const record=this.match(scope,person);
    if (!record || !Number.isFinite(Number(at)) || now-Number(at)>30000 || Number(at)>now+5000) return null;
    const key=`${sessionId}:${person.userId}`;
    if (this.seen.get(sessionId)?.has(String(person.userId))) return null;
    if (!this.seen.has(sessionId)) this.seen.set(sessionId,new Set());
    this.seen.get(sessionId).add(String(person.userId));
    if (this.seen.size>100) this.seen.delete(this.seen.keys().next().value);
    const alert={userId:String(person.userId),uniqueId:person.uniqueId||record.tiktok_id,nickname:person.nickname||record.tiktok_id,avatarUrl:person.avatarUrl||'',kind:'screenshot',expiresAt:now+60000};
    this.alerts.set(key,{scope,sessionId,alert});this.active(sessionId,now);return alert;
  }
  active(sessionId,now=Date.now()) {
    for (const [key,item] of this.alerts) if(item.alert.expiresAt<=now || !this.match(item.scope,item.alert))this.alerts.delete(key);
    return [...this.alerts.values()].filter(r=>r.sessionId===sessionId).map(r=>r.alert);
  }
  async refresh(store) {
    if (!store.ready) return;
    const batch=[...this.bindings];
    if(batch.length) {
      await store.pool.query(`UPDATE screenshot_listener_records r SET user_id=x->>'user_id',updated_at=NOW()
        FROM jsonb_array_elements($1::jsonb) x WHERE r.stream_username=x->>'stream_username' AND r.tiktok_id=x->>'tiktok_id' AND r.user_id=''`,[JSON.stringify(batch.map(([,r])=>r))]);
      for(const [key,value] of batch)if(this.bindings.get(key)===value)this.bindings.delete(key);
    }
    const {rows}=await store.pool.query('SELECT * FROM screenshot_listener_records WHERE enabled=TRUE LIMIT 5000');
    this.replace(rows);
  }
}
