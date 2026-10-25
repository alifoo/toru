#!/bin/bash
# Downloads the pinned Sparkle release into apps/macos/build/Sparkle (gitignored) and verifies its checksum.
set -euo pipefail
version="2.10.0"
sha="c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c"
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/apps/macos/build/Sparkle"
mkdir -p "$out"
archive="$out/Sparkle-$version.tar.xz"
if [ ! -f "$archive" ]; then
  curl -fsSL --max-time 600 -o "$archive" "https://github.com/sparkle-project/Sparkle/releases/download/$version/Sparkle-$version.tar.xz"
fi
echo "$sha  $archive" | shasum -a 256 -c -
rm -rf "$out/$version" && mkdir -p "$out/$version"
tar -xJf "$archive" -C "$out/$version"
echo "$out/$version/Sparkle.framework"
