/**
 * The driver hashes screencast frames only to compare them with each other, so a fast non-cryptographic
 * digest (two FNV-1a lanes) is enough here; nothing leaves the extension as a hash.
 */
export function createHash(_algorithm: string) {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  const hash = {
    update(data: Uint8Array | string) {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      for (let i = 0; i < bytes.length; i++) {
        a = Math.imul(a ^ bytes[i]!, 0x01000193);
        b = Math.imul(b ^ bytes[i]!, 0x5bd1e995);
      }
      return hash;
    },
    digest(_encoding?: string) {
      return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
    },
  };
  return hash;
}
export const randomUUID = () => crypto.randomUUID();
export const randomBytes = (size: number) => crypto.getRandomValues(new Uint8Array(size));
