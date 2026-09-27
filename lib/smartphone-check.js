let cached = null;
let pending = null;
export async function checkSmartphoneRoute(fetcher = fetch, now = Date.now()) {
  if (cached && now - cached.at < 15000) return cached.result;
  if (pending) return pending;
  pending = (async () => {
    let reachable = false;
    try {
      const response = await fetcher(`https://count-pocket.a-line.workers.dev/api/live-feed?giftSince=${now}&alertSince=${now}&limit=1`, { signal: AbortSignal.timeout(4500) });
      if (response.ok) {
        const body = await response.json();
        reachable = Array.isArray(body.gifts) && Array.isArray(body.alerts);
      }
    } catch {}
    const result = {reachable};
    cached = {at:now,result};
    return result;
  })();
  try { return await pending; } finally { pending = null; }
}
