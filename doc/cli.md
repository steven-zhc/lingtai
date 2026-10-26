# The lingtai command line

Generated from `apps/cli/src/commands.ts` and the parser; `lingtai --help` prints the same. Do not edit — run `pnpm docs:cli`.

## Everyday

| To… | Run |
|---|---|
| onboard a repository, on GitHub or on this machine | [lingtai add](#lingtai-add) |
| take the queue, in the recipe’s priority order | [lingtai run](#lingtai-run) |
| what is runnable, and what is holding the rest | [lingtai status](#lingtai-status) |
| ask for one ticket ahead of the queue | [lingtai now](#lingtai-now) |
| follow a run’s log, from the beginning | [lingtai attach](#lingtai-attach) |
| the minor findings passing steps raised | [lingtai backlog](#lingtai-backlog) |
| a project’s own tickets, where the recipe keeps them | [lingtai ticket](#lingtai-ticket) |
| serve, stop or inspect the board | [lingtai board](#lingtai-board) |
| the values a project’s agents are given | [lingtai env](#lingtai-env) |
| replay the end step for items that landed | [lingtai end](#lingtai-end) |

### lingtai add

Onboard a repository, on GitHub or on this machine.

Changes state.

```text
lingtai add [<owner>/<repo>] [flags]
  A GitHub repository the App is installed on, or — with no
  argument, or --local <dir> — a directory with its own origin.
  --github <owner>/<repo>   same as the positional
  --local <dir>             a directory on this machine instead
  --project <github|local>  answers the question above, when neither
                            a slug nor --local is given
  --github-app <create|skip>
      create or skip the App, asked only when none is configured
  --base <branch>
      github: where to read the recipe from, not what the base is —
      the recipe's own repo.base says that, and a --base
      contradicting it is refused. local: the branch the recipe
      governs. default: the repository's own default branch
  --tickets <github|db>
      where tickets come from, instead of being asked. local takes
      db only (#396)
  --kinds <a,b,c>
      which labels are work, first taken first.
      default: bug, feature, documentation
  --agent <claude-code|codex>  which agent writes the change
  --model <name>               the writer's model
  --reviewer <agent|none>      a cold reviewer, and which, or none
  --reviewer-model <name>      the reviewer's model
  --install <cmd>              what prepares a worktree, e.g. npm ci
  --build <cmd|none>           a check that must pass before review;
                               repeat it for more than one
  --land <branch|hold>
      where a pass lands, or hold every pass for a person at proposed
  --rounds <n>                 fix rounds a pass may buy
  --wall <duration>            wall time per agent run, e.g. 1h
  --budget <usd>               a dollar ceiling per agent run
  --defaults
      use every default the questions have. With no terminal, this
      or an answer to every question is required. Before anything is
      registered the checks and the landing are printed, and a run
      that took the defaults for an empty build or an unattended
      landing stops there unless --defaults named it
```

```sh
lingtai add steven-zhc/lingtai
lingtai add --local ~/code/app --tickets db --defaults
```

### lingtai run

Take the queue, in the recipe’s priority order.

Changes state.

```text
lingtai run <project> [flags]
  --issue <n>   one nominated issue instead of the queue
  --max <n>     stop after n items
  --once        the same as --max 1
  --no-merge    stop after the steps and ask before merging
```

```sh
lingtai run lingtai --once
lingtai run lingtai --issue <n> --no-merge
```

### lingtai status

What is runnable, and what is holding the rest.

Reads only — takes `--json` (version 1).

```text
lingtai status [<project>] [--all] [--json] [--no-color]
  Takes nothing and claims nothing.
  --all   include items that have left the queue, and why
  --json  one document instead of the sections
```

```sh
lingtai status
lingtai status lingtai --all
```

### lingtai now

Ask for one ticket ahead of the queue.

Changes state — `--json` on its verdict (version 1).

```text
lingtai now <project> --issue <n> [--json] [--no-color]
```

```sh
lingtai now lingtai --issue <n>
```

### lingtai attach

Follow a run’s log, from the beginning.

Reads only.

```text
lingtai attach <runId>
  What a run is doing, as it does it, however late you attach.
  Reads a file and asks nothing of the daemon or the database, so
  it answers on a stopped system. A landed run has no log: 0034
  keeps exactly the ones still owed an explanation.
```

```sh
lingtai attach <runId>
```

### lingtai backlog

The minor findings passing steps raised.

Changes state — `--json` on its verdict (version 1).

```text
lingtai backlog [<project>] [--all] [--json] [--no-color]
  The open ones. --all adds the decided ones, and what was decided.
lingtai backlog accept <project> <key> --kind <kind> [--unheld]
  Open one as an issue through the ticket store. One key: there is
  no accept-all. Without --kind, opens the issue of an entry
  already accepted — safe to repeat, never a second.
  --unheld   without agent:hold, so the next pass may take it
lingtai backlog decline <project> <key> --reason <why>
  Recorded, so the next attempt does not ask again.
```

```sh
lingtai backlog lingtai
lingtai backlog accept lingtai <findingId> --kind tech-debt
```

### lingtai ticket

A project’s own tickets, where the recipe keeps them.

Changes state — `--json` on its verdict (version 1).

```text
lingtai ticket list [--all] [--project <p>] [--json] [--no-color]
  Only for a project whose recipe keeps tickets in Lingtai's
  database (source.tickets: db); GitHub-backed ones are read with
  gh issue list. Open ones by default; --all adds closed ones.
lingtai ticket close <n> [--project <p>]
  Closes that row — not lingtai close, which ends a work item on
  the log. The daemon drops it on its next sweep, not at once.
lingtai ticket new [--project <p>]
  Opens $VISUAL or $EDITOR on a form: a title, a labels: line, then
  the body. Quitting with the form unchanged does nothing. No kind
  label and the ticket is created with a warning the queue will
  not take it.
lingtai ticket edit <n> [--project <p>]
  The same form, started from the ticket; writes what changed.
--project <p> is required with more than one project registered.
```

```sh
lingtai ticket list --project lingtai
lingtai ticket new --project lingtai
```

### lingtai board

Serve, stop or inspect the board.

Changes state — `--json` on its verdict (version 1).

```text
lingtai board start [--port <n>] [--dir <path>] [--no-open]
  Serve the board pnpm build wrote beside this CLI, in this
  process: the URL is printed, a browser opened, ctrl-c stops it.
  From the source there is no built board:
  pnpm --filter @lingtai/board dev
  --port <n>    default 17820, or board.port in ~/.lingtai/config.yml
  --dir <path>  a built board somewhere else
  --no-open     no browser — what the service’s job passes
lingtai board stop
  Stop the board this machine is running. Not shutdown, which
  waits for a pass. Where a supervisor keeps the board, this is
  its stop, and it stays stopped until lingtai service start.
lingtai board restart
  Stop, then start. Refuses nothing first: a UI at the wrong
  commit costs a reload.
lingtai board status [--port <n>] [--json] [--no-color]
  Who serves it, whether a board answers, whether a supervisor
  keeps one — three facts, none concluded from another.
```

```sh
lingtai board start
lingtai board status
```

### lingtai env

The values a project’s agents are given.

Changes state — `--json` on its verdict (version 1).

```text
lingtai env set <project> KEY=VALUE
  Write one value into ~/.lingtai/env/<project>.env.
lingtai env set <project> KEY
  Read the value from stdin, unechoed.
lingtai env list <project> [--json] [--no-color]
  Names and which layer answered — never values.
lingtai env unset <project> KEY
  Remove one.
```

```sh
lingtai env set lingtai API_TOKEN
lingtai env list lingtai
```

### lingtai end

Replay the end step for items that landed.

Changes state.

```text
lingtai end replay [<project>] [--issue <n>]
  Resolve the end step for items that landed, and deliver what it
  resolves to. --issue limits it to one.
```

```sh
lingtai end replay lingtai --issue <n>
```

## Waiting on you

| To… | Run |
|---|---|
| merge what a held run produced | [lingtai approve](#lingtai-approve) |
| answer a question a ticket was held on | [lingtai answer](#lingtai-answer) |
| hold a ticket on a decision before any run | [lingtai ask](#lingtai-ask) |
| one more implementation round on saved work | [lingtai grant-fix-round](#lingtai-grant-fix-round) |
| end a wait with a new run | [lingtai requeue](#lingtai-requeue) |
| end a ticket nobody is going to do | [lingtai close](#lingtai-close) |

### lingtai approve

Merge what a held run produced.

Changes state — `--json` on its verdict (version 1).

```text
lingtai approve <project> --issue <n> [--note <text>] [--json]
  Merge what a held run produced, if its head has not moved since
  the approval was asked for.
  --note <text>   recorded with the approval, and required when a
                  step still refuses the head: approving then waives
                  each refusing step, with this as why
```

```sh
lingtai approve lingtai --issue <n>
```

### lingtai answer

Answer a question a ticket was held on.

Changes state — `--json` on its verdict (version 1).

```text
lingtai answer <project> --issue <n> "<choice>" [--json]
  Answer it on the record: back in the queue, and every attempt at
  the ticket is told the answer — no editing the issue body.
```

```sh
lingtai answer lingtai --issue <n> "use the second option"
```

### lingtai ask

Hold a ticket on a decision before any run.

Changes state — `--json` on its verdict (version 1).

```text
lingtai ask <project> --issue <n> "<question>" [--json]
  Nothing is spent, the queue passes over the ticket, and lingtai
  status prints the question.
```

```sh
lingtai ask lingtai --issue <n> "which groups?"
```

### lingtai grant-fix-round

One more implementation round on saved work.

Changes state — `--json` on its verdict (version 1).

```text
lingtai grant-fix-round <project> --issue <n> [--if-head <sha>] [--json]
  Run one more implementation round on saved work, then repeat the
  checks without waiving a refusal.
```

```sh
lingtai grant-fix-round lingtai --issue <n> --if-head <sha>
```

### lingtai requeue

End a wait with a new run.

Changes state — `--json` on its verdict (version 1).

```text
lingtai requeue <project> --issue <n> [--note <why>] [--into-body <text>]
                [--json]
  A blocked item goes back to the queue — held for approval or not —
  and the next pass cuts a fresh branch from a base that has since
  moved. The actor is still recorded in by.
```

```sh
lingtai requeue lingtai --issue <n> --note "base moved"
```

### lingtai close

End a ticket nobody is going to do.

Changes state — `--json` on its verdict (version 1).

```text
lingtai close <project> --issue <n> "<reason>" [--json]
  The queue stops offering it because the log says it is over.
  Nothing lifts a close: if the work is wanted again, open a new
  ticket.
```

```sh
lingtai close lingtai --issue <n> "superseded"
```

## Daemon

| To… | Run |
|---|---|
| hold the projections current and take work | [lingtai start](#lingtai-start) |
| the old name of start, still answered | [lingtai daemon](#lingtai-daemon) |
| keep the daemon and the board running | [lingtai service](#lingtai-service) |
| drain, wait for the pass, and start one daemon | [lingtai restart](#lingtai-restart) |
| stop the daemon after the ticket in flight | [lingtai shutdown](#lingtai-shutdown) |
| stop the daemon taking new tickets | [lingtai pause](#lingtai-pause) |
| take tickets again | [lingtai resume](#lingtai-resume) |

### lingtai start

Hold the projections current and take work.

Changes state.

```text
lingtai start [--no-conduct] [--no-merge] [--no-color]
  Reads no standing signal: a pause or a shutdown aimed at an
  earlier daemon was not aimed at this one. If another daemon holds
  the lock this starts nothing and says so. Unchecked — lingtai
  restart is the checked start.
  --no-conduct   projections only, take nothing
  --no-merge     as for lingtai run
```

```sh
lingtai start
lingtai start --no-conduct
```

### lingtai daemon

The old name of start, still answered.

Changes state.

```text
lingtai daemon [--no-conduct] [--no-merge] [--no-color]
  Still answers: an installed LaunchAgent or systemd unit has this
  name written into it (#159). It is lingtai start.
```

```sh
lingtai daemon --no-conduct
```

### lingtai service

Keep the daemon and the board running.

Changes state — `--json` on its verdict (version 1).

```text
lingtai service install|start|shutdown [why]|restart [why]|uninstall
lingtai service status [--json]
  Two jobs, the daemon and the board: a LaunchAgent each on macOS,
  a systemd user unit each on Linux. No service manager? run
  lingtai daemon and lingtai board start in the foreground.
  shutdown drains the conductor through the log, waits for the
  pass, unloads it, then stops the board. restart is that and
  start, unchecked — lingtai restart is the checked one.
  status reports each job on its own: one word for both would hide
  a board that is up beside a conductor launchd keeps respawning.
```

```sh
lingtai service install
lingtai service status
```

### lingtai restart

Drain, wait for the pass, and start one daemon.

Changes state.

```text
lingtai restart [why] [flags] [--no-color]
  Here, or through lingtai service when a supervisor keeps it.
  Refuses a commit the tracking remote does not have, a dirty
  worktree, and what lingtai doctor failed on. Ctrl+C during the
  wait leaves the drain standing; the next restart picks it up.
  --dirty            start from a dirty worktree, having read why not
  --despite-doctor   start in spite of failed doctor checks
  --force, --timeout as for lingtai shutdown
  --no-conduct, --no-merge
      as for lingtai start; refused under a supervisor
```

```sh
lingtai restart "picking up #88"
```

### lingtai shutdown

Stop the daemon after the ticket in flight.

Changes state.

```text
lingtai shutdown [why] [--force] [--timeout <duration>] [--no-color]
  The pass finishes first, so the steps and the merge lane run
  too. It does not outlive the daemon it was sent to.
  --force                do not wait. The agent is left running and
                         the next conductor kills it
  --timeout <duration>   give up waiting after this and exit anyway.
                         Not with --force
```

```sh
lingtai shutdown "deploying"
lingtai shutdown --timeout 10m
```

### lingtai pause

Stop the daemon taking new tickets.

Changes state.

```text
lingtai pause <why> [--no-color]
  A run in flight finishes. About the daemon that is running, and
  gone when it is — but not for lingtai run, which takes no ticket
  while a pause stands, daemon or none: one already working
  finishes the ticket in hand and takes no other.
```

```sh
lingtai pause "reviewing the recipe"
```

### lingtai resume

Take tickets again.

Changes state.

```text
lingtai resume [--no-color]
```

```sh
lingtai resume
```

## Install and upkeep

| To… | Run |
|---|---|
| a bare machine to the board, on the wizard | [lingtai init](#lingtai-init) |
| the version, and which artifact is running | [lingtai version](#lingtai-version) |
| fetch and switch to the newest release | [lingtai upgrade](#lingtai-upgrade) |
| go back to an older installed version | [lingtai rollback](#lingtai-rollback) |
| remove everything under ~/.lingtai and the shim | [lingtai uninstall](#lingtai-uninstall) |
| check everything that can be checked | [lingtai doctor](#lingtai-doctor) |
| how far projections lag, and rebuild one | [lingtai projection](#lingtai-projection) |

### lingtai init

A bare machine to the board, on the wizard.

Changes state.

```text
lingtai init [flags]
  Git and the agents looked at, a store connected to and its tables
  made, ~/.lingtai/config.yml written. Run it again to continue, or
  to see what is set.
  --store <sqlite|postgres>
      the store, instead of being asked. postgres takes
      --database-url with it
  --database-url <url>   instead of being asked
  --port <n>             the board's port, for this run.
                         default: 17820, or board.port
  --project <github|local>  the first project, instead of being asked
  --local <dir>             a directory on this machine, as the project
  --github-app <create|skip>
      create or skip the App, asked only when none is configured
  --base <branch>           the branch a local project governs
  --tickets <github|db>     where tickets come from
  --kinds <a,b,c>          which labels are work, first taken first
  --agent <claude-code|codex>  which agent writes the change
  --model <name>               the writer's model
  --reviewer <agent|none>      a cold reviewer, and which, or none
  --reviewer-model <name>      the reviewer's model
  --install <cmd>              what prepares a worktree, e.g. npm ci
  --build <cmd|none>           a check that must pass before review;
                               repeat it for more than one
  --land <branch|hold>
      where a pass lands, or hold every pass for a person at proposed
  --rounds <n>                 fix rounds a pass may buy
  --wall <duration>            wall time per agent run, e.g. 1h
  --budget <usd>               a dollar ceiling per agent run
  --defaults
      use every default the recipe questions have. With no terminal,
      this or an answer to every question is required. The checks and
      the landing are printed before a project is registered, and a
      run that took the defaults for an empty build or an unattended
      landing stops there unless --defaults named it
```

```sh
lingtai init
lingtai init --store sqlite --defaults
```

### lingtai version

The version, and which artifact is running.

Reads only — takes `--json` (version 1).

```text
lingtai version [--json] [--no-color]
  Platform, binary or script, and the Node running it.
```

```sh
lingtai version
lingtai version --json
```

### lingtai upgrade

Fetch and switch to the newest release.

Changes state.

```text
lingtai upgrade [--despite-doctor]
  Fetch the newest release from GitHub Releases, check its
  checksums, unpack it beside this one in ~/.lingtai/versions,
  drain what conducts, then move ~/.local/bin/lingtai. Starts
  nothing. With lingtai doctor, the one request to the network
  this tool makes on its own account.
  --despite-doctor   upgrade in spite of failed doctor checks
```

```sh
lingtai upgrade
```

### lingtai rollback

Go back to an older installed version.

Changes state.

```text
lingtai rollback [<version>]
  Run ~/.local/bin/lingtai from an older version still in
  ~/.lingtai/versions — the newest one below the current, unless
  named.
```

```sh
lingtai rollback
lingtai rollback 0.9.0
```

### lingtai uninstall

Remove everything under ~/.lingtai and the shim.

Changes state.

```text
lingtai uninstall [--yes] [--nothing-conducts]
  Ask once, remove everything under ~/.lingtai and the shim, then
  name what it could not: the GitHub App, and the log where the
  log is a server.
  --yes               do not ask
  --nothing-conducts  remove a conductor's state though the lock
                      under ~/.lingtai/locks could not be read
```

```sh
lingtai uninstall
```

### lingtai doctor

Check everything that can be checked.

Reads only — takes `--json` (version 1).

```text
lingtai doctor [--json] [--no-color]
  Exits non-zero on any failure. Under --json a failing report is still the
  report document, on exit 1: test .error first (the report could not be
  produced), then .failed.
```

```sh
lingtai doctor
lingtai doctor --json
```

### lingtai projection

How far projections lag, and rebuild one.

Changes state — `--json` on its verdict (version 1).

```text
lingtai projection lag [--json] [--no-color]
  How far each projection is behind the log.
lingtai projection rebuild <name>
  Drop the table, reset the checkpoint, replay.
Projections: task_view, finding_backlog, spend
```

```sh
lingtai projection lag
lingtai projection rebuild spend
```
