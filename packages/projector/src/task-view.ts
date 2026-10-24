/**
 * `task_view` — the one projection.
 *
 * It replaces `board` and `queue`. One row per task Lingtai
 * has touched, holding the latest state and the metadata a card shows, and
 * nothing else: the board's list view is a `select` against this table and no
 * second query ([0012](../../../doc/decisions-archive/0012-one-task-view.md)).
 *
 * ## What is deliberately not here
 *
 * **Gate evidence, review findings, the diff.** All of
 * it is read from the event stream when somebody opens one task. A list view
 * and a detail view have opposite economics — the list is read constantly and
 * needs to be cheap, the detail is read rarely by one person about one task,
 * and folding a few dozen events on the spot is imperceptible. Building a table
 * for the second is paying continuously for an occasional read.
 *
 * The old `board` projection carried all of it, and the card grew heavy for
 * exactly that reason: what is available gets rendered. Moving detail behind a
 * task id makes a card's contents a decision instead of a consequence.
 *
 * ## Two rules that keep a rebuild honest
 *
 * **Every timestamp comes from `event.at`, never from `now()`.** A projection
 * whose rows depend on the clock cannot be rebuilt to the same table twice,
 * which would cost the property that lets a projection's shape change freely at
 * all. That property is load-bearing here, because this table's shape is
 * expected to move.
 *
 * **Retention is the reader's job.** `closed_at` is recorded and every row is
 * kept; `readTasks` filters. The two-day window is a `where` clause, so it is
 * configurable without a rebuild and a rebuild does not depend on when it ran.
 *
 * ## Counting
 *
 * Increments are guarded by `updated_seq <` rather than `<=`, so a replay lands
 * on the same numbers. Gate verdicts are a keyed map rather than a list, for
 * the same reason: assignment is idempotent and appending is not. Only the
 * verdict is kept — the evidence that came with it is detail.
 *
 * That key includes the run (#78). Keying it `point:action` alone bought
 * replay-safety and quietly gave up scope: a second attempt overwrote the same
 * cells, and in the window between a release and the next attempt reaching the
 * same point the card asserted a verdict no live run held. `ticket-lingtai-59` read
 * `1 passed · attempt 2` while attempt 1's only gate belonged to a run an
 * operator had killed hours earlier. Keying by run keeps both properties:
 * assignment is still idempotent, and `readTasks` shows only the run the card
 * names.
 */
import type { BlockDiagnosis, LabelState, PayloadOf } from '@lingtai/domain'
import { cardFactOf, parseTicketStream, waitBranchOf, waitWords, WaitId } from '@lingtai/domain'
import { WaitReason, type TriageFacts } from '@lingtai/domain/wait'

import { withProjectionStore } from './choose.ts'
import type { Projection, ProjectionContext } from './store.ts'

/**
 * Where a task is.
 *
 * Every one of these now comes from a fold — `queued` used to be written
 * straight into the table by `syncQueued`, with no event behind it, which is
 * why a queue change reached nobody (#56). A task is `queued` because the log
 * says it was released or unblocked, or because it has no row at all and
 * GitHub is offering it.
 */
export type TaskState = LabelState

export const TASK_VIEW_TABLE = 'task_view'

/** How long a landed task stays on the board. A query, not a rebuild. */
export const DEFAULT_RETENTION_DAYS = 2

export const taskViewProjection: Projection = {
  name: 'task_view',

  async create(ctx) {
    await ctx.query(`
      create table if not exists task_view (
        task_id      text primary key,
        project      text not null,
        issue        text not null,
        -- Null means not known yet. The reader renders the fallback, so a
        -- claim that carries no title cannot overwrite one that GitHub gave.
        title        text,
        kind         text,
        state        text not null,
        tier         text not null default 'guarded',

        run_id       text,
        turns        int,

        base_sha     text,
        head_sha     text,
        files        int,
        insertions   int,
        deletions    int,

        -- { "pass-abc:proposed:build": "passed" }. A map, so replaying is
        -- assignment rather than appending; keyed by the run that produced the
        -- verdict, so an attempt that is over cannot lend its verdicts to the
        -- next one. Evidence is not here on purpose.
        --
        -- Named for what it holds rather than for what wrote it (#249). The
        -- keys are runId:step and the values are verdicts, so 0058 moving
        -- which steps record one costs this column nothing.
        --
        -- A table built before #249 has the old column and not this one, and
        -- create table if not exists does not add it. The drift check in
        -- shape.ts names both halves and says the remedy: rebuild task_view.
        -- Until that runs, the write below is to a column that is not there,
        -- and so is the read: columnOf in store.ts is what makes the board say
        -- the same sentence rather than count four zeros, because a daemon on
        -- the old code keeps the checkpoint at head and leaves the shape check
        -- nothing to fire on.
        verdicts     jsonb not null default '{}'::jsonb,

        -- One line for the card: what it is waiting on, or why it stopped.
        note         text,

        -- The sha the open question is about, and null when nothing is being
        -- asked. Written from a signoff action's onSha, which is the value
        -- approve() compares a caller's onSha against.
        --
        -- Not head_sha. That one is what the last run *produced*, and it is a
        -- different fact: the two agree right up until a branch is repaired and
        -- approval re-requested on a new head, and then the board sent the
        -- produced sha, approve() refused it as stale, and the same approval
        -- through the CLI — which sends no sha at all — landed. Two answers to
        -- one question (#92).
        --
        -- Whether a person is being asked something is read off this rather
        -- than kept beside it: a card cannot then offer Approve without the sha
        -- Approve needs. That is the "waiting, and there is a head sha"
        -- inference #84 replaced, and this is what it should have been replaced
        -- with.
        awaiting_sha text,

        -- The current wait, read back as TaskCard.wait (#440).
        wait_id      text,
        wait_reason  jsonb,
        triage_attempt int,
        triage_started_at timestamptz,
        triage_result jsonb,
        triage_head_sha text,

        -- { question, answer, by } — the last block a person answered, and
        -- what with. WaitResolved.note, which no column held before #147:
        -- a rebuild could say what was asked and never what was decided.
        -- Assignment, not a list, so a replay lands on the same value; the
        -- whole history is the fold's (TicketState.answers). Kept across a
        -- claim and a landing, because a decision outlives the attempt at it.
        answer       jsonb,

        -- A repair bought and not yet claimed, and which run was one. Written
        -- only by the retired RepairRequested (#143), so nothing sets either on
        -- a new ticket — and both stay, because a log that holds the event is
        -- replayed by every rebuild. Without them an item released for a repair
        -- just before a deploy loses the backoff exemption its repair was
        -- bought with.
        repair_pending boolean not null default false,
        repair_run_id  text,

        -- Retention and ordering. From the event's own clock, never now().
        updated_at   timestamptz not null,
        closed_at    timestamptz,

        -- The backoff #43 needs. In the table rather than in memory, because an
        -- in-memory set forgets on restart and the loop it prevents costs money:
        -- the old harness re-ran two tickets five times for roughly $29.
        attempts        int not null default 0,
        last_attempt_at timestamptz,

        -- Which arm this item is on, and the ceiling it is counted against
        -- (0040 §3). The attempts column counts claims and says nothing about
        -- why one happened; a claim after a crash, after a backoff and after an
        -- approach was abandoned all read as "attempt 3". These two say
        -- "restart 1 of 2", which is a different sentence and the one a person
        -- acts on differently.
        --
        -- Assignment and not an increment, which is why there is no updated_seq
        -- subtlety here: TicketReleased{cause: Restart} carries its own ordinal, so a replay
        -- lands on the same number. attempts has to increment because a claim
        -- carries none.
        --
        -- Zero means no restart has been bought, which is every row today.
        restarts     int not null default 0,
        restarts_of  int not null default 0,

        updated_seq  bigint not null
      )`)
    await ctx.query('create index if not exists task_view_state_idx on task_view (project, state)')
    await ctx.query('create index if not exists task_view_closed_idx on task_view (closed_at)')

    // Which run belongs to which task. Run events arrive on their own stream and
    // name the task only at TicketClaimed or RunStarted.
    await ctx.query(`
      create table if not exists task_view_run (
        run_id  text primary key,
        task_id text not null
      )`)
  },

  async reset(ctx) {
    // Dropped, not truncated. This table's shape is expected to change, and
    // `create table if not exists` would silently keep the old columns.
    await ctx.query('drop table if exists task_view')
    await ctx.query('drop table if exists task_view_run')
  },

  async apply(events, ctx) {
    for (const event of events) {
      const seq = event.seq.toString()
      const at = event.at

      switch (event.type) {
        // ---- the task's own stream ----

        /**
         * Still handled, though nothing appends it any more (#41): the queue is
         * read from GitHub now. Logs written before that change still contain
         * these, and a projection that cannot replay its own history is not a
         * projection.
         */
        case 'TicketDiscovered': {
          const d = event.data as PayloadOf<'TicketDiscovered'>
          await upsert(ctx, event.streamId, seq, at, {
            project: d.project,
            issue: d.externalRef,
            title: d.title,
            kind: d.kind,
            state: 'queued',
          })
          break
        }

        case 'TicketClaimed': {
          const d = event.data as PayloadOf<'TicketClaimed'>
          await linkRun(ctx, d.runId, event.streamId)
          // The claim creates the row, not just updates it. With the queue out
          // of the log there is no earlier event to have made one, so an UPDATE
          // here would leave every running and landed task with no row after a
          // rebuild — they would vanish from the board, and GitHub could not
          // supply them because it only lists what is still open.
          const { project, issue } = splitTaskId(event.streamId)
          // One statement, counting the attempt as it goes. Two statements
          // cannot work here: whichever runs first writes `updated_seq = seq`,
          // and the second is guarded on `updated_seq` being lower, so the
          // counter silently never moves. That is exactly the shape of bug
          // that leaves a backoff looking implemented and doing nothing.
          await upsert(ctx, event.streamId, seq, at, {
            project,
            issue,
            title: d.title,
            kind: d.kind,
            state: 'running',
            runId: d.runId,
            attempt: true,
          })
          break
        }

        case 'TicketReleased': {
          const d = event.data as PayloadOf<'TicketReleased'>
          // The reason becomes the card's line. A release is an attempt that
          // ended without landing, and it used to leave no mark at all: a run
          // killed from outside fails no gate, so the card came back to Queued
          // with nothing to say and read like work nobody had started (#78).
          // Clearing `run_id` is also what scopes the gate pills — the card no
          // longer names a run, so it shows no verdicts.
          await set(ctx, event.streamId, seq, at, {
            state: 'queued',
            run_id: null,
            note: d.reason,
            wait_id: null,
            wait_reason: null,
            triage_attempt: null,
            triage_started_at: null,
            triage_result: null,
            triage_head_sha: null,
            // **The restart count's one writer** (0040, `#502`). `PassRouted`
            // only decides a restart; this is the event `conduct.ts`'s own
            // `armIsUp` guard withholds where the arm never reached origin, so
            // counting here is what keeps this column and `work-item.restarts`
            // — folded off the same event — from disagreeing.
            ...(d.cause?._tag === 'Restart' ? { restarts: d.cause.restart } : {}),
          })
          break
        }

        case 'TicketClosed': {
          const d = event.data as PayloadOf<'TicketClosed'>
          await set(ctx, event.streamId, seq, at, {
            state: 'closed',
            // The reason, where `landed` puts the merge commit: it is the whole
            // of what happened, and the only thing anybody will have later.
            note: d.reason,
            closed_at: at,
            awaiting_sha: null,
            wait_id: null,
            wait_reason: null,
            triage_attempt: null,
            triage_started_at: null,
            triage_result: null,
            triage_head_sha: null,
          })
          break
        }

        case 'TicketLanded': {
          const d = event.data as PayloadOf<'TicketLanded'>
          await set(ctx, event.streamId, seq, at, {
            state: 'landed',
            note: d.mergeCommit,
            closed_at: at,
            awaiting_sha: null,
            wait_id: null,
            wait_reason: null,
            triage_attempt: null,
            triage_started_at: null,
            triage_result: null,
            triage_head_sha: null,
          })
          break
        }

        case 'DispatchRefused': {
          const d = event.data as PayloadOf<'DispatchRefused'>
          // `queued` and not `waiting` (#405): the refusal is about the pass,
          // not this item — `conduct.ts` pauses the conductor over it rather
          // than asking a person about this one ticket — so the item is still
          // what the queue should offer once the pause lifts.
          //
          // **Conditional on the standing hold.** Only `WaitResolved` may
          // clear the wait, and only a person's answer may replace the
          // question `note` holds — a dispatch refused on top of a block
          // (`lingtai ask`, then a forced `lingtai run` under an unmet tier)
          // is not an event about *this item*, so where `wait_reason` is present
          // this leaves state, note and every hold column exactly as
          // they were. Writing `state: 'queued'` and clearing the hold here
          // regardless put `task_view` and the domain fold
          // (`packages/domain/src/ticket.ts`, still `blocked`) in
          // disagreement forever, and destroyed the question before any
          // `WaitResolved` had answered it.
          //
          // An upsert, because this can be a task's first event: it refuses
          // before anything is claimed, and nothing is appended when an issue
          // is merely seen. An UPDATE would leave the refusal unreadable, which
          // is the failure it exists to report.
          const { project: p, issue: i } = splitTaskId(event.streamId)
          await ctx.query(
            `insert into task_view (task_id, project, issue, title, kind, state, note, updated_at, updated_seq)
             values ($1, $2, $3, $4, $5, 'queued', $6, $7, $8::bigint)
             on conflict (task_id) do update
               set title = coalesce(excluded.title, task_view.title),
                   kind = coalesce(excluded.kind, task_view.kind),
                   state = case when task_view.wait_reason is not null then task_view.state else excluded.state end,
                   note = case when task_view.wait_reason is not null then task_view.note else excluded.note end,
                   awaiting_sha = case when task_view.wait_reason is not null then task_view.awaiting_sha else null end,
                   wait_id = case when task_view.wait_reason is not null then task_view.wait_id else null end,
                   wait_reason = case when task_view.wait_reason is not null then task_view.wait_reason else null end,
                   triage_attempt = case when task_view.wait_reason is not null then task_view.triage_attempt else null end,
                   triage_started_at = case when task_view.wait_reason is not null then task_view.triage_started_at else null end,
                   triage_result = case when task_view.wait_reason is not null then task_view.triage_result else null end,
                   triage_head_sha = case when task_view.wait_reason is not null then task_view.triage_head_sha else null end,
                   updated_at = excluded.updated_at,
                   updated_seq = excluded.updated_seq
             where task_view.updated_seq < excluded.updated_seq`,
            [
              event.streamId,
              p,
              i,
              null,
              null,
              `needs ${d.requiredTier}; ${d.runtime} is missing ${d.missing.join(', ')}`,
              at,
              seq,
            ],
          )
          break
        }

        // ---- the run's stream ----

        case 'RunStarted': {
          const d = event.data as PayloadOf<'RunStarted'>
          await linkRun(ctx, event.streamId, d.ticketId)
          await viaRun(ctx, event.streamId, seq, at, {
            state: 'running',
            run_id: event.streamId,
            base_sha: d.baseSha,
          })
          break
        }

        case 'RunAwaitingInput': {
          // Claude's `Notification` hook appends this (`hook-socket.ts`), the
          // hook answers `{ allow: true }`, and the run carries on — nothing
          // reads the event back. It is a note on the card, never a hold.
          const d = event.data as PayloadOf<'RunAwaitingInput'>
          await viaRun(ctx, event.streamId, seq, at, { note: d.prompt })
          break
        }

        case 'RunProducedDiff': {
          const d = event.data as PayloadOf<'RunProducedDiff'>
          await viaRun(ctx, event.streamId, seq, at, {
            head_sha: d.headSha,
            files: d.files,
            insertions: d.insertions,
            deletions: d.deletions,
          })
          break
        }

        /**
         * **`verifying`, and it was `gates` until `#247`.** The column beside
         * it became `verdicts` and the four counts lost their prefix under
         * `#250`, because each of those names a thing that survives
         * [0058](../../../doc/decisions-archive/0058-lingtai-is-a-development-pipeline.md);
         * this one names a *phase*, and `#249` left it standing because the
         * phase had no word — `proposed` is a step rather than a phase, and
         * `steps` says nothing.
         *
         * The word the ten steps give it is what the pass does between an
         * agent proposing completion and an item landing: `build`, `review`,
         * and the lane's own re-verify against the base as it now stands. It is
         * the same word `RefusalReason`'s `verify-failed` carries, which is the
         * one way this phase ends badly and is not a conflict.
         *
         * **It is a stored value, so `lingtai projection rebuild task_view` is
         * what an existing table needs** — and the reset means there is no such
         * table to carry. `LABEL_STATES`, `labelsFor`, `stateInk` and the
         * board's `COLUMN_OF` move with it.
         */
        case 'RunProposedCompletion': {
          const d = event.data as PayloadOf<'RunProposedCompletion'>
          await viaRun(ctx, event.streamId, seq, at, { state: 'verifying', head_sha: d.headSha })
          break
        }

        /**
         * Turns only. `RunFinished.costUsd` is gone (#502, 0110 §9) — spend
         * has one source, `RunSpent`, and `task_view` has no column for it at
         * all since `#506`: `spend.ts`'s own projection, read at display time,
         * is where a total now comes from (0110's *tokens on the event, money
         * at display*).
         */
        case 'RunFinished': {
          const d = event.data as PayloadOf<'RunFinished'>
          await viaRun(ctx, event.streamId, seq, at, { turns: d.turns })
          break
        }

        // ---- the integration lane ----

        case 'IntegrationRefused': {
          // A block does not always follow — the merge lane's own `verify-failed`
          // path can write a fix round's `running` instead (`conduct.ts`). Every
          // way out writes its own state, so this leaves `state` alone rather
          // than guessing which one is coming.
          const d = event.data as PayloadOf<'IntegrationRefused'>
          await set(ctx, d.ticketId, seq, at, {
            note: `${d.reason}: ${d.detail}`,
            // The approval, if there was one, has been spent on this attempt.
            // The run is back to `gating` and `approve()` refuses it — so the
            // card must stop offering a button that cannot work (#84).
            awaiting_sha: null,
          })
          break
        }

        case 'IntegrationSucceeded': {
          const d = event.data as PayloadOf<'IntegrationSucceeded'>
          await set(ctx, d.ticketId, seq, at, {
            state: 'landed',
            note: d.mergeCommit,
            closed_at: at,
            awaiting_sha: null,
            wait_id: null,
            wait_reason: null,
            triage_attempt: null,
            triage_started_at: null,
            triage_result: null,
            triage_head_sha: null,
          })
          break
        }

        /**
         * Every type 0120's appendix retires or reshapes, and the one `Hold`
         * match — `cardFactOf` is the one place left that still names an old
         * event type or a `Hold`, and #464's switch to the stored read model
         * changes that function and leaves this file untouched (the design
         * for #480).
         */
        default: {
          for (const fact of cardFactOf(event)) {
            switch (fact._tag) {
              // Keyed `run:point:action`. The point is there because two points
              // can run an action of the same name; the run is there because two
              // attempts can run the same point, and without it the second
              // silently inherited the first's verdicts (#78).
              case 'Verdict': {
                await setStep(ctx, event.streamId, seq, at, fact.key, fact.verdict)
                if (fact.approval?._tag === 'Requested') {
                  // A `WaitStarted` always follows — the conductor's own
                  // request sits inside the `if` that guards it, and a plugin's
                  // `heldAt` reaches the same unconditional append
                  // (`conduct.ts`, `pass.ts`) — so `state` is left for that
                  // event to write.
                  await viaRun(ctx, event.streamId, seq, at, {
                    note: fact.approval.question,
                    // The card may offer Approve, and this is the sha it must
                    // send: the one the run is asking about, not the one it
                    // produced. A re-request on a repaired head moves this and
                    // leaves `head_sha` where it was, which is the divergence
                    // #92 is about.
                    awaiting_sha: fact.approval.onSha,
                  })
                }
                // Granted and revoked are gone as their own events (#502): an
                // approval is `WaitResolved{Approve}` now, handled in that case
                // below, and nothing writes a revocation any more.
                break
              }

              /**
               * A fix is bought, so it is noted — never priced here. Since
               * `#506` a round's own cost is read off `spend` at display time
               * (0110's *tokens on the event, money at display*), and
               * `task_view` has no column to fold `RoundSpent` into.
               */
              case 'RoundOpened': {
                // `of` is gone with `FixRequested` (#502): the round is named
                // without a denominator rather than as `round 2 of 0`.
                const note =
                  fact.findings > 0
                    ? `fixing round ${fact.round}: ${fact.findings} finding(s)`
                    : `fixing round ${fact.round}`
                await viaRun(ctx, event.streamId, seq, at, { state: 'running', note })
                break
              }

              case 'WaitStarted': {
                // An upsert, because since #147 this can be a task's first
                // event: `lingtai ask` blocks an item before anything has
                // claimed it, and an UPDATE would leave the question on no row
                // — the board would not show it and the queue, which reads
                // this table, would not pass the item over. The same reason
                // `DispatchRefused` upserts.
                const { project: p, issue: i } = splitTaskId(event.streamId)
                await upsert(ctx, event.streamId, seq, at, {
                  project: p,
                  issue: i,
                  title: null,
                  kind: null,
                  state: 'waiting',
                })
                // The reason is the source of the card's line (#443).
                await set(ctx, event.streamId, seq, at, {
                  state: 'waiting',
                  note: waitWords(fact.reason, { branch: waitBranchOf(event), base: '', findings: [] }).line,
                  wait_id: fact.waitId,
                  wait_reason: JSON.stringify(fact.reason),
                  triage_attempt: null,
                  triage_started_at: null,
                  triage_result: null,
                  triage_head_sha: null,
                })
                break
              }

              case 'TriageStarted':
                await ctx.query(
                  `update task_view
                   set triage_attempt = $4::int, triage_started_at = $3,
                       triage_result = null, triage_head_sha = null,
                       updated_at = $3, updated_seq = $2::bigint
                   where task_id = $1 and state = 'waiting' and wait_id = $5
                     and (triage_attempt is null or triage_attempt < $4::int)
                     and updated_seq <= $2::bigint`,
                  [event.streamId, seq, at, fact.attempt, fact.waitId],
                )
                break

              case 'WaitTriaged':
                await ctx.query(
                  `update task_view
                   set triage_result = $4::jsonb, triage_head_sha = $5,
                       updated_at = $3, updated_seq = $2::bigint
                   where task_id = $1 and state = 'waiting' and wait_id = $6
                     and triage_attempt = $7::int and updated_seq <= $2::bigint`,
                  [event.streamId, seq, at, JSON.stringify(fact.result), fact.headSha, fact.waitId, fact.attempt],
                )
                break

              case 'WaitResolved':
                if (fact.resolution._tag === 'Approve' || fact.resolution._tag === 'ContinueConflict') {
                  // **Clears the hold rather than narrowly clearing `awaiting_sha`**
                  // (#465). 0118's own work-item fold used to leave the
                  // lifecycle alone on an Approve because what actually moved
                  // the ticket on was the integration that followed,
                  // synchronously, inside `approve.ts` — that integration is
                  // gone, and the fold now moves the lifecycle to `approved`
                  // (`ticket.ts`), so a row left `waiting` here would
                  // disagree with it: the home board would keep rendering
                  // Decide/Requeue over a question that is answered, and
                  // `page.tsx` reads the current wait to decide that.
                  //
                  // `state: 'approved'`, not `'running'` and not `'queued'`
                  // (#510). `selectRunnable` reads `state === 'queued'` as
                  // *the queue may claim this* (`queue.ts`), and an approved
                  // item is not the queue's to claim: `claimTicket` refuses
                  // it by name (`not-claimable, status: approved`), and the
                  // only way it moves is `continueTicket`, straight off the
                  // ticket stream. It is not `'running'` either: nothing is
                  // holding this row — no agent, no worktree, no claim — until
                  // `continueTicket` appends the next `TicketClaimed`, which
                  // folds it back to `'running'` below. `inFlight()`
                  // (`@lingtai/daemon`'s `control.ts`) reads `running` as *a
                  // conductor is holding this*, so an approval that folded as
                  // `running` read as a pass in flight that did not exist.
                  // `labelsFor('approved')` still gives the same GitHub label
                  // as `running`/`verifying` (`@lingtai/conductor`'s
                  // `labels.ts`), so this changes nothing a person sees on the
                  // issue, only what the projection and `inFlight()` are told.
                  await set(ctx, event.streamId, seq, at, {
                    state: 'approved',
                    note: 'approved — continues once a conductor is free',
                    awaiting_sha: null,
                    wait_id: null,
                    wait_reason: null,
                    triage_attempt: null,
                    triage_started_at: null,
                    triage_result: null,
                    triage_head_sha: null,
                  })
                  break
                }
                // The answer, beside the question it answered — which is the
                // row's `note` right up until this statement clears it, so
                // both are written in one statement over the row rather than
                // read back first. A question withdrawn was never answered, so
                // the last answer stands — the standing reason says whether
                // it was an `OwnQuestion`, and a `Requeue` on
                // one of those is a person taking the question back rather
                // than answering it (0118 §1); there is no `withdrawn` field
                // on the event any more to read that off directly (#502).
                const standing = await ctx.query<{ wait_reason: unknown }>(
                  'select wait_reason from task_view where task_id = $1',
                  [event.streamId],
                )
                const storedReason = standing[0]?.wait_reason
                const ownQuestion =
                  storedReason != null &&
                  WaitReason.parse(typeof storedReason === 'string' ? JSON.parse(storedReason) : storedReason)._tag ===
                    'OwnQuestion'
                await ctx.query(
                  `update task_view
                 set answer = case when $6 = 1 then answer else jsonb_build_object(
                       'question', case when wait_reason is not null then note end,
                       'answer', $4::text,
                       'by', $5::text) end,
                     state = 'queued',
                     note = null,
                     awaiting_sha = null,
                     wait_id = null,
                     wait_reason = null,
                     triage_attempt = null,
                     triage_started_at = null,
                     triage_result = null,
                     triage_head_sha = null,
                     updated_at = $3,
                     updated_seq = $2::bigint
                 where task_id = $1 and updated_seq <= $2::bigint`,
                  [
                    event.streamId,
                    seq,
                    at,
                    fact.note,
                    fact.by,
                    ownQuestion && fact.resolution._tag === 'Requeue' ? 1 : 0,
                  ],
                )
                break

              case 'RunEnded':
                // Always followed by a `WaitStarted` or a release back to
                // `queued` (`conduct.ts`) — this is the note for the moment
                // before either lands, and it leaves `state` for whichever one
                // writes it.
                await viaRun(ctx, event.streamId, seq, at, { note: `${fact.kind}: ${fact.detail}` })
                break
            }
          }
          break
        }
      }
    }
  },
}

// ----------------------------------------------------------------- write ----

/**
 * `ticket-nextloom-ai-admin-155` → project `nextloom-ai-admin`, issue `155`.
 *
 * Safe to parse because the same code writes it (`ticket-${project}-${ref}`), and
 * splitting at the *last* hyphen is what makes a project name containing
 * hyphens survive — which every one of them does.
 */
function splitTaskId(taskId: string): { project: string; issue: string } {
  // A projection must fold anything the log holds, including an id it cannot
  // parse — hence the fallback rather than a null the caller has to handle.
  return parseTicketStream(taskId) ?? { project: taskId.replace(/^wi-/, ''), issue: '' }
}

async function linkRun(ctx: ProjectionContext, runId: string, taskId: string): Promise<void> {
  await ctx.query(
    `insert into task_view_run (run_id, task_id) values ($1, $2)
     on conflict (run_id) do update set task_id = excluded.task_id`,
    [runId, taskId],
  )
}

/**
 * Creates the row if it is not there, updates it if it is.
 *
 * Needed because no single event is guaranteed to come first. Today the claim
 * always is; a projection that assumed so would break the first time a task
 * acquired an event before it — and a rebuild of a partial log has to work.
 */
async function upsert(
  ctx: ProjectionContext,
  taskId: string,
  seq: string,
  at: Date,
  values: {
    project: string
    issue: string
    /** Null when the caller does not know it. Never overwrites one that is known. */
    title: string | null
    kind: string | null
    state: TaskState
    runId?: string
    /**
     * True when this event is a claim, so the hold state can be reset. Set on
     * every claim including a continuation's; the SQL decides from the row's
     * own run_id whether the claim is a fresh attempt.
     */
    attempt?: boolean
  },
): Promise<void> {
  const n = values.attempt ? 1 : 0
  await ctx.query(
    // `coalesce` in both directions: a claim that carries no title must not
    // replace a real one with `#155`, and a row created by a claim must still
    // say something. Whoever knows the title wins, in either order of arrival.
    `insert into task_view
       (task_id, project, issue, title, kind, state, run_id, attempts, last_attempt_at,
        updated_at, updated_seq)
     values ($1, $2, $3, $4, $5, $6, $9, $10, case when $10::int > 0 then $7::timestamptz end, $7, $8::bigint)
     on conflict (task_id) do update
       set title = coalesce(excluded.title, task_view.title),
           kind = coalesce(excluded.kind, task_view.kind),
           state = excluded.state,
           run_id = coalesce(excluded.run_id, task_view.run_id),
           -- A continuation claims the same run again (continueTicket,
           -- claim.ts:150-152): the row's own run_id is still that run, so
           -- this counts a fresh attempt only when the claim names a run the
           -- row was not already on. task_view_run is not the "seen" test --
           -- linkRun runs before this upsert in the same case, so it is
           -- always already written by the time this runs.
           attempts = task_view.attempts
             + case when $10::int > 0 and task_view.run_id is distinct from excluded.run_id then 1 else 0 end,
           last_attempt_at = case when $10::int > 0 then excluded.updated_at else task_view.last_attempt_at end,
           note = case when $10::int > 0 then null else task_view.note end,
           -- A fresh attempt is nobody's question yet.
           awaiting_sha = case when $10::int > 0 then null else task_view.awaiting_sha end,
           wait_id = case when $10::int > 0 then null else task_view.wait_id end,
           wait_reason = case when $10::int > 0 then null else task_view.wait_reason end,
           triage_attempt = case when $10::int > 0 then null else task_view.triage_attempt end,
           triage_started_at = case when $10::int > 0 then null else task_view.triage_started_at end,
           triage_result = case when $10::int > 0 then null else task_view.triage_result end,
           triage_head_sha = case when $10::int > 0 then null else task_view.triage_head_sha end,
           -- The claim is what consumes a pending repair: this run *is* the
           -- repair, and naming it here is what lets its spend be counted apart
           -- from the work's. Only a retired RepairRequested sets one (#143), so
           -- on a new ticket both lines leave the row as it was.
           repair_run_id = case when $10::int > 0 and task_view.repair_pending
                                then excluded.run_id else task_view.repair_run_id end,
           repair_pending = case when $10::int > 0 then false else task_view.repair_pending end,
           updated_at = excluded.updated_at,
           updated_seq = excluded.updated_seq
     where task_view.updated_seq < excluded.updated_seq`,
    [taskId, values.project, values.issue, values.title, values.kind, values.state, at, seq, values.runId ?? null, n],
  )
}

/**
 * Updates a row by task id.
 *
 * `updated_seq` guards a replay: events arrive in seq order, so a write carrying
 * an earlier seq is a bug rather than something to apply.
 */
async function set(
  ctx: ProjectionContext,
  taskId: string,
  seq: string,
  at: Date,
  values: Record<string, unknown>,
): Promise<void> {
  const entries = Object.entries(values)
  const sets = entries.map(([k], i) => `${k} = $${i + 4}`).join(', ')
  await ctx.query(
    `update task_view set ${sets}, updated_at = $3, updated_seq = $2::bigint
     where task_id = $1 and updated_seq <= $2::bigint`,
    [taskId, seq, at, ...entries.map(([, v]) => v)],
  )
}

/** The same, for an event that arrived on a run's stream. */
async function viaRun(
  ctx: ProjectionContext,
  runId: string,
  seq: string,
  at: Date,
  values: Record<string, unknown>,
): Promise<void> {
  const rows = await ctx.query<{ task_id: string }>('select task_id from task_view_run where run_id = $1', [runId])
  const taskId = rows[0]?.task_id
  // A run whose start was never seen has no row to update. That is a gap in the
  // log, not a reason to invent a task.
  if (taskId) await set(ctx, taskId, seq, at, values)
}

/**
 * Assignment into a keyed map, so replaying is idempotent without a guard.
 *
 * The run is part of the key, not just the lookup: the cell a verdict lands in
 * belongs to the attempt that produced it, so a later attempt starts on a fresh
 * set rather than overwriting a dead one. `readTasks` then shows the cells
 * belonging to the run the row names, and nothing else.
 */
async function setStep(
  ctx: ProjectionContext,
  runId: string,
  seq: string,
  at: Date,
  step: string,
  verdict: string,
): Promise<void> {
  const rows = await ctx.query<{ task_id: string }>('select task_id from task_view_run where run_id = $1', [runId])
  const taskId = rows[0]?.task_id
  if (!taskId) return
  const key = `${runId}:${step}`
  await ctx.query(
    `update task_view
     set verdicts = verdicts || jsonb_build_object($3::text, $4::text),
         updated_at = $5,
         updated_seq = greatest(updated_seq, $2::bigint)
     where task_id = $1`,
    [taskId, seq, key, verdict, at],
  )
}

// ------------------------------------------------------------------ read ----

export interface TaskCard {
  taskId: string
  project: string
  issue: string
  title: string
  kind: string
  state: TaskState
  tier: string
  runId: string | null
  turns: number | null
  /**
   * Verdicts from the run this card names, and no other. Four counts rather
   * than two, because a person's word is not a gate's: `waived` is an
   * override of a failure and `approved` is a human answering a `human`
   * action. Counting either as passed made the card say the opposite of what
   * happened.
   *
   * **No prefix, and that is the whole of `#249`.** A prefix on these names the
   * *population* — which steps recorded a verdict — and
   * [0058](../../../doc/decisions-archive/0058-lingtai-is-a-development-pipeline.md) §3a
   * changes it: `review` stops giving one at all and raises findings instead, so
   * the 231 refusals it recorded over 14 days
   * ([012](../../../doc/experiments/012-where-the-turns-go.md) §4) will arrive at
   * `proposed`. `stepsPassed` would then promise a population it does not count,
   * exactly as the retired prefix did. These four say only *this run recorded
   * that many*, which was true before that rewrite and is true after it.
   */
  passed: number
  failed: number
  waived: number
  approved: number
  baseSha: string | null
  headSha: string | null
  files: number | null
  insertions: number | null
  deletions: number | null
  note: string | null
  updatedAt: Date
  closedAt: Date | null
  attempts: number
  lastAttemptAt: Date | null
  /**
   * How many approaches this ticket has abandoned, and the ceiling
   * ([0040](../../../doc/decisions-archive/0040-rounds-bound-depth-restarts-bound-breadth.md) §3).
   *
   * Both zero on every card today, because `runtime.limits.restarts` defaults
   * to zero. `attempts` is not this number and never was: it counts claims, so
   * a claim after a crash, after a backoff and after an approach was thrown
   * away all read as `attempt 3`. Read through `describeArm`, which is what
   * keeps the board and `lingtai status` saying it in the same words.
   */
  restarts: number
  restartsOf: number
  /**
   * The current wait, non-null exactly when `state` is `'waiting'` (#440).
   * `waitId` names the `WaitStarted` that opened it, and `reason` is the
   * whole of what it recorded — `allowedResolutions(wait.reason)` is what a
   * caller asks to know which controls apply. Read through `waitOf`, which
   * both store twins call so they cannot disagree about the refusal below.
   */
  wait: { waitId: WaitId; reason: WaitReason } | null
  triage: TriageFacts
  triageHeadSha: string | null
  /**
   * The last block a person answered, and what they answered it with — null on
   * a task nobody has answered. `question` is null only for an answer the log
   * holds without a block before it.
   */
  answer: { question: string | null; answer: string; by: string } | null
  /**
   * The sha the open question is about, and null when there is none.
   *
   * This is what a control has to send, not `headSha`: `approve()` binds its
   * verdict to what the run is *asking* about, and the card was sending what
   * the run *produced* (#92). They differ the moment a branch is repaired and
   * approval re-requested on a new head.
   */
  awaitingSha: string | null
  /**
   * Whether a person is being asked something, rather than merely left holding
   * it. `waiting` says where the card sits; this says whether Approve can work.
   *
   * Read off `awaitingSha` rather than stored beside it, so the card cannot
   * offer Approve without the sha Approve needs.
   */
  awaitingApproval: boolean
  /**
   * A repair bought and not yet claimed. Exempt from the queue's backoff.
   *
   * Only a retired `RepairRequested` sets it (`#143`), so it is false on every
   * new ticket — and true on one released for a repair before the deploy, which
   * is owed the exemption its repair was bought with.
   */
  repairPending: boolean
}

/**
 * The columns a store's own `toCard` reads into `TaskCard.wait` (#440).
 *
 * `reason` is already-parsed on Postgres and text on SQLite — each twin
 * passes in whatever its own column type hands back, and this is the one
 * place that turns it into `WaitReason` so the two cannot disagree about the
 * refusal below.
 *
 * Returns `null` for every state but `'waiting'`, whatever the columns hold:
 * `TicketDiscovered`, `RunStarted` and `RunProposedCompletion` move `state`
 * off `'waiting'` without touching these columns (design note §1), so a row
 * mid-run can carry a stale `wait_id`/`wait_reason` that this must not read.
 *
 * Throws, naming the task, on the one combination the fold can never write:
 * `state === 'waiting'` with no reason. `state` is only ever set to
 * `'waiting'` in the same statement that sets `wait_reason` (`WaitStarted`),
 * so a row here either predates this column or has been tampered with — both
 * are a bug to report loudly, not a card to draw with no wait.
 */
export function waitOf(taskId: string, state: TaskState, waitId: unknown, reason: unknown): TaskCard['wait'] {
  if (state !== 'waiting') return null
  if (reason === null || reason === undefined) {
    throw new Error(`task ${taskId} is waiting with no wait_reason`)
  }
  try {
    return { waitId: WaitId.parse(waitId), reason: WaitReason.parse(reason) }
  } catch (err) {
    throw new Error(`task ${taskId} has a wait that does not parse: ${String(err)}`)
  }
}

/**
 * One sentence of a hold, and which of the four it is.
 *
 * Typed parts rather than formatted lines, so the card and `lingtai status` can
 * render the same sentences differently without keeping their own copies of the
 * words. That is what #83's last condition asks for: *two places that disagree
 * about why something is blocked is the failure this repository keeps finding* —
 * so the wording is decided once, here, beside the field it is read from.
 */
export interface WaitLine {
  part: 'needs' | 'what' | 'did' | 'rec'
  text: string
}

/**
 * What is known about a hold, in the order an operator uses it.
 *
 * Empty for a block that carries only a question — every block written before
 * #83 — which is what makes those render exactly as they did: the question is
 * the card's `note` and is not this function's business.
 *
 * `diagnosis.raw` is deliberately **not** here. It is the git output verbatim,
 * it belongs behind a disclosure rather than in a sentence, and a reader that
 * cannot collapse it should link to the log instead of pasting a hundred lines
 * into a queue listing.
 */
export function describeWaitLines(card: {
  needs: 'judgement' | 'acknowledgement' | null
  diagnosis: BlockDiagnosis | null
}): WaitLine[] {
  const lines: WaitLine[] = []
  if (card.needs !== null) {
    lines.push({
      part: 'needs',
      text: card.needs === 'judgement' ? 'your judgement is needed' : 'a failure needs acknowledging',
    })
  }
  const d = card.diagnosis
  if (d === null) return lines
  lines.push({ part: 'what', text: d.what })
  if (d.done !== null) lines.push({ part: 'did', text: d.done })
  if (d.recommendation !== null) {
    lines.push({
      part: 'rec',
      text: `recommends ${d.recommendation.action} — ${d.recommendation.why}`,
    })
  }
  return lines
}

/**
 * What a person is being waited on *for*, or null when nobody is.
 *
 * Two holds rendered as one chip until #147, and they want opposite things of
 * the person. **An answer** is a question asked before any run: nothing has
 * been produced, there is no diff and no branch, and the move is to decide.
 * **A review** is a run holding a diff at a sha: the move is to approve or
 * reject what is there. A failure that needs acknowledging is neither, and
 * stays what `describeWaitLines` says it is.
 *
 * **`needs` is read, and that is what makes the third sentence true** (`#197`).
 * It used to hold by accident: the only blocks written `acknowledgement` — the
 * merge lane's own undirected reasons (`dirty-base` and the rest), the
 * out-of-turns one, a spent approval's — left no open `signoff`, so
 * `awaitingSha` was null and this returned null without ever asking. A fixer
 * killed mid-round now writes `acknowledgement` on a block that *does* hold a
 * sha, and the chip read *waiting for your review* — whose move is approve or
 * reject what is there — directly beside a headline saying *this is
 * infrastructure and not your call: send it again*. A chip and a headline
 * prescribing opposite moves on one card is the failure #147 split the chip to
 * end, so the rule that was documented is now the rule that runs. **Since
 * #452 a `conflict`/`verify-failed` refusal the router sent on is `Routed`,
 * writes `judgement` and does hold one** — correctly, because there the chip
 * and the headline agree: a branch that does not merge is exactly what *your
 * review* means.
 *
 * Beside `describeWaitLines` for its reason (#83, #100): the card and `lingtai
 * status` both say it, and must say it in the same words.
 */
export function describeWait(card: {
  waiting: boolean
  asked: boolean
  awaitingSha: string | null
  needs: 'judgement' | 'acknowledgement' | null
}): 'waiting for your answer' | 'waiting for your review' | null {
  if (!card.waiting) return null
  if (card.asked) return 'waiting for your answer'
  // Before the sha, because a block can now carry both and only one of them is
  // a question to the person: an acknowledgement is `describeWaitLines`'s to word.
  if (card.needs === 'acknowledgement') return null
  if (card.awaitingSha !== null) return 'waiting for your review'
  return null
}

/**
 * *restart 1 of 2*, or null when this ticket has only ever had one approach.
 *
 * **Beside `describeWaitLines` and for its reason** (#83, #100): the board and
 * `lingtai status` both show it, and two places that word the same fact
 * differently is the failure this repository keeps finding. So the sentence is
 * decided once, here — but the ceiling is the recipe's, never the row's, and
 * every caller has to hand it in. `#502` dropped the ceiling from the event
 * (`TicketReleased{cause: Restart}` is `{after, restart}` alone — the policy
 * it was spent against lives in the recipe, never on the event), so
 * `restartsOf` stays at its DDL default of 0 on every row now; a caller that
 * wants `of N` reads the recipe's `limits?.restarts` and passes it, the same
 * source `describeHeld` falls back to.
 *
 * Null rather than `restart 0 of 2`, because a ticket on its first approach is
 * not *on* an arm — there is nothing to tell apart yet, and a card that said so
 * on every row would spend the reader's attention on an absence. That is the
 * same reading `[not offered]` earns by saying nothing (#100).
 *
 * **The other half of the sentence is the note.** `fixing round 2` is what
 * `RoundOpened` writes there (#502 dropped the denominator with `FixRequested`:
 * there is no `of 3` any more), because depth is a fact about the pass in flight
 * and lives as long as that pass; this is a fact about the ticket and outlives
 * every pass of it. Together they read *fixing round 2, restart 1 of 2*, which is
 * what 0040 §3 asks a card to be able to say.
 */
export function describeArm(card: Pick<TaskCard, 'restarts'>, restartsOf: number | null): string | null {
  if (card.restarts === 0) return null
  return restartsOf !== null && restartsOf > 0
    ? `restart ${card.restarts} of ${restartsOf}`
    : `restart ${card.restarts}`
}

export interface ReadTasksOptions {
  project?: string
  /**
   * How long a landed task stays visible. Here rather than in the projection,
   * so changing it is a different query and not a rebuild — and so a rebuild
   * does not depend on when it ran.
   */
  retentionDays?: number
  url?: string
}

/**
 * The board's cards, out of whichever store this machine wrote down (#179).
 *
 * The query and the mapping moved into `postgres.ts` with #219 and did not
 * change on the way; what is left here is a store opened for this read and
 * closed after it, exactly as the client it replaced was. **Nothing here
 * chooses between the implementations** — `choose.ts` is the one place that
 * does — and a caller that already has a store calls `store.tasks` and skips
 * this.
 */
export async function readTasks(options: ReadTasksOptions = {}): Promise<TaskCard[]> {
  return withProjectionStore({ url: options.url, max: 1 }, (store) =>
    store.tasks({
      project: options.project,
      // Resolved here rather than in the store, so that changing the window
      // stays a different query and a store never has to know the board's
      // default.
      retentionDays: options.retentionDays ?? DEFAULT_RETENTION_DAYS,
    }),
  )
}

/**
 * Which projects the board holds cards from, whatever it is filtered to.
 *
 * Distinct over the same rows `readTasks` returns — the same retention window,
 * so a project whose last card has aged out loses its name here too rather than
 * offering a filter that leads to an empty board.
 *
 * Its own query rather than a fold over a filtered read, because that is the
 * one question a filtered read cannot answer: narrowing to one project is what
 * removes the evidence that the others exist. And not the registered list
 * either — **a card can outlive its project** (#86), so a repository that has
 * been unregistered still appears here for as long as its work does.
 */
export async function readTaskProjects(
  options: Pick<ReadTasksOptions, 'retentionDays' | 'url'> = {},
): Promise<string[]> {
  return withProjectionStore({ url: options.url, max: 1 }, (store) =>
    store.taskProjects({ retentionDays: options.retentionDays ?? DEFAULT_RETENTION_DAYS }),
  )
}
