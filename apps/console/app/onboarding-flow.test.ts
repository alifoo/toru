import { describe, expect, it } from "vitest";
import { CLIENTS, PATH_STEPS, nextStep, parsePath, parseStep, previousStep } from "./onboarding-flow";
describe("onboarding", () => {
  it("reads the step and path from the URL and starts by asking how to record", () => {
    expect(parseStep("?step=login")).toBe("path");
    expect(parseStep("?step=prompt&from=demos")).toBe("prompt");
    expect(parseStep("?path=mac&step=mac")).toBe("mac");
    expect(parseStep("?step=nope")).toBe("path");
    expect(parseStep("")).toBe("path");
    expect(parsePath("?path=chrome&step=chrome")).toBe("chrome");
    expect(parsePath("?path=linux")).toBeUndefined();
  });
  it("walks each path through its own setup step and never the other's", () => {
    expect(PATH_STEPS.chrome).not.toContain("mac");
    expect(PATH_STEPS.mac).not.toContain("chrome");
    expect(nextStep("chrome", "connect")).toBe("chrome");
    expect(nextStep("chrome", "chrome")).toBe("brand");
    expect(nextStep("mac", "connect")).toBe("mac");
    expect(nextStep("mac", "mac")).toBe("prompt");
    expect(previousStep("mac", "prompt")).toBe("mac");
    expect(previousStep("chrome", "connect")).toBe("path");
    expect(nextStep("mac", "chrome")).toBe("connect");
  });
  it("never sends people to the local companion", () => {
    expect(JSON.stringify(CLIENTS).toLowerCase()).not.toContain("companion");
  });
});
