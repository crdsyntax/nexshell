#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-}"
NOTES="${2:-}"
BASE_URL="${BASE_URL:-https://nexshell-updates.crdsyntax.workers.dev}"
OUT_DIR="${OUT_DIR:-update-dist}"

if [ -z "$VERSION" ]; then
  echo "Usage: ./scripts/publish-update.sh <version> [release_notes]"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "Building release bundles for version $VERSION..."
bun run tauri build

BUNDLE_ROOT="src-tauri/target/release/bundle"
mkdir -p "$OUT_DIR"

DEB_FILE=$(find "$BUNDLE_ROOT/deb" -name "*${VERSION}*.deb" 2>/dev/null | head -n 1 || true)
APPIMAGE_FILE=$(find "$BUNDLE_ROOT/appimage" -name "*${VERSION}*.AppImage" 2>/dev/null | head -n 1 || true)

PLATFORMS_JSON="{}"

if [ -n "$DEB_FILE" ]; then
  DEB_NAME=$(basename "$DEB_FILE")
  cp "$DEB_FILE" "$OUT_DIR/$DEB_NAME"
  SIG=""
  if [ -f "${DEB_FILE}.sig" ]; then
    SIG=$(cat "${DEB_FILE}.sig")
  fi
  echo "Staged $DEB_NAME"
fi

if [ -n "$APPIMAGE_FILE" ]; then
  APPIMAGE_NAME=$(basename "$APPIMAGE_FILE")
  cp "$APPIMAGE_FILE" "$OUT_DIR/$APPIMAGE_NAME"
  SIG=""
  if [ -f "${APPIMAGE_FILE}.sig" ]; then
    SIG=$(cat "${APPIMAGE_FILE}.sig")
  fi
  echo "Staged $APPIMAGE_NAME"
fi

PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cat <<EOF > "$OUT_DIR/latest.json"
{
  "version": "$VERSION",
  "notes": "$NOTES",
  "pub_date": "$PUB_DATE",
  "platforms": {
    "linux-x86_64": {
      "url": "$BASE_URL/$(basename "${DEB_FILE:-}")",
      "signature": "$(cat "${DEB_FILE}.sig" 2>/dev/null || true)"
    }
  }
}
EOF

echo "Done staging update in $OUT_DIR."
echo "Upload with:"
echo "node ../nexshell-updates/scripts/upload.mjs --dir ./update-dist --url $BASE_URL --token <ADMIN_TOKEN>"
