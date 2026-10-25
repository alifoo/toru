import { activeInviteForOwner, hashInviteToken, type InviteRecord } from './auth.js';
import { withRecorderStore } from './store/open.js';

export type OAuthPrincipal = { owner: string; expiresAt: number };
export type McpOAuth = {
  authorizationServer: string;
  scopes: string[];
  /** Verify issuer, audience, scope and expiry at the identity provider. Never log tokens. */
  verify(token: string): Promise<OAuthPrincipal | undefined>;
};

/** Only the authenticated dashboard may mint this lease. It cannot authenticate an MCP client. */
export async function dashboardArtifactLease(owner: string, dataDir: string, expiresAt: number, signingSecret: string): Promise<string | undefined> {
  const tokenHash = hashInviteToken(`${signingSecret}:toru:dashboard-artifacts:${owner}`);
  return withRecorderStore(dataDir, db => db.transaction(() => {
    if (db.connection.prepare('SELECT admission_status FROM accounts WHERE owner=?').get(owner)?.admission_status !== 'admitted') return;
    db.connection.prepare(`INSERT INTO grants(token_hash,owner,expires_at,created_at,kind) VALUES (?,?,?,?,'oauth')
      ON CONFLICT(token_hash) DO UPDATE SET expires_at=excluded.expires_at
      WHERE grants.kind='oauth' AND grants.owner=excluded.owner AND grants.revoked_at IS NULL`)
      .run(tokenHash, owner, expiresAt, Date.now());
    const active = db.connection.prepare('SELECT 1 FROM grants WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?').get(tokenHash, Date.now());
    return active ? tokenHash : undefined;
  }));
}

/** Short leases let signed browser/download links work without persisting access tokens. */
export async function authenticateOAuth(authorization: string | undefined, oauth: McpOAuth,
  dataDir: string, admit: ((owner: string) => Promise<unknown> | unknown) | undefined,
): Promise<(InviteRecord & { authorize: () => Promise<boolean> }) | undefined> {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
  if (!match) return;
  const token = match[1]!;
  const tokenHash = hashInviteToken(token);
  const principal = await oauth.verify(token);
  if (!principal || !Number.isFinite(principal.expiresAt) || principal.expiresAt <= Date.now()) {
    await withRecorderStore(dataDir, db => db.connection.prepare("UPDATE grants SET revoked_at=? WHERE token_hash=? AND kind='oauth'").run(Date.now(), tokenHash));
    return;
  }
  if (!admit) throw new Error('oauth_account_admission_unavailable');
  await admit(principal.owner);
  if (!await allowOAuth(principal.owner,dataDir,true)) return;
  const lease = async (expiresAt: number) => withRecorderStore(dataDir, db => db.transaction(() => {
    const sql = db.connection, now = Date.now();
    if (sql.prepare('SELECT admission_status FROM accounts WHERE owner=?').get(principal.owner)?.admission_status !== 'admitted') return false;
    sql.prepare(`INSERT INTO grants(token_hash,owner,expires_at,created_at,kind) VALUES (?,?,?,?,'oauth')
      ON CONFLICT(token_hash) DO UPDATE SET expires_at=excluded.expires_at
      WHERE grants.kind='oauth' AND grants.owner=excluded.owner AND grants.revoked_at IS NULL`)
      .run(tokenHash, principal.owner, Math.min(expiresAt, now + 15 * 60_000), now);
    return Boolean(sql.prepare(`SELECT 1 FROM grants WHERE token_hash=? AND owner=? AND kind='oauth'
      AND revoked_at IS NULL AND expires_at>?`).get(tokenHash, principal.owner, now));
  }));
  if (!await lease(principal.expiresAt)) return;
  let verifiedAt = Date.now();
  let expiresAt = principal.expiresAt;
  return { owner: principal.owner, tokenHash, expiresAt, authorize: async () => {
    if (expiresAt <= Date.now() || !await allowOAuth(principal.owner,dataDir)) return false;
    if (Date.now() - verifiedAt >= 5_000) {
      let refreshed: OAuthPrincipal | undefined;
      try { refreshed = await oauth.verify(token); } catch { return false; }
      if (!refreshed || refreshed.owner !== principal.owner || !Number.isFinite(refreshed.expiresAt) || refreshed.expiresAt <= Date.now()) {
        await withRecorderStore(dataDir, db => db.connection.prepare("UPDATE grants SET revoked_at=? WHERE token_hash=? AND kind='oauth'").run(Date.now(), tokenHash));
        return false;
      }
      expiresAt = refreshed.expiresAt;
      if (!await lease(expiresAt)) return false;
      verifiedAt = Date.now();
    }
    return activeInviteForOwner(principal.owner, tokenHash, dataDir);
  } };
}

/** Persistent owner-level OAuth gate. Dashboard artifact leases are deliberately excluded. */
export async function oauthConnectionState(owner: string, dataDir: string, secret: string, enabled?: boolean) {
  return withRecorderStore(dataDir, db => db.transaction(() => {
    const sql=db.connection;
    sql.exec(`CREATE TABLE IF NOT EXISTS mcp_connection_settings (
      owner TEXT PRIMARY KEY REFERENCES accounts(owner) ON DELETE CASCADE,
      blocked INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER
    ) STRICT`);
    const dashboardHash=hashInviteToken(`${secret}:toru:dashboard-artifacts:${owner}`);
    const legacy=sql.prepare("SELECT MAX(COALESCE(last_used_at,created_at)) AS used FROM grants WHERE owner=? AND kind='oauth' AND token_hash<>? AND revoked_at IS NULL").get(owner,dashboardHash);
    if (enabled !== undefined) {
      sql.prepare(`INSERT INTO mcp_connection_settings(owner,blocked) SELECT ?,? WHERE EXISTS(SELECT 1 FROM accounts WHERE owner=?)
        ON CONFLICT(owner) DO UPDATE SET blocked=excluded.blocked`).run(owner,enabled?0:1,owner);
    }
    const row=sql.prepare('SELECT blocked,last_used_at FROM mcp_connection_settings WHERE owner=?').get(owner);
    const lastUsedAt=Number(row?.last_used_at ?? legacy?.used ?? 0) || null;
    return { connected: Boolean(lastUsedAt) && row?.blocked !== 1, blocked: row?.blocked === 1, lastUsedAt };
  }));
}
async function allowOAuth(owner:string,dataDir:string,recordUse=false) {
  return withRecorderStore(dataDir,db=>{
    const sql=db.connection;
    sql.exec(`CREATE TABLE IF NOT EXISTS mcp_connection_settings (
      owner TEXT PRIMARY KEY REFERENCES accounts(owner) ON DELETE CASCADE,
      blocked INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER
    ) STRICT`);
    if(sql.prepare('SELECT blocked FROM mcp_connection_settings WHERE owner=?').get(owner)?.blocked===1)return false;
    if(recordUse)sql.prepare(`INSERT INTO mcp_connection_settings(owner,last_used_at) VALUES (?,?)
      ON CONFLICT(owner) DO UPDATE SET last_used_at=excluded.last_used_at WHERE blocked=0`).run(owner,Date.now());
    return true;
  });
}
