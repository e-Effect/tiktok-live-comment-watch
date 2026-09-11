// Starts only during 12:00 JST; never catches up after a sleeping server wakes.
export class NoonRetentionWindow {
  constructor() { this.day = ''; this.running = false; }
  allow(now, blocked = false) {
    const jst = new Date(now + 9 * 60 * 60 * 1000);
    const day = jst.toISOString().slice(0, 10);
    const hour = jst.getUTCHours(), minute = jst.getUTCMinutes();
    if (blocked || hour !== 12 || minute >= 15) {
      if (this.running) this.running = false;
      return false;
    }
    if (this.day !== day) {
      if (minute !== 0) return false;
      this.day = day; this.running = true;
    }
    return this.running;
  }
  finish() { this.running = false; }
}
