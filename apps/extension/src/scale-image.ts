/**
 * A PNG (base64) scaled to `width`×`height`, as PNG base64: the navigator's observation of a tab that renders denser
 * than it is observed. Scaling here, instead of asking Chrome for a scaled capture, keeps the tab rendering at its own
 * scale, so the screencast being recorded never sees a shrunk frame.
 *
 * With `scale` (the tab's device pixels per CSS pixel), a capture Chrome painted at one pixel per CSS pixel into the
 * denser surface is refused (null): it comes back tiled, the page repeated every viewport width, and the navigator
 * saw four copies of the page (03/11/2026, the first screenshots of a session in a freshly installed extension). The
 * caller then takes Chrome's own scaled capture, which paints the frame anew.
 */
export async function scalePng(png: string, width: number, height: number, scale = 1): Promise<string | null> {
  const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: 'image/png' });
  if (scale > 1) {
    const full = await createImageBitmap(blob);
    try {
      const canvas = new OffscreenCanvas(full.width, full.height);
      const context = canvas.getContext('2d', { willReadFrequently: true })!;
      context.drawImage(full, 0, 0);
      const pixels = context.getImageData(0, 0, full.width, full.height).data;
      if (looksTiled(pixels, full.width, full.height, Math.round(full.width / scale))) return null;
    } finally {
      full.close();
    }
  }
  const bitmap = await createImageBitmap(blob, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
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

/**
 * Whether an RGBA picture repeats itself `period` pixels to the right. Only edges count (a pixel unlike its neighbour),
 * so a page of plain background is never taken for a repeat; a tiled capture matches on nearly every edge.
 */
export function looksTiled(pixels: Uint8ClampedArray, width: number, height: number, period: number): boolean {
  if (!(period > 16 && period < width - 16)) return false;
  const rowStep = Math.max(1, Math.floor(height / 40));
  let edges = 0, same = 0;
  for (let y = 0; y < height; y += rowStep) {
    for (let x = 0; x + period < width && x + 3 < width; x += 5) {
      const at = (y * width + x) * 4, next = at + 12, there = at + period * 4;
      const edge = Math.abs(pixels[at]! - pixels[next]!) + Math.abs(pixels[at + 1]! - pixels[next + 1]!) + Math.abs(pixels[at + 2]! - pixels[next + 2]!);
      if (edge < 60) continue;
      edges++;
      const difference = Math.abs(pixels[at]! - pixels[there]!) + Math.abs(pixels[at + 1]! - pixels[there + 1]!) + Math.abs(pixels[at + 2]! - pixels[there + 2]!);
      if (difference <= 24) same++;
    }
  }
  return edges >= 40 && same / edges >= 0.9;
}
