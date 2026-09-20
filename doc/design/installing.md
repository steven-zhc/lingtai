# Installing, for somebody who has never run it

**Status** analysis · 2026-09-16 · reads
[0046](../decisions/0046-lingtai-is-personal.md) as settled

Lingtai is a personal tool now, so the person installing it is one developer on
one laptop who wants an agent to work one ticket. This is what stands between
them and that, measured rather than remembered.

## What a stranger does today

[`tutorial.md`](../tutorial.md) opens with four prerequisites:

> - **Postgres of its own.** Not a database belonging to a project you manage.
> - **A GitHub App**, installed on the repository you want managed.
> - **Node 22.13+**, `pnpm`, and the agent runtime you intend to use signed in.

Then, in order:

```
git clone …                      there is no install — see below
cp .env.example .env.local       and fill in five variables
pnpm install
pnpm db:init && pnpm db:bootstrap
pnpm lingtai doctor
                                 …then a recipe committed to the target repo,
                                 lingtai add owner/repo, and a daemon started
```

**There is no install because Lingtai is not installable.** `package.json` and
`apps/cli/package.json` are both `"private": true`. You clone a repository and
run `node apps/cli/src/lingtai.ts`. That is the first requirement and no wizard
covers it.

## Three of the four prerequisites are already going away

| | |
|---|---|
| **A GitHub App** | [#169](https://github.com/steven-zhc/lingtai/issues/169) — GitHub's manifest flow makes it one click, and pre-fills 0006's permission table so it cannot be filled in wrong |
| **A recipe in the repository** | [0046](../decisions/0046-lingtai-is-personal.md) — nothing is written to the managed repository at all, so there is no commit, no pull request, and no team to persuade |
| **Node and pnpm** | an installer's job. Hermes installs Python, Node, ripgrep and ffmpeg from one `curl` line and the whole thing takes under five minutes on a fresh VPS |

**What is left is the database**, and it is the only one that is infrastructure
rather than configuration.

## The rule: absence chooses

```
LINGTAI_DATABASE_URL is set    →  Postgres
LINGTAI_DATABASE_URL is unset  →  SQLite, in ~/.lingtai/
```

No flag and no prompt. This is the same shape as `merge: []` meaning nothing
holds at the merge point — **the configuration is the choice**, and there is
nothing to get out of step with it.

### Where the rule goes: `logConfigured()`

One function, `packages/env/src/index.ts`'s, and it already exists —
[#213](https://github.com/steven-zhc/lingtai/issues/213) separated *is a log
configured* from *what is the Postgres URL* before anything was built on top.
Every caller that asks the first question asks it by name and reads a boolean;
`postgresUrl()` is the second question and is asked only by callers opening a
`pg` connection. So the rule above is a change to one body and to no call site.

It was worth a ticket of its own because the two questions were one function,
and *is there a log* was asked by catching *what is the URL* — a `try`/`catch`
that no type checks, so a store that needs no URL would have made three callers
in `apps/cli/src/entry.ts` start lying while still compiling. That cost five
passes and about $100 before it was separated out.

### The Postgres lane is one URL, not two

`directPostgresUrl()` was `required()` and threw when unset, so a person had
to supply both. [0009](../decisions/0009-two-connections.md) already licensed
the fix in its own text:

> On Supabase the second is the same host and credentials on port 5432 with the
> `pgbouncer` flag dropped. **On a plain Postgres the two may be identical.**

Two URLs are a Supabase artifact, not an architectural requirement. **Done in
#176:** an absent `DIRECT` is `DATABASE_URL`, a set one wins, the `TEST_` pair
falls back within itself, and `lingtai doctor` refuses a pooled URL standing in.
It stands on its own — it halves the Postgres install whether or not SQLite is
ever built.

### What SQLite has to replace, and it is less than it looks

Verified against the code rather than assumed:

| | where | under SQLite |
|---|---|---|
| `append` / `read` / `readAll` | the whole `EventStore` interface — **three methods** | ordinary |
| `UNIQUE (stream_id, version)` | optimistic concurrency, which is the safety of the model | ordinary |
| the two projections | folds into tables, with **no `queryRaw` or `executeRaw` anywhere in production code** | nothing hand-written to port |
| `pg_try_advisory_lock` | `lock.ts` | a file lock for Postgres too ([0046 §1](../decisions/0046-lingtai-is-personal.md)) — SQLite's, not `flock(2)`, which Node cannot call ([0052](../decisions/0052-the-lock-is-sqlite-on-a-file.md)) |
| **`LISTEN`/`NOTIFY`** | `subscribe.ts` | **the only missing primitive** |

And the missing one has a contract weak enough to be almost no contract at all.
`subscribe.ts:16`:

> **The notification is a nudge, not the payload.** `NOTIFY` carries the `seq`
> only … so a nudge triggers a drain of everything after `lastSeq`, not a fetch
> of the one row named. That is also what makes a coalesced or duplicated
> notification harmless.

The handler does not even read it — `client.on("notification", () => {` takes no
argument. So the replacement must say *something changed, go look*, and it may
be late, duplicated, or spurious. **A missed one costs five minutes**, because
`SWEEP_MS` is already the fallback and `work-loop.ts:21` says why:

> a webhook needs a public address and **this runs on a laptop**: it is an
> optimisation, and **an optimisation must not be the only path**.

Polling a local file every 100ms is therefore not a degraded implementation. It
is a correct one that is three thousand times faster than the fallback the
system already tolerates.

**The seam is half-built and that is the actual work.** `EventStore` is an
interface with a contract test and a second implementation
(`createMemoryEventStore`). `subscribe()` accepts an injectable store and then
constructs its own `pg.Client`; `acquireDaemonLock()` does the same behind the
`DaemonLock` interface. The types are abstract and the constructors are
concrete, and `Subscription.backendPid` puts a Postgres backend PID on a type
three callers consume.

**Write the contract before the implementation.** `test/contract.ts` governs the
store and nothing governs waking or locking, so today nothing would go red when
two implementations disagree. The file says why that matters:

> a fake held to a hand-written contract is **worth exactly the contract it is
> held to**

### The rule must not reach the test variables

`env/index.ts:145` refuses to run the suite without
`LINGTAI_TEST_DATABASE_URL`, and gives its reason:

> The suite writes real events, and writing them to the operator's own log
> leaves work items and board cards that **only deleting from an append-only
> table can remove**.

If *absence chooses SQLite* is implemented at that layer, `pnpm test:db` falls
back to SQLite and passes — a suite whose stated purpose is asserting Postgres
itself, green against something else. That is this repository's signature
defect, and the guard is one line away from it.

**Absence chooses for the application. It chooses nothing for the tests.**

## What the references do that we do not

[Hermes](https://hermes-agent.org/) and [OpenClaw](https://docs.openclaw.ai/start/wizard)
were read for this, and five habits are worth taking:

1. **The installer starts the wizard.** There is no second command to discover.
2. **A read-only detection pass comes first.** OpenClaw looks at what you already
   have — installed CLIs, reachable servers, configured keys — before asking
   anything. Lingtai can do the same: `doctor` already detects which agent
   runtime is signed in.
3. **An explicit choice before any credential is written.** Nothing is saved on
   a guess.
4. **Verify with a real call, not a paste.** OpenClaw tests a provider with a
   live completion, and **a failure returns to the choice rather than silently
   selecting another**. Lingtai's equivalent is a real GitHub call and a real
   append.
5. **It ends by starting the thing and opening the browser**, and an interrupted
   run resumes on the next one.

The fifth matters more than it looks. Lingtai's install currently ends at
`doctor` being green, which is a verification and not a result. **It should end
at the board being open in a browser.**

## `~/.lingtai/`, which mostly exists already

```
~/.lingtai/
  env/<project>.env        values, 0600                     exists
  runs/<project>/…         run logs, 0034                   exists
  repos/  worktrees/       the mirror and the blast radius   exists
  chats/                                                     exists
  lingtai.db               the log, when no DATABASE_URL     new
  <project>.yaml           the recipe (0046 §3)              new
```

Two new entries in a layout that has five, reached through `stateDir()` in
`@lingtai/env`. The recipe file **has no `gates` key** — not ignored, absent,
and a parse error if present. 0016 §4's distinction applies to configuration as
much as to gate points: a key that is silently ignored and a key that does not
exist are different facts to whoever wrote it.

## `doctor` has to answer *where did this come from*

Once a value can come from the recipe, the machine file, the environment or a
default, "what is my configuration" stops being answerable by reading one file.
`doctor` already prints provenance where it has it:

```
turns 300 ← applied by claude-code · wall 2h ← applied by claude-code
```

Every resolved setting needs that treatment, and the store needs it most:
**which database am I on, and where is it** must be one line at the top of
`doctor`, not something inferred from an absent variable.

## Three things now decided

**Distribution is a `curl` installer.** One line, a shell script, and it handles
the platform. [0010](../decisions/0010-source-runs-unbuilt.md) shapes it: the
source runs unbuilt, so there is no binary to ship and the installer's job is to
put a runtime and the source in place rather than to unpack a build. What it has
to guarantee:

| | |
|---|---|
| Node 22.13+ | `engines` says so — `node:sqlite`, which the lock is, is unflagged from there. Install it or refuse by name — never run and fail later on a syntax error |
| `pnpm` | `packageManager` pins `pnpm@11.9.0` |
| `git` | the mirror and the worktrees are git |
| the source | fetched, then `pnpm install` |
| `lingtai` on `PATH` | a shim running `node …/apps/cli/src/lingtai.ts` |

**The agent runtime is the one thing an installer cannot finish.** Signing in to
`claude-code` is interactive and belongs to the person. `doctor` already detects
it — *`claude-code` — signed in via claude.ai* — so the installer ends by
saying which state it found, and the onboarding continues or stops there with a
next action. That is OpenClaw's habit #4 applied to the one credential we cannot
mint.

**There is no migration, and switching stores starts a new log.** A person who
moves from SQLite to Postgres, or whose schema outgrows what is on disk, picks up
new tickets and leaves the old log where it is. Nothing is converted and no tool
is built.

**With one exception, and it is this repository.**
[0019](../decisions/0019-a-second-reset.md) allows a reset only while

> the log contains no run that anybody outside this repository depends on

and Lingtai's own log fails that test: `CLAUDE.md` says *a finding that cites a
seq number is worth more than one that argues*, and the ADRs and tickets do cite
them. **Switching this installation's store would turn those citations into
dangling references.** The rule is for the product; the exception is one log, and
it is named here so nobody has to rediscover it by losing it.

## What is still not decided

- **Which platforms the installer claims.** macOS and Linux are the floor;
  WSL2 is where Hermes stops and is probably where this should too. Saying so
  is cheaper than discovering it in an issue.
- **Whether SQLite gets migrations at all.** The schema will change and a
  personal database still has to survive that — but *survive* may mean
  `db:init` into a fresh file rather than a migration, given the paragraph
  above. `migrations/app/…/ops.json` has not been checked for Postgres-specific
  operations.

## Starting and stopping what was installed

**Two processes, one supervisor, and the CLI does not become a supervisor
itself.** `apps/cli/src/service.ts:12` is the reason:

> **Wrapping a service manager means inheriting its version churn**
> (openclaw#40550). So each verb is one or two calls to `launchctl` or
> `systemctl --user` … **No service manager is not an error to work around.** A
> container, an init that is not systemd: the answer is `lingtai daemon` in the
> foreground, **under whatever supervises that box**.

`launchd` supervises two jobs as easily as one. Merging the board into the
conductor to avoid supervising two would be the CLI taking on exactly the role
that file declines.

Built in #187; `doc/operating.md` is the reference, and this is the reasoning.

```
lingtai start                   conduct, foreground
lingtai shutdown [why]          drain, then stop            0030
lingtai restart [why]           the checked restart         0042

lingtai board start             serve the UI, print the URL, open a browser
lingtai board stop
lingtai board restart
lingtai board status

lingtai service install|start|shutdown [why]|restart [why]|status|uninstall     both jobs
```

**The conductor gets `shutdown`; the board gets `stop`, and the difference is
the point.** `shutdown` means *finish the pass in flight first*, which waits as
long as `runtime.limits.wall` — an hour here. A board has no pass to finish.
Giving it the same verb would make somebody wait for nothing, or believe the
conductor was draining when it was not. `restart` is the same: `lingtai restart`
refuses a `HEAD` the remote does not have, a dirty worktree and a red `doctor`
before it drains; `board restart` is stop-then-start and claims nothing more.

**`service status` reports each job separately.** The rule is already in
`service.ts:17` — *"The supervisor has the job loaded" and "a daemon is up and
taking work" are different facts … no verb concludes the second from the first* —
and two jobs make it sharper. One summary saying *running* would hide a board
that is up beside a conductor `launchd` respawns every thirty seconds.

**`board start` on a port already held says so in words.** The conductor has the
advisory lock for this (`#93`); the board had nothing, so the failure would be a
bare `EADDRINUSE`. It reads: *a board is already on 17820 —
http://127.0.0.1:17820*, the holder beside it, and where the port is set.

The board takes a lock too, in the end — the file locker of `#193`, keyed by
port — because *which process is serving the board* is a question `stop` and
`status` both have to answer and nothing else on this machine could. A lock the
kernel drops with its holder is the one mechanism here that leaves nothing
stale behind.

## Ports: one, reserved as two, and not higher

```
17820   the board
17821   reserved. Nothing binds it today — see below
```

**Bigger is not safer past 32768**, which is the one thing worth knowing here:

| | |
|---|---|
| macOS ephemeral | `49152–65535` |
| Linux ephemeral | `32768–60999` (default) |

A default in either range is handed out to other processes by the kernel, so it
would collide **at random, intermittently, and mostly not at all** — which is
harder to diagnose than a fixed clash. `10000–32767` is the band: high enough to
be clear of anything common, below both ranges. `18789` is OpenClaw's, `27017`
MongoDB's, `26257` CockroachDB's, `19999` Netdata's.

**Defaults are in code and require no configuration.** Built in #187:
`BOARD_PORT` and `RESERVED_PORT` are in `packages/env/src/index.ts`, and
`board.port` in `~/.lingtai/config.yml` overrides the first and need not exist.
The port used to be `apps/board/package.json`'s `next dev -p 3200`, which is
the wrong place: somebody who installed Lingtai does not edit its
`package.json`. ([0008](../decisions/0008-nextjs-board.md) named 3200 when the
board was only ever `pnpm dev`.)

### The daemon binds nothing, and that is the design

Verified 2026-09-16: `packages/daemon/src`, `packages/conductor/src` and
`apps/cli/src` contain no `node:http`, no `node:net`, no `createServer`. The
hook socket is a **unix socket path** (`hook-socket.ts:369`), and the liveness
beacon is a file (`#46`).

**Everything reaches the daemon through the log.** `pause`, `shutdown`,
`restart`, `approve`, `requeue` and `close` all append to a stream the daemon is
subscribed to; `doctor` asks whether a daemon is alive by reading a file, not by
calling an endpoint. That is `0014` and `0022` in practice, and it is why there
is nothing to `curl`.

`17821` is reserved rather than bound so that a second listener, if one is ever
needed, has an obvious home instead of being scattered. **Binding it today with
no use would be a port the next reader has to explain**, and the two ways that
ends — inventing a purpose, or deleting it — are both worse than an empty line
in this table. `packages/env/test/board-port.test.ts` reads every package's
`src` and fails if any mention of the number, or of the `RESERVED_PORT` that
holds it, is anything but prose — so the sentence above stays true rather than
merely having been true.

### The one consequence of two processes, named rather than fixed

**The GitHub webhook receiver is `apps/board/src/app/api/webhook/route.ts` — it
is the board's, not the daemon's.** So a board that is not running is a webhook
that is not received, and discovery falls back to `SWEEP_MS`.

`0006`'s consequence reads:

> Webhooks come with the App rather than needing separate configuration, **which
> is what makes discovery event-driven**.

Under two processes that is **conditionally** true, and the condition is that the
board is up. On a laptop it makes no observable difference — `work-loop.ts:21`
already says a webhook needs a public address and this runs on a laptop — so
nothing moves today. **It is written here because the day somebody gives the
board a public address, "event-driven" will quietly mean "while I have the tab
open", and the sentence that would have warned them is in an ADR that predates
the split.**

Moving the receiver to the daemon is what `17821` would be for. Not now.

## Related

- [0046](../decisions/0046-lingtai-is-personal.md) — one person, one Lingtai, one
  log. Why SQLite is the default rather than a concession.
- [0009](../decisions/0009-two-connections.md) — two connection strings, and the
  sentence that says one is enough on a plain Postgres.
- [0003](../decisions/0003-postgres-event-store.md) — chose Postgres, and is not
  superseded: it is still the right answer for anyone who wants a server.
- [`creating-the-app.md`](creating-the-app.md) — the other prerequisite, and
  [#169](https://github.com/steven-zhc/lingtai/issues/169).
- [`the-onboarding-wizard.md`](the-onboarding-wizard.md) — onboarding a
  *repository*, which is a different act from installing.
