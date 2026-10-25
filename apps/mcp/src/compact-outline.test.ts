import { expect, it } from 'vitest';
import { compactOutline } from './recorder.js';

const outline = [
  'Scroll areas (layout only; offscreen content is not visual proof): {"regions":[]}',
  '[ref_1] link "Jump to content" — offscreen-left-above (scroll to reveal before clicking)',
  '[ref_2] input:search "Search Wikipedia" — visible at (690,33) viewport CSS pixels',
  '[ref_3] option "Product Hunt" in "options" — visible at (677,80) viewport CSS pixels',
  '  [ref_4] link "Product Hunt" in "options" — visible at (677,80) viewport CSS pixels',
  '[ref_5] link "Army of the Rhine" — obscured (inspect before clicking)',
  '[ref_6] link "Archive" — offscreen-below (scroll to reveal before clicking)',
].join('\n');

it('keeps the scroll header and the visible elements with their refs, and says what it left out', () => {
  expect(compactOutline(outline)).toBe([
    'Scroll areas (layout only; offscreen content is not visual proof): {"regions":[]}',
    '[ref_2] input:search "Search Wikipedia" — visible at (690,33) viewport CSS pixels',
    '[ref_3] option "Product Hunt" in "options" — visible at (677,80) viewport CSS pixels',
    '  [ref_4] link "Product Hunt" in "options" — visible at (677,80) viewport CSS pixels',
    '(3 more elements outside the viewport, covered or past the first 80; browser_observe with mode "outline" lists them all)',
  ].join('\n'));
  expect(compactOutline(outline, 1).split('\n')).toHaveLength(3);
  expect(compactOutline('[ref_1] button "Save" — visible at (1,1) window points')).toBe('[ref_1] button "Save" — visible at (1,1) window points');
});
