import {GetObjectCommand,ListObjectsV2Command,PutObjectCommand,S3Client} from '@aws-sdk/client-s3';
import {deletionJournalIdentity} from './deletion-journal.js';

const prefix='agent-recorder/deletions/v1/';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type BucketConfig={name:string;endpoint:string;region:string;accessKeyId:string;secretAccessKey:string};
export type JournalObjects={put(key:string,body:string):Promise<void>;get(key:string):Promise<string|undefined>;list():Promise<string[]>};

export function deletionBucketConfig(env:NodeJS.ProcessEnv):BucketConfig|undefined{
 const name=env.HOSTED_DELETION_BUCKET;
 const configured=[name,env.HOSTED_DELETION_BUCKET_ENDPOINT,env.HOSTED_DELETION_BUCKET_REGION,
   env.HOSTED_DELETION_BUCKET_ACCESS_KEY_ID,env.HOSTED_DELETION_BUCKET_SECRET_ACCESS_KEY];
 if(configured.every(value=>!value))return undefined;
 if(configured.some(value=>!value))throw new Error('hosted_deletion_bucket_config_required');
 let endpoint:URL;
 try{endpoint=new URL(env.HOSTED_DELETION_BUCKET_ENDPOINT!);}catch{throw new Error('invalid_deletion_bucket_endpoint');}
 if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/')
   throw new Error('invalid_deletion_bucket_endpoint');
 return {name:name!,endpoint:endpoint.toString(),region:env.HOSTED_DELETION_BUCKET_REGION!,
   accessKeyId:env.HOSTED_DELETION_BUCKET_ACCESS_KEY_ID!,secretAccessKey:env.HOSTED_DELETION_BUCKET_SECRET_ACCESS_KEY!};
}

export function bucketObjects(config:BucketConfig):JournalObjects{
 const client=new S3Client({region:config.region,endpoint:config.endpoint,credentials:{accessKeyId:config.accessKeyId,
   secretAccessKey:config.secretAccessKey},forcePathStyle:false,maxAttempts:3});
 const timeout=()=>({abortSignal:AbortSignal.timeout(10_000)});
 return {
  async put(key,body){await client.send(new PutObjectCommand({Bucket:config.name,Key:prefix+key,Body:body,ContentType:'application/json'}),timeout());},
  async get(key){
   try{const value=await client.send(new GetObjectCommand({Bucket:config.name,Key:prefix+key}),timeout());
    if(!value.Body)throw new Error('deletion_journal_object_empty');
    if(value.ContentLength!==undefined&&value.ContentLength>4096)throw new Error('deletion_journal_object_too_large');
    return await value.Body.transformToString();
   }catch(error){if(error instanceof Error&&(['NoSuchKey','NotFound'].includes(error.name)||
     (error as Error & {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode===404))return undefined;throw error;}
  },
  async list(){
   const keys:string[]=[];let token:string|undefined;
   do{
    const page=await client.send(new ListObjectsV2Command({Bucket:config.name,Prefix:prefix,ContinuationToken:token}),timeout());
    for(const item of page.Contents??[]){
     if(!item.Key?.startsWith(prefix))throw new Error('deletion_journal_list_invalid');
     keys.push(item.Key.slice(prefix.length));
    }
    const next=page.IsTruncated?page.NextContinuationToken:undefined;
    if(page.IsTruncated&&(!next||next===token))throw new Error('deletion_journal_list_incomplete');
   token=next;
   }while(token);
   if(new Set(keys).size!==keys.length)throw new Error('deletion_journal_list_invalid');
   return keys.sort();
  },
 };
}

function manifest(dataDir:string){return deletionJournalIdentity(dataDir);}
function parseManifest(body:string|undefined,expected:ReturnType<typeof manifest>){
 if(!body)throw new Error('deletion_journal_manifest_missing');
 let value:unknown;try{value=JSON.parse(body);}catch{throw new Error('invalid_deletion_journal_manifest');}
 const actual=value as Record<string,unknown>;
 if(!actual||actual.version!==1||actual.environment!==expected.environment||actual.instanceId!==expected.instanceId)
   throw new Error('deletion_journal_volume_identity_mismatch');
}
function parseEntry(body:string|undefined,owner:string){
 if(!body)throw new Error('invalid_deletion_journal_entry');
 let value:unknown;try{value=JSON.parse(body);}catch{throw new Error('invalid_deletion_journal_entry');}
 const entry=value as Record<string,unknown>;
 if(!entry||entry.version!==1||entry.owner!==owner||!Number.isSafeInteger(entry.requestedAt)||Number(entry.requestedAt)<0)
   throw new Error('invalid_deletion_journal_entry');
 return entry;
}
export class DeletionBucketJournal{
 constructor(private readonly objects:JournalObjects){}
 /** Explicit operator bootstrap; runtime replay never creates a missing journal. */
 async initialize(dataDir:string){
  const expected=manifest(dataDir),keys=await this.objects.list();
  if(keys.includes('manifest.json')){
   parseManifest(await this.objects.get('manifest.json'),expected);
   return {initialized:false};
  }
  if(keys.length)throw new Error('unbound_deletion_journal_requires_migration');
  await this.objects.put('manifest.json',JSON.stringify(expected));
  parseManifest(await this.objects.get('manifest.json'),expected);
  return {initialized:true};
 }
 async record(dataDir:string,owner:string){
  if(!uuid.test(owner))throw new Error('invalid_deletion_owner');
  parseManifest(await this.objects.get('manifest.json'),manifest(dataDir));
  const entry={version:1,owner,requestedAt:Date.now()},key=`${owner}.json`;
  await this.objects.put(key,JSON.stringify(entry));
  parseEntry(await this.objects.get(key),owner);
  return entry;
 }
 async replay(dataDir:string,erase:(owner:string)=>Promise<unknown>){
  parseManifest(await this.objects.get('manifest.json'),manifest(dataDir));
  const keys=await this.objects.list(),owners:string[]=[];
  if(!keys.includes('manifest.json'))throw new Error('deletion_journal_list_incomplete');
  for(const key of keys){
   if(key==='manifest.json')continue;
   const owner=key.slice(0,-5);
   if(!key.endsWith('.json')||!uuid.test(owner))throw new Error('invalid_deletion_journal_entry');
   parseEntry(await this.objects.get(key),owner);owners.push(owner);
  }
  for(const owner of owners)await erase(owner);
  return {reapplied:owners.length};
 }
}
export function deletionBucketFromEnvironment(env:NodeJS.ProcessEnv){
 const config=deletionBucketConfig(env);
 return config?new DeletionBucketJournal(bucketObjects(config)):undefined;
}
