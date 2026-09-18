import {isFirstVisitClaim, normalizeFirstVisitClaim} from './first-visit-claim.js';

export function entryDetection(data = {}, now = Date.now()) {
  const collector = Number(data.collectorReceivedAt ?? data._pipeline?.collectorReceivedAt);
  const server = Number(data.serverReceivedAt ?? data._pipeline?.serverReceivedAt);
  return collector > 0 && Number.isFinite(collector)
    ? {at:collector,clock:'collector'}
    : {at:server > 0 && Number.isFinite(server) ? server : now,clock:'server'};
}

export function matchesEarlyEntryText(text) {
  if (isFirstVisitClaim(text)) return true;
  const normalized = normalizeFirstVisitClaim(text).replace(/(?:w+|笑)+$/u,'');
  return /^(?:(?:初見です|初めまして|はじめまして|こんにちは|こんばんは))?(?:(?:私|わたし|僕|ぼく|自分)も)?(?:ぜひ)?(?:やりたい(?:です)?|やって(?:ください|下さい)|お願い(?:します|いたします|できますか)|おねがい(?:します|いたします|できますか))$/.test(normalized);
}

export function earlyEntryComment(entry, comment, now = Date.now()) {
  return matchesEarlyEntryText(comment.text) && withinEntryWindow(entry, comment, now);
}

export function withinEntryWindow(entry, comment, now = Date.now()) {
  if (!entry || entry.initial || comment.source === 'initial') return false;
  const received = entryDetection(comment,now);
  if (received.clock !== entry.clock) return false;
  const elapsed = received.at - entry.at;
  // A delayed batch must not make old comments appear to follow an entry immediately.
  const eventElapsed = Number(comment.at) - Number(entry.eventAt);
  return elapsed >= 0 && elapsed <= 5000 && eventElapsed >= 0 && eventElapsed <= 5000;
}
