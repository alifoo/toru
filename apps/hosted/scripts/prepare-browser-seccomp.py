"""Create a pinned Docker seccomp candidate; never installs or applies it globally.

Upstream Moby profiles is Apache-2.0. Source remains external; preserve its license
and attribution when distributing a generated profile in a worker image/release.
"""
import hashlib
import json
from pathlib import Path
import sys
import urllib.request

REVISION = '85e237f1fe229a0c61c9c7d8e743fa780d3b97ca'
SOURCE_SHA256 = '785b2429264afba4d594320337cb17f144f3c7d51585f9805eef72e28f4f9334'
SOURCE = f'https://raw.githubusercontent.com/moby/profiles/{REVISION}/seccomp/default.json'

if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python3 prepare-browser-seccomp.py NEW_OUTPUT_PATH')
    with urllib.request.urlopen(SOURCE, timeout=20) as response:
        raw = response.read(1024 * 1024 + 1)
    if hashlib.sha256(raw).hexdigest() != SOURCE_SHA256:
        raise SystemExit('upstream_seccomp_checksum_mismatch')
    profile = json.loads(raw)
    assert profile['defaultAction'] == 'SCMP_ACT_ERRNO'
    # Same namespace primitives documented by Playwright for sandboxed Chromium.
    # Retain the modern base's openat2 and clone3 ENOSYS fallback rules.
    profile['syscalls'].append({'names': ['clone', 'setns', 'unshare'],
        'action': 'SCMP_ACT_ALLOW', 'args': [],
        'comment': 'Chromium namespaces, following Playwright Docker guidance.'})
    output = (json.dumps(profile, sort_keys=True, indent=2) + '\n').encode()
    path = Path(sys.argv[1])
    with path.open('xb') as destination:
        destination.write(output)
    print(json.dumps({'sourceRevision': REVISION, 'sourceSha256': SOURCE_SHA256,
                      'profileSha256': hashlib.sha256(output).hexdigest(), 'output': str(path)}))
