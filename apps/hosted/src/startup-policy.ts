import {deletionBucketConfig} from '@agent-recorder/hosted-policy/dist/deletion-bucket.js';
import {railwayRuntimeConfig} from './runtime-config.js';

/** Deployment guardrails for the private hosted service. Local engine runs remain configurable. */
export function validateHostedStartupEnvironment(env:NodeJS.ProcessEnv):void {
  if(env.RECORDER_ENVIRONMENT==='local')return;
  if(env.RECORDER_ENVIRONMENT!=='staging'&&env.RECORDER_ENVIRONMENT!=='production')throw new Error('hosted_environment_required');
  if(env.CHROME_NO_SANDBOX==='1')throw new Error('hosted_browser_sandbox_required');
  if(!deletionBucketConfig(env))throw new Error('hosted_deletion_bucket_required');
  if(env.HOSTED_DELETION_JOURNAL)throw new Error('hosted_deletion_journal_conflict');
  railwayRuntimeConfig(env);
}
