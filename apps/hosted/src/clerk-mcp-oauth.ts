import { createHash } from 'node:crypto';
import type { McpOAuth } from '@agent-recorder/mcp/oauth';

// Keep this account mapping identical to apps/console/lib/recorder-owner.ts.
export function recorderOwnerFor(userId: string): string {
  const hex = createHash('sha256').update(`agent-recorder:${userId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function clerkMcpOAuthFromEnvironment(env: NodeJS.ProcessEnv, request: typeof fetch = fetch): McpOAuth | undefined {
  const issuer = env.CLERK_OAUTH_ISSUER;
  if (!issuer) return;
  const secret = env.CLERK_SECRET_KEY;
  if (!secret || !env.PUBLIC_URL) throw new Error('clerk_oauth_configuration_missing');
  const authorizationServer = new URL(issuer);
  if (authorizationServer.protocol !== 'https:' || authorizationServer.username || authorizationServer.password || authorizationServer.pathname !== '/' || authorizationServer.search || authorizationServer.hash) throw new Error('clerk_oauth_issuer_invalid');
  const resource = new URL('/mcp', env.PUBLIC_URL).href;
  return {
    authorizationServer: authorizationServer.origin,
    scopes: ['openid', 'offline_access'],
    async verify(token) {
      if (token.startsWith('ar_') || token.length > 4096) return;
      let response: Response;
      try {
        response = await request('https://api.clerk.com/v1/oauth_applications/access_tokens/verify', {
          method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token: token }), signal: AbortSignal.timeout(8_000),
        });
      } catch { throw new Error('oauth_provider_unavailable'); }
      if (response.status === 400 || response.status === 404) return;
      if (!response.ok) throw new Error('oauth_provider_unavailable');
      let value: Record<string, unknown>;
      try { value = await response.json() as Record<string, unknown>; } catch { throw new Error('oauth_provider_unavailable'); }
      if (!value || value.active === false || value.object !== 'clerk_idp_oauth_access_token' ||
        value.revoked !== false || value.expired !== false ||
        typeof value.subject !== 'string' || !value.subject.startsWith('user_') ||
        !Array.isArray(value.aud) || !value.aud.includes(resource) ||
        !Array.isArray(value.scopes) || !value.scopes.includes('openid') ||
        typeof value.expiration !== 'number' || !Number.isFinite(value.expiration) || value.expiration * 1000 <= Date.now()) return;
      return { owner: recorderOwnerFor(value.subject), expiresAt: value.expiration * 1000 };
    },
  };
}
