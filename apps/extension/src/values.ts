/** Same wire format as the local companion: bytes travel as {$bytes: base64}. */
export function encodeValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    let binary = '';
    for (let i = 0; i < value.length; i += 0x8000) binary += String.fromCharCode(...value.subarray(i, i + 0x8000));
    return { $bytes: btoa(binary) };
  }
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeValue(item)]));
  return value;
}
