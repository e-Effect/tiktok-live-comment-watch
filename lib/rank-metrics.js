// Explicit ledger refresh only. Read small indexed batches, never join all events.
export async function readRankMetrics(pool, username = '') {
  const candidates = await pool.query(`SELECT user_id FROM listener_stream_stats
    WHERE ($1 = '' OR LOWER(stream_username) = LOWER($1))
    GROUP BY user_id HAVING SUM(gift_coins) >= 100 AND SUM(comment_count) >= 10
    ORDER BY user_id`, [username]);
  const to = new Date(), from = new Date(to.getTime() - 90 * 86400000), rows = [];
  for (let start = 0; start < candidates.rows.length; start += 10) {
    const ids = candidates.rows.slice(start, start + 10).map(r => String(r.user_id)).filter(id => id && id.toLowerCase() !== 'unknown');
    if (!ids.length) continue;
    const values = [ids, username, from, to];
    const events = await pool.query(`SELECT user_id,
      COUNT(*) FILTER (WHERE event_type='comment')::bigint AS recent_comments,
      COALESCE(SUM(item_count) FILTER (WHERE event_type='like'),0)::bigint AS recent_likes,
      COALESCE(SUM(diamonds) FILTER (WHERE event_type='gift' AND item_count>0 AND diamonds::numeric/NULLIF(item_count,0)>10),0)::bigint AS recent_coins
      FROM live_events WHERE user_id=ANY($1::text[])
      AND ($2='' OR LOWER(stream_username)=LOWER($2)) AND event_at >= $3 AND event_at <= $4
      AND event_type IN ('comment','like','gift') GROUP BY user_id`, values);
    const eligible = events.rows.filter(r => Number(r.recent_comments) >= 10 && Number(r.recent_coins) >= 100);
    if (eligible.length) {
      const eligibleIds = eligible.map(r => String(r.user_id));
      const visits = await pool.query(`SELECT v.user_id,
        COUNT(DISTINCT COALESCE(NULLIF(s.room_id,''),v.session_id::text))::bigint AS recent_visits
        FROM viewer_visits v JOIN live_sessions s ON s.id=v.session_id
        WHERE v.user_id=ANY($1::text[]) AND ($2='' OR LOWER(v.stream_username)=LOWER($2))
        AND v.last_seen_at >= $3 AND v.first_seen_at <= $4 GROUP BY v.user_id`, [eligibleIds,username,from,to]);
      const profiles = await pool.query(`SELECT user_id,
        LOWER(CONCAT_WS(' ',user_id,latest_unique_id,latest_nickname,notes)) AS search_text
        FROM listeners WHERE user_id=ANY($1::text[])`, [eligibleIds]);
      const vs = new Map(visits.rows.map(r => [String(r.user_id),r]));
      const ps = new Map(profiles.rows.map(r => [String(r.user_id),r]));
      for (const r of eligible) if (ps.has(String(r.user_id))) rows.push({...r,...vs.get(String(r.user_id)),...ps.get(String(r.user_id))});
    }
    // Yield between batches so live ingestion can keep using the pool.
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return rows;
}
