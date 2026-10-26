import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const video=await readFile(new URL('./fixtures/clip.mp4',import.meta.url));
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p}
async function start(env){const p=await port();let logs='';const child=spawn(process.execPath,['server.js'],{env:{...process.env,RENDER:'',PORT:String(p),...env},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);const base=`http://127.0.0.1:${p}`;for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(logs);try{if((await fetch(base+'/api/health')).ok)return {base,child}}catch{}await new Promise(r=>setTimeout(r,30))}child.kill();throw Error(logs)}
async function stop(child){if(child.exitCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill();await done}

test('job attachments, private chat, public portfolio, limits and restart persistence',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'mr-media-'));let app;
 const env={MEDIA_STORAGE:'local',MEDIA_DIR:path.join(dir,'media'),DB_PATH:path.join(dir,'db.sqlite')};
 try{
  app=await start(env);
  async function api(route,method='GET',body,token,expected=200){const r=await fetch(app.base+'/api'+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();assert.equal(r.status,expected,JSON.stringify(d));return d}
  const reg=(n,role)=>api('/register','POST',{name:n,phone:'7900000000'+n,password:'test-password',role,city:'Тест'},null,201);
  const client=await reg('1','client'),master=await reg('2','master'),other=await reg('3','client');
  async function upload(token,scope='job',data=png,jobId='',status=201){const r=await fetch(app.base+'/api/media?scope='+scope+(jobId?'&jobId='+jobId:''),{method:'POST',headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'image/jpeg','X-File-Name':encodeURIComponent('Тест файла')},body:data});const d=await r.json();assert.equal(r.status,status,JSON.stringify(d));return d.media}
  const file=async(m,t,status=200)=>{const r=await fetch(app.base+'/api/media/'+m.id,{headers:t?{Authorization:'Bearer '+t}:{}});assert.equal(r.status,status);return r};
  await upload(null,'job',png,'',401);
  await upload(client.token,'job',Buffer.from('<svg onload="alert(1)"/>'),'',400);
  const photo=await upload(client.token),clip=await upload(client.token,'job',video);
  assert.equal(photo.type,'image/png');assert.equal(clip.kind,'video');
  await file(photo,other.token,403);await file(photo,client.token);
  const create=(ids,t=client.token,status=201)=>api('/jobs','POST',{title:'Тест',category:'Электрика',description:'Описание',city:'Тест',mediaIds:ids},t,status);
  await create([photo.id],other.token,400);
  const {job}=await create([photo.id,clip.id]);assert.equal(job.media.length,2);
  const data=await file(clip);assert.deepEqual(Buffer.from(await data.arrayBuffer()),video);
  await create([photo.id],client.token,400);
  const excess=[];for(let i=0;i<11;i++)excess.push(await upload(client.token));
  await create(excess.map(m=>m.id),client.token,400);
  for(const m of excess)await api('/media/'+m.id,'DELETE',undefined,client.token);
  const three=[];for(let i=0;i<3;i++)three.push(await upload(client.token,'job',video));
  await create(three.map(m=>m.id),client.token,400);
  for(const m of three)await api('/media/'+m.id,'DELETE',undefined,client.token);
  await upload(client.token,'message',png,job.id,403);
  const {offer}=await api('/offers','POST',{jobId:job.id,price:100},master.token,201);
  await api('/select','POST',{jobId:job.id,offerId:offer.id},client.token);
  const privatePhoto=await upload(client.token,'message',png,job.id),privateVideo=await upload(master.token,'message',video,job.id);
  await api('/messages','POST',{jobId:job.id,mediaIds:[privatePhoto.id]},client.token,201);
  await api('/messages','POST',{jobId:job.id,text:'Видео',mediaIds:[privateVideo.id]},master.token,201);
  const messages=await api('/messages?jobId='+job.id,'GET',undefined,master.token);assert.equal(messages.messages.length,2);assert.equal(messages.messages[0].media.length,1);
  await file(privatePhoto,null,403);await file(privatePhoto,other.token,403);await file(privatePhoto,master.token);
  await api('/messages?jobId='+job.id,'GET',undefined,other.token,403);
  await file(photo,null,403); // in-progress job photos are no longer public
  const portfolioPhoto=await upload(master.token,'portfolio'),portfolioVideo=await upload(master.token,'portfolio',video);
  const {work}=await api('/portfolio','POST',{title:'Готовая работа',description:'Результат',mediaIds:[portfolioPhoto.id,portfolioVideo.id]},master.token,201);
  const album=await api('/portfolio?masterId='+master.user.id);assert.equal(album.works[0].media.length,2);await file(portfolioPhoto);
  await api('/portfolio/'+work.id,'DELETE',undefined,other.token,403);
  await stop(app.child);app=await start(env);
  assert.equal((await api('/portfolio?masterId='+master.user.id)).works.length,1);await file(privateVideo,client.token);await file(portfolioPhoto);
  await api('/portfolio/'+work.id,'DELETE',undefined,master.token);await file(portfolioPhoto,null,404);
 }finally{if(app)await stop(app.child);await rm(dir,{recursive:true,force:true})}
});

test('S3 without conditional PUT preserves versions, rejects conflicts and survives local disk replacement',async()=>{
 const objects=new Map();
 const s3=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost'),key=url.pathname;const old=objects.get(key);
  if(req.method==='GET'&&url.searchParams.get('list-type')==='2'){
   const prefix=url.searchParams.get('prefix')||'',bucket=key.replace(/\/$/,'')+'/';
   const keys=[...objects.keys()].filter(k=>k.startsWith(bucket+prefix)).sort().map(k=>k.slice(bucket.length));
   res.writeHead(200,{'Content-Type':'application/xml'});return res.end('<ListBucketResult><IsTruncated>false</IsTruncated>'+keys.map(k=>'<Contents><Key>'+k+'</Key></Contents>').join('')+'</ListBucketResult>');
  }
  if(req.method==='PUT'){
   // Deliberately ignore conditional headers, as Supabase PutObject does.
   const parts=[];for await(const b of req)parts.push(b);const body=Buffer.concat(parts),etag='"'+crypto.createHash('md5').update(body).digest('hex')+'"';objects.set(key,{body,etag});res.writeHead(200,{ETag:etag});return res.end();
  }
  if(req.method==='DELETE'){objects.delete(key);res.writeHead(204);return res.end()}
  if(!old){res.writeHead(404,{'Content-Type':'application/xml'});return res.end('<Error><Code>NoSuchKey</Code></Error>')}
  res.writeHead(200,{ETag:old.etag,'Content-Length':old.body.length});res.end(old.body);
 });
 await new Promise(r=>s3.listen(0,'127.0.0.1',r));const dir=await mkdtemp(path.join(tmpdir(),'mr-s3-'));let app;
 const env={MEDIA_STORAGE:'s3',S3_ENDPOINT:`http://127.0.0.1:${s3.address().port}`,S3_BUCKET:'test-private',S3_REGION:'us-east-1',S3_ACCESS_KEY_ID:'test-only',S3_SECRET_ACCESS_KEY:'test-only',S3_FORCE_PATH_STYLE:'true',S3_PREFIX:'test',DB_PATH:path.join(dir,'first.sqlite')};
 try{
  app=await start(env);
  const register=await fetch(app.base+'/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Тест',phone:'79000000100',password:'test-password',role:'master'})});assert.equal(register.status,201);const {token,user}=await register.json();
  const uploaded=await fetch(app.base+'/api/media?scope=portfolio',{method:'POST',headers:{Authorization:'Bearer '+token},body:png});assert.equal(uploaded.status,201);const {media}=await uploaded.json();
  const posted=await fetch(app.base+'/api/portfolio',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({title:'Облачная работа',mediaIds:[media.id]})});assert.equal(posted.status,201);
  await stop(app.child);app=await start({...env,DB_PATH:path.join(dir,'replacement.sqlite')});
  const profile=await (await fetch(app.base+'/api/portfolio?masterId='+user.id)).json();assert.equal(profile.works.length,1);
  const r=await fetch(app.base+'/api/media/'+media.id);assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),png);
  const versions=[...objects.keys()].filter(k=>k.includes('/state-journal/')).sort();assert.equal(versions.length,3);
  assert.equal(JSON.parse(objects.get(versions[0]).body).portfolio.length,0);
  assert.equal(JSON.parse(objects.get(versions.at(-1)).body).portfolio.length,1);
  // An overlapping writer cannot make one branch silently disappear.
  const fork=versions.at(-1).replace(/[a-f0-9-]{36}\.json$/,crypto.randomUUID()+'.json');
  objects.set(fork,objects.get(versions.at(-1)));
  const conflicted=await fetch(app.base+'/api/jobs');assert.equal(conflicted.status,400);assert.match((await conflicted.json()).error,/Conflicting application state revisions/);
  assert.equal(objects.size,5); // original media, three versions and retained fork
  objects.delete(fork);
  assert.equal((await fetch(app.base+'/api/portfolio?masterId='+user.id)).status,200);
 }finally{if(app)await stop(app.child);await new Promise(r=>s3.close(r));await rm(dir,{recursive:true,force:true})}
});
