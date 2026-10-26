import {mode,mediaEnabled,putMedia,getMedia,deleteMedia,readCloudState,saveCloudState} from './storage.js';
import {limits,detectMedia,validateMediaSet,attachments,publicMedia} from './media.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const dbFile=process.env.DB_PATH||path.join(dir,'master-ryadom.sqlite');
fs.mkdirSync(path.dirname(dbFile),{recursive:true});
const sqlite=new DatabaseSync(dbFile);
sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS app_state(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL)');
const initial={users:[],jobs:[],offers:[],messages:[],reviews:[],sessions:[],notifications:[],media:[],portfolio:[]};
const oldFile=path.join(dir,'data.json');
const seed=fs.existsSync(oldFile)?JSON.parse(fs.readFileSync(oldFile,'utf8')):initial;
sqlite.prepare('INSERT OR IGNORE INTO app_state(id,payload) VALUES(1,?)').run(JSON.stringify(seed));
const read=async()=>{const db=(await readCloudState(initial))||JSON.parse(sqlite.prepare('SELECT payload FROM app_state WHERE id=1').get().payload);for(const [k,v] of Object.entries(initial))if(!Array.isArray(db[k]))db[k]=[...v];return db};
const save=async db=>{if(!await saveCloudState(db))sqlite.prepare('UPDATE app_state SET payload=? WHERE id=1').run(JSON.stringify(db))};
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data))};
const hash=(p,s)=>crypto.scryptSync(p,s,64).toString('hex');
const attempts=new Map();
const throttled=key=>{const now=Date.now(),a=(attempts.get(key)||[]).filter(t=>now-t<900000);a.push(now);attempts.set(key,a);return a.length>10};
const token=()=>crypto.randomBytes(32).toString('hex');
const ttl=7*86400000;
const newSession=(db,userId)=>{const t=token();db.sessions=db.sessions.filter(s=>s.createdAt&&Date.now()-Date.parse(s.createdAt)<ttl);db.sessions.push({token:t,userId,createdAt:new Date().toISOString()});return t};
const uid=()=>crypto.randomUUID();
const cleanUser=u=>({id:u.id,name:u.name,role:u.role,city:u.city,phone:u.phone,skills:u.skills||[],createdAt:u.createdAt});
const parseBody=async req=>{let chunks=[],size=0;for await(const part of req){size+=part.length;if(size>100000)throw Error('Слишком большой запрос');chunks.push(part)}return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}')};
const auth=(req,db)=>{const t=(req.headers.authorization||'').replace(/^Bearer /,'');const s=db.sessions.find(s=>s.token===t&&s.createdAt&&Date.now()-Date.parse(s.createdAt)<ttl);return db.users.find(u=>u.id===s?.userId)};
const publicJob=(j,db,viewer)=>({id:j.id,title:j.title,category:j.category,description:j.description,city:j.city,budget:j.budget,status:j.status,createdAt:j.createdAt,clientId:viewer?.id===j.clientId?j.clientId:null,masterId:viewer?.id===j.clientId||viewer?.id===j.masterId?j.masterId:null,clientName:db.users.find(u=>u.id===j.clientId)?.name||'Заказчик',offersCount:db.offers.filter(o=>o.jobId===j.id).length,media:db.media.filter(m=>m.attachedTo===j.id&&m.scope==='job').map(publicMedia)});
const notify=(db,userId,type,job,text)=>{if(!userId)return;db.notifications.push({id:uid(),userId,type,jobId:job?.id||null,text,read:false,createdAt:new Date().toISOString()});if(db.notifications.length>5000)db.notifications.splice(0,db.notifications.length-5000)};
const port=process.env.PORT||3000;
// Verify durable state can be read before accepting traffic. A missing credential
// or unavailable cloud must not produce a healthy-looking, empty local app.
await read();
let requestQueue=Promise.resolve();
http.createServer((req,res)=>{const work=async()=>{try{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
 const u=new URL(req.url,'http://localhost'),route=u.pathname,method=req.method;
 if(!route.startsWith('/api/')){const file=route==='/'?'index.html':route.slice(1),root=path.resolve(dir,'public'),full=path.resolve(root,file);if(!full.startsWith(root+path.sep))return json(res,403,{error:'Запрещено'});if(!fs.existsSync(full)||!fs.statSync(full).isFile()||fs.lstatSync(full).isSymbolicLink())return json(res,404,{error:'Не найдено'});const ext=path.extname(full);res.writeHead(200,{'Content-Type':{'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'}[ext]||'application/octet-stream','Cache-Control':'no-cache'});return fs.createReadStream(full).pipe(res)}
 if(route==='/api/health'&&method==='GET')return json(res,200,{status:'ok'});
 const db=await read(),body=['POST','PATCH'].includes(method)&&route!=='/api/media'?await parseBody(req):{};
 if(route==='/api/register'&&method==='POST'){
  if(throttled('register:'+req.socket.remoteAddress))return json(res,429,{error:'Слишком много регистраций. Повторите позже'});
  const {name,phone,password,role,city}=body;if(typeof name!=='string'||!name.trim()||!/^[+]?[0-9()\s-]{8,20}$/.test(phone||'')||String(password||'').length<8||!['client','master'].includes(role))return json(res,400,{error:'Укажите имя, телефон, пароль от 8 символов и роль'});
  const norm=phone.replace(/\D/g,'');if(norm.length<10||norm.length>15)return json(res,400,{error:'Проверьте номер телефона'});if(db.users.some(x=>x.phone.replace(/\D/g,'')===norm))return json(res,409,{error:'Телефон уже зарегистрирован'});
  const salt=crypto.randomBytes(16).toString('hex'),user={id:uid(),name:name.trim().slice(0,80),phone:norm,passwordSalt:salt,passwordHash:hash(password,salt),role,city:String(city||'').trim().slice(0,80),skills:[],createdAt:new Date().toISOString()};db.users.push(user);const t=newSession(db,user.id);await save(db);return json(res,201,{token:t,user:cleanUser(user)})}
 if(route==='/api/login'&&method==='POST'){
  const phone=String(body.phone||'').replace(/\D/g,'');if(throttled(req.socket.remoteAddress+':'+phone))return json(res,429,{error:'Слишком много попыток. Повторите позже'});const user=db.users.find(x=>x.phone===phone),candidate=hash(String(body.password||''),user?.passwordSalt||'master-ryadom-v1');if(!user||!crypto.timingSafeEqual(Buffer.from(user.passwordHash,'hex'),Buffer.from(candidate,'hex')))return json(res,401,{error:'Неверный телефон или пароль'});const t=newSession(db,user.id);await save(db);return json(res,200,{token:t,user:cleanUser(user)})}
 const user=auth(req,db);
 if(route==='/api/media/config'&&method==='GET')return json(res,200,{enabled:mediaEnabled,limits});
 if(route==='/api/media'&&method==='POST'){
  if(!user)return json(res,401,{error:'Войдите'});
  if(!mediaEnabled)return json(res,503,{error:'Загрузка пока недоступна. Подключается постоянное хранилище'});
  const scope=u.searchParams.get('scope'),jobId=u.searchParams.get('jobId');
  if(!['job','message','portfolio'].includes(scope))return json(res,400,{error:'Укажите назначение файла'});
  if(scope==='job'&&user.role!=='client')return json(res,403,{error:'Только для заказчика'});
  if(scope==='portfolio'&&user.role!=='master')return json(res,403,{error:'Только для мастера'});
  if(scope==='message'){
   const job=db.jobs.find(j=>j.id===jobId);
   if(!job||!job.masterId||![job.clientId,job.masterId].includes(user.id))return json(res,403,{error:'Нет доступа к переписке'});
  }
  const expired=db.media.filter(m=>m.ownerId===user.id&&!m.attachedTo&&Date.now()-Date.parse(m.createdAt)>86400000);
  if(expired.length){db.media=db.media.filter(m=>!expired.includes(m));await save(db);await Promise.all(expired.map(m=>deleteMedia(m.id)))}
  const pending=db.media.filter(m=>m.ownerId===user.id&&!m.attachedTo);
  if(pending.length>=24)return json(res,409,{error:'Удалите неиспользованные вложения перед новой загрузкой'});
  const max=limits.videoBytes;let size=0;const chunks=[];
  for await(const part of req){size+=part.length;if(size>max)throw Error('Видео — до 50 МБ, фото — до 15 МБ');chunks.push(part)}
  const bytes=Buffer.concat(chunks),detected=detectMedia(bytes);
  if(size>(detected.kind==='image'?limits.imageBytes:limits.videoBytes))throw Error('Фото — до 15 МБ, видео — до 50 МБ');
  if(db.media.filter(m=>m.ownerId===user.id).reduce((n,m)=>n+m.size,0)+size>limits.userBytes)throw Error('Лимит хранилища профиля — 500 МБ. Удалите ненужные файлы');
  let name;try{name=decodeURIComponent(String(req.headers['x-file-name']||'Файл'))}catch{throw Error('Некорректное имя файла')}
  const m={id:uid(),ownerId:user.id,scope,jobId:jobId||null,name:name.replace(/[\x00-\x1f]/g,'').slice(0,180),size,...detected,attachedTo:null,createdAt:new Date().toISOString()};
  await putMedia(m.id,bytes,m.type);db.media.push(m);
  try{await save(db)}catch(e){await deleteMedia(m.id).catch(()=>{});throw e}
  return json(res,201,{media:publicMedia(m)});
 }
 const mediaMatch=route.match(/^\/api\/media\/([a-f0-9-]{36})$/);
 if(mediaMatch){
  const m=db.media.find(m=>m.id===mediaMatch[1]);
  if(!m)return json(res,404,{error:'Файл не найден'});
  const job=m.scope==='job'?db.jobs.find(j=>j.id===m.attachedTo):db.jobs.find(j=>j.id===m.jobId);
  const visible=m.ownerId===user?.id||(m.scope==='portfolio'&&db.portfolio.some(p=>p.id===m.attachedTo))||(m.scope==='job'&&job&&(job.status==='open'||[job.clientId,job.masterId].includes(user?.id)))||(m.scope==='message'&&m.attachedTo&&job&&[job.clientId,job.masterId].includes(user?.id));
  if(method==='GET'){
   if(!visible)return json(res,403,{error:'Нет доступа к файлу'});
   const stream=await getMedia(m.id);
   res.writeHead(200,{'Content-Type':m.type,'Content-Length':m.size,'Cache-Control':'private, no-store','Content-Disposition':`inline; filename="${m.id}"`});
   stream.on('error',()=>res.destroy());stream.pipe(res);return;
  }
  if(method==='DELETE'){
   if(m.ownerId!==user?.id||m.attachedTo)return json(res,403,{error:'Можно удалить только своё неотправленное вложение'});
   db.media=db.media.filter(x=>x.id!==m.id);await save(db);await deleteMedia(m.id);return json(res,200,{ok:true});
  }
 }
 if(route==='/api/portfolio'&&method==='GET'){
  const ownerId=u.searchParams.get('masterId')||user?.id,master=db.users.find(x=>x.id===ownerId&&x.role==='master');
  if(!master)return json(res,404,{error:'Мастер не найден'});
  return json(res,200,{master:{id:master.id,name:master.name,city:master.city},works:db.portfolio.filter(p=>p.masterId===ownerId).map(p=>({...p,media:db.media.filter(m=>m.scope==='portfolio'&&m.attachedTo===p.id).map(publicMedia)}))});
 }
 if(route==='/api/portfolio'&&method==='POST'){
  if(!user||user.role!=='master')return json(res,403,{error:'Только для мастера'});
  if(typeof body.title!=='string'||!body.title.trim())throw Error('Укажите название работы');
  if(db.portfolio.filter(p=>p.masterId===user.id).length>=50)throw Error('В портфолио можно сохранить до 50 работ');
  const files=attachments(db,body.mediaIds,user,'portfolio');if(!files.length)throw Error('Добавьте фото или видео выполненной работы');
  const work={id:uid(),masterId:user.id,title:body.title.trim().slice(0,120),description:String(body.description||'').trim().slice(0,3000),createdAt:new Date().toISOString()};
  files.forEach(m=>m.attachedTo=work.id);db.portfolio.unshift(work);await save(db);return json(res,201,{work});
 }
 const workMatch=route.match(/^\/api\/portfolio\/([a-f0-9-]{36})$/);
 if(workMatch&&method==='DELETE'){
  const work=db.portfolio.find(p=>p.id===workMatch[1]);
  if(!work||work.masterId!==user?.id)return json(res,403,{error:'Нет доступа'});
  const files=db.media.filter(m=>m.scope==='portfolio'&&m.attachedTo===work.id);
  db.portfolio=db.portfolio.filter(p=>p.id!==work.id);db.media=db.media.filter(m=>!files.includes(m));await save(db);
  await Promise.all(files.map(m=>deleteMedia(m.id)));return json(res,200,{ok:true});
 }

 if(route==='/api/jobs'&&method==='GET'){let jobs=db.jobs.filter(j=>j.status==='open'||(user&&j.clientId===user.id)||(user&&j.masterId===user.id));if(u.searchParams.get('mine')==='1'){if(!user)return json(res,401,{error:'Войдите'});jobs=jobs.filter(j=>j.clientId===user.id||j.masterId===user.id)}return json(res,200,{jobs:jobs.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(j=>publicJob(j,db,user))})}
 if(route==='/api/jobs'&&method==='POST'){if(!user)return json(res,401,{error:'Войдите'});if(user.role!=='client')return json(res,403,{error:'Создавать заявки может заказчик'});const {title,category,description,city,budget}=body;if(typeof title!=='string'||!title.trim()||typeof category!=='string'||!category.trim()||typeof description!=='string'||!description.trim()||typeof city!=='string'||!city.trim())return json(res,400,{error:'Заполните обязательные поля'});const job={id:uid(),clientId:user.id,title:title.trim().slice(0,120),category:category.trim().slice(0,60),description:description.trim().slice(0,3000),city:city.trim().slice(0,80),budget:Math.min(100000000,Math.max(0,Number(budget)||0)),status:'open',masterId:null,createdAt:new Date().toISOString()};const files=attachments(db,body.mediaIds,user,'job');files.forEach(m=>m.attachedTo=job.id);db.jobs.push(job);await save(db);return json(res,201,{job:publicJob(job,db,user)})}
 if(!user)return json(res,401,{error:'Войдите в аккаунт'});
 if(route==='/api/me'&&method==='GET')return json(res,200,{user:cleanUser(user)});
 if(route==='/api/logout'&&method==='POST'){db.sessions=db.sessions.filter(s=>s.token!==(req.headers.authorization||'').replace(/^Bearer /,''));await save(db);return json(res,200,{ok:true})}
 if(route==='/api/notifications'&&method==='GET'){const notifications=db.notifications.filter(n=>n.userId===user.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,100);return json(res,200,{notifications,unread:db.notifications.filter(n=>n.userId===user.id&&!n.read).length})}
 if(route==='/api/notifications/read'&&method==='POST'){const ids=Array.isArray(body.ids)?body.ids.filter(x=>typeof x==='string').slice(0,100):null;for(const n of db.notifications)if(n.userId===user.id&&(!ids||ids.includes(n.id)))n.read=true;await save(db);return json(res,200,{ok:true})}
 if(route==='/api/offers'&&method==='POST'){if(user.role!=='master')return json(res,403,{error:'Только для мастеров'});const job=db.jobs.find(j=>j.id===body.jobId);if(!job||job.status!=='open')return json(res,404,{error:'Заявка недоступна'});if(db.offers.some(o=>o.jobId===job.id&&o.masterId===user.id))return json(res,409,{error:'Вы уже откликнулись'});const price=Number(body.price);if(body.price===undefined||body.price===''||!Number.isFinite(price)||price<0||price>100000000)return json(res,400,{error:'Некорректная цена'});const offer={id:uid(),jobId:job.id,masterId:user.id,price,comment:String(body.comment||'').trim().slice(0,1000),createdAt:new Date().toISOString()};db.offers.push(offer);notify(db,job.clientId,'offer',job,`Новый отклик на «${job.title}» от ${user.name}`);await save(db);return json(res,201,{offer})}
 if(route==='/api/offers'&&method==='GET'){const job=db.jobs.find(j=>j.id===u.searchParams.get('jobId'));if(!job||job.clientId!==user.id)return json(res,403,{error:'Нет доступа'});return json(res,200,{offers:db.offers.filter(o=>o.jobId===job.id).map(o=>({...o,masterName:db.users.find(x=>x.id===o.masterId)?.name||'Мастер'}))})}
 if(route==='/api/select'&&method==='POST'){const job=db.jobs.find(j=>j.id===body.jobId),offer=db.offers.find(o=>o.id===body.offerId&&o.jobId===job?.id);if(!job||job.clientId!==user.id||job.status!=='open'||!offer)return json(res,403,{error:'Нельзя выбрать мастера'});job.masterId=offer.masterId;job.status='in_progress';notify(db,offer.masterId,'selected',job,`Вас выбрали мастером по заявке «${job.title}»`);await save(db);return json(res,200,{job:publicJob(job,db,user)})}
 if(route==='/api/complete'&&method==='POST'){const job=db.jobs.find(j=>j.id===body.jobId);if(!job||job.clientId!==user.id||job.status!=='in_progress')return json(res,403,{error:'Нельзя завершить заявку'});job.status='completed';notify(db,job.masterId,'completed',job,`Работа по заявке «${job.title}» завершена`);await save(db);return json(res,200,{job:publicJob(job,db,user)})}
 if(route==='/api/messages'&&method==='GET'){const job=db.jobs.find(j=>j.id===u.searchParams.get('jobId'));if(!job||![job.clientId,job.masterId].includes(user.id)||!job.masterId)return json(res,403,{error:'Нет доступа к переписке'});return json(res,200,{messages:db.messages.filter(m=>m.jobId===job.id).map(m=>({...m,senderName:db.users.find(x=>x.id===m.senderId)?.name||'Участник',media:db.media.filter(f=>f.scope==='message'&&f.attachedTo===m.id).map(publicMedia)}))})}
 if(route==='/api/messages'&&method==='POST'){const job=db.jobs.find(j=>j.id===body.jobId);if(!job||![job.clientId,job.masterId].includes(user.id)||!job.masterId||(typeof body.text!=='string'||!body.text.trim())&&!(Array.isArray(body.mediaIds)&&body.mediaIds.length))return json(res,403,{error:'Сообщение недоступно'});const msg={id:uid(),jobId:job.id,senderId:user.id,text:String(body.text||'').trim().slice(0,2000),createdAt:new Date().toISOString()};const files=attachments(db,body.mediaIds,user,'message',job.id);files.forEach(m=>m.attachedTo=msg.id);db.messages.push(msg);notify(db,user.id===job.clientId?job.masterId:job.clientId,'message',job,`Новое сообщение по заявке «${job.title}»`);await save(db);return json(res,201,{message:msg})}
 if(route==='/api/reviews'&&method==='POST'){const job=db.jobs.find(j=>j.id===body.jobId),rating=Number(body.rating);if(!job||job.clientId!==user.id||job.status!=='completed'||!Number.isInteger(rating)||rating<1||rating>5||db.reviews.some(r=>r.jobId===job.id))return json(res,403,{error:'Отзыв недоступен'});const review={id:uid(),jobId:job.id,masterId:job.masterId,rating,text:String(body.text||'').slice(0,1000)};db.reviews.push(review);notify(db,job.masterId,'review',job,`Новый отзыв по заявке «${job.title}»`);await save(db);return json(res,201,{review})}
 return json(res,404,{error:'Не найдено'});
}catch(e){return json(res,400,{error:e.message||'Ошибка сервера'})}};requestQueue=requestQueue.then(work,work);}).listen(port,()=>console.log(`МАСТЕР РЯДОМ: http://localhost:${port}`));
