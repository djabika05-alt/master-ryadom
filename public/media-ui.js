let mediaDisposers=[];
function disposeMedia(){for(const dispose of mediaDisposers.splice(0))dispose()}
function mediaGallery(items=[]){return items.length?`<div class="media-gallery">${items.map(m=>`<div class="media-item" data-media="${esc(m.id)}" data-kind="${esc(m.kind)}"><button type="button" class="secondary media-load">${m.kind==='video'?'▶ Смотреть видео':'Загрузить фото'}<small>${esc(m.name)}</small></button></div>`).join('')}</div>`:''}
function hydrateMedia(){
 const controller=new AbortController(),urls=[];
 mediaDisposers.push(()=>{controller.abort();urls.forEach(u=>URL.revokeObjectURL(u))});
 for(const el of document.querySelectorAll('[data-media]')){
  const load=async()=>{
   const b=el.querySelector('button');if(!b)return;b.disabled=true;
   try{
    const r=await fetch('/api/media/'+el.dataset.media,{headers:token?{Authorization:'Bearer '+token}:{},signal:controller.signal});
    if(!r.ok)throw Error('Файл недоступен');
    const blob=await r.blob(),url=URL.createObjectURL(blob);urls.push(url);
    if(!el.isConnected)return;
    const media=document.createElement(el.dataset.kind==='video'?'video':'img');
    media.src=url;if(media.tagName==='VIDEO'){media.controls=true;media.playsInline=true;media.preload='metadata'}else{media.alt='Фото к работе';media.loading='lazy';media.onclick=()=>media.classList.toggle('expanded')}
    el.replaceChildren(media);
   }catch(e){if(e.name!=='AbortError'){b.disabled=false;b.textContent='Повторить загрузку'}}
  };
  el.querySelector('button').onclick=load;
  // Videos download only after a tap, to save mobile data.
  if(el.dataset.kind==='image')load();
 }
}
function mediaPicker(container,scope,jobId){
 const files=[];let committed=false,disposed=false,enabled=false;
 container.innerHTML='<label>Фото и видео</label><p class="muted media-hint">До 10 фото (15 МБ каждое) и 2 видео (50 МБ каждое). JPG, PNG, WebP, MP4, MOV, WebM.</p><label class="media-select">＋ Добавить фото и видео<input type="file" multiple accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm" aria-label="Выбрать фото и видео" hidden disabled></label><p class="media-status" role="status" aria-live="polite"></p><div class="media-gallery previews"></div>';
 const input=container.querySelector('input'),status=container.querySelector('.media-status'),gallery=container.querySelector('.previews');
 api('/media/config').then(c=>{if(disposed)return;enabled=c.enabled;input.disabled=!enabled;if(!enabled)status.textContent='Прикрепление файлов временно недоступно'}).catch(()=>{status.textContent='Не удалось проверить доступность загрузки'});
 const draw=()=>{gallery.replaceChildren();files.forEach((item,i)=>{
  const card=document.createElement('div');card.className='media-item';
  const media=document.createElement(item.file.type.startsWith('video/')?'video':'img');media.src=item.url;if(media.tagName==='VIDEO'){media.controls=true;media.preload='metadata';media.playsInline=true}else media.alt=item.file.name;
  const label=document.createElement('small');label.textContent=item.file.name;
  const remove=document.createElement('button');remove.type='button';remove.className='remove-media';remove.textContent='Удалить';remove.onclick=async()=>{if(item.media){try{await api('/media/'+item.media.id,'DELETE')}catch(e){toast(e.message);return}}URL.revokeObjectURL(item.url);files.splice(i,1);draw()};
  card.append(media,label,remove);gallery.append(card);
 });status.textContent=files.length?`Выбрано: ${files.filter(x=>x.file.type.startsWith('image/')).length} фото, ${files.filter(x=>x.file.type.startsWith('video/')).length} видео`:''};
 input.onchange=()=>{
  const added=[...input.files];input.value='';const all=[...files.map(x=>x.file),...added];
  if(all.some(f=>!['image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm'].includes(f.type)))return toast('Выберите JPG, PNG, WebP, MP4, MOV или WebM');
  if(all.filter(f=>f.type.startsWith('image/')).length>10||all.filter(f=>f.type.startsWith('video/')).length>2)return toast('Можно добавить до 10 фото и 2 видео');
  if(all.some(f=>f.size>(f.type.startsWith('image/')?15:50)*1024*1024))return toast('Фото — до 15 МБ, видео — до 50 МБ');
  added.forEach(file=>files.push({file,url:URL.createObjectURL(file)}));draw();
 };
 mediaDisposers.push(()=>{disposed=true;for(const item of files){URL.revokeObjectURL(item.url);if(item.media&&!committed)api('/media/'+item.media.id,'DELETE').catch(()=>{})}});
 return {count:()=>files.length,commit:()=>{committed=true},async upload(){
  if(files.length&&!enabled)throw Error('Загрузка файлов сейчас недоступна');
  for(let i=0;i<files.length;i++){
   const item=files[i];if(item.media)continue;
   status.textContent=`Загрузка файла ${i+1} из ${files.length}… Не закрывайте окно.`;
   const r=await fetch('/api/media?scope='+scope+(jobId?'&jobId='+encodeURIComponent(jobId):''),{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':item.file.type,'X-File-Name':encodeURIComponent(item.file.name)},body:item.file});
   const d=await r.json();if(!r.ok)throw Error(d.error||'Не удалось загрузить файл');item.media=d.media;
  }
  return files.map(x=>x.media.id);
 }};
}
async function submitMedia(form,picker,send){
 const fields=Object.fromEntries(new FormData(form)),sheet=form.closest('.sheet'),controls=[...sheet.querySelectorAll('button,input,select,textarea')],prior=controls.map(el=>el.disabled);
 controls.forEach(el=>el.disabled=true);
 try{await send(await picker.upload(),fields)}catch(e){toast(e.message)}finally{controls.forEach((el,i)=>el.disabled=prior[i])}
}
async function portfolio(masterId){
 try{
  const d=await api('/portfolio?masterId='+encodeURIComponent(masterId)),own=user?.id===masterId;
  modal(`<h2>${own?'Моё портфолио':'Работы мастера'}</h2><p><b>${esc(d.master.name)}</b> · ${esc(d.master.city||'')}</p>${own?'<button class="full" onclick="newPortfolioWork()">+ Добавить выполненную работу</button>':''}<button class="full secondary" id="sharePortfolio">Скопировать ссылку на портфолио</button>${d.works.length?d.works.map(w=>`<article class="offer"><h3>${esc(w.title)}</h3><p>${esc(w.description)}</p>${mediaGallery(w.media)}${own?`<button class="full secondary" onclick="removeWork('${w.id}')">Удалить работу</button>`:''}</article>`).join(''):'<p class="empty">Здесь появятся фото и видео выполненных работ.</p>'}`);
  $('#sharePortfolio').onclick=async()=>{const link=location.origin+'/?master='+encodeURIComponent(masterId);try{await navigator.clipboard.writeText(link);toast('Ссылка скопирована')}catch{prompt('Ссылка на портфолио',link)}};
  hydrateMedia();
 }catch(e){toast(e.message)}
}
function newPortfolioWork(){
 modal('<h2>Выполненная работа</h2><p class="muted">Эти фото, видео и описание будут видны посетителям вашего портфолио.</p><form id="portfolioForm"><label>Название работы</label><input name="title" required maxlength="120" placeholder="Например, электрика в частном доме"><label>Что сделали</label><textarea name="description" maxlength="3000" placeholder="Расскажите о задаче и результате"></textarea><div id="portfolioMedia"></div><button class="full">Сохранить в портфолио</button></form>');
 const picker=mediaPicker($('#portfolioMedia'),'portfolio');
 $('#portfolioForm').onsubmit=async e=>{e.preventDefault();if(!picker.count())return toast('Добавьте хотя бы одно фото или видео');await submitMedia(e.target,picker,async (mediaIds,fields)=>{await api('/portfolio','POST',{...fields,mediaIds});picker.commit();await portfolio(user.id);toast('Работа добавлена в портфолио')})};
}
async function removeWork(id){if(!confirm('Удалить работу вместе с фото и видео?'))return;try{await api('/portfolio/'+id,'DELETE');await portfolio(user.id)}catch(e){toast(e.message)}}
