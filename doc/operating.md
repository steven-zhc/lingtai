# Operating Lingtai

Everything you actually type, moved out of the README on 2026-09-08 so that the
README could be the shortest true description of what this is. Nothing here was
deleted; the sequence is unchanged. What *was* changed is the handful of places
this text had gone stale against
[0022](decisions/0022-the-seams.md) and
[#60](https://github.com/steven-zhc/lingtai/issues/60) — the package names, the
`RESERVED` denylist, the outbox, and the third environment layer. Each of those
is marked where it appears.

If you have never run this, read [tutorial.md](tutorial.md) first: it is the
same path with none of the reasons. This file is the reasons.

---

## What it writes to disk

**Nothing in your checkout of the managed repository.** `lingtai add` takes a
GitHub coordinate — `steven-zhc/nextloom-ai-admin` — not a local path, and
Lingtai clones its own copy. Your working tree is never read, never written
and never looked at, which is the whole reason the integrator exists: the old
harness merged in the operator's own checkout, and uncommitted work there is
what made #58 and #59 re-run five times for roughly $29 with nothing reporting
why.

Everything lives under `LINGTAI_HOME`, which defaults to `~/.lingtai`:

```
~/.lingtai/
├── config.yml                   this machine: the database URL, the agent, limits, ports
├── <project>/recipe.yml         the recipe — gates, kinds, env names  — persistent
├── env/<project>.env            your values, per project — persistent
├── repos/<project>.git          bare mirror — persistent
├── worktrees/<project>/<runId>  one per run — disposable
├── runs/<runId>/settings.json   the hook wiring
├── runs/<project>/<runId>.log   what a run is doing, while it does it
└── locks/                       the conductor, the board, a merge lane, a decision
```

| | Lifetime | Why there |
|---|---|---|
| `config.yml` | Persistent | **This machine's half of the recipe** — `runtime.agent`, `runtime.limits`, `runtime.assignee`, `database.url`, `board.port`. Written by `lingtai init`, a value at a time, each after it was verified. |
| `<project>/recipe.yml` | Persistent | **The recipe, and it is yours** ([0046](decisions/0046-lingtai-is-personal.md) §3). Outside every worktree, so an agent cannot reach the rules of its own run — which is what `tamper` used to guard and no longer has to. |
| `env/<project>.env` | Persistent | **Yours, and the one layer the managed repository cannot write.** One connection string per project, so two projects can want the same variable name and mean different things — see [The layers](#the-layers). Not re-clonable; the one thing here worth backing up. |
| `repos/<project>.git` | Persistent | Expensive. The first clone is a network round trip; after that every run is a `fetch`. This is why cutting a worktree took 1.7s in [experiment 005](experiments/005-rung-1-reaches-a-real-repository.md). |
| `worktrees/<project>/<runId>` | One run | Cheap. Cut from the mirror, removed when the run ends — and removed *before* the integrator runs, because a worktree holding `agent/<n>` checked out stops git updating that ref. |
| `runs/<runId>/settings.json` | One run | **Outside the worktree, deliberately.** An agent that can edit its own hook configuration has no hook configuration. |
| `runs/<project>/<runId>.log` | While it is owed | What `lingtai attach` and the task page's *run log* tail. **A trace, never a record**: it asks the daemon and the database nothing, so it answers on a stopped system — and a run that landed has no log, because [0034](decisions/0034-the-run-log.md) keeps only the ones still owed an explanation. |
| `locks/` | While held | One file per lock — the conductor's, the board's, a merge lane's, a decision's. **Not anything in Postgres** ([0052](decisions/0052-the-lock-is-sqlite-on-a-file.md)): each person runs their own Lingtai against their own log, so a lock scoped to one database would have answered `ok` while the real competitor was on somebody else's laptop. |
| `$TMPDIR/lingtai/*.sock` | One run | The hook's socket. In `$TMPDIR` rather than under `LINGTAI_HOME` because a unix socket path has a hard 104-byte limit and a home directory plus a run id exceeds it — see [ADR 0011](decisions/0011-hook-latency-is-runtime-startup.md). |

Two things in this repository are also not committed: `.env.local`, and
`packages/hook/bin/lingtai-hook` — a 55 MB compiled binary that `pnpm --filter
@lingtai/hook build` produces.

**`rm -rf ~/.lingtai/repos ~/.lingtai/worktrees ~/.lingtai/runs` is safe.**
Everything in those is either re-clonable from GitHub or belongs to a run that is
over. The part that matters — the event log — is in Postgres, and none of it is
here. **`config.yml`, `<project>/recipe.yml` and `env/` are the exception**: you
wrote all three, nothing else has a copy, and deleting them leaves a machine
with no recipe for any project and no value for any name it requires — each
refused by name until you write it again.

[#18]: https://github.com/steven-zhc/lingtai/issues/18
[#19]: https://github.com/steven-zhc/lingtai/issues/19
[#20]: https://github.com/steven-zhc/lingtai/issues/20
[#28]: https://github.com/steven-zhc/lingtai/issues/28

## Getting started

```bash
pnpm install
cp .env.example .env.local        # then paste the connection string
pnpm contract:emit                # offline — no database needed
pnpm typecheck
```

`.env.local` lives at the repo root and is gitignored. A real environment
variable beats it, which is what makes CI and launchd work with no file at all.

**One database, and on a plain Postgres one connection string** (#176).
`LINGTAI_DATABASE_URL` is for ordinary queries; `LINGTAI_DIRECT_DATABASE_URL` is session mode, for migrations and `LISTEN/NOTIFY`
— not for locks, which are files under `~/.lingtai/locks` and never Postgres (0052). Unset, the direct one is `LINGTAI_DATABASE_URL`; set, it
wins. It is needed only when the first goes through a transaction pooler —
Supabase's, PgBouncer — which breaks both, and breaks them without
erroring; `lingtai doctor` refuses a pooled URL standing in. See
[ADR 0009](decisions/0009-two-connections.md).

The event store must be **its own database**, not one belonging to a managed
project — Lingtai has to keep running while a managed project is the thing
being changed.

**The tests need their own string, and refuse to run without it.**
`LINGTAI_TEST_DATABASE_URL`, and `LINGTAI_TEST_DIRECT_DATABASE_URL` behind a pooler, point at a *different*
database — the pair falls back within itself, never to the operator's. The suite is not mocked — it appends real events, runs real
projections — so pointed at your own log it
leaves work items and board cards behind. It did: twenty-four cards from ten
throwaway `esctest*` projects, and none from a real one. Cleaning that up is
not cheap either, because rebuilding a projection replays the log and brings
the cards straight back; the only way to remove them is to delete from an
append-only table.

Give the test database its schema the same way the main one gets it, with
`LINGTAI_TEST=1` in front — see [Bringing the database up](#bringing-the-database-up).

**And a fifth place, if Lingtai is to work on Lingtai.** An agent working this
repository has to run this suite, so its recipe requires the two
`LINGTAI_TEST_*` names — and a `LINGTAI_` name never crosses from the machine
file, whatever a recipe declares. Copy them into the project's own file:

```bash
mkdir -p ~/.lingtai/env
grep '^LINGTAI_TEST_' .env.local > ~/.lingtai/env/lingtai.env
```

Without it, every run against this repository refuses by name before it claims
anything. `pnpm lingtai doctor` says which layer each name came from. See
[The layers](#the-layers).

**Empty its log now and then.** The suite cleans up its own streams but the log
only grows, and one test rebuilds a projection — which replays the whole log, so
its cost is the log's length. After a few weeks that test crossed its 60s
timeout and started failing for reasons unrelated to the code it covers.

```bash
LINGTAI_TEST=1 pnpm --filter @lingtai/event-store db:reset-test
```

It refuses twice over if you point it at anything else: the flag has to be set,
*and* the string it resolves has to differ from the one without the flag.

### Bringing the database up

> **`lingtai init` does this, and this section is what it does.** Since
> [#186](https://github.com/steven-zhc/lingtai/issues/186) one command takes a
> bare machine to the board: it asks for the URL, connects, creates the tables,
> and only then writes the URL into `~/.lingtai/config.yml` — nothing is written
> before its choice has been verified. The two scripts below are still here and
> still work; from a checkout they are the same thing with the steps visible.

Prisma 8 splits planning from applying. Planning is offline; only the second
half needs a reachable database.

```bash
pnpm db:init                      # create the tables and sign the database
pnpm db:bootstrap                 # apply NOTIFY_SQL, then prove it worked
```

The test database takes the same two, with `LINGTAI_TEST=1` in front of each
so they resolve `LINGTAI_TEST_DIRECT_DATABASE_URL` instead.

`db:bootstrap` is not optional and is not Prisma's job. Prisma models tables, not
triggers, so `NOTIFY_SQL` in `packages/event-store/src/schema.ts` — no longer a
`.sql` file, so `psql -f` has nothing to read — carries the two things the
schema cannot express: the `NOTIFY` trigger every subscriber wakes on, and the
rules that make `events` append-only in the database rather than by convention. The script then asserts
ten properties, including a **cross-connection** NOTIFY — the check that catches
a transaction pooler, which drops notifications silently.

An initial migration is already planned and committed; `db:plan --name <slug>` is
only needed after the contract changes.

### Checking it

```bash
pnpm lingtai doctor                   # non-zero exit on any failure
pnpm lingtai projection lag           # how far each projection is behind the log
```

`lingtai doctor` never writes to the event log — every check reads the catalogue,
and the one exception is a `NOTIFY`, which touches no table. It holds a listener
open, pauses long enough for a pool to churn, and notifies from a second
connection, because a check that merely opens the direct connection passes
against a transaction pooler and proves nothing
([experiment 003](experiments/003-doctor-catches-a-pooler.md)).

Checks that depend on code Phase 1 has not written yet print as `skip`, naming
the issue that will fill them in.

## Connecting GitHub

Lingtai talks to GitHub as a **GitHub App**, not as a personal access token.
The reason is a measured failure: on 2026-08-30 a fine-grained PAT covered the
admin repository's *submodule* but not the repository itself, and every CI run
failed with a 403 that said nothing about scope. An App's reach is explicit in
its installation, so `lingtai add` can ask and answer that question at onboarding
time instead of a day later. See
[ADR 0006](decisions/0006-github-app.md).

**One click does steps 1, 2 and 4 of this section** (`#169`). Open the board
with nothing configured and it links to `/setup/github-app`, which posts an App
*manifest* to GitHub: you name the App on GitHub's own screen, press **Create
GitHub App**, and GitHub hands the credentials back — the page writes the id,
the webhook secret and the private key at `0600`, and never shows you the key.
The permissions below are in the manifest, so they are not a question and
cannot be answered wrong, which is the whole of why 0006's founding failure
cannot happen on that path.

Nothing has to be restarted afterwards. `hasGitHubApp()` and `githubApp()` read
the App ID and the key path from `.env.local` on disk whenever the environment
does not set them, so the App is usable at once — by the board that wrote it and
by a daemon that was already running. A variable set in the environment still
wins over the file.

**What is below is the fallback, and it stays one.** A person may prefer to
create the App themselves; an organisation role that cannot create an App has
no other path; and the manifest flow does not support **enterprise-owned**
Apps at all. Installing it — step 3 — is the same either way.

What cannot be automated on either path is the browser: a human presses
*Create GitHub App*, by design, and the private key it hands you is a real
secret.

### 1. Create the App

Go to **Settings → Developer settings → GitHub Apps → New GitHub App**
(<https://github.com/settings/apps/new> for a personal account).

| Field | What to put |
|---|---|
| **GitHub App name** | Anything free — it is globally unique. `lingtai-<your-handle>` works. |
| **Homepage URL** | Required by the form and otherwise unused. The repository URL is fine. |
| **Webhook → Active** | **Uncheck it.** Webhooks arrive with [#28](https://github.com/steven-zhc/lingtai/issues/28); until then there is nothing listening and a failing delivery is noise. |
| **Where can this App be installed** | *Only on this account.* |

Then, under **Repository permissions**, set exactly these four:

| Permission | Level | What Lingtai does with it |
|---|---|---|
| **Issues** | Read and write | reading work items, writing `agent:*` labels and comments |
| **Contents** | Read and write | cloning, pushing `agent/*`, merging into the base branch |
| **Pull requests** | Read and write | opening and reading pull requests |
| **Metadata** | Read-only | mandatory; GitHub selects it for you |

Leave every other permission at *No access*. `lingtai add` checks these four by name
and refuses to onboard a repository that is missing one, so a gap becomes a
message at onboarding rather than a 403 in the middle of a merge.

Click **Create GitHub App**.

### 2. Take the App ID and a private key

On the App's **General** page:

- **App ID** — a number near the top. This is `LINGTAI_GITHUB_APP_ID`.
- **Private keys → Generate a private key** — this downloads a `.pem` file, and
  GitHub will not show it to you again.

Move the `.pem` somewhere **outside this repository**. It is the one credential
that is not short-lived, and `.gitignore` is not a place to rely on for it:

```bash
mv ~/Downloads/lingtai-*.private-key.pem ~/.lingtai-app.pem
chmod 600 ~/.lingtai-app.pem
```

### 3. Install it on the repositories it should manage

**Install App** in the left sidebar → your account → **Only select
repositories** → pick each repository Lingtai will manage.

An App that exists but is not installed on a repository is the exact failure
0006 is about, and `lingtai add` reports it as such:

```
the GitHub App is not installed on steven-zhc/nextloom-ai-admin. Install it on
that repository (Settings → GitHub Apps → Configure), then run lingtai add again.
```

### 4. Point Lingtai at it

In `.env.local` at the repository root:

```bash
LINGTAI_GITHUB_APP_ID=123456
LINGTAI_GITHUB_APP_PRIVATE_KEY_PATH=~/.lingtai-app.pem
```

`~` is expanded, and a relative path is relative to *this repository's root* —
not to whichever directory you ran the command from. Where only a single-line
value can be carried, `LINGTAI_GITHUB_APP_PRIVATE_KEY` takes the PEM itself with `\n`
escapes instead.

No installation id is needed. It is looked up per repository, which is what
turns "the App is not installed there" into a sentence rather than a 404.

Check it:

```bash
pnpm lingtai doctor
```

```
  ok   github: app credentials
       app 123456, key from ~/.lingtai-app.pem · requires issues:write,
       contents:write, pull_requests:write, metadata:read (verified per
       repository by lingtai add)
```

That check parses the key to prove it is a key rather than a path typo or a
truncated paste. It does **not** contact GitHub — whether an installation
actually grants those four permissions is a per-repository question, and
`lingtai add` is what asks it.

## Onboarding a repository

### 1. Write the recipe — on this machine, not in the repository

```
~/.lingtai/<project>/recipe.yml
```

**Nothing is committed to the repository being managed.** The recipe is yours
([0046](decisions/0046-lingtai-is-personal.md) §3,
[#180](https://github.com/steven-zhc/lingtai/issues/180)), and the board's
wizard writes a first one for you by reading the repository — its scripts, its
labels, its default branch.

> **This replaced `<repo>/.lingtai/config.yaml`, and the reason is worth
> keeping.** That file was read **from the base branch**, never from the branch
> an agent was working on, so an agent that edited it changed nothing about the
> run in flight — [ADR 0005](decisions/0005-config-in-target-repo.md), borrowed
> from GitHub Actions. The guarantee is now held by *location* instead: an
> agent's blast radius is its worktree, and `~/.lingtai/` is not in it. A
> `.lingtai/config.yaml` still sitting in a managed repository is an ordinary
> file — nothing reads it, and editing it changes nothing.

Write this file:

```yaml
version: 1

repo:
  base: develop
  # `git worktree add` does not populate submodules, and a worktree without them
  # fails every test that imports one — which reads on the board as though the
  # agent broke them.
  submodules: true

source:
  # Both lists are yours. Any label of this repository's may appear in either;
  # Lingtai keeps no vocabulary of its own and enforces nothing about the names
  # (#76). `kinds` is also the priority order: earlier wins.
  kinds: [bug, tech-debt]
  # Labels of yours that keep the agent off a ticket.
  exclude: [blocked, needs-design]

env:
  # Variable NAMES only, never values — the values are in
  # ~/.lingtai/env/<project>.env, at 0600, which is the one layer nothing else
  # writes.
  #
  # `required` means what it says: a name here with no value in any layer
  # refuses this project for the whole pass, before an issue is claimed and
  # before an agent is started.
  required:
    - LOCAL_DATABASE_URL
    - CLERK_SECRET_KEY
  # Rarely the repository root: Next, Prisma and vitest read it from the app
  # directory.
  plantAt: apps/web/.env.local

# Five keyed points, not an array. This example predated
# [0016](decisions/0016-the-settled-model.md) and said `- kind: process`, which
# the schema now rejects.
gates:
  admit: []
  prepared: []
  proposed:
    - name: build
      run: pnpm verify
      timeout: 15m
  merge:
    - name: approval
      human: Merge {branch} into {base}?
  end:
    - name: close the ticket
      when: landed
      close: true
```

**There is no `runtime:` block here, and writing one is refused rather than
ignored.** `runtime.agent`, `runtime.limits` and `runtime.assignee` are facts
about *this machine*, not about this repository, so they live in
`~/.lingtai/config.yml` ([0046](decisions/0046-lingtai-is-personal.md) §3):

```yaml
runtime:
  agent: claude-code
  limits: { turns: 300, wall: 2h, rounds: 2, restarts: 0 }

projects:
  nextloom-ai-admin:
    runtime:
      limits: { wall: 2h }      # this one repository, over the machine's own
```

Left in the recipe, each is named back at you —
`runtime.agent: moved to this machine (0046 §3) — write it in
~/.lingtai/config.yml … Nothing here was applied` — and `gates:` written in the
machine file is refused the same way. **Both files refuse what belongs in the
other**, because a key silently dropped and a key that does not exist are
different facts to whoever wrote it ([0016](decisions/0016-the-settled-model.md)
§4), and a gate that reads as declared while holding nothing is a way to weaken
a gate quietly.

> [0053](decisions/0053-the-recipe-chooses-the-agent-for-each-role.md) moves the
> agent and the limits back into the recipe, per *role* — development,
> discussion, and each agent gate. It is accepted and **not implemented**: the
> refusal above is what `main` does today.

A shorter form, if the project is an ordinary pnpm workspace:

```yaml
version: 1
extends: pnpm-workspace
repo:
  base: develop
source:
  kinds: [bug]
env:
  required: [LOCAL_DATABASE_URL]
  plantAt: apps/web/.env.local
```

`extends` fills in the submodule default, a `pnpm verify` build gate and the
runtime. It resolves to the same run as spelling all of it out, and hashes the
same — a preset's *name* is not part of what a run does, so it is not part of
the hash.

Four action kinds produce a verdict, and all four run. `run` and `human` need
nothing from the caller; `agent` needs a reviewer and `watch` needs the diff's
file list, and `run-once` supplies both. A recipe naming a kind whose dependency
is missing is **refused** by name rather than skipped — a pipeline that silently
dropped a human approval would put a green board on a change nobody approved.
(`close` and `labels` are the other two: effects, not verdicts, and only at
`end`.)

#### The layers

The recipe declares **names**. The values come from two files with two different
owners, merged in order — later wins:

> **Changed by [#60](https://github.com/steven-zhc/lingtai/issues/60).** There
> were three layers and the first two were `process.env` — whatever the
> conductor happened to be started with. **The shell is no longer a layer.** Two
> files remain, merged in order, later wins:

| | Source | Who owns it | Example |
|---|---|---|---|
| 1 | `~/.lingtai/env/<project>.env` | you, per project | `LOCAL_DATABASE_URL` |
| 2 | the workspace's `.env.local`, then `.env` | the repository | whatever it declares |

```bash
lingtai env set nextloom-ai-admin LOCAL_DATABASE_URL=postgresql://localhost:5432/admin_dev
lingtai env set nextloom-ai-admin API_TOKEN     # no value: read from stdin, unechoed
lingtai env list nextloom-ai-admin              # names and their layer, never values
lingtai env unset nextloom-ai-admin API_TOKEN
```

`set` creates the directory and the file, replaces one line without touching
the others or their comments, and leaves the file `0600`. Giving it no value is
the case worth having: the value is read from stdin without being echoed, so a
connection string never becomes a word in your shell history. The value is
written literally — nothing expands it and a `#` cannot truncate it — and there
is deliberately no `--from-file`, because copying an application's whole `.env`
is exactly how a `PROD_DATABASE_URL` reaches an agent. Writing the file by hand
still works; the command is only the four things it saves getting wrong.

The per-project file exists because a shell has one global home: two projects
wanting `DATABASE_URL` to mean different things cannot both be expressed in it.
That is also why the shell was dropped rather than kept as a fallback — a value
that reaches an agent because of how you happened to start a process is a value
nobody can audit from the recipe.
A `!` prefix on a value is reserved for a secret source (`SECRET=!op read
op://…`), which is not built — quote a value that really does begin with one.

**A name Lingtai uses for itself is one no application asks for.** Every one of
them begins `LINGTAI_` — `LINGTAI_DATABASE_URL`, `LINGTAI_TEST_*`,
`LINGTAI_GITHUB_APP_*` — so a recipe written by the repository an agent is
editing has nothing generic to reach for, and a project whose own file is
missing a `DATABASE_URL` line gets an **absent** value rather than silently
inheriting Lingtai's log under a name its application would connect to.
`required` refuses that loudly, before anything is claimed.

`RESERVED` — a denylist in the source that used to do this job the older way —
is **gone**, deleted with `#60`. The prefix is what made removing it safe, and
`env.allow` / `env.deny` in the recipe are what decide now. A guard nobody could
see from the recipe was a guard nobody could audit from the repository it
protects.

**A declared name with no value refuses the whole project for that pass**, before
the issue is claimed: no worktree, no agent, no money. This used to be a log
line, and one run spent $0.97 over ten turns against a database it could not
reach. See [0021](decisions/0021-the-recipe-decides-the-environment.md), which
supersedes 0020.

```bash
pnpm lingtai doctor    # per project: every required name and which layer it came from
```

`doctor` prints names and layers, never values.

### 2. Register it

```bash
pnpm lingtai add steven-zhc/nextloom-ai-admin
```

It checks the installation and its permissions **before** it writes anything, so
a half-onboarded project is not a state that exists. Then it reads the recipe,
hashes it, and records `ProjectConfigured`.

**Or from the board, in any state it is in.** The `+` at the end of the project
list on the bar goes to `/setup/repository` once the App exists and to
`/setup/github-app` before it — so a second repository is something the console
can do, and not only the first one (`#216`). Until then the slot was an entry
with no projects, a caption with one and a filter with two, and the only route
left was this command or typing the wizard's path from memory.

There is nothing else to write. The tier, the gates, the priority order **and the
base** are all the recipe's, in `~/.lingtai/<project>/recipe.yml` — which is why
this command takes a slug and nothing more, and why it reads nothing from the
repository to do it.

`--base` is a **bootstrap hint, and it is not a second way of saying what the
base is.** The file's own `repo.base` decides, and that is what gets recorded:

| `--base` | what happens |
|---|---|
| omitted | the repository's default branch is the hint; the recipe's `repo.base` is adopted and **that** branch is recorded |
| given, agreeing with `repo.base` | unchanged |
| given, disagreeing | refused, naming both branches, before anything is written |

```
pnpm lingtai add steven-zhc/nextloom-ai-admin --base main
--base main, but ~/.lingtai/nextloom-ai-admin/recipe.yml declares repo.base: develop.
This command will not overrule either — re-run without --base to take the recipe's,
or fix repo.base in the file.
```

**Only a branch a *person* typed earns that refusal.** A branch the system
remembered — the one `ProjectOnboardingStarted` recorded, replayed by the
board's *Recheck* — is a hint and is quietly adopted, because there is no flag
for a button to omit and the refusal's advice would name something nobody typed.

Editing `repo.base` afterwards re-creates the disagreement, and a run refuses on
it rather than obeying a base nobody confirmed (`lingtai doctor` has the same
check).

### 3. Check it

```bash
pnpm lingtai status nextloom-ai-admin              # what is runnable, and what is holding the rest
pnpm lingtai status nextloom-ai-admin --refresh    # ask GitHub first
```

Without `--refresh` this answers from the queue projection, which nothing writes
to until a run or the daemon has taken a pass — so on a freshly registered
project it says `queue: empty` however much work GitHub is offering. `--refresh`
asks GitHub, writes the queue, and reports **what it passed over and why**:

```
nextloom-ai-admin  base=develop
  nextloom-ai-a  recipe 3f8a1c2b9d04 from develop
    picks up     bug > enhancement   (in priority order)
    excludes     blocked, needs-design
  from GitHub: 9 eligible, 29 passed over — excluded-label 29
  queue: 9 runnable
    #154   bug         [Bug] The resolve-aliases destination search has no request sequencing…
    #110   enhancement [Enhancement] /users still prints async job ids to copy…
```

The first three lines are **what this project will and will not take**, and
`lingtai start` prints the same block for every registered project at startup,
from the same function, before it takes anything. A project whose recipe will
not resolve gets that slot rather than being left out:

```
lingtai        RECIPE INVALID — ~/.lingtai/lingtai/recipe.yml is not valid: source.kinds.3: Invalid option
               nothing will be taken from this project
```

That case used to be an empty queue and nothing else (#76), which is
indistinguishable from a repository with no work. `lingtai doctor` now fails on
it too.

It takes nothing, claims nothing and appends no event — the whole of what it
does is make the answer current. The absences are the half worth having: an
issue nobody is working on has a reason, and that reason is the recipe's.

One of those reasons is the repository's rather than the recipe's.
`blocked-by 1` is an issue GitHub says is still blocked by an open one, and it
is counted on the same line:

```
  from GitHub: 9 eligible, 30 passed over — excluded-label 29, blocked-by 1
```

The queue orders by kind and then by number and knows nothing about a chain, so
`#123` — `tech-debt` — was taken ahead of the two `feature` tickets it depended
on, and an agent was dispatched against groundwork that did not exist (#131).
Record a chain with GitHub's own **blocked by** on the issue, not as a table in
a body: prose is for people and the queue cannot read it. Nothing is stored on
this side — the ticket is offered again the pass after the last blocker closes,
exactly as removing `agent:hold` works.

A closed blocker does not hold anything, and a repository whose GitHub reports
no dependencies at all is told so once rather than having every ticket quietly
treated as clear:

```
  (GitHub reported no issue dependencies for this repository — nothing is held by a blocker)
```

That case behaves exactly as it did before dependencies were read, which is why
it has to be said. When GitHub summarises most issues and not some, the line
names those instead — `GitHub sent no dependency summary for #122 — it is not
held by a blocker` — rather than claiming the whole repository is unread beside
a `blocked-by` count that says otherwise. The board's Queued column carries the
same two lines per project, from the same functions, and a queued ticket's own
page repeats the second under its place in line.

Onboarding is done. How you actually run work is next.

## Running work

Two things have to exist before anything runs, and both refuse loudly rather
than degrading:

```bash
pnpm --filter @lingtai/hook build      # the hook binary; not committed
pnpm lingtai board start               # the board, on :17820
```

From a checkout with no `pnpm build` behind it there is no built board to
serve, and `board start` says so: `pnpm --filter @lingtai/board dev` is the
one to run there, on the same port.

The board is a reader. It renders `task_view` and issues control events; it
never holds a run, which is why restarting it or closing the tab costs nothing
— see [ADR 0013](decisions/0013-daemon-hosts-the-work.md).

A run without the hook binary does not start. The binary is not committed, so
building it is a real step.

> **Changed by [0016](decisions/0016-the-settled-model.md).** This section used
> to describe a **guard** — a policy list Lingtai kept and enforced on every tool
> call — and a `--no-guard` flag for turning it off. Both are gone. Lingtai
> restricts no tool call and keeps no such list; `--no-guard` is not a flag, and
> passing it does nothing.

The hook remains, and it is a *channel*, not a sandbox: the agent reaches the
log through it, and it fails closed when it cannot reach the socket. It is not
a security boundary and never was. **The two boundaries that actually hold are
the filtered environment and the disposable worktree** — neither was ever the
guard's, and both still hold ([0007](decisions/0007-dual-runtime.md)).

Tool limits belong to the agent runtime's own configuration —
`permissions.deny` in `~/.claude/settings.json` or in the managed repository's
`.claude/settings.json` — which holds even under `bypassPermissions`, because it
removes the tool from the model's list so nothing is ever attempted
([experiment 008](experiments/008-deny-survives-bypass.md)).

### Run one, and stop before it writes

The first thing to do with a repository, and the thing to keep doing until you
trust it:

```bash
pnpm lingtai run nextloom-ai-admin --issue 120 --no-merge
```

Discovery, claim, worktree, the `prepared` point, agent, the remaining gates — then it **stops** and asks.
The branch is pushed and every verdict is recorded; nothing is merged. You get:

```
held at 8f3a1c2 — wi-nextloom-ai-admin-120 is waiting on you
nothing was merged. Re-run without --no-merge to merge it.
```

### Let the daemon do it

```bash
pnpm lingtai start
```

> `lingtai daemon` still answers and is the name this used to have. A
> LaunchAgent or systemd unit already on disk has it written into its plist,
> and renaming a command must not stop a supervisor that is already running
> (#159). `start` is the name.

One process, holding one lock — a file under `~/.lingtai/locks`, not anything in Postgres. It keeps the projections current and
takes work: a completion event — landed, released, blocked, refused — is what
tells it to pick the next one up, so the loop advances by itself with no timer
anywhere.

Running it while another copy is up is fine; the second exits saying who holds
the lock.

```bash
pnpm lingtai pause "the importer is flaky today"   # take nothing new
pnpm lingtai resume
pnpm lingtai shutdown "picking up #88"             # finish the pass, then stop
pnpm lingtai restart "picking up #88"              # …and start one again, checked
pnpm lingtai now nextloom-ai-admin --issue 155     # one, ahead of the queue
```

**Pause stops it taking new work; a run in flight finishes.** Killing a running
agent is not implemented — a run you want gone ends when the conductor holding
it does, and the next one to start releases the claim it left. Said plainly
because a Stop button that means Pause is worse than no Stop button.

**Shutdown is a pause the process does not come back from**
([0030](decisions/0030-shutting-down-safely.md)). It appends and returns; the
daemon reads it before its next pass, finishes the one in flight and exits. The
boundary is the *pass* and not the agent — the gates, the merge lane and the
`end` point all run after the agent exits — so a drain can take as long as the
recipe's `runtime.limits.wall` (`1h` here, `2h` by default). The command says so
rather than leaving it looking hung. There is no default timeout, deliberately:
`--timeout 20m` exists for somebody who has decided to accept what it does when
it trips, which is stop taking work, **leave the agent running** and exit.

`lingtai resume` lifts a shutdown nobody acted on, as it lifts a pause. Without
that the request would stop every daemon started after it.

**Starting again is `lingtai restart`**, which is the drain above and then one
daemon — in that terminal, or by the supervisor that keeps it
([0042](decisions/0042-the-restart-is-a-command.md)):

```bash
pnpm lingtai restart "picking up #88"
```

It refuses **before** it stops anything, because a refusal after the drain is a
system that is down and a person reading about why it may not come back up:

- **a `HEAD` the tracking remote does not have**, by name. A process holds the
  code it started with for hours, and on 2026-09-09 a daemon started from
  `582a0f8` — a local commit a `git pull --rebase` rewrote out of existence
  twenty minutes later, leaving `daemon: currency` reporting a commit that is
  not reachable from `origin/main` at all. Being *behind* the remote is not a
  refusal: that code can still be fetched and read.
- **a dirty worktree**, in the same refusal, for the same reason — code that no
  commit names.
- **anything `lingtai doctor` failed on.** The failed checks are printed; the
  thirty green ones are not. A failure whose own remedy is a restart — a pass
  refused by a process at a commit older than this checkout (#148) — is printed
  and does not refuse, since this is the command it asks for.
- **a shutdown somebody else asked for**, because it is another person's
  decision. `lingtai resume` lifts it. One you asked for yourself — a `shutdown`,
  or a `restart` you Ctrl+C'd — is picked up and waited on, not refused.

One flag per refusal, so overriding one never overrides the rest: `--dirty` for
the worktree and `--despite-doctor` for the doctor. Nothing overrides an
unpushed commit or a drain that is somebody else's. What a flag waved through is
still printed.

Then it waits, saying what is still finishing and repeating itself so it never
reads as hung; checks the commit and the worktree **again**, because a drain can
take an hour and those are what the start freezes; withdraws the request it
made — `ConductorShutdownWithdrawn`, naming that request, so a pause and a drain
somebody asked for meanwhile are both left exactly as they are — and starts a
daemon in that terminal, unless a supervisor keeps one (below). **What makes
it never two daemons is the lock, not the order of operations** — and losing the
lock is not a daemon running. If anything takes it first, the restart starts
nothing and exits non-zero: the winner may be a `lingtai run` that exits when its
pass ends, or a copy something else started that read the drain before it was
withdrawn and drains straight back out, and either leaves no daemon. `lingtai
doctor` says whether one is up; if none is, run `lingtai restart` again. Ctrl+C
during the wait leaves the drain standing.

The lock held with no fresh beacon is drained too, not just waited on: it is a
`lingtai run`, which finishes its pass regardless, or a daemon whose beacon
writes are failing, which would otherwise never exit. A lock or a beacon that
could not be read refuses before anything is asked to stop.

**Under `lingtai service`, the drain and the start are the supervisor's, and
every refusal is still the restart's** (0048). When launchd has the job loaded,
or the systemd unit is active, a daemon started in the terminal would be a
second conductor beside the one it keeps, and the supervised one would come
back the moment the terminal closed. So `restart` asks first whether a
supervisor keeps it — refusing, before anything stops, a supervisor it could not
ask or a unit written from another checkout, since it would check this commit
and start that one's. Then the same checks as above; `lingtai service
shutdown`'s drain, which holds the conductor lock through the unload so the copy
KeepAlive starts cannot take work on code nobody checked; the same checks again
with nothing supervised running — a refusal there leaves the service unloaded
and says so; and `service start`. It exits 0 only when the daemon that started
has recorded `ConductorStarted` on the commit that was checked, and exits
non-zero naming what did start otherwise. `--no-conduct` and `--no-merge` are
refused there, because the unit decides how the supervisor starts it. A file
left after `service shutdown` is not a keeper — nothing starts from it — so that
restart runs in the terminal.

**`service start`, `service restart` and `service install` wait for the start to
be recorded**, up to two minutes, because the supervisor exiting 0 says the job
was asked for and not that a daemon took work: a copy that loses the lock, or
reads a drain, records nothing and exits 0 for the supervisor to start again.
No record is exit 1, and the line says so; a record that could not be read is
exit 1 too, and says whether work is taken is not known rather than that none
is. Where the supervisor already runs a process, `start` and `install` start
nothing and exit 0, and that exit confirms nothing — `lingtai doctor` says who
holds the lock. `apps/cli/src/restart.ts`'s
`RESTART_GUARDS` is the table of what the terminal and the supervised restart
each refuse.

A start is now in the log as well as in the beacon — `ConductorStarted`, with
who, why and the commit. `by` is `human:<you>` for a restart in the
terminal or a `lingtai start` typed at one, and `daemon` for one launchd or
systemd started — a supervised restart included, which is recorded as your
drain and withdrawal, then that start — so *who restarted it at 23:06* is a question the log answers. A start
that reads a drain asked while it was starting is not recorded: it takes nothing
and exits. A drain asked before a daemon started is never read by it (#159,
0048), so a standing one does not hold a supervisor's copies down, and `lingtai
resume` is not the answer to a start nothing recorded — something else holding
the lock is, and `lingtai doctor` names it. A beacon
is one mutable row the next start overwrites, and it never could.

Ctrl+C is the same drain and says what it is doing: the first one names what is
finishing and what a second one costs, and the second stops immediately. Both
are honest because the agent runs in its own process group — before that, the
signal that began the shutdown killed the agent in the same instant. `kill
<pid>` behaves identically.

An agent left behind by a `--timeout` or a second Ctrl+C is not left for ever:
the next conductor kills the process its claim names before releasing the
ticket, guarded on the host and on the process's own command line, and reports
rather than kills anything that fails either guard.

Control goes through the log, so a pause issued while the daemon is down is
waiting when it comes back.

It also comments on the ticket when something is waiting on you and sets an
`lingtai:*` label as a task moves. Both go **directly, as the run goes**, and
every attempt appends its outcome — `IssueUpdated` or `IssueUpdateFailed`. The
outbox that used to stand behind those calls, with its retry queue and its dead
letter, was deleted (`#56`); what did not land is converged at the daemon's next
startup by comparing what the log says the issue should look like against what
GitHub says it does.

**Whether it also interrupts you is the recipe's to say** (`#123`). The daemon
starts what each project declared under `subscribers:` and names none of it —
this repository's own block is `desktop`, `node apps/cli/src/notify.ts`, on the
four types that mean nothing moves until you act. A project that declares none
gets none, and the daemon says so on its way past rather than being silent about
a silence. Each is a process of its own, gets only the credentials it declared
beside itself, and is never waited for; a failure appends `PluginFailed` and
`lingtai doctor`'s `subscribers: failures` reads it back. Nothing is retried,
deliberately: a notification delivered an hour late about a decision you already
made is worse than none.

`terminal-notifier` on your PATH lets a notification open that task's page when
you click it. Without it `osascript` still delivers one and writes the link into
the message, because it cannot open a URL itself.

### The board's lifecycle

The UI has the same four verbs the conductor has, and one of them is
deliberately a different word (#187):

```bash
pnpm lingtai board start      # serve it here; prints the URL, opens a browser
pnpm lingtai board stop       # stop the one this machine is running
pnpm lingtai board restart    # stop, then start
pnpm lingtai board status     # who serves it, whether it answers, who keeps it
```

`start` serves in this terminal and **ctrl-c stops it**; `--no-open` leaves the
browser alone, which is what the supervisor's job passes. `--port <n>` serves
this one run somewhere else.

**The board gets `stop`, not `shutdown`.** `shutdown` means *finish the pass in
flight*, and waits as long as `runtime.limits.wall` — an hour here. A board has
no pass to finish, so a verb that waited for one would make you wait for
nothing, or read as though the conductor were draining when it was not.
`lingtai board shutdown` does not exist and says so by name.

**`board restart` refuses nothing first.** `lingtai restart` checks a `HEAD` the
tracking remote does not have, a dirty worktree and a red `lingtai doctor`
before it drains, because a daemon holds the code it started with for hours
(0042). A board at the wrong commit costs a reload, so `board restart` is
stop-then-start and claims nothing more.

**A port somebody already holds is said in words**, never as a bare
`EADDRINUSE`: *a board is already on 17820 — http://127.0.0.1:17820*, the
holder beside it, and where the port is set. A board this machine is serving
holds a file lock under `~/.lingtai/locks/` — the same locker the conductor
and a decision take (#193) — named for its port, and the
holder's name carries its pid, which is what `stop` signals and `status`
reports. Something else on the port is named as something else: it holds no
lock of ours and nothing here signals it.

**Where a supervisor keeps the board, `stop` and `restart` are its calls.** A
signal sent here would be respawned thirty seconds later, behind whatever took
the port meanwhile, so `board stop` runs the supervisor's own stop and the
board stays down until `lingtai service start`.

#### The port

`17820`, and **no configuration is required to get it**. It is in
`packages/env/src/index.ts` and not in `apps/board/package.json`, where it used
to live as `next dev -p 3200`: somebody who installed Lingtai has no
`package.json` to edit. `~/.lingtai/config.yml` overrides it and need not
exist:

```yaml
board:
  port: 18080
```

**The override reaches `pnpm --filter @lingtai/board dev` too**, which is what
four places here send you to when there is no built board, each saying it
serves *the same port*. That script asks for the port like everything else
(`apps/board/serve.ts`) rather than carrying one, or the one number you set
would be the one the documented fallback ignored.

`17821` is **reserved and bound by nothing** — the daemon listens on nothing at
all, and a second listener, if one is ever needed, has an obvious home instead
of being scattered. `packages/env/test/board-port.test.ts` reads every
package's `src` and fails if any mention of the number, or of the
`RESERVED_PORT` that holds it, is anything but prose.

Higher is not safer: macOS hands out `49152–65535` as ephemeral ports and Linux
`32768–60999`, so a default in either range would collide at random,
intermittently, and mostly not at all — harder to find than a fixed clash.

### Keep it running

**No service manager? Run `lingtai start` and `lingtai board start` in the
foreground.** A container, a
Linux whose init is not systemd, a box with no user session: `pnpm lingtai
start` under whatever supervises that machine is a first-class way to run
Lingtai, not a debug mode, and it needs nothing else from this section.
`lingtai service` says the same when it finds no `launchctl` or `systemctl`.

Where there is one, let it keep the daemon up across logout, sleep, reboots and
crashes:

```bash
pnpm lingtai service install     # write both files for this platform, and load them
pnpm lingtai service status      # each job's own answers — never one word for both
pnpm lingtai service shutdown "why"  # drain the conductor, then stop the board
pnpm lingtai service restart "why"   # that, then start — unchecked; see below
pnpm lingtai service start
pnpm lingtai service uninstall   # both jobs; logs are kept
```

**It installs two jobs** (#187), because there are two processes and `launchd`
supervises two as easily as one. Merging the board into the daemon to avoid
supervising two would be the CLI taking on the supervisor's role, which
`apps/cli/src/service.ts` declines by design.

**Two, where there is a board to serve.** The job runs `lingtai board start`
from the checkout, and that serves what `pnpm build` wrote into `dist/`. On a
checkout nobody has built there is no board, and a job installed over that
would exit at once with `KeepAlive` respawning it every thirty seconds for
ever — so none is written. `service install` names the missing board, installs
the conductor's job and exits 0; `pnpm build` and one more `service install`
add the board's. `service start` and `service restart` say the same and get on
with the conductor. The daemon is never held up over it: it runs unbuilt
(0010), which is the whole of what 0010 is for.

**And nothing is started over a board that is already on the port.** A
`lingtai board start` in a terminal holds `board:17820` under
`~/.lingtai/locks/`, and the job runs that same command against that same port:
bootstrapped over it, the job is refused by the lock, exits at once, and is
respawned every thirty seconds for ever — while the URL answers all along,
because the terminal's board is on it, so a start that asked only the URL
reported success over a crash loop. `service install` writes the file, starts
nothing, names the holder and exits non-zero; `pnpm lingtai board stop` and
`pnpm lingtai service start` hand the board to the supervisor. A lock that
cannot be read stops the start too: *unread* is not *nobody*.

A `board.port` that is not a port number holds up nothing of the conductor's.
It is refused by name where the board is the subject — `lingtai board start`
serves nothing — and everywhere else it is a fact the board's own half of the
report carries: `service shutdown` drains and unloads, and says the port could
not be read beside the board it could not find.

| | macOS | Linux |
|---|---|---|
| supervisor | launchd, `launchctl` | systemd **user** manager, `systemctl --user` |
| the conductor | `~/Library/LaunchAgents/ai.nextloom.lingtai.daemon.plist` | `~/.config/systemd/user/lingtai.service` |
| the board | `~/Library/LaunchAgents/ai.nextloom.lingtai.board.plist` | `~/.config/systemd/user/lingtai-board.service` |
| always up | `KeepAlive` | `Restart=always` |
| crash-loop spacing | `ThrottleInterval` 30 | `RestartSec=30`, `StartLimitIntervalSec=0` |
| logs | `$LINGTAI_HOME/logs/daemon.log`, `board.log` and the `.err` beside each | the same four files |

**`service status` reports each job on its own**, and the conductor's two
answers stay two: one summary saying *running* would hide a board that is up
beside a conductor launchd respawns every thirty seconds. The board's own
second answer is whether a board **answers** on the port — a job the supervisor
has loaded is not a UI anybody can open, exactly as a loaded daemon is not a
daemon taking work.

The board's two files carry none of the daemon's reasons. It detaches no agent,
so its systemd unit leaves `KillMode` at the default; it finishes no pass, so
neither file argues about a stop timeout. A generated file is the first thing
anybody reads when a job did not come back, and the daemon's reasons would be
false there.

**The board is last, both ways.** `service shutdown` drains the conductor and
then stops the board — the UI is what watches a drain, and it is worth having
through it — and `service restart` and `service start` bring the conductor up
first, because the conductor's start is the one that can still refuse over a
shutdown request, and its refusal says *nothing was started*. There is no drain
for the board either way: nothing is in flight to lose.

An install from before the board had a job is named and passed over, not
refused: `service start` and `service restart` say *no board job … pnpm lingtai
service install writes one* and get on with the conductor.

**A board job the supervisor would not stop does not abandon the conductor's
restart.** `launchctl bootout` answers `Boot-out failed: 36` for a job that is
mid-start, and `service shutdown` exits on that — the verb did not do all it
says — but with an exit of its own, so `lingtai restart` can tell *the drain did
not finish* from *the board's job did not stop*. It says which, and starts the
conductor it drained. One number for both legs left the daemon drained,
unloaded and unsupervised over a UI, under a sentence blaming the drain.

**And a board that never comes up does not cost the conductor its
confirmation**, which is the same rule on the way back up. Something that is
not a Lingtai board on 17820 — a stale `next dev`, an unrelated server that
took the port at login — holds no board lock, so the job is bootstrapped over
it, exits on its own `EADDRINUSE`, and nothing answers for 75 seconds. The
daemon started and recorded it through all of that. `service start` exits on
the board alone, with its own number rather than the daemon's, so `lingtai
restart` reads the record back, runs the `#167` checks on the daemon that
started and prints *restarted … — the commit that was checked* — then says the
board is what did not come up, and where to start it alone. Folded into one
number it returned there instead: no confirmation, no checks, exit 1 over a
daemon that is up and claiming tickets, and an operator told to drain a healthy
one and wait out another pass for the same answer.

The two exits are `service`'s own: **3** is *the conductor did its half and the
board's job would not stop*, **4** is *the conductor did its half and the board
did not come up*. Anything else non-zero is the conductor's, and `lingtai
restart` treats it as one.

**`KeepAlive` and `Restart=always` are the same rule**: the daemon is a thing
that is always supposed to be up, so there is no start button that matters.
What you steer is whether it takes work — `lingtai pause` and `lingtai resume`.
The Linux unit also sets `KillMode=process`, because systemd's default kills the
whole cgroup, agent included, where launchd signals only the daemon.

Both files are generated, never committed: they carry this checkout's absolute
paths, `node`'s, and the installing user's `HOME`, `USER` and `LINGTAI_HOME`.
The daemon itself is unchanged — `service` only manages what runs it. A
path a systemd unit cannot carry verbatim (a space, a quote, `%`, `$`, `\`) is
refused by name rather than written in a form systemd would misread.

**"Loaded" is not "alive", and `service` never says the second on the strength
of the first.** launchd will keep a job loaded while it fails to spawn it every
thirty seconds — a `node` the plist names that has since been removed is enough.
So `install` and `status` both end by printing what the supervisor says, in its
own words (`state`, `last exit code`; `ActiveState`, `SubState`, `NRestarts`),
beside what `daemon_status` — the beacon outside the log (#46) — says. A beacon
that could not be read is printed as unread, and a `launchctl` that did not
answer is printed as not answering, never as `not loaded`.

`install` over a job the supervisor already has does not restart it, because
that would signal the pass in flight. It writes the file and says when it takes
effect: launchd reads a plist only when it loads the job, so even a KeepAlive
respawn keeps the old one; systemd has run `daemon-reload`, so the next start
uses the new unit. `service restart` is what applies it now — on macOS
`bootout`, a wait until the job has gone, and `bootstrap`, never
`kickstart -k`, which would reuse the old definition.

**`shutdown` drains first and tells the supervisor last** (#174). The
supervisor's own stop is a signal and a deadline — launchd SIGKILLs at its
default `ExitTimeOut` of 20 seconds, systemd at `TimeoutStopSec`'s 90 — and a
pass takes up to an hour. `service stop` used to send that signal: the daemon
began its drain and launchd killed the agent twenty seconds in. So `service
shutdown` takes a place in the queue for the conductor lock, appends the request
`lingtai shutdown` appends, waits until the lock is its own, and only then runs
`bootout` or `systemctl --user stop` — still holding it. The lock and not the
request is what keeps the supervisor's next copy from work: KeepAlive starts one
the moment the drained daemon exits, that copy reads nothing appended before it
started (#159), and Postgres hands a released lock to the session already
waiting, so the copy loses it and claims nothing. Last, the lock is released and
the command withdraws its own request, so a later `service start` is not refused
over it. The wait ends because whoever holds the lock reads the request: a
daemon reads its watermark *before* it tries for the lock, so anything appended
once it holds the lock is above that watermark. Read the other way round, as it
was, a request that landed while the holder was still starting was below the
watermark of the one process that had to obey it, and the wait never ended.
A request already standing — anybody's, under your own name too — is
refused and left alone, since the daemon running now may never read it. On a
quiet daemon the wait is over at once. Ctrl+C during it tells the supervisor
nothing and withdraws the request; a daemon that had already read it still
exits after its pass, and the supervisor starts one that takes work, so run
`service shutdown` again. `service stop` is gone and says so.

`ExitTimeOut` and `TimeoutStopSec` are **deliberately left at their defaults.**
Set to the wall limit, they would make `bootout`, a logout and a machine
shutdown block for an hour. The daemon still drains on `SIGTERM`, for whatever
else signals it; nothing depends on that finishing.

**`service restart` is `shutdown` and then `start`, and nothing is checked.**
`lingtai restart "why"` is the checked one (0042): before anything stops it
refuses a `HEAD` the tracking remote does not have, a dirty worktree, and a
failed `lingtai doctor`, then drains, checks again, and has the supervisor start
the daemon recorded as yours. `service restart` does none of that — it starts
whatever the checkout holds — and it is the plumbing for a rewritten unit that
must be loaded now.

So the three restarts differ in what they refuse before they act, and in what
they cover:

| | refuses first | covers |
|---|---|---|
| `lingtai restart "why"` | an unpushed `HEAD`, a dirty worktree, a red `doctor` | the conductor |
| `lingtai service restart "why"` | nothing | both jobs |
| `lingtai board restart` | nothing | the board |

`lingtai restart` under a supervisor delegates the drain and the start to
`lingtai service restart` and keeps every refusal as its own (`RESTART_GUARDS`
in `apps/cli/src/restart.ts`), so the row above is about the checks and not
about which process does the work.

**Under a supervisor, `lingtai shutdown` does not hold the service down.** A
daemon reads nothing appended to the control stream before it started (#159),
so the copy KeepAlive or `Restart=always` brings back after the drained daemon
exits never sees the request and takes the next ticket at once. To keep the
service down, `service shutdown`, which unloads it. `service start`, `service
restart`, and `service install` over a job the supervisor does not have, refuse
and exit 1 without starting anything while a shutdown request stands — not
because the daemon they started would exit on it, since it would not, but
because it would take work over a stop somebody asked for, and lifting that is
theirs or `resume`'s. A `service restart` that finds one landed during its own
wait has already unloaded the service, and leaves it so.
(`install` still writes the file, and after `resume` it is `service start` that
loads it.)

**`resume` lifts a pause as well as the shutdown** — it is one event, and both
are cleared by it. If you had paused on purpose, `resume` alone lets the next
daemon take the work you were holding. To keep the pause, take the supervisor
out of the way first so nothing starts between the two commands: once the daemon
has exited, `service shutdown`, `resume`, `pause "why"` again, `service start`. The
refusal above names the pause and prints that order when one is in force.
**Not for a pause that lifts itself** — the conductor's own, after a run that
never started, carries a time (0031 §3) and `lingtai pause` cannot: pausing
again would hold past that time until somebody resumed by hand. Wait out its
time instead, then `resume`, which by then lifts only the shutdown. The refusal
says which kind it found.

#### Under a dedicated unprivileged user (Linux)

Everything the service touches is the installing user's — `HOME`, the unit
path, `LINGTAI_HOME` — so the recipe is to install *as* that user, from a
checkout they own:

```bash
sudo useradd --system --create-home --home-dir /var/lib/lingtai lingtai
sudo loginctl enable-linger lingtai     # a user manager that outlives logins
sudo machinectl shell lingtai@          # a real session, so systemctl --user works
# as lingtai: clone the repository, fill in .env.local and ~/.lingtai/env, then
pnpm install && pnpm lingtai doctor && pnpm lingtai service install
```

`sudo -u lingtai systemctl --user …` fails with no bus to talk to, because there
is no session; `service` names that and points here. Without lingering the user
manager, and the daemon with it, stops at that user's last logout — `install`
says when lingering is off, and says separately when `loginctl` could not tell
it. The checkout the unit names is the one the command ran from, not the
installing user's, so `install` refuses one that user does not own — `pnpm
--dir /home/admin/lingtai` from `lingtai`'s session is turned away rather than
written into a unit that runs someone else's code. `node` is whichever the
shell finds on `PATH`, so install from that user's own shell.
`apps/cli/test/service.test.ts` pins the refusal through the command's own
`repoRoot()`, and that `HOME`, `USER` and `LINGTAI_HOME` in the unit are the
environment it was given.

**A running daemon holds the code it started with. Merging is not deploying —
restarting is.** [0010](decisions/0010-source-runs-unbuilt.md) says the source
runs unbuilt, and that is easy to read as *there is no deploy step*. It removes
the build, not the restart: Node caches a module the first time it is imported,
so a long-lived process goes on running whatever `HEAD` pointed at when it
started, however many times you merge afterwards.

Nothing else in the system works that way, which is what makes it hard to see:

| | lifetime | code |
|---|---|---|
| **daemon** — conductor, claim, hook socket, run-once, queue | one long-lived process | **frozen at startup** |
| `lingtai doctor` / `status` / `run` | fresh per invocation | current |
| gates (`sh -c pnpm typecheck && pnpm test`) | fresh per invocation | current |
| the board (`next dev`) | hot reload | current |
| the recipe | read from `origin/main` each pass | current |

So a system left alone schedules with old logic, verifies with new code and
reads new config — and that mix is worse than being uniformly stale. It cost 52
prompts: `#88` fixed what a run records about its prompt, landed thirty-nine
minutes after the daemon started, and never executed once
([`#98`](https://github.com/steven-zhc/lingtai/issues/98)).

The daemon now says which commit it is on as it starts, and two places compare
that against `origin/main`:

```bash
pnpm lingtai doctor
```

```
  ok   daemon: liveness
         up, last beat 2s ago
 note   daemon: currency
         running 8f3a1c2 — 3 commit(s) behind origin/main, which has not taken
         effect in this process: 2b45637 fix(attempts): a second attempt is told
         what ended the first; … Unbuilt removes the build, not the restart —
         restart the daemon to take them
```

The board's bar says the same thing on its health dot. That used to be its own
chip beside a second one for whether the projection is current, and they are one
indicator now (#134): both answer *is the system doing what the code says?*, and
two boxes for one question is two things to learn to read on a row that is
glanced at. Neither fact is folded away — whichever is wrong is the sentence
beside the dot, and the other is on hover. A board can still be perfectly
current, taking work, and driven by code you replaced an hour ago; the dot goes
red and says which.

Whether the conductor is *paused* is a third fact and stays its own chip, absent
unless there is something to say.

Neither restarts anything: `lingtai doctor` never writes, and a daemon still
does not restart itself when `main` moves — that remains open, and 0042 decided
only that the restart is a command somebody types. Take the commits with it:

```bash
pnpm lingtai restart "taking 3 commits"   # drains, checks, and starts — itself, or through the supervisor
```

`daemon: currency` is a `note`, not a failure. Being a commit behind is normal
for the minutes between a merge and a restart; a doctor that went red for it
would be red most afternoons, and a check that is always red is one nobody
reads.

### Decide, on the board

Open <http://127.0.0.1:17820>. The card is in **Waiting on you** — title, state,
cost, gate counts — and Approve and Back to the queue are on it, because
deciding is what the board is for. Reject and Waive are gone (`#150`): neither
moved the card, and approving over a gate that still refuses now waives it, with
the reason Approve asks for.

Everything else is one click away. The card's title opens `/task/<id>`, which
folds that task's event stream on demand: each gate's verdict with its evidence,
the reviewer's findings with their failure scenarios, the guard trips, and the
raw history with every actor. Nothing on that page is maintained in a table — a
detail view is read rarely, by one person, about one task.

The page updates itself: Postgres notifies on every append, the daemon advances
the projection, and the board re-reads. When the conductor is paused the bar
says so on its own chip — who paused it, why, and a Resume beside it — because a
board that is perfectly current and going nowhere looks exactly like a quiet one
(`#77`). If it stops moving for any other reason, `lingtai doctor` says whether
the daemon is up.

That is the whole bet: if deciding still means opening GitHub, nothing changed.

The same decisions from the terminal, if you prefer:

```bash
pnpm lingtai approve nextloom-ai-admin --issue 120
pnpm lingtai approve nextloom-ai-admin --issue 120 --note "the review finding is out of scope"
pnpm lingtai requeue nextloom-ai-admin --issue 120 --note "the block was the harness, not the diff"
pnpm lingtai close nextloom-ai-admin --issue 120 "superseded — the design this describes is not the design"
```

**There is no `lingtai waive`, and that is the same decision `#150` made on the
board.** A waiver is not a move of its own: it is what approving over a refusal
*is*, and `--note` is the reason it carries. Two verbs for one act let a person
waive a gate and then wonder why the item had not moved — a decision reported as
taken that took nothing. `#129` added the command when the board had a Waive
button and the terminal did not; `#150` removed the button, and this removes the
verb that outlived it. `waive()` itself is still there, called by `approve`.

`approve` merges **what the held run actually produced**, not a fresh attempt.
If the branch moved since the run asked, it refuses and names both commits —
you would otherwise be merging something you have not read. When a gate still
refuses that head, `--note` is required: approving waives each refusing gate,
with the note as the reason, in the same append as the approval. `--reject` is
gone — it asked the same question again and ended nothing; to disagree with the
diff, `requeue` it.

`requeue` ends a wait with **a new run**, whether or not there is a diff to
approve (`#150`): an item held for approval — after which an approval of the
diff you sent back is refused, and while one is still merging the requeue is
refused instead — or one
that blocked — an integration that conflicted, a gate that failed for a reason
that was never about the change — goes back to the queue, and the next pass cuts
a fresh branch from a base that has since moved. It refuses by naming the state
the item is actually in, so *`wi-lingtai-122` is claimed, not blocked* is the
answer rather than "not blocked". `--note` is required and is never defaulted: a
block overruled anonymously is the silent waiver this whole system exists to
remove. It appends the same `WorkItemUnblocked` the board's button does and
makes no GitHub call — `reconcile` converges the label the block left behind.

`ask` and `answer` are the pair for a decision **before** any run (`#147`):

```bash
pnpm lingtai ask lingtai --issue 51 "which of the three designs for the tripwire?"
pnpm lingtai answer lingtai --issue 51 "the second — refuse at the hook"
```

`ask` appends `WorkItemBlocked` with `runId: null` and refuses an item a run
holds or one already asking; nothing is claimed and no worktree is cut, and the
queue passes over it because the fold says blocked. `lingtai status` prints the
question rather than counting it. A question asked by mistake is withdrawn with
`lingtai requeue ... --note "<why>"`, which writes the unblock `withdrawn` so no
attempt is told it. `answer` refuses a block a run is holding —
that is `approve` or `requeue` — and its choice is kept by the fold and carried
into every later attempt's prompt, so nobody edits the issue body to reach the
agent.


`waive` is the escape hatch, and it arrives where you already are: the case it
exists for — a flaky check, a scan whose service is down, a failure you have
read and judged unrelated — is one you meet at a prompt, not in a browser
(`#129`). The gate is named as `point:action`, the key the card shows. Any gate
on the run's current head can be named, whatever it says — including one left
`running` by a run that gave up on it, which nothing else will ever answer — and
so can any gate the run planned and never reported, which is how a
`landedWithoutGatePoints` failure in `lingtai doctor` is closed. A name that is
neither is refused by listing the gates there are. `--reason` is required and is
never filled in for you: *recorded, never silent* is the whole of what makes a
waiver acceptable. It appends the same `GateWaived` `approve --note` does,
bound to the head it listed the gates on, so a branch that moves in between is
refused rather than waived unread.

**A waiver merges nothing** on its own. `approve` reads an earlier waiver —
a gate already waived on the head is not one it asks a reason for again — but
nothing merges because of one. It is a verdict on the record — the card shows it, `doctor`
counts it, the next attempt is not told the gate died — and the item stays
where it was. So the command ends by saying what the item is still waiting on:
a held run is still `approve`'s to merge, and a blocked one is still blocked,
with `requeue` the move left and a new head this waiver will not count on.

### Let it merge

Drop the flag once you are willing:

```bash
pnpm lingtai run nextloom-ai-admin --issue 120
```

It still stops for a person wherever the recipe says so — a `human` gate, or a
`watch` action that saw a migration.

### Take the queue

No `--issue`, and it picks work itself, in the recipe's priority order:

```bash
pnpm lingtai run nextloom-ai-admin --max 2    # Phase 2's exit criterion
pnpm lingtai run nextloom-ai-admin            # until nothing runnable is left
```

**`--max` matters more than it looks.** Without it this drains the queue, and a
queue you have not read is a bill you have not agreed to. Start bounded.

A pass will not attempt the same work item twice, even though a failed run
releases it back into the queue — that is what stops a broken ticket from
costing an agent call per lap. It stops with `exhausted` rather than `empty`
when work remains that it has already tried, because those are different facts.

The line it prints at the end is read back from the log, not counted up from
what the process did:

```
9 run(s): 1 landed, 7 held, 1 stopped (empty)
```

**landed** the work item's stream says `WorkItemLanded` — by this run, or by
the merge lane after somebody approved it on the board while the pass carried
on. **held** it is blocked on a question a person now holds. **stopped** it
ended, nothing landed, and nobody was asked anything. The exit code is non-zero
only for that last count.

### When something refuses

Every refusal names itself. The common ones:

| What you see | What it means |
|---|---|
| `the GitHub App is not installed on …` | Step 3 above — install it on that repository. |
| `the installation is missing permissions:` | Step 1's table; each gap is listed with what it has, what it needs and what it is for. |
| `no recipe at ~/.lingtai/<project>/recipe.yml` | The recipe is yours and lives on this machine (0046 §3) — nothing is read from the repository, and nothing needs committing to it. The board's wizard writes a first one by reading the repository. |
| `runtime.agent: moved to this machine (0046 §3)` | A key that belongs in `~/.lingtai/config.yml` was left in the recipe. **Nothing in that recipe was applied** — the file is refused whole, rather than the key being dropped. Same for `runtime.limits`, `runtime.assignee`, and for `gates:` written in the machine file. |
| `runtime: signed in — claude-code reports not signed in` | `lingtai doctor` asks in the environment a *run* gets, not yours. If you are signed in and this fails, that environment is missing something the credential store needs. `/login` will not help. |
| `no lingtai-hook binary at …` | `pnpm --filter @lingtai/hook build`. A run without the guard must not start. |
| `ENOENT … lingtai-app.pem` | The key path is wrong. `~` and relative paths both work; relative is from this repository's root. |
| `stopped at recipe: …` | The recipe did not parse, or names an action this build does not have. The message is the validation failure. |
| `stopped at env: … declared in env.required and not set in any layer` | The recipe requires a name nothing supplies. Nothing was claimed and nothing was spent. The message names the command: `lingtai env set <project> <NAME>`, which reads the value from stdin unechoed. Or declare it in the repository's own `.env.local`. A `LINGTAI_` name never crosses from the machine file at all. |
| `env.required: …` names something nothing supplies | The recipe requires a name and no file has it. `allow`, `deny` and `required` are all valid keys since [0021](decisions/0021-the-recipe-decides-the-environment.md); the schema stays strict so a stale key fails loudly instead of resolving to "requires nothing". |
| `stopped at discover: excluded-label` | That issue carries a label the recipe's `source.exclude` names. Every reason an issue is passed over is the recipe's — there is no built-in list. |
| `stopped at discover: blocked-by` | GitHub says an open issue still blocks that one. Close the blocker, or remove the **blocked by** link on the ticket; there is nothing to clear here, since the next pass asks GitHub again (#131). |
| `stopped at prepare: the install action refused` | An action at the `prepared` point refused — usually dependencies that did not install in a fresh worktree. Nothing expensive ran; that is the point of failing here. |
| `did not merge (stale): the card showed …` | The branch moved between reading and deciding. Reload and read it again. |
| `a waiver needs a reason` | A waiver records who and why. Both, always. |
| `stopped: exhausted — 1 run(s)` | The queue still has work; everything left has already been tried this pass. Not the same as `empty`. |
