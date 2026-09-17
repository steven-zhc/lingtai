# 0050 — A version is a directory, and the shim is the only thing that moves

**Status** accepted · 2026-09-17 · builds on [0049](0049-the-publishable-unit-is-dist.md) ·
uses [0042](0042-the-restart-is-a-command.md)'s drain

## Context

`#184`: installing meant cloning, filling five variables and running four
commands. `doc/design/1.0.md` step 9 asks for one line — the artifact for this
platform, unpacked, on `PATH` — plus upgrade, rollback and uninstall, and for
the shape to survive #185 replacing a directory of JavaScript with a binary.

## Decision

```
~/.lingtai/versions/<v>/
  lingtai          the entry: lingtai.cjs renamed today, a binary after #185
  board/           standalone, the same on every platform
  package.json     what `lingtai version` reads
~/.local/bin/lingtai   a symlink into versions/
```

**1. A version's directory is written once and never rewritten or removed by an
upgrade.** It is unpacked into `versions/.<v>.partial`, run once (`lingtai
version` must say `<v>`), and renamed — so a directory named for a version is
always a whole one that runs here. One already present is used as it is: a
process may be running from it. Nothing but `uninstall` removes a version, and
uninstall refuses while any process's command line names `versions/` or the shim.

**2. The shim is the switch.** A new link beside it, renamed over it: a command
started between the two gets one version or the other. Upgrade moves it forward,
rollback moves it back, and neither fetches or deletes anything else. The
installer and the CLI refuse to replace a `lingtai` on `PATH` that is not a link
into `versions/`.

**3. A release is four tarballs and `SHA256SUMS`.** `pnpm release <v>` packs
`lingtai-<v>-{darwin,linux}-{arm64,x64}.tar.gz`. Today the four hold the same
bytes, because nothing in them is native (0049); the names are per platform so
that #185 changes what is inside and not what is asked for. **The checksum is
checked before unpacking**, by the installer and by `upgrade` alike. Publishing
is `gh release create`, by a person.

**4. `install.sh` is served by the site**, as `apps/site/public/install.sh`, so
`https://lingtai.dev/install.sh` is a static file. It detects the platform and
refuses anything else by name, asks `releases/latest` unless `LINGTAI_VERSION`
says, and edits no shell profile.

**5. `version`, `upgrade`, `rollback` and `uninstall` need no log.** Every other
command loads `@lingtai/event-store`, which throws without a database URL at
import. `apps/cli/src/entry.ts` answers these four first and imports
`lingtai.ts` for the rest; it is now the CLI's `bin`, `pnpm lingtai`, and what
the bundle is built from.

**6. `upgrade` does what can fail first, then drains, then switches.** The
question, the download, the checksum and the trial run all happen while the old
version still conducts; a refusal there changes nothing. Then — only where a log
is configured and something holds the conductor lock — `lingtai doctor` gates as
it gates a restart (`--despite-doctor`), `lingtai shutdown`'s drain is asked,
and the command waits on the lock. The shim moves after the lock is free, and
the drain is withdrawn. **It starts nothing**: `lingtai start` runs the new
version. It does not call `lingtai restart`, which refuses a start with no
checkout to name a commit from — every installed copy — and holds a daemon in
its terminal.

**7. Which release is newest is asked by `lingtai upgrade` and `lingtai doctor`
only** — the one outbound request this tool makes on its own account. Doctor
asks it in the command, not in `runDoctor`, so `restart`'s gate does not; and
it does not ask from a checkout.

**8. Uninstall asks once, then names what it could not remove.** The App is
read *before* anything is removed — the key it signs with may be under
`~/.lingtai` — and the command ends with its slug, how many repositories it is
still installed on, whether its key is gone, and the settings link. Where a log
is configured, it says the database is untouched.

## Consequences

- **`lingtai restart` does not work on an installed copy yet**: `codeIdentity`
  has no commit to read. An installed copy's identity is its version, and
  teaching the restart that is its own change.
- **`lingtai init` is not built** (1.0 step 11), so the installer ends by
  pointing at `lingtai doctor` rather than running it.
- An installed copy reads `.env.local` from `~/.lingtai/versions/` — one
  directory above its entry, 0049's rule — which is at least shared by every
  version. Where configuration really lives is `init`'s question.
- `lingtai service` still writes a checkout's path into its plist or unit; for
  an installed copy that is step 12.
