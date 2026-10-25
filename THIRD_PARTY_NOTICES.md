# Third-party components — initial inventory

This is the source-workspace inventory. The prepared standalone distribution now includes a dependency SBOM, license texts, corresponding sources and checksums; see docs/launch/open-source-review.md for evidence and remaining release gates. Original notices remain authoritative; none of these components is relicensed by the Recorder's MIT files.

| Component | Version/source inspected | License evidence | Release requirement to verify |
| --- | --- | --- | --- |
| OpenScreen | revision f57e36e25448b5af6c7b1b271066fe5beb9b8a49 | [vendored MIT license](vendor/openscreen/LICENSE), Copyright 2025 Siddharth Vaddem | Preserve notice and provenance; inspect artwork separately. |
| Mediabunny | installed 1.40.1 | installed package metadata/LICENSE: MPL-2.0 | Preserve license/notices and supply source availability for the distributed covered version, including any changes. |
| web-demuxer | installed 4.0.0 | installed LICENSE/README: MIT main codebase; FFmpeg-derived lib under LGPL | Verify exact source/build/options/license corresponding to the vendored WASM; do not label the entire runtime MIT. |
| motion | installed 12.38.0 | package metadata: MIT | Include upstream notice in bundled distribution. |
| pixi.js | installed 8.18.1 | package metadata: MIT | Include upstream notice in bundled distribution. |
| pixi-filters | installed 6.1.5 | package metadata: MIT | Include upstream notice in bundled distribution. |
| zod | installed 4.4.3 | package metadata: MIT | Include upstream notice in bundled distribution. |
| MCP SDK | installed 1.30.0 | package metadata: MIT | Include upstream notice in bundled distribution. |
| IBM Plex Sans | Google Fonts v23, Regular and Medium, bundled in Toru for Mac | [SIL OFL 1.1](apps/macos/Resources/Fonts/OFL.txt), Copyright 2017 IBM Corp., Reserved Font Name "Plex" | Ship OFL.txt with the fonts; never sell the fonts alone or rename a modified copy "Plex". |

The installed web-demuxer package has no `license` field; its LICENSE and README must be inspected instead of assuming absence of a license. The source currently copied by the render build is `vendor/openscreen/public/wasm/web-demuxer.wasm`. Its SHA256 was compared directly and matches the installed npm 4.0.0 binary; the distribution includes upstream source at 91721712b063bd65ac5963aa4e03e7eda4b17eff and its pinned FFmpeg source.

The vendored OpenScreen public tree contains optional artwork/cursor packs. Production build config excludes those packs, but publishing the entire source tree would still distribute them. Exclude unused artwork from the public artifact unless rights are established. Review the generated native cursor assets too; code used to obtain an image does not itself establish redistribution rights to that image.

Before a source/container/npm release, generate the complete transitive dependency inventory from the lockfile, preserve corresponding license texts, review the runtime's Chromium/FFmpeg/system packages and assemble the matching source/notices obligations. Check what is actually in the final archive/image, not just package.json declarations.

References: [Mediabunny upstream](https://github.com/Vanilagy/mediabunny), [Mozilla MPL FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/), [web-demuxer upstream](https://github.com/ForeverSc/web-demuxer). This inventory records engineering release checks; it does not replace review of the applicable licenses for the exact distributed binaries.
