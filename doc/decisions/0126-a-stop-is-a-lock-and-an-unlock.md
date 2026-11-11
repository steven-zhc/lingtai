# 0126 — A stop is a lock and an unlock on the stream of what it stops

**Status** accepted · 2026-11-11 · not yet built; the system locks wait on
[0127](0127-the-daemon-has-one-scheduler.md)

Three things stop new work: a person pausing a project, the day's spend reaching
the ceiling, and a runtime's account reaching its usage limit. Each is a pair of
events, one that locks and one that unlocks, on the stream of the thing it stops;
the state is what replaying them gives. The work loop only reads them, a watcher
on the daemon's scheduler writes the two the system owns, and one function in
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
see *A tier no runtime can provide*.

## Decision

1. **Every stop is a pair of events: one that locks and one that unlocks.**
   The state is what replaying them gives; the last of the pair wins. Nothing
   is locked or unlocked by a clock or a configuration file read inside a reducer.

2. **The pair goes on the stream of the thing it stops.**

   | Stop | Stream | Locks | Unlocks | Who appends the unlock |
   | --- | --- | --- | --- | --- |
   | A person's pause | `prj-{project}` | `ProjectPaused {project, by}` | `ProjectResumed {project, by}` | A person: `lingtai resume [project]`, the board's banner, or the bar with that project selected |
   | The day's ceiling | `ctl-conductor` | `DayCeilingReached {day, reportedUsd, estimatedUsd, ceilingUsd}` | `DayCeilingLifted {day, why: new-day \| config-raised \| config-removed}`, or `{day, why: person, by, toUsd}` | The ceiling watcher; or a person raising today's ceiling (§7) |
   | A runtime's usage limit | `acct-{runtime}` | `AccountLimitReached {runtime, until, untilFrom, said}` | `AccountLimitLifted {runtime}` | The account watcher, once `until` has passed |

   A project's own state is the Project aggregate's. The ceiling is the
   installation's budget. An account is shared by every project on the machine
   whose recipe uses its runtime, and is its own aggregate.

3. **Appended on the transition only.** A writer reads the stream's state, appends
   at that head only if the state changes, and on a concurrency error re-reads and
   decides again. Locking what is locked and unlocking what is unlocked append
   nothing. This is the rule `ProjectRefused`/`ProjectRecovered` follow
   (`turnTransition`).

4. **The work loop only reads; each system lock has a watcher that writes.** The
   work loop reads the states and asks §5's function; it never appends a lock or
   an unlock and has no branch deciding whether to. A lock's own events are
   trigger events for the work loop, so an unlock is acted on at once.

   The two system locks are written by watchers on the daemon's scheduler
   ([0127](0127-the-daemon-has-one-scheduler.md)), in the conductor-lock holder
   only, so each event has one writer:

   | Watcher | Wakes on | Appends |
   | --- | --- | --- |
   | Day ceiling | each `RunSpent`; local 00:00, recurring; a change to the configuration | `DayCeilingReached`; `DayCeilingLifted {why: new-day \| config-raised \| config-removed}` |
   | Account limit | the attempt that met the limit, which appends the lock where it learned of it; a one-shot at `until` | `AccountLimitReached`; `AccountLimitLifted` |

   A person's events are appended by the CLI and the board, as any command's are.

   **A watcher sees an event before the work loop does.** In the lock holder, each
   event is handed to the watchers first, and the work loop looks only once they
   have appended what it implies. So a `RunSpent` that takes the day past its
   ceiling is followed by `DayCeilingReached` before the loop can claim again, and
   no attempt starts in between.

   On start each watcher reads its state, registers again what it implies (0127
   §3), and checks at once what may have changed while no conductor was up: a new
   day, a passed `until`, an edited configuration. With no conductor up nothing is
   appended and nothing runs, and the log says *locked until the conductor came
   back*, which is what happened.

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

7. **A person can lift a person's pause, and today's ceiling — to a higher
   figure, never to none.** Raising the ceiling names a figure for today:
   `DayCeilingLifted {day, why: person, by, toUsd}`. For that `day` only, the
   watcher then compares against the larger of `toUsd` and the configuration's
   figure, and when the day's spend reaches it, locks again with a
   `DayCeilingReached` naming that figure. A new day forgets it. A `toUsd` not
   above the day's spend is refused by name and appends nothing. The ceiling is
   also lifted by raising or removing it in the configuration.

   An account limit is lifted by time only. `lingtai pause` and `lingtai resume`
   with no project mean every registered project.

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
     take work. No action.

   A lock whose `until` has passed but whose unlock is not yet appended (no
   conductor is up) keeps its row, greyed: *passed, lifts when the conductor next
   looks*, never as still holding.

   Elsewhere a lock is only marked, never explained or acted on twice: the footer
   is a reading (today's spend in the fail colour at the ceiling; a raised day's
   figure with *today only, raised from $y by you*); a queued card of a locked
   project says which lock holds it; the project filter marks a paused project.

## A tier no runtime can provide

A tier is the containment a recipe requires (`open`, `guarded`, `sandboxed`), and
what each runtime provides is a constant in code (`claude-code.ts`, `codex.ts`).
A recipe that requires a tier one of its own runtimes cannot provide is a recipe
in error, not a state of the machine: it is fixed by editing the recipe, and it is
known before anything is claimed (`missingForTier`). So it is refused where any
recipe in error is refused, when the recipe resolves, per project
([0122](0122-several-passes-share-one-conductor.md) §7, *A refused recipe*), and
the project takes work again on the first look after the recipe is fixed. It has
no lock, no watcher and no events of its own. #676 builds this.

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

**Order of landing.** The person's pause lands before the scheduler; the ceiling
and the account limit land after it. Until both have, the conductor-wide pause is
what they still write, and it keeps everything it has: the board's `Paused` chip
shows it, and a bare `lingtai resume` lifts it as well as resuming every project.
It stops what it stops today and no more: a discussion or a triage is stopped
by the locks §5 returns, not by it. Nothing above is removed until both system
locks have moved.

**Upgrading:** a `ConductorPaused` standing when a daemon restarts onto the
removal stops nothing any more. Run `lingtai resume` before that restart;
`doc/operating.md` says so.

## Not decided here

- More than one account per runtime on one machine. `acct-{runtime}` assumes one.
- How the ceiling watcher hears that the configuration changed (a file watch, or
  a recurring job reading it): 0127's.
- What the ceiling watcher does when today's spend cannot be trusted to be
  current, which 0122 §5 answers with *no work is taken*.
- Keyboard shortcuts for pausing and resuming. They belong to a board-wide scheme
  (choose a project, then act on it), designed in its own epic.
