/**
 * The element-identity surface Claude's browser toolset drives.
 *
 * Deliberately a separate interface rather than more methods on `BrowserContextDriver`: that one is
 * implemented by every driver and fake in the codebase and impact analysis rates a change to it
 * CRITICAL. Nothing here needs to reach the recipe engine, so a narrow structural interface keeps
 * the blast radius at zero — `WebDriverContext` satisfies both, and the executor asks for this one.
 */

/** Which elements `read_page` reports. Omitted means the toolset's own default. */
export type PageReadFilter = "interactive" | "all";

export type RefTarget = { type: "ref"; ref: string };
export type CoordinateTarget = { type: "coordinate"; x: number; y: number };
export type BrowserTarget = RefTarget | CoordinateTarget;

/** Pointer members that resolve a target and press. `hover` and `move` stop before pressing. */
export type PointerKind =
  | "left_click"
  | "right_click"
  | "double_click"
  | "triple_click"
  | "hover"
  | "move";

export type ScrollDirection = "up" | "down" | "left" | "right";

/**
 * Pointer gestures that show without pressing (docs/gestos-humanos.md): rest on an element, circle or underline it,
 * or sweep down the rows of a list. Each is recorded as an `emphasis` moment the camera frames.
 */
export type GestureKind = "point" | "circle" | "underline" | "sweep";

export interface BrowserRefDriver {
  /** Geometry only: visible scroll containers and remaining space, never hidden cell values. */
  readScrollState?(): Promise<string>;
  /** Accessibility-ish outline with `[ref_N]` tags the model can address. */
  readPage(options?: { filter?: PageReadFilter; depth?: number; ref?: string }): Promise<string>;
  /** Up to 20 elements matching a natural-language query, tagged the same way. */
  findElements(query: string): Promise<string>;
  /** Visible page text, for reading rather than acting. */
  pageText(): Promise<string>;
  currentUrl(): Promise<string>;
  pointer(kind: PointerKind, target: BrowserTarget): Promise<void>;
  /** Optional: a driver without it (an older Toru for Chrome) is asked for a plain `move` instead. */
  gesture?(kind: GestureKind, target: BrowserTarget, options?: { rows?: number }): Promise<void>;
  /** Types into the element a ref names, so the recording shows text being entered. */
  formInput(ref: string, value: string | number | boolean): Promise<void>;
  scrollToRef(ref: string): Promise<void>;
  scrollBy(target: CoordinateTarget, direction: ScrollDirection, amount: number): Promise<void>;
  typeText(text: string): Promise<void>;
  pressKey(text: string, repeat?: number): Promise<void>;
}

/**
 * A stale ref is a normal event, not a failure.
 *
 * The page re-renders, the tag it carried goes with it, and the model's next move names something
 * that no longer exists. The documented recovery is to say so and let it re-read — the previous
 * approach's habit of throwing here is what turned an ordinary miss into a lost recording.
 */
export class StaleRefError extends Error {
  constructor(readonly ref: string) {
    super(
      `${ref} is stale or not found on the current page. Re-read the page to get fresh references.`,
    );
    this.name = "StaleRefError";
  }
}

/** Attribute the page reader stamps on tagged elements; resolution looks refs up by it. */
export const refAttribute = "data-content-layer-ref";

/** The toolset caps `read_page` output; matching it here keeps the model's view and ours in step. */
export const maximumPageReadCharacters = 50_000;

/** Layout metadata only; works for nested tables and virtualized grids without reading their data. */
export const scrollStateScript = `
const regions = [];
for (const el of document.querySelectorAll('*')) {
  const s = getComputedStyle(el);
  const horizontal = /auto|scroll/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 2;
  const vertical = /auto|scroll/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 2;
  const page = el === document.scrollingElement;
  if (!horizontal && !vertical && !page) continue;
  if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) continue;
  const r = page ? {left:0,top:0,right:innerWidth,bottom:innerHeight} : el.getBoundingClientRect();
  let left = Math.max(0,r.left), top = Math.max(0,r.top), right = Math.min(innerWidth,r.right), bottom = Math.min(innerHeight,r.bottom);
  for (let p = el.parentElement; p && !page; p = p.parentElement) {
    const ps = getComputedStyle(p), pr = p.getBoundingClientRect();
    if (/auto|scroll|hidden|clip/.test(ps.overflowX)) { left = Math.max(left,pr.left); right = Math.min(right,pr.right); }
    if (/auto|scroll|hidden|clip/.test(ps.overflowY)) { top = Math.max(top,pr.top); bottom = Math.min(bottom,pr.bottom); }
  }
  if (right-left < 20 || bottom-top < 20) continue;
  const x = Math.round((left+right)/2), y = Math.round((top+bottom)/2);
  const hit = document.elementFromPoint(x,y);
  if (!hit || !el.contains(hit)) continue;
  const maxX = Math.max(0,el.scrollWidth-el.clientWidth), maxY = Math.max(0,el.scrollHeight-el.clientHeight);
  const offsetX = Math.max(0,Math.min(maxX,s.direction === 'rtl' ? maxX+el.scrollLeft : el.scrollLeft));
  const offsetY = Math.max(0,Math.min(maxY,el.scrollTop));
  const remaining = {left: Math.round(offsetX), right: Math.round(maxX-offsetX), up: Math.round(offsetY), down: Math.round(maxY-offsetY)};
  if (!horizontal && !page) { remaining.left=0; remaining.right=0; }
  if (!vertical && !page) { remaining.up=0; remaining.down=0; }
  if (!Object.values(remaining).some(v=>v>2)) continue;
  regions.push({kind:page?'page':'panel', wheelAt:{x,y}, remainingPixels:remaining});
}
regions.sort((a,b)=>(b.remainingPixels.left+b.remainingPixels.right)-(a.remainingPixels.left+a.remainingPixels.right));
return JSON.stringify({coordinateSpace:'viewport CSS pixels',regions:regions.slice(0,12)});
`;

/**
 * Tags addressable elements and returns an indented outline.
 *
 * Runs as one injected script because a round trip per node would cost seconds on a page the size
 * of a dashboard. Each visible candidate gets a `ref_N` attribute and one line naming its role,
 * accessible name, states, current value and the row it belongs to — what a navigator that cannot
 * see the screen needs to choose a target. Page text is a separate member, so this stays an index
 * rather than a copy of the document. Strings are JSON-quoted so a name containing quotes cannot
 * run into the fields after it.
 *
 * Depth counts levels of this outline, not of the DOM: a control inside twenty wrapper divs is one
 * level below its nearest listed ancestor, instead of being cut off by wrappers nobody would list.
 */
export const readPageScript = `
const scrollState = (() => { ${scrollStateScript} })();
const filter = arguments[0], maxDepth = arguments[1], rootRef = arguments[2], attr = arguments[3], cap = arguments[4];
const interactiveSelector = 'a,button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=switch],[role=textbox],[role=searchbox],[role=spinbutton],[role=slider],[role=combobox],[role=treeitem],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
const formControl = 'input,select,textarea,[role=checkbox],[role=radio],[role=switch]';
const rowScope = 'th,[role=columnheader],[draggable=true],fieldset,li,[role=listitem],tr,[role=row],[role=region],[role=tabpanel],[role=dialog],dialog';
const root = rootRef ? document.querySelector('[' + attr + '="' + rootRef + '"]') : document.body;
if (!root) return { text: '', count: 0, missingRoot: Boolean(rootRef) };
for (const tagged of document.querySelectorAll('[' + attr + ']')) tagged.removeAttribute(attr);
const visible = (el) => {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const s = getComputedStyle(el);
  if (s.visibility === 'hidden' || s.display === 'none') return false;
  if (Number(s.opacity) !== 0) return true;
  // Custom checkboxes and switches draw their own box and leave the real control transparent on
  // top of it. It still takes the click, so it is listed when it is what the pointer would hit.
  if (!el.matches(formControl)) return false;
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return Boolean(hit && (hit === el || el.contains(hit)));
};
const textOf = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
// A wrapping label also contains its control; only the label's own words name it.
const labelText = (label) => {
  let text = '';
  const visit = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) text += ' ' + child.textContent;
      else if (child.nodeType === 1 && !child.matches('input,select,textarea,option,datalist,button')) visit(child);
    }
  };
  visit(label);
  return text.replace(/\\s+/g, ' ').trim();
};
const fieldTags = ['INPUT', 'SELECT', 'TEXTAREA'];
const nameOf = (el) => {
  const labelledBy = (el.getAttribute('aria-labelledby') || '').split(/\\s+/)
    .map((id) => (id ? document.getElementById(id) : null)).filter(Boolean).map(textOf).join(' ').trim();
  if (labelledBy) return labelledBy;
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();
  if (el.labels && el.labels.length) {
    const labelled = [...el.labels].map(labelText).filter(Boolean).join(' ');
    if (labelled) return labelled;
  }
  if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type)) return (el.value || '').trim();
  if (el.tagName === 'FIELDSET') {
    const legend = el.querySelector(':scope > legend');
    if (legend && textOf(legend)) return textOf(legend);
  }
  if (!fieldTags.includes(el.tagName)) {
    const text = textOf(el);
    if (text) return text;
  }
  const ph = el.getAttribute('placeholder');
  if (ph && ph.trim()) return ph.trim();
  const title = el.getAttribute('title');
  return title && title.trim() ? title.trim() : '';
};
const statesOf = (el) => {
  const states = [];
  if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') states.push('disabled');
  const checked = el.getAttribute('aria-checked');
  if (el.checked === true || checked === 'true') states.push('checked');
  else if (el.indeterminate === true || checked === 'mixed') states.push('mixed');
  const expanded = el.getAttribute('aria-expanded');
  if (expanded === 'true') states.push('expanded');
  else if (expanded === 'false') states.push('collapsed');
  if (el.getAttribute('aria-selected') === 'true') states.push('selected');
  if (el.getAttribute('aria-pressed') === 'true') states.push('pressed');
  if (el.required === true || el.getAttribute('aria-required') === 'true') states.push('required');
  if (el.getAttribute('aria-invalid') === 'true') states.push('invalid');
  if (el.readOnly === true || el.getAttribute('aria-readonly') === 'true') states.push('readonly');
  return states;
};
// Contact details are blurred on screen, so their values stay out of the outline too.
const privateField = (el) => /^(password|hidden|file|email|tel)$/.test(el.type) || /email|tel|cc-|password/.test(el.getAttribute('autocomplete') || '');
const valueOf = (el) => {
  if (el.tagName === 'SELECT') return [...el.selectedOptions].map((o) => o.label.trim()).join(', ');
  if (el.tagName === 'TEXTAREA') return el.value;
  if (el.tagName === 'INPUT') return /^(checkbox|radio|submit|button|reset|image)$/.test(el.type) || privateField(el) ? null : el.value;
  return el.getAttribute('aria-valuetext') || el.getAttribute('aria-valuenow');
};
const roleOf = (el) => {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'input') return 'input:' + (el.getAttribute('type') || 'text');
  return tag;
};
const locationOf = (el) => {
  const r = el.getBoundingClientRect();
  let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const s = getComputedStyle(p), pr = p.getBoundingClientRect();
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return 'hidden-by-ancestor';
    if (/auto|scroll|hidden|clip/.test(s.overflowX)) { left=Math.max(left,pr.left); right=Math.min(right,pr.right); }
    if (/auto|scroll|hidden|clip/.test(s.overflowY)) { top=Math.max(top,pr.top); bottom=Math.min(bottom,pr.bottom); }
  }
  const hidden = [r.right<=left?'left':'',r.left>=right?'right':'',r.bottom<=top?'above':'',r.top>=bottom?'below':''].filter(Boolean);
  if (hidden.length) return 'offscreen-' + hidden.join('-') + ' (scroll to reveal before clicking)';
  const x=Math.round((Math.max(left,r.left)+Math.min(right,r.right))/2), y=Math.round((Math.max(top,r.top)+Math.min(bottom,r.bottom))/2);
  const hit=document.elementFromPoint(x,y);
  if (!hit || !el.contains(hit)) return 'obscured (inspect before clicking)';
  return 'visible at (' + x + ',' + y + ') viewport CSS pixels';
};
// A list rendered in a floating layer (a portal at the end of <body>, or a fixed/absolute layer) is
// usually the dropdown of the field that is currently expanded, even when nothing in the markup says
// so. Naming that field on each option tells a navigator which control the options belong to.
const expandedField = [...document.querySelectorAll('[aria-expanded="true"]')]
  .find((el) => el.matches('input,textarea,[role=combobox],[role=searchbox],[role=textbox]') && visible(el));
const expandedFieldName = expandedField ? (() => {
  const own = nameOf(expandedField).slice(0, 80);
  const section = expandedField.closest(rowScope);
  const sectionName = section ? nameOf(section).slice(0, 60) : '';
  return sectionName && sectionName !== own ? own + ' (' + sectionName + ')' : own;
})() : '';
const floatingLayer = (el) => {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const role = p.getAttribute('role');
    if (role === 'listbox' || role === 'menu') return p;
    const position = getComputedStyle(p).position;
    if ((position === 'fixed' || position === 'absolute') && p.parentElement === document.body) return p;
    if (p.parentElement === document.body && p.matches('ul,ol')) return p;
  }
  return null;
};
const lines = [];
let index = 0, total = 0, truncated = false;
const walk = (el, depth) => {
  if (truncated || depth > maxDepth) return;
  for (const child of el.children) {
    if (truncated) return;
    if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE' || child.tagName === 'NOSCRIPT') continue;
    const wanted = filter === 'all' ? true : child.matches(interactiveSelector);
    const shown = wanted && visible(child);
    if (shown) {
      const ref = 'ref_' + ++index;
      child.setAttribute(attr, ref);
      const name = nameOf(child).slice(0, 200);
      const interactive = child.matches(interactiveSelector);
      const states = interactive ? statesOf(child) : [];
      const value = interactive ? valueOf(child) : null;
      const options = interactive && child.tagName === 'SELECT'
        ? [...child.options].filter((o) => !o.disabled).slice(0, 25).map((o) => o.label.trim().slice(0, 60))
        : [];
      // The row, list item, column or labelled section a control belongs to: which "Edit", which
      // checkbox, and which accordion section's search box (a region is named by its trigger).
      const scope = interactive ? child.closest(rowScope) : null;
      let scopeName = scope && scope !== child ? nameOf(scope).slice(0, 120) : '';
      if (interactive && (!scopeName || scopeName === name) && child !== expandedField && floatingLayer(child)) {
        scopeName = expandedFieldName ? 'options for ' + expandedFieldName : 'open list';
      }
      const line = '  '.repeat(Math.min(depth, 12)) + '[' + ref + '] ' + roleOf(child)
        + (name ? ' ' + JSON.stringify(name) : '')
        + states.map((state) => ' ' + state).join('')
        + (value ? ' value=' + JSON.stringify(String(value).slice(0, 120)) : '')
        + (options.length ? ' options=' + JSON.stringify(options) : '')
        + (scopeName && scopeName !== name ? ' in ' + JSON.stringify(scopeName) : '')
        + (interactive ? ' — ' + locationOf(child) : '');
      total += line.length + 1;
      if (total > cap) { truncated = true; return; }
      lines.push(line);
    }
    walk(child, shown ? depth + 1 : depth);
  }
};
walk(root, 0);
return { text: 'Scroll areas (layout only; offscreen content is not visual proof): ' + scrollState + '\\n' + lines.join('\\n'), count: index, truncated: truncated };
`;

/**
 * Ranks tagged elements against a natural-language query.
 *
 * Deliberately a plain token score rather than anything clever: `find` exists so the model can skip
 * reading a whole dashboard, and a wrong guess costs it one turn, not the run. Matching the
 * accessible name the model would have read anyway keeps the two members consistent.
 */
export const findElementsScript = `
const query = String(arguments[0] || '').toLowerCase(), attr = arguments[1], limit = arguments[2];
const tokens = query.split(/[^\\p{L}\\p{N}]+/u).filter((t) => t.length > 1);
const tagged = [...document.querySelectorAll('[' + attr + ']')];
const scored = [];
for (const el of tagged) {
  const haystack = ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || el.textContent || '') + ' ' + (el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('title') || '')).toLowerCase();
  if (!haystack.trim()) continue;
  let score = 0;
  if (haystack.includes(query)) score += 10;
  for (const token of tokens) if (haystack.includes(token)) score += 1;
  if (score > 0) scored.push({ ref: el.getAttribute(attr), score, label: haystack.replace(/\\s+/g, ' ').trim().slice(0, 160), role: el.getAttribute('role') || el.tagName.toLowerCase() });
}
scored.sort((a, b) => b.score - a.score);
return scored.slice(0, limit).map((m) => '[' + m.ref + '] ' + m.role + ' "' + m.label + '"').join('\\n');
`;

/**
 * Visible text, biased to the main content so a nav-heavy page does not drown the answer.
 *
 * Tables come first as a count of filled cells per column. An empty cell has no text, so in the
 * plain text a column nobody has filled yet reads the same as a filled one: its header is there and
 * nothing says the cells under it are blank. Rows are the parents of `td`/`gridcell`/`cell`
 * elements; a column is named by its header, found as `th`/`columnheader` or, for grids built from
 * plain divs, as the element just above the first row with the cell's left edge and width. Only
 * counts are reported, never cell values.
 *
 * A cell still loading ("Preparing…" beside a spinner) has text but no value yet, so it is counted
 * as loading, not filled. Loading is anything visible that says it is working: `aria-busy`, a
 * `progressbar`, or a small element spinning on an endless CSS animation. Their total leads the
 * text, so a reader waits for a result instead of taking the placeholder for it.
 */
export const pageTextScript = `
const cap = arguments[0];
const main = document.querySelector('main,[role=main],article') || document.body;
const text = (main.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
const filled = (cell) => Boolean((cell.innerText || '').trim()) ||
  [...cell.querySelectorAll('input,textarea,select')].some((field) => String(field.value || '').trim());
const inView = (box) => box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth;
const indicators = [];
for (const el of document.querySelectorAll('[aria-busy=true],[role=progressbar]')) {
  if (inView(el.getBoundingClientRect())) indicators.push(el);
}
for (const animation of document.getAnimations ? document.getAnimations() : []) {
  const effect = animation.effect;
  const target = effect && effect.target;
  if (!(target instanceof Element) || animation.playState !== 'running') continue;
  if (!effect.getComputedTiming || effect.getComputedTiming().iterations !== Infinity) continue;
  const box = target.getBoundingClientRect();
  // Spinners are small; an endless animation on a large area is decoration, such as a shimmer.
  if (!inView(box) || box.width > 64 || box.height > 64) continue;
  if (getComputedStyle(target).visibility === 'hidden' || Number(getComputedStyle(target).opacity) === 0) continue;
  if (!indicators.includes(target)) indicators.push(target);
}
const loading = (cell) => indicators.some((indicator) => cell.contains(indicator));
const groups = new Map();
for (const cell of document.querySelectorAll('td,[role=gridcell],[role=cell]')) {
  const row = cell.parentElement;
  const body = row && row.parentElement;
  if (!body) continue;
  if (!groups.has(body)) groups.set(body, new Map());
  const rows = groups.get(body);
  if (!rows.has(row)) rows.set(row, []);
  rows.get(row).push(cell);
}
const shown = (el) => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0; };
const summaries = [];
for (const [body, rowMap] of groups) {
  if (summaries.length >= 3) break;
  const rows = [...rowMap.values()].filter((cells) => cells.length >= 2 && shown(cells[0]));
  if (!rows.length) continue;
  const top = Math.min(...rows[0].map((cell) => cell.getBoundingClientRect().top));
  const scope = (body.parentElement && body.parentElement.parentElement) || body.parentElement || body;
  // Real header cells first, so they win where both align; any element may name a div grid's column.
  const pool = [...scope.querySelectorAll('th,[role=columnheader]')];
  if (scope.getElementsByTagName('*').length <= 5000) pool.push(...scope.querySelectorAll('*'));
  const headers = [];
  for (const el of pool) {
    if (el.closest('td,[role=gridcell],[role=cell]')) continue;
    const box = el.getBoundingClientRect();
    if (box.bottom > top + 2 || box.bottom < top - 150 || box.width <= 0) continue;
    const name = (el.innerText || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
    if (name && name.length <= 80) headers.push({ box, name });
  }
  const columns = [];
  rows[0].forEach((cell, index) => {
    const box = cell.getBoundingClientRect();
    const header = headers.find((h) => Math.abs(h.box.left - box.left) <= 4 && Math.abs(h.box.width - box.width) <= 8);
    if (!header) return;
    const busy = rows.filter((cells) => cells[index] && loading(cells[index])).length;
    const count = rows.filter((cells) => cells[index] && !loading(cells[index]) && filled(cells[index])).length;
    columns.push(JSON.stringify(header.name) + ' ' + count + '/' + rows.length + (busy ? ' (' + busy + ' loading)' : ''));
  });
  if (columns.length) summaries.push('Table of ' + rows.length + ' rows, filled cells per column: ' + columns.slice(0, 40).join(', '));
}
const lead = [...(indicators.length ? ['Loading indicators on screen: ' + indicators.length] : []), ...summaries].join('\\n');
return lead ? (lead + '\\n\\n' + text).slice(0, cap) : text.slice(0, cap);
`;

/**
 * One member call, and the result shape the toolset expects back.
 *
 * Kept free of Anthropic SDK types so this package does not take the dependency: the caller adapts
 * `tool_use` blocks into these and these back into `tool_result` blocks. It also means the executor
 * is testable without a model.
 */
export type ToolsetMemberCall = { name: string; input: Record<string, unknown> };

export type ToolsetResultContent =
  | { kind: "text"; text: string }
  | { kind: "image"; png: Uint8Array }
  | {
      kind: "browserState";
      tabs: Array<{ tabId: string; title: string; url: string; active: boolean }>;
    };

export type ToolsetMemberResult = { content: ToolsetResultContent[]; isError?: boolean };

/** Members the toolset ships disabled. Enabling `javascript_exec` would bypass every policy here. */
const disabledMembers = new Set(["file_upload", "read_console", "read_network", "javascript_exec"]);

function targetFrom(input: Record<string, unknown>, key = "target"): BrowserTarget {
  const raw = input[key];
  if (raw && typeof raw === "object") {
    const candidate = raw as Record<string, unknown>;
    if (candidate.type === "ref" && typeof candidate.ref === "string") {
      return { type: "ref", ref: candidate.ref };
    }
    if (candidate.type === "coordinate") {
      return { type: "coordinate", x: Number(candidate.x) || 0, y: Number(candidate.y) || 0 };
    }
  }
  throw new Error(`${key} must be a ref or coordinate target`);
}

function text(value: string): ToolsetMemberResult {
  return { content: [{ kind: "text", text: value }] };
}

export type BrowserToolsetExecutorOptions = {
  driver: BrowserRefDriver;
  /** Viewport PNG for `screenshot`; the caller supplies it so redaction stays its concern. */
  observe: () => Promise<Uint8Array>;
  navigate: (url: string) => Promise<void>;
  wait: (milliseconds: number) => Promise<void>;
};

/**
 * Runs one member call against the browser we own.
 *
 * Every failure returns `isError` rather than throwing: a refused action, a stale ref or an unknown
 * member are all things the model recovers from on its next turn, and the recording is worth more
 * than a strict loop. The caller decides what genuinely ends a run.
 */
export function createBrowserToolsetExecutor(options: BrowserToolsetExecutorOptions) {
  const { driver, observe, navigate, wait } = options;

  return async function execute(call: ToolsetMemberCall): Promise<ToolsetMemberResult> {
    const { name, input } = call;
    if (disabledMembers.has(name)) {
      return {
        content: [{ kind: "text", text: `${name} is disabled for this run.` }],
        isError: true,
      };
    }
    try {
      switch (name) {
        case "screenshot":
          return { content: [{ kind: "image", png: await observe() }] };
        case "navigate": {
          const url = String(input.url ?? "");
          await navigate(url);
          return {
            content: [
              { kind: "text", text: `Navigated to ${await driver.currentUrl()}.` },
              { kind: "browserState", tabs: await tabsNow(driver) },
            ],
          };
        }
        case "read_page":
          return text(
            await driver.readPage({
              ...(typeof input.filter === "string"
                ? { filter: input.filter as PageReadFilter }
                : {}),
              ...(typeof input.depth === "number" ? { depth: input.depth } : {}),
              ...(typeof input.ref === "string" ? { ref: input.ref } : {}),
            }),
          );
        case "find":
          return text(await driver.findElements(String(input.query ?? "")));
        case "get_page_text":
          return text(await driver.pageText());
        case "left_click":
        case "right_click":
        case "double_click":
        case "triple_click":
        case "hover": {
          const target = targetFrom(input);
          await driver.pointer(name as PointerKind, target);
          return text(
            `${name} on ${target.type === "ref" ? target.ref : `(${target.x}, ${target.y})`}.`,
          );
        }
        case "mouse_move":
          await driver.pointer("move", targetFrom(input));
          return text("Pointer moved.");
        case "scroll_to":
          await driver.scrollToRef(
            String((input.target as { ref?: string })?.ref ?? input.ref ?? ""),
          );
          return text("Scrolled the element into view.");
        case "scroll": {
          const target = targetFrom(input) as CoordinateTarget;
          await driver.scrollBy(
            target,
            (input.scroll_direction as ScrollDirection) ?? "down",
            Number(input.scroll_amount ?? 3),
          );
          return text(`Scrolled ${String(input.scroll_direction ?? "down")}.`);
        }
        case "type":
          await driver.typeText(String(input.text ?? ""));
          return text("Typed the text.");
        case "key":
          await driver.pressKey(String(input.text ?? ""), Number(input.repeat ?? 1));
          return text(`Pressed ${String(input.text ?? "")}.`);
        case "form_input": {
          const ref = String((input.target as { ref?: string })?.ref ?? "");
          await driver.formInput(ref, input.value as string | number | boolean);
          return text(`Set ${ref}.`);
        }
        case "wait": {
          const seconds = Math.min(30, Math.max(0, Number(input.duration ?? 1)));
          await wait(seconds * 1_000);
          return text(`Waited ${seconds}s.`);
        }
        case "list_tabs":
        case "new_tab":
        case "switch_tab":
        case "close_tab":
          // One browser, one tab: the inventory is honest and the model stops asking.
          return { content: [{ kind: "browserState", tabs: await tabsNow(driver) }] };
        default:
          return {
            content: [{ kind: "text", text: `${name} is not supported by this recorder.` }],
            isError: true,
          };
      }
    } catch (error) {
      return {
        content: [{ kind: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  };
}

async function tabsNow(
  driver: BrowserRefDriver,
): Promise<Array<{ tabId: string; title: string; url: string; active: boolean }>> {
  const url = await driver.currentUrl();
  return [{ tabId: "tab-1", title: "", url, active: true }];
}
