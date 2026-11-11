#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-}"
NOTES="${2:-Nexshell $VERSION release}"
BASE_URL="${BASE_URL:-https://nexshell-updates.crdsyntax.workers.dev}"
OUT_DIR="${OUT_DIR:-update-dist}"
ADMIN_TOKEN="${ADMIN_TOKEN:-MHOqtbujTAVy7vsQZ9GE0SUW6rXJlzYf1LDocidKk4ne5CNP}"
KEY_PATH="${KEY_PATH:-$HOME/.tauri/nexshell.key}"

if [ -z "$VERSION" ]; then
  echo "Usage: ./scripts/publish-update.sh <version> [release_notes]"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SKIP_BUILD="${SKIP_BUILD:-0}"
if [ "$SKIP_BUILD" != "1" ]; then
  echo "Building release bundles for version $VERSION..."
  bun run tauri build
fi

BUNDLE_ROOT="src-tauri/target/release/bundle"
mkdir -p "$OUT_DIR"

DEB_FILE=$(find "$BUNDLE_ROOT/deb" -name "*${VERSION}*.deb" 2>/dev/null | head -n 1 || true)
APPIMAGE_FILE=$(find "$BUNDLE_ROOT/appimage" -name "*${VERSION}*.AppImage" 2>/dev/null | head -n 1 || true)

DEB_SIG=""
APPIMAGE_SIG=""

if [ -n "$DEB_FILE" ]; then
  DEB_NAME=$(basename "$DEB_FILE")
  cp "$DEB_FILE" "$OUT_DIR/$DEB_NAME"
  if [ -f "${DEB_FILE}.sig" ]; then
    cp "${DEB_FILE}.sig" "$OUT_DIR/${DEB_NAME}.sig"
  elif [ -f "$KEY_PATH" ]; then
    (unset TAURI_SIGNING_PRIVATE_KEY; bun run tauri signer sign -f "$KEY_PATH" -p "" --app-version "$VERSION" "$OUT_DIR/$DEB_NAME")
  fi
  if [ -f "$OUT_DIR/${DEB_NAME}.sig" ]; then
    DEB_SIG=$(cat "$OUT_DIR/${DEB_NAME}.sig")
  fi
  echo "Staged $DEB_NAME (sig: ${#DEB_SIG} chars)"
fi

if [ -n "$APPIMAGE_FILE" ]; then
  APPIMAGE_NAME=$(basename "$APPIMAGE_FILE")
  cp "$APPIMAGE_FILE" "$OUT_DIR/$APPIMAGE_NAME"
  if [ -f "${APPIMAGE_FILE}.sig" ]; then
    cp "${APPIMAGE_FILE}.sig" "$OUT_DIR/${APPIMAGE_NAME}.sig"
  elif [ -f "$KEY_PATH" ]; then
    (unset TAURI_SIGNING_PRIVATE_KEY; bun run tauri signer sign -f "$KEY_PATH" -p "" --app-version "$VERSION" "$OUT_DIR/$APPIMAGE_NAME")
  fi
  if [ -f "$OUT_DIR/${APPIMAGE_NAME}.sig" ]; then
    APPIMAGE_SIG=$(cat "$OUT_DIR/${APPIMAGE_NAME}.sig")
  fi
  echo "Staged $APPIMAGE_NAME (sig: ${#APPIMAGE_SIG} chars)"
fi

PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

node -e '
const fs = require("fs");
const [version, notes, baseUrl, pubDate, debName, debSig, appImageName, appImageSig, outFile] = process.argv.slice(1);

const platforms = {};
if (appImageName && appImageSig) {
  platforms["linux-x86_64"] = { url: `${baseUrl}/${appImageName}`, signature: appImageSig };
  platforms["linux-x86_64-appimage"] = { url: `${baseUrl}/${appImageName}`, signature: appImageSig };
} else if (debName && debSig) {
  platforms["linux-x86_64"] = { url: `${baseUrl}/${debName}`, signature: debSig };
}
if (debName && debSig) {
  platforms["linux-x86_64-deb"] = { url: `${baseUrl}/${debName}`, signature: debSig };
}

const manifest = {
  version,
  notes,
  pub_date: pubDate,
  platforms
};
fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2) + "\n");
' "$VERSION" "$NOTES" "$BASE_URL" "$PUB_DATE" "${DEB_NAME:-}" "${DEB_SIG:-}" "${APPIMAGE_NAME:-}" "${APPIMAGE_SIG:-}" "$OUT_DIR/latest.json"

echo "Done staging update in $OUT_DIR."

if [ -n "$ADMIN_TOKEN" ]; then
  echo "Uploading to $BASE_URL ..."
  node ../nexshell-updates/scripts/upload.mjs --dir "$OUT_DIR" --url "$BASE_URL" --token "$ADMIN_TOKEN"
fi
