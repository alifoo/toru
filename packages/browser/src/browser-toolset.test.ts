import { describe, expect, it, vi } from "vitest";
import {
  type BrowserRefDriver,
  createBrowserToolsetExecutor,
  StaleRefError,
} from "./browser-toolset.js";

function fakeDriver(overrides: Partial<BrowserRefDriver> = {}): BrowserRefDriver {
  return {
    readPage: vi.fn(async () => '[ref_1] button "Analisar"'),
    findElements: vi.fn(async () => '[ref_1] button "Analisar"'),
    pageText: vi.fn(async () => "Acme"),
    currentUrl: vi.fn(async () => "https://app.acme.example/dashboard"),
    pointer: vi.fn(async () => undefined),
    formInput: vi.fn(async () => undefined),
    scrollToRef: vi.fn(async () => undefined),
    scrollBy: vi.fn(async () => undefined),
    typeText: vi.fn(async () => undefined),
    pressKey: vi.fn(async () => undefined),
    ...overrides,
  };
}

function harness(driver: BrowserRefDriver = fakeDriver()) {
  const observe = vi.fn(async () => new Uint8Array([1, 2, 3]));
  const navigate = vi.fn(async () => undefined);
  const wait = vi.fn(async () => undefined);
  const execute = createBrowserToolsetExecutor({
    driver,
    observe,
    navigate,
    wait,
  });
  return { execute, driver, observe, navigate, wait };
}

describe("browser toolset executor", () => {
  it("answers screenshot with an image and nothing else", async () => {
    const { execute } = harness();
    const result = await execute({ name: "screenshot", input: {} });
    expect(result.content).toEqual([{ kind: "image", png: new Uint8Array([1, 2, 3]) }]);
    expect(result.isError).toBeUndefined();
  });

  it("answers tab members with browser state and nothing else", async () => {
    const { execute } = harness();
    const result = await execute({ name: "list_tabs", input: {} });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ kind: "browserState" });
  });

  it("clicks the element a ref names", async () => {
    const { execute, driver } = harness();
    const result = await execute({
      name: "left_click",
      input: { target: { type: "ref", ref: "ref_1" } },
    });
    expect(driver.pointer).toHaveBeenCalledWith("left_click", { type: "ref", ref: "ref_1" });
    expect(result.isError).toBeUndefined();
  });

  it("types a form value through the driver rather than assigning it", async () => {
    const { execute, driver } = harness();
    await execute({
      name: "form_input",
      input: { target: { type: "ref", ref: "ref_4" }, value: "example.com" },
    });
    expect(driver.formInput).toHaveBeenCalledWith("ref_4", "example.com");
  });

  /**
   * The whole point of the rewrite: the model makes recoverable mistakes, and none of them may end
   * a recording. Each of these used to be a thrown error somewhere in the previous explorer.
   */
  it.each([
    [
      "a stale ref",
      { name: "left_click", input: { target: { type: "ref", ref: "ref_9" } } },
      fakeDriver({
        pointer: vi.fn(async () => {
          throw new StaleRefError("ref_9");
        }),
      }),
    ],
    ["a disabled member", { name: "javascript_exec", input: { text: "alert(1)" } }, fakeDriver()],
    ["an unknown member", { name: "teleport", input: {} }, fakeDriver()],
    ["a malformed target", { name: "left_click", input: {} }, fakeDriver()],
  ])("reports %s as an error result instead of throwing", async (_label, call, driver) => {
    const { execute } = harness(driver);
    const result = await execute(call as { name: string; input: Record<string, unknown> });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ kind: "text" });
  });

  it("tells the model how to recover from a stale ref", async () => {
    const { execute } = harness(
      fakeDriver({
        pointer: vi.fn(async () => {
          throw new StaleRefError("ref_9");
        }),
      }),
    );
    const result = await execute({
      name: "left_click",
      input: { target: { type: "ref", ref: "ref_9" } },
    });
    const [block] = result.content;
    expect(block).toMatchObject({ kind: "text" });
    expect(block && "text" in block ? block.text : "").toContain("Re-read the page");
  });

  it("never runs a disabled member", async () => {
    const driver = fakeDriver();
    const { execute } = harness(driver);
    for (const name of ["javascript_exec", "read_console", "read_network", "file_upload"]) {
      expect((await execute({ name, input: {} })).isError).toBe(true);
    }
    expect(driver.pointer).not.toHaveBeenCalled();
    expect(driver.readPage).not.toHaveBeenCalled();
  });

  it("rejects a malformed scroll instead of guessing a coordinate", async () => {
    const { execute, driver } = harness();
    const result = await execute({
      name: "scroll",
      input: { scroll_direction: "down", scroll_amount: 3 },
    });
    expect(result.isError).toBe(true);
    expect(driver.scrollBy).not.toHaveBeenCalled();
  });

  it("reports the resulting URL after navigating", async () => {
    const { execute, navigate } = harness();
    const result = await execute({
      name: "navigate",
      input: { url: "https://app.acme.example/onboarding" },
    });
    expect(navigate).toHaveBeenCalledWith("https://app.acme.example/onboarding");
    expect(result.content.some((block) => block.kind === "browserState")).toBe(true);
  });
});
