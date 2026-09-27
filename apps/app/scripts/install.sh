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

# Colours only on a terminal (and not with NO_COLOR). Under `curl | sh`, stdout is still the terminal.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B="$(printf '\033[1m')"; D="$(printf '\033[2m')"; G="$(printf '\033[32m')"; R="$(printf '\033[31m')"
  P="$(printf '\033[38;2;214;96;124m')"; C="$(printf '\033[36m')"; X="$(printf '\033[0m')"
else
  B=; D=; G=; R=; P=; C=; X=
fi
ok() { printf '%s✓%s %s\n' "$G" "$X" "$1"; }
step() { printf '%s›%s %s\n' "$C" "$X" "$1"; }
fail() { printf '%s✗%s %s\n' "$R" "$X" "$1" >&2; exit 1; }

printf '\n  %s●%s %sPR Bunny%s %sinstaller%s\n\n' "$P" "$X" "$B" "$X" "$D" "$X"

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

# Find a host that answers (prbunny.dev, else GitHub), whether or not a version was pinned.
if LATEST="$(curl -fsL "$BASE/latest" 2>/dev/null)"; then
  :
elif [ -z "${PR_BUNNY_DOWNLOAD_URL:-}" ] && LATEST="$(curl -fsSL "$GITHUB/latest/download/latest")"; then
  step "prbunny.dev isn't reachable from here; downloading from GitHub instead."
  BASE="github"
else
  fail "couldn't reach $BASE"
fi
VERSION="${PR_BUNNY_VERSION:-$LATEST}"
VERSION="$(printf '%s' "$VERSION" | tr -d '[:space:]')"
ASSET="bunny-${OS}-${ARCH}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

if [ -n "${PR_BUNNY_VERSION:-}" ]; then ok "Version: ${B}${VERSION}${X} ${D}(pinned; latest is $(printf '%s' "$LATEST" | tr -d '[:space:]'), ${OS}/${ARCH})${X}"; else ok "Latest version: ${B}${VERSION}${X} ${D}(${OS}/${ARCH})${X}"; fi
step "Downloading ${ASSET}…"
if [ "$BASE" = github ]; then URL="$GITHUB/download/v$VERSION/$ASSET"; else URL="$BASE/$VERSION/$ASSET"; fi
# prbunny.dev counts installs by version and Mac type (?arch= on the binary, not its checksum);
# nothing else is sent, and nothing is saved here. GitHub and PR_BUNNY_DOWNLOAD_URL get no parameters.
COUNT=
if [ -z "${PR_BUNNY_DOWNLOAD_URL:-}" ] && [ "$BASE" != github ]; then COUNT="?arch=${OS}-${ARCH}"; fi
curl -fSL --progress-bar "$URL$COUNT" -o "$TMP/bunny" || fail "download failed: $URL"
curl -fsSL "$URL.sha256" -o "$TMP/bunny.sha256" || fail "checksum download failed"

EXPECTED="$(cut -d' ' -f1 "$TMP/bunny.sha256")"
ACTUAL="$(shasum -a 256 "$TMP/bunny" | cut -d' ' -f1)"
[ "$EXPECTED" = "$ACTUAL" ] || fail "checksum mismatch (expected $EXPECTED, got $ACTUAL)"
ok "Checksum verified ${D}(sha256 ${ACTUAL%"${ACTUAL#????????????}"}…)${X}"

chmod 755 "$TMP/bunny"
"$TMP/bunny" version >/dev/null 2>&1 || fail "the downloaded binary doesn't run on this Mac"
mkdir -p "$BIN_DIR"
mv -f "$TMP/bunny" "$BIN_DIR/bunny"
ok "Installed ${B}${BIN_DIR}/bunny${X}"

# An update replaces the binary under a running service; setup restarts it on the new version.
if [ -z "${PR_BUNNY_NO_SETUP:-}" ]; then
  printf '\n'
  if [ -r /dev/tty ]; then "$BIN_DIR/bunny" setup < /dev/tty; else "$BIN_DIR/bunny" setup --yes; fi
else
  step "Next: ${C}${BIN_DIR}/bunny setup${X}"
fi
