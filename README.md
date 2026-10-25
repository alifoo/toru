# Toru

**Recording infrastructure for your agent.** Your coding agent records your product demos itself: launch clips,
changelog GIFs, help-center guides and bug repros. Toru is its camera, editor and brand kit, and checks every take.

- Hosted: [toru.tools](https://toru.tools) (free tier, no card) · Docs: [toru.tools/docs](https://toru.tools/docs) ·
  For agents: [toru.tools/llms.txt](https://toru.tools/llms.txt)
- Works with Claude Code, Claude, Cursor, Codex and any remote MCP client.
- MIT licensed. See [LICENSING.md](LICENSING.md), [TRADEMARKS.md](TRADEMARKS.md) and
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## How it works

1. **Your agent plans the flow.** It reads your product's code (or the live UI) for the exact screens, labels and
   values, and writes a short plan that ends on a visible final state.
2. **Your agent records it.** `recording_run` opens the product in a window of its own, in your signed-in Chrome
   (Toru for Chrome) or on your Mac (Toru for Mac), starts recording and hands the window to the agent. The agent
   clicks and types with the `browser_*` tools, marks the result and calls `recording_run_finish`.
3. **Toru finishes the video.** It holds on the result, renders with your brand (background, logo, cards, cursor and
   zoom settings), checks the take (blank, frozen or too-short videos are held back) and returns an MP4 and a GIF.

Toru adds no model of its own: the agent you already use does the driving. Passwords never reach the agent or Toru;
the product is already signed in where it records.

## What is in this repository

| Path | What it is |
| --- | --- |
| `apps/mcp` | The recorder: the MCP server, sessions, capture, the run pipeline and the delivery check. |
| `apps/hosted` | The hosted service around the recorder: accounts, billing, render workers, backups. |
| `apps/console` | The web console and site: demos, connections, brand, billing, docs. |
| `apps/extension` | Toru for Chrome, the extension that records in the user's own Chrome. |
| `apps/macos` | Toru for Mac, the app that records (and, when allowed, lets the agent operate) a window. |
| `apps/render-worker`, `packages/render-*` | The renderer: camera, cursor, brand and export to MP4/GIF. |
| `packages/browser` | Browser control and page outlines for agents. |
| `packages/hosted-policy` | Plans, credits and billing rules of the hosted service. |
| `packages/agent-skills` | The Toru skill for Claude Code, Cursor and Codex ([alifoo/toru-skills](https://github.com/alifoo/toru-skills)). |
| `vendor/openscreen` | The vendored OpenScreen editor the renderer builds on (MIT). |

## Use the hosted service

Sign up at [toru.tools](https://toru.tools), then connect your agent to `https://mcp.toru.tools/mcp` (OAuth), or
install the plugin. In Claude Code:

```
/plugin marketplace add alifoo/toru-skills
/plugin install toru@toru-skills
```

Pair Toru for Chrome ([Chrome Web Store](https://toru.tools/chrome)) or Toru for Mac
(`curl -fsSL https://toru.tools/install.sh | bash`) from the link your agent sends you, then ask for a demo.

## Run it yourself

Self-hosting is free and needs no model key. It is young: billing-free defaults and a one-command `docker compose`
setup are in progress, so expect to read `.env.example`.

Requirements: Node 24.21+, pnpm 10.33, Chromium with a matching ChromeDriver, and FFmpeg.

```sh
pnpm install --frozen-lockfile
pnpm build
# Variables from .env.example in the process environment; the server does not read .env files.
export SESSION_ENCRYPTION_KEY="$(openssl rand -base64 32)"   # keep it: it encrypts stored sessions
pnpm start                                                   # the recorder (MCP server)
```

- Toru for Chrome against your server: `TORU_SERVER=https://your-server node apps/extension/build.mjs`, then load
  `apps/extension/dist` unpacked.
- Toru for Mac: `apps/macos/build.sh` (macOS 15+, Apple silicon); point it at your server in the pairing screen.
- The optional Toru navigator (a hosted model that drives instead of your agent) needs `TYPESAFE_API_KEY` and
  `DEFAULT_NAVIGATOR=toru`; by default the agent drives.

## Develop

```sh
pnpm typecheck
pnpm test
CHROMEDRIVER_BINARY=/path/to/chromedriver RENDER_BROWSER_BINARY=/path/to/chromium node scripts/smoke-local.mjs
```

`scripts/smoke-local.mjs` runs a real MCP → browser → MP4 → download round trip without any model.

## Contributing and security

Contributions are welcome under the DCO: see [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as
described in [SECURITY.md](SECURITY.md).
