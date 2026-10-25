/**
 * Where the recording window may go. Pure, so it is unit tested outside Chrome.
 */
import { isLocalDevelopmentUrl, sameLocalHost } from '../../../packages/browser/src/local-development.js';
import { sameProductSite } from '../../mcp/src/product-origin.js';
import { RECORDING_PLACEHOLDER } from './placeholder.js';

/**
 * The recording window may follow the demo to any https site (a provider's consent screen, docs, a
 * checkout): this is the user's own Chrome, reaching what the user can reach. Sign-in fields still stop it.
 * A development server on the user's machine (localhost, 127.0.0.1, [::1], *.localhost, *.test) only on the
 * local hosts this recording was opened for (any port), so a demo of a public site never wanders onto it.
 */
export function allowedTarget(url: string, product: URL, allowedOrigins: readonly string[] = []) {
  const target = new URL(url);
  if (target.username || target.password) return false;
  if (target.protocol === 'about:' || decodeURIComponent(url) === RECORDING_PLACEHOLDER) return true;
  if (isLocalDevelopmentUrl(target.href)) return sameLocalHost(target.href, product.href) || allowedOrigins.some((origin) => sameLocalHost(target.href, origin));
  return target.protocol === 'https:';
}
/** The product's own pages: its registrable site, or for a development server its local host (any port). */
export function onProductSite(url: string, product: URL) {
  if (url.startsWith('about:')) return true;
  if (isLocalDevelopmentUrl(url)) return sameLocalHost(url, product.href);
  return sameProductSite(url, product.href);
}
