// Explicit admin-only, bounded export; never called by the live receive loop.
export function trialOptions({ids, username, at}) {
  const userIds = [...new Set(String(ids || '').split(',').filter(Boolean))];
  if (!userIds.length || userIds.length > 10 || userIds.some(id => !/^\d{1,30}$/.test(id))) throw new Error('1〜10人のユーザーIDを指定してください');
  if (!/^[a-zA-Z0-9_.]{2,64}$/.test(username || '')) throw new Error('配信者IDが必要です');
  const end = Number(at);
  if (!Number.isFinite(end) || end < Date.UTC(2026,0,1) || end > Date.now()+60000) throw new Error('集計日時が不正です');
  return {userIds, username: username.toLowerCase(), from: new Date(end-90*86400000), to:new Date(end)};
}

export async function readTrialMetrics(pool, options) {
  const {userIds,username,from,to}=options;
  const values=[userIds,username,from,to];
  // Sequential, indexed per-user reads avoid an all-listener aggregate.
  const events=await pool.query(`SELECT user_id,
    COUNT(*) FILTER (WHERE event_type='comment')::bigint AS comments,
    COALESCE(SUM(item_count) FILTER (WHERE event_type='like'),0)::bigint AS likes,
    COALESCE(SUM(diamonds) FILTER (WHERE event_type='gift' AND item_count>0 AND diamonds::numeric/item_count>10),0)::bigint AS coins,
    COALESCE(SUM(diamonds) FILTER (WHERE event_type='gift'),0)::bigint AS all_coins
    FROM live_events WHERE user_id=ANY($1::text[])
      AND LOWER(stream_username)=$2 AND event_at >= $3 AND event_at <= $4
      AND event_type IN ('comment','like','gift') GROUP BY user_id`,values);
  const visits=await pool.query(`SELECT v.user_id,
    COUNT(DISTINCT COALESCE(NULLIF(s.room_id,''),v.session_id::text))::bigint AS visits
    FROM viewer_visits v JOIN live_sessions s ON s.id=v.session_id
    WHERE v.user_id=ANY($1::text[]) AND LOWER(v.stream_username)=$2
      AND v.last_seen_at >= $3 AND v.first_seen_at <= $4 GROUP BY v.user_id`,values);
  const profiles=await pool.query(`SELECT user_id,latest_unique_id,latest_nickname,is_super_fan
    FROM listeners WHERE user_id=ANY($1::text[])`,[userIds]);
  const es=new Map(events.rows.map(r=>[r.user_id,r])),vs=new Map(visits.rows.map(r=>[r.user_id,r]));
  return {from:from.toISOString(),to:to.toISOString(),username,policy:'trial-90d-unit-over-10-v1',items:profiles.rows.map(p=>{
    const e=es.get(p.user_id)||{},v=vs.get(p.user_id)||{};
    return {id:p.user_id,name:p.latest_nickname,handle:p.latest_unique_id,superFan:p.is_super_fan,
      coins:Number(e.coins||0),allCoins:Number(e.all_coins||0),comments:Number(e.comments||0),likes:Number(e.likes||0),visits:Number(v.visits||0)};
  })};
}
