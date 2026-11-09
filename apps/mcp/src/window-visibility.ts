/**
 * Whether Chrome is drawing the recording window, as Toru for Chrome reports it after each command while recording.
 * `stalled` is a page that says it is visible but draws no frame. Chrome stops drawing a window that is hidden,
 * minimized, covered or on another desktop: the screencast sends nothing, animations pause, so nothing done there
 * reaches the video.
 */
export type PageVisibility = 'visible' | 'hidden' | 'stalled';

/** Reads a reported state; anything else is unknown (an extension before the check). */
export function pageVisibility(value: unknown): PageVisibility | undefined {
  return value === 'visible' || value === 'hidden' || value === 'stalled' ? value : undefined;
}

/** Reported ranges on the recording clock, bounded: well-formed, in order, at most 500. */
export function hiddenRanges(value: unknown): Array<{ startMs: number; endMs: number }> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((range): range is { startMs: number; endMs: number } => typeof range === 'object' && range !== null
    && Number.isFinite((range as { startMs?: unknown }).startMs) && Number.isFinite((range as { endMs?: unknown }).endMs)
    && (range as { startMs: number }).startMs >= 0 && (range as { endMs: number }).endMs >= (range as { startMs: number }).startMs)
    .slice(0, 500).map(range => ({ startMs: Math.round(range.startMs), endMs: Math.round(range.endMs) }));
}

/** What the agent is told while Chrome is not drawing the recording window. */
export const recordingWindowHidden = {
  code: 'recording_window_hidden',
  message: 'Chrome is not drawing the recording window (hidden, minimized, covered, or on another desktop/workspace). Nothing you do now is recorded, so Toru refuses page actions until it is visible again. Ask the user to bring the Toru window into view, then observe again (browser_observe).',
} as const;
