# Licensing

All first-party Toru code in this repository is MIT licensed: the recorder and MCP server (`apps/mcp`), the render
worker, the browser, render-contract and render-host packages, the console (`apps/console`), the hosted service
(`apps/hosted`, `packages/hosted-policy`), Toru for Chrome (`apps/extension`) and Toru for Mac (`apps/macos`). See
[LICENSE](LICENSE); each package carries the same text.

Third-party code keeps its own license, even where it is bundled with these packages: OpenScreen in
`vendor/openscreen` (MIT), Mediabunny (MPL-2.0), web-demuxer and its FFmpeg runtime (MIT and LGPL). See
[provenance](PROVENANCE.md) and [third-party notices](THIRD_PARTY_NOTICES.md). The MIT grant does not relicense them.

The license covers the code, not the name. "Toru", the lens mark and the toru.tools domains are not licensed; see
[TRADEMARKS.md](TRADEMARKS.md).

Running Toru yourself needs no subscription. Navigation by Jev calls TypeSafe's hosted model with your own key and at
your own cost; Toru does not resell provider access.
