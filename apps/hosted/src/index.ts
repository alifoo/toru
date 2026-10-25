import {clerkMcpOAuthFromEnvironment} from './clerk-mcp-oauth.js';
import { startRecorder } from '@agent-recorder/mcp';
import { createHostedLifecycle } from '@agent-recorder/hosted-policy/dist/adapter.js';
import {replayDeletions} from '@agent-recorder/hosted-policy/dist/deletion-journal.js';
import {deletionBucketFromEnvironment} from '@agent-recorder/hosted-policy/dist/deletion-bucket.js';
import {bootstrapHostedStore} from '@agent-recorder/hosted-policy/dist/bootstrap.js';
import {eraseAccountData} from '@agent-recorder/mcp/erasure';
import {join} from 'node:path';
import {validateHostedStartupEnvironment} from './startup-policy.js';
import {createSandboxJournal} from './sandbox-journal.js';
import {createHostedRuntime} from './hosted-runtime.js';
import {createStripeWebhookHandler,stripeWebhookConfigFromEnvironment} from './billing-webhook.js';
import {createStripeCheckoutHandler,stripeCheckoutConfigFromEnvironment} from './billing-checkout.js';
import {startBillingReconciliation} from './billing-reconcile.js';
import {createStripePortalHandler} from './billing-portal.js';
import {createAdminCreditsHandler} from './admin-credits.js';
async function start(){
  validateHostedStartupEnvironment(process.env);
  const dataDir=process.env.DATA_DIR ?? '/data';
  const stripeWebhook=stripeWebhookConfigFromEnvironment(process.env);
  const checkoutConfig=stripeCheckoutConfigFromEnvironment(process.env);
  if(checkoutConfig&&(!stripeWebhook||stripeWebhook.account!==checkoutConfig.stripe.account||
    stripeWebhook.livemode!==checkoutConfig.stripe.livemode))throw new Error('checkout_webhook_required');
  // The process lock is held by infra/start.sh. A failed provider cleanup keeps
  // the ID on disk and stops startup instead of forgetting a live VM.
  await createSandboxJournal(join(dataDir,'sandbox-vms.json')).recover();
  const bucket=deletionBucketFromEnvironment(process.env);
  if(process.env.HOSTED_BOOTSTRAP_LEGACY!==undefined){
    if(!bucket)throw new Error('hosted_deletion_bucket_required');
    await bootstrapHostedStore(process.env.DATA_DIR ?? '/data',process.env,bucket);
  }
  if(bucket)await bucket.replay(process.env.DATA_DIR ?? '/data',owner=>eraseAccountData(process.env.DATA_DIR ?? '/data',owner,createHostedLifecycle,{tombstoneMissingAccount:true}));
  else if(process.env.HOSTED_DELETION_JOURNAL)await replayDeletions(process.env.HOSTED_DELETION_JOURNAL,process.env.DATA_DIR ?? '/data');
  const oauth=clerkMcpOAuthFromEnvironment(process.env);
  const runtime=createHostedRuntime(process.env,dataDir);
  const webhookHandler=stripeWebhook?createStripeWebhookHandler(dataDir,stripeWebhook):undefined;
  const checkoutHandler=checkoutConfig?createStripeCheckoutHandler(dataDir,checkoutConfig):undefined;
  const portalHandler=checkoutConfig?createStripePortalHandler(dataDir,checkoutConfig.adminKey,checkoutConfig.stripe):undefined;
  const creditsHandler=process.env.INVITE_ADMIN_KEY?createAdminCreditsHandler(dataDir,process.env.INVITE_ADMIN_KEY):undefined;
  const running=await startRecorder({lifecycle:createHostedLifecycle,...(oauth?{oauth}:{}),...(runtime?{runtime}:{}),
    ...(webhookHandler||checkoutHandler||portalHandler||creditsHandler?{httpExtension:async(request,response,url)=>
      Boolean(await webhookHandler?.(request,response,url)||await checkoutHandler?.(request,response,url)||
        await portalHandler?.(request,response,url)||await creditsHandler?.(request,response,url))}:{}),
  });
  if(checkoutConfig){
    const stop=startBillingReconciliation(dataDir,checkoutConfig.stripe);
    running.server.once('close',stop);
  }
}
start().catch((error:unknown)=>{
  console.error(error instanceof Error?error.message:'hosted_recorder_start_failed');process.exitCode=1;
});
