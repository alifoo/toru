import { describe, expect, it } from "vitest";
import {
  buildDemoRecipeDraft,
  buildDemoRecipeDrafts,
  credentialHandle,
} from "./demo-recipe.js";
import { assertRecipePolicy } from "./index.js";

const login = {
  loginUrl: "https://app.acme.example/login",
  emailCredentialId: "20000000-0000-4000-8000-000000000001",
  passwordCredentialId: "20000000-0000-4000-8000-000000000002",
};

const base = {
  productName: "Acme",
  productUrl: "https://app.acme.example/dashboard",
  tutorial: "Open Search, choose People, and use synthetic filters.",
  login,
  demoFlows: ["Find decision makers", "Enrich a company", "Export the sheet", "A fourth flow"],
};

function asRecipe(draft: ReturnType<typeof buildDemoRecipeDraft>) {
  return {
    ...draft,
    id: "10000000-0000-4000-8000-000000000001",
    workspaceId: "10000000-0000-4000-8000-000000000002",
    version: 1,
  };
}

describe("generated demo recipe", () => {
  it("passes the same policy gate a hand-authored recipe must pass", () => {
    const draft = buildDemoRecipeDraft(base);
    expect(() => assertRecipePolicy(asRecipe(draft))).not.toThrow();
    expect(draft.output.video).toBe(true);
    expect(draft.allowedOrigins).toEqual(["https://app.acme.example"]);
    expect(draft.viewport).toEqual({ width: 1920, height: 1080 });
  });

  it("records exactly one recording window around the demo flows", () => {
    const steps = buildDemoRecipeDraft(base).steps;
    const start = steps.findIndex((step) => step.type === "startRecording");
    const stop = steps.findIndex((step) => step.type === "stopRecording");

    expect(steps.filter((step) => step.type === "startRecording")).toHaveLength(1);
    expect(steps.filter((step) => step.type === "stopRecording")).toHaveLength(1);
    expect(start).toBeLessThan(stop);
    // Login happens before recording starts, so no credential field is ever on camera.
    expect(steps.findIndex((step) => step.type === "fill")).toBeLessThan(start);
  });

  it("references credentials only by handle and passes capped goals to visual exploration", () => {
    const draft = buildDemoRecipeDraft(base);
    const fills = draft.steps.filter((step) => step.type === "fill");
    const clicks = draft.steps.filter((step) => step.type === "click");
    const explore = draft.steps.find((step) => step.type === "explore");

    // The worker resolves `credential:<id>` against the encrypted store. A friendly name would
    // resolve to nothing and the fill step would be refused at execution time.
    expect(fills.map((step) => step.valueHandle)).toEqual([
      credentialHandle(login.emailCredentialId),
      credentialHandle(login.passwordCredentialId),
    ]);
    expect(clicks).toHaveLength(0);
    expect(explore).toMatchObject({
      goals: ["Find decision makers", "Enrich a company", "Export the sheet"],
      tutorial: "Open Search, choose People, and use synthetic filters.",
    });
  });

  it("waits for the signed-in app before recording, so a challenge page is not the demo", () => {
    const steps = buildDemoRecipeDraft({ ...base, login: { ...login, flow: "two_step" } }).steps;
    const start = steps.findIndex((step) => step.type === "startRecording");
    const signedIn = steps.filter(
      (step) => step.type === "waitFor" && step.locator.value === "signed_in",
    );
    expect(signedIn.length).toBeGreaterThanOrEqual(2);
    expect(
      steps.findIndex((step) => step.type === "waitFor" && step.locator.value === "signed_in"),
    ).toBeLessThan(start);
    expect(steps[start - 1]).toMatchObject({
      type: "waitFor",
      locator: { strategy: "field", value: "signed_in" },
    });
  });

  it("opens the app origin instead of forcing the hosted sign-in path", () => {
    const destinations = buildDemoRecipeDraft(base).steps.flatMap((step) =>
      step.type === "goto" ? [step.url] : [],
    );
    expect(destinations[0]).toBe("https://app.acme.example");
    expect(destinations).not.toContain("https://app.acme.example/login");
  });

  it("records the signed-in app instead of the marketing site", () => {
    const draft = buildDemoRecipeDraft({
      ...base,
      productUrl: "https://acme.example/",
    });
    const destinations = draft.steps.flatMap((step) => (step.type === "goto" ? [step.url] : []));
    expect(destinations.at(-1)).toBe("https://app.acme.example");
    expect(destinations).not.toContain("https://acme.example/");
  });

  it("keeps the product's own sign-in host for session hydrate", () => {
    const draft = buildDemoRecipeDraft({
      ...base,
      login: { ...login, resourceOrigins: ["https://clerk.acme.example"] },
    });
    expect(draft.allowedOrigins).toContain("https://clerk.acme.example");
  });

  it("locates login fields by purpose, not by localized label text", () => {
    const draft = buildDemoRecipeDraft(base);
    const locators = draft.steps.flatMap((step) => ("locator" in step ? [step.locator] : []));

    // A recipe that matched "Email" or "Password" as visible text would never find Clerk's pt-BR
    // form, which renders "Endereço de e-mail" and "Senha".
    expect(locators.some((locator) => locator.strategy === "label")).toBe(false);
    expect(locators.filter((locator) => locator.strategy === "field").length).toBeGreaterThan(0);
    expect(locators.map((locator) => locator.value)).toContain("email");
    expect(locators.map((locator) => locator.value)).toContain("password");
  });

  it("submits between the two screens of a hosted provider, and only then", () => {
    const single = buildDemoRecipeDraft(base).steps;
    const twoStep = buildDemoRecipeDraft({
      ...base,
      login: { ...login, flow: "two_step" },
    }).steps;

    const submitsBeforePassword = (steps: typeof single) => {
      const password = steps.findIndex(
        (step) => step.type === "fill" && step.locator.value === "password",
      );
      return steps
        .slice(0, password)
        .filter((step) => step.type === "click" && step.locator.value === "submit").length;
    };

    expect(submitsBeforePassword(single)).toBe(0);
    expect(submitsBeforePassword(twoStep)).toBe(1);
    expect(
      twoStep.filter((step) => step.type === "click" && step.locator.value === "submit"),
    ).toHaveLength(1);
    expect(() => assertRecipePolicy(asRecipe(buildDemoRecipeDraft(base)))).not.toThrow();
  });

  it("records the product without signing in when no login was stored", () => {
    const { login: _login, ...withoutLogin } = base;
    const draft = buildDemoRecipeDraft(withoutLogin);
    expect(() => assertRecipePolicy(asRecipe(draft))).not.toThrow();
    expect(draft.steps.some((step) => step.type === "fill")).toBe(false);
    expect(draft.steps.some((step) => step.type === "startRecording")).toBe(true);
  });

  it("still produces a usable recording when the product suggested no flows", () => {
    const draft = buildDemoRecipeDraft({ ...base, demoFlows: [] });
    expect(() => assertRecipePolicy(asRecipe(draft))).not.toThrow();
    expect(draft.steps.find((step) => step.type === "explore")).toMatchObject({
      goals: ["Discover and demonstrate the main value of Acme"],
    });
  });

  it("refuses a product that is not reachable over https", () => {
    expect(() => buildDemoRecipeDraft({ ...base, productUrl: "http://insecure.test" })).toThrow();
  });
});

describe("one recipe per flow", () => {
  const product = { productName: "acme", productUrl: "https://acme.example/" };

  it("records each flow separately, each stopping at its own win", () => {
    const drafts = buildDemoRecipeDrafts({
      ...product,
      flows: [
        { label: "Buscar pessoas", win: "A tabela Resultados mostra linhas" },
        { label: "Enriquecer uma planilha", win: "As colunas aparecem preenchidas" },
      ],
    });

    expect(drafts).toHaveLength(2);
    for (const [index, draft] of drafts.entries()) {
      const explore = draft.steps.find((step) => step.type === "explore");
      // One goal each: a single run given every goal spends its budget on the first and lands on none.
      expect(explore?.goals).toHaveLength(1);
      expect(explore?.win).toBe(
        index === 0 ? "A tabela Resultados mostra linhas" : "As colunas aparecem preenchidas",
      );
    }
    expect(new Set(drafts.map((draft) => draft.name)).size).toBe(2);
  });

  it("still records something when there is no plan", () => {
    const drafts = buildDemoRecipeDrafts({ ...product, flows: [] });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.steps.find((step) => step.type === "explore")?.goals).toHaveLength(1);
  });

  it("keeps each recipe within the policy a hand-authored one must pass", () => {
    const drafts = buildDemoRecipeDrafts({
      ...product,
      flows: [{ label: "Buscar pessoas", win: "Resultados mostra linhas" }],
    });
    for (const draft of drafts) {
      expect(draft.redactSensitiveText).toBe(true);
      expect(draft.allowedOrigins).toContain("https://acme.example");
    }
  });
});
