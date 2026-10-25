import { describe, expect, it } from "vitest";
import { parseRoute } from "./workspace-frame";
describe("workspace routes", () => {
  it("parses views, demo ids and old links", () => {
    expect(parseRoute("")).toEqual({ view: "demos" });
    expect(parseRoute("#brand")).toEqual({ view: "brand" });
    expect(parseRoute("#demo/22222222-2222-4222-8222-222222222222")).toEqual({ view: "demo", param: "22222222-2222-4222-8222-222222222222" });
    expect(parseRoute("#demo/not-an-id")).toEqual({ view: "demos" });
    expect(parseRoute("#connect")).toEqual({ view: "agents" });
    expect(parseRoute("#settings")).toEqual({ view: "plan" });
    expect(parseRoute("#activity")).toEqual({ view: "demos" });
    expect(parseRoute("#recordings")).toEqual({ view: "demos" });
    expect(parseRoute("#recording/11111111-1111-4111-8111-111111111111")).toEqual({ view: "recording", param: "11111111-1111-4111-8111-111111111111" });
    expect(parseRoute("#new")).toEqual({ view: "demos", redirect: "/onboarding?step=prompt&from=demos" });
    expect(parseRoute("#onboarding")).toEqual({ view: "demos", redirect: "/onboarding" });
    expect(parseRoute("", "?billing=success")).toEqual({ view: "plan" });
  });
});
