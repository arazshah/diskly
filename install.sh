#!/usr/bin/env bash
# diskly one-line installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/araz/diskly/main/install.sh | bash
#
# Environment variables (all optional):
#   DISKLY_VERSION   Pin a specific release tag (default: latest)
#   DISKLY_BIN_DIR   Where to install the binary (default: ~/.local/bin)
#   DISKLY_REPO      GitHub owner/repo (default: araz/diskly)

set -euo pipefail

REPO="${DISKLY_REPO:-araz/diskly}"
VERSION="${DISKLY_VERSION:-latest}"
BIN_DIR="${DISKLY_BIN_DIR:-$HOME/.local/bin}"
BIN_NAME="diskly"

# Pick a target based on the host OS / arch.
uname_s="$(uname -s)"
uname_m="$(uname -m)"
case "$uname_s:$uname_m" in
  Linux:x86_64)   TARGET="bun-linux-x64" ;;
  Linux:aarch64)  TARGET="bun-linux-arm64" ;;
  Darwin:x86_64)  TARGET="bun-darwin-x64" ;;
  Darwin:arm64)   TARGET="bun-darwin-arm64" ;;
  *)
    echo "❌ Unsupported platform: $uname_s $uname_m" >&2
    echo "   Build from source instead:  bun run build" >&2
    exit 1
    ;;
esac

if [[ "$VERSION" == "latest" ]]; then
  URL="https://github.com/${REPO}/releases/latest/download/diskly-${TARGET}"
else
  URL="https://github.com/${REPO}/releases/download/${VERSION}/diskly-${TARGET}"
fi

echo "→ Installing diskly (${TARGET}) into ${BIN_DIR}/"
mkdir -p "$BIN_DIR"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$URL" -o "$tmp/$BIN_NAME"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$tmp/$BIN_NAME" "$URL"
else
  echo "❌ Neither curl nor wget is available." >&2
  exit 1
fi

chmod +x "$tmp/$BIN_NAME"
mv "$tmp/$BIN_NAME" "$BIN_DIR/$BIN_NAME"

echo "✅ Installed: $BIN_DIR/$BIN_NAME"
echo
echo "Make sure \"$BIN_DIR\" is on your PATH. For example, add this to"
echo "your ~/.bashrc or ~/.zshrc if it isn't already:"
echo
echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
echo
echo "Then run:  diskly --version"
