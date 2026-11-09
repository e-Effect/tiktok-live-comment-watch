export function formatObservedStay(milliseconds) {
  const seconds=Math.max(1,Math.round(Number(milliseconds)/1000));
  const hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60);
  return (hours?hours.toLocaleString('ja-JP')+'時間':'')+(minutes?minutes+'分':'')+(seconds%60||seconds<60?seconds%60+'秒':'');
}

export function formatObservedWatchTime(milliseconds) {
  const duration=Number(milliseconds);
  return Number.isFinite(duration)&&duration>0
    ? '推定視聴 約'+formatObservedStay(duration) : '視聴時間 未計測';
}
