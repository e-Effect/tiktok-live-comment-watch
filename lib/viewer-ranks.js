// Read saved ledger ranks only. Never calculate ranks on the LIVE receive path.
export class ViewerRanks {
  constructor(store, username, onLoaded = () => {}) {
    this.store = store;
    this.username = String(username || '').trim().toLowerCase();
    this.key = this.username || '*';
    this.onLoaded = onLoaded;
    this.loading = false;
    this.loaded = false;
    this.retryAfter = 0;
  }
  rank(userId) {
    const saved = this.store.contributionRankCache.get(this.key);
    if (!saved && !this.loaded && !this.loading && this.store.ready && Date.now() >= this.retryAfter) {
      this.loading = true;
      this.store.listenerContributionRankings({username:this.username,waitForRefresh:false})
        .then(() => { this.loaded = true; this.onLoaded(); })
        .catch(() => { this.retryAfter = Date.now() + 60000; })
        .finally(() => { this.loading = false; });
    }
    const rank = saved?.byUserId.get(String(userId))?.contributionRank;
    return /^[SABCD]$/.test(rank || '') ? rank : '';
  }
}
