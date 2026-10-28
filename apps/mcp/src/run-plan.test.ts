import { expect, it } from 'vitest';
import { compilePlan, lacksAttention, planSchema, scriptSteps } from './run-plan.js';

const plan = planSchema.parse({
  steps: [
    { screen: 'Main page', action: 'click', target: 'search field "Search Wikipedia"', expect: 'The field is focused' },
    { screen: 'Main page', action: 'type', target: 'search field "Search Wikipedia"', value: 'Product Hunt', expect: 'Suggestions appear' },
    { screen: 'Main page', action: 'press', target: 'search field "Search Wikipedia"', value: 'Enter', expect: 'The article opens' },
    { screen: 'Article', action: 'click', target: 'link "History"', expect: 'The History section shows' },
  ],
  finalState: 'The History section of the article is visible',
});

it('drops a click on a field that the next step types into, and keeps every other step', () => {
  expect(scriptSteps(plan.steps).map(step => `${step.action} ${step.target}`)).toEqual([
    'type search field "Search Wikipedia"', 'press search field "Search Wikipedia"', 'click link "History"',
  ]);
  const script = compilePlan(plan);
  expect(script).toContain('1. On Main page: type search field "Search Wikipedia" = "Product Hunt"');
  expect(script).not.toContain('The field is focused');
});

it('accepts gestures in a plan and leaves them out of the navigator script', () => {
  const withGestures = planSchema.parse({ ...plan, steps: [...plan.steps,
    { screen: 'Article', action: 'trace', target: 'heading "History"', value: 'underline', expect: 'The heading is underlined by the cursor' },
    { screen: 'Article', action: 'read', target: 'the History section', expect: 'The section scrolls past' }] });
  expect(scriptSteps(withGestures.steps).map(step => step.action)).toEqual(['type', 'press', 'click']);
  expect(compilePlan(withGestures)).not.toContain('underline');
});

it('defaults to a walkthrough, and asks a presentation for something to point out', () => {
  expect(plan.intent).toBe('walkthrough');
  expect(lacksAttention(plan)).toBe(false);
  const presentation = planSchema.parse({ ...plan, intent: 'presentation' });
  expect(lacksAttention(presentation)).toBe(true);
  const pointed = planSchema.parse({ ...presentation, steps: [...presentation.steps,
    { screen: 'Article', action: 'highlight', target: 'paragraph under "History"', value: 'founded in 2013', expect: 'The founding year is selected' }] });
  expect(lacksAttention(pointed)).toBe(false);
  expect(scriptSteps(pointed.steps).some(step => step.action === 'highlight')).toBe(false);
});
