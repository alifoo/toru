import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  maximumPageReadCharacters,
  pageTextScript,
  readPageScript,
  refAttribute,
} from "./browser-toolset.js";

/**
 * The page reader against real Chrome, because unit tests only ever see its output stubbed.
 *
 * Opt-in like the other live test: `RUN_BROWSER_E2E=true WEBDRIVER_E2E_URL=<hub>`, for example the
 * compose grid at http://localhost:4444/wd/hub. Fixtures are data URLs, so the browser needs no route
 * back to this process.
 */
const hub = process.env.WEBDRIVER_E2E_URL;
const runLive = process.env.RUN_BROWSER_E2E === "true" && Boolean(hub);

const fixture = `<!doctype html><html><head><style>
  li { list-style: none; position: relative; height: 40px; }
  .toggle { position: absolute; left: 0; top: 0; width: 40px; height: 40px; opacity: 0; margin: 0; }
  .ghost { opacity: 0; width: 40px; height: 40px; }
</style></head><body>
  <label for="project">Project name</label><input id="project" required value="Acme">
  <label>Text input <input name="plain"></label>
  <span id="due-label">Due date</span><input aria-labelledby="due-label" readonly value="2026-10-01">
  <input type="email" aria-label="Work email" value="person@example.com">
  <label for="plan">Plan</label>
  <select id="plan"><option>Starter</option><option selected>Growth</option><option disabled>Legacy</option></select>
  <ul>
    <li><input class="toggle" type="checkbox" aria-label="Toggle Todo"><label>Buy milk</label></li>
    <li><input class="toggle" type="checkbox" aria-label="Toggle Todo" checked><label>Walk the dog</label></li>
  </ul>
  <div class="ghost" role="button" aria-label="Invisible action"></div>
  <button aria-expanded="false">Filters</button>
  <button aria-disabled="true">Archive</button>
  <button>Say "hi"</button>
  ${"<div>".repeat(25)}<button>Deep action</button>${"</div>".repeat(25)}
  <button id="titles-trigger" aria-controls="titles-region" aria-expanded="true">Job titles</button>
  <div role="region" id="titles-region" aria-labelledby="titles-trigger">
    <input role="combobox" aria-expanded="true" placeholder="Search and select">
  </div>
  <ul style="position: fixed; top: 10px; right: 10px; width: 160px; background: white; margin: 0;">
    <li><button>CEO</button></li><li><button>CFO</button></li>
  </ul>
</body></html>`;

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${hub}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await response.json()) as { value: unknown };
  if (!response.ok) throw new Error(JSON.stringify(json.value).slice(0, 300));
  return json.value;
}

describe.skipIf(!runLive)("read_page outline in live Chrome", () => {
  let session = "";
  let outline = "";

  beforeAll(async () => {
    const created = (await call("POST", "/session", {
      capabilities: { alwaysMatch: { browserName: "chrome" } },
    })) as { sessionId: string };
    session = created.sessionId;
    await call("POST", `/session/${session}/url`, {
      url: `data:text/html;charset=utf-8,${encodeURIComponent(fixture)}`,
    });
    const read = (await call("POST", `/session/${session}/execute/sync`, {
      script: readPageScript,
      args: ["interactive", 15, null, refAttribute, maximumPageReadCharacters],
    })) as { text: string };
    outline = read.text;
  }, 30_000);

  afterAll(async () => {
    if (session) await call("DELETE", `/session/${session}`).catch(() => undefined);
  });

  const line = (needle: string) => outline.split("\n").find((row) => row.includes(needle)) ?? "";

  it("names fields from their labels and shows their state and value", () => {
    expect(line('"Project name"')).toContain('input:text "Project name" required value="Acme"');
    expect(line('"Text input"')).toContain('input:text "Text input"');
    expect(line('"Due date"')).toContain('"Due date" readonly value="2026-10-01"');
  });

  it("keeps contact details out of the outline", () => {
    expect(line('"Work email"')).not.toContain("person@example.com");
  });

  it("lists a dropdown's selected value and its enabled options", () => {
    expect(line('select "Plan"')).toContain('value="Growth" options=["Starter","Growth"]');
  });

  it("lists transparent custom checkboxes with the row they belong to", () => {
    expect(line('in "Buy milk"')).toContain('input:checkbox "Toggle Todo" in "Buy milk"');
    expect(line('in "Walk the dog"')).toContain('"Toggle Todo" checked in "Walk the dog"');
    // Transparency still hides anything that is not a form control.
    expect(outline).not.toContain("Invisible action");
  });

  it("reports ARIA states and JSON-quotes names", () => {
    expect(line('"Filters"')).toContain('button "Filters" collapsed');
    expect(line('"Archive"')).toContain('button "Archive" disabled');
    expect(outline).toContain('button "Say \\"hi\\""');
  });

  it("names the section a control sits in and the field a floating list belongs to", () => {
    expect(line('"Search and select"')).toContain(
      'combobox "Search and select" expanded in "Job titles"',
    );
    // A dropdown portalled to <body> with no ARIA link still reads as that field's options.
    expect(line('button "CEO"')).toContain(
      'button "CEO" in "options for Search and select (Job titles)"',
    );
  });

  it("reaches controls nested far below the outline depth limit", () => {
    expect(line('"Deep action"')).toContain("visible at");
  });
});

// A spreadsheet built from divs, as many product grids are, next to a native table.
const tables = `<!doctype html><html><head><style>
  .grid > div { display: grid; grid-template-columns: 160px 160px 160px; }
  .grid > div > div { height: 32px; }
  .spin { display: inline-block; width: 12px; height: 12px; border: 2px solid; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style></head><body>
  <div class="grid">
    <div><div draggable="true">Full name</div><div draggable="true">Company domain</div><div draggable="true">Work email</div></div>
    <div data-row><div role="gridcell"><input value="Ada Lovelace" readonly></div><div role="gridcell">acme.com</div><div role="gridcell"></div></div>
    <div data-row><div role="gridcell"><input value="Alan Turing" readonly></div><div role="gridcell"></div><div role="gridcell"><span class="spin"></span> Preparing</div></div>
  </div>
  <table><thead><tr><th>Plan</th><th>Seats</th></tr></thead>
    <tbody><tr><td>Growth</td><td>12</td></tr><tr><td>Starter</td><td></td></tr></tbody></table>
</body></html>`;

describe.skipIf(!runLive)("page text table summary in live Chrome", () => {
  let session = "";
  let text = "";

  beforeAll(async () => {
    const created = (await call("POST", "/session", {
      capabilities: { alwaysMatch: { browserName: "chrome" } },
    })) as { sessionId: string };
    session = created.sessionId;
    await call("POST", `/session/${session}/url`, {
      url: `data:text/html;charset=utf-8,${encodeURIComponent(tables)}`,
    });
    text = (await call("POST", `/session/${session}/execute/sync`, {
      script: pageTextScript,
      args: [maximumPageReadCharacters],
    })) as string;
  }, 30_000);

  afterAll(async () => {
    if (session) await call("DELETE", `/session/${session}`).catch(() => undefined);
  });

  it("counts filled cells per column, so an empty column reads as empty", () => {
    expect(text).toContain(
      'Table of 2 rows, filled cells per column: "Full name" 2/2, "Company domain" 1/2, "Work email" 0/2 (1 loading)',
    );
    expect(text).toContain('Table of 2 rows, filled cells per column: "Plan" 2/2, "Seats" 1/2');
  });

  it("reports counts without cell values, ahead of the page text", () => {
    const summary = text.split("\n\n")[0] ?? "";
    expect(summary).not.toContain("Ada Lovelace");
    // A spinner's placeholder text is not a value; the page says it is still working.
    expect(text.startsWith("Loading indicators on screen: 1\nTable of")).toBe(true);
  });
});
