# Toru Mac capture preview

A native SwiftUI app for macOS 15+ (the build script currently targets Apple Silicon). No browser extension, local Node, ChromeDriver, ffmpeg or Accessibility permission is required by the app. ScreenCaptureKit captures a selected window/display and writes an H.264 MP4 with the native cursor (see Recording size and window presets). Audio is not implemented.

## Build and test

```sh
apps/macos/build.sh
pnpm --filter @agent-recorder/mcp build
node scripts/smoke-macos.mjs
```

Jev operating a window (no clicks; needs a terminal with Accessibility and Screen Recording and a TextEdit window
titled `toru-test.rtf`):

```sh
TORU_BUNDLE_ID=tools.toru.mac.dev apps/macos/build.sh
defaults write tools.toru.mac.dev allowControl -bool true
TYPESAFE_API_KEY=… node scripts/smoke-macos-control.mjs
```

`apps/macos/Tools/ax` (`swiftc … -o build/toru-ax`) prints what Toru reads from a window (`toru-ax outline <id>`)
and runs single actions (`toru-ax act <id> click ref_3`).

The test starts a local MCP service with the existing real render engine, creates a temporary account/token and launches Toru with its pairing code. It makes no paid model calls. In Toru:

1. Open the built-in demo window.
2. Click Refresh. Allow Toru in macOS Screen & System Audio Recording if requested, then reopen/refresh.
3. Choose **Toru — Toru Capture Demo**, approve capture/upload, and click **Share selected source**.
4. The MCP test records 15 seconds. Click Create demo item in the synthetic window.
5. The test stops capture, uploads it, renders through Toru, downloads the video and preview, and checks the MP4 decodes. Output: `/tmp/toru-macos-proof.mp4`.

For a regular agent session, connect it to the updated MCP service. Call `desktop_recording_pair`, show the server URL and pairing code, then wait for user consent in the Mac app. After `local_browser_status` is ready, call `desktop_recording_open({connectionId, requestId})`, then the existing `recording_start`, `recording_stop`, `recording_render`, `recording_status`, and `recording_links` tools.

## Recording size and window presets

Captures are recorded at the screen's own density (2 on a Retina screen) up to 2560x1440, the size Toru for Chrome records at, with even dimensions. A shared window on screen is recorded with a 200-point margin around it (for menus), so a window that nearly fills its screen records the whole display height: a 1710x1112-point Retina display records 2214x1440. ScreenCaptureKit frames go through AVAssetWriter with Chrome's bitrate ladder (6 Mbps at 1440p, 4 Mbps at 1080p, ~2.8 Mbps at 720p, scaled by pixel count), so five minutes stay inside the 256 MiB upload limit. Above 1080p only a hardware H.264 encoder is used; a Mac that cannot encode the largest size records the next one down (up to 1920x1080, then 1280x720). `defaults write tools.toru.mac.dev captureMaxWidth -int 1920` simulates such a Mac in a development build.

The desktop tools take an optional `windowSize` (`1280x720`, `1440x900`, `1920x1080`; default `1920x1080`, in points), sent to the app as `windowSize` in the `startRecording` arguments. When the user lets their agent operate the shared window (and Accessibility is granted), the app resizes the window before recording: to the preset when it fits the visible frame of the window's screen, otherwise to the largest size with the same aspect ratio that does, moving it only as far as needed to stay on that screen. After the recording it puts the window back at its original size and position, also on cancel, failure, disconnect and Quit. Displays are never resized. With control off, for a display, or when the window refuses a new size (fixed-size or full-screen windows, or a tiling window manager that keeps its layout), it records as is. Every command result during the recording carries `desktopWindow` in its metadata: `requested`, the window's `width`/`height` in points, `resized`, a `reason` (`control_off`, `display`, `not_resizable`, `fitted_to_screen`, `app_limited`) and, after Stop, `restored`. The server shows it in `recording_status` and the run status, and keeps the size in the capture's observation. Apps before 0.4.2 ignore `windowSize` and report nothing; servers that send no `windowSize` get no resize.

Focused checks (no screen permission):

```sh
swiftc -parse-as-library apps/macos/Sources/CaptureGeometry.swift apps/macos/Tests/CaptureGeometryTests.swift -o /tmp/toru-geometry-tests && /tmp/toru-geometry-tests
swiftc -parse-as-library apps/macos/Sources/WindowSizing.swift apps/macos/Tests/WindowSizingTests.swift -o /tmp/toru-window-tests && /tmp/toru-window-tests
```

## Boundaries

- Desktop mode is opt-in. Browser recording defaults are unchanged.
- This is capture only. Browser actions, credential export, and navigation are unavailable in desktop mode. The user or a separately authorized computer-control agent performs the flow.
- The app explicitly requires consent to capture/upload; there is no automatic redaction. Finish login before sharing. Prefer an individual window, not the entire display.
- Stop sharing or quit to stop capture/control. Local files remain under `~/Movies/Toru`, including captures whose upload fails. Commands are never automatically replayed after a disconnect.
- Pairing lasts five minutes, the connection thirty minutes, and a recording at most five minutes. Upload limit is 256 MiB. Captures are at most 2560x1440.
- Local capture includes the real cursor. Synthetic cursor tracking and automatic zooms are not implemented for this preview.
- Development build is ad-hoc signed, not notarized or ready for public distribution. No production deployment is required for the local smoke test.

## Local recovery

Each new capture has a stable UUID and an atomic JSON manifest beside its MP4 in `~/Movies/Toru`. The app lists recent local captures after relaunch. Interrupted encoders are marked **Interrupted — check file**; Toru does not claim that a force-quit MP4 is playable. Interrupted uploads retain the local file and return to **Saved**, without automatically uploading again. For captures journaled by this version, **Retry upload** resumes an existing file after relaunch and backend restart, using the original device/account. It does not start screen capture. Retry is available while disconnected from a live recording, with the original pairing and an unexpired backend job/upload. Older journals without a server/device binding remain accessible in Finder.

Closing the studio window keeps the app available in the menu bar. **Stop sharing** and **Quit Toru** stop capture and preserve the local result when finalization succeeds. Upload reads from disk instead of buffering the whole video. Completed media duration is propagated to the renderer so network time is excluded.

Focused journal checks (no screen permission or app replacement):

```sh
swiftc -parse-as-library apps/macos/Sources/CaptureJournal.swift apps/macos/Sources/CaptureGeometry.swift apps/macos/Tests/CaptureJournalTests.swift -o /tmp/toru-journal-tests
/tmp/toru-journal-tests
```

## Persistent Mac pairing

The current source uses durable device credentials with the updated MCP backend. The one-time pairing code registers the Mac; credentials stay in macOS Keychain, scoped to the server. After restarting either side, select a source and click **Share selected source** again. The app rotates the refresh credential and requests fresh capture approval. The agent can discover the saved connection with `desktop_devices` and use `desktop_recording_open`; it should not mint another pairing code for an already paired Mac.

**Stop sharing** ends the recording lease while keeping the saved identity. **Disconnect Mac** revokes the device and removes its Keychain entry. If remote revocation fails, the app reports that separately; use `desktop_device_disconnect` from an authorized MCP client to revoke the old device. A lost refresh response may require pairing again. While connected, the app rotates its access credential before expiry and the backend keeps the lease alive while the Mac polls; an expired or revoked credential still stops the lease safely and asks you to pair again.

The persistence protocol is verified with handler-level restart/consent/revocation tests. Keychain calls are typechecked; signed-app runtime and external-client checks remain part of the release gate.

Desktop `recording_stop` returns `stopping` while finalization/upload continues. Follow `recording_status` until `captured` before requesting `recording_render`. A repeated Stop observes the same finalization. MP4 input is now stored as MP4 on the backend, and native capture does not reserve hosted-browser compute. Resumable transfer and publication into an interrupted job are implemented.

Uploads now use bounded chunks with durable server offsets and SHA-256 verification. Transport retries reuse the capture ID and accepted bytes. The finalized local journal supplies dimensions and duration in the upload manifest; the backend persists them in schema 13 and rejects changed metadata on retry. Deploy the updated app with this backend: new upload requests require the `media` manifest. Existing uploads keep their bytes/offsets and can receive missing metadata from the same authorized device with a matching checksum. Recovered uploads publish into their original jobs; retrying render reserves available credit after abandonment and charges once on first delivery. An exhausted balance blocks rendering while preserving the capture. Credential revocation and expired upload grants still prevent cloud recovery; the local file remains accessible.


Recovery smoke on macOS (requires Swift, ffmpeg, Chrome and built workspace packages; no screen permission or installed app replacement):

```sh
pnpm --filter @agent-recorder/mcp build
pnpm --filter @agent-recorder/hosted-policy build
node scripts/smoke-macos-recovery.mjs
```

This uses the real Swift retry code, a disposable loopback backend, Keychain credentials scoped to that random port, a valid synthetic MP4 and the real renderer. It checks restart/resume, a lost publication response, retained local media and exactly one credit. Fixtures and test credentials are removed afterward. Signed-app and production acceptance remain separate.

## Recording safety stops

Recording stops by itself, keeping the local MP4 and clearing consent, when the recorded window closes or is minimized, the recorded display is unplugged, the Mac sleeps or locks, Screen Recording permission is revoked, free space in Movies/Toru drops below 150 MB (500 MB is required to start), or the agent session expires. Toru never switches to another window or display on its own; approve a new recording to continue. If an upload was interrupted, use **Retry upload** in the local recordings list.

Focused guard checks (no screen permission):

```sh
swiftc -parse-as-library apps/macos/Sources/CaptureGuards.swift apps/macos/Tests/CaptureGuardsTests.swift -framework ScreenCaptureKit -o /tmp/toru-guard-tests
/tmp/toru-guard-tests
```

## Recording without an agent

With a paired Mac and a selected source, **Record now** starts a capture that is admitted exactly like an agent session (same account, same credit reservation). **Stop and upload** finalizes, uploads and publishes it; your agent can then render it with `recording_render`, or it appears in the Toru library as captured. If the upload fails, the local file stays and **Retry upload** is available. Uploaded local copies are moved to the Trash after 30 days when the toggle in the local recordings list is on; saved or interrupted copies are never removed automatically.

## Setup links

The console (**Connect a Mac**) and `desktop_recording_pair` produce a `toru-mac://pair?server=…&code=…` link. Opening it in the installed app prefills the server and one-time code; it never starts sharing. Choose a source, approve recording and click **Share selected source** as usual. A Mac that is already paired with that server ignores the code. Paired Macs can be listed and disconnected from the console; disconnecting revokes the device and requires a new link.

## Updates

The app sends its version with every request. A backend configured with `DESKTOP_MIN_APP_VERSION` answers 426 to old apps; the app then shows “update required” and disables new recordings while Stop, upload and Retry upload keep working. Once a day, and after each recording, it reads `https://toru.tools/downloads/mac.json` and the server's `/local-browser/version` to show an **Update available** banner linking to the download page. Building with `TORU_SPARKLE_FRAMEWORK` and `TORU_SPARKLE_PUBLIC_KEY` embeds Sparkle for signed in-app updates from `https://toru.tools/downloads/appcast.xml`; Sparkle never checks or relaunches while a recording or upload is in progress. `scripts/publish-mac-release.mjs` stages a notarized archive, updates `mac.json` and writes the appcast (`--ed-signature` from Sparkle's `sign_update`). With `TORU_TAP_DIR` pointing at a clone of `github.com/alifoo/homebrew-toru` it also bumps the Homebrew cask. Users install with `curl -fsSL https://toru.tools/install.sh | bash` (served from `apps/console/public/install.sh`; it reads `mac.json`, checks the SHA-256 and installs without the quarantine flag, so an un-notarized beta opens without a security prompt) or `brew install --cask alifoo/toru/toru`.

## Development builds and permissions

Sign development builds with your Apple Development identity (`TORU_SIGN_IDENTITY="Apple Development: … (TEAMID)" ./build.sh`) and install to /Applications. Ad-hoc signatures change on every build, which makes the Screen & System Audio Recording pane hide the app and re-prompt. `tccutil reset ScreenCapture tools.toru.mac` clears stale rows. `/Applications/Toru.app/Contents/MacOS/Toru --check-permission` and `open -n /Applications/Toru.app --args --list-sources` (result in `/tmp/toru-list-sources.txt`) report what macOS grants to the exact app identity. Status changes are logged under `log stream --predicate 'subsystem == "tools.toru.mac"'`; the lines contain status text only.

`node scripts/smoke-macos-gate.mjs` runs the focused release gate against a disposable backend (window capture, second recording without re-pairing, display capture, window closed mid-recording → Retry upload); `MAC_GATE_SKIP=1,2` runs only the edge-case cycle.

## Layout

The app opens as a floating glass bar: account/agent state, the source to record, **Share** and **Record now**, then Library, Settings and Hide. The bar stays on top of other windows and is excluded from captures. The library window (⌘-click Library, or the menu bar icon → Open library) shows the preview and local recordings.

Library window — sidebar: account state, the list of windows and displays (auto-listed once Screen Recording is granted), the system picker and Settings (⌘,). Main pane: a still preview of the selected source, **Share <app> with my agent** (the click is the approval for one recording), **Record now**, the status line and the local recordings list (five per page). While recording, a floating bar with the timer and Stop stays on top and is excluded from captures; disable it in Settings → Recording.
