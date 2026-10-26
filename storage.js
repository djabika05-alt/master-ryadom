import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command} from '@aws-sdk/client-s3';

// Production uses a PRIVATE S3-compatible bucket for both metadata and media.
// Local storage must be explicitly enabled for development; it is not durable on Render Free.
export const mode=process.env.MEDIA_STORAGE||'disabled';
if(!['disabled','local','s3'].includes(mode))throw Error('Invalid MEDIA_STORAGE');
if(mode==='local'&&process.env.RENDER)throw Error('Local media storage is not allowed on Render');
const bucket=process.env.S3_BUCKET;
if(mode==='s3'&&(!bucket||!process.env.S3_ACCESS_KEY_ID||!process.env.S3_SECRET_ACCESS_KEY))throw Error('Configure private S3 storage before enabling uploads');
const client=mode==='s3'?new S3Client({region:process.env.S3_REGION||'auto',endpoint:process.env.S3_ENDPOINT||undefined,forcePathStyle:process.env.S3_FORCE_PATH_STYLE==='true',credentials:{accessKeyId:process.env.S3_ACCESS_KEY_ID,secretAccessKey:process.env.S3_SECRET_ACCESS_KEY}}):null;
const root=path.resolve(process.env.MEDIA_DIR||'var/media');
const prefix=(process.env.S3_PREFIX||'master-ryadom').replace(/^\/+|\/+$/g,'');
const key=id=>`${prefix}/media/${id}`;
const stateKey=`${prefix}/state.json`;
const journalPrefix=`${prefix}/state-journal/`;
let revision;
const missing=e=>e.name==='NoSuchKey'||e.$metadata?.httpStatusCode===404;
export const mediaEnabled=mode!=='disabled';
export async function putMedia(id,body,type){
 if(client)await client.send(new PutObjectCommand({Bucket:bucket,Key:key(id),Body:body,ContentType:type}));
 else {await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(root,id),body,{flag:'wx',mode:0o600});}
}
export async function getMedia(id){
 if(client)return (await client.send(new GetObjectCommand({Bucket:bucket,Key:key(id)}))).Body;
 const {createReadStream}=await import('node:fs');return createReadStream(path.join(root,id));
}
export async function deleteMedia(id){
 if(client)await client.send(new DeleteObjectCommand({Bucket:bucket,Key:key(id)}));
 else await fs.rm(path.join(root,id),{force:true});
}
// Supabase S3 does not implement conditional PutObject. Never overwrite state:
// each commit has a unique key. Conflicting writers leave two revisions on disk
// and fail closed instead of silently losing one writer's data.
async function journalHead(){
 let continuation,head=null;const seen=new Set();
 do{
  const result=await client.send(new ListObjectsV2Command({Bucket:bucket,Prefix:journalPrefix,ContinuationToken:continuation}));
  for(const item of result.Contents||[]){
   const suffix=item.Key?.slice(journalPrefix.length),match=suffix?.match(/^(\d{16})-([a-f0-9-]{36})\.json$/);
   if(!match)throw Error('Invalid application state journal entry');
   const number=Number(match[1]);
   if(!Number.isSafeInteger(number)||number<1||seen.has(number))throw Error('Conflicting application state revisions; restore from retained versions before continuing');
   seen.add(number);if(!head||number>head.number)head={number,key:item.Key};
  }
  continuation=result.IsTruncated?result.NextContinuationToken:undefined;
  if(result.IsTruncated&&!continuation)throw Error('Incomplete application state listing');
 }while(continuation);
 return head;
}
export async function readCloudState(initial){
 if(!client)return null;
 const head=await journalHead();revision=head?.number||0;
 try{const result=await client.send(new GetObjectCommand({Bucket:bucket,Key:head?.key||stateKey}));const state=JSON.parse(await result.Body.transformToString());if(!state||typeof state!=='object'||Array.isArray(state)||!Array.isArray(state.users)||!Array.isArray(state.jobs))throw Error('Invalid stored application state');return state;}
 catch(e){if(head||!missing(e))throw e;return structuredClone(initial);}
}
export async function saveCloudState(state){
 if(!client)return false;
 const head=await journalHead();
 if(revision===undefined||(head?.number||0)!==revision)throw Error('Application state changed; refresh and retry');
 const next=revision+1,key=`${journalPrefix}${String(next).padStart(16,'0')}-${randomUUID()}.json`;
 await client.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:JSON.stringify(state),ContentType:'application/json',CacheControl:'no-store'}));
 const saved=await journalHead();
 if(saved?.key!==key)throw Error('Application state changed during save; retained versions require review');
 revision=next;return true;
}
