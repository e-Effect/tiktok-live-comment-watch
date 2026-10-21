export function historyUrl(userId,username) {
  return `/api/listeners/${encodeURIComponent(userId)}/history?${new URLSearchParams({kind:'comments',limit:'20',username})}`;
}

export function tiktokProfileUrl(uniqueId) {
  const id=String(uniqueId||'').trim().replace(/^@/,'');
  return /^[a-zA-Z0-9._]{1,24}$/.test(id) && !/^unknown$/i.test(id) ? `https://www.tiktok.com/@${encodeURIComponent(id)}` : '';
}

export function setupCommentHistory(list,getContext) {
  const dialog=document.getElementById('viewerCommentHistory');
  const title=document.getElementById('viewerCommentHistoryTitle');
  const status=document.getElementById('viewerCommentHistoryStatus');
  const results=document.getElementById('viewerCommentHistoryItems');
  const keyForm=document.getElementById('viewerCommentHistoryKeyForm');
  const keyInput=document.getElementById('viewerCommentHistoryKey');
  const retry=document.getElementById('viewerCommentHistoryRetry');
  const profile=document.getElementById('viewerCommentHistoryProfile');
  const profileStatus=document.getElementById('viewerCommentHistoryProfileStatus');
  const storageKey='tiktok-listener-admin-key';
  let target=null,controller=null,revision=0;
  const cancel=()=>{revision++;controller?.abort();controller=null;};
  function showProfile(uniqueId) {
    const url=tiktokProfileUrl(uniqueId);
    profile.hidden=!url;
    if(url)profile.href=url;else profile.removeAttribute('href');
    profileStatus.textContent=url?'':'TikTok ID未取得';
  }
  async function loadProfile(key,ticket,signal) {
    if(tiktokProfileUrl(target.uniqueId))return;
    profileStatus.textContent='TikTok IDを確認中…';
    try {
      const response=await fetch(`/api/listeners/${encodeURIComponent(target.userId)}?${new URLSearchParams({username:target.username})}`,{headers:{Authorization:`Bearer ${key}`},signal,cache:'no-store'});
      if(!response.ok)throw Error();
      const data=await response.json();
      if(ticket!==revision || !dialog.open)return;
      target.uniqueId=data.listener?.uniqueId||'';
      showProfile(target.uniqueId);
    }catch(error){if(error.name!=='AbortError' && ticket===revision && dialog.open)showProfile('');}
  }
  document.getElementById('viewerCommentHistoryClose').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{cancel();keyInput.value='';});
  dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
  async function load(key) {
    cancel();const ticket=revision;controller=new AbortController();
    results.replaceChildren();retry.hidden=true;
    if(!key){keyForm.hidden=false;status.textContent='コメント履歴を見るには台帳の管理キーを入力してください。';keyInput.focus();return;}
    keyForm.hidden=true;status.textContent='最新20件を読み込んでいます…';
    loadProfile(key,ticket,controller.signal);
    try {
      const response=await fetch(historyUrl(target.userId,target.username),{headers:{Authorization:`Bearer ${key}`},signal:controller.signal,cache:'no-store'});
      if(ticket!==revision || !dialog.open)return;
      if(response.status===401 || response.status===403){keyForm.hidden=false;status.textContent='管理キーを確認して入力してください。';keyInput.focus();return;}
      if(!response.ok)throw Error('履歴を取得できませんでした。「再取得」でお試しください。');
      const data=await response.json();
      if(ticket!==revision || !dialog.open)return;
      localStorage.setItem(storageKey,key);keyInput.value='';
      const items=(data.items||[]).slice(0,20);
      status.textContent=items.length?`保存済みの最新${items.length}件です。直前のコメントは保存待ちの場合があります。`:'保存済みのコメントはまだありません。';
      for(const item of items){
        const row=document.createElement('li'),date=document.createElement('time'),text=document.createElement('p');
        const at=new Date(item.at);date.textContent=Number.isNaN(at.getTime())?'日時不明':at.toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'});
        text.className='comment-text';text.textContent=String(item.text||'');row.append(date,text);results.append(row);
      }
      retry.hidden=false;
    }catch(error){if(error.name!=='AbortError' && ticket===revision){status.textContent=error.message;retry.hidden=false;}}
  }
  keyForm.addEventListener('submit',event=>{event.preventDefault();load(keyInput.value.normalize('NFKC').trim());});
  retry.addEventListener('click',()=>load(localStorage.getItem(storageKey)||''));
  const open=row=>{
    const context=getContext();
    if(!row?.dataset.userId || !context?.username)return;
    cancel();target={userId:row.dataset.userId,username:context.username,uniqueId:row.dataset.uniqueId||''};
    showProfile(context.preview?'':target.uniqueId);
    title.textContent=`${row.dataset.userName||target.userId}さんのコメント履歴`;
    if(!dialog.open)dialog.showModal();
    if(context.preview){results.replaceChildren();keyForm.hidden=true;retry.hidden=true;status.textContent='テスト表示では保存された履歴はありません。';return;}
    load(localStorage.getItem(storageKey)||'');
  };
  for(const root of (Array.isArray(list)?list:[list]).filter(Boolean)) {
    root.addEventListener('click',event=>{
      if(event.target.closest('a,button,input,select,textarea') || window.getSelection()?.toString())return;
      open(event.target.closest('[data-comment-history][data-user-id]'));
    });
    root.addEventListener('keydown',event=>{
      if(event.repeat || (event.key!=='Enter' && event.key!==' '))return;
      const row=event.target.closest('[data-comment-history][data-user-id]');
      if(row && event.target===row){event.preventDefault();open(row);}
    });
  }
}
