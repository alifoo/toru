import { isIP } from "node:net";

/** This machine addressed as itself: all of 127.0.0.0/8, and IPv6 loopback in either spelling. */
export function isLoopbackAddress(address: string): boolean {
  const host = address.replace(/^\[|\]$/gu, "").toLocaleLowerCase();
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  return isIP(host) === 4 && host.startsWith("127.");
}

export function isPublicNetworkAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split(".").map(Number);
    const first = octets[0] ?? 0;
    const second = octets[1] ?? 0;
    if (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 192 && second === 0) ||
      (first === 192 && second === 88 && octets[2] === 99) ||
      (first === 198 && second === 51 && octets[2] === 100) ||
      (first === 203 && second === 0 && octets[2] === 113) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    ) {
      return false;
    }
    return true;
  }
  if (version === 6) {
    // Only global unicast; exclude transition, protocol-assignment and documentation ranges.
    // Parsing hextets also handles fully expanded loopback/mapped addresses.
    const parts = address.toLowerCase().split(":");
    const first = Number.parseInt(parts[0] || "0", 16);
    const second = Number.parseInt(parts[1] || "0", 16);
    return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 &&
      !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) &&
      !(first === 0x3fff && second <= 0xfff);
  }
  return false;
}

/** Local captures still need localhost. Everything else on a private net is SSRF. */
export function isInternalNavigationHost(hostname: string): boolean {
  const host = hostname.toLocaleLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  /**
   * Loopback by address, for the same reason it is allowed by name.
   *
   * `localhost` resolves here, so refusing the numeric form withheld nothing from anybody who
   * could type either — it only meant a fixture served on `127.0.0.1` was refused while the same
   * fixture on `localhost` was not. The rest of this package already draws the line where this now
   * does: allowed origins accept plain http for loopback, contexts call it a development host, and
   * the debugger endpoint requires it. SSRF is about reaching other machines on a private network;
   * this process can already reach itself.
   */
  if (isLoopbackAddress(host)) return false;
  if (isIP(host)) return !isPublicNetworkAddress(host);
  return host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan");
}
