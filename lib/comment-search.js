export async function searchComments(pool, {search='',username='',cursor=''}={}) {
  const term=String(search).trim();
  if(!term || term.length>100) throw new Error('検索する言葉を1〜100文字で入力してください');
  let before=null;
  if(cursor) {
    try { before=JSON.parse(Buffer.from(String(cursor),'base64url').toString()); }
    catch {throw new Error('続きの検索情報が不正です。検索し直してください');}
    if(!before || typeof before.at!=='string' || before.at.length>80 || !Number.isFinite(Date.parse(before.at)) || typeof before.id!=='string' || before.id.length>1000 || before.term!==term || before.username!==username) throw new Error('検索条件が変わっています。検索し直してください');
  }
  // Bounded indexed reads: no full-table substring scan or COUNT(*) per request.
  const result=await pool.query(`SELECT event_key AS id,event_at::text AS "at",user_id AS "userId",nickname,comment_text AS text,stream_username AS "streamUsername"
    FROM live_events WHERE event_type='comment' AND NOT comment_body_pruned
    AND comment_text<>'' AND user_id<>'' AND LOWER(user_id)<>'unknown'
    AND ($1='' OR LOWER(stream_username)=LOWER($1))
    AND ($2::timestamptz IS NULL OR (event_at,event_key)<($2::timestamptz,$3::text))
    ORDER BY event_at DESC,event_key DESC LIMIT 2000`,[username,before?.at||null,before?.id||'']);
  const needle=term.normalize('NFKC').toLocaleLowerCase('ja-JP'),items=[];
  let scanned=0,last=null;
  for(const row of result.rows) {
    scanned++;last=row;
    if(String(row.text).normalize('NFKC').toLocaleLowerCase('ja-JP').includes(needle))items.push(row);
    if(items.length===50)break;
  }
  const complete=scanned===result.rows.length && result.rows.length<2000;
  const nextCursor=!complete&&last?Buffer.from(JSON.stringify({at:last.at,id:last.id,term,username})).toString('base64url'):null;
  return {items,scanned,complete,nextCursor};
}
