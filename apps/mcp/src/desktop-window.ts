import { z } from 'zod';

/**
 * The window sizes (macOS points) a Toru for Mac recording can give the shared window, when the user lets their agent
 * operate it. The Mac app fits the preset to the window's screen (the largest size with its aspect ratio that fits),
 * records, and puts the window back afterwards. Displays are never resized.
 */
export const WINDOW_SIZE_PRESETS = ['1280x720', '1440x900', '1920x1080'] as const;
export type WindowSizePreset = typeof WINDOW_SIZE_PRESETS[number];
export const DEFAULT_WINDOW_SIZE: WindowSizePreset = '1920x1080';
export const windowSizeSchema = z.enum(WINDOW_SIZE_PRESETS);

/**
 * What the Mac reports about the shared window for a recording: its size in points while recording, whether Toru
 * resized it, why not (control_off, display, not_resizable) or why another size (fitted_to_screen, app_limited), and
 * whether it was put back afterwards. Mac apps before 0.4.2 report nothing.
 */
const desktopWindowSchema = z.object({
  requested: windowSizeSchema.optional(),
  width: z.number().int().min(1).max(20000),
  height: z.number().int().min(1).max(20000),
  resized: z.boolean(),
  reason: z.enum(['control_off', 'display', 'not_resizable', 'fitted_to_screen', 'app_limited']).optional(),
  restored: z.boolean().optional(),
}).strip();
export type DesktopWindow = z.infer<typeof desktopWindowSchema>;

/** The report when it is well formed, otherwise nothing (an older or misbehaving app never fails a recording). */
export function desktopWindow(value: unknown): DesktopWindow | undefined {
  const parsed = desktopWindowSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
