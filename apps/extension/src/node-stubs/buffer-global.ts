/** The driver decodes CDP base64 payloads with Buffer.from(data, 'base64'). */
const decode = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};
export const Buffer = {
  from(value: string | ArrayLike<number> | ArrayBuffer, encoding?: string): Uint8Array {
    if (typeof value === 'string') return encoding === 'base64' ? decode(value) : new TextEncoder().encode(value);
    return value instanceof ArrayBuffer ? new Uint8Array(value) : Uint8Array.from(value);
  },
  concat(chunks: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
  },
};
/** The driver reads optional settings from process.env; none are set in the extension. */
export const process = { env: {} as Record<string, string | undefined>, platform: 'browser', pid: 0 };
