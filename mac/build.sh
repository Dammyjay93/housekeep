#!/bin/bash
# Builds Housekeep.app: the menu bar app, with Node and Housekeep itself inside.
#
#   mac/build.sh             a local build, signed ad hoc, in mac/dist/Housekeep.app
#   mac/build.sh --release   signed with a Developer ID, notarized, as mac/dist/Housekeep.dmg
#
# --release needs a "Developer ID Application" certificate in the keychain, and a notarytool profile
# named "housekeep" (xcrun notarytool store-credentials housekeep).
set -euo pipefail

NODE_VERSION=24.21.0
MAC="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$MAC")"
CACHE="$MAC/.cache"
DIST="$MAC/dist"
APP="$DIST/Housekeep.app"
RELEASE=false
[[ "${1:-}" == "--release" ]] && RELEASE=true

step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

step "Building Housekeep"
(cd "$ROOT" && npm run build >/dev/null)

step "Getting Node $NODE_VERSION for Apple silicon and Intel"
mkdir -p "$CACHE"
NODE="$CACHE/node-$NODE_VERSION-universal"
if [[ ! -x "$NODE" ]]; then
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$CACHE/SHASUMS256-$NODE_VERSION.txt"
  for arch in arm64 x64; do
    tarball="node-v$NODE_VERSION-darwin-$arch.tar.xz"
    [[ -f "$CACHE/$tarball" ]] || curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$tarball" -o "$CACHE/$tarball"
    (cd "$CACHE" && grep " $tarball\$" "SHASUMS256-$NODE_VERSION.txt" | shasum -a 256 -c - >/dev/null) \
      || { echo "The Node download didn't match nodejs.org's checksum. Delete mac/.cache and try again."; exit 1; }
    tar -xf "$CACHE/$tarball" -C "$CACHE" "node-v$NODE_VERSION-darwin-$arch/bin/node" "node-v$NODE_VERSION-darwin-$arch/LICENSE"
  done
  lipo -create -output "$NODE" \
    "$CACHE/node-v$NODE_VERSION-darwin-arm64/bin/node" "$CACHE/node-v$NODE_VERSION-darwin-x64/bin/node"
fi

step "Building the app"
(cd "$MAC" && xcodegen generate --quiet)
xcodebuild -project "$MAC/Housekeep.xcodeproj" -scheme Housekeep -configuration Release \
  -derivedDataPath "$MAC/.build" ARCHS="arm64 x86_64" ONLY_ACTIVE_ARCH=NO -quiet build
rm -rf "$DIST"
mkdir -p "$DIST"
ditto "$MAC/.build/Build/Products/Release/Housekeep.app" "$APP"

step "Adding Node and Housekeep"
mkdir -p "$APP/Contents/Helpers"
cp "$NODE" "$APP/Contents/Helpers/node"
cp "$CACHE/node-v$NODE_VERSION-darwin-arm64/LICENSE" "$APP/Contents/Resources/NODE-LICENSE"
HK="$APP/Contents/Resources/housekeep"
mkdir -p "$HK/dist"
cp "$ROOT/package.json" "$ROOT/LICENSE" "$HK/"
ditto "$ROOT/dist/src" "$HK/dist/src"
ditto "$ROOT/assets" "$HK/assets"
ditto "$ROOT/skills" "$HK/skills"

if $RELEASE; then
  IDENTITY="$(security find-identity -v -p codesigning | awk -F'"' '/Developer ID Application/ { print $2; exit }')"
  [[ -n "$IDENTITY" ]] || { echo "No Developer ID Application certificate in the keychain."; exit 1; }
  SIGN=(--sign "$IDENTITY" --timestamp --options runtime)
else
  SIGN=(--sign - --options runtime)
fi

step "Signing (${IDENTITY:-ad hoc})"
# Inside out: Node first, with what V8 needs, then the app around it.
codesign --force "${SIGN[@]}" --entitlements "$MAC/node.entitlements" "$APP/Contents/Helpers/node"
codesign --force "${SIGN[@]}" "$APP"
codesign --verify --deep --strict "$APP"

if $RELEASE; then
  step "Packing and notarizing"
  STAGE="$DIST/dmg"
  mkdir -p "$STAGE"
  ditto "$APP" "$STAGE/Housekeep.app"
  ln -s /Applications "$STAGE/Applications"
  hdiutil create -quiet -volname Housekeep -srcfolder "$STAGE" -format ULFO -fs HFS+ "$DIST/Housekeep.dmg"
  rm -rf "$STAGE"
  codesign --force --sign "$IDENTITY" --timestamp "$DIST/Housekeep.dmg"
  xcrun notarytool submit "$DIST/Housekeep.dmg" --keychain-profile housekeep --wait
  xcrun stapler staple "$DIST/Housekeep.dmg"
  spctl --assess --type open --context context:primary-signature "$DIST/Housekeep.dmg"
  echo "Ready: $DIST/Housekeep.dmg"
else
  echo "Ready: $APP"
fi
