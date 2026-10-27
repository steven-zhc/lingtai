# Why Lingtai is built this way

The design argument, moved out of the root README so that it can start with
what to type. For the commands, begin at the [tutorial](tutorial.md).

Lingtai takes a queue of work, hands items to coding agents — several passes at
once, each in a worktree of its own — holds each at a series of steps, and
releases it only when every step, including a human one, has passed. Nothing
advances without leaving a record of why.

**One agent loop, driven by an append-only event log. Everything else is a
projection of that log or a subscriber to it.**

## Why

Three questions decide whether you can leave a coding agent running:

- *what state is this ticket in?*
- *why did this not merge?*
- *what is waiting on me?*

Everything here follows from making those three **the same query against the
same table**. Scatter them — state in labels, history in comments, telemetry in
a log nobody parses — and each is answerable only by someone who already knows
where to look, which is near enough to not answerable at all.

The load-bearing word is **log**, not *event*: plenty of systems are
event-driven and still keep authoritative mutable state somewhere. Here the log
is the only truth — every table is derived, can be dropped, and rebuilds to
exactly what it was.

## Goals

| | |
|---|---|
| **Nothing decides in private** | Every component appends to one table and keeps no state of its own, so the board and the CLI cannot disagree. |
| **The managed repository stays ordinary** | **Nothing is committed to it at all.** No configuration file, no bot account, no CI job, no label state machine. Delete Lingtai tomorrow and the repository would not notice, because there is nothing there to delete. |
| **The rules are yours, and they are on your machine** | What may be picked up, what environment it gets, what must pass — `~/.lingtai/<project>/recipe.yml`. Nothing privileged sits above that file, and an agent cannot reach it: its blast radius is a worktree, and `~/.lingtai/` is not in it ([0046](decisions-archive/0046-lingtai-is-personal.md) §3). What a *team* shares was never the recipe — it is branch protection. |
| **Nothing is sent anywhere** | No telemetry, no analytics, no crash reports, no account. Cost and duration are recorded — on your own log, and on `/spend` — and nothing reports them anywhere. **Where that log is, is yours to decide, and `lingtai init` writes the answer down** ([0100](decisions/0100-one-append-only-log.md) §7): an empty answer is SQLite, one file at `~/.lingtai/lingtai.db` that nothing off this machine can read; a Postgres URL is the other store. `config.example.yml` templates `database.url` as a bare host — `postgresql://user:password@host:5432/lingtai` — and names no provider, so where that database sits, if you choose one, is a choice you make rather than one it makes for you. A URL pointing off this machine puts the log there — the costs and durations, and the issue bodies, prompts and gate evidence beside them. Point it at a Postgres of your own and none of it leaves. The one question Lingtai asks on its own account is which release is newest: `lingtai upgrade` and `lingtai doctor` ask the GitHub Releases API, sending nothing but the question and the version you are on ([0051](decisions-archive/0051-a-version-is-a-directory.md) §7). An `upgrade` you then ask for downloads that release's artifacts from GitHub as well, so an allowlist naming only the API is not enough (§4). Everything else it talks to is the job you gave it: GitHub about your repository's issues and branches, the agent about the work, and whatever your recipe's own subscribers run — the `telegram` one posts the notification to Telegram, because you configured it to. The board's two typefaces are files in the repository — `next/font/local` in `apps/board/src/app/layout.tsx` — so building it fetches nothing from Google. An installed copy carries the same files: `board.tar.gz` ships the board built ([0051](decisions-archive/0051-a-version-is-a-directory.md) §3). |
| **A configured check that did not run is a bug** | Not a preference — the thing the design is built to make visible. An unconfigured gate is *shown as skipped*, never omitted, because absent and silently-not-run must be distinguishable. |
| **Refusing is cheap and early** | A missing environment value refuses the whole project before an issue is claimed: no worktree, no agent, no money. |

**Lingtai merges its own tickets unattended**, and `lingtai pause` is there for
when you want it to stop.

## The big picture

Lingtai runs on one machine of yours. It owns its log — a SQLite file by
default, the empty answer at `lingtai init`, or a Postgres database if you give
it one — a clone of each repository it manages, and the agent processes it
starts.

```mermaid
flowchart TB
  gh(["<b>GitHub</b> — the authority on what work exists"])
  cond["<b>conductor</b><br/>discover · claim · worktree · the ten steps · integrate"]
  agent["<b>agent</b><br/>claude-code, in a worktree of its own"]
  log[("<b>events</b> — append-only, and the only truth")]
  you["<b>board</b> · <b>lingtai</b> — where you see it and decide"]

  gh -->|"issues, recipe"| cond
  cond -->|"branch, merge, labels"| gh
  cond -->|"starts it, hears it back"| agent
  cond -->|"append"| log
  agent -->|"append, through the hook"| log
  log -->|"read"| you
  you -->|"approve · reject · pause"| log

  classDef out fill:#f3efe4,stroke:#8a6a2e,stroke-width:1.5px,color:#14181c;
  classDef work fill:#e6e9ec,stroke:#5c646d,stroke-width:1.5px,color:#14181c;
  classDef truth fill:#e9dcc0,stroke:#8a6a2e,stroke-width:3px,color:#14181c;
  classDef read fill:#e2ecea,stroke:#2c6b67,stroke-width:1.5px,color:#14181c;
  class gh out;
  class cond,agent work;
  class log truth;
  class you read;
```

**Everything writes to the middle, and everything else reads it.** Nothing keeps
private state, which is why the board and the CLI cannot disagree — and why the
three questions above are one query rather than three investigations.

GitHub is on both sides and is neither the middle: an **input**, since it is the
authority on what work exists, and an **output**, told what the log says. It is
never where Lingtai keeps what it did.

## The loop

A pass is ten steps in a fixed order, and what runs at each is the recipe's.
[`the-pass.html`](the-pass.html) draws them and says what each word means.
Several passes may run at once ([0122](decisions/0122-several-passes-share-one-conductor.md)).

A refusal is answered by the agent that is still standing in the worktree, not
by a new run: that is the whole of
[0039](decisions-archive/0039-the-worktree-is-the-whole-of-a-pass.md), and
`runtime.limits.rounds` is how many times. When those are spent on a *refused
review* — an opinion that the approach is wrong, rather than a red check or a
moved base — the claim is released and the next one starts over from the base
carrying every finding, `runtime.limits.restarts` times
([0040](decisions-archive/0040-rounds-bound-depth-restarts-bound-breadth.md)).
Only when every ceiling is spent does it reach a person.

## The architecture, in one screen

The packages fall in two columns. **Nothing on the left names anything on the
right** — `conductor` declares the interfaces it needs, the right column
implements them, and a host wires the two together.

| Decides · no I/O of its own | Touches the world · one thing each |
|---|---|
| **`conductor`** the order of one pass, and the ports it needs | **`event-store`** SQLite or Postgres: append with a version, subscribe from a seq |
| **`actions`** what runs at a point, and what its verdict means | **`projector`** the fold, and the checkpoint in the same transaction |
| **`agent-env`** what the agent's environment holds | **`github`** the App, the token, issues and labels |
| **`recipe`** what the managed repository asked for | **`repo`** git: the mirror, the worktree, the merge lane |
| **`domain`** the vocabulary: event types, streams, reducers | **`agent`** starting the process, hearing it back on the socket |
| | **`env`** the *machine's* credentials, and its state directory |
| | **`hook`** one Bun binary, inside the agent's sandbox |

Two hosts assemble them — `apps/cli` and `packages/daemon` — plus `apps/board`,
which reads the projection and appends decisions. **Every process that appends
holds a projector while it runs**, so the board follows a run by hand just as it
follows the daemon. The daemon adds what only a long-lived process can owe: a
lock file, a heartbeat, a repair at startup, and a loop that keeps taking
work.

There are **two projections**, `task_view` (the board) and `finding_backlog`
(the minors passing gates raised), and each is rebuilt on its own with
`lingtai projection rebuild <name>` — one rebuild per projection. Anything else
you want to know is folded from the log on demand.

## Status

Lingtai works its own repository: the tickets in it are worked by agents Lingtai
dispatched. It is unfinished in the places [`roadmap.md`](roadmap.md) lists, and
[`README.md`](README.md) in this directory indexes the decisions and what is
still open.
