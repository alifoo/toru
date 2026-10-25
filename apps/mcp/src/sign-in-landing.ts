/** Where a sign-in left the browser: origin and path only, since queries can carry one-time tokens. */
export function signedInPage(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin + url.pathname : undefined;
  } catch { return undefined; }
}

/**
 * The page a session opens on after a sign-in.
 *
 * Agents often name a product by its home page (`https://product.com`) while the signed-in app lives
 * elsewhere (`https://app.product.com/home`). Reopening the bare home page after the login drops the
 * recording on the marketing site. A specific path the agent asked for always wins.
 */
export function openAfterSignIn(requested: string, signedIn: string | undefined): string {
  if (!signedIn) return requested;
  const url = new URL(requested);
  return url.pathname === '/' && !url.search && !url.hash ? signedIn : requested;
}
