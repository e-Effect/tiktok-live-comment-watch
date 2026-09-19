// Cache per viewer; batch only users actually displayed, without delaying events.
export class ViewerCoins {
  constructor(store,username,onLoaded=()=>{}) {
    Object.assign(this,{store,username,onLoaded,cache:new Map(),pending:new Set(),timer:null,running:false,closed:false});
  }
  get(id) {
    id=String(id||'');const item=this.cache.get(id);
    if(id && id!=='unknown' && !this.closed && this.store.ready && (!item || item.expires<=Date.now())) {
      this.pending.add(id);this.schedule();
    }
    return item?.coins ?? null;
  }
  schedule() {
    if(this.timer || this.running || this.closed || !this.pending.size)return;
    this.timer=setTimeout(()=>{this.timer=null;this.flush().catch(()=>{});},500);
    this.timer.unref?.();
  }
  async flush() {
    if(this.closed || this.running || !this.store.ready)return;
    this.running=true;
    const ids=[...this.pending].slice(0,10);ids.forEach(id=>this.pending.delete(id));
    if(!ids.length){this.running=false;return;}
    try {
      const result=await this.store.pool.query(`SELECT user_id,SUM(diamonds)::bigint AS coins
        FROM live_events WHERE user_id=ANY($1::text[]) AND event_type='gift'
        AND LOWER(stream_username)=LOWER($2)
        AND event_at>=NOW()-INTERVAL '30 days' AND event_at<=NOW()
        GROUP BY user_id`,[ids,this.username]);
      const totals=new Map(result.rows.map(row=>[String(row.user_id),Math.max(0,Number(row.coins)||0)]));
      for(const id of ids)this.cache.set(id,{coins:totals.get(id)||0,expires:Date.now()+60000});
      if(!this.closed)this.onLoaded(ids);
    } catch {
      for(const id of ids)this.cache.set(id,{coins:this.cache.get(id)?.coins??null,expires:Date.now()+30000});
    } finally {this.running=false;this.schedule();}
  }
  close(){this.closed=true;clearTimeout(this.timer);this.pending.clear();}
}
