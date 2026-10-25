import { z } from 'zod';

/**
 * The page layouts (CSS viewports) a Toru for Chrome recording can choose. The extension renders the page at that size
 * and captures it at most 2560 device pixels wide: 1280x720 and 1920x1080 as 2560x1440, 1440x900 as 2560x1600.
 */
export const VIEWPORT_PRESETS = { '1280x720': { width: 1280, height: 720 }, '1440x900': { width: 1440, height: 900 }, '1920x1080': { width: 1920, height: 1080 } } as const;
export type ViewportPreset = keyof typeof VIEWPORT_PRESETS;
export const DEFAULT_VIEWPORT: ViewportPreset = '1920x1080';
export const viewportSchema = z.enum(Object.keys(VIEWPORT_PRESETS) as [ViewportPreset, ...ViewportPreset[]]);

/** The CSS viewport a request names, or the default. */
export function viewportOf(value: unknown): { width: number; height: number } {
  return { ...VIEWPORT_PRESETS[value === undefined ? DEFAULT_VIEWPORT : viewportSchema.parse(value)] };
}
