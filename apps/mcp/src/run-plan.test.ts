import { expect, it } from 'vitest';
import { compilePlan, planSchema, scriptSteps } from './run-plan.js';

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
