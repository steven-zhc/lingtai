# 0113 — Distribution: `dist/` is the package, the binary is a SEA per platform, and a version is a directory the shim points at

**Status** accepted · 2026-10-01

`pnpm build` writes `dist/` — one CommonJS CLI bundle and the board as Next
`standalone` — and that is the only publishable unit; both workspace manifests
stay private. `pnpm binary` turns the bundle into a Node single-executable
application, built and run on each of four platforms and signed ad hoc on
macOS. A tag `v*` publishes the four binaries, one board, the installer and
`SHA256SUMS` to GitHub Releases. On a user's machine each version is unpacked
once into `~/.lingtai/versions/<v>/`, and `~/.local/bin/lingtai` is a symlink
that upgrade and rollback move and nothing else does.

## Context

A checkout runs its TypeScript source unbuilt, which is right for development
and useless for somebody who only wants the tool. Installing has to be one
line with no Node required, upgrades must not break a daemon that is still
running the old code, and a bad release must be reversible without a network.
A SEA copies the Node that builds it, so a binary cannot be cross-compiled, and
on Apple Silicon an unsigned binary is killed at `exec` with no message.

## Decision

1. **`dist/` is the package, and nothing else is.** `pnpm build` runs
   `apps/release/src/build.ts`, which writes `dist/package.json` (name
   `lingtai`, bin `lingtai.cjs`, no dependencies, not private),
   `dist/lingtai.cjs` (the CLI bundled from `apps/cli/src/entry.ts` by esbuild)
   and `dist/board/` (entry `board/apps/board/server.js`). The root and
   `apps/cli` manifests stay `"private": true`: the root is the workspace, and
   `apps/cli`'s bin is TypeScript source with `workspace:*` dependencies.
   `apps/release` is private too.
2. **The CLI is CJS and the board is ESM; the CLI crosses with `import()`.**
   Inside a SEA a plain `import()` reaches only built-ins, so `lingtai board`
   compiles it in a `vm.Script` with `USE_MAIN_CONTEXT_DEFAULT_LOADER`
   (`apps/cli/src/board.ts`); the binary's `execArgv` silences that one
   experimental warning.
3. **The board is pure JavaScript and its build is reproducible.** It uses
   `images: { unoptimized: true }`; the build prunes `sharp` and `@img/*` from
   the standalone output and refuses to finish with any `.node` file in
   `board/`. The Next build id is set to the commit (`LINGTAI_BUILD_ID`), so two
   builds of one commit have one layout.
4. **The binary is a SEA built with `node --build-sea`.** `pnpm binary`
   (`apps/release/src/binary.ts`) writes `dist/lingtai` beside the bundle; it
   needs Node 25.5 or later to build, while the script runs on `engines`
   (`>=22.13`). Code cache and snapshot are off. Inside a SEA the bundle treats
   `process.execPath` as its own location, so `board/` is found beside the
   binary.
5. **Four platforms, each built and run on itself.** `macos-arm64`,
   `macos-x64`, `linux-x64`, `linux-arm64`, with Node 26, in
   `.github/workflows/release.yml`. Each job runs
   `apps/release/integration/build.test.ts` (bundle and binary both start the
   board and serve a page), builds the artifact, runs `dist/lingtai version` and
   checks it names its platform and, on a tag, the tag's version. No Windows.
6. **macOS binaries are always signed ad hoc** with `codesign --sign -` and
   verified. The test asserts the signature with `codesign --verify`, and that a
   build without the step has none, so the step cannot be dropped quietly — the
   signature rather than the kill at exec, because GitHub's macOS runners run an
   unsigned binary that a stock Apple Silicon Mac kills. No Developer ID or notarisation: `curl | sh` is not
   a browser download.
7. **`lingtai version` names the artifact** —
   `lingtai <version> <platform> (binary|script, node <v>)`. The version is the
   root `package.json`'s, compiled in.
8. **A tag `v*` publishes.** The publish job uploads
   `lingtai-<platform>.tar.gz` ×4, one `board.tar.gz`, `install.sh` and
   `SHA256SUMS` over all of them to a GitHub Release.
9. **A version is a directory, written once.**
   `~/.lingtai/versions/<v>/` holds `lingtai` and `board/`. It is unpacked into
   its own `versions/.<v>.partial-*`, run once (`lingtai version` must report
   `<v>`), then renamed into place. A version already present is used as it is.
   Nothing but `uninstall` removes one.
10. **The shim is the only thing that moves.** `~/.local/bin/lingtai` (or
    `LINGTAI_BIN_DIR`) is a symlink into `versions/`, replaced by renaming a new
    link over it. The installer and the CLI refuse to replace a `lingtai` that is
    not such a link.
11. **Both artifacts are checked against `SHA256SUMS` before either is
    unpacked**, by the installer and by `upgrade` alike.
12. **The installer is `apps/site/public/install.sh`.** It names the platform or
    refuses by name, asks GitHub Releases for the newest version unless
    `LINGTAI_VERSION` says, fetches and verifies, unpacks, points the shim, and
    runs `lingtai init` where there is a terminal (`LINGTAI_NO_INIT` stops
    before it). It edits no shell profile. `LINGTAI_HOME`, `LINGTAI_BIN_DIR`
    and `LINGTAI_RELEASES_URL` move where it installs and fetches from. The
    canonical address is the release asset
    (`releases/latest/download/install.sh`); the site's `/install.sh` is the
    front door, and neither is needed after the first run.
13. **`version`, `upgrade`, `rollback`, `uninstall` and `init` need no log.**
    `apps/cli/src/entry.ts` dispatches them before `lingtai.ts`, and so
    `@lingtai/event-store`, is imported (`apps/cli/src/install.ts`).
14. **`upgrade` does everything that can fail first, then drains, then switches.**
    It asks for the newest release, downloads, verifies and trial-runs while the
    old version still conducts; a refusal there changes nothing. Then, where a
    log is configured, `lingtai doctor` gates (`--despite-doctor`), and where
    something holds the conductor lock, `lingtai shutdown`'s drain is asked and
    the lock waited on; a drain the same person left standing is lifted and asked
    again. The shim moves once the lock is free, and the drain is withdrawn.
    It starts nothing: `lingtai start` runs the new version. Upgrading a checkout
    is refused; that is `git pull` and `lingtai restart`.
15. **`rollback [<version>]` moves the shim to an installed older version**
    (the newest older one by default) after running it once. It fetches and
    deletes nothing; a daemon keeps the version it started from until it is
    stopped and started.
16. **Which release is newest is asked by `upgrade` and `doctor` only** — the one
    outbound request Lingtai makes on its own account (`RELEASES_API`, or
    `LINGTAI_RELEASES_API`). Doctor asks it in the command, not in `runDoctor`,
    so `restart`'s gate does not, and it skips the check on a checkout.
17. **`uninstall` refuses while anything runs from what it would remove, asks
    once, then names what it could not remove.** It refuses while a process's
    command line names the shim or anything under `~/.lingtai`, while a process
    works in a directory under it, or while anything holds the conductor lock
    (`~/.lingtai/locks/`); an unreadable lock refuses unless `--nothing-conducts`
    answers for it. It warns before asking when the event log is a file it would
    remove. It reads the GitHub App before removing anything and ends with the
    App's slug, its installations, whether its key is gone and the settings link.
    `--yes` answers the question.

## Consequences

- A checkout and an installed copy are different things: the checkout runs
  source, the installed copy runs a ~145 MB binary.
- `pnpm test` includes board builds through `apps/release`.
- Old versions accumulate under `versions/` until uninstall; that is what makes
  rollback offline and safe under a running daemon.
- A domain that moves breaks new installs only; installed copies talk to GitHub
  Releases directly.
- The Node version must agree in three places: `.node-version`, `release.yml`
  and the machine building binaries.

## Not built yet

- `lingtai restart` does not work on an installed copy: `codeIdentity`
  (`packages/daemon/src/currency.ts`) needs a git checkout to name a commit,
  and an installed copy's identity would be its version.
- `lingtai service` writes a checkout's `apps/cli/src/lingtai.ts` path into its
  plist or unit, so a supervised daemon still needs a checkout.

---
*Replaces archived 0049, 0050, 0051 in [decisions-archive](../decisions-archive/).*
