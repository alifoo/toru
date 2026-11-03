import { describe, expect, it } from "vitest";
import { normalizePrivacyOptions, privacyRedactorScript, PrivacyOptionsSchema } from "./privacy-redactor.js";

describe("privacy redactor", () => {
  it("keeps domains and texts lower-cased and unique, and refuses what is not a domain", () => {
    expect(normalizePrivacyOptions(undefined)).toEqual({ keep: [], texts: [] });
    expect(normalizePrivacyOptions({ keepEmailDomains: ["UseNock.com", "usenock.com"], blurTexts: ["  Rafael   Paduan ", "rafael paduan"] }))
      .toEqual({ keep: ["usenock.com"], texts: ["rafael paduan"] });
    for (const bad of [{ keepEmailDomains: ["usenock"] }, { keepEmailDomains: ["@usenock.com"] }, { blurTexts: ["a"] }, { script: "x" }]) {
      expect(PrivacyOptionsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("is one statement that runs as a document-start script and as an execute body, with the options as data", () => {
    const script = privacyRedactorScript({ keepEmailDomains: ["usenock.com"], blurTexts: ["O'Brien   </script>"] });
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain('"keep":["usenock.com"]');
    // The person-name pattern compiles in the page as a Unicode regular expression.
    const word = /var WORD = (".*?");/.exec(script)?.[1];
    expect(new RegExp(`^${JSON.parse(word!)}$`, "u").test("Álvaro")).toBe(true);
  });
});
