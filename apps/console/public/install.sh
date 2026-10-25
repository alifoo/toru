#!/bin/bash
# Installs the latest Toru for Mac into /Applications.
#
#   curl -fsSL https://toru.tools/install.sh | bash
#
# Why a script instead of the .zip: the beta build is not notarized by Apple yet. A browser marks every download with
# com.apple.quarantine and Gatekeeper then refuses to open the app until you allow it in System Settings. curl does not
# set that flag, so nothing downloaded here is quarantined. The script checks the release's SHA-256 before installing.
#
# TORU_INSTALL_DIR=/some/dir installs there instead of /Applications; TORU_NO_OPEN=1 does not open the app afterwards.

set -euo pipefail

SITE="https://toru.tools"
APP="Toru"
DIR="${TORU_INSTALL_DIR:-/Applications}"
DEST="$DIR/$APP.app"

say()  { printf '  %s\n' "$*"; }
fail() { printf '  error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || fail "Toru for Mac is a macOS app."
[ "$(uname -m)" = arm64 ] || fail "Toru for Mac needs a Mac with Apple silicon."
major=$(sw_vers -productVersion | cut -d. -f1)
[ "$major" -ge 15 ] || fail "Toru needs macOS 15 or newer (this is $(sw_vers -productVersion))."

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# The release manifest names the latest zip and its checksum; plutil reads JSON and ships with macOS.
curl -fsSL "$SITE/downloads/mac.json" -o "$tmp/mac.json" || fail "could not reach toru.tools to find the latest release."
path=$(plutil -extract latest.url raw -o - "$tmp/mac.json" 2>/dev/null) || fail "no release is published yet."
sha=$(plutil -extract latest.sha256 raw -o - "$tmp/mac.json")
version=$(plutil -extract latest.version raw -o - "$tmp/mac.json")
case "$path" in /downloads/mac/Toru-*.zip) ;; *) fail "unexpected release path: $path" ;; esac
zip="$tmp/${path##*/}"

say "downloading Toru $version"
curl -fsSL "$SITE$path" -o "$zip"
printf '%s  %s\n' "$sha" "$zip" | shasum -a 256 -c - >/dev/null || fail "checksum does not match — not installing."

ditto -x -k "$zip" "$tmp/unpacked"
[ -d "$tmp/unpacked/$APP.app" ] || fail "the download does not contain $APP.app."

# Quit the copy being replaced, if it is running; recordings in progress are saved locally by the app.
pkill -f "$DEST/Contents/MacOS/$APP" 2>/dev/null && sleep 1 || true

# /Applications is writable for admin accounts; ask for sudo only when it is not.
sudo=""
mkdir -p "$DIR" 2>/dev/null || true
[ -w "$DIR" ] || sudo="sudo"
$sudo mkdir -p "$DIR"
$sudo rm -rf "$DEST"
$sudo ditto "$tmp/unpacked/$APP.app" "$DEST"
# Nothing above sets the flag, but an older copy downloaded with a browser might carry it.
$sudo xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST" 2>/dev/null || true

say "installed Toru $version in $DEST"
say "next: open https://app.toru.tools/onboarding?step=mac to connect this Mac"
[ "${TORU_NO_OPEN:-}" = 1 ] || open "$DEST"
