/** Fail closed before replay or HTTP startup when the hosted worker is incomplete. */
export function railwayRuntimeConfig(env:NodeJS.ProcessEnv){
 if(env.HOSTED_WORKER_MODE!=='railway')throw new Error('hosted_isolated_runtime_required');
 const checkpoint=env.HOSTED_WORKER_CHECKPOINT??'';
 const image=env.HOSTED_WORKER_IMAGE_SHA256??'';
 if(!/^[A-Za-z0-9_.-]{1,80}$/.test(checkpoint))throw new Error('hosted_worker_checkpoint_required');
 if(!/^sha256:[a-f0-9]{64}$/.test(image))throw new Error('hosted_worker_image_digest_required');
 if(!env.RAILWAY_TOKEN)throw new Error('hosted_project_token_required');
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(env.RAILWAY_ENVIRONMENT_ID??''))
  throw new Error('hosted_railway_environment_required');
 return {checkpoint,image};
}
