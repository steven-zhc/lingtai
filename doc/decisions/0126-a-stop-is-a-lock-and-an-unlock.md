# 0126 — A stop is a lock and an unlock on the stream of what it stops

**Status** accepted · 2026-11-11 · amended 2026-11-13: an account is a platform's, and a rate limit is its lock; a missing tier is a refused required sandbox · not yet built

Three things stop new work: a person pausing a project, the day's spend reaching
the ceiling, and a platform's account reaching a limit — a runtime's usage limit,
or a code host's rate limit. Each is a pair of
events, one that locks and one that unlocks, on the stream of the thing it stops;
the state is what replaying them gives. The work loop only reads them, one guard
checked before work is taken writes the two the system owns, and one function in
`packages/domain` answers *may this project start new work?* for every gate and
every reader.

## Context

All three were one event, `ConductorPaused`, on `ctl-conductor`, with a `cause`
to tell them apart, and each grew its own way of being lifted: a person's
`resume`, a reducer reading the clock against `until`, `ceilingWaivedUntil`, a
pause that lifts itself (`liftOwnPause`), a watermark that drops a pause older
than the daemon (`scopeControl`) unless it `holdsAcrossStarts`. A pause about one
project stopped every project.

The pause over a tier the setup cannot provide (#405) is not a stop of this kind:
see *A required sandbox the host cannot provide*.

## Decision

1. **Every stop is a pair of events: one that locks and one that unlocks.**
   The state is what replaying them gives; the last of the pair wins. Nothing
   is locked or unlocked by a clock or a configuration file read inside a reducer.

2. **The pair goes on the stream of the thing it stops.**

   | Stop | Stream | Locks | Unlocks | Who appends the unlock |
   | --- | --- | --- | --- | --- |
   | A person's pause | `prj-{project}` | `ProjectPaused {project, by}` | `ProjectResumed {project, by}` | A person: `lingtai resume [project]`, the board's banner, or the bar with that project selected |
   | The day's ceiling | `ctl-conductor` | `DayCeilingReached {day, reportedUsd, estimatedUsd, ceilingUsd}` | `DayCeilingLifted {day, why: new-day \| config-raised \| config-removed}`, or `{day, why: person, by, toUsd}` | The guard; or a person raising today's ceiling (§7) |
   | A platform account's limit | `acct-{platform}` | `AccountLimitReached {account, until, untilFrom, said}` | `AccountLimitLifted {account}`, or `{account, by}` | The guard, once `until` has passed; or a person who knows it is over (§7) |

   A project's own state is the Project aggregate's. The ceiling is the
   installation's budget. An account is shared by every project on the machine
   that uses its platform, and is its own aggregate. `account` names the
   platform: a runtime (`claude-code`, `codex`) or a code host (`github`, and
   any later one such as `gitlab`).

   **A rate limit is an account limit.** A platform that answers *too many
   requests* is limiting the account, not one ticket, so every project on that
   account would meet it next: the first call that meets it appends
   `AccountLimitReached` for the platform, and the guard stops new work on
   every project that uses it until `until`. `until` is the platform's own word
   where it gives one — `retry-after`, or GitHub's `x-ratelimit-reset` —
   recorded in `untilFrom`; where it gives none, one minute, doubling on each
   limit met again before an unlock (`untilFrom: 'backoff'`). Which answers are
   a rate limit, and which header carries the wait, is the failure module's
   table ([0108](0108-a-refusal-buys-a-round.md) §19,
   [doc/design/platform-errors.md](../design/platform-errors.md)): a
   permission 403 is never one. **The call that met the limit is not a
   failure of its attempt**: the attempt waits for the unlock and makes the
   same call again, in place — no agent run, no round, and nothing redone — as
   any attempt in flight goes on under a lock (§6).

3. **Appended on the transition only.** A writer reads the stream's state, appends
   at that head only if the state changes, and on a concurrency error re-reads and
   decides again. Locking what is locked and unlocking what is unlocked append
   nothing. This is the rule `ProjectRefused`/`ProjectRecovered` follow
   (`turnTransition`).

4. **The work loop only reads; one guard writes the system locks, before work
   is taken.** The work loop reads the states and asks §5's function; it never
   appends a lock or an unlock and has no branch deciding whether to. A lock's
   own events are trigger events for the work loop, so an unlock is acted on at
   once.

   The two system locks are written by one module, the guard, in the
   conductor-lock holder only. It has one entry point, and every gate calls it
   at the moment it would start work: each claim, each start, a discussion, a
   triage. Its answer is a fact about the moment it is asked, and a queue read
   can take long enough to change it (#861). The call brings the system locks
   up to the present and returns §5's answer for that project; it is a few
   local reads, next to the GitHub request every look already makes. Each check
   in it is a function of the state, the time and the configuration that
   returns the events to append:

   | Check | Locks | Unlocks |
   | --- | --- | --- |
   | Day ceiling | `DayCeilingReached` when today's spend reaches the ceiling | `DayCeilingLifted {why: new-day \| config-raised \| config-removed}` |
   | Account limit | none: the attempt that met the limit appends `AccountLimitReached` where it learned of it | `AccountLimitLifted` once `until` has passed |

   The entry point is built with the person's pause (#991), when its only
   check reads `prj-` and appends nothing, so every gate calls it from the
   first; the ceiling and the account limit are each a check added to it. A new
   check is a function added to the guard; neither the work loop nor any gate
   changes.
   The guard is the only writer of these events besides that attempt and a
   person (§7), and a test holds that. It replaces `dayCeilingPause`, which
   asked the same question before each claim.

   **Nothing runs on a timer of its own.** A look happens at start, after every
   attempt, on a control event and on the five-minute sweep
   ([0102](0102-one-conductor-holds-the-lock.md) §13). So a passed midnight, a
   passed `until` or an edited configuration is acted on at the next look, at
   most five minutes late and only when there is work to take it from. A lock
   is never late: the `RunSpent` that takes the day past its ceiling is read by
   the next look before it claims. A person raising today's ceiling appends at
   once (§7).

   The first look after a start is the start's check. With no conductor up
   nothing is appended and nothing runs, and the log says *locked until the
   conductor came back*, which is what happened.

   The day, and what today's spend is, stay [0122](0122-several-passes-share-one-conductor.md)
   §5's: the machine's local calendar day, and a row that cannot be priced named
   as unknown, never counted as zero.

5. **One function answers *may this project start new work?*** It takes the
   project's state, the control state and the state of each `acct-{runtime}` the
   project's resolved recipe uses, and returns every lock that applies, with its
   kind, since when, by whom and, where there is one, until when. An empty list
   means yes. Every gate calls it — the claim, `launch`, an approved continuation,
   a granted fix round, a discussion, `lingtai now`, `lingtai run` — and so does
   every reader: the board's banner, cards, project filter and project actions,
   `lingtai status` and `doctor`. It is written once, in `packages/domain`.

6. **A lock stops new work only.** An attempt already running is not interrupted
   by any of the three, and what runs inside it goes on: its fix rounds, its
   judge, its merge. Every agent run that would start outside an attempt in
   flight is new work and is stopped: a discussion a person asked for, and the
   triage of a wait, included;
   to have it, the person resumes the project or raises today's ceiling first.
   A run that meets an account limit has already failed; that is the runtime's
   doing, not the lock's.

7. **A person can lift a person's pause, an account limit, and today's
   ceiling — to a higher figure, never to none.** Raising the ceiling names a figure for today:
   `DayCeilingLifted {day, why: person, by, toUsd}`, **at any time of the day,
   before the ceiling is reached as well as after**. Raised before, it takes no
   lock away and only sets the figure, so the day never stops at the lower one.
   For that `day` only, the
   guard then compares against the larger of `toUsd` and the configuration's
   figure, and when the day's spend reaches it, locks with a
   `DayCeilingReached` naming that figure. A new day forgets it. A `toUsd` not
   above the day's spend, or not above the figure today already has, is refused
   by name and appends nothing. The ceiling is
   also lifted by raising or removing it in the configuration.

   An account limit is lifted when its `until` passes, or by a person who knows
   it is over before then — a runtime signed back in, an `until` read wrong:
   `AccountLimitLifted {runtime, by}`. A restart does not lift it. If the limit
   still holds, the next run meets it, never starts, and locks it again; that
   costs one run that never started, and nothing else. `lingtai pause` and
   `lingtai resume` with no project mean every registered project.

8. **The project filter scopes everything, and the banner is the one place that
   says why nothing starts.** The bar's project filter lists *all projects* and
   each project, and nothing else; a paused project carries a *paused* mark. A
   `+` beside it adds a repository. What the filter selects scopes the tickets,
   the banner, the project actions and *Report* alike.

   With one project selected, the bar's right side holds that project's actions,
   *Recipe* and *Pause* (*Paused · resume* while it holds), set apart from
   *Report*. With *all projects* there are no project actions; in the filter's
   menu, the project row under the pointer shows, faintly, what choosing it gives
   (*recipe · pause*, or *recipe · resume*). A page that belongs to one project,
   such as its recipe, shows the bar as if that project were selected. An
   installation with one project selects it by default.

   On every page with the bar, a banner under it carries one row per lock that
   holds the selected scope, and is absent when there are none: for one project,
   exactly the locks §5 returns for it; for *all projects*, every lock that holds
   any project. Rows are ordered: the ceiling, then each account limit, then each
   person's pause by project name. Each row names the lock and holds the action
   that lifts it, where a person may:
   - a person's pause: the project, who and since when, and *resume*;
   - the ceiling: that today's spend reached it, and *continue today to $[x]*;
   - an account limit: the runtime, `until`, which projects wait and which still
     take work, and *lift*, for a person who knows it is over.

   A lock whose `until` has passed but whose unlock is not yet appended (no
   conductor is up) keeps its row, greyed: *passed, lifts when the conductor next
   looks*, never as still holding.

   Elsewhere a lock is only marked, never explained or acted on twice: the footer
   is a reading (today's spend in the fail colour at the ceiling; a raised day's
   figure with *today only, raised from $y by you*); a queued card of a locked
   project says which lock holds it; the project filter marks a paused project.

## A required sandbox the host cannot provide

A recipe that requires the sandbox (`sandbox.required: true`,
[0127](0127-what-an-agent-can-reach.md) §13) on a host that cannot provide it is
a recipe in error, not a state of the machine: it is fixed by editing the recipe
or the host, and it is known before anything is claimed. So it is refused where
any recipe in error is refused, when the recipe resolves, per project
([0122](0122-several-passes-share-one-conductor.md) §7, *A refused recipe*), and
the project takes work again on the first look after it is fixed. It has no
lock, no check in the guard and no events of its own. Until the tier is removed
from the code (0127 §10), a missing tier still pauses the conductor
(`ConductorPaused {cause: 'setup'}`), and `lingtai resume` lifts it.

## Shutdown and drain

They are not stops of this kind and stay on `ctl-conductor`
([0102](0102-one-conductor-holds-the-lock.md) §8), but they follow the same rule:
a pair of events, and the state is what replaying them gives. **A drain lasts
from `ConductorShutdownRequested` to the next `ConductorStarted`.** The daemon
that reads it finishes every attempt in flight and exits; the start after that
ends it, for every reader alike, where before only the daemon's own watermark
(`scopeControl`) ended it, and `lingtai restart`, which refuses a drain somebody
else asked for, still saw it standing.

So a drain is never withdrawn. A person does not withdraw it (`lingtai resume`
does not touch it), and a `restart` does not either: the start it makes ends its
own request. A `restart` that finds this person's own drain standing (a Ctrl+C
during its wait) picks it up. One that finds somebody else's, with no daemon left
to act on it, is refused by name, and the refusal says that starting a conductor
(`lingtai daemon`) ends it.

## Removed

`ConductorPaused`, `ConductorResumed` and `PauseCause`; the writers of
`ConductorShutdownWithdrawn`, whose type is retired but still reduced, so a
withdrawal already in the log keeps its meaning; `holdsAcrossStarts`, `ceilingWaivedUntil` and `liftOwnPause`;
`scopeControl` and the pause half of `evaluateControl`; the conductor-wide pause
over a missing tier in `conduct.ts`; the board's `Paused` chip and every
installation-wide pause branch in the CLI and the board. Events of the removed
types already in the log still parse and are reduced to nothing.

**Order of landing.** The person's pause lands first; the ceiling and the
account limit after it. Until both have, the conductor-wide pause is
what they still write, and it keeps everything it has: the board's `Paused` chip
shows it, and a bare `lingtai resume` lifts it as well as resuming every project.
It stops what it stops today and no more: a discussion or a triage is stopped
by the locks §5 returns, not by it. Nothing above is removed until both system
locks have moved.

**Deferred to 0.14.0.** The pause over a missing tier is not removed with the
rest: until the tier is removed (0127 §10), `ConductorPaused` with `cause: 'setup'`, `ConductorResumed`,
the `Paused` chip (which then speaks only of it) and a bare `lingtai resume`
lifting it stay. #1013 removes everything else listed above; the remainder goes
with the tier's removal.

**Upgrading:** a `ConductorPaused` other than the setup's standing when a daemon
restarts onto the removal stops nothing any more. Run `lingtai resume` before that restart;
`doc/operating.md` says so.

## Not decided here

- More than one account per platform on one machine. `acct-{platform}` assumes one
  (for GitHub, one App per machine, [0114](0114-a-github-app-not-a-token.md)).
- What the guard's ceiling check does when today's spend cannot be trusted to be
  current, which 0122 §5 answers with *no work is taken*.
- Keyboard shortcuts for pausing and resuming. They belong to a board-wide scheme
  (choose a project, then act on it), designed in its own epic.
