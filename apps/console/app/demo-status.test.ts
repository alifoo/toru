import { describe, expect, it } from "vitest";
import { clock, demoPrompt, domainOf, durationLabel, outcomeOf, relativeTime, stepLine, stopReason, targetLabel, trackFor, trackPosition, type DemoRun } from "./demo-status";

const run = (patch: Partial<DemoRun>): DemoRun => ({ runId: "r", status: "planning", startedAt: new Date().toISOString(), ...patch });

describe("demo status", () => {
  it("shows the live stage, with user waits and render progress", () => {
    expect(outcomeOf(run({ status: "navigating", active: true }))).toEqual({ tone: "live", label: "Navigating" });
    expect(outcomeOf(run({ status: "rendering", active: true, session: { progress: { percent: 40 } } }))).toEqual({ tone: "live", label: "Rendering", detail: "40%" });
    expect(outcomeOf(run({ status: "awaiting_code", active: true, waitingForUser: true })).tone).toBe("waiting");
    expect(outcomeOf(run({ status: "needs_input", active: true })).label).toBe("Waiting for you");
    expect(outcomeOf(run({ status: "agent_driving", active: true }))).toEqual({ tone: "live", label: "Navigating", detail: "Your agent is driving" });
    expect(outcomeOf(run({ status: "agent_driving", active: true, handoff: "blocked" })).detail).toBe("Your agent took over from Toru");
    expect(trackPosition("agent_driving")).toBe("navigating");
  });
  it("says a held video was not charged and why, and treats a later delivery as ready", () => {
    expect(outcomeOf(run({ status: "needs_review", qualityReasons: ["blank_frames", "too_short"] })))
      .toEqual({ tone: "review", label: "Needs review", detail: "Not charged · The screen stayed blank, The video was too short" });
    expect(outcomeOf(run({ status: "needs_review", session: { status: "completed", qualityReview: { accepted: true } } })))
      .toEqual({ tone: "ready", label: "Ready", detail: "Delivered after review" });
    expect(outcomeOf(run({ status: "done" })).tone).toBe("ready");
  });
  it("explains stops in plain words", () => {
    expect(outcomeOf(run({ status: "failed", reason: "navigation_exhausted" }))).toEqual({ tone: "stopped", label: "Didn't finish", detail: "Toru couldn't finish the flow" });
    expect(stopReason("navigation_agent_stuck")).toBe("Your agent couldn't finish the flow");
    expect(stopReason("session_open_failed:{\"x\":1}")).toBe("The browser session didn't open");
    expect(stopReason("something_new")).toBe("something new");
    expect(outcomeOf(run({ status: "canceled" })).label).toBe("Canceled");
  });
  it("only shows the sign-in step for hosted sign-ins", () => {
    expect(trackFor(run({ route: "local-browser" })).map(step => step.key)).toEqual(["planning", "navigating", "recording", "rendering"]);
    expect(trackFor(run({ route: "hosted-email-only" })).map(step => step.key)).toContain("connecting");
    expect(trackPosition("awaiting_code")).toBe("connecting");
    expect(trackPosition("done")).toBe("complete");
    expect(trackPosition("failed")).toBeUndefined();
  });
  it("formats domains, durations and times", () => {
    expect(domainOf("https://www.app.example.com/x")).toBe("app.example.com");
    expect(domainOf("nope")).toBeUndefined();
    expect(durationLabel(4200)).toBe("4s");
    expect(durationLabel(83000)).toBe("1m 23s");
    expect(relativeTime(new Date(Date.now() - 5 * 60000).toISOString())).toBe("5 min ago");
  });
  it("builds a prompt for Toru for Chrome or Toru for Mac, never Toru's own browser", () => {
    const chrome = demoPrompt({ url: "https://app.acme.com", flow: "create a project", route: "chrome" });
    expect(chrome).toContain("my own Chrome"); expect(chrome).toContain("extension_devices"); expect(chrome).toContain("exact button and field labels");
    const mac = demoPrompt({ url: "", flow: "make the title bold", route: "mac", app: "TextEdit" });
    expect(mac).toContain("Record a demo of TextEdit on my Mac"); expect(mac).toContain("desktop_recording_run"); expect(mac).not.toContain("app.example.com");
    for (const route of ["chrome", "mac"] as const) {
      const text = demoPrompt({ url: "", flow: "", route }).toLowerCase();
      expect(text).not.toContain("password"); expect(text).not.toContain("companion"); expect(text).not.toContain("local_browser");
      expect(text).not.toContain("usedemoaccount"); expect(text).not.toContain("loginemail");
    }
  });
});

describe("shot list", () => {
  it("reads a plan step the way the shot list shows it", () => {
    expect(targetLabel('button "Create invoice"')).toBe("Create invoice");
    expect(targetLabel("field Customer")).toBe("Customer");
    expect(stepLine({ action: "click", target: 'button "New issue"' })).toEqual({ verb: "Click", label: "New issue" });
    expect(stepLine({ action: "type", target: 'field "Title"', value: "Launch" })).toEqual({ verb: "Type “Launch” in", label: "Title" });
    expect(clock(0)).toBe("0:00"); expect(clock(65_400)).toBe("1:05");
  });
});
