/** The same answers as Node's isIP for the literals the host policy checks. */
export function isIP(input: string): 0 | 4 | 6 {
  if (/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(input)) return 4;
  if (input.includes(':') && /^[0-9a-fA-F:.]+$/.test(input)) {
    try { new URL(`http://[${input}]/`); return 6; } catch { return 0; }
  }
  return 0;
}
export const isIPv4 = (input: string) => isIP(input) === 4;
export const isIPv6 = (input: string) => isIP(input) === 6;
