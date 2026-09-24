#!/bin/sh
# Installs PR Bunny on this Mac:  curl -fsSL https://prbunny.dev/install | sh
#
#   PR_BUNNY_VERSION=0.1.0       install a specific version (default: the latest)
#   PR_BUNNY_DOWNLOAD_URL=<url>  where releases are hosted (default below)
#   PR_BUNNY_NO_SETUP=1          don't run `bunny setup` afterwards
#
# The binary lives in ~/.pr-bunny/bin/bunny (the app updates it there). `bunny setup` then offers
# to link it as ~/.local/bin/bunny and installs the login service.
#
# Built by scripts/build.ts, which checks this file matches its targets and URL layout:
# targets: darwin-arm64, darwin-x64
set -eu

BASE="${PR_BUNNY_DOWNLOAD_URL:-https://prbunny.dev/releases}"
# If prbunny.dev can't be reached, the files are on GitHub Releases (tag v<version>) anyway.
GITHUB="https://github.com/DailyStandup-io/pr-bunny/releases"
HOME_DIR="${PR_BUNNY_HOME:-$HOME/.pr-bunny}"
BIN_DIR="$HOME_DIR/bin"

fail() { printf 'PR Bunny install: %s\n' "$1" >&2; exit 1; }

OS="$(uname -s)"
case "$OS" in
  Darwin) OS=darwin ;;
  *) fail "PR Bunny supports macOS only for now (this is $OS)." ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) fail "unsupported CPU: $(uname -m)" ;;
esac
# Rosetta: an x64 shell on Apple silicon should still get the native build.
if [ "$ARCH" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then ARCH=arm64; fi

if [ -n "${PR_BUNNY_VERSION:-}" ]; then
  VERSION="$PR_BUNNY_VERSION"
elif VERSION="$(curl -fsSL "$BASE/latest")"; then
  :
elif [ -z "${PR_BUNNY_DOWNLOAD_URL:-}" ] && VERSION="$(curl -fsSL "$GITHUB/latest/download/latest")"; then
  BASE="github"
else
  fail "couldn't reach $BASE"
fi
VERSION="$(printf '%s' "$VERSION" | tr -d '[:space:]')"
ASSET="bunny-${OS}-${ARCH}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

printf 'Downloading PR Bunny %s (%s)…\n' "$VERSION" "$ASSET"
if [ "$BASE" = github ]; then URL="$GITHUB/download/v$VERSION/$ASSET"; else URL="$BASE/$VERSION/$ASSET"; fi
curl -fSL --progress-bar "$URL" -o "$TMP/bunny" || fail "download failed: $URL"
curl -fsSL "$URL.sha256" -o "$TMP/bunny.sha256" || fail "checksum download failed"

EXPECTED="$(cut -d' ' -f1 "$TMP/bunny.sha256")"
ACTUAL="$(shasum -a 256 "$TMP/bunny" | cut -d' ' -f1)"
[ "$EXPECTED" = "$ACTUAL" ] || fail "checksum mismatch (expected $EXPECTED, got $ACTUAL)"

chmod 755 "$TMP/bunny"
"$TMP/bunny" version >/dev/null 2>&1 || fail "the downloaded binary doesn't run on this Mac"
mkdir -p "$BIN_DIR"
mv -f "$TMP/bunny" "$BIN_DIR/bunny"
printf 'Installed %s\n' "$BIN_DIR/bunny"

# An update replaces the binary under a running service; setup restarts it on the new version.
if [ -z "${PR_BUNNY_NO_SETUP:-}" ]; then
  printf '\nRunning bunny setup…\n'
  if [ -r /dev/tty ]; then "$BIN_DIR/bunny" setup < /dev/tty; else "$BIN_DIR/bunny" setup --yes; fi
else
  printf 'Next: %s setup\n' "$BIN_DIR/bunny"
fi
