---
name: toru
description: Use Toru to record a polished demo video of a product flow. Use it when the user asks for a demo, walkthrough, feature video, bug reproduction video or GIF of a web app (recorded in the user's own Chrome with Toru for Chrome) or of an app on their Mac (Toru for Mac). Also use it to check a recording, render or re-render it, fetch the MP4 link, or manage paired Chrome browsers and Macs.
last-updated: 2026-10-27
---

# Toru

Toru is recording infrastructure for you, the agent. You investigate the product, write the plan and drive the flow; Toru records it in the user's own Chrome or Mac app, adds cursor motion and zooms, applies the user's brand and checks the MP4 before delivery. Toru never needs product passwords in chat.

> **Freshness check**: if more than 30 days have passed since `last-updated`, tell the user this skill may be outdated and point them to the update table.

## Keeping this skill updated

**Source**: [github.com/alifoo/toru-skills](https://github.com/alifoo/toru-skills)

| Installation | How to update |
| --- | --- |
| Claude Code plugin | `/plugin marketplace update toru-skills` then `/plugin update toru@toru-skills` |
| Codex plugin | `codex plugin marketplace upgrade toru-skills`, then update the installed Toru plugin |
| Cursor plugin | Update the installed Toru plugin, or replace `~/.cursor/plugins/local/toru` and reload |
| `npx skills` | `npx skills update` |
| Manual | Pull the repo and re-copy `skills/toru/` into your skill directory |

## Runtime

Toru works only through its MCP server (`https://mcp.toru.tools/mcp`, OAuth). If the `toru` tools are not available in this session, tell the user to connect Toru (plugin above, or add the URL as a remote MCP connector and sign in) and stop. Do not invent another path.

Connecting Toru authorizes **Toru**, not the user's product. Toru records where the user is already signed in: their own Chrome (Toru for Chrome) or their Mac (Toru for Mac). Toru never handles product passwords.

## Step 0: write the plan (required)

`recording_run` and `desktop_recording_run` refuse calls without a `plan` (`plan_required`, nothing recorded, no credit used). The plan is the script Toru follows, so it decides whether the video shows the right flow. You usually have the product's source: use it.

1. **Investigate.** If you can read this product's code, trace the flow: route → component → the exact strings it renders (button text, field labels, placeholders, menu items, i18n strings) → the data each step needs → what the screen shows afterwards. Check required inputs, permissions, feature flags, existing data, empty and loading states. Without code, inspect the live UI. Never read `.env` files or secrets.
2. **Write one step per visible action**, with the exact label the user sees. No step may depend on a guess.
3. **Send it** as `plan`:

```json
{
  "preconditions": ["An invoice for Acme Inc. exists in Draft"],
  "steps": [
    { "screen": "Invoices list (/invoices)", "action": "click", "target": "button \"New invoice\"", "expect": "The \"New invoice\" dialog opens" },
    { "screen": "New invoice dialog", "action": "type", "target": "field \"Customer\"", "value": "Acme Inc.", "expect": "Acme Inc. is suggested and selected" },
    { "screen": "New invoice dialog", "action": "click", "target": "button \"Create\"", "expect": "The invoice detail page opens in Draft" }
  ],
  "finalState": "The invoice detail page shows Acme Inc. with status \"Draft\"",
  "avoid": ["Do not delete or archive existing invoices"],
  "sources": ["src/routes/invoices/new.tsx:42"]
}
```

- `action`: `click | type | select | press | scroll | wait | navigate`, plus the gestures `point | trace | sweep | read` (see direction.md). `value` is what to type, the option to pick, the key to press, the path to open, or a trace's shape (`circle`, `underline`).
- A field typed several times (three tasks into the same input) keeps its values in order.
- `finalState` is what must be visible at the end; the video ends there.
- Give the user a short plain-language summary of the plan, not a source dump.

## Where Toru records: only two places

Toru records in the user's own Chrome or on their Mac, both already signed in as the user. There is no other browser: never launch, install or suggest a separate Chrome, a Chrome profile, a headless or cloud browser for Toru, and never ask for passwords or codes. If the product shows a sign-in screen, ask the user to sign in in their Chrome (or the app) and reply done, then record.

1. **Web apps: Toru for Chrome.** `extension_devices` first.
   - A Chrome is `ready`: call `recording_run` with `localConnectionId` set to its `connectionId`. Toru opens the product in a window of its own there and records it while you drive; the user does not click anything.
   - The `url` can be a public `https://` site or a local development server on the user's machine: `http` or `https` on `localhost`, `127.0.0.1`, `[::1]`, `*.localhost` or `*.test`, any port. Start the dev server first. The recording stays on that origin; other private addresses (`10.x`, `192.168.x`, `.internal`) are refused.
   - Empty list: `extension_pair`. Send the user to `installUrl` (https://toru.tools/chrome) if the extension is missing, then give them `connectUrl` to open in that Chrome. End the turn and wait for "connected".
   - `offline` means Chrome is closed or the extension is off: ask the user to open Chrome and end the turn.
2. **Mac apps: Toru for Mac.** `desktop_devices` first.
   - If a Mac is `ready` with `control: true`, pick the window with `desktop_sources` → `desktop_select_source`, then **one call**: `desktop_recording_run {connectionId, requestId, goal, plan, values?}`. You drive that window with the `browser_*` tools, in the background (the user keeps their mouse and keyboard), and Toru records it. Follow the run like a web run. Password fields stop the run: the user signs in beforehand.
   - If `control` is false, the recording is capture only: `desktop_recording_open` and the user (or your own computer-use tool) performs the flow. To let you operate it, the user turns on "Let your agent operate the shared window" in Toru for Mac Settings.
   - No Mac paired: `desktop_recording_pair`. If the app is missing, it installs with one Terminal command, `curl -fsSL https://toru.tools/install.sh | bash` (or `brew install --cask alifoo/toru/toru`): offer to run it yourself if you have a shell on the user's Mac, otherwise give it to them to paste. No security prompt, no password. Then hand them the setup link. End the turn.

## Core workflow

1. Confirm the target URL and the flow in one sentence with a clear visible end state. Ask at most 1–3 focused questions if it is vague. Never substitute a marketing-page tour for an in-app flow unless asked.
2. Write the plan (Step 0).
3. `recording_run {requestId, url, goal, plan, localConnectionId}` (or `desktop_recording_run` for a Mac). `url` is where step 1 starts; `localConnectionId` is the ready Chrome from `extension_devices`. Toru opens the page and starts recording.
4. `recording_run_status {runId}` answers `agent_driving` with `sessionId` and `finalState`: you drive.
   - Follow the plan one action at a time with `browser_click`, `browser_type`, `browser_key`, `browser_select`, `browser_scroll` and `browser_wait` on `sessionId`. Each reply shows the screen and the elements in view; `browser_observe` with `mode: "outline"` lists every element.
   - Every action is in the video: no exploratory clicks while recording.
   - Direct the viewer's eye: on the screen that proves the flow, emphasize the evidence with one gesture (`browser_point`, `browser_trace` with circle or underline, `browser_sweep`, `browser_read`) before marking the result. Never use a gesture on transition screens ("Next", tabs, menus). See [`references/direction.md`](references/direction.md).
   - When `finalState` is visible: `mark_demo_moment` kind `result` with that screenshot's `observationId`, then `recording_run_finish {runId, outcome: "reached"}`. Toru holds on the result, stops, renders with the brand and checks the take. If the flow cannot be completed: `outcome: "stuck"` (no credit used).
   - Never call `recording_render` on the run's session; the run renders. If your tool list has no `recording_run_finish` (a session started before it existed), `recording_stop` on `sessionId` finishes the run as reached. After 5 minutes without a call on the session the run stops.
5. Poll `recording_run_status {runId, waitMs: 25000}`:
   - `done`: `recording_links` with `sessionId`; give the MP4 and GIF links.
   - `needs_review`: the video failed the delivery check and no credit was used; fix the plan and run again, or `recording_render` with `acceptReview:true` if the user wants it anyway.
   - `failed`: a captured session can still be rendered manually.
6. Use a fresh UUID `requestId` per operation and reuse it after transport timeouts.

`navigator: "toru"` asks Toru's own navigator to drive instead, where the server offers it; it may then ask for a field value (`needs_input`, answer with `navigation_guide`) or hand you the running capture (`agent_driving` with `handoff`).

## Step-by-step path (only when each screen needs your judgement)

1. `session_open {url, localConnectionId, requestId}` on the intended in-app URL in the user's Chrome, then `recording_start`.
2. Drive one action at a time (`browser_observe`, `browser_click`, `browser_type`, `browser_key`, `browser_scroll`, `browser_move`, `browser_wait`, and the gestures `browser_point`, `browser_trace`, `browser_sweep`, `browser_read`). Inspect each returned screenshot before the next action.
3. Mark moments: `mark_demo_moment` with `setup` for unimportant interactions (no zoom), `action` for meaningful ones, and `result` when the requested outcome is visible, using the observationId of the first screenshot showing it. Hold on the result with `browser_wait` (about 4 s), move the cursor away from the evidence, then `recording_stop`.
4. `recording_render`, then `recording_status` until `completed` (it waits up to 25 s per call), then `recording_links`. The brand saved for the product domain applies automatically; only pass `background`, `padding`, `gif` or `width` for a one-off change.

On a capture-only Mac recording: `desktop_recording_open` → `recording_start` → the user performs the flow → `recording_stop` → wait for `captured` in `recording_status` → `recording_render` → `recording_links`. If the Mac stops by itself (window closed, sleep), the capture is kept; the user clicks **Retry upload** in Toru and you render afterwards.

## Rules

- Never ask for or paste product passwords or one-time codes in chat. The user signs in to their product in their own Chrome or app.
- Every run needs a plan written from the code or the live UI. Do not send a one-line goal alone.
- One recording per request unless the user asks for several; one flow per recording.
- Do not poll in tight loops: `recording_status` and `recording_run_status` already wait.
- Finish with the result visible, then stop. Verify the final screen before claiming success, and describe what actually happened.
- 1 credit = 1 delivered video that passed the delivery check. Videos held in `needs_review`, failed runs, re-renders and downloads never use a credit. When `creditsLow` is set, mention the remaining credits once when handing over the video and point to https://toru.tools/pricing. Never interrupt a flow to upsell.

## Goal-writing guidance

The goal is one sentence; the plan carries the detail.

Good: `Create a report named "Weekly Revenue" in the "Q2 Pipeline" workspace with the last-30-days filter, ending on the dashboard with the revenue chart visible.`

Weak: `Show the product.` / `Go through onboarding, settings, billing and analytics.`

## References

- [`references/tools.md`](references/tools.md): tool list by route, argument notes and the error codes you will see.
- [`references/direction.md`](references/direction.md): directing the recording, with the gestures, when to use them, and what the camera and the delivery check do.
