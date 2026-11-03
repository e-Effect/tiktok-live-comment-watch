export function formatObservedStay(milliseconds) {
  const seconds=Math.max(1,Math.round(Number(milliseconds)/1000));
  const hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60);
  return (hours?hours.toLocaleString('ja-JP')+'時間':'')+(minutes?minutes+'分':'')+(seconds%60||seconds<60?seconds%60+'秒':'');
}
