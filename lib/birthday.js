export function validBirthday(value) {
  if (!/^\d{2}-\d{2}$/.test(String(value))) return false;
  const [m,d]=value.split('-').map(Number);
  return m>=1 && m<=12 && d>=1 && d<=[31,29,31,30,31,30,31,31,30,31,30,31][m-1];
}
export function parseBirthdayComment(text) {
  const input=String(text||'').normalize('NFKC').trim();
  const match=input.match(/^(?:(?:私|わたし|僕|ぼく|俺|自分)の)?(?:(\d{1,2})月(\d{1,2})日が誕生日|誕生日は(\d{1,2})月(\d{1,2})日)(?:です|だよ|だ|だよね)?[!！。〜~\s]*$/);
  if (!match) return null;
  const birthday=`${String(Number(match[1]||match[3])).padStart(2,'0')}-${String(Number(match[2]||match[4])).padStart(2,'0')}`;
  return validBirthday(birthday)?birthday:null;
}
export function birthdayLabel(value) { return value.split('-').map(Number).join('月')+'日'; }
export function japanCalendarDay(at = Date.now()) {
  const time=Number(at);
  return Number.isFinite(time) ? new Date(time+9*60*60*1000).toISOString().slice(0,10) : "";
}
