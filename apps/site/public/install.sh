#!/bin/sh
# Lingtai's installer (#184, doc/decisions/0050-a-version-is-a-directory.md).
#
#   curl -fsSL https://lingtai.dev/install.sh | sh
#
# What it does, in order, and nothing else:
#
#   1. names this platform — macOS or Linux, arm64 or x64 — or refuses by name
#   2. asks GitHub Releases which version is newest, unless LINGTAI_VERSION says
#   3. fetches that version's artifact and SHA256SUMS, and checks the one against
#      the other BEFORE unpacking a byte of it
#   4. unpacks into ~/.lingtai/versions/<version>/, and runs it once to see that
#      it does run here
#   5. points ~/.local/bin/lingtai at it
#
# Run again over an install, it changes only what is different and says which.
# A version already unpacked is never unpacked over: a process may be running
# from it. It edits no shell profile, and it sends nothing anywhere but the two
# requests above.
#
# LINGTAI_HOME, LINGTAI_BIN_DIR, LINGTAI_VERSION and LINGTAI_RELEASES_URL move
# where it installs, which version, and where it fetches from.

set -eu

REPO="steven-zhc/lingtai"
HOME_DIR="${LINGTAI_HOME:-$HOME/.lingtai}"
BIN_DIR="${LINGTAI_BIN_DIR:-$HOME/.local/bin}"
RELEASES="${LINGTAI_RELEASES_URL:-https://github.com/$REPO/releases/download}"
API="${LINGTAI_RELEASES_API:-https://api.github.com/repos/$REPO/releases}"

say() { printf '%s\n' "$*"; }
refuse() { printf 'lingtai: %s\n' "$*" >&2; exit 1; }

# ----------------------------------------------------------------- platform --

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) refuse "no Lingtai is built for $os $arch — only macOS and Linux, on arm64 or x64. Nothing was installed rather than something that will not run" ;;
esac
case "$arch" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) refuse "no Lingtai is built for $os $arch — only arm64 and x64. Nothing was installed rather than something that will not run" ;;
esac
platform="$os-$arch"

command -v curl > /dev/null 2>&1 || refuse "curl is needed to fetch the release, and is not on PATH"
command -v tar > /dev/null 2>&1 || refuse "tar is needed to unpack the release, and is not on PATH"
if command -v shasum > /dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
elif command -v sha256sum > /dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
else
  refuse "neither shasum nor sha256sum is on PATH, so the download could not be checked — nothing was installed"
fi

# ------------------------------------------------------------------ version --

version="${LINGTAI_VERSION:-}"
if [ -z "$version" ]; then
  tag=$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API/latest" |
    sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1) ||
    refuse "could not ask $API/latest which version is newest"
  [ -n "$tag" ] || refuse "$API/latest named no release"
  version="${tag#v}"
fi
version="${version#v}"

dir="$HOME_DIR/versions/$version"
shim="$BIN_DIR/lingtai"

# ------------------------------------------------------------------- unpack --

if [ -e "$dir/lingtai" ]; then
  say "lingtai $version is already in $dir — left as it is"
else
  artifact="lingtai-$version-$platform.tar.gz"
  scratch=$(mktemp -d "${TMPDIR:-/tmp}/lingtai-install.XXXXXX")
  partial="$HOME_DIR/versions/.$version.partial"
  trap 'rm -rf "$scratch" "$partial"' EXIT INT TERM

  say "fetching $artifact"
  curl -fsSL -o "$scratch/SHA256SUMS" "$RELEASES/v$version/SHA256SUMS" ||
    refuse "could not fetch SHA256SUMS for $version, so nothing could be checked — nothing was installed"
  curl -fsSL -o "$scratch/$artifact" "$RELEASES/v$version/$artifact" ||
    refuse "could not fetch $artifact from $RELEASES/v$version — is $version released?"

  expected=$(awk -v name="$artifact" '$2 == name || $2 == "*" name { print $1 }' "$scratch/SHA256SUMS")
  [ -n "$expected" ] || refuse "SHA256SUMS for $version does not list $artifact — nothing was installed"
  actual=$(sha256 "$scratch/$artifact")
  [ "$actual" = "$expected" ] ||
    refuse "$artifact does not match its checksum — expected $expected, got $actual. Nothing was unpacked"

  mkdir -p "$HOME_DIR/versions"
  rm -rf "$partial"
  mkdir "$partial"
  tar -xzf "$scratch/$artifact" -C "$partial" || refuse "tar could not unpack $artifact"
  if ! said=$("$partial/lingtai" version 2>&1) || ! printf '%s' "$said" | grep -q "$version"; then
    refuse "the unpacked lingtai does not run here, so it was not installed — it said: ${said:-nothing}. Until the binary ships (#185) it needs Node 22 or later on PATH"
  fi
  mv "$partial" "$dir"
  say "installed lingtai $version into $dir, checksum verified"
fi

# --------------------------------------------------------------------- shim --

mkdir -p "$BIN_DIR"
target="$dir/lingtai"
if [ -L "$shim" ]; then
  current=$(readlink "$shim")
  case "$current" in
    "$HOME_DIR/versions/"*) ;;
    *) refuse "$shim points at $current, which is not Lingtai's to replace. Move it and run this again" ;;
  esac
  if [ "$current" = "$target" ]; then
    say "$shim already runs $version"
  else
    ln -s "$target" "$shim.$$.new"
    mv -f "$shim.$$.new" "$shim"
    was=$(basename "$(dirname "$current")")
    say "$shim now runs $version (was $was — still in $HOME_DIR/versions, and lingtai rollback points back at it)"
  fi
elif [ -e "$shim" ]; then
  refuse "$shim is a file and not a link into $HOME_DIR/versions — not Lingtai's to replace. Move it and run this again"
else
  ln -s "$target" "$shim"
  say "$shim runs $version"
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "$BIN_DIR is not on your PATH — add it to your shell's profile to type lingtai" ;;
esac

# lingtai init (1.0 step 11) is not built yet; when it is, this runs it.
say "next: lingtai doctor says what is configured and what is not"
