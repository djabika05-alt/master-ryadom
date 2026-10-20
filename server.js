import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const dbFile=process.env.DB_PATH||path.join(dir,'master-ryadom.sqlite');
fs.mkdirSync(path.dirname(dbFile),{recursive:true});
const sqlite=new DatabaseSync(dbFile);
sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK (id=1), payload TEXT NOT NULL)');
const initial={users:[],jobs:[],offers:[],messages:[],reviews:[],sessions:[]};
const oldFile=path.join(dir,'data.json');
const seed=fs.existsSync(oldFile)?JSON.parse(fs.readFileSync(oldFile,'utf8')):initial;
sqlite.prepare('INSERT OR IGNORE INTO app_state (id,payload) VALUES (1,?)').run(JSON.stringify(seed));
const read=()=>JSON.parse(sqlite.prepare('SELECT payload FROM app_state WHERE id=1').get().payload);
const save=db=>{sqlite.prepare('UPDATE app_state SET payload=? WHERE id=1').run(JSON.stringify(db))};
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data))};
const hash=(p,salt)=>crypto.scryptSync(p,salt,64).toString('hex');
const attempts=new Map();
const throttled=(key)=>{const now=Date.now();const a=attempts.get(key)||[];const recent=a.filter(t=>now-t<15*60*1000);recent.push(now);attempts.set(key,recent);return recent.length>10};
const token=()=>crypto.randomBytes(32).toString('hex');
const SESSION_TTL_MS=7*24*60*60*1000;
const newSession=(db,userId)=>{const t=token();db.sessions=db.sessions.filter(s=>s.createdAt&&Date.now()-Date.parse(s.createdAt)<SESSION_TTL_MS);db.sessions.push({token:t,userId,createdAt:new Date().toISOString()});return t};
const uid=()=>crypto.randomUUID();
const cleanUser=u=>({id:u.id,name:u.name,role:u.role,city:u.city,phone:u.phone,skills:u.skills||[],createdAt:u.createdAt});
const parseBody=async req=>{let chunks=[],size=0;for await(const part of req){size+=part.length;if(size>100000)throw new Error('Слишком большой запрос');chunks.push(part)}return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}')};
const auth=(req,db)=>{const t=(req.headers.authorization||'').replace(/^Bearer /,'');const session=db.sessions.find(s=>s.token===t&&s.createdAt&&Date.now()-Date.parse(s.createdAt)<SESSION_TTL_MS);return db.users.find(u=>u.id===session?.userId)};
const publicJob=(j,db,viewer)=>({id:j.id,title:j.title,category:j.category,description:j.description,city:j.city,budget:j.budget,status:j.status,createdAt:j.createdAt,clientId:viewer?.id===j.clientId?j.clientId:null,masterId:viewer?.id===j.clientId||viewer?.id===j.masterId?j.masterId:null,clientName:db.users.find(u=>u.id===j.clientId)?.name||'Заказчик',offersCount:db.offers.filter(o=>o.jobId===j.id).length});
const port=process.env.PORT||3000;
http.createServer(async(req,res)=>{try{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
 const u=new URL(req.url,'http://localhost');const route=u.pathname;const method=req.method;
 if(!route.startsWith('/api/')){let file=route==='/'?'index.html':route.slice(1);const root=path.resolve(dir,'public');const full=path.resolve(root,file);if(!full.startsWith(root+path.sep))return json(res,403,{error:'Запрещено'});if(!fs.existsSync(full)||!fs.statSync(full).isFile()||fs.lstatSync(full).isSymbolicLink())return json(res,404,{error:'Не найдено'});const ext=path.extname(full);res.writeHead(200,{'Content-Type':{'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'}[ext]||'application/octet-stream'});return fs.createReadStream(full).pipe(res)}
 if(route==='/api/health'&&method==='GET')return json(res,200,{status:'ok'});
 const db=read();const body=['POST','PATCH'].includes(method)?await parseBody(req):{};
 if(route==='/api/register'&&method==='POST'){
  if(throttled('register:'+req.socket.remoteAddress))return json(res,429,{error:'Слишком много регистраций. Повторите позже'});
  const {name,phone,password,role,city}=body;if(typeof name!=='string'||!name.trim()||!/^\+?[0-9()\s-]{8,20}$/.test(phone||'')||String(password||'').length<8||!['client','master'].includes(role))return json(res,400,{error:'Укажите имя, телефон, пароль от 8 символов и роль'});
  const norm=phone.replace(/\D/g,'');if(norm.length<10||norm.length>15)return json(res,400,{error:'Проверьте номер телефона'});if(db.users.some(x=>x.phone.replace(/\D/g,'')===norm))return json(res,409,{error:'Телефон уже зарегистрирован'});
  const salt=crypto.randomBytes(16).toString('hex');const user={id:uid(),name:name.trim().slice(0,80),phone:norm,passwordSalt:salt,passwordHash:hash(password,salt),role,city:String(city||'').trim().slice(0,80),skills:[],createdAt:new Date().toISOString()};db.users.push(user);const t=newSession(db,user.id);save(db);return json(res,201,{token:t,user:cleanUser(user)})}
 if(route==='/api/login'&&method==='POST'){
  const phone=String(body.phone||'').replace(/\D/g,'');if(throttled(req.socket.remoteAddress+':'+phone))return json(res,429,{error:'Слишком много попыток. Повторите позже'});const user=db.users.find(x=>x.phone===phone);const candidate=hash(String(body.password||''),user?.passwordSalt||'master-ryadom-v1');if(!user||!crypto.timingSafeEqual(Buffer.from(user.passwordHash,'hex'),Buffer.from(candidate,'hex')))return json(res,401,{error:'Неверный телефон или пароль'});const t=newSession(db,user.id);save(db);return json(res,200,{token:t,user:cleanUser(user)})}
 const user=auth(req,db);
 if(route==='/api/jobs'&&method==='GET'){let jobs=db.jobs.filter(j=>j.status==='open'||(user&&j.clientId===user.id)||(user&&j.masterId===user.id));if(u.searchParams.get('mine')==='1'){if(!user)return json(res,401,{error:'Войдите'});jobs=jobs.filter(j=>j.clientId===user.id||j.masterId===user.id)}return json(res,200,{jobs:jobs.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(j=>publicJob(j,db,user))})}
 if(route==='/api/jobs'&&method==='POST'){if(!user)return json(res,401,{error:'Войдите'});if(user.role!=='client')return json(res,403,{error:'Создавать заявки может заказчик'});const {title,category,description,city,budget}=body;if(typeof title!=='string'||!title.trim()||typeof category!=='string'||!category.trim()||typeof description!=='string'||!description.trim()||typeof city!=='string'||!city.trim())return json(res,400,{error:'Заполните обязательные поля'});const job={id:uid(),clientId:user.id,title:title.trim().slice(0,120),category:String(category).slice(0,60),description:description.trim().slice(0,3000),city:city.trim().slice(0,80),budget:Math.min(100000000,Math.max(0,Number(budget)||0)),status:'open',masterId:null,createdAt:new Date().toISOString()};db.jobs.push(job);save(db);return json(res,201,{job:publicJob(job,db,user)})}
 if(!user)return json(res,401,{error:'Войдите в аккаунт'});
 if(route==='/api/me'&&method==='GET')return json(res,200,{user:cleanUser(user)});
 if(route==='/api/logout'&&method==='POST'){db.sessions=db.sessions.filter(s=>s.token!==(req.headers.authorization||'').replace(/^Bearer /,''));save(db);return json(res,200,{ok:true})}
 if(route==='/api/offers'&&method==='POST'){if(user.role!=='master')return json(res,403,{error:'Только для мастеров'});const job=db.jobs.find(j=>j.id===body.jobId);if(!job||job.status!=='open')return json(res,404,{error:'Заявка недоступна'});if(db.offers.some(o=>o.jobId===job.id&&o.masterId===user.id))return json(res,409,{error:'Вы уже откликнулись'});const price=Number(body.price);if(body.price===undefined||body.price===''||!Number.isFinite(price)||price<0||price>100000000)return json(res,400,{error:'Некорректная цена'});const offer={id:uid(),jobId:job.id,masterId:user.id,price,comment:String(body.comment||'').trim().slice(0,1000),createdAt:new Date().toISOString()};db.offers.push(offer);save(db);return json(res,201,{offer})}
 if(route==='/api/offers'&&method==='GET'){const job=db.jobs.find(j=>j.id===u.searchParams.get('jobId'));if(!job||job.clientId!==user.id)return json(res,403,{error:'Нет доступа'});return json(res,200,{offers:db.offers.filter(o=>o.jobId===job.id).map(o=>({...o,masterName:db.users.find(x=>x.id===o.masterId)?.name||'Мастер'}))})}
 if(route==='/api/select'&&method==='POST'){const job=db.jobs.find(j=>j.id===body.jobId);const offer=db.offers.find(o=>o.id===body.offerId&&o.jobId===job?.id);if(!job||job.clientId!==user.id||job.status!=='open'||!offer)return json(res,403,{error:'Нельзя выбрать мастера'});job.masterId=offer.masterId;job.status='in_progress';save(db);return json(res,200,{job:publicJob(job,db,user)})}
 if(route==='/api/complete'&&method==='POST'){const job=db.jobs.find(j=>j.id===body.jobId);if(!job||job.clientId!==user.id||job.status!=='in_progress')return json(res,403,{error:'Нельзя завершить заявку'});job.status='completed';save(db);return json(res,200,{job:publicJob(job,db,user)})}
 if(route==='/api/messages'&&method==='GET'){const job=db.jobs.find(j=>j.id===u.searchParams.get('jobId'));if(!job||![job.clientId,job.masterId].includes(user.id)||!job.masterId)return json(res,403,{error:'Нет доступа к переписке'});return json(res,200,{messages:db.messages.filter(m=>m.jobId===job.id).map(m=>({...m,senderName:db.users.find(x=>x.id===m.senderId)?.name||'Участник'}))})}
 if(route==='/api/messages'&&method==='POST'){const job=db.jobs.find(j=>j.id===body.jobId);if(!job||![job.clientId,job.masterId].includes(user.id)||!job.masterId||!body.text?.trim())return json(res,403,{error:'Сообщение недоступно'});const msg={id:uid(),jobId:job.id,senderId:user.id,text:body.text.trim().slice(0,2000),createdAt:new Date().toISOString()};db.messages.push(msg);save(db);return json(res,201,{message:msg})}
 if(route==='/api/reviews'&&method==='POST'){const job=db.jobs.find(j=>j.id===body.jobId);const rating=Number(body.rating);if(!job||job.clientId!==user.id||job.status!=='completed'||!Number.isInteger(rating)||rating<1||rating>5||db.reviews.some(r=>r.jobId===job.id))return json(res,403,{error:'Отзыв недоступен'});const review={id:uid(),jobId:job.id,masterId:job.masterId,rating,text:String(body.text||'').slice(0,1000)};db.reviews.push(review);save(db);return json(res,201,{review})}
 return json(res,404,{error:'Не найдено'});
}catch(e){return json(res,400,{error:e.message||'Ошибка сервера'})}}).listen(port,()=>console.log(`МАСТЕР РЯДОМ: http://localhost:${port}`));
