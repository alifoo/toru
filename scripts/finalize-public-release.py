#!/usr/bin/env python3
"""Generate license inventory, SBOM and a source-only archive from a tested tree."""
from pathlib import Path
import argparse, datetime, gzip, hashlib, json, shutil, subprocess, tarfile, uuid, runpy
p = argparse.ArgumentParser(); p.add_argument('--tree', required=True); p.add_argument('--archive', required=True); a = p.parse_args()
root = Path(a.tree).resolve(); archive = Path(a.archive).resolve()
runpy.run_path(str(Path(__file__).with_name('public-release-boundary.py')))['verify'](root)
if archive.exists(): raise SystemExit('Refusing to overwrite an existing archive')
if not (root/'node_modules/.pnpm').exists(): raise SystemExit('Install/test the release tree first')
notices = root/'third-party/package-licenses'; notices.mkdir(exist_ok=True)
packages = {}
license_graph=json.loads(subprocess.check_output(['pnpm','licenses','list','--json'],cwd=root))
active={(entry['name'],version) for entries in license_graph.values() for entry in entries for version in entry['versions']}
for manifest in sorted((root/'node_modules/.pnpm').glob('*/node_modules/*/package.json')) + sorted((root/'node_modules/.pnpm').glob('*/node_modules/@*/*/package.json')):
    if manifest.parent.is_symlink(): continue
    data = json.loads(manifest.read_text()); name=data.get('name'); version=data.get('version')
    if not name or not version or (name,version) not in active: continue
    key=f'{name}@{version}'
    folder=notices/(name.replace('/','__')+'@'+version); folder.mkdir(exist_ok=True)
    files=[]
    for path in sorted(manifest.parent.iterdir()):
        if path.is_file() and path.name.upper().startswith(('LICENSE','LICENCE','COPYING','NOTICE','COPYRIGHT')):
            shutil.copyfile(path, folder/path.name); files.append(str((folder/path.name).relative_to(root)))
    packages[key]={'name':name,'version':version,'license':data.get('license', 'SEE LICENSE' if files else 'UNRESOLVED'), 'noticeFiles':files}
(root/'third-party/packages.json').write_text(json.dumps(list(packages.values()),indent=2)+'\n')
components=[]
for item in packages.values():
    c={'type':'library','name':item['name'],'version':item['version'], 'purl':'pkg:npm/'+item['name'].replace('@','%40')+'@'+item['version']}
    if isinstance(item['license'],str): c['licenses']=[{'license':{'name':item['license']}}]
    components.append(c)
(root/'sbom.cdx.json').write_text(json.dumps({'bomFormat':'CycloneDX','specVersion':'1.5','serialNumber':'urn:uuid:'+str(uuid.uuid4()),'version':1,'metadata':{'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat(), 'component':{'type':'application','name':'agent-recorder','version':'0.1.0'}},'components':components},indent=2)+'\n')
# No build products, runtime config, history or dependencies are copied into the source archive.
skip={'node_modules','dist','dist-web','.git','.vercel','data','artifacts','__pycache__'}
def included(path):
    rel=path.relative_to(root)
    return not any(x in skip or x.startswith('.env') for x in rel.parts) and path.name!='.local-mcp.json' and not path.name.endswith('.tsbuildinfo')
files=[x for x in sorted(root.rglob('*')) if x.is_file() and included(x) and x.name!='SHA256SUMS']
for f in files:
    if f.is_symlink(): raise SystemExit('Release may not contain symlinks: '+str(f.relative_to(root)))
(root/'SHA256SUMS').write_text(''.join(hashlib.sha256(f.read_bytes()).hexdigest()+'  '+str(f.relative_to(root))+'\n' for f in files))
files.append(root/'SHA256SUMS')
archive.parent.mkdir(parents=True,exist_ok=True)
with archive.open('xb') as out, gzip.GzipFile(filename='',mode='wb',fileobj=out,mtime=0) as gz, tarfile.open(fileobj=gz,mode='w') as tar:
    for f in sorted(files):
        info=tar.gettarinfo(str(f),arcname='agent-recorder/'+str(f.relative_to(root)))
        info.uid=info.gid=0;info.uname=info.gname='';info.mtime=0;info.mode=0o755 if f.name.endswith('.sh') else 0o644
        with f.open('rb') as stream:tar.addfile(info,stream)
checksum=hashlib.sha256(archive.read_bytes()).hexdigest()
archive.with_suffix(archive.suffix+'.sha256').write_text(checksum+'  '+archive.name+'\n')
print(json.dumps({'files':len(files),'dependencies':len(packages),'unresolved':[k for k,v in packages.items() if v['license']=='UNRESOLVED'],'archive':str(archive),'sha256':checksum}))
