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
| `browser_read {amount?}` | Smooth scrolling in steps, pausing to read | A long page that should be seen, not jumped |
| `browser_move {x, y}` | The cursor leaves the content | After the final emphasis, so nothing covers the result |

Data is rarely clickable, so the outline often has no ref for a number or a cell: pass `x, y` (CSS pixels, as for `browser_click`) instead of `ref`. A sweep named by a link inside a table row sweeps that table from the row down, and a gesture on something scrolled out of view scrolls back to it first.

In a plan, write these steps as the actions `point`, `trace` (the `value` is `circle` or `underline`), `sweep` and `read`.

## Rules

1. **One gesture per content screen** at most, two on the result screen. Too many gestures becomes the new defect.
2. **No gestures on transition screens.** On a wizard step with "Next", a tab, a menu or a loading screen, click and move on.
3. **Before the result, emphasize the proof** (circle the total, sweep the new rows). Then `mark_demo_moment` kind `result`, `browser_move` away from it, and hold.
4. **Gestures go on data and results only.** Never circle a button label, a menu item or a field name, and never shake or spin the cursor without a target.
5. **Zoom is for reading.** Toru zooms for typing, small elements and the result. Do not try to force more zooms.
6. **A screen that stays still for more than about 10 seconds needs a change.** Point or sweep, rather than waiting on an unchanged picture.
7. **Keep within the recording limit.** In a long flow, emphasize only the result.

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

A directed video is held for review (`needs_review`, no credit used) in three cases:

- the frames are blank or static, or the video is too short;
- `camera_late`: the camera was still moving when a click landed;
- `zoom_pumping`: the camera came out for less than two seconds and went back in, or zoomed more than four times in a minute.

Camera holds come from Toru's own editing, not from your gestures. Report them plainly, and re-record only if the user wants to.
