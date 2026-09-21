export function historyUrl(userId,username) {
  return `/api/listeners/${encodeURIComponent(userId)}/history?${new URLSearchParams({kind:'comments',limit:'10',username})}`;
}

export function setupCommentHistory(list,getContext) {
  const dialog=document.getElementById('viewerCommentHistory');
  const title=document.getElementById('viewerCommentHistoryTitle');
  const status=document.getElementById('viewerCommentHistoryStatus');
  const results=document.getElementById('viewerCommentHistoryItems');
  const keyForm=document.getElementById('viewerCommentHistoryKeyForm');
  const keyInput=document.getElementById('viewerCommentHistoryKey');
  const retry=document.getElementById('viewerCommentHistoryRetry');
  const storageKey='tiktok-listener-admin-key';
  let target=null,controller=null,revision=0;
  const cancel=()=>{revision++;controller?.abort();controller=null;};
  document.getElementById('viewerCommentHistoryClose').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{cancel();keyInput.value='';});
  dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
  async function load(key) {
    cancel();const ticket=revision;controller=new AbortController();
    results.replaceChildren();retry.hidden=true;
    if(!key){keyForm.hidden=false;status.textContent='コメント履歴を見るには台帳の管理キーを入力してください。';keyInput.focus();return;}
    keyForm.hidden=true;status.textContent='最新10件を読み込んでいます…';
    try {
      const response=await fetch(historyUrl(target.userId,target.username),{headers:{Authorization:`Bearer ${key}`},signal:controller.signal,cache:'no-store'});
      if(ticket!==revision || !dialog.open)return;
      if(response.status===401 || response.status===403){keyForm.hidden=false;status.textContent='管理キーを確認して入力してください。';keyInput.focus();return;}
      if(!response.ok)throw Error('履歴を取得できませんでした。「再取得」でお試しください。');
      const data=await response.json();
      if(ticket!==revision || !dialog.open)return;
      localStorage.setItem(storageKey,key);keyInput.value='';
      const items=(data.items||[]).slice(0,10);
      status.textContent=items.length?`保存済みの最新${items.length}件です。直前のコメントは保存待ちの場合があります。`:'保存済みのコメントはまだありません。';
      for(const item of items){
        const row=document.createElement('li'),date=document.createElement('time'),text=document.createElement('p');
        const at=new Date(item.at);date.textContent=Number.isNaN(at.getTime())?'日時不明':at.toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'});
        text.textContent=String(item.text||'');row.append(date,text);results.append(row);
      }
      retry.hidden=false;
    }catch(error){if(error.name!=='AbortError' && ticket===revision){status.textContent=error.message;retry.hidden=false;}}
  }
  keyForm.addEventListener('submit',event=>{event.preventDefault();load(keyInput.value.normalize('NFKC').trim());});
  retry.addEventListener('click',()=>load(localStorage.getItem(storageKey)||''));
  const open=row=>{
    const context=getContext();
    if(!row?.dataset.userId || !context?.username)return;
    cancel();target={userId:row.dataset.userId,username:context.username};
    title.textContent=`${row.dataset.userName||target.userId}さんのコメント履歴`;
    if(!dialog.open)dialog.showModal();
    if(context.preview){results.replaceChildren();keyForm.hidden=true;retry.hidden=true;status.textContent='テスト表示では保存された履歴はありません。';return;}
    load(localStorage.getItem(storageKey)||'');
  };
  list.addEventListener('click',event=>{if(!window.getSelection()?.toString())open(event.target.closest('article.comment[data-user-id]'));});
  list.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){const row=event.target.closest('article.comment[data-user-id]');if(row){event.preventDefault();open(row);}}});
}
