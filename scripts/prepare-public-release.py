#!/usr/bin/env python3
"""Stage a standalone public engine tree. Never copies history, env or cloud console."""
from pathlib import Path
import argparse, hashlib, json, shutil, subprocess, urllib.request

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
parser.add_argument('--source-cache', help='Directory with the pinned third-party source archives for offline preparation')
parser.add_argument('--release-lockfile', help='Previously validated standalone lockfile; a frozen install must still verify it')
args = parser.parse_args()
out = Path(args.output).resolve()
source_cache = Path(args.source_cache).resolve() if args.source_cache else None
if out.exists(): raise SystemExit('Output must not exist; refusing to overwrite a release tree')
if out == root or root in out.parents: raise SystemExit('Use an output outside the private workspace')
out.mkdir(parents=True)
excluded = {'node_modules', 'dist', 'dist-web', '.git', '.vercel', '.gitnexus', '__pycache__'}

def copy_file(src, target):
    if src.is_symlink(): raise RuntimeError('Symlinks forbidden: ' + str(src.relative_to(root)))
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, target)

def copy_tree(relative, vendor=False):
    start = root / relative
    for src in sorted(start.rglob('*')):
        rel = src.relative_to(start)
        # This private acceptance client asserts hosted credits; the MIT engine does not.
        if relative == 'apps/mcp' and rel.as_posix() == 'src/smoke-product-fixture.mjs': continue
        if any(part in excluded or part.startswith('.env') for part in rel.parts): continue
        if not src.is_file(): continue
        if vendor and src.suffix not in {'.ts', '.tsx', '.json', '.css', '.svg'}: continue
        if src.name.endswith('.tsbuildinfo'): continue
        copy_file(src, out / relative / rel)

for directory in ['apps/mcp', 'apps/render-worker', 'packages/browser', 'packages/render-contract', 'packages/render-host']:
    copy_tree(directory)
copy_tree('vendor/openscreen/src', vendor=True)
for path in ['vendor/openscreen/LICENSE', 'vendor/openscreen/public/wasm/web-demuxer.wasm', 'tsconfig.base.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', '.dockerignore', 'scripts/smoke-local.mjs', 'scripts/smoke-navigation-recovery.mjs', 'scripts/smoke-browser-supervision.mjs']:
    copy_file(root / path, out / path)
(out / 'Dockerfile').write_text('''FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @agent-recorder/mcp... --filter @content-layer/render-worker... build
RUN rm -rf node_modules && CI=true pnpm install --prod --offline --frozen-lockfile
RUN rm -rf vendor/openscreen/public

FROM node:24.21.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3002 DATA_DIR=/data RENDER_BROWSER_BINARY=/usr/bin/chromium RENDER_BUNDLE_DIRECTORY=/app/apps/render-worker/dist-web
RUN apt-get update && apt-get install -y --no-install-recommends chromium chromium-driver ffmpeg dumb-init gosu util-linux ca-certificates && rm -rf /var/lib/apt/lists/* && corepack enable
RUN ffmpeg -hide_banner -encoders 2>/dev/null | grep -q ' libvpx-vp9 '
COPY --from=build /app /app
RUN chmod +x infra/start.sh
ENTRYPOINT ["dumb-init", "--", "/app/infra/start.sh"]
''')
(out / 'infra').mkdir(exist_ok=True)
(out / 'infra/start.sh').write_text('''#!/bin/sh
set -eu
mkdir -p "${DATA_DIR:-/data}"
chown -R node:node "${DATA_DIR:-/data}"
exec gosu node flock -n "${DATA_DIR:-/data}/.process-lock" node /app/apps/mcp/dist/index.js
''')
for name in ['README.md', 'CONTRIBUTING.md', 'SECURITY.md']:
    copy_file(root / 'scripts/public-release' / name, out / name)
copy_file(root / 'scripts/public-release/setup-local.mjs', out / 'scripts/setup-local.mjs')
copy_file(root / 'scripts/public-release/ci.yaml', out / '.github/workflows/ci.yaml')
copy_file(root / 'apps/mcp/LICENSE', out / 'LICENSE')
(out / '.gitignore').write_text('node_modules/\ndist/\ndist-web/\n.env*\n!.env.example\n.local-mcp.json\ndata/\nartifacts/\n*.tsbuildinfo\n')
(out / 'infra/start.sh').chmod(0o755)
manifest = json.loads((root / 'package.json').read_text())
manifest['license'] = 'MIT'
manifest['scripts']['test'] = 'pnpm -r --workspace-concurrency=1 test --maxWorkers=1'
# The private workspace also installs deployment tooling. Keep the standalone
# engine's root manifest independent of future hosted/infra dev dependencies.
public_dev_dependencies = {'@types/node', 'mediabunny', 'motion', 'pixi-filters',
                           'pixi.js', 'typescript', 'vitest', 'web-demuxer'}
manifest['devDependencies'] = {name: version for name, version in manifest['devDependencies'].items()
                               if name in public_dev_dependencies}
(out / 'package.json').write_text(json.dumps(manifest, indent=2) + '\n')
(out / 'PROVENANCE.md').write_text('''# Engine provenance

Extracted from ContentLayer at ec9d6c0; Jev integration from dfdf358. Original code is MIT in this distribution. OpenScreen renderer source originates at f57e36e25448b5af6c7b1b271066fe5beb9b8a49, under its preserved MIT license. Only source/SVG assets and decoder WASM are included; optional public artwork/cursor packs are excluded.

Source dependency pins and checksums are in third-party/sources.json. The web-demuxer WASM shipped here is byte-identical to npm web-demuxer 4.0.0. Its upstream source commit references FFmpeg e38092ef9395d7049f871ef4d5411eb410e283e0. The source archive and upstream build instructions are supplied alongside it, including LGPL notices. No OS cursor bitmaps or private repository history are included.
''')
third = out / 'third-party'; third.mkdir()
sources = [
 ('web-demuxer-4.0.0.tar.gz', 'https://codeload.github.com/ForeverSc/web-demuxer/tar.gz/91721712b063bd65ac5963aa4e03e7eda4b17eff', '06afd73d7e49df0d95b9dfe20e12ac842acad646a8cb0041215b36e4eaf0d5a4'),
 ('ffmpeg-e38092ef.tar.gz', 'https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/e38092ef9395d7049f871ef4d5411eb410e283e0', '7578feb5284b22e6172c6f4020ddc43d746eb3ca44363756d1b47a96fd2d68f5'),
 ('mediabunny-1.40.1.tgz', 'https://registry.npmjs.org/mediabunny/-/mediabunny-1.40.1.tgz', 'd7a57d7468e9dc38027e26b6a991baa764b816f806053f9e5ae028017391301d'),
]
records = []
for name, url, expected_sha256 in sources:
    target = third / name
    if source_cache:
        shutil.copyfile(source_cache / name, target)
    else:
        with urllib.request.urlopen(url, timeout=120) as response, target.open('wb') as f: shutil.copyfileobj(response, f)
    actual_sha256 = hashlib.sha256(target.read_bytes()).hexdigest()
    if actual_sha256 != expected_sha256: raise RuntimeError('Unreviewed source archive changed: ' + name)
    records.append({'name': name, 'source': url, 'sha256': actual_sha256})
wasm = out / 'vendor/openscreen/public/wasm/web-demuxer.wasm'
expected = 'f33a4d44f60dc2e6ca63b06063ae6de575b2b86cd45d92378e21bd8a01ff12d7'
if hashlib.sha256(wasm.read_bytes()).hexdigest() != expected: raise RuntimeError('Unreviewed WASM changed')
records.append({'name': 'web-demuxer.wasm', 'source': 'npm:web-demuxer@4.0.0', 'sha256': expected})
(third / 'sources.json').write_text(json.dumps(records, indent=2) + '\n')
(out / 'THIRD_PARTY_NOTICES.md').write_text('''# Third-party notices

Original Recorder code: MIT, see LICENSE. Third-party terms remain in force.

- OpenScreen: MIT, Copyright 2025 Siddharth Vaddem; see vendor/openscreen/LICENSE.
- Mediabunny 1.40.1: MPL-2.0. The full npm archive with src/ and LICENSE is supplied in third-party/. No Mediabunny source modifications are made.
- web-demuxer 4.0.0: main code MIT, Copyright 2024 ForeverSc. FFmpeg-derived lib/ is LGPL-2.1 as supplied upstream. Full source/build recipes and pinned FFmpeg source are in third-party/. Extract FFmpeg into web-demuxer/lib/FFmpeg to use the upstream Makefile; review its build options and toolchain instructions. This replaces the git submodule checkout; do not initialize a different revision. Decoder binary SHA256 is recorded in sources.json. Modifying/rebuilding the decoder for your own use is permitted under its applicable license; the engine does not enforce a proprietary binary signature.
- Additional package versions/licenses and preserved license files: third-party/packages.json and third-party/package-licenses/ (generated from installed dependencies during release validation).

No stock wallpapers, themed public cursor packs, extracted OS cursor images, cloud customer data or private history are part of this archive. SVG cursor source included under OpenScreen's MIT notice is separate from optional public/cursors artwork. Runtime container system packages retain Debian's copyright/license files under /usr/share/doc; retain these files when redistributing an image and satisfy the corresponding package obligations. This source release is not a prebuilt container image.
''')
if args.release_lockfile:
    shutil.copyfile(Path(args.release_lockfile).resolve(), out / 'pnpm-lock.yaml')
else:
    subprocess.run(['pnpm', 'install', '--lockfile-only', '--ignore-scripts'], cwd=out, check=True, stdout=subprocess.DEVNULL)
print(json.dumps({'tree': str(out), 'sourceArchives': len(sources), 'historyIncluded': False, 'consoleIncluded': False}))
