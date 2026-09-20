# 0051 — A version is a directory, and the shim is the only thing that moves

**Status** accepted · 2026-09-17 · installs [0050](0050-the-binary-is-a-sea-signed-ad-hoc.md)'s artifacts ·
uses [0042](0042-the-restart-is-a-command.md)'s drain

## Context

`#184`: installing meant cloning, filling five variables and running four
commands. `doc/design/1.0.md` step 9 asks for one line — the artifact for this
platform, unpacked, on `PATH` — plus upgrade, rollback and uninstall. #185
landed first: 0050 publishes a binary per platform, one board, and
`SHA256SUMS`, so what is unpacked is already decided and this decides where it
goes and how it moves.

## Decision

```
~/.lingtai/versions/<v>/
  lingtai          the binary, from lingtai-<platform>.tar.gz
  board/           from board.tar.gz, the same on every platform
~/.local/bin/lingtai   a symlink into versions/
```

**1. A version's directory is written once and never rewritten or removed by an
upgrade.** It is unpacked into a `versions/.<v>.partial-*` of its own, run once
(`lingtai version`'s second word must be `<v>`), and renamed — so a directory named for a
version is always a whole one that runs here, and two unpacks at once never
share one. One already present is used as it is: a process may be running from
it. Nothing but `uninstall` removes a version, and uninstall refuses while any
process's command line names the shim or anything under `~/.lingtai`, while any
process works in a directory under it, or while anything holds the conductor
lock — a daemon started from a checkout names none of those, and its worktrees
are under `~/.lingtai` all the same. The lock is a file under
`~/.lingtai/locks/` ([0052](0052-the-lock-is-sqlite-on-a-file.md)), so it is
asked whether or not a log is configured here — and only where that file cannot
be *read* is the question open, which refuses until it can be or
`--nothing-conducts` answers for it. Until #213 separated *is a log configured*
from *what is the Postgres URL*, this paragraph said that no log here meant the
lock could not be asked at all, and refused everything but `versions/` on it.

**2. The shim is the switch.** A new link beside it, renamed over it: a command
started between the two gets one version or the other. Upgrade moves it forward,
rollback moves it back, and neither fetches or deletes anything else. The
installer and the CLI refuse to replace a `lingtai` on `PATH` that is not a link
into `versions/`.

**3. A version is two of 0050's artifacts, both checked before either is
unpacked.** `lingtai-<platform>.tar.gz` — `macos-arm64`, `macos-x64`,
`linux-x64`, `linux-arm64`, `lingtai version`'s own names — and
`board.tar.gz`, each against `SHA256SUMS`, by the installer and by `upgrade`
alike. Nothing here packs or publishes: a tag does, in
`.github/workflows/release.yml`.

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
version still conducts; a refusal there changes nothing. Then, wherever a log is
configured, `lingtai doctor` gates as it gates a restart (`--despite-doctor`) —
whether or not anything conducts — and only where something holds the conductor
lock is `lingtai shutdown`'s drain asked and the lock waited on. A drain the
same person left standing — a Ctrl+C during an earlier upgrade's wait — is
lifted and asked again rather than waited on, as `lingtai restart` does: the
daemon holding the lock may have started since, and never reads a request
older than itself (#159). Where doctor refuses, the refusal names that standing
drain rather than saying nothing was asked to stop. The shim moves after the lock is free, and
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
