import {parseArgs} from 'node:util';
import {eraseAccountData} from '@agent-recorder/mcp/erasure';
import {createHostedLifecycle} from './adapter.js';
import {recordDeletion,replayDeletions} from './deletion-journal.js';
import {deletionBucketFromEnvironment} from './deletion-bucket.js';
const {values}=parseArgs({options:{'data-dir':{type:'string'},journal:{type:'string'},replay:{type:'boolean'},'init-bucket':{type:'boolean'},owner:{type:'string'},'confirm-owner':{type:'string'}},strict:true});
if(!values['data-dir'])throw new Error('Required: --data-dir DIR');
const bucket=deletionBucketFromEnvironment(process.env);
if(Boolean(bucket)===Boolean(values.journal))throw new Error('Required: exactly one of --journal DIR or HOSTED_DELETION_BUCKET configuration');
if(values['init-bucket']){
 if(!bucket||values.replay||values.owner)throw new Error('usage: --init-bucket requires bucket configuration only');
 console.log(JSON.stringify(await bucket.initialize(values['data-dir'])));
}
else if(values.replay){console.log(JSON.stringify(bucket?await bucket.replay(values['data-dir'],owner=>eraseAccountData(values['data-dir']!,owner,createHostedLifecycle,{tombstoneMissingAccount:true})):await replayDeletions(values.journal!,values['data-dir'])));}
else{
if(!values.owner||values.owner!==values['confirm-owner'])throw new Error('Required: --owner UUID --confirm-owner SAME_UUID; stop Recorder first');
if(bucket)await bucket.record(values['data-dir'],values.owner);
else await recordDeletion(values.journal!,values['data-dir'],values.owner);
console.log(JSON.stringify(await eraseAccountData(values['data-dir'],values.owner,createHostedLifecycle)));
}
