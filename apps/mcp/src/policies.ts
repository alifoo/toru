import { createHash } from 'node:crypto';
import type { RecorderDatabase } from './store/database.js';

export type DailyLimits = Readonly<{ browserMs: number; renderMs: number; browserStarts: number; globalBrowserStarts: number }>;
export const defaultDailyLimits: DailyLimits = Object.freeze({ browserMs: 60 * 60_000, renderMs: 30 * 60_000, browserStarts: 10, globalBrowserStarts: 50 });

export function validateDailyLimits(overrides: Partial<DailyLimits> = {}): DailyLimits {
  const limits = { ...defaultDailyLimits, ...overrides };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid_daily_limit');
  }
  return Object.freeze(limits);
}

export function dailyLimitsFromEnvironment(env: NodeJS.ProcessEnv): DailyLimits {
  const integer = (name: string, fallback: number) => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw)) throw new Error(`invalid_daily_limit:${name}`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) throw new Error(`invalid_daily_limit:${name}`);
    return value;
  };
  return validateDailyLimits({
    browserMs: integer('DAILY_BROWSER_MINUTES', 60) * 60_000,
    renderMs: integer('DAILY_RENDER_MINUTES', 30) * 60_000,
    browserStarts: integer('DAILY_SESSION_LIMIT', 10),
    globalBrowserStarts: integer('DAILY_SERVICE_SESSION_LIMIT', 50),
  });
}

/** Operational guardrails only. Commercial entitlement policy belongs to the hosted service. */
export function recordOperationalPolicy(db: RecorderDatabase, limits: DailyLimits, actor: string, now = Date.now()): string {
  if (!/^[a-zA-Z0-9_.:@/-]{1,128}$/.test(actor)) throw new Error('invalid_policy_actor');
  const validated = validateDailyLimits(limits);
  const policy = JSON.stringify({ browserMs: validated.browserMs, renderMs: validated.renderMs,
    browserStarts: validated.browserStarts, globalBrowserStarts: validated.globalBrowserStarts });
  const version = `operational-v1:${createHash('sha256').update(policy).digest('hex')}`;
  db.connection.prepare('INSERT INTO policy_revisions(version,actor,created_at,policy) VALUES (?,?,?,?) ON CONFLICT(version) DO NOTHING').run(version, actor, now, policy);
  return version;
}

export type DeploymentIdentity = Readonly<{
  environment:'local'|'staging'|'production'; instanceId:string; actor:string; deploymentId:string;
}>;
const identityPattern = /^[a-zA-Z0-9_.:@/-]{1,128}$/;
export function deploymentIdentityFromEnvironment(env:NodeJS.ProcessEnv):DeploymentIdentity {
  const environment = env.RECORDER_ENVIRONMENT ?? 'local';
  if(!['local','staging','production'].includes(environment)) throw new Error('invalid_recorder_environment');
  function value(name:string,fallback?:string) {
    const result=env[name] ?? fallback;
    if(!result || !identityPattern.test(result)) throw new Error(`invalid_deployment_identity:${name}`);
    return result;
  }
  return Object.freeze({environment:environment as DeploymentIdentity['environment'],
    instanceId:value('RECORDER_INSTANCE_ID',environment === 'local' ? 'local' : undefined),
    actor:value('POLICY_ACTOR',environment === 'local' ? 'local-operator' : undefined),
    deploymentId:value('RECORDER_DEPLOYMENT_ID',env.RAILWAY_DEPLOYMENT_ID ?? (environment === 'local' ? 'local' : undefined)),
  });
}

/** Bind the volume to one environment and preserve every policy transition, including rollback. */
export function activateOperationalPolicy(db:RecorderDatabase,limits:DailyLimits,identity:DeploymentIdentity,now=Date.now()):string {
  if(!['local','staging','production'].includes(identity.environment) ||
    ![identity.instanceId,identity.actor,identity.deploymentId].every(value=>identityPattern.test(value))) throw new Error('invalid_deployment_identity');
  return db.transaction(()=>{
    const sql=db.connection;
    const binding=sql.prepare('SELECT environment,instance_id FROM instance_identity WHERE singleton=1').get();
    if(binding && (binding.environment !== identity.environment || binding.instance_id !== identity.instanceId)) throw new Error('recorder_volume_identity_mismatch');
    if(!binding) sql.prepare('INSERT INTO instance_identity VALUES (1,?,?,?)').run(identity.environment,identity.instanceId,now);
    const version=recordOperationalPolicy(db,limits,identity.actor,now);
    // A hosted deployment ID identifies an immutable configuration, so a reused ID cannot hide a change.
    if(identity.environment !== 'local' && sql.prepare('SELECT 1 FROM policy_activations WHERE deployment_id=? AND version!=?').get(identity.deploymentId,version)) throw new Error('deployment_policy_conflict');
    const previous=sql.prepare('SELECT version FROM policy_activations ORDER BY id DESC LIMIT 1').get();
    if(previous?.version !== version) {
      sql.prepare('INSERT INTO policy_activations(version,previous_version,actor,deployment_id,created_at) VALUES (?,?,?,?,?)')
        .run(version,previous?.version ?? null,identity.actor,identity.deploymentId,now);
    }
    return version;
  });
}
