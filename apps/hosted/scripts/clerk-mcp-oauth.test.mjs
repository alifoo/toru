import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { clerkMcpOAuthFromEnvironment, recorderOwnerFor } from '../dist/clerk-mcp-oauth.js';

const env = {CLERK_OAUTH_ISSUER:'https://clerk.toru.tools',CLERK_SECRET_KEY:'test-secret',PUBLIC_URL:'https://recorder.example'};
const valid = {object:'clerk_idp_oauth_access_token',subject:'user_test',aud:['https://recorder.example/mcp'],scopes:['openid'],revoked:false,expired:false,expiration:Math.floor(Date.now()/1000)+600};
test('Clerk OAuth verifies the resource, user, scope and lifetime without exposing the token', async()=>{
  const auth=clerkMcpOAuthFromEnvironment(env, async(url,init)=>{
    assert.equal(url,'https://api.clerk.com/v1/oauth_applications/access_tokens/verify');
    assert.equal(init.headers.Authorization,'Bearer test-secret');
    assert.deepEqual(JSON.parse(init.body),{access_token:'opaque-access-token'});
    return Response.json(valid);
  });
  const principal=await auth.verify('opaque-access-token');
  const hex=createHash('sha256').update('agent-recorder:user_test').digest('hex');
  assert.equal(principal.owner,`${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`);
  assert.equal(principal.owner,recorderOwnerFor('user_test'));
  assert.equal(principal.expiresAt,valid.expiration*1000);
  for(const patch of [{aud:undefined},{aud:['https://other.example/mcp']},{scopes:[]},{subject:'org_other'},{revoked:true},{expired:true},{expiration:1},{expiration:null},{active:false}]) {
    const invalid=clerkMcpOAuthFromEnvironment(env,async()=>Response.json({...valid,...patch}));
    assert.equal(await invalid.verify('opaque-access-token'),undefined);
  }
});
test('provider failures fail closed; unknown tokens ask clients to authenticate again',async()=>{
  for(const status of [400,404]) assert.equal(await clerkMcpOAuthFromEnvironment(env,async()=>new Response(null,{status})).verify('invalid'),undefined);
  for(const status of [401,429,500]) await assert.rejects(clerkMcpOAuthFromEnvironment(env,async()=>new Response(null,{status})).verify('token'),/oauth_provider_unavailable/);
  assert.equal(clerkMcpOAuthFromEnvironment({}),undefined);
  assert.throws(()=>clerkMcpOAuthFromEnvironment({...env,CLERK_SECRET_KEY:''}),/configuration_missing/);
});
