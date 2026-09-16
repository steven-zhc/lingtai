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
> - **Node 22+**, `pnpm`, and the agent runtime you intend to use signed in.

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

### The Postgres lane is one URL, not two

`directDatabaseUrl()` is `required()` today and throws when unset, so a person
must supply both. [0009](../decisions/0009-two-connections.md) already licenses
the fix in its own text:

> On Supabase the second is the same host and credentials on port 5432 with the
> `pgbouncer` flag dropped. **On a plain Postgres the two may be identical.**

Two URLs are a Supabase artifact, not an architectural requirement. `DIRECT`
should fall back to `DATABASE_URL` when absent. **This stands on its own** — it
halves the Postgres install whether or not SQLite is ever built.

### What SQLite has to replace, and it is less than it looks

Verified against the code rather than assumed:

| | where | under SQLite |
|---|---|---|
| `append` / `read` / `readAll` | the whole `EventStore` interface — **three methods** | ordinary |
| `UNIQUE (stream_id, version)` | optimistic concurrency, which is the safety of the model | ordinary |
| the two projections | folds into tables, with **no `queryRaw` or `executeRaw` anywhere in production code** | nothing hand-written to port |
| `pg_try_advisory_lock` | `lock.ts` | `flock(2)` — and [0046 §1](../decisions/0046-lingtai-is-personal.md) moves it there for Postgres too |
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

## What is not decided here

- **How Lingtai is distributed.** `private: true` on both packages means there
  is no install to improve yet. A `curl` installer, an npm package and a
  Homebrew formula are three different answers and
  [0010](../decisions/0010-source-runs-unbuilt.md)'s *the source runs unbuilt*
  constrains all of them.
- **Whether SQLite gets migrations from day one.** The schema will change, and a
  personal database still has to survive that. `db:migrate` and `db:verify`
  exist; whether `migrations/app/…/ops.json` is Postgres-specific has not been
  checked.
- **Moving from SQLite to Postgres.** A person who starts alone and later wants a
  server will need it. The shape is free if nothing blocks it — the log is
  append-only and self-describing, so a move is `readAll`, `append`, and
  `projection rebuild`, all of which exist. **Writing that sentence down is
  worth more today than building the tool**, because its cost is entirely in
  not designing something that forecloses it.

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
