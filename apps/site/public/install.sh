#!/bin/sh
# Lingtai's installer (#184, doc/decisions/0051-a-version-is-a-directory.md).
#
#   curl -fsSL https://lingtai.nextloom.ai/install.sh | sh
#
# **Two addresses, and they are not interchangeable.** The one above is the
# front door. The one that cannot move is the release asset:
#
#   curl -fsSL https://github.com/steven-zhc/lingtai/releases/latest/download/install.sh | sh
#
# A domain can lapse, be renamed, or end up behind a bot challenge answering
# 200 with an HTML page — which `curl -f` does not catch, because it is not an
# error status, and which then gets piped into `sh`. Neither address is
# load-bearing after this script runs: every artifact below comes straight from
# GitHub Releases, and so does `lingtai upgrade`. A domain that moves breaks
# new installs and nothing that is already installed.
#
# What it does, in order, and nothing else:
#
#   1. names this platform — macOS or Linux, arm64 or x64 — or refuses by name
#   2. asks GitHub Releases which version is newest, unless LINGTAI_VERSION says
#   3. fetches that version's binary for this platform, the board and SHA256SUMS,
#      and checks both against the sums BEFORE unpacking a byte of either
#   4. unpacks into ~/.lingtai/versions/<version>/, and runs it once to see that
#      it does run here
#   5. points ~/.local/bin/lingtai at it
#   6. runs lingtai init, where there is a terminal to answer it
#
# Run again over an install, it changes only what is different and says which.
# A version already unpacked is never unpacked over: a process may be running
# from it. It edits no shell profile, and it sends nothing anywhere but the two
# requests above.
#
# LINGTAI_HOME, LINGTAI_BIN_DIR, LINGTAI_VERSION and LINGTAI_RELEASES_URL move
# where it installs, which version, and where it fetches from. LINGTAI_NO_INIT
# stops before init.

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
  Darwin) os=macos ;;
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
  # Asked on its own and not piped: sh has no pipefail, so a failed request at
  # the head of a pipeline would read as a release that does not exist.
  latest=$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API/latest") ||
    refuse "could not ask $API/latest which version is newest"
  tag=$(printf '%s\n' "$latest" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
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
  # What `.github/workflows/release.yml` publishes (0050): a binary per
  # platform, and one board for all of them.
  artifacts="lingtai-$platform.tar.gz board.tar.gz"
  scratch=$(mktemp -d "${TMPDIR:-/tmp}/lingtai-install.XXXXXX")
  partial=""
  trap 'rm -rf "$scratch" "$partial"' EXIT INT TERM

  say "fetching lingtai-$platform.tar.gz and board.tar.gz"
  curl -fsSL -o "$scratch/SHA256SUMS" "$RELEASES/v$version/SHA256SUMS" ||
    refuse "could not fetch SHA256SUMS for $version, so nothing could be checked — nothing was installed"
  for artifact in $artifacts; do
    curl -fsSL -o "$scratch/$artifact" "$RELEASES/v$version/$artifact" ||
      refuse "could not fetch $artifact from $RELEASES/v$version — is $version released?"
    expected=$(awk -v name="$artifact" '$2 == name || $2 == "*" name { print $1 }' "$scratch/SHA256SUMS")
    [ -n "$expected" ] || refuse "SHA256SUMS for $version does not list $artifact — nothing was installed"
    actual=$(sha256 "$scratch/$artifact")
    [ "$actual" = "$expected" ] ||
      refuse "$artifact does not match its checksum — expected $expected, got $actual. Nothing was unpacked"
  done

  mkdir -p "$HOME_DIR/versions"
  # One of its own, so an unpack beside this one never removes it or fills it.
  partial=$(mktemp -d "$HOME_DIR/versions/.$version.partial-XXXXXX")
  for artifact in $artifacts; do
    tar -xzf "$scratch/$artifact" -C "$partial" || refuse "tar could not unpack $artifact"
  done
  # `lingtai 1.0.1 macos-arm64 (binary, node v26.5.0)`: the second word is the version.
  said=$("$partial/lingtai" version 2>&1) || said="${said:-it exited non-zero}"
  case "$said" in
    "lingtai $version "* | "lingtai $version") ;;
    *) refuse "the unpacked lingtai does not run here as $version, so it was not installed — it said: ${said:-nothing}" ;;
  esac
  if mv "$partial" "$dir" 2> /dev/null && [ ! -e "$dir/$(basename "$partial")" ]; then
    say "installed lingtai $version into $dir, checksum verified"
  else
    # Another install renamed its whole directory into place first; mv moved
    # this one inside it, or refused, and either way that one is used.
    rm -rf "$dir/$(basename "$partial")"
    [ -e "$dir/lingtai" ] || refuse "could not move $partial into place as $dir"
    say "lingtai $version was installed into $dir alongside this — left as it is"
  fi
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

# ---------------------------------------------------------------------- init --

# The installer runs `lingtai init` (#186), so there is no second command to
# discover. Its questions are asked of the terminal, which under `curl | sh` is
# not stdin — stdin is the script — so they are read from /dev/tty, and only
# when there is one: with nobody to answer, it is named and not run.
#
# Only where init has never run. Over a machine that has a config.yml the run is
# an upgrade, and init there would start a board in this process and hold the
# `curl | sh` open on it, or fail on the port the machine's own board holds.
if [ -n "${LINGTAI_NO_INIT:-}" ]; then
  say "next: lingtai init — the database, the agent and the GitHub App, ending on the board"
elif [ -e "$HOME_DIR/config.yml" ]; then
  say "not running lingtai init — $HOME_DIR/config.yml is already here; lingtai init reports it, or continues where it stopped"
elif [ -t 1 ] && { : < /dev/tty; } 2> /dev/null; then
  say "running lingtai init"
  # Init stopping — a refusal, or a Ctrl+C — is not the install failing: the
  # binary and the shim are in place, and init run again continues from its file.
  "$target" init < /dev/tty || say "lingtai init stopped (exit $?) — lingtai is installed; lingtai init continues where it left off"
else
  say "next: lingtai init — there is no terminal here to answer its questions, so it was not run"
fi
