#!/usr/bin/env bash

# diskly one-line installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/arazshah/diskly/main/install.sh | bash
#
# Optional environment variables:
#   DISKLY_VERSION   Release tag, for example v0.1.0 (default: latest)
#   DISKLY_BIN_DIR   Installation directory (default: ~/.local/bin)
#   DISKLY_REPO      GitHub owner/repository (default: arazshah/diskly)

set -euo pipefail

REPO="${DISKLY_REPO:-arazshah/diskly}"
VERSION="${DISKLY_VERSION:-latest}"
BIN_DIR="${DISKLY_BIN_DIR:-$HOME/.local/bin}"
BIN_NAME="diskly"

uname_s="$(uname -s)"
uname_m="$(uname -m)"

case "${uname_s}:${uname_m}" in
  Linux:x86_64|Linux:amd64)
    TARGET="bun-linux-x64"
    ;;
  Linux:aarch64|Linux:arm64)
    TARGET="bun-linux-arm64"
    ;;
  Darwin:x86_64|Darwin:amd64)
    TARGET="bun-darwin-x64"
    ;;
  Darwin:arm64|Darwin:aarch64)
    TARGET="bun-darwin-arm64"
    ;;
  *)
    echo "❌ Unsupported platform: ${uname_s} ${uname_m}" >&2
    echo "Build from source instead:" >&2
    echo "  git clone https://github.com/${REPO}.git" >&2
    echo "  cd diskly && bun run build" >&2
    exit 1
    ;;
esac

ASSET="diskly-${TARGET}"

if [[ "$VERSION" == "latest" ]]; then
  URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
else
  URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"
fi

echo "→ Repository: ${REPO}"
echo "→ Platform:   ${TARGET}"
echo "→ Installing: ${BIN_DIR}/${BIN_NAME}"

mkdir -p "$BIN_DIR"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

TMP_BIN="${TMP_DIR}/${BIN_NAME}"

if command -v curl >/dev/null 2>&1; then
  curl -fL --retry 3 --connect-timeout 15 "$URL" -o "$TMP_BIN"
elif command -v wget >/dev/null 2>&1; then
  wget --tries=3 --timeout=15 -O "$TMP_BIN" "$URL"
else
  echo "❌ Neither curl nor wget is installed." >&2
  exit 1
fi

if [[ ! -s "$TMP_BIN" ]]; then
  echo "❌ Downloaded file is empty." >&2
  exit 1
fi

chmod 0755 "$TMP_BIN"
mv "$TMP_BIN" "${BIN_DIR}/${BIN_NAME}"

echo
echo "✅ diskly installed successfully:"
echo "   ${BIN_DIR}/${BIN_NAME}"

case ":${PATH}:" in
  *":${BIN_DIR}:"*)
    echo
    echo "Run:"
    echo "   diskly"
    ;;
  *)
    echo
    echo "⚠ ${BIN_DIR} is not currently in PATH."
    echo
    echo "For Bash, run:"
    echo "   echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc"
    echo "   source ~/.bashrc"
    echo
    echo "Then run:"
    echo "   diskly"
    ;;
esac
