import { z } from 'zod';

/**
 * The plan a user's agent sends with a recording: written from the product's own source code, so Toru's
 * navigator knows the exact screens, labels, values and end state instead of guessing from a one-line goal.
 */
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
export const planStepSchema = z.object({
  /** Where the step happens, as the user sees it: a route, page title or dialog name. */
  screen: text(2, 200),
  /** point, trace, sweep, highlight and read are gestures the driving agent makes (browser_point and the rest); they press nothing. */
  action: z.enum(['click', 'type', 'select', 'press', 'scroll', 'wait', 'navigate', 'point', 'trace', 'sweep', 'highlight', 'read']),
  /** The exact visible label of the control, from the source or the UI: button "Create invoice", field "Customer". */
  target: text(1, 200),
  /** What to type, the option to pick, the key to press, the path to open, a trace's shape (circle, underline), or the
   * exact passage a highlight selects. */
  value: z.string().max(2000).optional(),
  /** What visibly changes when the step worked. */
  expect: text(3, 300),
});
export const planSchema = z.object({
  /**
   * walkthrough follows the screens; presentation demonstrates the feature as a person would, pointing out on each
   * content screen what the viewer should notice (the plan's point, trace, sweep and highlight steps).
   */
  intent: z.enum(['walkthrough', 'presentation']).default('walkthrough'),
  /** Data or state that must exist before the flow (an invoice in Draft, a signed-in admin). */
  preconditions: z.array(text(3, 300)).max(10).default([]),
  steps: z.array(planStepSchema).min(1).max(30),
  /** What must be visible on the last screen for the demo to be done. */
  finalState: text(10, 600),
  /** Controls or changes the demo must not touch. */
  avoid: z.array(text(3, 300)).max(10).default([]),
  /** Where the plan came from (file:line), for the record; not shown to the navigator. */
  sources: z.array(text(3, 200)).max(20).default([]),
});
export type RunPlan = z.infer<typeof planSchema>;

/** The template returned when a plan is missing or malformed. */
export const planTemplate = {
  preconditions: ['Data or state that must exist first'],
  steps: [{ screen: 'Invoices list (/invoices)', action: 'click', target: 'button "New invoice"', expect: 'The "New invoice" dialog opens' },
    { screen: 'New invoice dialog', action: 'type', target: 'field "Customer"', value: 'Acme Inc.', expect: 'Acme Inc. is suggested and selected' }],
  finalState: 'The invoice detail page shows status "Paid" for Acme Inc.',
  avoid: ['Do not delete or archive existing invoices'],
  sources: ['src/routes/invoices/new.tsx:42'],
};

/** The quoted label in a target such as `field "Customer"`, or the whole target. */
export function label(target: string): string {
  return /"([^"]+)"/.exec(target)?.[1] ?? target.replace(/^(button|field|link|tab|menu|option|checkbox|select|dropdown)\s+/i, '').trim();
}

/** The navigator's script: compact, ordered, exact labels first. The navigator reads up to 4,000 characters. */
/**
 * The steps the navigator follows. Typing into a field focuses it, and the navigator only clicks controls, never
 * text fields: a "click the field" step right before typing into the same field made it look for a control that is
 * not there and give up (no_progress on a Wikipedia search, 2026-10-24). Such a click is dropped. Gestures are dropped
 * too: they show what is on screen and change nothing, and the navigator has no tool for them.
 */
const gestures: ReadonlySet<string> = new Set(['point', 'trace', 'sweep', 'highlight', 'read']);

/** The steps that point something out to the viewer. */
export const attentionActions: ReadonlySet<string> = new Set(['point', 'trace', 'sweep', 'highlight']);

/** A presentation that never points anything out is a walkthrough: it is sent back for its attention points. */
export function lacksAttention(plan: RunPlan): boolean {
  return plan.intent === 'presentation' && !plan.steps.some(step => attentionActions.has(step.action));
}
export function scriptSteps(steps: RunPlan['steps']): RunPlan['steps'] {
  return steps.filter(step => !gestures.has(step.action)).filter((step, index, kept) => {
    const next = kept[index + 1];
    return !(step.action === 'click' && next && (next.action === 'type' || next.action === 'select') && label(next.target) === label(step.target));
  });
}

export function compilePlan(plan: RunPlan, guidance?: string): string {
  const lines = [
    'Plan from the user\'s agent, written from the product\'s source code. Follow the steps in order; labels are exact.',
    ...(plan.preconditions.length ? [`Before: ${plan.preconditions.join('; ')}`] : []),
    ...scriptSteps(plan.steps).map((step, index) => `${index + 1}. On ${step.screen}: ${step.action} ${step.target}${step.value !== undefined && step.value !== '' ? ` = ${JSON.stringify(step.value)}` : ''} -> ${step.expect}`),
    `Done when: ${plan.finalState}`,
    ...(plan.avoid.length ? [`Never: ${plan.avoid.join('; ')}`] : []),
  ];
  const script = lines.join('\n');
  return guidance?.trim() ? `${script}\n\nMore from the agent:\n${guidance.trim()}` : script;
}

/**
 * Values the plan gives for typed and selected fields, keyed by the field's label. A field filled once gets a
 * value; a field filled several times (three tasks typed into the same input) gets its values in order.
 */
export function planValues(plan: RunPlan): { values: Record<string, string>; sequences: Record<string, string[]> } {
  const byField = new Map<string, string[]>();
  for (const step of plan.steps) {
    if ((step.action !== 'type' && step.action !== 'select') || !step.value) continue;
    const field = label(step.target);
    byField.set(field, [...(byField.get(field) ?? []), step.value]);
  }
  const values: Record<string, string> = {}, sequences: Record<string, string[]> = {};
  for (const [field, list] of byField) {
    if (new Set(list).size === 1) values[field] = list[0]!;
    else sequences[field] = list;
  }
  return { values, sequences };
}
