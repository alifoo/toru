/**
 * A PNG (base64) scaled to `width`×`height`, as PNG base64: the navigator's observation of a tab that renders denser
 * than it is observed. Scaling here, instead of asking Chrome for a scaled capture, keeps the tab rendering at its own
 * scale, so the screencast being recorded never sees a shrunk frame.
 */
export async function scalePng(png: string, width: number, height: number): Promise<string> {
  const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
  try {
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    const scaled = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let binary = '';
    for (let i = 0; i < scaled.length; i += 0x8000) binary += String.fromCharCode(...scaled.subarray(i, i + 0x8000));
    return btoa(binary);
  } finally {
    bitmap.close();
  }
}
