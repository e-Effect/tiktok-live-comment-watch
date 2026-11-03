const DIVISIONS = new Map([["A1", 2000], ["A2", 1900], ["A3", 1800], ["B1", 1500], ["B2", 1400], ["B3", 1300]]);
const REFRESH_MS = 30 * 60_000;
const MAX_BOARD_AGE_MS = 24 * 60 * 60_000;
const REGION = "JP";

function handleKey(value) {
  const key = String(value || "").trim().replace(/^@/, "").toLowerCase();
  return /^(?!unknown$)[a-z0-9_.]{1,24}$/.test(key) ? key : "";
}

export class ViewerLeagues {
  constructor({ apiKey, fetchFn = globalThis.fetch, now = Date.now, onChange = () => {} } = {}) {
    this.apiKey = String(apiKey || "").trim();
    this.fetchFn = fetchFn;
    this.now = now;
    this.onChange = onChange;
    this.entries = new Map();
    this.nextRefreshAt = 0;
    this.pending = null;
  }

  get(uniqueId) {
    const key = handleKey(uniqueId);
    if (!this.apiKey || !key) return "";
    const now = this.now();
    if (!this.pending && now >= this.nextRefreshAt) {
      this.nextRefreshAt = now + REFRESH_MS;
      this.pending = this.refresh().catch(() => {}).finally(() => { this.pending = null; });
    }
    const entry = this.entries.get(key);
    return entry && entry.expiresAt > now ? entry.label : "";
  }

  async request(route, params) {
    const url = new URL(`https://api.tik.tools/webcast/leaderboard/${route}`);
    url.search = new URLSearchParams({ region: REGION, ...params });
    const response = await this.fetchFn(url, {
      headers: { "x-api-key": this.apiKey },
      redirect: "error",
      signal: AbortSignal.timeout(7000)
    });
    if (!response.ok) throw new Error("League ranking unavailable");
    return response.json();
  }

  async refresh() {
    const entries = new Map();
    try {
      const index = await this.request("leagues");
      if (index.region === REGION && index.available === true && Array.isArray(index.leagues)) {
        const now = this.now();
        const divisions = [...DIVISIONS].flatMap(([classLabel, classType]) => {
          const board = index.leagues.find(item => item?.classLabel === classLabel && item.classType === classType);
          const updatedAt = board?.updatedAt;
          return Number.isFinite(updatedAt) && updatedAt <= now + 60_000 && updatedAt + MAX_BOARD_AGE_MS > now
            ? [{ classLabel, classType, updatedAt }] : [];
        });
        const boards = await Promise.allSettled(divisions.map(async ({ classLabel, classType, updatedAt }) => {
          const board = await this.request("league", { class: String(classType) });
          if (board.region !== REGION || board.classLabel !== classLabel || board.classType !== classType
            || board.available !== true || board.hasFullAccess !== true || !Array.isArray(board.entries)) return;
          for (const row of board.entries) {
            if (!row || row.masked || row._masked) continue;
            const key = handleKey(row.uniqueId);
            if (!key) continue;
            const prior = entries.get(key);
            if (prior && prior.label !== classLabel) entries.set(key, { label: "", expiresAt: 0 });
            else entries.set(key, { label: classLabel, expiresAt: updatedAt + MAX_BOARD_AGE_MS });
          }
        }));
        // A failed division could hide a conflict with another division.
        if (boards.some(result => result.status === "rejected")) entries.clear();
      }
    } catch {
      // Leave badges blank when the source is unavailable.
    }
    const previous = this.entries;
    this.entries = entries;
    const changed = new Set([...previous.keys(), ...entries.keys()].filter(key =>
      previous.get(key)?.label !== entries.get(key)?.label
    ));
    if (changed.size) this.onChange(uniqueId => changed.has(handleKey(uniqueId)));
  }
}
