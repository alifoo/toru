import { expect, it } from 'vitest';
import { looksTiled } from './scale-image.js';

/** A 2560x1600 RGBA picture: `paint(x, y)` gives a grey level. */
function picture(width: number, height: number, paint: (x: number, y: number) => number) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const value = paint(x, y), at = (y * width + x) * 4;
    pixels[at] = pixels[at + 1] = pixels[at + 2] = value; pixels[at + 3] = 255;
  }
  return pixels;
}
// Text-like content: dark strokes at irregular places on a light page.
const content = (x: number, y: number) => ((x * 7919 + y * 104729) % 97 < 9 && (Math.floor(x / 37) + Math.floor(y / 23)) % 3 !== 0 ? 30 : 245);

it('finds a capture Chrome painted at one pixel per CSS pixel into a denser surface', () => {
  const width = 2560, height = 1600, period = 1440;
  // The page at 1440x900 repeated every viewport width and height: four copies, the right and bottom ones cut off.
  expect(looksTiled(picture(width, height, (x, y) => content(x % period, y % 900)), width, height, period)).toBe(true);
  expect(looksTiled(picture(width, height, content), width, height, period)).toBe(false);
  // A blank page has no edges to compare and is never taken for a repeat.
  expect(looksTiled(picture(width, height, () => 245), width, height, period)).toBe(false);
  // A capture at one pixel per CSS pixel has no period to check.
  expect(looksTiled(picture(1440, 900, content), 1440, 900, 1440)).toBe(false);
});
