// Count polling never reloads rows or steals focus from the current page.
export function setupListenerCount({api, schedule = (fn) => setTimeout(fn, 5000), unschedule = clearTimeout}) {
  let revision = 0, timer, controller;
  function cancel() { revision++; unschedule(timer); controller?.abort(); }
  function start(query, onResult) {
    cancel();
    const ticket = revision;
    let attempts = 0;
    controller = new AbortController();
    async function poll() {
      if (ticket !== revision) return;
      try {
        const response = await api(`/api/listeners/count?${query}`, {signal:controller.signal});
        if (!response.ok) throw new Error('Count unavailable');
        const result = await response.json();
        if (ticket !== revision) return;
        if (result.pending && ++attempts < 12) timer = schedule(poll);
        else onResult(result.pending ? {error:true} : result);
      } catch (error) {
        if (ticket === revision && error.name !== 'AbortError') onResult({error:true});
      }
    }
    void poll();
  }
  return {start,cancel};
}
