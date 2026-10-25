#!/usr/bin/env python3
"""Validate the source distribution boundary. This is not a secret/license audit."""
from pathlib import Path
import json

APPS={'mcp','render-worker'}
PACKAGES={'browser','render-contract','render-host'}
ROOT_FILES={'.dockerignore','.gitignore','CONTRIBUTING.md','Dockerfile','LICENSE','PROVENANCE.md','README.md','SECURITY.md','SHA256SUMS','THIRD_PARTY_NOTICES.md','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','sbom.cdx.json','tsconfig.base.json'}
ROOT_DIRS={'.github','apps','infra','packages','scripts','third-party','vendor'}
PUBLIC_ROOT_DEV_DEPENDENCIES={'@types/node','mediabunny','motion','pixi-filters','pixi.js','typescript','vitest','web-demuxer'}

def verify(root):
    root=Path(root)
    manifest=json.loads((root/'package.json').read_text())
    if manifest.get('dependencies') or manifest.get('optionalDependencies') or \
       set(manifest.get('devDependencies',{}))!=PUBLIC_ROOT_DEV_DEPENDENCIES:
        raise ValueError('Unexpected root dependencies in engine release')
    # History/dependencies are allowed in the staging tree, never in the archive.
    for item in root.iterdir():
        if item.name in {'.git','node_modules'}: continue
        if item.is_symlink(): raise ValueError('Release symlink: '+item.name)
        if item.name not in (ROOT_DIRS if item.is_dir() else ROOT_FILES):
            raise ValueError('Unexpected release root: '+item.name)
    for parent,allowed in [('apps',APPS),('packages',PACKAGES)]:
        actual={item.name for item in (root/parent).iterdir()}
        if actual!=allowed: raise ValueError('Unexpected release packages: '+parent+'/'+str(sorted(actual)))
        for name in allowed:
            path=root/parent/name/'package.json'
            manifest=json.loads(path.read_text())
            if manifest.get('license')!='MIT': raise ValueError('Engine license missing: '+str(path))
            for section in ['dependencies','devDependencies','optionalDependencies']:
                for dependency in manifest.get(section,{}):
                    if dependency.startswith(('@clerk/','@agent-recorder/hosted')) or dependency=='stripe':
                        raise ValueError('Commercial dependency in engine: '+dependency)
    if (root/'apps/mcp/src/smoke-product-fixture.mjs').exists():
        raise ValueError('Hosted-credit fixture client in engine release')
    for relative in ['Dockerfile','infra/start.sh']:
        contents=(root/relative).read_text()
        if any(marker in contents for marker in ['apps/hosted','@agent-recorder/hosted','RECORDER_MODE=hosted']):
            raise ValueError('Private hosted runtime in public deployment: '+relative)
    if '/app/apps/mcp/dist/index.js' not in (root/'infra/start.sh').read_text():
        raise ValueError('Public deployment must start the MIT MCP engine')
    return {'apps':sorted(APPS),'packages':sorted(PACKAGES),'commercialPackagesIncluded':False}

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--tree',required=True)
    print(json.dumps(verify(parser.parse_args().tree)))
