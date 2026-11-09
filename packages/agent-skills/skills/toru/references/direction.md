# Directing the recording

You are the director as well as the operator. Toru moves the cursor like a hand and places the camera; you decide where the viewer looks. These rules come from screencast practice and from measuring Toru demos. The catalogue behind them is `docs/gestos-humanos.md` in the Toru repository.

## What Toru already does

- The cursor travels in a curve and slows down before it lands. It sometimes corrects by a few pixels, and it rests a moment before every press. It hesitates longer over presses that commit something ("Create", "Send", "Activate").
- The camera arrives before the click, never during it. It does not zoom on clicks that only move a flow on ("Next", "Back", a link to the next page). Clicks inside one panel get one shot, and there are at most about four zooms a minute.
- Typing and the result are always framed.

So never add pauses, wiggles or extra moves to look human, and never click twice to "help" the camera.

## Gestures

Gestures show without pressing. Each one is in the video, and the camera frames it subtly.

| Tool | What the viewer sees | Use it for |
|---|---|---|
| `browser_point {ref}` | The cursor goes to the element and rests there about a second | One number, a status, a new item: "look here" |
| `browser_trace {ref, shape: "circle"}` | One loop around the element | The proof that the flow worked: a total, a card, a new row |
| `browser_trace {ref, shape: "underline"}` | A stroke under a line of text | A title, a sentence in a preview, a value in a sentence |
| `browser_sweep {ref, rows?}` | The cursor runs down the first rows of a list or table (1–5, default 4) | Showing that there are several results and what they hold |
| `browser_highlight {ref, text?}` | The cursor presses at the first word and drags to the last, leaving the passage selected | The exact words that matter: a sentence in a preview, a value, a name |
| `browser_read {amount?}` | Smooth scrolling in steps, pausing to read | A long page that should be seen, not jumped |
| `browser_move {x, y}` | The cursor leaves the content | After the final emphasis, so nothing covers the result |

Data is rarely clickable, so the outline often has no ref for a number or a cell: pass `x, y` (CSS pixels, as for `browser_click`) instead of `ref`. A sweep named by a link inside a table row sweeps that table from the row down, and a gesture on something scrolled out of view scrolls back to it first.

In a plan, write these steps as the actions `point`, `trace` (the `value` is `circle` or `underline`), `sweep`, `highlight` (the `value` is the exact passage) and `read`.

## Walkthrough or presentation

Read what the user asked for:

- **Walkthrough** (`"record the flow"`, a tutorial, a bug reproduction): follow the screens. At most one gesture, on the result.
- **Presentation** (`"show"`, `"demonstrate"`, `"present"` a feature, a launch or sales video): demonstrate it as a person would. Set `intent: "presentation"` in the plan, and for each content screen write what the viewer should notice and why, as attention steps: point at the number that changed, highlight the sentence that explains it, sweep the results, circle the proof. Two or three per content screen, none on transition screens. Toru refuses a presentation plan with no attention steps (`plan_needs_attention`).

## Rules

1. **Gestures follow the intent.** A walkthrough: one, on the result. A presentation: two or three per content screen. Never more: a cursor that never rests becomes the new defect.
2. **No gestures on transition screens.** On a wizard step with "Next", a tab, a menu or a loading screen, click and move on.
3. **Before the result, emphasize the proof** (circle the total, sweep the new rows). Then `mark_demo_moment` kind `result`, `browser_move` away from it, and hold.
4. **Gestures go on data and results only.** Never circle a button label, a menu item or a field name, and never shake or spin the cursor without a target.
5. **Zoom is for reading.** Toru zooms for typing, small elements and the result. Do not try to force more zooms.
6. **A screen that stays still for more than about 10 seconds needs a change.** Point or sweep, rather than waiting on an unchanged picture.
7. **Keep within the recording limit.** In a long flow, emphasize only the result.
8. **Tidy the screen first, as setup.** A sidebar listing private pages, a cookie banner or a promo card is closed before the flow, and each such click is followed by `mark_demo_moment` kind `setup` so the camera skips it. Then move the cursor off the control you clicked, or its tooltip stays on screen.
9. **Re-read the screen after anything that changes the layout.** Closing a sidebar, opening a panel or scrolling renumbers the refs; a stale ref fails and costs seconds of still video. When a card or row has properties, click its title text, not its middle.
10. **After a highlight in an editor, leave by the side away from its toolbar.** Notion, Google Docs and similar editors open a formatting toolbar under a selection, and a cursor that crosses it opens its menus on camera. Move up or to the empty margin, never across the toolbar.

## Example: a wizard that creates a saved search

| Screen | Direction |
|---|---|
| Catalogue | `browser_click` the card being chosen |
| Filters | `browser_click` the filter, `browser_point` the counter that changes, `browser_click` "Next" |
| Audience | `browser_click` the option, `browser_click` "Next" (transition: no gesture) |
| Preview | `browser_sweep` 4 rows of the preview table, `browser_click` "Next" |
| Cost | `browser_trace` underline on "up to 110 credits a day", `browser_click` "Next" |
| Result | `browser_trace` circle on the created item, `mark_demo_moment` result, `browser_move` away, hold |

## The delivery check

A directed video is held for review (`needs_review`, no credit used) in four cases:

- the frames are blank or static, or the video is too short;
- `camera_late`: the camera was still moving when a click landed;
- `zoom_pumping`: the camera came out for less than two seconds and went back in, or zoomed more than four times in a minute;
- `capture_stalled`: Chrome stopped drawing the recording window while the flow went on, so part of it is missing or frozen in the video. Held when an action (a click, typing, a gesture, a scroll, a key) ran while Toru for Chrome found the page hidden, when typing or a highlight falls in a stretch of more than 2 seconds without a new captured frame, or when a click is followed by 5 seconds without one.

Camera holds come from Toru's own editing, not from your gestures. Report them plainly, and re-record only if the user wants to.

### A hidden recording window

Chrome does not draw a window that is minimized, fully covered by another app, or on another desktop or workspace (a window manager such as AeroSpace hides the windows of other workspaces). Nothing done there reaches the video: typed text never appears, a closing dialog stays frozen mid-fade, the cursor sticks. Toru cannot make Chrome draw it, so it says so:

- every `browser_*` reply, and `recording_run_status` while you drive, carries `warning.code: "recording_window_hidden"` while the window is not drawn;
- while recording, Toru for Chrome refuses page actions (click, type, key, select, scroll, navigate, gestures) with the error `recording_window_hidden` instead of performing them unseen. Nothing ran: ask the user to bring the Toru window into view, `browser_observe` again, then repeat the action;
- a warning with `actionMissed: true` means the action already ran while the window was not drawn: it is missing from the video and the take will be held as `capture_stalled`. Once the window is visible, end the run with `recording_run_finish` outcome `"stuck"` and record again.

Before a long recording, tell the user to keep the Toru window visible until it closes.
