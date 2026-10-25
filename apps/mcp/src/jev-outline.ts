import type { JevPage, JevElement, JevScrollArea } from "./jev.js";
const outlineLine = /^\s*\[(ref_\d+)\] (\S+)(.*)$/;
const locationPrefixes = ["visible at", "offscreen", "obscured", "hidden-by-ancestor"];

/**
 * Reads the `read_page` outline back into elements.
 *
 * A line is `role "name" state… value="…" options=[…] in "scope" — location`, with every string
 * JSON-quoted, so it is read left to right as tokens: a quote can never end a name early or shift the
 * fields after it. Controls hidden by an ancestor are dropped; nothing can act on them.
 */
export function parseOutline(outline: string): Pick<JevPage, "elements" | "scrollAreas"> {
  const lines = outline.split("\n");
  const elements: JevElement[] = [];
  for (const line of lines) {
    const match = outlineLine.exec(line);
    if (!match) continue;
    const [, ref, role] = match as unknown as [string, string, string];
    let rest = match[3] ?? "";
    let location = "";
    const separator = rest.lastIndexOf(" — ");
    if (separator >= 0) {
      const suffix = rest.slice(separator + 3);
      if (locationPrefixes.some((prefix) => suffix.startsWith(prefix))) {
        location = suffix;
        rest = rest.slice(0, separator);
      }
    }
    if (location.startsWith("hidden-by-ancestor")) continue;
    const fields = readFields(rest);
    if (!fields) continue;
    elements.push({
      ref,
      role,
      name: fields.name ?? "",
      ...(fields.states.length ? { states: fields.states } : {}),
      ...(fields.value !== undefined ? { value: fields.value } : {}),
      ...(fields.options ? { options: fields.options } : {}),
      ...(fields.scope ? { scope: fields.scope } : {}),
      position: location.startsWith("offscreen")
        ? "offscreen"
        : location.startsWith("obscured")
          ? "obscured"
          : "visible",
    });
  }
  return { elements, scrollAreas: parseScrollAreas(lines[0] ?? "") };
}

type LineFields = {
  name?: string;
  states: string[];
  value?: string;
  options?: string[];
  scope?: string;
};

/** The fields between an element's role and its location, or null when the line is malformed. */
function readFields(rest: string): LineFields | null {
  const fields: LineFields = { states: [] };
  let at = 0;
  const json = (): unknown => {
    const end = jsonEnd(rest, at);
    if (end < 0) throw new SyntaxError("unterminated");
    const value = JSON.parse(rest.slice(at, end)) as unknown;
    at = end;
    return value;
  };
  try {
    while (at < rest.length) {
      if (rest[at] === " ") {
        at++;
        continue;
      }
      if (rest[at] === '"' && fields.name === undefined && !fields.states.length) {
        fields.name = String(json());
      } else if (rest.startsWith('value="', at)) {
        at += "value=".length;
        fields.value = String(json());
      } else if (rest.startsWith("options=[", at)) {
        at += "options=".length;
        const options = json();
        if (Array.isArray(options)) fields.options = options.map(String);
      } else if (rest.startsWith('in "', at)) {
        at += "in ".length;
        fields.scope = String(json());
      } else {
        const next = rest.indexOf(" ", at);
        const word = rest.slice(at, next < 0 ? rest.length : next);
        if (!/^[a-z]+$/.test(word)) return null;
        fields.states.push(word);
        at += word.length;
      }
    }
  } catch {
    return null;
  }
  return fields;
}

/** Where the JSON string or array starting at `start` ends, honouring escapes and nested strings. */
function jsonEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let at = start; at < text.length; at++) {
    const char = text[at];
    if (inString) {
      if (char === "\\") at++;
      else if (char === '"') {
        inString = false;
        if (depth === 0) return at + 1;
      }
    } else if (char === '"') inString = true;
    else if (char === "[") depth++;
    else if (char === "]" && --depth === 0) return at + 1;
  }
  return -1;
}

function parseScrollAreas(line: string): JevScrollArea[] {
  const start = line.indexOf("{");
  if (!line.startsWith("Scroll areas") || start < 0) return [];
  try {
    const parsed = JSON.parse(line.slice(start)) as {
      regions?: Array<{
        kind?: unknown;
        wheelAt?: { x?: unknown; y?: unknown };
        remainingPixels?: Record<string, unknown>;
      }>;
    };
    return (parsed.regions ?? []).flatMap((region) => {
      const x = Number(region.wheelAt?.x);
      const y = Number(region.wheelAt?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
      const remaining = (key: string) => Math.max(0, Number(region.remainingPixels?.[key]) || 0);
      return [
        {
          kind: region.kind === "page" ? ("page" as const) : ("panel" as const),
          wheelAt: { x, y },
          remaining: {
            up: remaining("up"),
            down: remaining("down"),
            left: remaining("left"),
            right: remaining("right"),
          },
        },
      ];
    });
  } catch {
    return [];
  }
}

