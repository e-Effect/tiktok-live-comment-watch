const stages = {candidates:'対象者の確認',events:'コメント・ギフト・いいね',visits:'来訪',profiles:'プロフィール',saving:'保存',done:'完了'};
const date = value => new Intl.DateTimeFormat('ja-JP',{year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(value));

export function rankingStatusText(job) {
  const saved = job.generatedAt ? `保存済み集計：${date(job.generatedAt)}` : '保存済み集計なし';
  if (job.state === 'running') return `再計算中：${stages[job.stage] || '準備'} ${job.stage === 'candidates' ? `${job.scanned || 0}人確認` : `${job.processed || 0}/${job.total || 0}人`}。${saved}（更新前）`;
  if (job.state === 'failed') return `再計算に失敗：${stages[job.stage] || '集計'}。${job.errorCode === '57014' ? '処理時間の上限を超えました。' : 'データベース処理を完了できませんでした。'}${saved}。前回の結果は保持しています。`;
  if (job.busy) return `別の配信者のランクを計算中。${saved}`;
  return `${job.state === 'succeeded' ? '再計算完了。' : ''}${saved}`;
}

export function setupRankingStatus({button,status,api,username,onComplete}) {
  let revision = 0, timer, controller, previousState = '', previousScope = '';
  function cancel() { revision++; clearTimeout(timer); controller?.abort(); }
  async function refresh(start = false) {
    cancel();
    const ticket = revision, scope = username();
    if (scope !== previousScope) previousState = '';
    previousScope = scope;
    controller = new AbortController();
    button.disabled = true;
    if (start) status.textContent = '再計算を開始しています…';
    try {
      const response = await api(`/api/listeners/ranking?${new URLSearchParams({username:scope})}`,{method:start?'POST':'GET',signal:controller.signal});
      const job = await response.json();
      if (ticket !== revision || scope !== username()) return;
      if (!response.ok) throw new Error(job.error || '処理状況を取得できません');
      status.textContent = rankingStatusText(job);
      status.classList.toggle('error',job.state === 'failed');
      button.disabled = job.state === 'running' || job.busy;
      button.textContent = job.state === 'running' ? '再計算中…' : 'ランクを再計算';
      const completed = (start || previousState === 'running') && job.state === 'succeeded';
      previousState = job.state;
      if (job.state === 'running' || job.busy) timer = setTimeout(()=>refresh(),5000);
      if (completed) onComplete();
    } catch (error) {
      if (ticket !== revision || error.name === 'AbortError') return;
      status.textContent = `状況を確認できません：${error.message}（更新完了ではありません）`;
      status.classList.add('error');
      button.textContent = 'ランクを再計算';
      button.disabled = false;
      // Read-only retry also handles a lost response to a successful POST.
      timer = setTimeout(()=>refresh(),15000);
    }
  }
  button.addEventListener('click',()=>refresh(true));
  return {refresh,cancel};
}
