/**
 * A development server on the user's own machine: http or https on `localhost`, `127.0.0.1`, `[::1]`, or a
 * name under `.localhost` or `.test`, any port.
 *
 * Only a browser running on the user's machine may open one (Toru for Chrome). Toru's servers and hosted
 * browsers never fetch it: there it would be Toru's own loopback, not the user's. Every other private
 * address (10.x, 192.168.x, 169.254.x, `.internal`, `.local`) stays refused on every route, and so does
 * every other scheme.
 *
 * No imports: the extension bundles this file as is.
 */
export function isLocalDevelopmentUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  // The URL parser already lowercases, strips a default port and folds 127.1 or [0:0:…:1] into one spelling.
  const host = url.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" ||
    /^[^.]+(\.[^.]+)*\.(localhost|test)$/u.test(host);
}

/**
 * Two development-server URLs on the same local host, whatever the port or scheme: a local app on :3000 that
 * signs in through :3001 is one product. A different local name (another *.test, localhost vs 127.0.0.1) is not.
 */
export function sameLocalHost(a: string, b: string): boolean {
  return isLocalDevelopmentUrl(a) && isLocalDevelopmentUrl(b) && new URL(a).hostname === new URL(b).hostname;
}
