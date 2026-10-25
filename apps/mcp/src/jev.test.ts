import { describe, expect, it, vi } from "vitest";
import {
  actionSpace,
  type JevAction,
  JevBrowserNavigator,
  JevClient,
  type JevDecisionTrace,
  type JevPage,
  validateChoice,
} from "./jev.js";

type Question = { type: "choice" | "noul"; criteria: Record<string, unknown> };
/** Option id for a choice, probability of yes for a noul. */
type Script = (questions: Record<string, Question>) => Record<string, string | number>;

/** Answers a choice by putting most of the mass on `chosen`. */
function answer(criteria: Record<string, unknown>, chosen: string) {
  const ids = Object.keys(criteria);
  if (!ids.includes(chosen)) throw new Error(`test chose ${chosen}, offered ${ids.join(",")}`);
  const rest = ids.length > 1 ? 0.1 / (ids.length - 1) : 0;
  return {
    choice: chosen,
    probabilities: Object.fromEntries(ids.map((id) => [id, id === chosen ? 0.9 : rest])),
    confidence: 0.9,
  };
}

/** A TypeSafe endpoint that replays one scripted decision per request. */
function fakeTypeSafe(steps: Script[]) {
  const bodies: Array<{
    model: string;
    state: Record<string, unknown>;
    questions: Record<string, Question>;
  }> = [];
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as (typeof bodies)[number];
    bodies.push(body);
    const step = steps.shift();
    if (!step) throw new Error("no scripted decision left");
    const choices = step(body.questions);
    const answers = Object.fromEntries(
      Object.entries(choices).map(([id, chosen]) => {
        const question = body.questions[id];
        if (!question) throw new Error(`question ${id} was not asked`);
        if (question.type === "noul") return [id, { type: "noul", noul: Number(chosen) }];
        return [id, answer(question.criteria, String(chosen))];
      }),
    );
    return new Response(
      JSON.stringify({ model: body.model, answers, usage: { input_tokens: 1_000 } }),
    );
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, bodies };
}

/** The index a target question offers for the element whose description contains `text`. */
function indexOf(question: Question | undefined, text: string): string {
  const found = Object.entries(question?.criteria ?? {}).find(([, value]) =>
    JSON.stringify(value).includes(text),
  );
  if (!found) throw new Error(`no target contains ${text}`);
  return found[0];
}

const signal = new AbortController().signal;

function formPage(overrides: Partial<JevPage> = {}): JevPage {
  return {
    url: "https://app.example.com/projects/new",
    text: "New project",
    elements: [
      { ref: "ref_1", role: "input:text", name: "Project name", position: "visible" },
      { ref: "ref_2", role: "button", name: "Create", position: "visible" },
      { ref: "ref_3", role: "link", name: "Docs", position: "visible" },
    ],
    scrollAreas: [],
    ...overrides,
  };
}

describe("validateChoice", () => {
  it("accepts a coherent answer over the offered options", () => {
    expect(validateChoice(answer({ a: 1, b: 1 }, "b"), ["a", "b"]).choice).toBe("b");
  });

  it("rejects an option that was never offered", () => {
    expect(() =>
      validateChoice({ choice: "c", probabilities: { a: 0.5, b: 0.5 }, confidence: 1 }, ["a", "b"]),
    ).toThrow("jev_answer_invalid");
  });

  it("rejects a choice that is not the most likely option", () => {
    expect(() =>
      validateChoice({ choice: "a", probabilities: { a: 0.2, b: 0.8 }, confidence: 1 }, ["a", "b"]),
    ).toThrow("jev_answer_invalid");
  });
});

describe("JevClient", () => {
  it("pins the model, authenticates and charges input tokens only", async () => {
    const { fetch, bodies } = fakeTypeSafe([() => ({ q: "yes" })]);
    const client = new JevClient({ apiKey: "key", fetch });
    const result = await client.ask(
      {},
      { q: { type: "choice", criteria: { yes: "y", no: "n" }, instructions: "?" } },
      signal,
    );
    expect(bodies[0]?.model).toBe("jev-1.13.0");
    const init = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer key");
    expect(result.costUsd).toBeCloseTo(0.000042);
    expect(client.spentUsd).toBeCloseTo(0.000042);
  });

  it("retries a rate limit and then succeeds", async () => {
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response("busy", { status: 429 });
      return new Response(
        JSON.stringify({ answers: { q: answer({ yes: 1, no: 1 }, "no") }, usage: {} }),
      );
    }) as unknown as typeof globalThis.fetch;
    const client = new JevClient({ apiKey: "key", fetch });
    const result = await client.ask(
      {},
      { q: { type: "choice", criteria: { yes: "y", no: "n" }, instructions: "?" } },
      signal,
    );
    expect(calls).toBe(2);
    expect(validateChoice(result.answers.q, ["yes", "no"]).choice).toBe("no");
  });

  it("reuses an identical decision within one session without another model charge",async()=>{
    const {fetch}=fakeTypeSafe([()=>({q:'yes'}),()=>({q:'no'})]);
    const checkpoints:number[]=[];
    const client=new JevClient({apiKey:'key',fetch,onCostCheckpoint:cost=>checkpoints.push(cost)});
    const questions={q:{type:'choice' as const,criteria:{yes:'y',no:'n'},instructions:'?'}};
    const first=await client.ask({page:'same'},questions,signal);
    const repeated=await client.ask({page:'same'},questions,signal);
    expect(repeated.answers).toEqual(first.answers);
    expect(repeated.costUsd).toBe(0);
    expect(client.spentUsd).toBeCloseTo(first.costUsd);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(checkpoints).toHaveLength(2);
    await client.ask({page:'changed'},questions,signal);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refuses a request that could exceed the run budget", async () => {
    const { fetch } = fakeTypeSafe([]);
    const client = new JevClient({ apiKey: "key", fetch, maximumRunCostUsd: 0.0000001 });
    await expect(
      client.ask(
        {},
        { q: { type: "choice", criteria: { a: 1, b: 2 }, instructions: "?" } },
        signal,
      ),
    ).rejects.toThrow("jev_budget_exhausted");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("actionSpace", () => {
  it("offers only operations something on the page can receive", () => {
    const space = actionSpace(
      formPage({
        elements: [
          { ref: "ref_1", role: "input:password", name: "Password", position: "visible" },
          { ref: "ref_2", role: "button", name: "Covered", position: "obscured" },
          { ref: "ref_3", role: "button", name: "Save", states: ["disabled"], position: "visible" },
          { ref: "ref_4", role: "combobox", name: "Region", position: "visible" },
          { ref: "ref_5", role: "select", name: "Plan", position: "offscreen" },
          {
            ref: "ref_6",
            role: "input:text",
            name: "ID",
            states: ["readonly"],
            position: "visible",
          },
        ],
        scrollAreas: [
          {
            kind: "page",
            wheelAt: { x: 1, y: 1 },
            remaining: { up: 0, down: 900, left: 0, right: 10 },
          },
        ],
      }),
      false,
    );
    expect(Object.keys(space.operations)).toEqual([
      "CLICK",
      "TYPE_TEXT",
      "SELECT",
      "PRESS_ESCAPE",
      "SCROLL_1_DOWN",
      "WAIT",
      "DONE",
      "BLOCKED",
    ]);
    expect(Object.values(space.targets.CLICK ?? {}).map((e) => e.name)).toEqual(["Region"]);
    // A readonly field is listed for context but is never offered for typing.
    expect(Object.values(space.targets.TYPE_TEXT ?? {}).map((e) => e.name)).toEqual(["Region"]);
    expect(space.table.some((row) => row.includes('"ID" (readonly)'))).toBe(true);
    expect(space.table.some((row) => row.includes("Password"))).toBe(true);
  });

  it("shows covered controls without targeting them, and offers Escape to uncover them", () => {
    const space = actionSpace(
      formPage({
        elements: [
          {
            ref: "ref_1",
            role: "combobox",
            name: "Search titles",
            states: ["expanded"],
            position: "visible",
          },
          { ref: "ref_2", role: "button", name: "CEO", position: "visible" },
          { ref: "ref_3", role: "button", name: "Function", position: "obscured" },
        ],
      }),
      false,
    );
    expect(space.operations.PRESS_ESCAPE).toBeDefined();
    expect(Object.values(space.targets.CLICK ?? {}).map((e) => e.name)).toEqual([
      "Search titles",
      "CEO",
    ]);
    expect(space.table).toContain(
      '[covered] button "Function" — hidden under an open list or popup',
    );
  });

  it("marks the elements the last action revealed", () => {
    const space = actionSpace(formPage(), false, new Set(['input:text "Project name"']));
    expect(space.table).toEqual([
      '[1] input:text "Project name"',
      '[2] (new) button "Create"',
      '[3] (new) link "Docs"',
    ]);
    // Without a previous page nothing can be new.
    expect(actionSpace(formPage(), false).table[1]).toBe('[2] button "Create"');
  });

  it("offers Escape only when something is open or covered", () => {
    expect(actionSpace(formPage(), false).operations.PRESS_ESCAPE).toBeUndefined();
  });

  it("offers Enter only right after typing", () => {
    expect(actionSpace(formPage(), false).operations.PRESS_ENTER).toBeUndefined();
    expect(actionSpace(formPage(), true).operations.PRESS_ENTER).toBeDefined();
  });
});

describe("JevBrowserNavigator", () => {
  function harness(steps: Script[], pages: JevPage[], options: { verifier?: boolean } = {}) {
    const { fetch, bodies } = fakeTypeSafe(steps);
    const navigator = new JevBrowserNavigator({ client: new JevClient({ apiKey: "key", fetch }) });
    const acted: JevAction[] = [];
    let current = 0;
    return {
      bodies,
      acted,
      run: (overrides: Partial<Parameters<JevBrowserNavigator["run"]>[0]> = {}) =>
        navigator.run({
          goal: "Create a project",
          win: "The new project page is shown",
          maximumActions: 10,
          observe: async () => pages[Math.min(current, pages.length - 1)] as JevPage,
          act: async (action) => {
            acted.push(action);
            current++;
          },
          writeValue: async () => "Launch plan",
          ...(options.verifier === false ? {} : { confirmWin: async () => true }),
          signal,
          ...overrides,
        }),
    };
  }

  it("types, clicks and stops on a verified result", async () => {
    const created = formPage({ url: "https://app.example.com/projects/1", text: "Launch plan" });
    const test = harness(
      [
        (q) => ({
          operation: "TYPE_TEXT",
          type_text_target: indexOf(q.type_text_target, "Project name"),
        }),
        (q) => ({ operation: "CLICK", click_target: indexOf(q.click_target, "Create") }),
        () => ({ operation: "DONE" }),
      ],
      [formPage(), formPage({ text: "New project Launch plan" }), created],
    );
    const result = await test.run();
    expect(result).toMatchObject({ status: "done", actions: 2, decisions: 3 });
    expect(test.acted.map((action) => action.kind)).toEqual(["type", "click"]);
    expect(test.acted[0]).toMatchObject({ text: "Launch plan", element: { ref: "ref_1" } });
    expect(test.acted[1]).toMatchObject({ element: { ref: "ref_2" } });
    // Even a single candidate is a choice: Jev can reject it rather than being handed it.
    expect(Object.keys(test.bodies[0]?.questions.type_text_target?.criteria ?? {})).toEqual([
      "1",
      "none",
    ]);
    expect(test.bodies[0]?.questions.win_check).toBeUndefined();
  });

  it("accepts a completed attempt without paying for an independent result check when disabled", async () => {
    const test = harness([() => ({ operation: "DONE" })], [formPage()]);
    const confirmWin = vi.fn(async () => false);
    await expect(test.run({ verifySuccess: false, confirmWin })).resolves.toMatchObject({
      status: "done",
    });
    expect(test.bodies[0]?.questions.win_check).toBeUndefined();
    expect(confirmWin).not.toHaveBeenCalled();
  });

  it("asks a yes/no success question in the same request when nothing can verify visually", async () => {
    const test = harness([() => ({ operation: "DONE", win_check: 0.93 })], [formPage()], {
      verifier: false,
    });
    const result = await test.run();
    expect(result.status).toBe("done");
    expect(test.bodies[0]?.questions.win_check?.type).toBe("noul");
  });

  it("keeps going when the yes/no success estimate is too low to believe", async () => {
    const test = harness(
      [
        () => ({ operation: "DONE", win_check: 0.4 }),
        () => ({ operation: "DONE", win_check: 0.35 }),
        () => ({ operation: "DONE", win_check: 0.3 }),
      ],
      [formPage()],
      { verifier: false },
    );
    await expect(test.run()).resolves.toMatchObject({
      status: "blocked",
      reason: "win_not_verified",
    });
    // Each rejection waited, longer each time, for a result that never arrived.
    expect(test.acted).toEqual([
      { kind: "wait", durationMs: 1_000 },
      { kind: "wait", durationMs: 2_000 },
    ]);
  });

  it("asks each part of the success condition apart and names the part still missing", async () => {
    const traces: JevDecisionTrace[] = [];
    const test = harness(
      [
        () => ({ operation: "DONE", win_check_0: 0.95, win_check_1: 0.2 }),
        () => ({ operation: "DONE", win_check_0: 0.95, win_check_1: 0.9 }),
      ],
      [formPage()],
      { verifier: false },
    );
    const parts = ["The sheet lists people", "The enrichment column has values"];
    await expect(
      test.run({ winParts: parts, onDecision: (trace) => traces.push(trace) }),
    ).resolves.toMatchObject({ status: "done" });
    const [first, second] = test.bodies;
    expect(Object.keys(first?.questions ?? {}).filter((id) => id.startsWith("win_check"))).toEqual([
      "win_check_0",
      "win_check_1",
    ]);
    expect(traces[0]).toMatchObject({
      error: "win_not_verified",
      successChecks: [
        [parts[0], 0.95],
        [parts[1], 0.2],
      ],
    });
    const note = JSON.stringify(second?.state.recent_actions);
    expect(note).toContain("The enrichment column has values");
    expect(note).not.toContain("The sheet lists people");
  });

  it("waits after a rejected DONE for results that are still arriving", async () => {
    const early = () => ({ operation: "DONE", win_check: 0.3 });
    const test = harness(
      [early, early, early, early, () => ({ operation: "DONE", win_check: 0.9 })],
      [1, 2, 3, 4, 5].map((filled) => formPage({ text: `Enriched ${filled} of 5` })),
      { verifier: false },
    );
    // Four rejections, more than the limit, but the page changed during every wait.
    await expect(test.run()).resolves.toMatchObject({ status: "done", actions: 4 });
    expect(test.acted.every((action) => action.kind === "wait")).toBe(true);
  });

  it("acts on nothing when Jev says no listed element fits", async () => {
    const none = () => ({ operation: "CLICK", click_target: "none" });
    const test = harness([none, none, none], [formPage()]);
    await expect(test.run()).resolves.toMatchObject({ status: "blocked", reason: "no_progress" });
    expect(test.acted).toEqual([]);
  });

  it("selects a dropdown value from its real options instead of asking the writer", async () => {
    const plans = formPage({
      elements: [
        {
          ref: "ref_1",
          role: "select",
          name: "Plan",
          value: "Starter",
          options: ["Starter", "Growth", "Enterprise"],
          position: "visible",
        },
        { ref: "ref_2", role: "button", name: "Continue", position: "visible" },
      ],
    });
    const test = harness(
      [
        () => ({ operation: "SELECT", select_target: "1", select_option_1: "2" }),
        () => ({ operation: "BLOCKED" }),
      ],
      [plans],
    );
    const writeValue = vi.fn(async () => "should not be used");
    await test.run({ goal: "Choose the Growth plan", writeValue });
    expect(test.acted).toEqual([expect.objectContaining({ kind: "select", value: "Growth" })]);
    expect(writeValue).not.toHaveBeenCalled();
    expect(test.bodies[0]?.questions.select_option_1?.criteria).toMatchObject({
      "1": "Starter",
      "2": "Growth",
      "3": "Enterprise",
    });
  });

  it("backs off while a page keeps loading and gives up only when the time budget is spent", async () => {
    const wait = () => ({ operation: "WAIT" });
    const test = harness(
      Array.from({ length: 10 }, () => wait),
      [formPage()],
    );
    const result = await test.run();
    // 1 + 2 + 4 + 8 × 6 = 55s; a tenth wait of 8s would pass the 60s budget.
    expect(test.acted.map((action) => (action.kind === "wait" ? action.durationMs : 0))).toEqual([
      1_000, 2_000, 4_000, 8_000, 8_000, 8_000, 8_000, 8_000, 8_000,
    ]);
    expect(result).toMatchObject({ status: "blocked", reason: "waiting" });
  });

  it("waits once on a page that just changed before believing BLOCKED", async () => {
    const opened = formPage({ url: "https://app.example.com/projects/1", text: "Loading…" });
    const test = harness(
      [
        (q) => ({ operation: "CLICK", click_target: indexOf(q.click_target, "Create") }),
        () => ({ operation: "BLOCKED" }),
        () => ({ operation: "BLOCKED" }),
      ],
      [formPage(), opened],
    );
    const result = await test.run();
    expect(test.acted.map((action) => action.kind)).toEqual(["click", "wait"]);
    expect(result).toMatchObject({ status: "blocked", reason: "model_blocked", decisions: 3 });
  });

  it("passes operator guidance as its own field, apart from page content", async () => {
    const test = harness([() => ({ operation: "BLOCKED" })], [formPage()]);
    await test.run({ readGuidance: vi.fn().mockReturnValueOnce("Use the Growth plan") });
    expect(test.bodies[0]?.state.operator_guidance).toEqual(["Use the Growth plan"]);
  });

  it("discards a pending decision when new client guidance arrives", async () => {
    const test = harness([
      q => ({ operation: "CLICK", click_target: indexOf(q.click_target, "Create") }),
      () => ({ operation: "BLOCKED" }),
    ], [formPage()]);
    await test.run({ readGuidance: vi.fn().mockReturnValueOnce(undefined).mockReturnValueOnce("Do not create anything") });
    expect(test.acted).toEqual([]);
    expect(test.bodies[1]?.state.operator_guidance).toEqual(["Do not create anything"]);
  });

  it("reports no_progress when clicks keep leaving the page unchanged", async () => {
    const click = (q: Record<string, Question>) => ({
      operation: "CLICK",
      click_target: indexOf(q.click_target, "Docs"),
    });
    const test = harness([click, click, click], [formPage()]);
    await expect(test.run()).resolves.toMatchObject({ status: "blocked", reason: "no_progress" });
  });

  it("does not believe DONE until the verifier agrees", async () => {
    const done = () => ({ operation: "DONE" });
    const test = harness([done, done, done], [formPage()]);
    await expect(test.run({ confirmWin: async () => false })).resolves.toMatchObject({
      status: "blocked",
      reason: "win_not_verified",
    });
  });

  it("records a field it cannot fill as a failed step instead of typing a guess", async () => {
    const test = harness(
      [
        (q) => ({
          operation: "TYPE_TEXT",
          type_text_target: indexOf(q.type_text_target, "Project name"),
        }),
        () => ({ operation: "BLOCKED" }),
      ],
      [formPage()],
    );
    const traces: unknown[] = [];
    const result = await test.run({
      writeValue: async () => {
        throw new Error("model_provider_unavailable");
      },
      onDecision: (trace) => traces.push(trace),
    });
    expect(test.acted).toEqual([]);
    expect(result).toMatchObject({ status: "blocked", reason: "model_blocked" });
    expect(traces[0]).toMatchObject({
      operation: "TYPE_TEXT",
      error: "model_provider_unavailable",
    });
  });
});


it('checkpoints the conservative model cost before dispatch and settles after response', async () => {
  const checkpoints:number[]=[];
  const fetch=vi.fn(async()=>{
    expect(checkpoints).toHaveLength(1);expect(checkpoints[0]).toBeGreaterThan(0);
    return new Response(JSON.stringify({answers:{q:0.9},usage:{input_tokens:1}}));
  });
  const client=new JevClient({apiKey:'test',fetch,onCostCheckpoint:cost=>checkpoints.push(cost)});
  await client.ask({page:'test'},{q:{type:'noul',instructions:'Is it ready?',criteria:{true:'ready',false:'not ready'}}},new AbortController().signal);
  expect(checkpoints).toHaveLength(2);expect(checkpoints[1]).toBe(client.spentUsd);
  expect(checkpoints[1]).toBeLessThan(checkpoints[0]!);
  const denied=new JevClient({apiKey:'test',fetch,onCostCheckpoint:()=>{throw new Error('disk_failed');}});
  await expect(denied.ask({}, {q:{type:'noul',instructions:'Is it ready?',criteria:{true:'ready',false:'not ready'}}},new AbortController().signal)).rejects.toThrow('disk_failed');
  expect(fetch).toHaveBeenCalledOnce();
});
