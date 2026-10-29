export function setupScreenshotRecords({root,getUsername,fetcher=fetch,storage=localStorage}) {
  if(!root)return {setScope(){}};
  const find=id=>root.querySelector('#'+id);
  const scope=find('screenshotScope'),status=find('screenshotStatus'),list=find('screenshotRecordsList');
  const keyForm=find('screenshotKeyForm'),key=find('screenshotAdminKey'),refresh=find('screenshotRefresh');
  let controller,revision=0,items=[];
  function setBusy(busy) {
    busy?root.setAttribute('aria-busy','true'):root.removeAttribute('aria-busy');
    root.querySelectorAll('button,input[type=checkbox]').forEach(el=>el.disabled=busy);
  }
  function draw() {
    list.replaceChildren();
    const search=find('screenshotSearch').value.toLowerCase().trim();
    for(const item of items.filter(r=>[r.tiktok_id,r.nickname,r.source].join(' ').toLowerCase().includes(search))) {
      const row=document.createElement('li'),identity=document.createElement('div'),link=document.createElement('a');
      link.textContent='@'+item.tiktok_id;link.href='https://www.tiktok.com/@'+encodeURIComponent(item.tiktok_id);link.target='_blank';link.rel='noopener noreferrer';
      const detail=document.createElement('small');
      const recordedAt=item.created_at?new Date(item.created_at):null;
      detail.textContent=[item.nickname,{found:'履歴あり',none:'履歴なし',ambiguous:'複数候補・要確認'}[item.history],item.source,
        recordedAt && !Number.isNaN(recordedAt.getTime())?recordedAt.toLocaleDateString('ja-JP',{timeZone:'Asia/Tokyo'}):''].filter(Boolean).join(' · ');
      identity.append(link,detail);
      const label=document.createElement('label'),toggle=document.createElement('input');toggle.type='checkbox';toggle.checked=item.enabled;
      toggle.setAttribute('aria-label','@'+item.tiktok_id+'の来訪を強調');
      toggle.addEventListener('change',()=>request('PATCH',{id:item.tiktok_id,enabled:toggle.checked}));
      label.append(toggle,document.createTextNode('来訪を強調'));row.append(identity,label);list.append(row);
    }
  }
  async function request(method='GET',body) {
    controller?.abort();controller=new AbortController();const ticket=++revision;
    setBusy(false);
    const username=scope.value.trim().replace(/^@/,'').toLowerCase();
    const adminKey=key.value.trim()||storage.getItem('tiktok-listener-admin-key')||'';
    if(!username){status.textContent='配信者IDを指定してください';return;}
    if(!adminKey){keyForm.hidden=false;status.textContent='記録IDの管理には台帳の管理キーが必要です';return;}
    setBusy(true);
    status.textContent=method==='GET'?'記録IDと履歴を照合中…':'保存・照合中…';
    try {
      const response=await fetcher('/api/screenshot-records?'+new URLSearchParams({username}),{method,headers:{Authorization:'Bearer '+adminKey,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:controller.signal,cache:'no-store'});
      const data=await response.json();
      if(ticket!==revision)return;
      if(!response.ok){if(response.status===401)keyForm.hidden=false;throw Error(data.error||'記録IDを取得できませんでした');}
      storage.setItem('tiktok-listener-admin-key',adminKey);key.value='';keyForm.hidden=true;
      items=data.items||[];draw();
      status.textContent=`${items.length}件 · 来訪を強調 ${items.filter(r=>r.enabled).length}件`;
      if(method==='POST')find('screenshotIds').value='';
    } catch(error) {if(ticket===revision && error.name!=='AbortError'){draw();status.textContent=error.message;}}
    finally {if(ticket===revision)setBusy(false);}
  }
  refresh.addEventListener('click',()=>request());
  scope.addEventListener('change',()=>{items=[];draw();request();});
  find('screenshotSearch').addEventListener('input',draw);
  keyForm.addEventListener('submit',event=>{event.preventDefault();request();});
  find('screenshotAddForm').addEventListener('submit',event=>{event.preventDefault();request('POST',{ids:find('screenshotIds').value,source:find('screenshotSource').value});});
  let previous='';
  return {setScope(){const current=String(getUsername()||'').toLowerCase();if(current && current!==previous){previous=current;scope.value=current;items=[];draw();request();}}};
}
