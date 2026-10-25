import { request } from "node:https";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";

/** What a product's own site says about its look: enough to prefill a brand the user then checks and saves. */
export type SiteBrand = {
  origin: string;
  name?: string;
  accent?: string;
  logo?: string;
  /** Where each value came from, so the screen can say what it filled. */
  found: { accent?: "theme-color" | "manifest" | "mask-icon"; logo?: "apple-touch-icon" | "manifest" | "icon" };
};

/** Addresses a fetch on a user's behalf must never reach: loopback, private, link-local, carrier NAT, multicast, reserved.
 * Two lists: a BlockList also maps IPv4 onto its IPv6 rules, so one shared list would block every IPv4 address. */
const blocked4 = new BlockList(), blocked6 = new BlockList();
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]] as const) {
  blocked4.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) {
  blocked6.addSubnet(network, prefix, "ipv6");
}
export function isPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return isPublicAddress(mapped);
  const family = isIP(address);
  if (family === 4) return !blocked4.check(address, "ipv4");
  if (family === 6) return !blocked6.check(address, "ipv6");
  return false;
}

/** Resolves like dns.lookup, but refuses every address that is not public: checked when the socket connects. */
function publicLookup(hostname: string, options: object, callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "");
    const list = (addresses as LookupAddress[]).filter(entry => isPublicAddress(entry.address));
    if (!list.length) return callback(Object.assign(new Error("address_not_public"), { code: "EADDRNOTPUBLIC" }), "");
    if ((options as { all?: boolean }).all) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
}

type Fetched = { url: URL; type: string; body: Buffer };
/** A GET to a public https address on the default port, following up to three redirects, capped in time and size. */
export async function fetchPublic(target: string, maxBytes: number, timeoutMs = 6_000, redirects = 3): Promise<Fetched> {
  const url = new URL(target);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw new Error("public_https_url_required");
  if (isIP(url.hostname.replace(/^\[|\]$/g, ""))) throw new Error("public_https_url_required");
  return new Promise<Fetched>((resolve, reject) => {
    const call = request(url, { method: "GET", lookup: publicLookup as never, timeout: timeoutMs,
      headers: { "user-agent": "Toru brand preview (+https://toru.tools)", accept: "text/html,application/json,image/png,*/*;q=0.5" } }, response => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirects <= 0) return reject(new Error("too_many_redirects"));
        return resolve(fetchPublic(new URL(response.headers.location, url).href, maxBytes, timeoutMs, redirects - 1));
      }
      if (status !== 200) { response.resume(); return reject(new Error("site_unavailable")); }
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) { call.destroy(new Error("too_large")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ url, type: String(response.headers["content-type"] ?? ""), body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    call.on("timeout", () => call.destroy(new Error("site_timeout")));
    call.on("error", reject);
    call.end();
  });
}

const attribute = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(2).find(value => value !== undefined);
const tags = (html: string, name: string) => html.match(new RegExp(`<${name}\\b[^>]*>`, "gi")) ?? [];
const decode = (value: string) => value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();

/** A CSS colour as #rrggbb, or undefined for anything that is not a plain hex or rgb() colour. */
export function hexColour(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  if (/^#[0-9a-f]{8}$/.test(text)) return text.slice(0, 7);
  const rgb = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/.exec(text);
  if (rgb) return `#${rgb.slice(1, 4).map(part => Math.min(255, Number(part)).toString(16).padStart(2, "0")).join("")}`;
  return undefined;
}
/** Near-white and near-black say nothing about a brand: a site's background, not its colour. */
function distinctive(hex: string) {
  const [r, g, b] = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
  const light = (Math.max(r!, g!, b!) + Math.min(r!, g!, b!)) / 510;
  return light > 0.08 && light < 0.94;
}

/** What the page's HTML declares: name, theme colours, manifest and icon links. Pure, for tests. */
export function readPage(html: string, base: URL) {
  const head = html.slice(0, 200_000);
  const meta = tags(head, "meta"), links = tags(head, "link");
  const metaContent = (key: string) => meta.find(tag => (attribute(tag, "name") ?? attribute(tag, "property"))?.toLowerCase() === key && !attribute(tag, "media"))
    ?? meta.find(tag => (attribute(tag, "name") ?? attribute(tag, "property"))?.toLowerCase() === key);
  const href = (tag: string | undefined) => { const value = tag && attribute(tag, "href"); try { return value ? new URL(decode(value), base).href : undefined; } catch { return undefined; } };
  const rel = (tag: string) => (attribute(tag, "rel") ?? "").toLowerCase().split(/\s+/);
  const size = (tag: string) => Math.max(0, ...(attribute(tag, "sizes") ?? "").split(/\s+/).map(entry => Number(entry.split("x")[0]) || 0));
  const themeTag = metaContent("theme-color"), siteName = metaContent("og:site_name") ?? metaContent("application-name");
  const title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(head)?.[1];
  const icons = links.filter(tag => rel(tag).includes("icon") && /png/i.test(attribute(tag, "type") ?? href(tag) ?? "")).sort((a, b) => size(b) - size(a));
  const mask = links.find(tag => rel(tag).includes("mask-icon"));
  return {
    name: decode((siteName && attribute(siteName, "content")) ?? title ?? "").split(/\s[|–—-]\s/)[0]?.slice(0, 80) || undefined,
    themeColour: hexColour(themeTag && decode(attribute(themeTag, "content") ?? "")),
    maskColour: hexColour(mask && attribute(mask, "color")),
    manifest: href(links.find(tag => rel(tag).includes("manifest"))),
    appleIcon: href(links.find(tag => rel(tag).includes("apple-touch-icon"))),
    icons: icons.map(href).filter((value): value is string => Boolean(value)),
  };
}

/** Theme colour and PNG icons from a web app manifest. Pure, for tests. */
export function readManifest(text: string, base: URL) {
  try {
    const manifest = JSON.parse(text) as { theme_color?: string; name?: string; short_name?: string; icons?: Array<{ src?: string; type?: string; sizes?: string }> };
    const icons = (manifest.icons ?? []).filter(icon => icon.src && (/png/i.test(icon.type ?? "") || /\.png(\?|$)/i.test(icon.src)))
      .map(icon => ({ src: new URL(icon.src!, base).href, size: Math.max(0, ...(icon.sizes ?? "").split(/\s+/).map(entry => Number(entry.split("x")[0]) || 0)) }))
      // A logo near 192–512 px is sharp in a corner and still small; a huge one blows the size limit.
      .sort((a, b) => Math.abs(a.size - 256) - Math.abs(b.size - 256));
    return { themeColour: hexColour(manifest.theme_color), name: manifest.short_name ?? manifest.name, icons: icons.map(icon => icon.src) };
  } catch { return { icons: [] as string[] }; }
}

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** The brand logo limit the recorder accepts. */
const logoBytes = 150_000;

/** Reads the product's home page (and its manifest) and prefills a brand: colour, logo, name. Never throws for a missing piece. */
export async function brandFromSite(address: string, fetcher = fetchPublic): Promise<SiteBrand> {
  const start = new URL(/^https?:\/\//i.test(address.trim()) ? address.trim() : `https://${address.trim()}`);
  const page = await fetcher(start.href, 1_500_000);
  if (!/html/i.test(page.type)) throw new Error("site_not_html");
  const read = readPage(page.body.toString("utf8"), page.url);
  const manifest = read.manifest ? await fetcher(read.manifest, 100_000).then(found => readManifest(found.body.toString("utf8"), found.url)).catch(() => undefined) : undefined;
  const result: SiteBrand = { origin: page.url.origin, found: {} };
  const name = read.name ?? manifest?.name;
  if (name) result.name = name;
  for (const [colour, source] of [[read.themeColour, "theme-color"], [manifest?.themeColour, "manifest"], [read.maskColour, "mask-icon"]] as const) {
    if (colour && distinctive(colour)) { result.accent = colour; result.found.accent = source; break; }
  }
  const candidates: Array<[string, NonNullable<SiteBrand["found"]["logo"]>]> = [
    ...(read.appleIcon ? [[read.appleIcon, "apple-touch-icon"] as [string, "apple-touch-icon"]] : []),
    ...(manifest?.icons ?? []).map(src => [src, "manifest"] as [string, "manifest"]),
    ...read.icons.map(src => [src, "icon"] as [string, "icon"]),
  ];
  for (const [src, source] of candidates.slice(0, 5)) {
    const image = await fetcher(src, logoBytes).catch(() => undefined);
    if (image && image.body.subarray(0, 8).equals(pngSignature) && image.body.length <= logoBytes) {
      result.logo = `data:image/png;base64,${image.body.toString("base64")}`; result.found.logo = source; break;
    }
  }
  return result;
}
