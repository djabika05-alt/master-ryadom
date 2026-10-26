import fs from 'node:fs/promises';
import path from 'node:path';
import {S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand} from '@aws-sdk/client-s3';

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
let etag;
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
export async function readCloudState(initial){
 if(!client)return null;
 try{const result=await client.send(new GetObjectCommand({Bucket:bucket,Key:stateKey}));etag=result.ETag;const state=JSON.parse(await result.Body.transformToString());if(!state||typeof state!=='object'||Array.isArray(state))throw Error('Invalid stored application state');return state;}
 catch(e){if(!missing(e))throw e;etag=undefined;return structuredClone(initial);}
}
export async function saveCloudState(state){
 if(!client)return false;
 // Conditional writes reject concurrent changes from another instance instead of losing them.
 const result=await client.send(new PutObjectCommand({Bucket:bucket,Key:stateKey,Body:JSON.stringify(state),ContentType:'application/json',...(etag?{IfMatch:etag}:{IfNoneMatch:'*'})}));
 etag=result.ETag;return true;
}
