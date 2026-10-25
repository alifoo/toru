# Recording engine provenance

Extracted from ContentLayer at commit ec9d6c0 on 2026-09-15, including the user's uncommitted browser schema changes. The original workspace and its history are preserved. Package names retain the original internal scope during extraction; workspace links resolve inside this independent repository.

OpenScreen is vendored at revision f57e36e25448b5af6c7b1b271066fe5beb9b8a49 from https://github.com/siddharthvaddem/openscreen. Its MIT license remains in vendor/openscreen/LICENSE. The exporter is bundled unchanged. Built-in pilot backgrounds use CSS gradients; uploaded media remains private to its owner.

This repository does not contain the ContentLayer original model-provider stack, retry investigator, database, account credentials or user recordings.

## Cooperative navigation

`apps/mcp/src/jev.ts` and `jev-outline.ts` derive from ContentLayer's
`packages/ai/src/jev.ts` and `apps/browser-worker/src/jev-explorer.ts` at `dfdf358`.
The extracted core keeps the typed TypeSafe decisions and outline parsing. It removes
ContentLayer's database-budget and writing-model adapters. Recorder's navigation
controller supplies field values from the client agent and owns session limits.

## System cursor reader

`packages/render-host/native/SystemCursorAssets.swift` is original Toru code (rewritten 22/10/2026; it previously
vendored a file from Recordly). It ships no cursor images: it reads the cursor pictures of the Mac it runs on.

## License scope

Original Recorder code in the five engine package directories is licensed under the adjacent MIT LICENSE files. This does not relicense OpenScreen, Mediabunny, the web-demuxer/FFmpeg runtime, assets, or other third-party code. See LICENSING.md and THIRD_PARTY_NOTICES.md. The public distribution must preserve the source provenance above.
