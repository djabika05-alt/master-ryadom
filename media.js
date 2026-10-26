export const limits={images:10,videos:2,imageBytes:15*1024*1024,videoBytes:50*1024*1024,userBytes:500*1024*1024};
export function detectMedia(b){
 if(b.length>=3&&b[0]===255&&b[1]===216&&b[2]===255)return {type:'image/jpeg',kind:'image'};
 if(b.length>=8&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {type:'image/png',kind:'image'};
 if(b.length>=12&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP')return {type:'image/webp',kind:'image'};
 if(b.length>=12&&b.toString('ascii',4,8)==='ftyp'&&['isom','iso2','mp41','mp42','avc1','M4V ','qt  '].includes(b.toString('ascii',8,12)))return {type:b.toString('ascii',8,12)==='qt  '?'video/quicktime':'video/mp4',kind:'video'};
 if(b.length>=4&&b.subarray(0,4).equals(Buffer.from([26,69,223,163])))return {type:'video/webm',kind:'video'};
 throw Error('Поддерживаются фото JPG, PNG, WebP и видео MP4, MOV, WebM');
}
export function validateMediaSet(items){
 if(items.filter(m=>m.kind==='image').length>limits.images||items.filter(m=>m.kind==='video').length>limits.videos)throw Error('Можно добавить до 10 фото и 2 видео');
}
export function attachments(db,ids,user,scope,jobId){
 if(ids===undefined)return [];
 if(!Array.isArray(ids)||ids.length>12||new Set(ids).size!==ids.length)throw Error('Некорректные вложения');
 const items=ids.map(id=>db.media.find(m=>m.id===id&&m.ownerId===user.id&&m.scope===scope&&!m.attachedTo&&(!jobId||m.jobId===jobId)));
 if(items.some(m=>!m))throw Error('Вложение недоступно или уже использовано');
 validateMediaSet(items);return items;
}
export const publicMedia=m=>({id:m.id,name:m.name,type:m.type,kind:m.kind,size:m.size});
