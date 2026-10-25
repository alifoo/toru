import { describe, expect, it } from 'vitest';
import { dailyLimitsFromEnvironment, defaultDailyLimits, validateDailyLimits } from './policies.js';

describe('operational policy configuration', () => {
  it('preserves defaults and allows explicitly disabling admissions with zero', () => {
    expect(dailyLimitsFromEnvironment({})).toEqual(defaultDailyLimits);
    expect(dailyLimitsFromEnvironment({DAILY_SESSION_LIMIT:'0'}).browserStarts).toBe(0);
    expect(dailyLimitsFromEnvironment({DAILY_BROWSER_MINUTES:'2'}).browserMs).toBe(120000);
  });
  it.each(['', ' ', '-1', '1.5', 'Infinity', 'NaN', '1e3', '0x10', '9007199254740992'])('rejects ambiguous or unsafe environment value %j', value => {
    expect(() => dailyLimitsFromEnvironment({DAILY_SESSION_LIMIT:value})).toThrow('invalid_daily_limit');
  });
  it('rejects milliseconds overflow, and invalid programmatic overrides', () => {
    expect(() => dailyLimitsFromEnvironment({DAILY_BROWSER_MINUTES:'9007199254740991'})).toThrow('invalid_daily_limit');
    expect(() => validateDailyLimits({browserMs:NaN})).toThrow('invalid_daily_limit');
    expect(() => validateDailyLimits({renderMs:-1})).toThrow('invalid_daily_limit');
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecorderDatabase } from './store/database.js';
import { activateOperationalPolicy, deploymentIdentityFromEnvironment, type DeploymentIdentity } from './policies.js';

it('requires explicit operator/deployment/instance for hosted environments', () => {
  expect(deploymentIdentityFromEnvironment({}).environment).toBe('local');
  expect(() => deploymentIdentityFromEnvironment({RECORDER_ENVIRONMENT:'production'})).toThrow('invalid_deployment_identity');
  expect(() => deploymentIdentityFromEnvironment({RECORDER_ENVIRONMENT:'prod'})).toThrow('invalid_recorder_environment');
  expect(deploymentIdentityFromEnvironment({RECORDER_ENVIRONMENT:'staging',RECORDER_INSTANCE_ID:'recorder-stage',POLICY_ACTOR:'operator:test',RAILWAY_DEPLOYMENT_ID:'deploy-123'})).toEqual({environment:'staging',instanceId:'recorder-stage',actor:'operator:test',deploymentId:'deploy-123'});
});

it('rejects a mismatched volume, records rollback, and cannot rewrite audit history', async () => {
  const dir=await mkdtemp(join(tmpdir(),'recorder-policy-'));
  const db=new RecorderDatabase(join(dir,'recorder.sqlite'));
  const identity:DeploymentIdentity={environment:'production',instanceId:'recorder-prod',actor:'operator:test',deploymentId:'deploy-1'};
  try {
    const original=activateOperationalPolicy(db,defaultDailyLimits,identity,1);
    activateOperationalPolicy(db,defaultDailyLimits,identity,2);
    expect(db.connection.prepare('SELECT count(*) n FROM policy_activations').get()!.n).toBe(1);
    expect(()=>activateOperationalPolicy(db,defaultDailyLimits,{...identity,environment:'staging'},3)).toThrow('recorder_volume_identity_mismatch');
    expect(()=>activateOperationalPolicy(db,defaultDailyLimits,{...identity,instanceId:'other'},3)).toThrow('recorder_volume_identity_mismatch');
    expect(()=>activateOperationalPolicy(db,{...defaultDailyLimits,browserStarts:5},identity,3)).toThrow('deployment_policy_conflict');
    expect(db.connection.prepare('SELECT count(*) n FROM policy_revisions').get()!.n).toBe(1);
    const changed=activateOperationalPolicy(db,{...defaultDailyLimits,browserStarts:5},{...identity,deploymentId:'deploy-2'},4);
    activateOperationalPolicy(db,defaultDailyLimits,{...identity,deploymentId:'deploy-rollback'},5);
    expect(db.connection.prepare('SELECT version,previous_version,actor,deployment_id FROM policy_activations ORDER BY id').all()).toEqual([
      {version:original,previous_version:null,actor:identity.actor,deployment_id:'deploy-1'},
      {version:changed,previous_version:original,actor:identity.actor,deployment_id:'deploy-2'},
      {version:original,previous_version:changed,actor:identity.actor,deployment_id:'deploy-rollback'},
    ]);
    expect(()=>db.connection.exec('DELETE FROM policy_activations')).toThrow('immutable_policy_activation');
    expect(()=>db.connection.exec("UPDATE instance_identity SET environment='staging'")).toThrow('immutable_instance_identity');
  } finally {db.close();await rm(dir,{recursive:true,force:true});}
});
