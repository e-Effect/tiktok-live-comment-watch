const DAY = 86400000;
const timeout = error => error?.code === '57014' || /query read timeout/i.test(error?.message || '');

// Failed event batches split without dropping records or publishing partial ranks.
export async function readRankMetrics(pool, username = '', options = {}) {
  const progress = options.onProgress || (() => {});
  const pause = options.pause || (() => new Promise(resolve => setTimeout(resolve, 100)));
  const query = async (stage, sql, args) => {
    if (options.signal?.aborted) throw Object.assign(new Error('Ranking cancelled'),{code:'CANCELLED',rankStage:stage});
    progress({stage});
    const started = Date.now();
    try {
      const result = await pool.query(`/* rank:${stage} */ ${sql}`, args);
      progress({lastQueryMs:Date.now()-started});
      return result.rows;
    } catch (error) {
      error.rankStage = stage;
      throw error;
    }
  };
  const to = new Date(options.now || Date.now()), from = new Date(to.getTime() - 90 * DAY);
  const candidates = [];
  let cursor = '', scanned = 0, pageSize = 500;
  while (true) {
    let page;
    try {
      // Filter eligibility after LIMIT, so sparse matches cannot cause a full scan.
      page = await query('candidates', `SELECT user_id, SUM(gift_coins) AS coins,
        SUM(comment_count) AS comments FROM listener_stream_stats
        WHERE user_id > $1 AND ($2 = '' OR LOWER(stream_username) = LOWER($2))
        GROUP BY user_id ORDER BY user_id LIMIT $3`, [cursor, username, pageSize]);
    } catch (error) {
      if (!timeout(error) || pageSize <= 10) throw error;
      pageSize = Math.max(10, Math.floor(pageSize/2));
      await pause();
      continue;
    }
    for (const row of page) {
      if (row.user_id && row.user_id.toLowerCase() !== 'unknown' && Number(row.coins) >= 100 && Number(row.comments) >= 10) candidates.push(String(row.user_id));
    }
    scanned += page.length;
    progress({scanned, total:candidates.length, processed:0});
    if (page.length < pageSize) break;
    cursor = String(page.at(-1).user_id);
    await pause();
  }

  async function events(ids, start, end) {
    try {
      return await query('events', `SELECT user_id,
      COUNT(*) FILTER (WHERE event_type='comment')::bigint AS recent_comments,
      COALESCE(SUM(item_count) FILTER (WHERE event_type='like'),0)::bigint AS recent_likes,
      COALESCE(SUM(diamonds) FILTER (WHERE event_type='gift' AND item_count>0 AND diamonds::numeric/NULLIF(item_count,0)>10),0)::bigint AS recent_coins
      FROM live_events WHERE user_id=ANY($1::text[])
      AND ($2='' OR LOWER(stream_username)=LOWER($2)) AND event_at >= $3 AND event_at < $4
      AND event_type IN ('comment','like','gift') GROUP BY user_id`, [ids,username,start,end]);
    } catch (error) {
      if (!timeout(error)) throw error;
      await pause();
      if (ids.length > 1) {
        const mid = Math.ceil(ids.length/2);
        return [...await events(ids.slice(0,mid),start,end), ...await events(ids.slice(mid),start,end)];
      }
      if (end-start <= DAY) throw error;
      const mid = new Date(start.getTime()+Math.floor((end-start)/2));
      const parts = [...await events(ids,start,mid), ...await events(ids,mid,end)];
      const merged = new Map();
      for (const row of parts) {
        const sum = merged.get(row.user_id) || {user_id:row.user_id,recent_comments:0,recent_likes:0,recent_coins:0};
        for (const key of ['recent_comments','recent_likes','recent_coins']) sum[key] += Number(row[key]);
        merged.set(row.user_id,sum);
      }
      return [...merged.values()];
    }
  }

  const rows = [];
  for (let start = 0; start < candidates.length; start += 10) {
    const ids = candidates.slice(start,start+10);
    const metrics = await events(ids,from,to);
    const eligible = metrics.filter(r => Number(r.recent_comments) >= 10 && Number(r.recent_coins) >= 100);
    if (eligible.length) {
      const eligibleIds = eligible.map(r => String(r.user_id));
      const visits = await query('visits', `SELECT v.user_id,
        COUNT(DISTINCT COALESCE(NULLIF(s.room_id,''),v.session_id::text))::bigint AS recent_visits
        FROM viewer_visits v JOIN live_sessions s ON s.id=v.session_id
        WHERE v.user_id=ANY($1::text[]) AND ($2='' OR LOWER(v.stream_username)=LOWER($2))
        AND v.last_seen_at >= $3 AND v.first_seen_at <= $4 GROUP BY v.user_id`, [eligibleIds,username,from,to]);
      const profiles = await query('profiles', `SELECT user_id,
        LOWER(CONCAT_WS(' ',user_id,latest_unique_id,latest_nickname,notes)) AS search_text
        FROM listeners WHERE user_id=ANY($1::text[])`, [eligibleIds]);
      const vs = new Map(visits.map(r => [String(r.user_id),r]));
      const ps = new Map(profiles.map(r => [String(r.user_id),r]));
      for (const r of eligible) if (ps.has(String(r.user_id))) rows.push({...r,...vs.get(String(r.user_id)),...ps.get(String(r.user_id))});
    }
    progress({processed:Math.min(start+10,candidates.length),total:candidates.length});
    await pause();
  }
  return rows;
}
