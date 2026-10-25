# Agent Recorder

A recorded browser for your AI agent. The agent supplies intent and text; the server provides browser controls, optional Jev navigation, capture and MP4 rendering. Partial attempts can be exported. There is no automatic success judge blocking your recording.

## Local setup

Requirements: Node 24.21.0+, pnpm 10.33.0, FFmpeg, Chrome/Chromium and a matching ChromeDriver. macOS was tested with Chrome/ChromeDriver 154. Linux uses the Dockerfile's matched Chromium packages; run the integration checks on your host before accepting untrusted users.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
node scripts/setup-local.mjs
```

The setup creates `.env`, a private bootstrap `data/invites.json`, and `.local-mcp.json` containing the local MCP connection token. Do not commit or share these files. Set `CHROMEDRIVER_BINARY` and `RENDER_BROWSER_BINARY` in `.env` to your installed binaries, then start:

```sh
node --env-file=.env apps/mcp/dist/index.js
```

Configure a client supporting Streamable HTTP and a Bearer Authorization header using `.local-mcp.json`. The endpoint is `http://localhost:3002/mcp`. This is a local test configuration, not a public deployment configuration. Use HTTPS, correct PUBLIC_URL, persistent storage, sandboxed browser isolation, and an ingress policy for public hosting. No Clerk account or hosted subscription is needed.

For Claude Code, after starting the server, load the generated private configuration for this session:

```sh
claude --strict-mcp-config --mcp-config .local-mcp.json
```

Review and approve the Recorder connection/tools when Claude asks. This invocation uses only the supplied MCP configuration. Keep the token file private; never paste its contents into a prompt. See the [official Claude Code MCP guide](https://code.claude.com/docs/en/mcp). Transport health and revoked-token rejection were tested with Claude Code 2.1.283; a complete agent-driven recording in Claude still needs acceptance testing.

A session can visit public HTTPS sites; the egress proxy intentionally blocks private networks and localhost destinations. A local MCP server does not grant agents permission to operate your other accounts. Use demo accounts/data, approve required origins, and provide credentials through the secure connection flow, never through navigation text.

## Record a workflow

Ask your client agent to inspect only the context it needs, then use `session_open`, `recording_start`, browser tools, `recording_stop`, `recording_render`, `recording_status`, and `recording_links`. The first two calls return the session id to pass to subsequent operations.

Optional Jev: set `TYPESAFE_API_KEY` privately. Use `navigation_start` with a fresh requestId; poll `navigation_status`; answer a pending inputId using `navigation_guide`; use `navigation_stop` before manual takeover. Text is supplied by your client agent. No model key is needed for manual browser controls. Provider/model calls cost money and use your own account.

`navigation_start` returning done is not proof that the requested product outcome was achieved. Observe the page. Stop and export a partial attempt whenever useful. After render failure, retry the same capture; do not repeat product actions. A hard crash during capture can lose unfinalized material. Browser actions are never replayed automatically.

One browser or render runs at a time. Default limits: 20-minute session, 5-minute capture, 10-minute render, 24-hour artifact retention. Daily operational limits default to 60 browser minutes, 30 render minutes, 10 session starts per owner and 50 service-wide. Reservations survive restarts; unused time settles on graceful completion. Multiple tokens for one owner share quota. These are self-hosting safeguards, not hosted subscription plans.

## Verification

```sh
CHROMEDRIVER_BINARY=/path/to/chromedriver RENDER_BROWSER_BINARY=/path/to/chrome node scripts/smoke-local.mjs
RECOVERY_SMOKE=1 CHROMEDRIVER_BINARY=/path/to/chromedriver RENDER_BROWSER_BINARY=/path/to/chrome node scripts/smoke-local.mjs
RUN_RENDER_E2E=true RENDER_BROWSER_BINARY=/path/to/chrome pnpm --filter @content-layer/render-host test --maxWorkers=1
```

The smoke uses a temporary private data directory, a public Selenium demo form, real capture/render, and no model by default. NAVIGATION_SMOKE=1 additionally uses paid Jev calls; supply a key securely and a bounded JEV_MAX_USD.

## Licensing and provenance

Original engine/bootstrap code is MIT. OpenScreen, Mediabunny, web-demuxer and FFmpeg retain their own licenses; see `THIRD_PARTY_NOTICES.md`, `third-party/`, and `PROVENANCE.md`. The distribution includes corresponding source for the pinned decoder/FFmpeg and installed Mediabunny, plus package license notices. Third-party source archives are included for inspection/rebuilding; no stock wallpapers or optional themed cursor packs are shipped.

This source distribution excludes the hosted commercial console, customer data, billing and private history. Package names retain the original internal scope; all workspace dependencies resolve within this tree.

Storage uses `data/recorder.sqlite` after first startup. The bootstrap invite file is imported once and retired; issue/revoke subsequent tokens with `node apps/mcp/dist/invites.js create --owner <UUID> --data-dir data` (also supports revoke, list, pause and resume). Before upgrading an existing JSON installation, drain/stop the old process and take a volume backup with the encryption key saved separately. The new runtime backs up and migrates metadata/media, then refuses JSON-only rollback. Run one recorder process per volume. Never copy only the live SQLite main file without its WAL; use a consistent SQLite backup for metadata and a drained volume snapshot for media.

## Durable retries and preparation

Use a stable UUID requestId for retries of session creation, rendering and navigation. Reusing a navigation requestId with different arguments is rejected. After restart, active navigation returns interrupted without replaying browser actions; inspect recording_status and render surviving capture or explicitly start a new session. The Jev client records a conservative cost reservation before dispatch. Run `node scripts/smoke-navigation-recovery.mjs` after build to test recovery using SIGKILL and a simulated model, without a paid call.

Optionally call preparation_save with requestId, a compact summary, file references and scope `{project, revision, routes}`. Retrieve it with preparation_read and the current scope. Notes expire after 24 hours; a revision/project/route mismatch returns invalidated without the old summary. The client reports scope; the server does not verify Git. Never store secrets, personal data or source dumps. Read only enough code to prepare; there is no minimum file count.

For shared capacity, queue_enqueue v1 accepts session_open or recording_render with requestId and arguments. Poll queue_status by jobId; use queue_cancel to request cancellation. Jobs waiting in the queue do not start Chrome. Browser work is not replayed after worker failure.

Each account may have at most five active credentials and create twenty in a rolling 24-hour window. Revocation does not reset this issuance limit. Signed media links require an active grant and share the owner's bandwidth quota.

Browser processes use a POSIX supervisor (Linux/macOS): losing the recorder IPC connection terminates the browser process group, including ordinary descendants. Native Windows launch is rejected; use a Linux environment. This is lifecycle cleanup, not a filesystem or privilege sandbox. Run `node scripts/smoke-browser-supervision.mjs` after build for a no-network SIGKILL process-tree test. The real media recovery smoke also accepts `RECOVERY_SMOKE=1 RECOVERY_SIGNAL=SIGKILL`; use it only against the isolated temporary server created by `scripts/smoke-local.mjs`.
