#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
app="$PWD/build/Toru.app"
mkdir -p "$app/Contents/MacOS"
# TORU_SPARKLE_FRAMEWORK=/path/to/Sparkle.framework embeds Sparkle for signed in-app updates; unset builds without an updater.
sparkle_flags=()
if [ -n "${TORU_SPARKLE_FRAMEWORK:-}" ]; then
  mkdir -p "$app/Contents/Frameworks"
  rm -rf "$app/Contents/Frameworks/Sparkle.framework"
  ditto "$TORU_SPARKLE_FRAMEWORK" "$app/Contents/Frameworks/Sparkle.framework"
  sparkle_flags=(-F "$(dirname "$TORU_SPARKLE_FRAMEWORK")" -framework Sparkle -Xlinker -rpath -Xlinker @executable_path/../Frameworks)
fi
swiftc -parse-as-library -swift-version 5 -O -target arm64-apple-macos15.0 Sources/*.swift -o "$app/Contents/MacOS/Toru" -framework SwiftUI -framework ScreenCaptureKit -framework AVFoundation -framework AppKit -framework Security ${sparkle_flags[@]+"${sparkle_flags[@]}"}
mkdir -p "$app/Contents/Resources" && cp "$PWD/Toru.icns" "$app/Contents/Resources/Toru.icns"
# Plex Sans (with its OFL licence) and the lens image: the Studio type and mark. Fonts load through ATSApplicationFontsPath.
rm -rf "$app/Contents/Resources/Fonts" && ditto "$PWD/Resources/Fonts" "$app/Contents/Resources/Fonts"
cp "$PWD/Resources/toru-orb.png" "$app/Contents/Resources/toru-orb.png"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Toru</string>
<key>CFBundleIdentifier</key><string>${TORU_BUNDLE_ID:-tools.toru.mac}</string>
<key>CFBundleName</key><string>Toru</string>
<key>CFBundleIconFile</key><string>Toru</string>
<key>CFBundleVersion</key><string>${TORU_BUILD:-7}</string>
<key>CFBundleShortVersionString</key><string>${TORU_VERSION:-0.4.3}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>15.0</string>
<key>NSScreenCaptureUsageDescription</key><string>Record the window or display you select, when your connected agent requests it.</string>
<key>NSHighResolutionCapable</key><true/>
<key>ATSApplicationFontsPath</key><string>Fonts</string>
<key>SUFeedURL</key><string>https://toru.tools/downloads/appcast.xml</string>
<key>SUPublicEDKey</key><string>${TORU_SPARKLE_PUBLIC_KEY:-$(cat "$PWD/sparkle-public-key.txt" 2>/dev/null || true)}</string>
<key>SUEnableAutomaticChecks</key><true/>
<key>SUAutomaticallyUpdate</key><false/>
<key>SUScheduledCheckInterval</key><integer>86400</integer>
<key>CFBundleURLTypes</key><array><dict>
<key>CFBundleURLName</key><string>Toru setup link</string>
<key>CFBundleURLSchemes</key><array><string>toru-mac</string></array>
</dict></array>
</dict></plist>
PLIST
# TORU_SIGN_IDENTITY="Developer ID Application: Name (TEAMID)" signs for distribution (hardened runtime + secure timestamp).
# Unset keeps the ad-hoc development signature.
if [ -n "${TORU_SIGN_IDENTITY:-}" ]; then
  # Sign the embedded Sparkle framework (XPC services, Autoupdate) before the outer bundle.
  if [ -d "$app/Contents/Frameworks/Sparkle.framework" ]; then
    codesign --force --options runtime --timestamp --deep --sign "$TORU_SIGN_IDENTITY" "$app/Contents/Frameworks/Sparkle.framework"
  fi
  codesign --force --options runtime --timestamp --sign "$TORU_SIGN_IDENTITY" "$app"
  codesign --verify --strict --verbose=2 "$app"
else
  codesign --force --sign - "$app"
fi
echo "$app"
