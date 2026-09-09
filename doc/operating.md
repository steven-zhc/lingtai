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
├── env/<project>.env            your values, per project — persistent
├── repos/<project>.git          bare mirror — persistent
├── worktrees/<project>/<runId>  one per run — disposable
└── runs/<runId>/settings.json   the hook wiring
```

| | Lifetime | Why there |
|---|---|---|
| `env/<project>.env` | Persistent | **Yours, and the one layer the managed repository cannot write.** One connection string per project, so two projects can want the same variable name and mean different things — see [The layers](#the-layers). Not re-clonable; the one thing here worth backing up. |
| `repos/<project>.git` | Persistent | Expensive. The first clone is a network round trip; after that every run is a `fetch`. This is why cutting a worktree took 1.7s in [experiment 005](experiments/005-rung-1-reaches-a-real-repository.md). |
| `worktrees/<project>/<runId>` | One run | Cheap. Cut from the mirror, removed when the run ends — and removed *before* the integrator runs, because a worktree holding `agent/<n>` checked out stops git updating that ref. |
| `runs/<runId>/settings.json` | One run | **Outside the worktree, deliberately.** An agent that can edit its own hook configuration has no hook configuration. |
| `$TMPDIR/lingtai/*.sock` | One run | The hook's socket. In `$TMPDIR` rather than under `LINGTAI_HOME` because a unix socket path has a hard 104-byte limit and a home directory plus a run id exceeds it — see [ADR 0011](decisions/0011-hook-latency-is-runtime-startup.md). |

Two things in this repository are also not committed: `.env.local`, and
`packages/hook/bin/lingtai-hook` — a 55 MB compiled binary that `pnpm --filter
@lingtai/hook build` produces.

**`rm -rf ~/.lingtai/repos ~/.lingtai/worktrees ~/.lingtai/runs` is safe.**
Everything in those is either re-clonable from GitHub or belongs to a run that is
over. The part that matters — the event log — is in Postgres, and none of it is
here. `~/.lingtai/env` is the exception: you wrote it, nothing else has a copy,
and deleting it makes every project that requires a value refuse by name until
you write it again.

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

**Two connection strings, one database.** `LINGTAI_DATABASE_URL` is pooled, for
ordinary queries; `LINGTAI_DIRECT_DATABASE_URL` is session mode, for migrations, `LISTEN/NOTIFY`
and advisory locks. A transaction pooler breaks all three, and breaks them
without erroring — see [ADR 0009](decisions/0009-two-connections.md).

The event store must be **its own database**, not one belonging to a managed
project — Lingtai has to keep running while a managed project is the thing
being changed.

**The tests need a third and fourth string, and refuse to run without them.**
`LINGTAI_TEST_DATABASE_URL` and `LINGTAI_TEST_DIRECT_DATABASE_URL` point at a *different*
database. The suite is not mocked — it appends real events, runs real
projections and takes real advisory locks — so pointed at your own log it
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

Prisma 8 splits planning from applying. Planning is offline; only the second
half needs a reachable database.

```bash
pnpm db:init                      # create the tables and sign the database
pnpm db:bootstrap                 # apply notify.sql, then prove it worked
```

The test database takes the same two, with `LINGTAI_TEST=1` in front of each
so they resolve `LINGTAI_TEST_DIRECT_DATABASE_URL` instead.

`db:bootstrap` is not optional and is not Prisma's job. Prisma models tables, not
triggers, so `notify.sql` carries the two things the schema cannot express: the
`NOTIFY` trigger every subscriber wakes on, and the rules that make `events`
append-only in the database rather than by convention. The script then asserts
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

This part cannot be automated: creating an App is a browser step, and the
private key it hands you is a real secret.

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
GITHUB_APP_PRIVATE_KEY_PATH=~/.lingtai-app.pem
```

`~` is expanded, and a relative path is relative to *this repository's root* —
not to whichever directory you ran the command from. Where only a single-line
value can be carried, `GITHUB_APP_PRIVATE_KEY` takes the PEM itself with `\n`
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

### 1. Give the repository a recipe

Lingtai reads `<repo>/.lingtai/config.yaml` **from the base branch**,
never from the branch an agent is working on. An agent that edits this file
changes nothing about the run in flight; the edit shows up in the diff and takes
effect from the next work item. That rule is borrowed from GitHub Actions and is
[ADR 0005](decisions/0005-config-in-target-repo.md).

Commit this to the base branch of the repository being managed — not to
Lingtai:

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
  # Variable NAMES only, never values — so this file is safe to commit.
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

runtime:
  agent: claude-code
  limits:
    turns: 300
    wall: 2h
```

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

There is nothing else to write. The tier, the gates, the priority order **and the
base** are all the recipe's, in the managed repository — which is why this
command takes a slug and nothing more.

`--base` is the one exception, and it is not a second way of saying what the base
is: you have to be on *some* branch to read `.lingtai/config.yaml` at all, and
`--base` says which. The file's own `repo.base` then decides, and that is what
gets recorded:

| `--base` | what happens |
|---|---|
| omitted | the recipe is read from the repository's default branch; if it declares another `repo.base`, it is read again there and **that** branch is recorded |
| given, agreeing with `repo.base` | unchanged |
| given, disagreeing | refused, naming both branches, before anything is written |

```
pnpm lingtai add steven-zhc/nextloom-ai-admin --base main
--base main, but .lingtai/config.yaml there declares repo.base: develop. …
```

So reach for `--base` when the recipe is not on the default branch — never to
override what the recipe says. Editing `repo.base` afterwards re-creates the
disagreement, and a run refuses on it rather than obeying rules from the wrong
branch (`lingtai doctor` has the same check).

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
`lingtai daemon` prints the same block for every registered project at startup,
from the same function, before it takes anything. A project whose recipe will
not resolve gets that slot rather than being left out:

```
lingtai        RECIPE INVALID — .lingtai/config.yaml on main is not valid: source.kinds.3: Invalid option
               nothing will be taken from this project
```

That case used to be an empty queue and nothing else (#76), which is
indistinguishable from a repository with no work. `lingtai doctor` now fails on
it too.

It takes nothing, claims nothing and appends no event — the whole of what it
does is make the answer current. The absences are the half worth having: an
issue nobody is working on has a reason, and that reason is the recipe's.

Onboarding is done. How you actually run work is next.

## Running work

Two things have to exist before anything runs, and both refuse loudly rather
than degrading:

```bash
pnpm --filter @lingtai/hook build      # the hook binary; not committed
pnpm --filter @lingtai/board dev       # the board, on :3200
```

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
pnpm lingtai daemon
```

One process, holding one advisory lock. It keeps the projections current and
takes work: a completion event — landed, released, blocked, refused — is what
tells it to pick the next one up, so the loop advances by itself with no timer
anywhere.

Running it while another copy is up is fine; the second exits saying who holds
the lock.

```bash
pnpm lingtai pause "the importer is flaky today"   # take nothing new
pnpm lingtai resume
pnpm lingtai now nextloom-ai-admin --issue 155     # one, ahead of the queue
```

**Pause stops it taking new work; a run in flight finishes.** Killing a running
agent is not implemented — a run you want gone ends when its lease expires and
the claim comes back. Said plainly because a Stop button that means Pause is
worse than no Stop button.

Control goes through the log, so a pause issued while the daemon is down is
waiting when it comes back.

It also comments on the ticket when something is waiting on you, sets an
`lingtai:*` label as a task moves, and sends a macOS notification for the
four things that mean nothing moves until you act. The comments and labels go
**directly, as the run goes**, and every attempt appends its outcome —
`IssueUpdated` or `IssueUpdateFailed`. The outbox that used to stand behind
those three calls, with its retry queue and its dead letter, was deleted
(`#56`); what did not land is converged at the daemon's next startup by
comparing what the log says the issue should look like against what GitHub says
it does. Notifications deliberately get neither: one delivered an hour late
about a decision you already made is worse than none.

`terminal-notifier` on your PATH makes a notification clickable, opening that
task's page. Without it they still arrive, and the daemon says which you got.

To keep it running across logout, sleep and crashes:

```bash
./scripts/launchd.sh install     # KeepAlive; there is no start button to press
./scripts/launchd.sh status
./scripts/launchd.sh uninstall
```

### Decide, on the board

Open <http://localhost:3200>. The card is in **Waiting on you** — title, state,
cost, gate counts — and Approve, Reject and Waive are on it, because deciding is
what the board is for.

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

The same three decisions from the terminal, if you prefer:

```bash
pnpm lingtai approve nextloom-ai-admin --issue 120
pnpm lingtai approve nextloom-ai-admin --issue 120 --reject "wrong approach"
```

`approve` merges **what the held run actually produced**, not a fresh attempt.
If the branch moved since the run asked, it refuses and names both commits —
you would otherwise be merging something you have not read. A rejection sends
the item back to the gate, not back to the queue.

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
| `no .lingtai/config.yaml on develop` | The recipe is missing from the **base branch**. A copy on the agent's branch is not read, by design. |
| `runtime: signed in — claude-code reports not signed in` | `lingtai doctor` asks in the environment a *run* gets, not yours. If you are signed in and this fails, that environment is missing something the credential store needs. `/login` will not help. |
| `no lingtai-hook binary at …` | `pnpm --filter @lingtai/hook build`. A run without the guard must not start. |
| `ENOENT … lingtai-app.pem` | The key path is wrong. `~` and relative paths both work; relative is from this repository's root. |
| `stopped at recipe: …` | The recipe did not parse, or names an action this build does not have. The message is the validation failure. |
| `stopped at env: … declared in env.required and not set in any layer` | The recipe requires a name nothing supplies. Nothing was claimed and nothing was spent. The message names the command: `lingtai env set <project> <NAME>`, which reads the value from stdin unechoed. Or declare it in the repository's own `.env.local`. A `LINGTAI_` name never crosses from the machine file at all. |
| `env.required: …` names something nothing supplies | The recipe requires a name and no file has it. `allow`, `deny` and `required` are all valid keys since [0021](decisions/0021-the-recipe-decides-the-environment.md); the schema stays strict so a stale key fails loudly instead of resolving to "requires nothing". |
| `stopped at discover: excluded-label` | That issue carries a label the recipe's `source.exclude` names. Every reason an issue is passed over is the recipe's — there is no built-in list. |
| `stopped at prepare: the install action refused` | An action at the `prepared` point refused — usually dependencies that did not install in a fresh worktree. Nothing expensive ran; that is the point of failing here. |
| `did not merge (stale): the card showed …` | The branch moved between reading and deciding. Reload and read it again. |
| `a waiver needs a reason` | A waiver records who and why. Both, always. |
| `stopped: exhausted — 1 run(s)` | The queue still has work; everything left has already been tried this pass. Not the same as `empty`. |
