import { describe, expect, it } from 'vitest';
import { captureFrameSize, captureScaleFor, chooseViewport, DEFAULT_VIEWPORT, renderScaleFor, VIEWPORT_PRESETS } from './config.js';

describe('Toru for Chrome page layout', () => {
  it('records the preset the server names, 1280x720 for a server that names none, and the default otherwise', () => {
    expect(chooseViewport({ width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080 });
    expect(chooseViewport({ width: 1440, height: 900 })).toEqual({ width: 1440, height: 900 });
    expect(chooseViewport({ width: 1280, height: 720 })).toEqual({ width: 1280, height: 720 });
    // A server before the choice reads every coordinate in the 1280x720 layout it always got.
    expect(chooseViewport(undefined)).toEqual({ width: 1280, height: 720 });
    // A size this build does not offer (a newer server, a typo) records the default, and reports it.
    expect(chooseViewport({ width: 2560, height: 1440 })).toEqual(DEFAULT_VIEWPORT);
    expect(chooseViewport('1920x1080')).toEqual(DEFAULT_VIEWPORT);
    expect(DEFAULT_VIEWPORT).toEqual({ width: 1920, height: 1080 });
  });

  it('renders the tab at the screen\'s own scale, so a captured frame never re-renders the user\'s window', () => {
    expect(renderScaleFor(1)).toBe(1);
    expect(renderScaleFor(2)).toBe(2);
    expect(renderScaleFor(1.5)).toBe(1.5);
    // Not the 4/3 a 1920x1080 recording asks for: Chrome would re-render a 1x or 2x window at 4/3 for every frame.
    expect(renderScaleFor(2)).not.toBeCloseTo(captureScaleFor(VIEWPORT_PRESETS['1920x1080']));
    // Out of range or unreadable: the transport's bounds, or 1.
    expect(renderScaleFor(4)).toBe(3);
    expect(renderScaleFor(0.9)).toBe(1);
    expect(renderScaleFor(undefined)).toBe(1);
    expect(renderScaleFor('2')).toBe(2);
    expect(renderScaleFor(Number.NaN)).toBe(1);
  });

  it('captures every preset at most 2560 wide and at most 2x, in even frame sizes', () => {
    expect(captureScaleFor(VIEWPORT_PRESETS['1920x1080'])).toBeCloseTo(4 / 3, 10);
    expect(captureScaleFor(VIEWPORT_PRESETS['1440x900'])).toBeCloseTo(16 / 9, 10);
    expect(captureScaleFor(VIEWPORT_PRESETS['1280x720'])).toBe(2);
    expect(captureFrameSize(VIEWPORT_PRESETS['1920x1080'])).toEqual({ width: 2560, height: 1440 });
    expect(captureFrameSize(VIEWPORT_PRESETS['1440x900'])).toEqual({ width: 2560, height: 1600 });
    expect(captureFrameSize(VIEWPORT_PRESETS['1280x720'])).toEqual({ width: 2560, height: 1440 });
    for (const viewport of Object.values(VIEWPORT_PRESETS)) {
      const scale = captureScaleFor(viewport);
      // What the screencast asks for (the driver rounds viewport x scale) is the frame size the encoder expects.
      expect({ width: Math.round(viewport.width * scale), height: Math.round(viewport.height * scale) }).toEqual(captureFrameSize(viewport));
    }
  });
});
