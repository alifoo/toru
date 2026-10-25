import {DeleteObjectCommand,GetObjectCommand,ListObjectsV2Command,PutObjectCommand,S3Client} from '@aws-sdk/client-s3';
import {legacyBackupRoot,type BackupObject,type LegacyBackupRetentionObjects} from './legacy-backup-retention.js';

type BucketConfig={name:string;endpoint:string;region:string;accessKeyId:string;secretAccessKey:string};

export function legacyBackupBucketConfig(env:NodeJS.ProcessEnv):BucketConfig{
  const name=env.HOSTED_BACKUP_BUCKET,rawEndpoint=env.HOSTED_BACKUP_BUCKET_ENDPOINT;
  const region=env.HOSTED_BACKUP_BUCKET_REGION,accessKeyId=env.HOSTED_BACKUP_BUCKET_ACCESS_KEY_ID;
  const secretAccessKey=env.HOSTED_BACKUP_BUCKET_SECRET_ACCESS_KEY;
  if(!name||!rawEndpoint||!region||!accessKeyId||!secretAccessKey||name===env.HOSTED_DELETION_BUCKET)
    throw new Error('legacy_backup_bucket_config_invalid');
  let endpoint:URL;
  try{endpoint=new URL(rawEndpoint);}catch{throw new Error('legacy_backup_bucket_config_invalid');}
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.pathname!=='/'||
    endpoint.search||endpoint.hash)throw new Error('legacy_backup_bucket_config_invalid');
  return {name,endpoint:endpoint.toString(),region,accessKeyId,secretAccessKey};
}

export function legacyBackupBucketObjects(config:BucketConfig,root=legacyBackupRoot):LegacyBackupRetentionObjects{
  const client=new S3Client({region:config.region,endpoint:config.endpoint,
    credentials:{accessKeyId:config.accessKeyId,secretAccessKey:config.secretAccessKey},
    forcePathStyle:false,maxAttempts:3});
  const timeout=()=>({abortSignal:AbortSignal.timeout(60_000)});
  return {
    async list(){
      const entries:BackupObject[]=[];const tokens=new Set<string>();let token:string|undefined;
      do{
        const page=await client.send(new ListObjectsV2Command({Bucket:config.name,Prefix:root,
          ContinuationToken:token}),timeout());
        for(const item of page.Contents??[]){
          if(!item.Key||!item.LastModified||!item.ETag)throw new Error('legacy_backup_inventory_invalid');
          entries.push({key:item.Key,modifiedAt:item.LastModified.getTime(),etag:item.ETag});
          if(entries.length>50_000)throw new Error('legacy_backup_inventory_too_large');
        }
        token=page.IsTruncated?page.NextContinuationToken:undefined;
        if(page.IsTruncated&&(!token||tokens.has(token)))throw new Error('legacy_backup_inventory_invalid');
        if(token)tokens.add(token);
      }while(token);
      return entries;
    },
    async remove(key){
      await client.send(new DeleteObjectCommand({Bucket:config.name,Key:key}),timeout());
      if(await this.get(key))throw new Error('legacy_backup_expiry_incomplete');
    },
    async put(key,body){
      await client.send(new PutObjectCommand({Bucket:config.name,Key:key,Body:body,
        ContentLength:body.length,ContentType:key.endsWith('.json')?'application/json':'application/octet-stream'}),timeout());
    },
    async get(key){
      try{
        const result=await client.send(new GetObjectCommand({Bucket:config.name,Key:key}),timeout());
        if(!result.Body||result.ContentLength===undefined||result.ContentLength>64*1024*1024)
          throw new Error('legacy_backup_remote_size_invalid');
        const bytes=await result.Body.transformToByteArray();
        if(bytes.length!==result.ContentLength)throw new Error('legacy_backup_remote_size_invalid');
        return bytes;
      }catch(error){
        if(error instanceof Error&&(['NoSuchKey','NotFound'].includes(error.name)||
          (error as Error&{$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode===404))return undefined;
        throw error;
      }
    }
  };
}
