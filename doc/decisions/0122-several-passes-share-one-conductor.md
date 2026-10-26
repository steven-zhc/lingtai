# 0122 — Several passes share one conductor: slots per project, who runs together, one landing at a time, what a drain waits for

**Status** accepted · 2026-10-25

One conductor may run several passes at once. How many is `runtime.concurrency`
in a project's recipe, default 1. Tickets that cannot safely run together are
never started together, landings onto one base are taken one at a time, a drain
waits for every pass in flight, and a daily dollar ceiling stops the taking of
new work without ever killing a pass that is running.

**Words.** A **pass** is one ticket's ten steps ([0103](0103-a-pass-is-ten-fixed-steps.md)).
A **look** is one iteration of the work loop over every project
(`pump` → `drain` → `options.pass` in `packages/daemon/src/work-loop.ts`); the
code's own comments call it a pass, and this ADR does not. A **slot** is one
place a pass may run: the pair (project, number in flight).

## Context

Everything above the lock was written for one pass at a time.
`work-loop.ts` says so in *One pass at a time*: running a second concurrently
"would race for the same claim". `apps/cli/src/conduct.ts` hands every project
`max: options.max ?? 1`, `runQueue` in `packages/conductor/src/schedule.ts`
awaits each `runOnce` in turn, and the beacon names one `currentRunId`
([0102](0102-one-conductor-holds-the-lock.md) §2). The operator's decisions in
epic #341 are the inputs here: concurrency is inside one conductor, never two
conductors; everything that does not collide runs; landings are one at a time;
and the dollar ceiling lands before any N > 1.

## Decision

1. **Slots are per project, and the installation has no cap of its own.**
   `runtime.concurrency` is an integer ≥ 1 in the recipe, default 1. The
   installation runs the sum of its projects' slots; what bounds money is §5, not
   a count. A slot is (project, count in flight), so a stop that is per project
   (§7) stops one project's slots and leaves another's. The key must exist in the
   running daemon's recipe schema before it is written into a recipe (*code,
   restart, paste*, [the-plugin-body](../design/the-plugin-body.md)); Lingtai's own
   `concurrency: 2` is an operator change after that restart.

   **Looks stay one at a time. A look starts passes into free slots and does not
   wait for them. A pass finishing triggers another look** (completion events
   already wake the loop, `work-loop.ts`). Serial looks are what keep the claim
   race closed; the claim's expected-version append
   ([0109](0109-the-core-takes-a-ticket.md) §5) is the backstop. This replaces the
   single `running`/`again` pair in `work-loop.ts`, the `max: options.max ?? 1`
   in `apps/cli/src/conduct.ts`, and the sequential `for (;;)` in `runQueue`
   (`packages/conductor/src/schedule.ts`): each takes the free slots of its
   project and returns when they are started.

2. **Who runs together.** Order is `selectRunnable`'s (`packages/conductor/src/queue.ts`,
   called from `schedule.ts`) and does not change: kind, then issue number. A look
   fills free slots by walking that order and **skipping**, not stopping at, any
   candidate that collides with a pass in flight in the same project: a higher
   ticket that collides waits for the collision to clear and a lower one that does
   not collide takes the slot.
   - **A blocked-by chain never runs together.** This is already so: a ticket with
     an open blocker is passed over as `blocked-by`
     (`packages/conductor/src/discover.ts`), and a blocker in flight is open until
     it lands and closes. A→B→C excludes C through B. Nothing is built for it.
   - **Tickets whose `Fix` rows name the same file never run together.** The files
     are the backticked tokens in the four-row table's `Fix` cell that contain a
     `/` or an extension, with a trailing `:line` removed. Two tickets collide when
     any path is equal, or when a bare file name equals the last segment of the
     other's path. **A ticket with no `Fix` row, or none naming a file, collides
     with nothing**: everything else runs, and no agent is paid to predict scope.
     What this lets through is caught by the re-review on a moved base (§3, #593)
     and by conflict waits (#589).
   - **The in-memory set of passes in flight is subtracted first.** A ticket
     claimed a moment ago may still read `queued` in `task_view` on the next look,
     because the projection lags the claim. If both miss, the claim's version
     check refuses the second.

3. **Landings are taken one at a time per project and base, in the conductor's
   memory.** The serialising point is the `land` function `conduct.ts` builds and
   hands to `createMergeAction` (`packages/actions/src/merge-action.ts`): a second
   `land` call waits for the first to answer. It is not a file lock and
   `packages/repo/src/integrate.ts` does not change. Its statement that the lane
   holds no lock stays true of git, which is still the guarantee against a
   person's push or another machine. Serialising records an ordering, not a
   safety: two lanes at once would both run `verify`, and the loser would run it
   again.

   **A later landing re-checks on the new base.** Each attempt in `integrate.ts`
   fetches the base afresh and runs the `base-moved` overlap check, so a landing
   that starts after the earlier push sees the new base and, when the changed files
   overlap, goes back to `build` and `review` (#593). The lost-push retry already
   re-runs all of it.

4. **A drain waits for every pass in flight.** `stop()` and `busy` in
   `work-loop.ts` await every pass's promise, not one retained promise, and the
   beacon names every run in flight ([0102](0102-one-conductor-holds-the-lock.md)
   §2, §8). `apps/cli/src/restart.ts` needs no new mechanism: `waitForTheLock`
   already waits for the daemon to exit, and `facts.inFlight()` already returns a
   list. Its sentence about what a drain may spend stays one pass's ceiling
   (`WALL_LIMIT`), because the passes run side by side and none starts after the
   drain is asked for.

5. **The daily dollar ceiling pauses taking new work and never stops a pass in
   flight.** It is one figure in `~/.lingtai/config.yml`
   ([0117](0117-configuration-is-config-yml-and-the-environment.md), so it can
   also be exported as a `LINGTAI_` variable) and it stays installation-wide,
   because one account pays. **While none is set, the installation runs one
   pass in all**, whatever each project's `concurrency` says: a look starts a
   pass only when nothing is in flight in any project, so two projects with a
   free slot each do not run together. `lingtai doctor` says so: no N > 1 runs
   unbounded.
   - The day is the machine's local calendar day. Spend is the sum of today's
     `spend` rows; a row whose `costUsd` is null is priced from the rate card at
     the moment of reading, never in a fold
     ([0110](0110-tokens-on-the-event-money-at-display.md) §5–6), and a row that
     cannot be priced is named as unknown and never counted as zero.
   - It is checked where the pause is already asked before each claim
     (`schedule.ts`, `work-loop.ts`). Reaching it appends `ConductorPaused` with
     `until` at the next local midnight, and the reason names the figure and
     today's spend, by the standing-down path of `conduct.ts`
     ([0108](0108-a-refusal-buys-a-round.md) §11). It needs no
     `holdsAcrossStarts`: a restarted daemon recomputes and pauses again at its
     first check.
   - **The overshoot is bounded only as far as the recipe bounds a pass.** The
     figure is `passCeiling`'s (`packages/conductor/src/ceiling.ts`) times the
     slots in flight, and that product counts `implement`'s runs alone: the cold
     reviewer's and a judge's calls are outside it, and `runtime.limits.usd` is
     optional. So the daily ceiling is a bound on when new work stops being
     taken, not on the day's total; what a pass spends after the ceiling is
     reached is whatever its own limits allow, and **Lingtai states no figure for
     it**: `passCeiling` is `implement`'s alone, so slots × that figure is not a
     bound. An operator who wants one adds up `runtime.limits.usd` over every
     step that dispatches (the implementation rounds, the cold reviewer, a judge)
     for one pass, and multiplies by the slots in flight; a step with no
     `runtime.limits.usd` makes the sum unbounded. That is the price of never
     killing a pass.

6. **Per pass, and shared.**

   | Resource | Where | Per pass because, or shared and safe because |
   | --- | --- | --- |
   | Worktree | `~/.lingtai/worktrees/<project>/<runId>` (`run-log.ts`) | Per pass: named by `runId`. |
   | Branch | `agent/<issue>` | Per pass: one issue is one pass. |
   | Run log | `runLogPath` (`run-log.ts`) | Per pass: `<runId>.log`. `findOrphanLogs` reads only `*.log`, so it leaves the `runs/<runId>/` directories alone. |
   | Hook socket | `socketPathFor` (`packages/agent/src/hook-config.ts`) | Per pass: `tmpdir()/lingtai/<sha256(home, runId)[:12]>.sock`. The parent directory is shared and safe, since each name is per run and a socket is removed only by the run that made it. |
   | Agent settings | `settingsPathFor`, `<home>/runs/<runId>/settings.json` | Per pass: under the run's own directory, as its labelled siblings are. |
   | Codex output schema | `tmpdir()/lingtai-output-schema-<runId>.json` (`codex.ts`) | Per pass: named by `runId`. |
   | Scratch directories | `sea-build.ts`, `triage-checkout.ts`, `install.ts`, `ticket.ts`, `apps/release/src/binary.ts` | Per call: each is a `mkdtemp`. |
   | Test lock directory | `setup()` in `teardown.ts`, a `mkdtemp` | Per vitest run. The unit project has no `globalSetup`, so a unit test that took a lock would throw rather than take the operator's. |
   | Test store | a SQLite file in a directory made per vitest run by `packages/event-store/test-support/teardown.ts`, only while no `LINGTAI_TEST_DATABASE_URL` is set | Per pass. The gate's `pnpm test` gets `PATH, HOME, TMPDIR, LANG, USER, LOGNAME` plus the project's env file, so the URL reaches a pass only if the operator wrote it there, which is the case below. |
   | Ports | every test that binds uses `listen(0, …)` | No port is assigned to a pass. `17820` and `18080` in `apps/cli/unit/board*.test.ts` are values handed to a fake world that starts no server. The one gap is `freePort()` then spawn in `apps/release/integration/build.test.ts`: the port is free when probed and could be taken before the spawn uses it. Two runs drawing the same ephemeral port is very unlikely, and it is integration-only. Held by `packages/event-store/unit/no-fixed-port.test.ts`. |
   | `node_modules`, `.vite`, `.next` | inside the worktree | Per pass: `node_modules` is a real directory, not a link. |
   | pnpm content store | under the operator's `HOME` | Shared. Concurrent `pnpm install` is safe by pnpm's own atomic writes, which is pnpm's claim and not proven here; it held with two `pnpm test` runs in two checkouts at once (#641). |

   **With `LINGTAI_TEST_DATABASE_URL` set the test store is shared, not per pass:**
   `setup()` makes no directory for it, every pass's suite writes the one Postgres
   database, and the first suite's teardown deletes every `esctest*` event and
   control stream in it, including a still-running pass's. At N > 1 a pass
   therefore runs its tests with no URL set, or the URL names a database of its
   own.

   A test that binds a fixed port is a defect at N > 1, and
   `packages/event-store/unit/no-fixed-port.test.ts` fails on one in either half
   of the suite.

   **Shared:** the event store, the lock, the beacon, the projector, the GitHub
   App token, the runtime's account and quota, the recipe file, and the bare
   mirror. Writes to the mirror (fetch, `worktree add`, `worktree remove`) are
   taken one at a time in the conductor, in memory like §3, because concurrent
   fetches into one repository can fail to lock a ref.

7. **Every stop that exists today is marked *per project* or *stays
   installation-wide*.** This records the classification; #449 builds it.

   | Stop | Where today | Becomes | Lifted by |
   | --- | --- | --- | --- |
   | A person's pause | `CONTROL_STREAM`, `packages/domain/src/control.ts` | Per project: `ConductorPaused` gains an optional `project`, absent meaning installation-wide | `lingtai resume [project]` |
   | The pause over a tier the setup cannot provide (#405) | `conduct.ts` | Per project | Fixing the setup, then a restart |
   | The pause after a run that never started | `packages/conductor/src/never-started.ts`, [0108](0108-a-refusal-buys-a-round.md) §11 | Stays installation-wide: the account is shared | Itself, at `until` |
   | The daily ceiling | §5 | Stays installation-wide | Midnight, or a higher figure |
   | Shutdown and drain | [0102](0102-one-conductor-holds-the-lock.md) §8 | Stays installation-wide | `lingtai resume` |
   | The lock | [0102](0102-one-conductor-holds-the-lock.md) §4 | Stays installation-wide | — |
   | *One pass at a time* | `work-loop.ts` | Per project, as slots (§1) | — |
   | A refused recipe | `stage: "recipe"` in `conduct.ts` | Already per project | — |
   | A missing environment | `env` in `schedule.ts` | Already per project | — |
   | No GitHub App | `projectsForPass` in `apps/cli/src/conduct.ts` (#355) | Stays installation-wide: one App per machine ([0114](0114-a-github-app-not-a-token.md)) | — |
   | A red base | None exists | If one is added, it is per project | — |

## Consequences

- Both the beacon and the work loop hold a set of runs where they held one.
  `lingtai status`, `doctor` and the board's bar read the set.
- Until a ceiling is configured nothing changes for anyone: one pass in the
  whole installation, as today.
- Two tickets that collide in a way a `Fix` row did not predict both run, and the
  second to land pays a re-review on the new base. That cost is chosen over paying
  an agent to predict scope.

_New topic; replaces no archived ADR. The design discussion is #341 and #636._
