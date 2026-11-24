import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, posix } from 'node:path'

import {
  NO_DESIGN,
  type ActionContext,
  type ActionPort,
  type ActionPortDeps,
  type CutAnswer,
  type DiffRead,
  type KeptAnswer,
  type LandAnswer,
  type MergeStrategy,
  type TakeAnswer,
  type WorkDispatch,
  type WorkPortDeps,
  actionPortsFromRecipe,
  makeHumanAction,
  makeMergeAction,
  makeQueueAction,
  makeWorkAction,
  makeWorktreeAction,
  redoParagraph,
  withRedoParagraph,
  afterOpeningLines,
  rerunId,
} from '@lingtai/actions'
import type { LandedCommit, LandedPath, LandedTitle } from '@lingtai/actions'
import { FAILED, markFailed } from '@lingtai/actions/spans'
import {
  NO_RUN_LOG,
  type RunLog,
  type RunOutcome,
  type Runtime,
  createRuntime,
  missingToFailClosed,
  runtimeVersionOfEffect,
  taggedTrace,
  type RunSandbox,
} from '@lingtai/agent'
import { extensionEnv, productionPatterns, runnableEnv } from '@lingtai/agent-env'
import {
  type Envelope,
  type PayloadOf,
  type SpentFor,
  type TicketState,
  type WaitId,
  triageSpentOf,
  personFixRoundsOf,
  WIP_COMMIT_PREFIX,
  releasesOf,
  stepStartedAtOf,
  continuableRelease,
  pendingRedoOf,
  cutOffPromptOf,
  expandPrompt,
  integrationStream,
  parsePayload,
  stripEvidence,
  waitWords,
  DIFF_FLAGS,
} from '@lingtai/domain'
import {
  UNREACHABLE_WAITS,
  classify,
  standDown,
  type StandDownWhat,
  type NamedLimit,
  limitSentence,
  type ReleaseCause,
  type AttemptState,
  type RuntimeId,
  type Step,
  type ToAppend,
  attemptIdOf,
  attemptStream,
  reduceAttempt,
  standingRefusal,
  attemptReducer,
  ticketReducer,
  reduceTicket,
  reviewSummaryOf,
  stepOutcomesOf,
  waitsFromState,
  personAsksFromState,
  ticketStream,
} from '@lingtai/domain'
import {
  decideImplementOutcome,
  doneWhenItems,
  parseImplementOutcome,
  type ImplementOutcome,
  type ProjectState,
} from '@lingtai/domain'
import {
  continuationOf,
  grantCriterion,
  answerStepOf,
  rerunStepOf,
  standingFor,
  waivedActionsAt,
  type KeptAt,
  type AttemptRef,
  type WaitReason,
} from '@lingtai/domain/wait'
import { stateDir } from '@lingtai/env'
import { type EventStore, eventStore, log as theLog, readThroughSnapshot, type Snapshot } from '@lingtai/event-store'
import { observeSandbox, openPr, readPr, readUnheldFixLandings, recordPrFixLanded } from '@lingtai/project'
import { readBacklogEffect } from '@lingtai/projector'
/**
 * One work item, claim through merge — **and since `#256` the sequence is not
 * here.**
 *
 * `runAttempt` in [`run-attempt.ts`](run-attempt.ts) walks the ten steps and applies the outcome
 * rules; `bodiesFor` in [`attempt-steps.ts`](attempt-steps.ts) is the ten bodies. This
 * file is what they were written to be called by: it resolves the recipe and the
 * environment, builds a live `AttemptPorts` out of `Repo`, `AgentHost`, the GitHub
 * client and the store, hands the pass its `actionsAt` and its `emit`, and
 * **writes down the ending** — which is the one thing the pass deliberately does
 * not do ([0058](../../../doc/decisions-archive/0058-lingtai-is-a-development-pipeline.md)
 * §2b, and `attempt-steps.ts`'s *What the pass does not write*).
 *
 * It replaces the engine `#256` deleted, which ran five gate points around the
 * same wiring in 3479 lines. That file is **the old engine** wherever the
 * comments below need it: named, never cited, because it is not there to read. Nothing about the *stored* vocabulary changed in that swap:
 * `run-attempt.ts` and `attempt-steps.ts` append no event type of their own, so every
 * event below is one the log already carried, appended from the same place in
 * the order — the caller's.
 *
 * ## The order, which is the part that has to be right
 *
 *   resolve the recipe from ~/.lingtai/     never from the repository, and it
 *                                           must name the registered base as its own
 *   resolve the environment                 a declared name with no value
 *                                           refuses here, before the money
 *   check each runtime can fail closed      one that cannot is `DispatchRefused`,
 *                                           never a downgrade
 *   → the pass                              ten steps, and the claim is the first
 *   write the ending                        landed, blocked or failed — once,
 *                                           whichever of the four ways it ended
 *
 * **The refusals come first, deliberately.** Everything above the pass acquires
 * nothing, so a run that stops at an unreadable recipe or a missing environment
 * value has claimed nothing and provisioned no worktree to release — the lesson
 * 0024 recorded about where a scope *starts*.
 *
 * ## What the ports are, and what they are not
 *
 * Seven closures, and every one of them **wraps rather than reimplements**, which
 * is the `#226` rule `attempt-steps.ts` is held to from the other side. Four are
 * `AttemptPorts` methods; `take`, `cut` and `land` are a plugin's deps, reached
 * through `stepDeps` rather than through the pass (`#269`, `#268`, `#270`):
 *
 * ```
 * take      runnableNow + claimTicket      a `queue:` action's, at `claim`
 * cut       repo.provision                   a `worktree:` action's, at `admit`
 * dispatch  the hook, the agent, the receipt  and a fix round, when a round was bought
 * judge     judgeDeclaredAt                  the recipe's own `proposed:` judges
 * land      repo.integrate                    a `merge:` action's, at `merge`
 * readEnd   store.read                        the item's own stream
 * recordEnd held for the ending's append       what `end` resolved, never alone
 * ```
 *
 * Beside those, `item` and `onStream` — two `AttemptPorts` methods that read what
 * `take` left in this closure rather than doing anything, for `cutTree`'s reason:
 * the closure that holds a fact is the one that can hand it back (`#269`).
 *
 * **`draft` was one of them and is gone** (`#265`). It answered *nothing is
 * declared* — `""`, dispatching nothing — because no plugin served `design`, and
 * that was the truthful answer rather than a stub while it was true.
 * `agentPlugin` declares the step now, so a design is an `agent:` action a recipe
 * writes and the port that stood in for one would be the second place it could
 * happen. What is unchanged is what an unconfigured `design` does: `defaultsAt`
 * has no row for it, nothing runs, and `implement` is briefed with `""`.
 * **`judge` stopped being the second of those in `#274`**: a
 * recipe declares its judges at `proposed:`, one per `when:`, and this port is
 * where the entry matching the direction is looked up. Where it declares none the
 * answer is still `noJudge`, and what that costs is `BUILT_IN_FOR`'s: `red` and
 * `verify-failed` are mechanical and spend nothing, and a person is the floor under
 * the other three.
 *
 * ## Four things a run acquires, and one scope each
 *
 * The run log, the worktree, the hook socket and the agent process. The log and
 * the worktree are `Effect.acquireRelease` pairs **here**, because the pass is a
 * plain promise and cannot hold a scope: the worktree is *cut* by `admit`'s port
 * and released by this file's finalizer, which is 0039 §1's *the worktree is the
 * whole of a pass* expressed as a scope rather than as an ordering somebody
 * remembers. `repo.remove` takes no error channel and tolerates a worktree that
 * was never cut, so the finalizer is unconditional.
 *
 * The socket and the agent process keep their narrow scopes inside `dispatch`,
 * which is what an agent may not outlive.
 *
 * The log's release decides **keep or delete** — landed → delete, did not land →
 * keep ([0034](../../../doc/decisions-archive/0034-the-run-log.md) §4) — so it is
 * acquired before the worktree and released after it, which is what one scope
 * and reverse order of acquisition give without anybody arranging it.
 *
 * ## Where the worktree's path comes from, and why it is not a fourth moving field
 *
 * `attempt-steps.ts` left this open — *what does not travel is the worktree's path
 * into `ActionContext.cwd`* — and the answer is that it does not have to travel.
 * `worktreePath(home, project, runId)` is a pure function of three things this
 * file knows **before** the pass starts, and `provisionWorktree` cuts at exactly
 * that path. So `context.cwd` is the caller's for the whole pass, as
 * `AttemptOptions.context` says it is, and the skeleton keeps its three moving
 * fields.
 *
 * `context.onSha` starts empty, and that is honest rather than a placeholder:
 * nothing has been cut, `claim` and `admit` have no cell open so no plugin reads
 * it, and `admit` returns the base sha on its ending the moment there is one.
 *
 * ## Every exit appends
 *
 * A run that ends leaves either `RunFinished` or `RunFailed` — both, for a run
 * stopped at its turns, whose receipt is its spend — and a work item that does
 * not land is either released or blocked with a question. The pass says which of
 * the four outcomes was reached (`outcomeOf`) and never writes it; the three
 * blocks below are where it is written, once each.
 *
 * **And one ending locks the account rather than backing the item off.** A `never-ran` met
 * something account-wide ([0031](../../../doc/decisions-archive/0031-a-run-that-never-started.md)),
 * so the item is released like any other failure and `acct-{runtime}` is told to
 * lock that runtime's projects until the limit lifts — per-item backoff answering an
 * account-wide condition is what eighty events in ninety-two seconds looked like.
 */
import {
  backoffOf,
  branchOf,
  ceilingOf,
  modeOf,
  numericTurns,
  parseDuration,
  queueOf,
  selectionOf,
  submodulesOf,
  type QueueSettings,
  type ResolvedRecipe,
  type StepAction,
} from '@lingtai/recipe'
import { DEFAULT_ACTION, invocationDecision, isBuiltInJudge, type SandboxDecision } from '@lingtai/recipe'
import {
  mirrorPathFor,
  mirrorWrite,
  retryUnreachable,
  type RepoFailed,
  worktreePath,
  type TokenSource,
  type Worktree,
} from '@lingtai/repo'
import { ticketOfLandingSubject } from '@lingtai/repo/landing-subject'
import { standInExcludes, type SandboxApi } from '@lingtai/sandbox'
import { Cause, type Duration, Effect, Exit, Result } from 'effect'

import { reachAccountLimit, readAccount } from './account.ts'
import { armsOnOriginEffect } from './arms.ts'
import {
  type Brief,
  type Claimed,
  type Judged,
  type Judging,
  type AttemptPorts,
  type Worked,
  bodiesFor,
} from './attempt-steps.ts'
import {
  armForState,
  alreadyDoneOf,
  conflictResolvedOf,
  onlyAConflictRoundSince,
  reviewedHeadOf,
  diffBaseShaOf,
  landedOnBaseOf,
  priorAttemptsFromState,
  releasedHeadOf,
  continuableRedoOf,
  type ReleasedHead,
} from './attempts.ts'
import { baseCheckFor, baseCheckQuestion } from './base-check.ts'
import { proposeBaseFix } from './base-fix.ts'
import { baseStateEffect, buildRunsOf } from './base-red.ts'
import { agentBranch } from './branches.ts'
import { runnableNowEffect, type TicketSource } from './discover.ts'
import type { TerminalOutcome } from './end-step.ts'
import { readWhatAFileKept } from './file-port.ts'
import { fixBriefParts, grantedAdviceFromState } from './fix.ts'
import { flakyPortOf } from './flaky-port.ts'
import { causeIn, chosenIn, judgePrompt, judgePromptParts } from './judge-agent.ts'
import { type Declared, judgeDeclaredAt } from './judge.ts'
import {
  commitWipExceptPlanted,
  keptRunPort,
  onlyThePlantedFileIsDirty,
  resetToHead,
  restoreAfterReview,
} from './kept-run-port.ts'
import { PR_FIX_LABEL, labelsFor } from './labels.ts'
import { type LandingLane, landingLane } from './landing-lane.ts'
import { type PersonalBranchPort } from './personal-branch.ts'
import { AgentHost, Repo } from './ports.ts'
import { currentRecipeEffect } from './projects.ts'
import { copilotTokenSignedIn, signedInHere } from './projects.ts'
import { resolvePromptRefs } from './prompt-refs.ts'
// The one composer, shared with the board. See `prompt.ts` for why it is not
// here any more.
import { buildCommands, nextPrompt, renderPromptParts, splitReturnParagraph } from './prompt.ts'
import { recordPrompt, type RecordPart } from './record-prompt.ts'
import { restartReason } from './restart.ts'
import {
  type Ceilings,
  type AttemptEnd,
  type AttemptEvent,
  type AttemptOver,
  type StepReached,
  type StepReport,
  type ConflictMergeAnswer,
  claimStepEffect,
  outcomeOf,
  runAttemptEffect,
  type RouteTaken,
} from './run-attempt.ts'
import { RUN_LOG_END, claudeConfigDirFor, runLogEnd, runLogPath } from './run-log.ts'
import { runtimesOf } from './runtimes-of.ts'
import { decidePassSandbox, makeRunSandbox } from './sandbox-decision.ts'
import {
  makeRefusalCollector,
  recordUnwrapped,
  recordingWrap,
  observedKindOf,
  sandboxOutcomeOf,
  type InvocationAppends,
} from './sandbox-record.ts'
import { stepsResolved } from './steps-resolved.ts'
import { type RefChannel, tellGitHubAboutEffect, tellGitHubEffect } from './tell.ts'
import { githubTicketStore, type Tickets } from './ticket-store.ts'
import {
  claimTicketEffect,
  continueTicketEffect,
  holdTicketEffect,
  landTicketEffect,
  refuseDispatchEffect,
  releaseTicketEffect,
  satisfyTicketEffect,
  type SplitChildBrief,
} from './ticket/commands.ts'
import { outcomeFormNote, withUnreadTail } from './unread-tail.ts'

/** How many times a person asked for `RedoStep` on `runId`'s waits: one summand of a rerun's dispatch suffix (#1218). */
/** The releases of `runId` that each started a rerun of it: an account limit's lift and a redo a stop interrupted (#1398). */
function releaseRerunsOf(ticketEvents: Parameters<typeof releasesOf>[0], runId: string): number {
  return releasesOf(ticketEvents, runId, 'AccountLimit') + releasesOf(ticketEvents, runId, 'StepRedoPending')
}

function personRerunsOf(waits: ReturnType<typeof waitsFromState>, runId: string): number {
  // An `AnswerQuestions` continues the asking step the same way, so it spends a suffix too (#1254): two `design` dispatches never share an id.
  return waits.filter(
    (w) =>
      (w.resolution?._tag === 'RedoStep' || w.resolution?._tag === 'AnswerQuestions') &&
      'run' in w.reason &&
      w.reason.run.runId === runId,
  ).length
}

/** A run's cost in words: dollars to the cent, or `cost unknown` — never `$0.00` for a cost nobody reported (0110 §7). */
/**
 * **One base check per store** (#744, 0122) — its in-flight map is what makes two passes asking
 * about one commit and command one run, so it cannot be a local of a pass. Keyed by the store
 * because a store is one log; `log` is the first caller's, which is the conductor's own.
 */
/** The runtime whose own account-limit sentence `detail` holds, or null (#1011). */
function wallOf(detail: string): RuntimeId | null {
  const said = classify({ platform: 'runtime', text: detail })
  return said?.kind === 'account-limit' ? said.runtime : null
}

export function spentWords(costUsd: number | null): string {
  return costUsd === null ? 'cost unknown' : `$${costUsd.toFixed(2)}`
}

/**
 * Where this branch's own change starts: `git merge-base <base tip> HEAD` (#937).
 * Asked on every call and never kept, because an agent may merge the base
 * mid-attempt. A failed fetch uses the local base ref, which is only ever older
 * (a larger diff, never a smaller one); a merge-base that cannot be read is
 * `fallback`, and each is noted. Never throws.
 */
export const ownChangeStart = (port: {
  git: (args: string[]) => Effect.Effect<Result.Result<string, { detail: string }>>
  note: (line: string) => void
  base: string
  fallback: string
}): Effect.Effect<string> =>
  Effect.gen(function* () {
    const { git, note, base, fallback } = port
    const fetched = yield* git(['fetch', 'origin', `refs/heads/${base}`])
    const fetchOk = Result.isSuccess(fetched)
    if (!fetchOk) note(`fetching ${base} failed, using the local ref: ${fetched.failure.detail}`)
    const got = yield* git(['merge-base', fetchOk ? 'FETCH_HEAD' : `refs/heads/${base}`, 'HEAD'])
    if (Result.isFailure(got)) {
      note(`merge-base with ${base} failed, measuring from ${fallback}: ${got.failure.detail}`)
      return fallback
    }
    const lines = got.success.split('\n').filter((l) => l.trim() !== '')
    const sha = lines.length === 1 ? lines[0]!.trim() : ''
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      note(`merge-base with ${base} printed ${lines.length} lines, measuring from ${fallback}`)
      return fallback
    }
    return sha
  })

export const changedFilesArgs = (baseSha: string): string[] => [
  'diff',
  '--name-only',
  '--no-renames',
  `${baseSha}...HEAD`,
]

/**
 * A refused `agent:`: the sentence both callers print, and **which** `agent:`
 * it was.
 *
 * The sentence is one for both places (#180). `at` is here because the remedy
 * is not: `runtime.agent` is written beside `steps:` and a step's `agent:` on
 * the step, two lines of the project's recipe (`#372`) — so a caller that
 * offers one instruction for both refusals sends the operator to a line that is
 * already correct, and its project goes on taking nothing (`#245`). Which
 * `agent:` and which file to open are one fact, so they travel together rather
 * than being re-derived by reading the sentence.
 */
export interface AgentRefusal {
  /**
   * Which `agent:` is wrong and why: for `runtime.agent`, what this conductor
   * runs instead; for a step, since `#314`, that **nothing on this machine is
   * signed in to** the runtime it names — a second runtime at a step is
   * dispatched, so its remedy is signing in or naming another, never repeating
   * `runtime.agent`.
   */
  sentence: string
  /** Where that `agent:` is written, which is the file whose line must change. */
  at: 'runtime.agent' | 'step'
  /**
   * **Which key on that line names the runtime** (`#277`).
   *
   * `agent:` and a runtime `judge:` are the same fact — a runtime named at a
   * step that nothing on this machine is signed in to (since `#314`; a second
   * runtime alone is legal and dispatched) — and they are refused by the same
   * sentence; the remedy has to
   * name the key, because *Name `agent:` …* sends an operator to edit a key the
   * line does not have. The file is the same either way, which is what `at`
   * carries and why this is a field beside it rather than a third value of it.
   */
  key: 'agent' | 'judge'
}

/**
 * Why a resolved recipe will not run on the runtime a conductor dispatches, or
 * null when it will (#180).
 *
 * One sentence for both places that ask: `runOnce`, which refuses before its
 * claim, and `lingtai doctor`'s recipe row, which must not be `ok` for a
 * recipe every pass of which that refusal stops.
 *
 * **The step half changed subject in `#314`, and did not go away** (0070 §7).
 * A step's `agent:` is a runtime too since `#245`, and until per-step dispatch
 * was built the only honest answer to a second runtime named at a step was to
 * say so — the gates were handed `options.runtime`, so a `review` naming the
 * other one would have run its cold review on the dispatched one with nothing
 * anywhere saying the named runtime was not used. It is dispatched now. What is
 * still refused, in the same shape and the same place, is a runtime **nothing
 * on this machine is signed in to**: that is the silent pick 0046 §3 is about,
 * and the failure it prevents is a claim taken and a worktree cut for a pass
 * whose `review` cannot start.
 *
 * `signedIn` is what this machine can dispatch beyond `dispatched` — asked of
 * `signedInProbe`, whose answer is a process per runtime and is cached for a
 * minute. **The caller asks only where the recipe names a second runtime**, so
 * a recipe that names none — every recipe on both machines today — spawns
 * nothing and reaches this with an empty list it never consults.
 *
 * **A runtime `judge:` is the same fact and is read the same way** (`#277`).
 * A built-in `judge:` is not a runtime and is passed over: `isBuiltInJudge` is
 * the whole of that test, so a second built-in is on the free side the day it
 * is added.
 */
export function agentRefusal(
  resolved: Pick<ResolvedRecipe, 'recipe' | 'provenance'>,
  dispatched: string,
  signedIn: readonly string[] = [],
): AgentRefusal | null {
  const named = resolved.recipe.runtime.agent
  if (named !== dispatched) {
    const from = resolved.provenance?.['runtime.agent']
    return {
      at: 'runtime.agent',
      key: 'agent',
      sentence: `runtime.agent is ${named}${from ? ` (${from})` : ''}, and this conductor runs ${dispatched}`,
    }
  }
  for (const [step, actions] of Object.entries(resolved.recipe.steps)) {
    for (const action of actions) {
      // A built-in judge names no runtime — it is a function — so it is not a
      // second dispatch and nothing about it can disagree with this one.
      const second: { key: AgentRefusal['key']; wants: string } | null =
        'agent' in action
          ? { key: 'agent', wants: action.agent }
          : 'judge' in action && !isBuiltInJudge(action.judge)
            ? { key: 'judge', wants: action.judge }
            : null
      if (second === null || second.wants === dispatched) continue
      // **Dispatched, not refused, since `#314`.** A runtime that is merely not
      // the pass's default is a thing the recipe is allowed to say; `runtimeFor`
      // builds it and the step runs on it.
      if (signedIn.includes(second.wants)) continue
      return {
        at: 'step',
        key: second.key,
        sentence:
          `steps.${step}'s "${action.name}" action names ${second.key} ${second.wants}, ` +
          `and nothing on this machine is signed in to ${second.wants}`,
      }
    }
  }
  return null
}

/**
 * What a pass needs of the client it is handed: ticket verbs, ref verbs, and
 * the repository's own identity (`owner`/`repo`) that recipe-resolution and
 * the lane both read off it. `GitHubClient` satisfies this structurally —
 * pinned in `unit/tickets.test.ts` — so every caller keeps passing the same
 * value; only the type named here narrows.
 *
 * **`owner` is null for a project with no GitHub owner** (`#352`) — one
 * registered from a local directory rather than `lingtai add <owner>/<repo>`.
 * `provision` reads it only to build a `github.com` URL it never reaches when
 * `remote` is already set (`worktree.ts:102`); `integrate` declares the same
 * field and never reads it at all (`IntegrateOptions`, `integrate.ts:71-93`
 * — it pushes from the mirror `ensureMirror` already pointed at `remote`).
 * Either way the two call sites below pass `owner ?? ''` rather than this
 * type growing a branch of its own.
 */
export type TurnClient = Tickets &
  RefChannel & {
    readonly owner: string | null
    readonly repo: string
  }

export interface RunOnceOptions {
  /** The lane landings queue on — the process's own unless a test shares one between passes. */
  lane?: LandingLane
  project: ProjectState
  client: TurnClient
  /** The recipe this run obeys. `currentRecipe` — the machine's file — unless a test says otherwise. */
  recipe?: () => Promise<ResolvedRecipe>
  runtime: Runtime
  /**
   * **How a runtime a *step* named is built** — `createRuntime` unless a test
   * says otherwise (`#314`, 0070 §7).
   *
   * Beside `runtime:` and not instead of it. `runtime:` stays the pass's
   * default, which is what `runtime.agent` resolved to and what every existing
   * test supplies alone; this is asked only where a step names something else,
   * so a recipe that names nothing behaves as it did and a two-runtime test
   * hands in a map of fakes. Inverting the port into a factory the conductor
   * calls after resolving would change a field every one of those tests passes
   * through, to save one read (`apps/cli/src/run.ts`'s own argument, kept).
   */
  runtimeFor?: (id: RuntimeId) => Runtime
  /**
   * **What this machine is signed in to**, asked only where `runtime.agent` is
   * the pass's own runtime and a step names a different one (`#314`, 0070 §7).
   *
   * `signedInHere` unless a test says otherwise — the same cached probe the
   * board and `resolveLocalRecipe` use, one process per runtime and remembered
   * for a minute. A `runtime.agent` that is not the pass's own is refused
   * without it, and a unit test that names one runtime never reaches it, which
   * is what keeps the probe out of the half of the suite that may not spawn
   * (0060 §1).
   */
  signedIn?: () => Promise<readonly RuntimeId[]>
  /** The issue to work. Phase 1 nominates by number rather than taking the queue. */
  issue: number
  /** Absolute path to the compiled `lingtai-hook`. */
  hookBinary: string
  /**
   * The one sandbox service of this process (#1150), built lazily at a host's edge so that a process whose recipes
   * have no `sandbox:` block never loads srt. Absent with a sandboxed decision is a refusal by name, never an
   * unwrapped run.
   */
  sandbox?: Effect.Effect<SandboxApi, { readonly reason: string; readonly sentences: readonly string[] }>
  /** False wires no hooks and skips the smoke test. See `RenderOptions.guard`. */
  guard?: boolean
  /** The ticket prompt. Versioned, and recorded on every `RunPrompted`. */
  prompt: string
  promptVersion?: string
  token?: TokenSource
  home?: string
  store?: EventStore
  /**
   * Where the pass offers snapshots of what it read (0124 §5). Given only inside the daemon, which
   * holds one writer for its lifetime; `lingtai run` reads snapshots and never writes them.
   */
  snapshotWriter?: { offer(snapshot: Snapshot): void }
  gitEnv?: NodeJS.ProcessEnv
  /** The waits between tries of a landing's git network call (#1029); a test passes zeros. Default `UNREACHABLE_WAITS`. */
  unreachableWaits?: readonly Duration.Input[]
  /** The waits before each step redo and each `land-again` (#1221); absent is `BOUNDS.stepRedoWaits`. */
  stepRedoWaits?: readonly Duration.Input[]
  /** Overrides the clone source. The tests point it at a local repository. */
  remote?: string
  /**
   * **Makes a team project's `branch.personal` when the remote has none** (#1358) — asked only after the cut
   * found its base absent, in team mode, for the action's own base. Absent: the cut refuses as it always did.
   */
  personalBranch?: PersonalBranchPort
  /**
   * False stops after the gates, with the branch pushed and every verdict
   * recorded, and asks a person for the merge.
   *
   * This is not a separate mechanism from the human gate (#20). It requests the
   * same `signoff` a `human:` action at `merge` requests, which is
   * what keeps it from becoming a second vocabulary for one idea. A recipe that
   * declares nothing at `merge` still holds under the flag; one that declares a
   * person there holds whether or not the flag was passed. The hold is
   * bound to `onSha` like any other verdict, so a force-push invalidates it by
   * arithmetic rather than by anyone remembering to.
   */
  merge?: boolean
  log?: (line: string) => void
  /**
   * **An observer, called with the `AttemptOver` the moment `runAttempt` returns
   * it** (`#466`). It branches on nothing and the pass does not wait for it —
   * the one caller today is `test/one-attempt.ts`'s `once()`, which checks
   * `adapters.ts`'s `eventOf` against the run stream `conduct.ts` itself is
   * about to write from the very same `pass.steps`, so a mismatch there is an
   * adapter bug by #461's own rule rather than a reason for this seam to exist
   * for production use. A throw from it is caught and noted on `runLog`
   * rather than skipping the ending below.
   */
  onPass?: (pass: AttemptOver) => void
  /**
   * **Resume a held run from its own wait, rather than start a fresh one**
   * (#465, 0120 §6) — set only by `conductWork`'s own continuation branch
   * (`apps/cli/src/conduct.ts`), never by a hand-picked `lingtai now` or an
   * ordinary queue pass.
   *
   * Carries only the run id: everything else — which step it continues at,
   * what it waives there, the sha to re-cut from, and the rounds already
   * spent — is read off the ticket's own `approved` lifecycle and the run's
   * own stream at the moment `take` reclaims it (below), never trusted from
   * a caller's copy that may be stale by the time this runs.
   */
  continuing?: { runId: string }
}

/**
 * What a person is shown about a pass once it ends (#766): the ticket, the
 * visits that ran an action and how each ended, and what the pass spent.
 * Built from facts the pass already holds; nothing here is written to the log.
 */
export type AttemptSummary = {
  ref: string
  title: string
  /** Visits that ran at least one action, or were declared — the ones `attemptLine` does not print as `skipped`. */
  ran: readonly { step: string; ending: string }[]
  /** Dollars of every `RunSpent` the pass appended; `unknown` counts the runs that reported none. */
  cost: { usd: number; unknown: number }
  /** Why a held pass waits, whole: the commands it offers depend on more than the tag. Absent on any other ending. */
  wait?: WaitReason
}

export type RunOnceResult =
  /**
   * `satisfied` is set where the base already held the work and a review checked it (#1251): nothing landed, and
   * `mergeCommit` is then the base's sha the check was bound to.
   */
  | { ok: true; ticketId: string; runId: string; mergeCommit: string; satisfied?: true; summary?: AttemptSummary }
  /**
   * Reached the merge and stopped, because a person asked it to. Deliberately
   * not `ok: false` with a stage — nothing refused, and calling it a failure
   * would be the kind of convenient fiction the log exists to prevent.
   */
  | { ok: 'held'; ticketId: string; runId: string; headSha: string; step: string; summary?: AttemptSummary }
  | {
      ok: false
      ticketId: string | null
      runId: string | null
      stage: string
      detail: string
      summary?: AttemptSummary
    }

/** A defect's own words. Wanted by the publish and by the release above it. */
function whyOf(defect: unknown): string {
  return defect instanceof Error ? defect.message : String(defect)
}

function said(detail: string, n = 300): string {
  const one = detail.replace(/\s+/g, ' ').trim()
  if (one === '') return 'no detail was recorded'
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/** How a runtime is spawned for the fail-closed smoke test. */
function runBinary(
  bin: string,
  env: Record<string, string>,
  stdin: string,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (c) => (stderr += c.toString()))
    child.on('close', (code) => resolve({ code, stderr }))
    child.on('error', (err) => resolve({ code: null, stderr: err.message }))
    child.stdin.end(stdin)
  })
}

/**
 * The `pass:` line: one entry per visit, in order.
 *
 * A visit that passed having run no action, at a step the recipe declared
 * nothing for, prints `skipped` — the board's own word for it — because
 * `passed` there only means the visit happened and nothing objected. `end`
 * always has empty `results` (its list is effects), so the recipe's own list
 * is what tells a declared `end` from an empty one.
 */
export function attemptLine(
  steps: readonly StepReached[],
  declared: Readonly<Record<string, readonly unknown[] | undefined>>,
): string {
  const word = (v: StepReached): string => (wasSkipped(v, declared) ? 'skipped' : v.ending.ending)
  return `attempt: ${steps.map((v) => `${v.step}=${word(v)}`).join(' ')}`
}

/** A visit that passed having run no action, at a step the recipe declared nothing for. */
function wasSkipped(v: StepReached, declared: Readonly<Record<string, readonly unknown[] | undefined>>): boolean {
  return v.ending.ending === 'passed' && v.results.length === 0 && (declared[v.step] ?? []).length === 0
}

/** The visits a person is shown: `attemptLine`'s own test, so the two cannot disagree. */
function ranVisits(
  steps: readonly StepReached[],
  declared: Readonly<Record<string, readonly unknown[] | undefined>>,
): AttemptSummary['ran'] {
  // A routing decision is the router's, not an action that ran or refused.
  return steps
    .filter((v) => v.ending.ending !== 'routed' && !wasSkipped(v, declared))
    .map((v) => ({ step: v.step, ending: v.ending.ending }))
}

/**
 * What a pass left the tree at, read off the visits.
 *
 * `LeftTheTreeAt` is on an ending and the walk carries it forward, so the last
 * one any visit reported is the head every verdict after it was about — and the
 * head a person is shown on a card. Empty where nothing was cut.
 */
function headReached(steps: readonly StepReached[]): string {
  return steps.reduce<string>((sha, visit) => visit.ending.head ?? sha, '')
}

/**
 * The action a step named when it did not pass, or null where none did.
 *
 * `StepReport` includes `passed`, which carries no `at` — and a `null` `at` is
 * the step's *own* work having refused rather than a declared action, which
 * `attempt-steps.ts` says at each of the bodies that set it.
 */
function whatRefused(stopped: AttemptOver['stopped']): string | null {
  if (stopped === null) return null
  return 'at' in stopped.ending ? stopped.ending.at : null
}

/** What a step said when it did not pass, in the words a person reads (0043). */
function detailOf(ending: AttemptOver['stopped']): string {
  if (ending === null) return ''
  const said = ending.ending
  if ('detail' in said) return said.detail
  return 'question' in said ? said.question : said.ending
}

/**
 * One work item, claim through merge, on `run-attempt.ts`.
 *
 * The name is unchanged because what it names is unchanged — *one pass* — and
 * `schedule.ts`, `apps/cli`'s `run` and `tally.ts` all hold it. What changed is
 * everything under it: the five gate points are ten steps, the sequence is
 * `runAttempt`'s, and this is the caller the pass was written to be called by.
 */
/** A grant buys the next implement visit after every round already recorded on this run. */
export function continuationRound(run: AttemptState, granted: boolean): number {
  return granted ? run.implementRound + 1 : run.implementRound
}

/** What a held attempt's stream says it has spent of the mechanical bounds, absent read as 0 (0108 §8, #1200). */
export const continuationSpent = (run: AttemptState) => ({
  baseMerges: run.baseMerges ?? 0,
  conflictRounds: run.conflictRounds ?? 0,
  stepRedos: run.stepRedos ?? 0,
  landingRetries: run.landingRetries ?? 0,
})

/**
 * **What a held attempt has spent, with what triage's own resolutions spent before the continuation could record it**
 * (#1258): each counter is the larger of the attempt's own and `triageSpentOf`'s, never their sum — the number a triage
 * resolution carries is the one the continuation records itself, so once it has there is one spend, and before it has
 * this says it alone, whatever restarts between the append and the effect.
 */
export const continuationSpentWithTriage = (
  run: AttemptState,
  ticket: TicketState,
  runId: string,
  runEvents: readonly Envelope[],
) => {
  const personRounds = personFixRoundsOf(ticket, runId, runEvents)
  const own = continuationSpent(run)
  const triage = triageSpentOf(ticket, runId)
  return {
    ...own,
    conflictRounds: Math.max(own.conflictRounds, triage.conflictResolutions),
    stepRedos: Math.max(own.stepRedos, triage.stepRedos),
    // `triage.refusalFixes` is in the allowance's units (a person's rounds taken out), `implementRound` is the round counter.
    rounds: Math.max(run.implementRound, triage.refusalFixes + personRounds),
    /** The refusal fixes the allowance has spent: a person's `FixRefusal` rounds are not among them. */
    refusalFixes: Math.max(run.implementRound - personRounds, triage.refusalFixes, 0),
    /** A person's fix rounds inside `rounds`: the allowance is judged without them. */
    personRounds,
  }
}

/**
 * **A person's approval of review findings, and the head it was on** (#1279): a continuation answers one
 * (`approvedNow`), or follows the system's own merges onto one no agent commit has come after. A retry, a grant
 * or an answer is neither. A declared `human:` at `proposed` asks a `SignoffRequired`, and its approval counts too.
 */
function approvalOf(
  waits: ReturnType<typeof waitsFromState>,
  outcomes: ReturnType<typeof stepOutcomesOf>,
  runId: string,
  approvedWaitId: string | undefined,
  granted: boolean,
): { approvedHead?: string; approvedNow?: true } {
  const approves = waits.filter(
    (w) =>
      w.resolution?._tag === 'Approve' &&
      (w.reason._tag === 'SignoffRequired' ||
        (w.reason._tag === 'ProposedEscalated' && w.reason.proposal._tag !== 'DiffTooLarge')) &&
      w.reason.run.runId === runId,
  )
  const last = approves[approves.length - 1]
  const head = last?.resolution?._tag === 'Approve' ? last.resolution.onSha : undefined
  if (granted || head === undefined) return {}
  const at = outcomes.findLastIndex(
    (o) => (o.step === 'proposed' || o.step === 'merge') && o.actions.some((a) => a.onSha === head),
  )
  if (at < 0) return {}
  if (outcomes.slice(at + 1).some((o) => o.step === 'implement') && !onlyAConflictRoundSince(outcomes, at)) return {}
  return {
    approvedHead: head,
    ...(last!.waitId === approvedWaitId ? { approvedNow: true as const } : {}),
  }
}

/** srt's own explanation out of a `SandboxWrapFailed`'s `cause`. */
const causeText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'no explanation was given'

export function runOnce(options: RunOnceOptions): Effect.Effect<RunOnceResult, never, Repo | AgentHost> {
  const run: Effect.Effect<RunOnceResult, never, Repo | AgentHost> = Effect.gen(function* () {
    // Asked for, not threaded through, which is the half of 0023 the `RunPorts`
    // parameter was standing in for.
    const repo = yield* Repo
    const host = yield* AgentHost

    const store = options.store ?? eventStore
    // The default log's snapshots belong to the default store; a store passed in has none of its own.
    const controlSnapshots = options.store === undefined ? theLog.snapshots : undefined
    // What every ticket read in this pass is offered: the same snapshots, and the daemon's writer if it gave one.
    const ticketSnapshots = { snapshots: controlSnapshots, writer: options.snapshotWriter }
    const home = options.home ?? stateDir()
    const log = options.log ?? (() => {})
    const project = options.project.project!
    const basePromptVersion = options.promptVersion ?? 'ticket@1'

    /**
     * An append at whatever version the stream is at, and nothing else.
     *
     * An `Effect` over the promise `store`: one read and one append at the
     * length it read (an expected-version write), with no retry. A store that
     * refuses is a defect. **For the callers that answer a refused append
     * themselves** — the account of the publish, the diff's counts, the
     * release's record of what `end` resolved — each of which has already
     * decided that losing its row costs less than losing the ending it is
     * about; they use `Effect.catchDefect`, never a catch that takes an
     * interrupt too. Everything else uses `appendNow`.
     */
    const appendAt = (stream: string, events: readonly ToAppend[]): Effect.Effect<number> =>
      Effect.gen(function* () {
        const at = (yield* Effect.promise(() => store.read(stream))).length
        const written = yield* Effect.promise(() => store.append(stream, at, events))
        // The version of the last event written: what a later event can name (#931).
        return written.length > 0 ? written[written.length - 1]!.version : at
      })

    /**
     * The same append, **remembered when the store refuses it**.
     *
     * A store that will not append is a defect and not a refusal this function
     * can make on anyone's behalf: the handler at the bottom is where defects
     * are answered for. That was true of every append while the old engine made
     * them, and the swap to `run-attempt.ts` quietly made it false for the ones made
     * from inside the walk — `emit`'s verdicts, `dispatch`'s `RunStarted`, a
     * round's `PassRouted`. `runStep` catches whatever a step throws and
     * reports it as that step having *did-not-finish: threw* (`run-attempt.ts`), so a
     * dropped Postgres connection — the disconnect CLAUDE.md documents against
     * `#157` — came back as `blocked` with `needs: "acknowledgement"` and a
     * diagnosis naming the step, parking the item on *Waiting on you* over a
     * database blip and losing the verdict it was recording. Before the swap
     * the same rejection reached the defect handler, released the item, and the
     * queue took it again after the backoff with nobody involved.
     *
     * So the throw still travels — the step must not carry on as though its
     * verdict were recorded — and the defect is kept here, where the ending is
     * written: the pass is re-raised into the defect channel the moment it
     * returns (see `unappended`), rather than having its report believed.
     */
    let unappended: unknown = null
    const remembered = <A>(effect: Effect.Effect<A>): Effect.Effect<A> =>
      effect.pipe(
        Effect.tapDefect((defect) =>
          Effect.sync(() => {
            unappended ??= defect
          }),
        ),
      )
    const appendNow = (stream: string, events: readonly ToAppend[]): Effect.Effect<number> =>
      remembered(appendAt(stream, events))

    /**
     * The same, at a version the caller already holds rather than one read here.
     *
     * The receipts, and only those: the hook server wrote to the run's stream
     * while the agent worked, so `server.get(runId).version` is where it got to
     * and a read of our own would race it. Remembered like `appendNow` and for
     * its reason — the dispatch is inside the walk, so a store that refuses one
     * of these arrives as *the `implement` step threw* unless this says
     * otherwise.
     */
    const appendFrom = (stream: string, version: number, events: readonly ToAppend[]): Effect.Effect<void> =>
      Effect.promise(() => store.append(stream, version, events)).pipe(
        Effect.asVoid,
        Effect.tapDefect((defect) =>
          Effect.sync(() => {
            unappended ??= defect
          }),
        ),
      )

    /**
     * The hook server of the `implement` dispatch in flight, so that an append made mid-run keeps its version.
     *
     * It appends to the stream at its own in-memory `run.version` and advances it (`hook-socket.ts`), so an
     * append made here by a read of the head would leave that version one behind and its next
     * `RunTouchedFile` would be refused (#1164).
     */
    let hookRuns: { get(runId: string): { version: number } | undefined } | undefined
    /**
     * An invocation's sandbox rows, on the pass's stream and at the version a registered hook server holds.
     * `remember`: a refused append is remembered as the pass's defect (`appendNow`'s reason), for both rows.
     */
    const appendInvocation = (stream: string, events: readonly ToAppend[], remember: boolean): Effect.Effect<void> => {
      const registered = hookRuns?.get(stream)
      if (registered === undefined) {
        return remember ? appendNow(stream, events).pipe(Effect.asVoid) : appendAt(stream, events).pipe(Effect.asVoid)
      }
      return Effect.promise(() =>
        store.append(stream, registered.version, events).then((written) => {
          if (written.length > 0) registered.version = written[written.length - 1]!.version
        }),
      ).pipe(
        remember
          ? Effect.tapDefect((defect) =>
              Effect.sync(() => {
                unappended ??= defect
              }),
            )
          : (self) => self,
      )
    }
    // What this pass's invocations were refused, by step; `runStep` drains it into the step's outcome (#1157).
    const refusals = makeRefusalCollector()
    /** Tells the Project what sandbox a run met. A failure is a log line: the next run's transition records it. */
    let noteOnRunLog: (label: string, detail: string) => void = () => undefined
    const observeTheSandbox = (kind: 'sandboxed' | 'degraded' | 'off by choice', runId: string): Effect.Effect<void> =>
      observeSandbox(options.project.project!, { kind, runId }, store).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const why = `observation not recorded — ${Cause.pretty(cause)}`
            log(`sandbox: ${why}`)
            noteOnRunLog('sandbox', why)
          }),
        ),
      )
    const invocationAppends = (stream: string): InvocationAppends => ({
      before: (events) =>
        appendInvocation(stream, events, true).pipe(
          // Only once the boundary is on the stream, and never able to stop the child: the boundary is the record.
          Effect.andThen(
            Effect.forEach(events, (event) => {
              // `before` carries boundaries and nothing else (`sandbox-record.ts`), so the boundary is read, not the type.
              const boundary = (event.data as { boundary?: { kind: string; reason?: string } }).boundary
              const kind = boundary === undefined ? null : observedKindOf(boundary)
              return kind === null ? Effect.void : observeTheSandbox(kind, stream)
            }),
          ),
        ),
      // Remembered, so the pass cannot report success with a refusals row missing; swallowed here so the child's
      // own receipts are not lost over it.
      after: (events) => appendInvocation(stream, events, true).pipe(Effect.catchDefect(() => Effect.void)),
      read: refusals.record,
    })

    // ---- 1. the recipe, from this machine -----------------------------------
    // `~/.lingtai/<project>/recipe.yml` (0046 §3, #180), the same read every
    // other command that conducts makes.
    //
    // An unreadable or non-compliant recipe must stop the run rather than fall
    // back to a default, and **every cause of it stops it the same way**: a
    // failure and a defect both answer `stage: 'recipe'`, because a daemon
    // restarted onto a bad recipe takes nothing at all rather than crashing
    // every pass. `Effect.result` sees only the failure channel; this sees both.
    const given = options.recipe
    const recipeAt: Result.Result<ResolvedRecipe, string> = yield* (
      given
        ? Effect.tryPromise(() => given())
        : currentRecipeEffect(options.project, options.client, undefined, { store })
    ).pipe(
      Effect.map((found) => Result.succeed(found)),
      Effect.catchCause((cause) => {
        const err = Cause.squash(cause)
        return Effect.succeed(Result.fail(err instanceof Error ? err.message : String(err)))
      }),
    )
    if (Result.isFailure(recipeAt)) {
      return { ok: false, ticketId: null, runId: null, stage: 'recipe', detail: recipeAt.failure }
    }
    const resolved = recipeAt.success
    const recipe = resolved.recipe
    /** The request's `sandbox` for a decision: absent unless it is *sandboxed* or *refused*. */
    const sandboxOf = (
      passDecision: SandboxDecision | undefined,
      run: { runId: string; worktree: string | undefined },
      /** The pass's stream, and what names this invocation on it (#1164). `runId` above is the dispatch's own. */
      record: { stream: string; step: Step; action: string; runtime: string },
    ): Effect.Effect<{ sandbox: RunSandbox } | Record<string, never>> => {
      if (passDecision === undefined) return Effect.succeed({})
      // The pass decided once; a runtime that cannot be sandboxed narrows it for its own invocation.
      const decision = invocationDecision(passDecision, record.runtime)
      const keys = { step: record.step, action: record.action, runtime: record.runtime, runId: run.runId }
      const appends = invocationAppends(record.stream)
      // Not wrapped, so nothing else will say which boundary this one ran under: record it before the child starts.
      if (decision.kind === 'unsandboxed') return recordUnwrapped(decision, keys, appends.before).pipe(Effect.as({}))
      const runDir = claudeConfigDirFor(home, run.runId)
      const service = options.sandbox
      return Effect.succeed({
        sandbox: {
          decision:
            decision.kind === 'sandboxed'
              ? { kind: 'sandboxed', project_additions: decision.project_additions }
              : { kind: 'refused', why: decision.why },
          project,
          mirror: mirrorPathFor(project, home),
          cache: join(home, 'cache', project),
          worktree: run.worktree ?? runDir,
          runDir,
          operatorClaudeDir: join(homedir(), '.claude'),
          hostHome: homedir(),
          codexNamed: runtimesOf(recipe).includes('codex'),
          read: [options.hookBinary],
          wrap: (input) =>
            service === undefined
              ? Effect.fail({ message: 'no sandbox service in this process' })
              : service.pipe(
                  Effect.mapError((e) => ({ message: [e.reason, ...e.sentences].join('; ') })),
                  Effect.flatMap((api) =>
                    // A wrap that fails appends no boundary: no child starts, and the run's own failure is the record.
                    recordingWrap(api, input, keys, appends).pipe(
                      Effect.mapError((e) => ({
                        message:
                          e._tag === 'SandboxUnavailable'
                            ? [e.reason, ...e.sentences].join('; ')
                            : e._tag === 'SandboxPolicyRefused'
                              ? `the sandbox policy refused ${e.refusals.map((r) => r.path).join(', ')}`
                              : `srt could not wrap the command: ${causeText(e.cause)}`,
                      })),
                    ),
                  ),
                ),
        },
      })
    }
    // The agent the recipe resolved to is the agent that runs, or nothing runs
    // (0046 §3). Before the claim, for the same reason as the refusals around it.
    /**
     * **Every runtime a step names that is not the pass's own** (`#314`).
     *
     * Empty for every recipe that names none, which is the point: `signedInHere`
     * is a process per runtime, `runOnce` is on the hot path, and a probe asked
     * where there is nothing to decide would be a spawn bought by a feature the
     * recipe did not use. Empty also means `agentRefusal`'s loop below never
     * reads the list, so the two facts stay one branch.
     *
     * **A `runtime.agent` other than the pass's own is refused without the
     * probe**: `agentRefusal`'s first branch never reads the list, so the probe
     * is asked only where `runtime.agent` is the pass's own runtime.
     */
    const ownRuntime = options.runtime.capabilities.id as RuntimeId
    const secondRuntimes = new Set<RuntimeId>(runtimesOf(recipe).filter((r) => r !== ownRuntime))
    const dispatchable: readonly string[] =
      secondRuntimes.size === 0 || recipe.runtime.agent !== ownRuntime
        ? []
        : yield* Effect.promise<readonly RuntimeId[]>(() => (options.signedIn ?? signedInHere)())
    // A sandboxed run is handed the machine's Copilot token, so for such a recipe the token signs Copilot in too;
    // an unsandboxed one never receives it, and the token-free probe above is the whole answer.
    const dispatchableNow: readonly string[] =
      recipe.sandbox?.enabled === true &&
      secondRuntimes.has('copilot') &&
      recipe.runtime.agent === ownRuntime &&
      !dispatchable.includes('copilot') &&
      (yield* Effect.promise(() => copilotTokenSignedIn()))
        ? [...dispatchable, 'copilot']
        : dispatchable
    const wrongAgent = agentRefusal(resolved, options.runtime.capabilities.id, dispatchableNow)
    if (wrongAgent !== null) {
      return {
        ok: false,
        ticketId: null,
        runId: null,
        stage: 'recipe',
        // **Per-step dispatch is built, so the remedy is no longer *name the
        // other one*** (`#314`, 0070 §7). The `runtime.agent` half is still an
        // assertion that the caller picked correctly — `conduct.ts` constructs
        // from that very field — and the step half is now about signing in
        // rather than about what this conductor happens to run.
        detail:
          wrongAgent.at === 'runtime.agent'
            ? `${wrongAgent.sentence} — nothing was claimed. Name ${options.runtime.capabilities.id} there to run with it`
            : `${wrongAgent.sentence} — nothing was claimed. Sign in to it, or name a runtime this machine has`,
      }
    }
    /**
     * **What this pass is, as to the sandbox — decided once, before the claim** (#1152). Every action's wrap
     * reads this one answer, so none can see *sandboxed* while another sees *degraded*. A refusal here claims nothing, like the refusals around it.
     */
    const passSandbox = yield* decidePassSandbox(recipe.sandbox, options.sandbox)
    const sandboxDecision = passSandbox.decision
    /** The same answer at every agent site (#1150): one decision per pass, so a `run:` and the agent beside it agree. */
    const decideSandbox: Effect.Effect<SandboxDecision> = Effect.succeed(sandboxDecision)
    if (sandboxDecision.kind === 'refused') {
      return {
        ok: false,
        ticketId: null,
        runId: null,
        stage: 'recipe',
        detail: `${sandboxDecision.why} — nothing was claimed`,
      }
    }
    if (sandboxDecision.kind === 'sandboxed' && passSandbox.service === undefined) {
      // The early form of fail-closed: without it an `implement` agent is paid for before `build` refuses.
      return {
        ok: false,
        ticketId: null,
        runId: null,
        stage: 'recipe',
        detail:
          'the recipe sandboxes its runs and this host provided no Sandbox service to wrap them with — nothing was claimed',
      }
    }
    if (sandboxDecision.kind === 'unsandboxed' && sandboxDecision.reason === 'degraded') {
      log(`sandbox: running unsandboxed — ${sandboxDecision.why}`)
    }
    // Safe now, and only now: past the refusal these two are the same branch.
    const passBase = branchOf(recipe)
    /**
     * **The branch this attempt is cut from and lands on** (0130 §5, #1341): `branch.personal` for every claim but a
     * team `lingtai:pr-fix` taken while a PR is open, which is that PR's branch. Decided once per attempt — in `take`
     * for a fresh claim, off the ticket's own `cutFrom` for a continuation — and **read where it is used, never closed
     * over**: `passBase` is what is true before a claim, `attemptBase()` after it.
     */
    let attemptCut = null as { readonly branch: string; readonly pr: number | null } | null
    const attemptBase = (): string => attemptCut?.branch ?? passBase
    /**
     * **A landing on `branch.personal` joins the draft in the same transaction** (ADR 0131 §1, `landTicketEffect`).
     * Null for a solo project and for a pr-fix, whose base is the PR's branch.
     */
    const draftOfLanding = (): { project: string } | null =>
      modeOf(recipe) === 'team' && recipe.branch.personal !== undefined && attemptBase() === recipe.branch.personal
        ? { project }
        : null
    /**
     * **`runtime.limits` — the ceiling, and the default under every dispatch**
     * (`#314`, 0070 §5).
     *
     * It was `limitsFor(recipe, "implement")` applied to all three dispatch
     * sites, which was one number read at three steps. `rounds` and `restarts`
     * are the pass's and are only ever this; `turns` and `wall` are what a
     * dispatch that declares nothing gets, and `spendFor` is where one that
     * declares something narrows it.
     */
    const ceiling = ceilingOf(recipe)
    /**
     * **What one call may spend**: the dispatch's own `limits:` where the recipe
     * wrote one, and the ceiling where it did not (0070 §5).
     *
     * Field by field, so `limits: { turns: 50 }` narrows the turns and keeps the
     * wall. Widening is already impossible here — `Recipe` refuses a `limits:`
     * past the ceiling when it resolves, before the claim — so this is a
     * substitution and never a `Math.min`, and the refusal stays the one place
     * that rule is stated.
     */
    const spendFor = (own?: { readonly turns?: number; readonly wall?: string }) => ({
      // `unbounded` is a request with no `turns` (#547), as `usd` is.
      turns: numericTurns(own?.turns ?? ceiling.run.turns),
      wallMs: parseDuration(own?.wall ?? ceiling.run.wall),
      // The ceiling's own, unchanged: a dispatch's `limits:` is a
      // `strictObject` that refuses `usd` by name, so there is nothing a step
      // could narrow here (`#370`).
      usd: ceiling.run.usd,
    })
    /**
     * **The runtime a step named, dispatched** (`#314`, 0070 §7).
     *
     * `options.runtime` is the pass's default — what `runtime.agent` resolved to,
     * constructed by the caller — and it is returned by identity for its own id,
     * so a recipe that names nothing else dispatches the object every test
     * already supplies. Anything else is built from `RUNTIMES`, the one table a
     * `RuntimeId` is dispatchable by (`#313`), and kept for the pass: three
     * `agent:` entries naming one runtime are one process's worth of
     * construction, and a second object would be a second adapter with its own
     * idea of what it had been asked.
     *
     * `options.runtimeFor` is the seam a test hands a second fake through.
     * Beside `runtime:` rather than replacing it, because inverting the port
     * would change a field every test that supplies a fake passes through, to
     * save one read (`apps/cli/src/run.ts`'s own argument).
     */
    const runtimeNamed = (() => {
      const made = new Map<RuntimeId, Runtime>([[options.runtime.capabilities.id, options.runtime]])
      return (id: RuntimeId): Runtime => {
        const kept = made.get(id)
        if (kept !== undefined) return kept
        const built = (options.runtimeFor ?? createRuntime)(id)
        made.set(id, built)
        return built
      }
    })()
    log(`recipe ${resolved.configHash.slice(0, 12)} from ${resolved.ref}`)

    // ---- 2. the environment, before anything is claimed ---------------------
    // A declared name with no value refuses the whole project for this pass: no
    // worktree, no agent, no money. It used to be a log line, after which the
    // run claimed the ticket and spent $0.97 producing nothing against a
    // database it could not reach (0020).
    const asked = yield* Effect.result(
      host.resolveEnv({
        project,
        // All three, because all three are the recipe's: `required` refuses,
        // `allow`/`deny` filter (0021).
        required: recipe.env.required,
        allow: recipe.env.allow,
        deny: recipe.env.deny,
        patterns: productionPatterns(recipe.env.refuseHosts),
        home,
      }),
    )
    if (Result.isFailure(asked)) {
      return { ok: false, ticketId: null, runId: null, stage: 'env', detail: asked.failure.detail }
    }
    const env = asked.success
    if (env.refusal) {
      return { ok: false, ticketId: null, runId: null, stage: 'env', detail: env.refusal }
    }
    log(
      `env: ${env.names.length === 0 ? 'nothing declared' : env.names.map((n) => `${n.name} from ${n.layer}`).join(', ')}`,
    )

    /**
     * The environment of one extension — every `run:` action's, and nothing
     * else's (0037 §1).
     *
     * Not `env.values`: that is the agent's, and handing it to a command is what
     * put one project's credential in every extension's process.
     */
    const envForExtension = (declared: readonly string[]): Record<string, string> =>
      runnableEnv(extensionEnv(env.merged, declared, productionPatterns(recipe.env.refuseHosts)).values)

    // The tripwire over every extension's declared values, here and not only
    // when `envForExtension` is first called: a denied production value would
    // otherwise first throw mid-run, past the claim, as a defect.
    const extensionRefusal = Result.try(() => {
      for (const step of Object.values(recipe.steps)) {
        for (const action of step) {
          if ('run' in action) extensionEnv(env.merged, action.env, productionPatterns(recipe.env.refuseHosts))
        }
      }
      for (const subscriber of recipe.subscribers) {
        extensionEnv(env.merged, subscriber.env, productionPatterns(recipe.env.refuseHosts))
      }
    })
    if (Result.isFailure(extensionRefusal)) {
      const detail =
        extensionRefusal.failure instanceof Error ? extensionRefusal.failure.message : String(extensionRefusal.failure)
      return { ok: false, ticketId: null, runId: null, stage: 'env', detail }
    }

    // ---- 3. capability matching, before anything is claimed -----------------
    /**
     * **Asked of every runtime this pass will dispatch, not only the default**
     * (`#314`, 0070 §8).
     *
     * Failing closed is a fixed requirement, not a property a recipe asks for
     * (#1158), so a step naming a runtime that cannot is the *pass* being
     * impossible, and is recorded as `DispatchRefused` before the claim rather
     * than as a step failing halfway through one. `refusedBy` names which
     * runtime could not, because *missing pre-tool-use-interception* over a
     * two-runtime recipe says nothing about which line to edit. It is the
     * project's refusal for this pass and pauses nothing (#676).
     */
    const refusedBy = [options.runtime.capabilities.id, ...secondRuntimes]
      .map((id) => ({ id, missing: missingToFailClosed(runtimeNamed(id as RuntimeId).capabilities) }))
      .find((each) => each.missing.length > 0)
    const missing = refusedBy?.missing ?? []
    const ticketId = ticketStream(project, options.issue)

    if (missing.length > 0) {
      // Never silently downgrade. The refusal is an event on the work item so the
      // board can say why nothing ran.
      const runtime = refusedBy?.id ?? options.runtime.capabilities.id
      yield* remembered(refuseDispatchEffect(ticketId, { runtime, missing }, store, ticketSnapshots))
      return {
        ok: false,
        ticketId,
        runId: null,
        stage: 'dispatch',
        detail: `${project}: ${runtime} cannot fail closed: missing ${missing.join(', ')}.`,
      }
    }

    const branch = agentBranch(options.issue)

    /**
     * The item's stream as it was before this claim, read once.
     *
     * Everything the prompt is composed from is read from it — the edit a person
     * left, a repair bought before `#143`, what the earlier attempts did — and
     * all of it for one reason (0032 §5): **the claim is what consumes them**, so
     * a read taken afterwards finds nothing and the edit silently never reaches
     * the agent. It is also where the restarts already spent are counted, which
     * is what `Ceilings.restartsLeft` is.
     */
    // Read through a snapshot where the default log has one, and every event type (#876): `version`
    // is the stream's head and `claimTicket` appends at it, so a typed tail would break every append.
    // A failure is a defect, as it was inside `Effect.promise`.
    const reduced = yield* readThroughSnapshot(store, ticketReducer, ticketId, 'all', ticketSnapshots).pipe(
      Effect.orDie,
    )

    // A continuation is the same attempt, so it keeps the branch its claim was cut from (#1341); `take` decides it
    // again for a fresh claim, which is why this is only ever read where `continuation` is not null.
    attemptCut = reduced.cutFrom

    /**
     * **Resuming a held run, read fresh off the log rather than trusted from
     * the caller** (#465, 0120 §6). `options.continuing` names only a
     * `runId`; everything else is computed here, at the moment this claim
     * is about to be made — a request that raced a requeue, a second
     * approval, or a close finds the lifecycle no longer `approved` (or
     * naming a different run) and this is simply `null`, which `take`
     * below reports as an ordinary `notClaimed` rather than acting on a
     * stale copy.
     */
    /** Set by the second source below: why a release-sourced continuation was declined rather than taken. */
    let releasedDeclined: string | null = null
    /** Why the saved head of a released attempt could not be cut again, once the cut found out (#1205). */
    let headGone: string | null = null
    /** The words a recorded prompt was handed with, expanded; null where a ref no longer resolves (#1205). */
    const recordedPromptOf = (record: PayloadOf<'RunPrompted'>) =>
      Effect.gen(function* () {
        if (record.prompt === null) return null
        if ((record.refs ?? []).length === 0) return record.prompt
        const run = Effect.runPromiseWith(yield* Effect.context<never>())
        const values = yield* Effect.tryPromise(() =>
          resolvePromptRefs(record.refs ?? [], {
            store,
            git: (args, cwd) =>
              run(
                repo.git([...args], { token: options.token, env: options.gitEnv, cwd }).pipe(
                  Effect.match({
                    onSuccess: (out) => ({ ok: true as const, out }),
                    onFailure: (e) => ({ ok: false as const, why: e.detail }),
                  }),
                ),
              ),
            mirrorPath: mirrorPathFor(project, home),
          }),
        )
        const expanded = expandPrompt(record, values)
        return expanded.unresolved.length === 0 ? expanded.text : null
      }).pipe(Effect.orElseSucceed(() => null))
    const continuation = yield* Effect.gen(function* () {
      if (options.continuing === undefined) {
        /**
         * **The other source of a continuation: a queued ticket whose last release names a run to
         * continue** (#1205, `continuableRelease`). Read here, at the version this claim will append at,
         * so a ticket that moved since is `null` and an ordinary claim; the owner's continue
         * transition checks the same question again. The cause decides which head and which `from`
         * (`releasedHeadOf`, `released.cause`); #1211 adds `BaseRed` to it.
         */
        if (reduced.lifecycle.status !== 'backlog') return null
        const releasedFrom = continuableRelease(reduced)
        if (releasedFrom === null) return null
        const cause = releasedFrom.cause
        if (cause._tag === 'BaseRed') {
          /**
           * **A ticket released for a red base is the same attempt, taken again** (#1211, 0108 §13, §15): its
           * worktree is cut at the release's `headSha`, the green base is merged in as a base merge, and the
           * walk goes on at `build`. Every read before the claim that fails leaves the ticket queued for the
           * next look — a failed read is never *head gone*. The claim that follows appends `TicketContinued`
           * at the version read above, so a race between two looks is a `notClaimed` exactly as for #1205.
           */
          const baseRead = yield* repo.baseHead({
            project,
            owner: options.client.owner ?? '',
            repo: options.client.repo,
            base: attemptBase(),
            ...(options.token === undefined ? {} : { token: options.token }),
            ...(options.remote === undefined ? {} : { remote: options.remote }),
            home,
            ...(options.gitEnv === undefined ? {} : { gitEnv: options.gitEnv }),
          })
          if ('unreadable' in baseRead) {
            releasedDeclined = `the base's head could not be read: ${baseRead.unreadable}`
            return null
          }
          // The `build` action whose command the red record names: asked by name, not by command (`baseIsRed`).
          const action = buildRunsOf(recipe).find((each) => each.run === cause.command)?.name ?? null
          // Unchanged is only a reason to wait while something still runs the command that failed.
          if (baseRead.at === cause.baseSha && action !== null) {
            releasedDeclined = `the base is still at the red commit ${cause.baseSha.slice(0, 7)}`
            return null
          }
          const listed = yield* repo
            .git(['ls-remote', 'origin', `refs/heads/${branch}`], {
              token: options.token,
              env: options.gitEnv,
              cwd: mirrorPathFor(project, home),
            })
            .pipe(Effect.result)
          if (Result.isFailure(listed)) {
            releasedDeclined = `origin could not be asked for ${branch}: ${listed.failure.detail}`
            return null
          }
          const lines = listed.success.split('\n').filter((line) => line.trim() !== '')
          const answered = lines.length === 1 ? /^([0-9a-f]{40})\t(\S+)$/.exec(lines[0]!.trim()) : null
          if (lines.length > 0 && answered === null) {
            releasedDeclined = `origin's answer for ${branch} was not a ref line`
            return null
          }
          const head: ReleasedHead =
            answered !== null && answered[1] === cause.headSha
              ? { at: cause.headSha, atRef: branch }
              : { cannot: `the saved head ${cause.headSha.slice(0, 7)} of ${branch} is no longer on origin` }
          const releasedEvents = yield* Effect.promise(() => store.read(releasedFrom.runId))
          const releasedState = reduceAttempt(releasedEvents)
          const spent = continuationSpentWithTriage(releasedState, reduced, releasedFrom.runId, releasedEvents)
          const ticketEvents = yield* Effect.promise(() => store.read(ticketId))
          const releases = releasesOf(ticketEvents, releasedFrom.runId, 'BaseRed')
          const accountReruns =
            releaseRerunsOf(ticketEvents, releasedFrom.runId) +
            personRerunsOf(waitsFromState(reduced), releasedFrom.runId)
          return {
            step: 'build' as Step,
            waive: [],
            grantRef: undefined,
            advice: undefined,
            declined: undefined,
            grant: undefined,
            findings: undefined,
            conflict: undefined,
            readClipped: undefined,
            roundLimit: undefined,
            onSha: 'at' in head ? head.at : '',
            // Its own dispatch ids: two continuations of one run for a red base must not share them.
            resumedWaitId: `base-red:${releases}` as WaitId,
            roundsSpent: spent.rounds,
            personRounds: spent.personRounds,
            baseMergesSpent: spent.baseMerges,
            conflictRoundsSpent: spent.conflictRounds,
            stepRedosSpent: spent.stepRedos,
            landingRetriesSpent: spent.landingRetries,
            diffBaseSha: diffBaseShaOf(releasedEvents),
            landedOnBase: landedOnBaseOf(releasedEvents),
            conflictResolved: conflictResolvedOf(releasedEvents),
            reviewedHead: reviewedHeadOf(releasedEvents),
            alreadyDone: alreadyDoneOf(releasedEvents),
            approval: approvalOf(
              waitsFromState(reduced),
              stepOutcomesOf(releasedEvents),
              releasedFrom.runId,
              undefined,
              false,
            ),
            baseRed: { toSha: baseRead.at, fromSha: cause.baseSha, action },
            released: {
              by: 'release' as const,
              runId: releasedFrom.runId,
              head,
              // No cut-off call is replayed: nothing was cut off.
              rerun: { for: null, prompt: null, accountReruns },
            },
          }
        }
        if (cause._tag !== 'AccountLimit' && cause._tag !== 'StepRedoPending') return null
        if (cause._tag === 'AccountLimit') {
          // The first claim after the lock lifts. A lock that stands again is a race with a fresh one: this
          // never becomes an ordinary claim from the base, which is the cost this continuation removes.
          const locked = yield* readAccount(store, cause.runtime).pipe(
            Effect.map((account) => account.limit !== null),
            Effect.orElseSucceed(() => true),
          )
          if (locked) {
            releasedDeclined = `the ${cause.runtime} account is still locked`
            return null
          }
        }
        const releasedEvents = yield* Effect.promise(() => store.read(releasedFrom.runId))
        const releasedState = reduceAttempt(releasedEvents)
        const head = releasedHeadOf(releasedEvents)
        const spent = continuationSpentWithTriage(releasedState, reduced, releasedFrom.runId, releasedEvents)
        // Each lift is one release naming this run, so this rerun's number among them is their count.
        const ticketReleases = yield* Effect.promise(() => store.read(ticketId))
        const releases = releasesOf(ticketReleases, releasedFrom.runId, cause._tag)
        // A redo the stop interrupted keeps the tail it was about to quote (#1398): what `StepRedone.said` recorded.
        const pendingRedo = cause._tag === 'StepRedoPending' ? pendingRedoOf(releasedEvents) : null
        // A person's rerun of this attempt is a rerun too: its dispatch id is its own (#1218). An account limit's
        // releases and a redo's are counted together, so no two reruns of one attempt share a dispatch id.
        const accountReruns =
          releaseRerunsOf(ticketReleases, releasedFrom.runId) +
          personRerunsOf(waitsFromState(reduced), releasedFrom.runId)
        const cutOff = cutOffPromptOf(releasedEvents)
        // The call the wall cut off is the release's own step: another step's last call is not it.
        const cutOffFor = cutOff !== null && cutOff.for.step === cause.step ? cutOff.for : null
        const recordedPrompt =
          cutOff?.prompt == null || cutOffFor === null || reduced.pendingPrompt !== null
            ? null
            : yield* recordedPromptOf(cutOff.prompt)
        return {
          step: cause.step,
          waive: [],
          // What only an approval's continuation carries; present as `undefined` so the two shapes are one.
          grantRef: undefined,
          advice: undefined,
          declined: undefined,
          grant: undefined,
          findings: undefined,
          conflict: undefined,
          readClipped: undefined,
          roundLimit: undefined,
          onSha: 'at' in head ? head.at : '',
          resumedWaitId: `${cause._tag === 'AccountLimit' ? 'account-limit' : 'redo-pending'}:${releases}` as WaitId,
          roundsSpent: spent.rounds,
          personRounds: spent.personRounds,
          baseMergesSpent: spent.baseMerges,
          conflictRoundsSpent: spent.conflictRounds,
          stepRedosSpent: spent.stepRedos,
          landingRetriesSpent: spent.landingRetries,
          diffBaseSha: diffBaseShaOf(releasedEvents),
          landedOnBase: landedOnBaseOf(releasedEvents),
          conflictResolved: conflictResolvedOf(releasedEvents),
          reviewedHead: reviewedHeadOf(releasedEvents),
          alreadyDone: alreadyDoneOf(releasedEvents),
          approval: approvalOf(
            waitsFromState(reduced),
            stepOutcomesOf(releasedEvents),
            releasedFrom.runId,
            undefined,
            false,
          ),
          released: {
            by: 'release' as const,
            runId: releasedFrom.runId,
            head,
            rerun:
              cutOffFor?._tag === 'Action'
                ? {
                    for: cutOffFor,
                    prompt: recordedPrompt,
                    accountReruns,
                    why:
                      cause._tag === 'AccountLimit'
                        ? "the account's limit cut it off"
                        : 'the conductor stopped while it waited to be redone',
                    startedAt: stepStartedAtOf(releasedEvents, cutOffFor.step) ?? undefined,
                    ...(pendingRedo === null ? {} : { unread: pendingRedo.said }),
                  }
                : { for: null, prompt: null, accountReruns },
          },
        }
      }
      if (reduced.lifecycle.status !== 'approved' || reduced.lifecycle.runId !== options.continuing.runId) return null
      const { waitId: approvedWaitId, onSha: approvedOnSha } = reduced.lifecycle
      const reason = waitsFromState(reduced).find((w) => w.waitId === approvedWaitId)?.reason
      if (reason === undefined) return null
      const runEvents = yield* Effect.promise(() => store.read(options.continuing!.runId))
      const runState = reduceAttempt(runEvents)
      /**
       * **A person's `RedoStep` continues the same attempt at the step that stopped, on the saved head** (#1218):
       * #1205's re-cut and recorded-prompt rerun, asked for by a wait's resolution rather than by a release. The
       * wait's own resolution says so — the lifecycle carries no new field — and `rerunStepOf` names the step, as it
       * named the offer. No grant, no criterion and no round: the counters are the attempt's own, unchanged.
       */
      const approvedWait = waitsFromState(reduced).find((w) => w.waitId === approvedWaitId)
      if (approvedWait?.resolution?._tag === 'RedoStep' || approvedWait?.resolution?._tag === 'AnswerQuestions') {
        // **An `AnswerQuestions` is a redo of the step that asked** (#1254, 0108 §12): the same re-cut on the saved head,
        // the same counters, no `stepRedos` spent — and no recorded prompt replayed, which would send the old body.
        const answering = approvedWait.resolution._tag === 'AnswerQuestions'
        const step = answering
          ? answerStepOf(reason, reduced.waits.find((w) => w.waitId === approvedWaitId)?.triage.result)
          : rerunStepOf(reason)
        if (step === null) return null
        const head = releasedHeadOf(runEvents)
        const spent = continuationSpentWithTriage(runState, reduced, options.continuing.runId, runEvents)
        const accountReruns =
          releaseRerunsOf(yield* Effect.promise(() => store.read(ticketId)), options.continuing.runId) +
          personRerunsOf(waitsFromState(reduced), options.continuing.runId)
        const cutOff = cutOffPromptOf(runEvents)
        // The call the stop cut off is the rerun step's own: another step's last call is not it.
        const cutOffFor = answering ? null : cutOff !== null && cutOff.for.step === step ? cutOff.for : null
        const recordedPrompt =
          cutOff?.prompt == null || cutOffFor === null ? null : yield* recordedPromptOf(cutOff.prompt)
        return {
          step,
          answered: answering
            ? {
                key: `${ticketId}/${approvedWaitId}`,
                accountReruns,
                // Measured from where the asking step began, not from the saved head: commits it made before asking count (#1254).
                startedAt: stepStartedAtOf(runEvents, step) ?? undefined,
              }
            : undefined,
          waive: waivedActionsAt(waitsFromState(reduced), stepOutcomesOf(runEvents), options.continuing.runId, step),
          grantRef: undefined,
          advice: undefined,
          declined: undefined,
          grant: undefined,
          findings: undefined,
          conflict: undefined,
          readClipped: undefined,
          roundLimit: undefined,
          onSha: 'at' in head ? head.at : approvedOnSha,
          resumedWaitId: approvedWaitId,
          roundsSpent: spent.rounds,
          personRounds: spent.personRounds,
          baseMergesSpent: spent.baseMerges,
          conflictRoundsSpent: spent.conflictRounds,
          stepRedosSpent: spent.stepRedos,
          landingRetriesSpent: spent.landingRetries,
          diffBaseSha: diffBaseShaOf(runEvents),
          landedOnBase: landedOnBaseOf(runEvents),
          conflictResolved: conflictResolvedOf(runEvents),
          reviewedHead: reviewedHeadOf(runEvents),
          alreadyDone: alreadyDoneOf(runEvents),
          approval: approvalOf(
            waitsFromState(reduced),
            stepOutcomesOf(runEvents),
            options.continuing.runId,
            approvedWaitId,
            false,
          ),
          released: {
            by: 'person' as const,
            runId: options.continuing.runId,
            head,
            rerun:
              cutOffFor?._tag === 'Action'
                ? {
                    for: cutOffFor,
                    prompt: recordedPrompt,
                    accountReruns,
                    why: 'a person asked to redo it',
                    startedAt: stepStartedAtOf(runEvents, cutOffFor.step) ?? undefined,
                  }
                : { for: null, prompt: null, accountReruns },
          },
        }
      }
      const granted = reduced.lifecycle.grantRef !== undefined
      // A crash that stands in for a wait carries that wait's advice (#654).
      const adviceWaitId = reason._tag === 'AgentCrashed' ? (reason.standing?.waitId ?? approvedWaitId) : approvedWaitId
      const byTriage = new Set(reduced.waits.filter((w) => w.resolution?.by === 'triage').map((w) => w.waitId))
      // Only a person's grants cap a lap here: a triage round (`byTriage` below) follows the recipe's `refusalFixes` (#1258).
      const priorGrant = waitsFromState(reduced).some(
        (wait) =>
          wait.resolution?._tag === 'FixRefusal' &&
          !byTriage.has(wait.waitId) &&
          'run' in wait.reason &&
          wait.reason.run.runId === options.continuing!.runId,
      )
      const spentNow = continuationSpentWithTriage(runState, reduced, options.continuing.runId, runEvents)
      const grantedBy = byTriage.has(approvedWaitId) ? 'triage' : 'person'
      // A conflict resolution triage made spends `conflictResolutions` alone: its implement visit re-opens the current
      // round, so `StepStarted` does not raise `implementRound` and no refusal fix is counted (#1258).
      // The wait's own reason says it too, so a `spent` a stale snapshot lost cannot turn a conflict into a refusal fix.
      const conflictByTriage =
        grantedBy === 'triage' &&
        (reduced.waits.find((w) => w.waitId === approvedWaitId)?.resolution?.spent?.bound === 'conflictResolutions' ||
          (reason._tag === 'ProposedEscalated' && reason.proposal._tag === 'MergeConflict'))
      const lapRound = continuationRound(runState, granted && !conflictByTriage)
      const criterion = granted ? grantCriterion(reason, standingRefusal(runState)) : null
      const next = granted ? { step: 'implement' as const } : continuationOf(reason, stepOutcomesOf(runEvents))
      if (next === null) return null
      return {
        step: next.step,
        /**
         * **Every waiver this item's approvals have granted at this step,
         * not only the one `approvedWaitId` is about** (#465's blocker
         * finding). A step whose list holds two actions that each stop the
         * pass — a `watch:` and a `human:`, say — can never be got past one
         * approval at a time: the first approval waives one action and the
         * other stops the pass again, and a continuation that remembered
         * only the wait it was itself answering let the first run again
         * unwaived on this very visit, which refused again the same way,
         * forever. `waivedActionsAt` (`@lingtai/domain/wait`) reduces over
         * every `Approve` this item has ever recorded for this run, so both
         * come back together.
         */
        waive: waivedActionsAt(waitsFromState(reduced), stepOutcomesOf(runEvents), options.continuing.runId, next.step),
        approval: approvalOf(
          waitsFromState(reduced),
          stepOutcomesOf(runEvents),
          options.continuing.runId,
          approvedWaitId,
          granted,
        ),
        onSha: approvedOnSha,
        // `Approve` on a `DiffTooLarge` wait (#892), keyed to the head it approved. Carried
        // forward from every such approval on this run at this head, as waivers are, so a
        // later approval on the same head (a signoff after the clipped review) does not
        // measure the unchanged diff again. A new head (a fix round) matches none.
        ...(waitsFromState(reduced).some(
          (w) =>
            w.resolution?._tag === 'Approve' &&
            w.resolution.onSha === approvedOnSha &&
            w.reason._tag === 'ProposedEscalated' &&
            w.reason.proposal._tag === 'DiffTooLarge' &&
            w.reason.run.runId === options.continuing!.runId &&
            w.reason.proposal.from === next.step,
        )
          ? {
              readClipped: {
                onSha: approvedOnSha,
                // A clipped review that already passed on this head is kept, never dispatched
                // again: its session id is deterministic and the runtime refuses a reused one.
                kept: stepOutcomesOf(runEvents)
                  .filter((o) => o.step === next.step)
                  .flatMap((o) =>
                    o.actions.flatMap((a) =>
                      a.yields === 'verdict' &&
                      a.onSha === approvedOnSha &&
                      a.result._tag === 'Completed' &&
                      a.result.assessment.verdict === 'accepted' &&
                      a.result.assessment.clipped !== undefined
                        ? [
                            {
                              name: a.name,
                              ...(a.result.assessment.summary === undefined
                                ? {}
                                : { summary: a.result.assessment.summary }),
                              findings: a.result.assessment.findings,
                              evidence: a.evidence,
                              clipped: a.result.assessment.clipped,
                            },
                          ]
                        : [],
                    ),
                  ),
              },
            }
          : {}),
        // The wait this continuation resumes: a fresh UUID per wait, so it is
        // what tells one continuation's judge from the next one's (#580).
        resumedWaitId: approvedWaitId,
        ...(granted ? { grantRef: reduced.lifecycle.grantRef } : {}),
        // Only a granted lap: it is one round long, so this reaches the round
        // the person paid for, on the advice of the wait they granted it on (#643).
        ...(granted && grantedAdviceFromState(reduced, adviceWaitId) !== undefined
          ? { advice: grantedAdviceFromState(reduced, adviceWaitId)! }
          : {}),
        roundsSpent: Math.max(lapRound, spentNow.rounds),
        personRounds: spentNow.personRounds,
        baseMergesSpent: spentNow.baseMerges,
        conflictRoundsSpent: spentNow.conflictRounds,
        stepRedosSpent: spentNow.stepRedos,
        landingRetriesSpent: spentNow.landingRetries,
        // An earlier person's grant does not cap a triage round: `byTriage` follows the recipe's `refusalFixes`.
        ...(priorGrant && grantedBy !== 'triage' ? { roundLimit: lapRound } : {}),
        ...(grantedBy === 'triage' ? { byTriage: true as const } : {}),
        ...(criterion !== null
          ? {
              grant: {
                why:
                  grantedBy === 'triage'
                    ? 'Triage granted one checked fix round.'
                    : 'A person granted one checked fix round.',
                asked: null,
                printed: criterion.printed,
              },
              findings: criterion.findings,
              ...(criterion.declined === undefined ? {} : { declined: criterion.declined }),
              // A conflict wait's proof, so the round starts in the merge (#1120).
              ...(criterion.conflict === undefined ? {} : { conflict: criterion.conflict }),
            }
          : {}),
        /**
         * **The base every "what changed" read has to diff against — never
         * `onSha` above, and never `RunStarted.baseSha` alone** (#465).
         * `onSha` is where this re-cut's worktree is checked out, which is
         * the run's own prior head; diffing against it reads as no change at
         * all until a new commit lands, so a `watch:` or a cold reviewer's
         * `diff` reached for the first time after the approval sees an empty
         * file list and clears a diff it never read.
         *
         * `diffBaseShaOf` (`./attempts.ts`) reads this off `admit`'s own
         * `StepEnded` rather than `RunStarted.baseSha`, which only
         * `firstDispatch` writes — a recipe whose `implement:` is a bare
         * `run:` action with no agent dispatch never reaches it, and the `!`
         * this replaced asserted a field only that dispatch fills.
         */
        diffBaseSha: diffBaseShaOf(runEvents),
        landedOnBase: landedOnBaseOf(runEvents),
        conflictResolved: conflictResolvedOf(runEvents),
        reviewedHead: reviewedHeadOf(runEvents),
        alreadyDone: alreadyDoneOf(runEvents),
      }
    })

    // **The same run, continued, never a fresh one — but only once
    // `continuation` says the request is still good** (#465, 0120 §6, `take`
    // below). A stale request — the item left `approved` before this pass
    // reached it — is an ordinary fresh claim and must get an ordinary fresh
    // id: adopting `options.continuing.runId` unconditionally here claimed a
    // brand-new pass onto the *approved* run's own stream, under `--no-merge`
    // or not depending on nothing this pass decided.
    const runId =
      continuation === null
        ? attemptStream(crypto.randomUUID())
        : (continuation.released?.runId ?? options.continuing!.runId)
    /**
     * **Where the pass works, known before it starts.**
     *
     * `provisionWorktree` cuts at exactly this path, so `context.cwd` is the
     * caller's for the whole pass — see this file's opening. Nothing reads it
     * before `admit` has cut there: `claim` and `admit` have no cell open, so
     * there is no plugin to run in a directory that does not exist yet.
     */
    const cwd = worktreePath(home, project, runId)

    const edit = reduced.pendingPrompt
    if (edit) log(`carrying a prompt edit from ${edit.by} (${edit.text.length} bytes)`)
    // **Not a new attempt — but only for a genuine continuation** (#465). A
    // continuation's own `TicketClaimed` is already on `before`, blocked by
    // the very wait it is continuing from, so `priorAttempts` would otherwise
    // count this run as the one before itself and hand it `attempt: 2`'s
    // brief for a run that is not attempt 2. `previous: undefined` decides
    // only that — no prior-attempt brief is fetched for a continuation, which
    // already has the context its own prompt was built with. **It says
    // nothing about the arm**: that is `armFor`, below, which reads the held
    // run's own attempt number off `priorAttempts(before)` directly rather
    // than assuming it agrees with `next.attempt` — because it does not: a
    // continuation's `next.attempt` is one higher (the re-claim is on the
    // stream too), and pushing there would force-push over the commits this
    // claim exists to keep, onto a ref the next genuine attempt would then
    // force-push over a second time. Guarded on `continuation !== null`, not
    // `options.continuing !== undefined`: a stale request is an ordinary
    // fresh claim, with its own prior attempts to carry into the prompt like
    // any other.
    const previous = continuation !== null ? undefined : priorAttemptsFromState(reduced, ticketId).at(-1)
    // Only the attempt's state is needed, so it is read through a snapshot; a failure is a defect, as it was
    // inside `Effect.promise`.
    const lastRun = previous
      ? yield* readThroughSnapshot(store, attemptReducer, previous.runId, 'all', ticketSnapshots).pipe(Effect.orDie)
      : null
    // Asked of `origin` and only for a requeued pass (#315): a first attempt has
    // no arm to name and makes no request, which keeps its prompt byte-identical.
    const arms = previous ? yield* armsOnOriginEffect(options.client, branch) : null
    if (previous && arms === null) {
      log(`could not list ${branch}'s arms on origin — the brief names none`)
    }
    const next = nextPrompt({
      base: basePromptVersion,
      budget: recipe.runtime.budget,
      item: { state: reduced, streamId: ticketId },
      lastRun,
      arms,
    })
    if (previous) {
      log(`attempt ${next.attempt}: ${previous.runId} ended — ${previous.ended ?? 'no ending recorded'}`)
    }
    const arm = armForState(reduced, ticketId, branch, continuation !== null ? runId : null, next.attempt)

    /**
     * **What the back edges may spend** (0061 §3, and 0040's two dimensions).
     *
     * `rounds` bounds depth and `restarts`/`newAttemptsSpent` bound breadth, and
     * the pass reads all three rather than asking anybody: `offerFor`
     * (`@lingtai/domain`) puts `implement` on the offer while rounds are left
     * and `claim` while restarts are, and offers neither once they are spent.
     * That is the whole of *the workflow counts, the judge chooses* — which
     * is why `decideFix` and `decideRestart` are no longer consulted here.
     * What each of them decided is now either the ceiling's arithmetic or the
     * judge's answer, and neither is a second opinion this file is entitled
     * to.
     */
    const ceilings: Ceilings = {
      refusalFixes: ceiling.attempt.refusalFixes,
      conflictResolutions: ceiling.attempt.conflictResolutions,
      newAttempts: ceiling.ticket.newAttempts,
      newAttemptsSpent: reduced.newAttempts.length,
      personAsksSpent: personAsksFromState(reduced),
    }

    let released = false
    /**
     * Set once a landing exists: records `TicketLanded` for merged work and answers
     * true when there was some. **`release` goes through it first** — merged work
     * is never given back with a `TicketReleased`, whatever ended the pass (#1056).
     */
    let recordMergedWork: (() => Effect.Effect<boolean>) | null = null
    /** Set when a landing exists and the store refused every try at recording it. */
    let unrecordedLanding = false
    /**
     * **The stream `end` resolves onto**, or null where this pass is about no item
     * (`#269`).
     *
     * Beside `took` in meaning and beside `released` in scope, and both placements
     * are load-bearing. It is not read off `took` because the two are not the same
     * question: a claim whose append *may* have committed gives the pass a stream
     * and no ticket, and `end` needs only the first of those. And it is **out here
     * rather than inside the scope, because `release` is out here too** —
     * `endResolved` is here for that reason and this is the same one: *did this run
     * ever hold the item* is what the release is gated on, and a local of the scope
     * is a question the release cannot ask.
     */
    let onStream: string | null = null
    /**
     * What `end` resolved, so the issue is told what the item recorded.
     *
     * **Out here rather than inside the scope, because `release` is out here
     * too.** `recordEnd` sets it; all three endings read it. It used to be a
     * local of the scope below, which `release` cannot see — so the `failed` and
     * restart endings passed `labels` to `tellGitHubAbout` and no `appended`,
     * and `tellGitHubAbout` carries out an `EndActionsResolved` **only** from
     * `appended` (`tell.ts`). A recipe's `end: [{ when: failed, close: true }]`
     * was therefore resolved onto the log and never carried out: no
     * `closeIssue`, no `IssueUpdateFailed` for `converge.ts` to retry, and
     * `resolveEndActions`'s once-per-outcome rule makes every later pass resolve
     * nothing — so `endedWithoutEndActions` finds the row and reports nothing
     * wrong. The landed and blocked endings always passed it; this is the path
     * that dropped it.
     *
     * **What actually reached the stream, never what was going to.** Each ending
     * sets it after its own append has returned — see `endPlan`.
     */
    let endResolved: readonly ToAppend[] = []
    /**
     * **What `end` resolved, held until the append that makes its outcome true.**
     *
     * `recordEnd` sets this and appends nothing, which is `AttemptPorts.recordEnd`
     * read the way it states itself — *batching is the caller's because the
     * ending is the caller's*. It used to append on the spot, and that put the
     * resolution on the item's stream **before** the `TicketLanded` or
     * `WaitStarted` it is about: the exact split `resolveEndActions` says is
     * impossible — *one transaction, so the outcome and its resolution cannot
     * come apart* (`end-step.ts`).
     *
     * The window was not theoretical and it was the expensive kind. A dropped
     * connection on the next append — the disconnect CLAUDE.md documents against
     * `#157` — left `EndActionsResolved{landed}` over a commit that is on the
     * base branch with no landing recorded: `reduceTicket` reads `backlog`,
     * the issue is relabelled `lingtai:queued`, the next queue pass buys a whole
     * agent to re-implement merged work, and because the point resolves **once
     * per outcome** the real landing can never resolve it again —
     * `endedWithoutEndActions` finds the matching row and reports nothing wrong.
     * The same window on the blocked ending recorded a `when: blocked` action as
     * carried out for a block that was never recorded.
     *
     * So it is held here and appended *by* the ending, in one transaction with
     * it: `land`, `hold` and a failed ending's `release` each carry the plan.
     */
    let endPlan: readonly ToAppend[] = []
    /**
     * Which of the four endings the pass reached, or null while it is walking.
     *
     * Read by `release`, for the rule above: a plan may only be appended beside
     * the event that makes its outcome true, and a release makes `failed` true
     * and nothing else. So a `landed` plan whose own append died must not be
     * carried in on the release that follows it — that is the orphan row again,
     * arriving by the defect handler instead of by the window.
     */
    let endedAs: TerminalOutcome | null = null
    /**
     * How a run that did not land gives the item back.
     *
     * **One way, and `#143` is what made it one.** The item returns to the queue
     * and the backoff decides when it is seen again. The `end` step has already
     * *resolved* its declared effects by the time this runs — the pass ran it, on
     * every ending — so nothing here resolves them again; what is left is
     * recording that resolution and carrying it out.
     *
     * **The release goes first, and this is the one ending where the two are two
     * appends.** `releaseTicket` owns its own read and version, which is
     * `appendEndActions`'s *the one caller that cannot batch* arriving from the
     * other side. The direction is what stands in for the transaction: losing the
     * second append leaves effects unrecorded, where losing the first would leave
     * them recorded for an ending the log does not carry (`endPlan`).
     *
     * **So the first append's failure is read, and that is the whole of what
     * makes the direction mean anything.** It is not raised — the reasons below
     * stand — but a release that never reached the log must not be followed by
     * the row that says what that release resolved: `.catch(() => {})` on its
     * own made the two indistinguishable, and `EndActionsResolved{failed}` went
     * on next regardless. That is the orphan this ordering exists to prevent,
     * arriving by the tolerant catch rather than by the window, and it costs
     * exactly what the window costs — the point resolves once per outcome, so
     * the pass that does release the item can never resolve `failed` again, and
     * `endedWithoutEndActions` finds the row and reports nothing wrong.
     *
     * **And only a plan about `failed`**, because that is the outcome a release
     * makes true. A `landed` or `blocked` plan reaching here means that ending's
     * own append died, and appending it would be the orphan row this ordering
     * exists to prevent. **Not `claim-unconfirmed`**, since `#463`: that decline
     * calls `release` straight from `conduct.ts`'s early return on the claim,
     * before `end` has run at all, so `endPlan` is still `[]` and `endedAs` still
     * `null` there. Neither a landed nor a blocked plan is recorded, so a later
     * pass resolves whichever ending it actually reaches.
     */
    const release = (reason: string, cause: ReleaseCause | null = null): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (released) return Effect.void
        const recording = onStream === null ? null : (recordMergedWork?.() ?? null)
        if (recording !== null) {
          return recording.pipe(
            Effect.flatMap((merged) =>
              // Merged work is never released, whatever the reason and whether or not
              // the record landed: a landing that exists but is unrecorded stays put.
              merged || unrecordedLanding ? Effect.void : releaseUnmerged(reason, cause),
            ),
          )
        }
        return releaseUnmerged(reason, cause)
      })
    const releaseUnmerged = (reason: string, cause: ReleaseCause | null): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (released) return Effect.void
        /**
         * **A run that took nothing releases nothing** (`#269`).
         *
         * `releaseTicket` appends whoever holds it (`ticket/commands.ts`), so a release
         * from a run that never claimed writes `TicketReleased` over **another
         * conductor's live item** and `lingtai:queued` over its `lingtai:working`
         * while its agent is still working. The `claim` branch at the bottom
         * guards the declines the pass *reports*; what reaches the defect handler
         * with `released` still false is a throw from before the claim, and
         * `claim`'s own step has appended to the run's stream since its work
         * became a `queue:` action — `emit`'s `StepRequested` for the take, which
         * a dropped connection turns into exactly that defect.
         *
         * `onStream` and not `took`, because the one decline that may be holding
         * the item has a stream and no ticket: `claim-unconfirmed` must still give
         * back something this run may hold, which is the whole reason `Taken` had
         * a fourth case.
         */
        if (onStream === null) {
          log(`nothing to release: ${reason}`)
          released = true
          return Effect.void
        }
        released = true
        // **The whole of it, or none of it.** It was one promise that ran to the end
        // when the fiber was interrupted; as steps an interrupt between
        // `TicketReleased` and the end actions would leave the item back in the queue,
        // its end actions unrecorded and GitHub still saying `working` — and `released`
        // is already set, so nothing would run it again.
        return Effect.uninterruptible(
          Effect.gen(function* () {
            // The plan rides in the release's own append: both are written or neither.
            const withPlan = endedAs === 'failed' && endPlan.length > 0
            const gave = yield* Effect.result(
              releaseTicketEffect(ticketId, runId, reason, store, cause, {
                ...ticketSnapshots,
                ...(withPlan ? { endPlan } : {}),
              }),
            )
            if (Result.isFailure(gave)) {
              // Said rather than raised: the run has already ended, and a throw here
              // would replace the reason it ended with the reason the bookkeeping did.
              log(`the item was not released: ${whyOf(gave.failure)}`)
            } else if (withPlan && gave.success.ok) {
              endResolved = endPlan
            }
            yield* tellGitHubAboutEffect({
              store,
              github: options.client,
              ticketId,
              ...ticketSnapshots,
              labels: labelsFor('queued'),
              editEnded: true,
              appended: endResolved,
            })
          }),
        ).pipe(
          // A release is the last thing a failing run does, and one that threw
          // would replace the reason the run ended with the reason the cleanup did.
          // Outside the uninterruptible region, so a defect still stops the body.
          Effect.catchCause(() => Effect.void),
        )
      })

    /**
     * The account stops, because the item backing off is the wrong instrument
     * (0031 §3): the attempt that met the wall appends `AccountLimitReached` to
     * `acct-{runtime}` where it learned of it (0126 §2), and nothing to
     * `ctl-conductor`. Projects whose recipe uses `runtime` start nothing new
     * until the guard lifts it at `until`; every other project keeps taking work.
     *
     * **Once, not once per item.** A limit already standing answers `already` and
     * appends nothing, so the first `until` stands. A failed append is logged and
     * swallowed: it must not replace the reason the run ended. **It answers whether the account is locked
     * now** (`true` on `appended` and on `already`), so a release that waits on the lock (#1205) is made
     * only behind one that stands.
     */
    const standDownAccount = (
      what: StandDownWhat,
      runtime: RuntimeId,
      detail: string,
    ): Effect.Effect<{ locked: boolean; limit: NamedLimit | null; now: Date; untilFrom: string; said: string }> =>
      Effect.gen(function* () {
        const it =
          what.of === 'run'
            ? 'a run'
            : what.of === 'step' || what.of === 'draft' || what.of === 'mid-run'
              ? `the ${what.step} step's agent`
              : `the fixing agent for ${what.action}`
        const now = new Date()
        const { until, untilFrom, said, reason, limit } = standDown({
          detail,
          what,
          runtime,
          now,
          backoffMs: parseDuration(backoffOf(recipe)),
        })
        const answer = yield* reachAccountLimit(store, runtime, {
          until: until.toISOString(),
          untilFrom,
          said,
          limit,
        })
        const met = what.of === 'mid-run' ? 'met the account limit' : 'never started'
        if (answer.kind === 'appended') {
          log(`${it} ${met} — ${runtime} locked until ${until.toISOString()}: ${reason}`)
        } else {
          log(`${it} ${met}; ${runtime} is already locked until ${answer.until.toISOString()}`)
        }
        // Locked now, by this append or an earlier one: what a release that waits on the lock may rely on (#1205).
        return { locked: true, limit, now, untilFrom, said }
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            log(`could not lock the ${runtime} account: ${error.message}`)
            return { locked: false, limit: null, now: new Date(), untilFrom: 'backoff', said: '' }
          }),
        ),
      )

    /**
     * The outermost scope, and it is the log's (0034 §4).
     *
     * It is wider than the socket's and the agent's because what closes it has to
     * know something neither of them does: **whether the run landed**. It is
     * wider than the worktree's too, and only just — since 0039 §1 the worktree
     * lives as long as the pass, so the two release in order, worktree then log,
     * without anybody arranging it.
     */
    const claimed = Effect.gen(function* () {
      /**
       * Whether this run's diff reached the base branch. Set in exactly one
       * place, beside the `TicketLanded` append, which is the only sentence
       * here that means it.
       */
      let didLand = false
      /** Whether a WIP row is still owed after the last `noteAllKept`: a failed append, an unresolved sha or an unreadable ancestry. */
      let keptOwed = false
      /**
       * The merge commit the lane produced, for the caller's `ok: true`.
       *
       * Read through `landedAt()` and not off the variable: `land` is a port and
       * the compiler cannot see that it ran, so narrowing the `let` at the read
       * would make it `never`.
       */
      let mergeCommit: string | null = null
      const landedAt = (): string | null => mergeCommit
      /** The tree, once `admit`'s `worktree:` action has cut it. */
      let worktree: Worktree | null = null
      /**
       * That tree, for the step that briefs an agent on it — or a throw naming
       * what did not run.
       *
       * **It is this file's fact rather than the pass's since `#268`.** The cut
       * is the `worktree:` plugin's now (0065 §2), `cut` below is the dep it
       * runs, and this closure is what that dep fills — so `Brief` no longer
       * carries a copy of a path only the conductor can have made. `implement`
       * is reached only after `admit` passed and `admit` passes only on a cut,
       * so null here is the pass's own bookkeeping gone wrong and not something
       * that happened to a diff: `runStep` catches the throw and reports the
       * visit as its own `did-not-finish`, which is what `madeBy` in
       * `attempt-steps.ts` does for the two facts that still travel in its closure.
       */
      const cutTree = (): Worktree => {
        if (worktree === null) {
          throw new Error(
            "the `implement` step has no worktree — `admit`'s `worktree:` action did not cut one, " +
              "and the spine says it did. This is the attempt's own bookkeeping and not a judgement " +
              'about the change.',
          )
        }
        return worktree
      }
      /** The item, once `claim`'s `queue:` action has taken it. */
      let took: Claimed | null = null
      /** What this pass's claim read of a split's children, for the return brief (#1263). */
      let splitRead: readonly SplitChildBrief[] | null = null
      /** What this pass has spent, for the summary a person is shown (#766). */
      const spent = { usd: 0, unknown: 0 }
      /**
       * The settings file every declared `agent:` runs under, once `admit`'s port
       * has written it.
       *
       * Empty until then, and nothing reads it until then — **and since `#265` the
       * earliest reader is one step later rather than three.** `agentPlugin.at`
       * opens at `design`, `review`, `proposed` and `merge`, and `design` is the
       * step straight after `admit`: a drafting agent declared there is dispatched
       * with this path, so the write cannot move any later than `cut` without
       * leaving it `""`. Named for the reviewer because that is the action it was
       * written for and still the only one that reads a diff; what it *is* is one
       * unhooked settings file per pass. See `cut` for why it is written there
       * rather than above the pass.
       */
      let reviewSettingsPath = ''
      let reviewDecision: SandboxDecision | undefined
      /**
       * **How many judgements this pass has bought**, and it is in the session id
       * (`#277`).
       *
       * A runtime's session id has to differ per dispatch, and the direction is
       * not enough to make it: one pass reaches `proposed` with a `findings`
       * every round it buys, so `<runId>:judge:findings` would be the same string
       * twice. Claude Code refuses a session id it has already been given —
       * *Session ID … is already in use* — which is `#195` exactly: one second,
       * no receipt, the round spent, the question never read. **The crash was the
       * lucky outcome there**; a runtime that resumed instead would answer the
       * second arrival with the first one's context, which is a judge asked
       * whether it still agrees with itself.
       *
       * A count rather than the head `sessionIdFor` keys on: a judge is asked at
       * arrivals that may share a commit — a `needs-input` and the `findings`
       * after it — so the commit is not the thing that differs, and the number of
       * times this pass has paid for a judgement is.
       *
       * **Within one `conduct` call only** (#580): a continuation of the same run
       * starts it at zero again, so its first judgement would repeat the
       * previous continuation's. The id also carries the wait the continuation
       * resumes (`continuation.resumedWaitId`, `'start'` for a fresh claim),
       * which differs between continuations by construction.
       */
      let judgements = 0
      /**
       * **Why the agent stopped mid-run, where it did — and null everywhere
       * else** (`#468`).
       *
       * Set by the dispatch's own stop, not by whatever the pass eventually
       * ends with: `publishWhatIsCommitted` runs on every ending that did not
       * land, including a red build or a hold at `proposed`, and a dirty tree
       * on those endings is not an agent's unfinished work — it is this
       * process's own worktree sitting beside a step that refused on purpose.
       * So this is `null` on every ending but the one where an agent was
       * running when the pass stopped: `out-of-turns`, `out-of-usd`, a crash,
       * a timeout, `no-commits`, or `'interrupted'` while a dispatch is still
       * in flight (cleared the moment it returns with a commit).
       *
       * **Never set at `never-started`.** That agent touched nothing, so
       * there is nothing in the worktree it could have left dirty.
       */
      let stoppedBy: string | null = null
      /**
       * Conflict fix rounds dispatched so far (#653). A conflict round leaves
       * `round` where `rounds` was, so `round` alone would hand Claude Code the
       * previous fix's session id, which it refuses. Within one `conduct` call
       * only: a continuation keeps `runId` and `round` and restarts this at zero,
       * so the id also carries the wait it resumes, as the judge's does.
       */
      let conflictFixes = 0
      /**
       * **Which agent met the account-wide wall, where `implement` reports one.**
       *
       * The pass has one `implement` step and this file dispatches two different
       * agents at it — the implementer on the way through, and the agent a round
       * bought on the way back — and `StepNeverRan` carries the runtime's id, not
       * which of the two it was (its `at` is the action's name). Left unrecorded, a fix round that met the wall
       * was reported to `standDown` as `{of: "run"}`, whose sentence is *a run
       * ended without ever starting — no turns taken, nothing spent*: written
       * into the log line, about a pass whose implementer ran, took its turns
       * and was paid. That is the false sentence `#133` is against and `0041` §3
       * gave `NeverStarted` a third case for — `{of: "fix"}`, which nothing
       * constructed.
       *
       * Null until a round's agent is the one refused, so the first dispatch's
       * wall is still `{of: "run"}` and says so.
       */
      let fixWall: { action: string; round: number } | null = null
      /**
       * Read through a call and not off the variable, for `landedAt`'s reason:
       * `fixRound` is a port and the compiler cannot see that it ran, so
       * narrowing the `let` at the read below would make it `never`.
       */
      const wallMetBy = (): { action: string; round: number } | null => fixWall

      /**
       * The run's log, and the keep-or-delete that ends it.
       *
       * **Landed → delete. Did not land → keep.** The diff is on the branch and
       * the events are on the log, so what an agent was thinking during a run
       * that worked has the least marginal value of anything here. A log that
       * could not be opened is `NO_RUN_LOG` rather than a refusal: the
       * observability of a run is not worth failing it for.
       *
       * **And it is opened by the claim, not before it** — which is 0034 §4's
       * *what is kept is exactly the investigable set* read as a rule about when
       * the file is created rather than only about its fate. Under the old engine
       * discovery and the claim both ran above the scope that opened this, so a
       * candidate that was never taken left nothing behind. Since `#256` the
       * claim is the pass's first step, and an eager open put a file on disk for
       * every `passed-over` and every lost race — kept, because `didLand` is
       * false, with a closing line calling itself *the only account of why* a run
       * that never started did not land. One pair per pass, for ever, and the
       * rule 0034 rests on to need no sweeper is exactly that nothing
       * uninvestigable is written.
       *
       * So the handle is deferred and `runLog` is what everything holds — and
       * **a note written before the open is held rather than dropped** (`#269`).
       * There used to be none, which is what this said; since the take is a
       * `queue:` action, `runActionPipeline` writes its `started` line before
       * calling it (`action.ts`) and the open happens *inside* the call, on the
       * line the claim commits. Dropping it left every log opening with a
       * `claim:… passed` whose `started` was nowhere — an action end that never
       * began, to somebody following `lingtai attach <runId>` from the beginning,
       * which is how that command is always read (0034).
       *
       * Held and not eagerly opened, because the file is the thing 0034 is about:
       * a pass that is passed over or loses the race still writes nothing at all,
       * and what it buffered goes with the closure.
       */
      let opened: RunLog | null = null
      /** Notes taken before there was a file, in the order they were written. */
      let beforeTheOpen: { label: string; detail: string | undefined }[] = []
      const runLog: RunLog = {
        get path() {
          return opened?.path ?? ''
        },
        note: (label, detail) => {
          if (opened === null) beforeTheOpen.push({ label, detail })
          else opened.note(label, detail)
        },
        // The inner log's own close Effect, handed on lazily: it runs only when this Effect does.
        close: (fate) => Effect.suspend(() => opened?.close(fate) ?? Effect.void),
      }
      noteOnRunLog = runLog.note
      /** Called by `claim`'s `queue:` action, and only once it holds the item. */
      const openTheRunLog: Effect.Effect<void> = Effect.gen(function* () {
        opened = yield* host.runLog({ path: runLogPath(home, project, runId) }).pipe(
          Effect.catch((err) =>
            Effect.sync(() => {
              log(`no run log: ${err.detail}`)
              return NO_RUN_LOG satisfies RunLog
            }),
          ),
        )
        // The sentence that says which run this is, first — then what was written
        // while there was nowhere to write it, in the order it was written.
        runLog.note('run', `${runId} · ${ticketId} · ${branch} → ${attemptBase()}`)
        const held = beforeTheOpen
        beforeTheOpen = []
        for (const { label, detail } of held) runLog.note(label, detail)
      })
      /**
       * Released last, because it is registered first — the same ordering the
       * `acquireRelease` this replaces gave, and for the same reason: the fate
       * turns on `didLand`, which is only a fact once the worktree's finalizer
       * and the publish's have run. A log that was never opened has nothing to
       * close and nothing to say.
       */
      yield* Effect.addFinalizer(() =>
        Effect.suspend(() => {
          if (opened === null) return Effect.void
          // The sentence, and the label a reader recognises it by: `#110`
          // follows this from another process and has nothing else to tell *the
          // writer has finished* from *the writer is thinking*.
          const finished = didLand && !keptOwed
          runLog.note(RUN_LOG_END, runLogEnd(finished))
          return runLog.close(finished ? 'delete' : 'keep')
        }),
      )

      /**
       * **The worktree's release, and it is unconditional** (0039 §1).
       *
       * `admit`'s port cuts it, which is inside the pass and therefore inside a
       * plain promise that cannot hold a scope — so the release is here, in the
       * run's own scope, acquired after the log and released before it.
       * `repo.remove` has no error channel and tolerates a path nothing cut, so
       * there is nothing to branch on: a pass that never reached `admit` releases
       * a worktree that was never there, which is a no-op and is cheaper than a
       * flag somebody has to keep true.
       */
      yield* Effect.addFinalizer(() => repo.remove({ project, runId, home }))

      /** A git command in the worktree, which is where all of them run. */
      const gitHere = (args: string[]) => repo.git(args, { token: options.token, env: options.gitEnv, cwd })
      /** …as an Effect: a failure here is a defect, not a verdict. */
      const gitOrDieEffect = (args: string[]) => Effect.orDie(gitHere(args))
      /**
       * `retry` is the waits for a command that may not reach origin (#1029): the same single
       * run, with `retryUnreachable` inside it.
       */
      const gitAskedEffect = (
        args: string[],
        retry?: readonly Duration.Input[],
        recover?: (err: RepoFailed) => Effect.Effect<string, RepoFailed>,
      ) => {
        // `recover` runs inside each try, so what it reads is retried with the command.
        const once = recover
          ? Effect.gen(function* () {
              const r = yield* Effect.result(gitHere(args))
              return Result.isSuccess(r) ? r.success : yield* recover(r.failure)
            })
          : gitHere(args)
        return Effect.result(retry ? retryUnreachable(once, retry) : once)
      }
      /**
       * …for a command that writes the mirror's refs or worktree metadata,
       * which a worktree shares with it: one at a time per mirror, for that
       * command only (0122 §6, #1026). The fetches in this file are
       * `fetch origin refs/heads/<base>` with no destination, so they write
       * the worktree's own `FETCH_HEAD` and objects and are not held.
       */
      const gitAskedMirror = (args: string[]) => mirrorWrite(mirrorPathFor(project, home), gitAskedEffect(args))

      /**
       * `git diff <DIFF_FLAGS> from...HEAD`, the one spelling the reviewer, the
       * fixer and the prompt resolver share (#927). Both ends are resolved to full
       * shas **first** and the diff is run between those two, so the text and a
       * reference to it describe the same pair even if `HEAD` moves; where either
       * cannot be resolved the diff still runs as it always did and carries no shas,
       * so its prompt writes it out.
       */
      const diffBetween = (from: string): Effect.Effect<DiffRead> => {
        const shaOf = (rev: string): Effect.Effect<string | null> =>
          Effect.map(gitAskedEffect(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]), (got) =>
            Result.isFailure(got) ? null : got.success.trim() || null,
          )
        return Effect.gen(function* () {
          const [a, b] = yield* Effect.all([shaOf(from), shaOf('HEAD')], { concurrency: 2 })
          if (a !== null && b !== null) {
            const text = yield* gitOrDieEffect(['diff', ...DIFF_FLAGS, `${a}...${b}`])
            return { text, from: a, to: b }
          }
          const text = yield* gitOrDieEffect(['diff', ...DIFF_FLAGS, `${from}...HEAD`])
          return { text, from: null, to: null }
        })
      }

      /**
       * What the head changed against the merge the base would have made of
       * `reviewed` alone (#1274): `git merge-tree --write-tree reviewed base` writes
       * loose objects and moves no ref, so it needs no mirror lock. Two dots, since a
       * tree has no merge base. Any failure is a defect the review reads as a full review.
       */
      const diffSinceMerge = (reviewed: string, base: string): Effect.Effect<DiffRead> =>
        Effect.gen(function* () {
          const version = yield* Effect.orDie(gitHere(['--version']))
          const m = /git version (\d+)\.(\d+)/.exec(version)
          if (!m || Number(m[1]) < 2 || (Number(m[1]) === 2 && Number(m[2]) < 38))
            return yield* Effect.die(new Error(`git merge-tree --write-tree needs git 2.38; found ${version}`))
          // Exit 1 is a conflict, and the tree with its markers is still written to stdout.
          const out = yield* gitHere(['merge-tree', '--write-tree', reviewed, base]).pipe(
            Effect.catchTag('RepoFailed', (err) =>
              err.exitCode === 1 && typeof err.stdout === 'string' ? Effect.succeed(err.stdout) : Effect.fail(err),
            ),
            Effect.orDie,
          )
          const tree = out.split('\n')[0]?.trim() ?? ''
          if (!/^[0-9a-f]{40,64}$/.test(tree)) return yield* Effect.die(new Error('git merge-tree returned no tree'))
          const head = (yield* gitOrDieEffect(['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
          const text = yield* gitOrDieEffect(['diff', ...DIFF_FLAGS, tree, head])
          return { text, from: reviewed, to: head }
        })

      /**
       * **Never `worktree.baseSha` on its own, once there is a continuation**
       * (#465) — `worktree.baseSha` is where this re-cut's tree was checked
       * out, the run's own prior head, and diffing against it is diffing a
       * commit against itself until a new one lands. `continuation.diffBaseSha`
       * is this run's real cut, read off its own `RunStarted` — see its own
       * comment, above, for why it is never missing by the time there is a
       * `continuation` to ask.
       */
      const baseShaOr = (fallback: string) => continuation?.diffBaseSha ?? worktree?.baseSha ?? fallback

      /**
       * Both ends default to what every existing caller already meant —
       * `baseShaOr('HEAD')..HEAD` — so passing neither changes nothing. `to` is
       * widened for `recordDiff`, below, which may be asked about a `branch`
       * whose head is not `HEAD` once a WIP commit has moved it on
       * (`keepUncommittedWork`, `#468`).
       */
      const changeStart = (fallback: string = baseShaOr('HEAD')) =>
        ownChangeStart({ git: gitAskedEffect, note: (l) => runLog.note('base', l), base: attemptBase(), fallback })

      const numstat = (from?: string, to = 'HEAD') =>
        Effect.gen(function* () {
          from ??= yield* changeStart()
          const stat = yield* gitOrDieEffect(['diff', '--numstat', `${from}..${to}`]).pipe(
            Effect.catchDefect(() => Effect.succeed('')),
          )
          const rows = stat
            .split('\n')
            .filter(Boolean)
            .map((l) => l.split('\t'))
          return {
            files: rows.length,
            insertions: rows.reduce((n, r) => n + (Number(r[0]) || 0), 0),
            deletions: rows.reduce((n, r) => n + (Number(r[1]) || 0), 0),
          }
        })

      /**
       * What origin last had for this branch, as far as this pass knows. Starts
       * as what it had when the worktree was cut and moves to whatever this pass
       * pushed: a lease that does not move is a lease this pass breaks itself on
       * its second round.
       */
      let lease: string | null = null
      /** The head this pass has already published, so nothing pushes it twice. */
      let published: string | null = null
      /**
       * The head **`arm` itself is on origin at**, or null while it is on none.
       *
       * Apart from `published`, because the two refs do not always go together
       * and both directions happen: `arm-only` is origin taking the forced arm
       * and rejecting the leased `agent/<n>`, which leaves `published` where it
       * was and the arm up; `land` is the other way round — it pushes the
       * branch alone, so a merge the lane then refuses leaves `published` at
       * this head with no arm anywhere, which is what the end-of-pass publish
       * asks about before it decides it has nothing to do.
       *
       * It exists because `attempts.ts`'s `armOf` derives the abandoned arm's
       * ref name live, against what origin actually has, and nothing else
       * here could say whether a push claimed by a restart actually landed.
       * `attempts.ts` tells the next agent to `git fetch origin <arm>`, and
       * appending `TicketReleased{cause: Restart}` consumes one of
       * `ceilings.restartsLeft` — so a restart recorded over a publish that was
       * refused spends a restart, points the next attempt at a ref that has
       * never existed, and loses the commits with the worktree. The old engine
       * pushed strictly *before* the append for exactly this reason: *a push
       * that is refused must leave no arm on the log.*
       */
      let armPublished: string | null = null
      /**
       * **Where a refused push's commits are, while the worktree still has
       * them** (`#421`). `null` until a `refused` ending keeps a head in the
       * mirror, or an `arm-only` ending points at the arm instead — and back
       * to `null` once the commits reach origin, so the mirror never holds a
       * ref for work that is already there.
       */
      let kept: KeptAt | null = null
      /** `refs/lingtai/unpushed/<n>/<runId>` — the mirror ref a refused push's head is kept at. */
      const keptRef = `refs/lingtai/unpushed/${options.issue}/${runId}`
      /**
       * Writes `head` to `keptRef` in the mirror — `gitAskedEffect` runs in the
       * worktree, which shares the mirror's refs (`worktree.ts:187`) — and
       * records it as `kept`. Never throws (`noteRefs`' own reason, below):
       * the publish has to finish whether or not the ref lands.
       */
      const keepHead = (head: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const wrote = yield* gitAskedMirror(['update-ref', keptRef, head])
          if (Result.isFailure(wrote)) {
            runLog.note('push', `${head.slice(0, 7)} was not kept at ${keptRef} — ${wrote.failure.detail}`)
            return
          }
          kept = { _tag: 'Mirror', ref: keptRef, sha: head, arm: `refs/heads/${arm}` }
        })
      /** Deletes `keptRef`, where the commits it pointed at reached origin another way. */
      const dropKept = (): Effect.Effect<void> =>
        Effect.gen(function* () {
          const dropped = yield* gitAskedMirror(['update-ref', '-d', keptRef])
          if (Result.isFailure(dropped)) {
            runLog.note('push', `${keptRef} was not dropped — ${dropped.failure.detail}`)
          }
          kept = null
        })
      /**
       * **The dirty trees a stopped agent left, each kept as its own commit** (`#468`, `#1243`).
       *
       * One entry per abnormal end of an `implement` dispatch that left a dirty
       * tree: `keepUncommittedWork` runs at the end of the dispatch itself and
       * again in `publishWhatIsCommitted`, and a clean tree is what stops the
       * second call. A list and not one slot, because a rerun in the same claim
       * (`#1201`) can stop a second time. `parent` is `HEAD` before the commit;
       * `sha` is the commit, `null` from the moment `git commit` succeeds until a
       * read of it does — the commit's existence is recorded before its sha is
       * read, since the read is a second git call that can fail on its own.
       */
      const wips: Array<{ parent: string; stoppedBy: string; sha: string | null }> = []
      /**
       * Where `wips` stood when the step's agent was first dispatched (#1245): a step redone whole is told
       * the WIP made since, and only that. Set by every first dispatch, never by a redo of it.
       */
      /** Where each implementer first found the tree, by arrival and action name (#1245). */
      const agentStarts = new Map<string, string>()
      let stepFirst: { onSha: string; sha: string; wipFrom: number } | null = null
      /** Whether this arrival at the step (its `onSha`) already has its first start recorded (#1245). */
      const firstStartOf = (context: ActionContext): { onSha: string; sha: string; wipFrom: number } | null =>
        stepFirst !== null && stepFirst.onSha === context.onSha ? stepFirst : null
      /** The paragraph a redone step's agent ends its brief with, or null on a first dispatch (0108 §12). */
      const redoNoteOf = (context: ActionContext, startedAt: string): Effect.Effect<string | null> =>
        Effect.gen(function* () {
          const first = firstStartOf(context)
          if (context.redo === undefined) {
            // Only the step's first agent arrival records it: a later agent, at the same head, must not
            // move where the step began nor which WIP is its own.
            if (first === null) stepFirst = { onSha: context.onSha, sha: startedAt, wipFrom: wips.length }
            return null
          }
          // A WIP whose own sha read failed is resolved before it is named: it was committed all the same.
          yield* resolveWipShas()
          return redoParagraph(
            { ...context.redo, startedAt: first?.sha ?? startedAt },
            wips.slice(first?.wipFrom ?? 0).flatMap((entry) => (entry.sha === null ? [] : [entry.sha])),
          )
        })
      /** The worktree's `HEAD` as `publishWhatIsCommitted` last read it — what `standingFor` compares to the granted sha (#654). */
      let headNow: string | null = null
      /** Whether the dispatch that ran last was a conflict round, which keeps nothing (0108 §20). */
      let inConflictRound = false
      /**
       * **Why a keep was attempted and left nothing, when it was** (`#468`).
       * `null` on the two outcomes that need no account — a clean tree, and a
       * keep that succeeded — so this is only ever read where a dirty tree's
       * fate would otherwise go unrecorded anywhere durable: reduced into
       * `RunRefsPublished.detail` by `withWipFailure`, below, never left to the
       * run log alone (0034 §8: a trace, never a record).
       */
      let wipFailure: string | null = null
      /**
       * What the run's own stream has already been told this claim produced, as
       * `<ref>@<head>`. A key and not a flag, because `arm-only` corrects an
       * answer an earlier call has already given (`#251`).
       */
      let recordedDiff: string | null = null
      const producedKey = (ref: string, head: string) => `${ref}@${head}`

      /**
       * **The account of the publish, on the log rather than only in the file**
       * (`#251`). `#250` met the wall with two commits in its worktree, left
       * neither ref on origin, and was collected — $26.84 recovered from
       * unreachable git objects by luck, because four different things wrote the
       * same nothing.
       *
       * **The account never costs the thing it is an account of**: a store that
       * will not take this row is swallowed, because raising it would abort the
       * `RunProducedDiff` below, and a ref nobody will fetch is worse than a
       * missing explanation of a ref that is there.
       */
      /** An append that never rejects: `null` when it landed, the refusal when it did not. */
      const appendTo = (events: readonly ToAppend[]): Effect.Effect<{ refused: unknown } | null> =>
        appendAt(runId, events).pipe(
          Effect.as(null),
          Effect.catchDefect((refused: unknown) => Effect.succeed({ refused })),
        )
      /** Set when a `RunRefsPublished` append was refused: `saveHead` reads it to know the save did not land (#1398). */
      let refsAppendFailed = false
      const noteRefs = (
        outcome: 'published' | 'nothing-committed' | 'already-published' | 'arm-only' | 'refused' | 'unrecorded',
        headSha: string | null,
        detail: string | null,
        branchCarries?: boolean,
        armSha?: string,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const failed = yield* appendTo([
            {
              type: 'RunRefsPublished',
              actor: 'conductor',
              data: parsePayload('RunRefsPublished', { branch, arm, headSha, outcome, detail, branchCarries, armSha }),
            },
          ])
          if (failed !== null) {
            refsAppendFailed = true
            const why = whyOf(failed.refused)
            runLog.note('push', `the account of ${outcome} was not appended — ${why}`)
            log(`RunRefsPublished (${outcome}) was refused by the store: ${why}`)
          }
        })

      /**
       * The counts, against the ref that actually holds them — so the next
       * attempt's brief says how much is there rather than only that something is.
       *
       * **The ref is a parameter and not `branch`**, because `arm-only` exists.
       * **Asked for twice within one call** (`#252`): a store that drops its
       * connection on this one row is the disconnect CLAUDE.md documents, arriving
       * on the row `attemptBrief` reads and nothing else does. Twice and not until
       * it works — a finalizer that will not finish holds the worktree, and with
       * it the commits, against every later attempt.
       */
      const recordDiff = (ref: string, head: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (recordedDiff === producedKey(ref, head)) return
          // `head` rather than the implicit `HEAD`: once a WIP commit exists,
          // `branch`'s own head is the agent's last commit and `HEAD` is the
          // WIP on top of it (`keepUncommittedWork`, `#468`) — two different
          // counts, and this one is asked for the ref it is actually about.
          const counted = yield* numstat(undefined, head)
          const row: ToAppend = {
            type: 'RunProducedDiff',
            actor: 'conductor',
            data: parsePayload('RunProducedDiff', { branch: ref, headSha: head, ...counted }),
          }
          const first = yield* appendTo([row])
          if (first !== null) {
            const again = yield* appendTo([row])
            if (again !== null) {
              const why = `${whyOf(first.refused)}, and again — ${whyOf(again.refused)}`
              runLog.note('push', `${ref} at ${head.slice(0, 7)} is on origin and was not recorded — ${why}`)
              log(`RunProducedDiff (${ref}) was refused by the store twice: ${why}`)
              yield* noteRefs('unrecorded', head, `${ref} — ${why}`)
              return
            }
          }
          // After the append and never before it (`#251`): a key set in advance
          // marks the answer given by the append that did not give it.
          recordedDiff = producedKey(ref, head)
        })

      /**
       * **A stopped agent's dirty tree, kept as its own commit on `HEAD`** (`#468`, `#1243`).
       *
       * Called at the end of an `implement` dispatch that ended abnormally —
       * `firstDispatch`, and `fixRound` — so the commit is on `HEAD` before any
       * step after it reads the worktree, and again from `publishWhatIsCommitted`,
       * where an `interrupted` dispatch (which never reaches its own end) is kept.
       * `stoppedBy` is null on every ending nothing stopped mid-agent, and
       * `no-commits` is a normal end that left nothing worth a commit. **A conflict
       * round keeps nothing** (0108 §20): a merge left standing is aborted by the
       * next round's own `mergeForConflict`, and the worktree goes with the scope.
       *
       * A clean tree is what stops a second call; a successful keep consumes the
       * stop, and a failed one leaves `stoppedBy` set so the finalizer asks again.
       *
       * Every git call here is asked rather than died on (`gitAskedEffect`, not
       * `gitOrDie`): a failed WIP must never cost the publish of the real commits
       * below it, which is `noteRefs`' own rule read for this row.
       */
      const keepUncommittedWork = (): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (stoppedBy === null || stoppedBy === 'no-commits' || inConflictRound) return
          // A failed keep clears nothing: the retried call reaches here too (`#468`), and a
          // keep that fails once and then succeeds must not go on telling later
          // `RunRefsPublished` rows the tree was not kept.
          wipFailure = null
          const dirty = yield* gitAskedEffect(['status', '--porcelain'])
          if (Result.isFailure(dirty)) {
            wipFailure = `the dirty tree could not be checked — ${dirty.failure.detail}`
            runLog.note('push', wipFailure)
            return
          }
          if (dirty.success.trim() === '') return
          // **Dirt that is only the planted env file is not agent work to
          // keep** (`#468`) — a porcelain line for it alone must read the same
          // as a clean tree, not send `git add`/`git commit` at a tree with
          // nothing else for them to touch. Porcelain's own format is two
          // status characters, a space, then the path.
          if (onlyThePlantedFileIsDirty(dirty.success, recipe.env.plantAt)) return
          const parent = yield* gitAskedEffect(['rev-parse', 'HEAD'])
          if (Result.isFailure(parent)) {
            wipFailure = `the dirty tree was not kept — its parent could not be read: ${parent.failure.detail}`
            runLog.note('push', wipFailure)
            return
          }
          // `kept-run-port.ts`'s `commitWipExceptPlanted` stages everything and
          // then unstages the planted env file by name, rather than excluding
          // it from the `add` — a `:(exclude)` pathspec exits 1 whenever the
          // repository's own `.gitignore` already covers the path, even though
          // it staged everything else (`#470`).
          // The commit and the entry are one uninterruptible region (#468):
          // `HEAD` has moved the moment the commit succeeds.
          const stopper = stoppedBy
          const entry: { parent: string; stoppedBy: string; sha: string | null } = {
            parent: parent.success,
            stoppedBy: stopper,
            sha: null,
          }
          const kept = yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const made = yield* commitWipExceptPlanted(
                gitAskedEffect,
                recipe.env.plantAt,
                // `runId` is always `attemptStream`'s (its one constructor, above),
                // which `WIP_COMMIT_PREFIX` already carries — `attemptIdOf` strips it
                // back off here so the message reads `wip: run-<uuid> stopped by …`
                // rather than doubling it.
                `${WIP_COMMIT_PREFIX}${attemptIdOf(runId)} stopped by ${stopper}`,
              )
              if (!('failed' in made)) {
                wips.push(entry)
                stoppedBy = null
              }
              return made
            }),
          )
          if ('failed' in kept) {
            wipFailure = `the dirty tree was not kept — ${kept.failed}`
            runLog.note('push', wipFailure)
            return
          }
          // The commit moved `HEAD` whether or not the read below can confirm its
          // own sha, so the entry exists already (`#468`); `publishWhatIsCommitted`
          // resolves any entry whose sha this read could not.
          const after = yield* gitAskedEffect(['rev-parse', 'HEAD'])
          if (Result.isSuccess(after)) entry.sha = after.success
          runLog.note(
            'push',
            Result.isSuccess(after)
              ? `kept the dirty tree as ${after.success.slice(0, 7)} on ${branch}, stopped by ${stopper}`
              : `kept the dirty tree on ${branch}, stopped by ${stopper} — its own sha could not be confirmed: ${after.failure.detail}`,
          )
        })

      /**
       * **Fills in the sha of a WIP whose own read failed** (`#468`). The WIP was committed
       * directly on `parent`, so the first commit of `parent..HEAD` is that WIP even when a
       * rerun committed on top of it. An entry that still cannot be resolved is named in
       * `wipFailure` and gets no row: a row must name a fetchable sha.
       */
      const resolveWipShas = (): Effect.Effect<void> =>
        Effect.gen(function* () {
          for (const entry of wips) {
            if (entry.sha !== null) continue
            const listed = yield* gitAskedEffect([
              'log',
              '--reverse',
              '--first-parent',
              '--format=%H %P%x09%s',
              `${entry.parent}..HEAD`,
            ])
            // The first commit on the first-parent chain above `parent` is the WIP, which was made
            // directly on it: an advanced base merged in later, or another ticket's commit on the same
            // parent, is reached only through a merge's second parent and so is never on this chain.
            const head = Result.isSuccess(listed) ? (listed.success.split('\n')[0] ?? '') : ''
            const [ids = '', subject = ''] = head.split('\t')
            const parts = ids.trim().split(/\s+/)
            const first =
              parts.length === 2 && parts[1] === entry.parent && subject.startsWith(WIP_COMMIT_PREFIX) ? parts[0]! : ''
            if (first !== '') {
              entry.sha = first
              continue
            }
            const why = Result.isFailure(listed) ? listed.failure.detail : 'no WIP commit directly above its parent'
            const note = `the kept tree's sha could not be resolved — ${why}`
            wipFailure = wipFailure === null ? note : `${wipFailure}; ${note}`
            runLog.note('push', note)
          }
        })

      /**
       * The shas `noteKept` has already recorded, so a second call for the same
       * WIP commit writes nothing (`#468`). `publishWhatIsCommitted` runs twice
       * on most endings — inline, then from the finalizer — and without this,
       * the second call found the same WIP still there and appended the same
       * row again: `recordDiff`'s own `recordedDiff` key, read for this one.
       */
      const notedKept = new Set<string>()

      /**
       * The WIP's own account, appended once the commit is actually on origin —
       * never before, for `RunRefsPublished`'s own reason: a sha named on the log
       * must be fetchable. Counted `parent..sha`, which is the WIP alone.
       */
      const noteKept = (
        made: { parent: string; stoppedBy: string; sha: string | null },
        ref: string,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const sha = made.sha
          if (sha === null || notedKept.has(sha)) return
          const counted = yield* numstat(made.parent, sha)
          const failed = yield* appendTo([
            {
              type: 'RunKeptUncommitted',
              actor: 'conductor',
              data: parsePayload('RunKeptUncommitted', {
                ref,
                sha,
                parentSha: made.parent,
                stoppedBy: made.stoppedBy,
                ...counted,
              }),
            },
          ])
          if (failed === null) {
            // After the append and never before it (`#251`'s own rule, read for
            // this row): a key set in advance marks the answer given by the
            // append that did not give it.
            notedKept.add(sha)
          } else {
            const why = whyOf(failed.refused)
            runLog.note('push', `${sha.slice(0, 7)} is on ${ref} and was not recorded — ${why}`)
            log(`RunKeptUncommitted was refused by the store: ${why}`)
          }
        })
      /** `ref` is where the commits are: `branch`, or the arm alone when `agent/<n>` was refused. */
      const noteAllKept = (ref: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          keptOwed = false
          yield* resolveWipShas()
          for (const entry of wips) {
            // An entry whose sha is unknown is still owed a row.
            if (entry.sha === null) {
              keptOwed = true
              continue
            }
            if (notedKept.has(entry.sha)) continue
            // A row names a sha the remote holds: one the pushed history does not contain (a WIP a
            // rerun amended away) is never recorded, whatever local objects remain.
            const inside = yield* gitAskedEffect(['merge-base', '--is-ancestor', entry.sha, 'HEAD'])
            if (Result.isFailure(inside)) {
              // Only git's own "not an ancestor" (exit 1) is absence. Any other failure is unknown, and
              // unknown is not confirmation: nothing is recorded now, and the row stays owed for a later call.
              if (inside.failure.exitCode === 1) {
                runLog.note(
                  'push',
                  `${entry.sha.slice(0, 7)} is not in the history pushed to ${ref}, so it is not recorded`,
                )
              } else {
                keptOwed = true
                runLog.note(
                  'push',
                  `${entry.sha.slice(0, 7)} could not be confirmed in the history pushed to ${ref} — ${inside.failure.detail}`,
                )
              }
              continue
            }
            yield* noteKept(entry, ref)
            if (!notedKept.has(entry.sha)) keptOwed = true
          }
        })

      /**
       * **What this claim leaves behind, whatever ending it had** (0062 §1).
       *
       * A worktree is cut `--force --detach` and removed when this scope closes,
       * so commits the agent made and nothing pushed go with it. `#237` made 36
       * edits, committed none and pushed nothing; this is the half the conductor
       * owns. **An ending with no commits publishes nothing** — a ref to an empty
       * branch is a worse lie than the absence.
       */
      const publishWhatIsCommitted: Effect.Effect<string | null> = Effect.uninterruptible(
        Effect.gen(function* () {
          // Where this run's tree was really cut (#607) — `tree.baseSha` alone is
          // the approved head on a continuation, so a lane refusal with no new
          // commit read as "nothing committed" over a head already published.
          // See `baseShaOr`.
          if (worktree === null) return null
          const tree = worktree
          const cutBase = continuation?.diffBaseSha ?? tree.baseSha
          // Hoisted out of the `try`, so the `catch` below can still name the
          // head a defect struck after (`#421`) — `head` itself is a `const`
          // the `try`'s own scope would otherwise keep from it.
          let headRead: string | null = null
          return yield* Effect.gen(function* () {
            yield* keepUncommittedWork()
            const at = yield* gitAskedEffect(['rev-parse', 'HEAD'])
            if (Result.isFailure(at)) {
              runLog.note('push', `${branch} was not pushed — ${at.failure.detail}`)
              // `wipFailure`, not `withWipFailure` (not yet in scope — that
              // closure reads `head`, which this call never got to): the keep
              // may have failed for its own reason before this read did for a
              // different one, and both deserve a line on the durable row.
              yield* noteRefs(
                'refused',
                null,
                wipFailure === null ? at.failure.detail : `${at.failure.detail}; ${wipFailure}`,
              )
              return at.failure.detail
            }
            const head = at.success
            headRead = head
            headNow = head
            // A keep whose own sha read failed is resolved here, before anything is pushed or recorded.
            yield* resolveWipShas()
            // **Why a keep found nothing to publish, when it did not** (`#468`):
            // reduced into whichever `RunRefsPublished` row this call ends up
            // writing, so a failed `git add` or `git commit` reaches somewhere
            // durable and not only `runLog.note` (0034 §8 — a trace, never a
            // record).
            const withWipFailure = (detail: string | null): string | null =>
              wipFailure === null ? detail : detail === null ? wipFailure : `${detail}; ${wipFailure}`
            if (head === cutBase) {
              runLog.note('push', `nothing to push — ${branch} is still at the base`)
              yield* noteRefs('nothing-committed', null, withWipFailure(null))
              return null
            }
            /**
             * **Both refs, because the row says both and a restart names the
             * second** (0062 §2, `#251`).
             *
             * `published` alone was the condition, and `land` sets it without the
             * arm: it pushes `HEAD:refs/heads/<branch>` on its own, because the
             * lane is about to merge that ref and an arm written for a landing is
             * one 0062 §4's sweep would take straight back off. So on every
             * ending that reached the merge lane and was refused there —
             * `conflict`, `no-commits`, `pending-migration`, `dirty-base` — this
             * short-circuited as `already-published`, pushed nothing, and wrote a
             * row naming an `arm` that is on no remote. The person requeues, the
             * next attempt's `--force-with-lease` matches and overwrites
             * `agent/<n>` from a fresh base, and the commits the live
             * `signoff` named are unreachable — which is the loss the
             * arm ref exists to prevent, under a log row asserting it was
             * prevented.
             *
             * Asking for both means the push below runs on that ending: the
             * branch's refspec is a no-op at a head origin already has, and the
             * forced arm is the whole point of the second trip.
             */
            if (head === published && head === armPublished) {
              // The commits are on origin under one of the two refs this ending
              // names, so the mirror keeps nothing for them (`#421`) — a no-op
              // unless an earlier call on this claim wrote a `Mirror` ref.
              yield* dropKept()
              yield* noteRefs('already-published', head, withWipFailure(null))
              // And the record is asked for again (`#251`): a store that was down
              // for the earlier attempts may be up by the time the scope unwinds.
              yield* recordDiff(branch, head)
              // `noteKept` is asked for again too, and for the same reason as
              // `recordDiff` above (`#251`, `#468`): `notedKept` lacks the sha when the
              // earlier attempt's append found the store down.
              yield* noteAllKept(branch)
              return null
            }
            // Retried while origin cannot be reached or answers a 5xx (#1125). A 5xx that origin
            // applied leaves the next try's lease stale, so — as `landNow` does — a stale lease
            // is settled by asking origin what it holds. One command moves two refs and is not
            // atomic, so neither is inferred from the other: both must be where this push put them.
            const pushed = yield* gitAskedEffect(
              [
                'push',
                `--force-with-lease=refs/heads/${branch}:${lease ?? ''}`,
                'origin',
                'HEAD:refs/heads/' + branch,
                `+HEAD:refs/heads/${arm}`,
              ],
              options.unreachableWaits ?? UNREACHABLE_WAITS,
              (err) =>
                /stale info/i.test(err.stderr ?? err.detail)
                  ? Effect.gen(function* () {
                      const listed = yield* Effect.result(
                        gitHere(['ls-remote', 'origin', `refs/heads/${branch}`, `refs/heads/${arm}`]),
                      )
                      if (Result.isFailure(listed))
                        return yield* Effect.fail(
                          classify({ platform: 'git', text: listed.failure.stderr ?? listed.failure.detail })?.kind ===
                            'unreachable'
                            ? listed.failure
                            : err,
                        )
                      const held = new Map(
                        listed.success
                          .split('\n')
                          .map((line) => line.split(/\s+/))
                          .map(([sha, ref]) => [ref, sha] as const),
                      )
                      return held.get(`refs/heads/${branch}`) === head && held.get(`refs/heads/${arm}`) === head
                        ? ''
                        : yield* Effect.fail(err)
                    })
                  : Effect.fail(err),
            )
            if (Result.isFailure(pushed)) {
              // **One exit code for two refspecs, so a failure is asked which**
              // (`#251`). `git push` is not atomic: origin takes the forced arm,
              // rejects the leased `agent/<n>`, and exits non-zero with the commits
              // on origin. Forced and at the same head, this second push is a no-op
              // where the arm already went and fails again where the transport broke.
              const armAlone = yield* gitAskedEffect(
                ['push', 'origin', `+HEAD:refs/heads/${arm}`],
                options.unreachableWaits ?? UNREACHABLE_WAITS,
              )
              if (Result.isSuccess(armAlone)) {
                runLog.note(
                  'push',
                  `${branch} was not pushed — ${pushed.failure.detail}; ${arm} at ${head.slice(0, 7)} is on origin`,
                )
                // The arm is up even though the command exited non-zero, which is
                // the whole point of asking it separately.
                armPublished = head
                // The commits are on origin as the arm, not the mirror (`#421`)
                // — `dropKept` clears a `Mirror` ref an earlier call on this
                // claim may have written, and `kept` is then set to `Arm`
                // directly: there is nothing in the mirror to point at.
                yield* dropKept()
                kept = { _tag: 'Arm', ref: `refs/heads/${arm}`, sha: head }
                yield* noteRefs('arm-only', head, withWipFailure(pushed.failure.detail))
                yield* recordDiff(arm, head)
                yield* noteAllKept(arm)
                return pushed.failure.detail
              }
              // **Kept before the account is written, not after** (`#421`) —
              // the worktree holding these commits is removed when the pass
              // ends, so the ref has to exist before anything describes where
              // the work went.
              yield* keepHead(head)
              runLog.note('push', `${branch} was not pushed — ${pushed.failure.detail}`)
              yield* noteRefs('refused', head, withWipFailure(pushed.failure.detail))
              return pushed.failure.detail
            }
            lease = head
            published = head
            armPublished = head
            // The commits just reached origin, so the mirror keeps nothing for
            // them (`#421`) — a no-op unless an earlier call wrote a ref.
            yield* dropKept()
            runLog.note('push', `${branch} and ${arm} at ${head.slice(0, 7)}`)
            yield* noteRefs('published', head, withWipFailure(null))
            yield* recordDiff(branch, head)
            yield* noteAllKept(branch)
            return null
          }).pipe(
            Effect.catchDefect((defect) =>
              Effect.gen(function* () {
                const why = whyOf(defect)
                // **Only where `head` was read and never reached origin** (`#421`)
                // — `headRead === armPublished` is the `armPublished` guard: a
                // defect thrown *after* a successful push (inside `recordDiff`, say)
                // must not write a `Mirror` ref for work that is already up.
                if (headRead !== null && headRead !== cutBase && headRead !== armPublished) {
                  yield* keepHead(headRead)
                }
                runLog.note('push', `the publish itself failed — ${why}`)
                yield* noteRefs('refused', null, why)
                return why
              }),
            ),
          )
        }),
      )

      yield* Effect.addFinalizer(() => (didLand && !keptOwed ? Effect.void : publishWhatIsCommitted))

      /**
       * **A landing that finished is recorded even when the pass was interrupted
       * after it** (#1056). The lane makes the push and the merge uninterruptible,
       * but the interruption then takes effect before the pass reaches its own
       * `TicketLanded` append, and the outer finalizer would give back an item
       * whose diff is already on the base. Runs on every exit of this scope; on a
       * normal ending `released` is already true and it does nothing.
       *
       * **Registered after the publish and the run log's finalizers, so it runs
       * before them**: the log's fate turns on `didLand`, which has to be true by
       * then. **`release` goes through this first**, so a defect after the
       * merge (a refused `StepEnded`) records the landing instead of returning
       * merged work to the queue; only a landing the store refuses on every try
       * falls through to the ordinary release.
       */
      const recordLanding = (): Effect.Effect<boolean> =>
        Effect.suspend(() => {
          const merged = mergeCommit
          if (merged === null) return Effect.succeed(false)
          if (released) return Effect.succeed(true)
          return remembered(
            landTicketEffect(
              ticketId,
              { mergeCommit: merged, base: attemptBase(), draft: draftOfLanding() },
              store,
              ticketSnapshots,
            ),
          ).pipe(
            // A refusal is a defect now; retried as a failure, as it was.
            Effect.catchDefect((defect) => Effect.fail(defect)),
            Effect.retry({ times: 2 }),
            // The publish is skipped once `didLand` is set, so the WIP rows are written first.
            Effect.tap(() => noteAllKept(branch)),
            Effect.tap(() =>
              Effect.sync(() => {
                released = true
                didLand = true
              }),
            ),
            // Recorded: the item is landed. Not recorded (the store refuses it on
            // every try): the work is on the base all the same, so an interrupted
            // pass does not give it back (`release`); a pass that died of the
            // refusal itself still releases, as it always has.
            Effect.as(true),
            Effect.catchCause(() =>
              Effect.sync(() => {
                log(`could not record the landing of ${ticketId} at ${merged}`)
                unrecordedLanding = true
                return false
              }),
            ),
          )
        })
      recordMergedWork = recordLanding
      yield* Effect.addFinalizer((exit) =>
        Exit.isFailure(exit) && onStream !== null ? Effect.asVoid(recordLanding()) : Effect.void,
      )

      // ---- the ports ---------------------------------------------------------
      // Eight methods, and every one of them wraps rather than reimplements —
      // `attempt-steps.ts`'s own rule, read from this side.

      /**
       * `claim` — whether this machine may take the item, and taking it.
       *
       * **Eligibility is asked, not looked up.** Nothing was appended when this
       * issue was first seen (0012), so there is no *was it discovered* to read:
       * the recipe decides against the issue as GitHub reports it right now, which
       * is also the only way a label edit takes effect without a second mechanism.
       *
       * The four answers are `Taken`'s, and the fourth is the one worth naming:
       * `claimTicket` answers a `ConcurrencyError` with `lost-race` and
       * **throws** every other failure, including an append that committed and
       * then lost its connection. Reported as `mayHold` rather than let escape, so
       * the pass stops with the item named and `end` resolves against the stream
       * it may be on.
       */
      const take = (queue: QueueSettings): Effect.Effect<TakeAnswer> =>
        Effect.gen(function* () {
          // **Before the answer, not after it** — the three ways this can decline
          // set no item, and it was exactly those that would let `end` resolve onto
          // the item the pass before had landed. It is here rather than in `claim`'s
          // body because the action runs *before* the body: a reset written there
          // would wipe what this had just taken (`attempt-steps.ts`).
          took = null
          onStream = null
          // The four values off the action and never off `recipe` here, so that the
          // ticket this takes is the one the reading of the recipe says it took
          // (`queueOf`, and `defaultsAt` below where a recipe declares nothing).
          // Discovery's own port (`#347`): the two reads a pass makes of a ticket
          // source go through one value typed by it, not by the wider
          // `GitHubClient` — swapping the source later is then a one-line change
          // here rather than one at each call site.
          const tickets: TicketSource = options.client
          // A read that rejects is a defect here, which the pipeline turns into
          // `queue:`'s `failed` verdict as a rejection did.
          const found = yield* runnableNowEffect({
            client: tickets,
            queue,
            selection: selectionOf(recipe),
            only: [options.issue],
          }).pipe(Effect.orDie)
          const runnable = found.runnable.find((r) => r.ref === String(options.issue))
          if (!runnable) {
            return {
              passedOver: found.skipped.find((s) => s.ref === options.issue)?.reason ?? 'not runnable',
            }
          }
          // **The branch this attempt is cut from and lands on** (0130 §5, #1341). A continuation keeps its claim's;
          // a fresh claim is on `branch.personal` unless it is a team `lingtai:pr-fix`, which is cut from the open PR's
          // branch. **A failed read of the PR is never *no PR open***: it claims nothing for this look, because
          // landing a review's fix on `branch.personal` would be landing it outside the PR.
          if (continuation === null) {
            attemptCut = null
            if (modeOf(recipe) === 'team' && runnable.kind.toLowerCase().replace(/\s+/g, '-') === PR_FIX_LABEL) {
              const read = yield* Effect.result(openPr(project, store))
              if (Result.isFailure(read)) return { notClaimed: `the open PR could not be read: ${whyOf(read.failure)}` }
              const open = read.success
              if (open !== null) {
                // A requested PR has no branch yet, and one not yet pushed has nothing on the remote to cut from.
                if (open.n === null || open.prBranch === null || open.lastPushed === null)
                  return { notClaimed: `the PR branch of PR ${open.n ?? '?'} is not on the remote yet` }
                attemptCut = { branch: open.prBranch, pr: open.n }
              } else {
                attemptCut = { branch: passBase, pr: null }
              }
            }
          }
          // The ticket, fetched once, before anything that reads it: the
          // implementer's brief and the cold reviewer both want it, and a run still
          // costs one call for it.
          const issue = yield* Effect.promise(() => tickets.getIssue(options.issue))
          // **One uninterruptible region, from the claim call to the assignment of
          // `onStream`** (#1056). The claim's append may have committed by the time
          // the call returns, and `onStream` is the whole of *this run may hold the
          // item* — which `release` is gated on. An interruption between the two
          // would leave the item claimed with nothing willing to give it back.
          // It stops short of `runnableNow` and `getIssue`, which hold nothing, and
          // of `openTheRunLog` and `tellGitHubAbout`, which `release` reaches once
          // `onStream` is set.
          const region = yield* Effect.uninterruptible(
            Effect.gen(function* () {
              // A release-sourced continuation whose lock stands again is not a claim at all (#1205).
              if (releasedDeclined !== null) {
                return { kind: 'answer' as const, answer: { notClaimed: releasedDeclined } as TakeAnswer }
              }
              // **A continuation reclaims the same run, never a fresh one**
              // (#465, 0120 §6) — `continueTicket` is `claimTicket`'s
              // sibling for the one state the latter refuses, `approved`, and
              // `continuation` (above) is what makes this branch `null` rather
              // than acted on wrongly when the request has gone stale.
              const attempting: Effect.Effect<
                | Effect.Success<ReturnType<typeof claimTicketEffect>>
                | Effect.Success<ReturnType<typeof continueTicketEffect>>,
                unknown
              > =
                continuation !== null
                  ? continueTicketEffect(ticketId, runId, {
                      store,
                      ...ticketSnapshots,
                      body: issue.body,
                      // The head, prompt and lock check were read at this version: a newer release is another look's.
                      ...(continuation.released?.by === 'release' ? { expectVersion: reduced.version } : {}),
                    })
                  : // The claim carries what the task is, because it is now the
                    // only place a title enters the log at all.
                    claimTicketEffect(ticketId, {
                      runId,
                      store,
                      ...ticketSnapshots,
                      title: runnable.title,
                      kind: runnable.kind,
                      body: issue.body,
                      ...(attemptCut === null ? {} : { cutFrom: attemptCut }),
                      children: options.client,
                    })
              const attempted = yield* Effect.result(attempting)
              if (Result.isFailure(attempted)) {
                // The one decline that leaves a stream behind, and `end` resolves
                // against it: the append may have committed, so the item may be held by
                // this run and somebody has to be told about it.
                onStream = ticketId
                return {
                  kind: 'answer' as const,
                  answer: { mayHold: { ticketId, detail: whyOf(attempted.failure) } } as TakeAnswer,
                }
              }
              const claim = attempted.success
              if (!claim.ok)
                return { kind: 'answer' as const, answer: { notClaimed: JSON.stringify(claim.refusal) } as TakeAnswer }
              // **Set on the line the append committed, and before anything that can
              // fail** (`#269`). It is the whole of *this run may hold the item*, which
              // is what `release` below is gated on — so a throw between here and the
              // return must not be able to leave the item claimed with nothing willing
              // to give it back.
              onStream = ticketId
              return { kind: 'claim' as const, claim }
            }),
          )
          if (region.kind === 'answer') return region.answer
          const claim = region.claim
          splitRead = claim.claim.splitChildren
          log(`claimed ${ticketId} as ${runId}`)
          // **The run's account starts here**, because until this line there is no
          // run to account for: see `runLog`. A `passedOver` or a lost race above
          // returns having opened nothing.
          yield* openTheRunLog
          took = {
            ticketId,
            kind: runnable.kind,
            ticket: { ref: String(issue.number), title: issue.title, body: issue.body },
            // Both claims above were handed `body: issue.body`, so the event at this
            // version holds exactly the string the prompts will paste (#927).
            claimVersion: claim.claim.version,
          }
          // The issue says what the log says, from here on. Inline rather than
          // queued (0022): a call that does not land is written down and converged
          // later rather than retried.
          yield* tellGitHubAboutEffect({
            store,
            github: options.client,
            ticketId,
            ...ticketSnapshots,
            labels: labelsFor('running'),
            // A continuation is the same work going on: the landing, the next
            // hold or the release edits that wait's comment with the real
            // outcome. Editing it here would spend the one edit on *Approved*.
            editEnded: !(options.continuing !== undefined && continuation !== null),
          })
          return { taken: { ticketId, kind: runnable.kind } }
        })

      /**
       * `admit` — cut the worktree, at the base **the action names**.
       *
       * **The dep of a plugin rather than a port of a step, since `#268`.**
       * `worktreePlugin` declares `admit` (0065 §4), so what calls this is
       * `createWorktreeAction` in `@lingtai/actions`, over the `base` and
       * `submodules` the action carries — which is `worktree:`'s at `admit` where
       * a recipe declares one and `defaultsAt`'s off `repo:` where it does not.
       * Read off the argument and never off `recipe` here, so that the tree this
       * cuts is the one the reading of the recipe says it cut.
       *
       * The path is `cwd`, computed before the pass: see this file's opening. A
       * clone that did not finish is not a judgement about the change — nothing
       * has been written yet — so it is `notCut`, which the action reports as
       * 0057's class rather than as a refusal buying a round to fix a repository.
       */
      const cut = (spec: { readonly base: string; readonly submodules: boolean }): Effect.Effect<CutAnswer> =>
        Effect.gen(function* () {
          /**
           * The cold reviewer's own settings, with no hook in them. `wiring`'s
           * settings and `wiring.env` are one thing and the `agent` gate had only
           * the first, so the hook refused the reviewer's opening prompt and every
           * review returned that refusal instead of findings.
           *
           * Through the port and not `writeUnhookedSettings` itself: it writes a
           * file under `~/.lingtai`, and a conductor that wrote it here would put a
           * disk under every test of a decision that reaches `review` (0060 §1,
           * `AgentHostPort.unhookedSettings`).
           *
           * **Here, and not above the pass, because above the pass is before the
           * claim.** It used to be `….pipe(Effect.orDie)` in this file's own scope,
           * which is two faults in one line. A file under `~/.lingtai/runs/<runId>/`
           * was written for every candidate the `claim` step then passed over or
           * lost the race for, one per pass and never removed (`runLog`). And a
           * write that failed — ENOSPC, `~/.lingtai` not writable after a
           * permissions change — became a **defect**, which the handler at the
           * bottom of `runOnce` answers with `release(…)`: `releaseTicket`
           * appends whoever holds it (`ticket/commands.ts`), so a failure here appended
           * `TicketReleased` to another conductor's live item and wrote
           * `lingtai:queued` over its `lingtai:working` while its agent was still
           * working. The `claim` branch guards declines the pass reports; a defect
           * raised before the `claim` step reaches the handler with `released`
           * still false.
           *
           * So it is asked for at the step that gets this pass's disk ready, on an
           * item this run holds, and **before** the worktree: a failure is `notCut`
           * with nothing cut, which is true, and the item is then blocked or
           * released by the ending like any other machine fact.
           */
          reviewDecision = yield* decideSandbox
          const settings = yield* Effect.result(
            host.unhookedSettings({
              runId,
              label: 'review',
              home,
              ...(reviewDecision.kind === 'sandboxed' ? { sandboxed: true } : {}),
            }),
          )
          if (Result.isFailure(settings)) {
            return { notCut: `the cold reviewer had no settings: ${settings.failure.detail}` }
          }
          reviewSettingsPath = settings.success

          // **A continuation of a release re-cuts at the head its cause names** (#1205): a head that cannot be
          // continued is not cut at all, and the ending restarts or holds for a person (`headGone`).
          const releasedHead = continuation?.released?.head
          if (releasedHead !== undefined && 'cannot' in releasedHead) {
            headGone = releasedHead.cannot
            return { notCut: `the saved head cannot be continued: ${releasedHead.cannot}` }
          }
          const provision = Effect.suspend(() =>
            Effect.result(
              repo.provision({
                project,
                // '' when there is no owner: `remote` is always set then —
                // `ownerlessClient` (`./ownerless.ts`) refuses a recipe naming
                // no `repo.remote` before either of its two callers, `run.ts`
                // and `apps/cli/src/conduct.ts`'s `conductWork`, builds this
                // client — so `ProvisionOptions.owner` is read only to build
                // the `github.com` URL `remote` pre-empts.
                owner: options.client.owner ?? '',
                repo: options.client.repo,
                base: spec.base,
                branch,
                runId,
                submodules: spec.submodules,
                plantAt: recipe.env.plantAt,
                env: env.values,
                token: options.token,
                home,
                remote: options.remote,
                gitEnv: options.gitEnv,
                // srt's stand-in names, so `git add -A` works inside it (#1152); no key under any other decision.
                ...(sandboxDecision.kind === 'sandboxed' ? { exclude: standInExcludes } : {}),
                // **A continuation re-cuts at the sha the approval was about,
                // never the base** (#465) — the worktree a held pass left is
                // gone once its scope closed, and `provisionWorktree`'s own
                // `at` check refuses rather than silently taking a branch that
                // has moved since.
                ...(continuation !== null
                  ? releasedHead !== undefined
                    ? { at: releasedHead.at, atRef: releasedHead.atRef }
                    : { at: continuation.onSha, ...(continuation.grantRef ? { atRef: continuation.grantRef } : {}) }
                  : {}),
              }),
            ),
          )
          let provisioned = yield* provision
          if (
            Result.isFailure(provisioned) &&
            provisioned.failure.baseAbsent === true &&
            options.personalBranch !== undefined &&
            continuation === null &&
            modeOf(recipe) === 'team' &&
            recipe.branch.personal !== undefined &&
            spec.base === recipe.branch.personal
          ) {
            // The remote has no `branch.personal`, which the person stated by writing it in the recipe (#1358). Made
            // from `branch.main`'s tip, never moved; a read that failed makes nothing and the cut refuses as it did.
            const ensured = yield* Effect.result(options.personalBranch(spec.base, recipe.branch.main))
            if (Result.isFailure(ensured)) return { notCut: ensured.failure.message }
            if ('made' in ensured.success) {
              log(`made ${spec.base} at ${ensured.success.made.slice(0, 7)} from ${recipe.branch.main}`)
            }
            provisioned = yield* provision
          }
          if (Result.isFailure(provisioned)) {
            if (releasedHead !== undefined && provisioned.failure.stale === true) headGone = provisioned.failure.detail
            return { notCut: provisioned.failure.detail }
          }
          worktree = provisioned.success
          lease = provisioned.success.remoteHead
          log(`worktree ${provisioned.success.path} at ${provisioned.success.baseSha.slice(0, 7)}`)
          // `head` is the whole of what moves `onSha`, and the action puts it on
          // its result for the pass to read (`ActionResult.head`). The `Worktree`
          // itself stays here, where the finalizer that removes it already is.
          return { head: provisioned.success.baseSha, where: provisioned.success.path }
        })

      /**
       * **One `RunSpent` per paid call that returned a `RunOutcome`** (`#493`,
       * `#495`, 0110 §2, §9, §10) — `firstDispatch`, `fixRound` and `askTheAgent`
       * below all call this, so none of the three can write a different shape.
       * `for` names what the call was for, built by each caller; `usage` is `[]`
       * rather than absent, since `RunSpent.usage` is required unlike
       * `RunFinished.usage`; `costUsd` is copied through as the runtime reported
       * it, `null` included, and is never defaulted to zero.
       */
      const runSpentFrom = (outcome: RunOutcome, forSpent: SpentFor, runtime: RuntimeId): ToAppend => {
        if (outcome.costUsd === null || outcome.costUsd === undefined) spent.unknown += 1
        else spent.usd += outcome.costUsd
        return runSpentRow(outcome, forSpent, runtime)
      }
      const runSpentRow = (outcome: RunOutcome, forSpent: SpentFor, runtime: RuntimeId): ToAppend => ({
        type: 'RunSpent',
        actor: 'conductor',
        data: parsePayload('RunSpent', {
          for: forSpent,
          runtime,
          turns: outcome.turns,
          durationMs: outcome.durationMs,
          costUsd: outcome.costUsd,
          usage: outcome.usage ?? [],
        }),
      })

      /**
       * **An agent, paid for a judgement** — the dispatch a `judge: claude-code`
       * is (`#277`, [the-plugin-body.md](../../../doc/design/the-plugin-body.md) §5).
       *
       * This is the seam that was missing while `JudgeName` took no runtime: a
       * built-in is a function the router applies and could live anywhere, and a
       * runtime needs a `Runtime`, a settings file and a prompt, none of which
       * exists on the router's side of the call. So it is here, beside the other
       * two dispatches, and it is the same four moves they make — settings, run,
       * read the answer, say what it cost.
       *
       * **Three ways it does not come back with a choice, and they are not all
       * the same thing.** None of the three judged anything, exactly as a reviewer
       * whose answer will not parse has not reviewed (`agent-action.ts`), and none
       * of them is **retried** — an agent that could not answer once costs the
       * same again and terminates no sooner. What differs is *whose* condition it
       * was:
       *
       * - a run that did not finish, and an answer that will not read as a
       *   destination, are about this pass, so they are **a person's** — the pass
       *   stops at `proposed` and the runtime's own words go on the card;
       * - a run that **never started** is a quota wall, which is account-wide, so
       *   it stands the conductor down exactly as an implementing agent's does
       *   (0031 §3). This paragraph said the opposite until the cold reviewer on
       *   `#277` read it against the ADR, and the argument it made — *the pass
       *   stops at `proposed` for a person either way* — was true about this pass
       *   and beside the point: the decision is about whether the conductor keeps
       *   taking work into a wall every queued item would meet, which is what §3
       *   is for, and about §5's resume happening without anybody watching.
       *
       * **Nothing is dispatched for a set of one**, but a refusal at `admit` or
       * `prepared` is not that set — `offerFor`'s `SetupRefused` cell calls
       * `restart(hasCriterion)` regardless of step (`routing.ts:173-178`), so
       * with any evidence and a restart left, `available` is `['restart',
       * 'hand-to-person']` even though no agent has run, and a declared judge
       * is asked there same as anywhere else. What a set of one still excludes
       * is the narrower case — no evidence, or no restart left to spend — where
       * `stepsOnOffer`'s criterion rule has already refused the only purchase
       * on offer, one step further on.
       *
       * **What it cost is on `RunSpent`, and the decision stays in the
       * sentence** (`#495`, 0110 *Consequences*). `PassRouted.why` is what a
       * person reads beside the arriving step's detail, and a judgement with
       * no price on it is the reading `#98` is about; there is still no
       * `JudgeAsked` to reduce — the route is already the record of what was
       * decided, and what it spent is a `RunSpent` beside it.
       */
      const askTheAgent = (declared: Extract<Declared, { runtime: RuntimeId }>, on: Judging): Effect.Effect<Judged> =>
        // A dispatched judge is an action of the `proposed` visit (#791); a
        // built-in spends nothing and is not. Its failures mark the span
        // themselves — `held`, `neverStarted` and `unreadable` below — from the
        // fiber, where the span is current. A failure exit (an interruption)
        // marks it too, inside the span.
        askTheAgentBody(declared, on).pipe(
          Effect.onExit((exit) => (Exit.isFailure(exit) ? Effect.annotateCurrentSpan(FAILED, true) : Effect.void)),
          Effect.withSpan('action judge', { attributes: { 'lingtai.index': 0 } }, { captureStackTrace: false }),
        )
      const askTheAgentBody = (
        declared: Extract<Declared, { runtime: RuntimeId }>,
        on: Judging,
      ): Effect.Effect<Judged> =>
        Effect.gen(function* () {
          const named = declared.named
          const held = (why: string): Judged => {
            markFailed()
            return { next: 'waiting', named, why }
          }
          // `#462`: the set-of-one guard that used to live here (`on.offering
          // .length < 2`) is dead — `replyFor` (`proposed-route.ts`) answers
          // `NotAsked` before `judge` is ever called for a set that size, which
          // is the ticket's own rule: a judge is paid, so one that cannot help
          // is not asked, not even a built-in.

          // **The runtime the entry named, dispatched** (`#314`). It used to be
          // `options.runtime.capabilities.id` unconditionally, with a comment saying
          // that was not the name being dropped — `agentRefusal` had refused any
          // entry that disagreed, so the two always agreed. They need not now, and
          // this is the reading that makes `judge: codex` beside `agent:
          // claude-code` a thing the recipe can say.
          const dispatched = runtimeNamed(declared.runtime)
          const runtime = dispatched.capabilities.id
          // **The model is in the sentence or it is nowhere.** `RunSpent` carries
          // `runtime` and never `model`, so a `judge:` whose whole point is a
          // cheap model must still say which one it bought here, where
          // `PassRouted.why` and the run log can be read after the fact (`#314`,
          // 0070 §2).
          const asKnown = `${runtime}${declared.model === undefined ? '' : ` (${declared.model})`}`
          const judgeDecision = yield* decideSandbox
          const settings = yield* Effect.result(
            host.unhookedSettings({
              runId,
              label: 'judge',
              home,
              ...(judgeDecision.kind === 'sandboxed' ? { sandboxed: true } : {}),
            }),
          )
          if (Result.isFailure(settings)) {
            return held(`the "${named}" judge had no settings: ${settings.failure.detail}`)
          }
          judgements += 1
          log(`judging a "${on.when}" with ${asKnown} — ${named}`)
          runLog.note('judge', `${on.when}: asking ${asKnown}`)

          // Set inside the `.catch` below: `dispatched.run` threw rather than
          // returning, so the `RunOutcome` beneath it is made up by this
          // function and not reported by the process — the `RunSpent` the
          // ticket asks for is "whose process returned a `RunOutcome`", and
          // this one did not.
          let threw = false
          // Built once, for the prompt record and for the `RunSpent` below (#923).
          const judgeFor: SpentFor = { _tag: 'Judge', when: on.when }
          const judgeParts = judgePromptParts(on)
          const judgePromptText = judgePrompt(on)
          const judgeEnv = runnableEnv(env.values)
          const runtimeVersion = yield* runtimeVersionOfEffect(dispatched, judgeEnv, worktree?.path ?? home)
          yield* Effect.promise(() =>
            recordPrompt(
              store,
              runId,
              {
                for: judgeFor,
                promptVersion: `judge@${judgePromptText.length}`,
                runtimeVersion,
                prompt: judgeParts,
              },
              log,
            ),
          )
          // Only a defect is the crash outcome; an interruption stays one. The
          // run's own interruption waits for the agent to stop before it continues.
          const judgeRunId = `${runId}:judge:${on.when}:${continuation?.resumedWaitId ?? 'start'}:${judgements}`
          const outcome = yield* dispatched
            .run({
              // The count is in it, so two arrivals on one pass are two
              // sessions: a judge asked whether it still agrees with itself
              // is the warm-review failure `sessionIdFor` exists to avoid,
              // and a session id reused is the refusal `#195` cost a run.
              // The wait this continuation resumes is in it too, since the
              // count restarts in each one (#580). See `judgements`.
              runId: judgeRunId,
              // The worktree where there is one, and the conductor's own
              // directory where `admit` never cut one. Nothing is read from
              // either — the prompt says so — but a process still needs a
              // directory that exists to start in. A sandboxed judge with no
              // worktree starts in its own run directory instead: the
              // conductor's is read-denied inside srt (#1150).
              cwd:
                worktree?.path ?? (judgeDecision.kind === 'unsandboxed' ? home : claudeConfigDirFor(home, judgeRunId)),
              ...(yield* sandboxOf(
                judgeDecision,
                { runId: judgeRunId, worktree: worktree?.path },
                { stream: runId, step: 'proposed', action: `judge:${on.when}`, runtime: dispatched.capabilities.id },
              )),
              prompt: judgePromptText,
              ...(declared.model === undefined ? {} : { model: declared.model }),
              settingsPath: settings.success,
              log: taggedTrace(runLog, `judge:${on.when}`),
              traceTools: true,
              env: judgeEnv,
              limits: spendFor(declared.limits),
            })
            .pipe(
              Effect.catchDefect((err) =>
                Effect.sync(() => {
                  threw = true
                  return {
                    exitCode: null,
                    turns: 0,
                    durationMs: 0,
                    costUsd: null,
                    failure: { kind: 'crash' as const, detail: (err as Error).message },
                    text: null,
                    sessionId: '',
                    usage: undefined,
                  }
                }),
              ),
            )

          // **Who was asked is part of what it cost** (`#314`). This string is
          // still the whole record of the *decision* — there is no `JudgeAsked`
          // to reduce — and a `judge:` bought from a cheap model is one whose
          // model has to be readable on `PassRouted.why` afterwards, or the
          // saving is unprovable.
          const spent = `${asKnown} · ${outcome.turns} turns${outcome.costUsd === null ? '' : `, $${outcome.costUsd.toFixed(2)}`}`
          runLog.note('judge', `${on.when}: ${outcome.failure?.kind ?? 'answered'} · ${spent}`)
          // **One `RunSpent` per dispatch whose process returned a `RunOutcome`**
          // (`#495`, 0110 *Consequences*) — whether the judge answered, answered
          // something the offer did not contain, or answered nothing. `threw`
          // excludes the one path where nothing came back to report: the
          // `.catch` above makes up a `RunOutcome` so the rest of this function
          // can read one, and `RunSpent.turns`/`.costUsd` may never be invented
          // numbers (`events.ts`'s own doc on `RunSpent`).
          if (!threw) {
            yield* appendNow(runId, [runSpentFrom(outcome, judgeFor, runtime)])
          }
          /**
           * **A quota wall is the account's, so it locks that account rather than
           * backing off this item** (0031 §3) — the third depth that wall is met at, after the
           * step's own agent and the agent a refusal bought.
           *
           * `never-started` is the adapter's classification and is not re-derived
           * here (0031 §1). Everything else — a crash, a timeout, a turn budget
           * spent without an answer — did start, is about this pass, and is a
           * person's: that is the `held` below.
           */
          if (outcome.failure?.kind === 'never-started') {
            markFailed()
            return {
              neverStarted: {
                agent: runtime,
                // The runtime's own words, whole: `standDown` reads a reset time out
                // of them (0031 §4) and the log line shows them as what they are.
                detail: outcome.failure.detail,
              },
            }
          }
          if (outcome.failure) {
            // #655: the judge's crash is the ticket's wait, and the account's wall locks the runtime that said it.
            const walled = outcome.failure.kind === 'crash' ? wallOf(outcome.failure.detail) : null
            if (walled !== null) {
              const stood = yield* standDownAccount({ of: 'mid-run', step: 'proposed' }, walled, outcome.failure.detail)
              if (stood.limit !== null) {
                return held(
                  `the "${named}" judge did not answer: ${limitSentence(walled, stood.limit, stood.now, { untilFrom: stood.untilFrom, said: stood.said })} — ` +
                    `${outcome.failure.detail} — so the attempt is held for a person (${spent})`,
                )
              }
            }
            return held(
              `the "${named}" judge did not answer (${outcome.failure.kind}): ` +
                `${outcome.failure.detail} — so the attempt is held for a person (${spent})`,
            )
          }
          if (on.when === 'findings') {
            // 0108 §6: the judge answers a cause, and the route applies `actionFor` to it (`replyFor`).
            const read = causeIn(outcome.text)
            if (read !== null && 'cause' in read) {
              return { cause: read.cause, named, why: `the "${named}" judge: ${read.summary} (${spent})` }
            }
            markFailed()
            return {
              unreadable: {
                named,
                raw:
                  (read === null
                    ? `the "${named}" judge's answer was not readable as one cause`
                    : `the "${named}" judge answered ${read.refused}, which a judge at findings may not answer (0118 §5)`) +
                  ` (${spent}):\n${(outcome.text ?? '').slice(0, 2_000)}`,
              },
            }
          }
          const chose = chosenIn(outcome.text)
          if (chose === null) {
            // `#462`: a judge's own unreadable answer is `Judged.unreadable`
            // now, not reduced into `held`'s `next: 'waiting'` — it becomes
            // `JudgeReply.Unreadable` in `replyFor`, which `decideRoute` reads
            // as `UnreadableReply` rather than as a destination somebody chose.
            markFailed()
            return {
              unreadable: {
                named,
                raw:
                  `the "${named}" judge's answer was not readable as one of the steps it was offered ` +
                  `(${spent}):\n${(outcome.text ?? '').slice(0, 2_000)}`,
              },
            }
          }
          // Held to the offer by `judged` in `attempt-steps.ts` and never here — a
          // destination the set did not contain is refused by name there, with the
          // ceiling that took it away, which is the one place that knows both.
          return { next: chose.next, named, why: `the "${named}" judge: ${chose.why} (${spent})` }
        })

      /**
       * `proposed` — **the judge the recipe declared for this direction** (`#274`,
       * `#277`, 0061 §3).
       *
       * `judgePlugin.at` carries `proposed`, `recipe.steps.proposed` is what
       * resolved there, and `judgeDeclaredAt` takes the entry whose `when:` matches
       * the reason the last step gave. **What it answers is one of two kinds of
       * decider**: a built-in is a *name* the pass applies, where nothing is
       * dispatched and `bodiesFor`'s `judged` records what the rule chose against
       * the offer; a runtime is an agent, and `askTheAgent` above is what that
       * costs.
       *
       * **`noJudge` where the recipe said nothing, which is still the ordinary
       * answer.** `BUILT_IN_FOR` then answers `red` and `verify-failed` mechanically
       * and spends nothing, and a person is the floor under `conflict`,
       * `needs-input` and `findings`. So a recipe with an empty `proposed:` behaves
       * exactly as it did before this existed (0064 §5: absent is not empty), and
       * the floor `#253` set holds either way.
       *
       * **What a declared judge buys is the round the ceilings already paid for.**
       * `#267` and `#263` each refused at `review` and parked at `waiting` with
       * `rounds: 3` unspent — $14.19 between them — because there was no judge to
       * ask which way to go. A runtime judge spends one of those rounds by
       * *choosing* `implement`; it cannot spend a second, because the offer it was
       * handed is what the counting already left.
       */
      const judge = (on: Judging): Effect.Effect<Judged> => {
        const declared = judgeDeclaredAt(recipe.steps.proposed, on.when)
        if (declared === null) return Effect.succeed({ noJudge: true })
        if ('built' in declared) return Effect.succeed(declared)
        return askTheAgent(declared, on)
      }

      /** `end` — the work item's own stream, read this late on purpose. */
      const readEnd = (stream: string) => Effect.promise(() => store.read(stream))

      /**
       * `end` — what the step resolved, held for the append that makes its
       * outcome true.
       *
       * **Not an append of its own, and that is the contract rather than a
       * shortcut.** `resolveEndActions`'s own doc is *one transaction, so the
       * outcome and its resolution cannot come apart*, and `AttemptPorts.recordEnd`
       * says whose transaction it is: *batching is the caller's because the ending
       * is the caller's*. The pass runs `end` before this file writes
       * `TicketLanded` or `WaitStarted`, so an append here is the resolution
       * landing first and a dropped connection leaving it there alone. See
       * `endPlan` for what that cost.
       *
       * The version the read gave is therefore not used: the append that carries
       * this reads the stream for itself, which is the same optimistic check one
       * step further on.
       */
      const recordEnd = (_stream: string, _at: number, plan: readonly ToAppend[]) =>
        Effect.sync(() => {
          endPlan = plan
        })

      /**
       * `merge` — the branch on the remote, then the lane.
       *
       * **The dep of a plugin rather than a port of a step, since `#270`.**
       * `mergePlugin` declares `merge` (0065 §2), so what calls this is
       * `createMergeAction` in `@lingtai/actions`, over the `strategy` the action
       * carries and the `onSha` the pass is on — which is `merge:`'s at `merge`
       * where a recipe declares one and `defaultsAt`'s where it does not.
       *
       * The push is here rather than beside the agent because this is the point at
       * which the head has been judged: the steps before it all passed on `onSha`,
       * and pushing it is how the lane and a person get to see the thing that was
       * judged. Every other ending publishes from the finalizer.
       *
       * **`strategy` is carried and not branched on, because there is one value.**
       * `integrate` offers `git merge --no-ff` and a fast-forward push, which is
       * `merge-commit`. What keeps a second value from resolving is `mergePlugin`'s
       * own `z.enum` in `packages/recipe/src/recipe.ts` — not a check here, and
       * this signature has none: it carries the field so the lane is told what it
       * was asked for. Widening that enum without giving `integrate` the second
       * behaviour is `#61` — a value that resolves, is drawn, and lands the first
       * behaviour under the second's name — so the enum and `integrate` grow in
       * one diff, and this is where the branch on it would go.
       *
       * **The lane reports and decides nothing.** `stepsPassed` is `true` without
       * being asked, and that is the sequence rather than an assumption: `merge` is
       * reached only where every step before it passed, so a lane told otherwise
       * would be a lane told something the pass cannot be in a position to say.
       */
      const landNow = (on: { readonly strategy: MergeStrategy; readonly onSha: string }): Effect.Effect<LandAnswer> =>
        Effect.gen(function* () {
          // Retried while origin cannot be reached (#1029), inside the lane's uninterruptible
          // region: a drain waits at most the tries' own bound, about 3 × git's timeout plus the
          // waits, and a landing that started is never cut in half.
          // A lease that no longer matches may mean a push whose reply was lost landed after all:
          // if origin already holds the sha being landed, the push is done. The check is part of
          // each try, so a failed read is another try rather than an early exit.
          const pushed = yield* gitAskedEffect(
            [
              'push',
              `--force-with-lease=refs/heads/${branch}:${lease ?? ''}`,
              'origin',
              `${on.onSha}:refs/heads/${branch}`,
            ],
            options.unreachableWaits ?? UNREACHABLE_WAITS,
            (err) =>
              /stale info/i.test(err.stderr ?? err.detail)
                ? Effect.gen(function* () {
                    const listed = yield* Effect.result(gitHere(['ls-remote', 'origin', `refs/heads/${branch}`]))
                    if (Result.isFailure(listed))
                      return yield* Effect.fail(
                        classify({ platform: 'git', text: listed.failure.stderr ?? listed.failure.detail })?.kind ===
                          'unreachable'
                          ? listed.failure
                          : err,
                      )
                    return listed.success.split(/\s/)[0] === on.onSha ? '' : yield* Effect.fail(err)
                  })
                : Effect.fail(err),
          )
          if (Result.isFailure(pushed)) {
            const said = classify({ platform: 'git', text: pushed.failure.stderr ?? pushed.failure.detail })?.kind
            return {
              notMerged: {
                reason: said === 'unreachable' || said === 'remote-error' ? said : 'push-rejected',
                detail: pushed.failure.detail,
              },
            }
          }
          lease = on.onSha
          // The branch and not the arm: the lane is about to merge this ref, and
          // an arm written for a landing is one 0062 §4's sweep takes back off.
          // A lane that refuses leaves the arm to the end-of-pass publish, which
          // asks about `armPublished` and not only about this
          // (`publishWhatIsCommitted`).
          published = on.onSha

          // A pr-fix lands on the PR's branch, which must still be what Lingtai last pushed there: read inside the lane's
          // turn, so a landing before this one has moved it already (#1341). A read that fails is not a branch that
          // held, and nothing is merged.
          let expectBase: string | undefined
          if (attemptCut !== null && attemptCut.pr !== null) {
            // A fix an earlier landing pushed and could not tell the PR of is told first, from the log (its
            // `TicketLanded` on this branch), so the head checked below is the PR's however many processes ago that was.
            const mended = yield* Effect.result(
              Effect.gen(function* () {
                const current = yield* readPr(project, attemptCut!.pr!, store)
                if (current === null) return
                const owed = yield* readUnheldFixLandings(project, current, store)
                for (const fix of owed) yield* recordPrFixLanded(project, attemptCut!.pr!, fix, store)
              }),
            )
            // **A repair that failed is not a head to check against**: the PR's `lastPushed` is stale, and landing against
            // it would refuse `pr-branch-moved` for a push nobody made and hand Lingtai's own to a person. Nothing is
            // merged; the lane's own retry asks again.
            if (Result.isFailure(mended)) {
              log(`PR ${attemptCut.pr}: fixes not told of were not mended: ${whyOf(mended.failure)}`)
              return {
                notMerged: {
                  reason: 'unreachable',
                  detail: `the PR could not be told of an earlier fix: ${whyOf(mended.failure)}`,
                },
              } as LandAnswer
            }
            const prRead = yield* Effect.result(readPr(project, attemptCut.pr, store))
            if (Result.isFailure(prRead)) {
              return {
                notMerged: { reason: 'unexpected', detail: `the PR could not be read: ${whyOf(prRead.failure)}` },
              } as LandAnswer
            }
            expectBase = prRead.success?.lastPushed ?? undefined
          }

          const result = yield* repo.integrate({
            project,
            // '' when there is no owner, for `provision`'s own reason above.
            owner: options.client.owner ?? '',
            repo: options.client.repo,
            base: attemptBase(),
            branch,
            ticketId,
            headSha: on.onSha,
            stepsPassed: true,
            remote: options.remote,
            issue: String(options.issue),
            token: options.token,
            home,
            gitEnv: options.gitEnv,
            store,
            unreachableWaits: options.unreachableWaits,
            ...(expectBase === undefined ? {} : { expectBase }),
          })
          if (result.ok) {
            mergeCommit = result.mergeCommit
            // The PR is told **inside the lane's turn**: a second pr-fix then reads this merge as the PR's head, and
            // the push step never finds the branch at a commit the PR does not know (#1341). The push has happened,
            // so a failed append is the sweep's to repair, not the landing's to fail.
            if (attemptCut !== null && attemptCut.pr !== null) {
              const answered = yield* Effect.result(
                recordPrFixLanded(
                  project,
                  attemptCut.pr,
                  {
                    ticket: String(options.issue),
                    mergeCommit: result.mergeCommit,
                    ...(took === null ? {} : { title: took.ticket.title }),
                  },
                  store,
                ).pipe(Effect.retry({ times: 4 })),
              )
              if (Result.isFailure(answered))
                log(`PR ${attemptCut.pr} was not told of the fix: ${whyOf(answered.failure)}`)
              else if (!answered.success)
                log(
                  `PR ${attemptCut.pr} holds ${options.issue} already or is no longer open: it stays on ${attemptBase()}`,
                )
            }
            return { merged: result.mergeCommit } as LandAnswer
          }
          return {
            notMerged: {
              reason: result.reason,
              detail: result.detail,
              ...(result.conflict === undefined ? {} : { conflict: result.conflict }),
              ...(result.baseMoved === undefined ? {} : { baseMoved: result.baseMoved }),
            },
          } as LandAnswer
        })

      /**
       * The lane is what makes `landNow` uninterruptible (`landing-lane.ts`), so
       * this adds no `uninterruptible` of its own: once granted, the push and the
       * merge run to their end and the answer is what the pass records.
       */
      const land = (on: { readonly strategy: MergeStrategy; readonly onSha: string }): Effect.Effect<LandAnswer> =>
        (options.lane ?? landingLane).through(
          integrationStream(project, attemptBase()),
          { runId, issue: options.issue },
          {
            onWait: (behind) =>
              appendNow(runId, [
                {
                  type: 'MergeLaneWaited',
                  actor: 'conductor',
                  data: parsePayload('MergeLaneWaited', {
                    behind: 'pr' in behind ? { pr: behind.pr } : { runId: behind.runId, issue: String(behind.issue) },
                  }),
                },
              ]).pipe(Effect.asVoid),
          },
          landNow(on),
        )

      /**
       * **The base merged into the branch, by the system** (#593) — what a
       * `MergeBase` route runs, and no agent is involved.
       *
       * `toSha`, not the base's tip: it is what the lane's trial merge just proved
       * clean, so the merge here is clean by construction. If the base has moved
       * again since, the next visit to `merge` sees that and counts it, which is
       * what `baseBranchMerges` bounds. **Not pushed here**: `land` pushes `onSha`
       * against `lease` on the next visit to `merge`, and this commit is a
       * fast-forward of the head it pushed last; any ending before that publishes
       * from the finalizer. A third push site would be a third place `lease` has
       * to be kept true.
       *
       * The subject starts with `Merge`, so it can never look like the
       * `WIP_COMMIT_PREFIX` commit the lane refuses (`integrate.ts`).
       */
      const mergeBase = (toSha: string): Effect.Effect<{ head: string } | { failed: string }> =>
        Effect.gen(function* () {
          const fetched = yield* gitAskedEffect(['fetch', 'origin', `refs/heads/${attemptBase()}`])
          if (Result.isFailure(fetched))
            return { failed: `fetching ${attemptBase()} failed: ${fetched.failure.detail}` }
          const merged = yield* gitAskedEffect([
            'merge',
            '--no-edit',
            '-m',
            `Merge ${attemptBase()} at ${toSha.slice(0, 7)} into ${branch}`,
            toSha,
          ])
          if (Result.isFailure(merged)) {
            yield* gitAskedEffect(['merge', '--abort'])
            return { failed: merged.failure.detail }
          }
          const head = yield* gitAskedEffect(['rev-parse', 'HEAD'])
          if (Result.isFailure(head)) return { failed: head.failure.detail }
          return { head: head.success.trim() }
        })

      /**
       * Whether a merge stands. `rev-parse -q --verify` exits 1 for a ref that is not there and
       * says nothing; any other failure (a killed git, a locked index, a spawn that failed) is
       * **unknown, never absent** (#1120).
       */
      const mergeHeadState = (): Effect.Effect<
        { state: 'standing' } | { state: 'absent' } | { state: 'unknown'; detail: string }
      > =>
        Effect.gen(function* () {
          const got = yield* gitAskedEffect(['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
          if (Result.isSuccess(got)) return { state: 'standing' } as const
          return got.failure.exitCode === 1
            ? ({ state: 'absent' } as const)
            : ({ state: 'unknown', detail: got.failure.detail } as const)
        })
      /** Paths git names across a range, NUL-delimited so a quoted name is never used as a path. `null` when the read failed. */
      const pathsBetween = (range: string): Effect.Effect<string[] | null> =>
        Effect.gen(function* () {
          const got = yield* gitAskedEffect(['diff', '--name-only', '-z', range])
          return Result.isSuccess(got) ? got.success.split('\0').filter((p) => p !== '') : null
        })
      /**
       * **What landed on the base, and what each side did to it** (#594, #1121): the one read
       * behind the fix brief and the review. One `git diff` per path (so no `diff --git` header
       * is parsed back into paths), through `DIFF_FLAGS`; for a conflicted path also the
       * first-parent commits that touched it and, given `branchSha`, the branch's own diff.
       * Conflicted paths come first, in the order given, then the rest. Every read that fails
       * is that part's text, never an empty section and never a failed round. Reads only, in
       * the attempt's worktree, which shares the mirror's objects: no fetch and no permit.
       */
      type RawLine = { sha: string; subject: string; n: number | null }
      type RawCommits = { readonly failed: string } | { readonly lines: readonly RawLine[] }
      type RawPath = { path: string; diff: string; commits?: RawCommits; branchDiff?: string }
      const landedOnBaseRead = (moved: {
        readonly paths: readonly string[]
        readonly fromSha: string
        readonly toSha: string
        readonly conflicted?: readonly string[]
        readonly branchSha?: string
      }): Effect.Effect<LandedPath[]> =>
        Effect.gen(function* () {
          const marked = moved.conflicted ?? []
          const ordered = [...new Set([...marked, ...moved.paths])]
          const readDiff = (a: string, b: string, path: string) =>
            Effect.gen(function* () {
              const got = yield* gitAskedEffect(['diff', ...DIFF_FLAGS, a, b, '--', path])
              return Result.isFailure(got) ? `[could not read this diff: ${got.failure.detail}]` : got.success
            })
          const readCommits = (path: string): Effect.Effect<RawCommits> =>
            Effect.gen(function* () {
              const got = yield* gitAskedEffect([
                '-c',
                'log.follow=false',
                'log',
                '--first-parent',
                '--no-color',
                '--no-show-signature',
                '--no-notes',
                '--format=%H %s',
                '-z',
                `${moved.fromSha}..${moved.toSha}`,
                '--',
                path,
              ])
              if (Result.isFailure(got)) return { failed: got.failure.detail }
              const lines: RawLine[] = got.success
                .split('\0')
                .map((rec) => rec.replace(/^\n+/, ''))
                .filter((rec) => rec !== '')
                .map((rec) => {
                  const at = rec.indexOf(' ')
                  const sha = at < 0 ? '' : rec.slice(0, at)
                  if (!/^[0-9a-f]{40}$/.test(sha)) return { sha: '', subject: rec, n: null }
                  const subject = rec.slice(at + 1)
                  return { sha, subject, n: ticketOfLandingSubject(subject) }
                })
              return { lines }
            })
          const per: RawPath[] = yield* Effect.forEach(
            ordered,
            (path) =>
              Effect.gen(function* () {
                const diff = yield* readDiff(moved.fromSha, moved.toSha, path)
                if (!marked.includes(path)) return { path, diff }
                const commits = yield* readCommits(path)
                const branchDiff =
                  moved.branchSha === undefined ? undefined : yield* readDiff(moved.fromSha, moved.branchSha, path)
                return { path, diff, commits, ...(branchDiff === undefined ? {} : { branchDiff }) }
              }),
            { concurrency: 'unbounded' },
          )
          // One stream read per distinct landed ticket; a rejection is a value that renders.
          const numbers = [
            ...new Set(
              per.flatMap((e) =>
                e.commits !== undefined && 'lines' in e.commits
                  ? e.commits.lines.flatMap((l) => (l.n === null ? [] : [l.n]))
                  : [],
              ),
            ),
          ]
          const titles = new Map<number, LandedTitle>()
          yield* Effect.forEach(
            numbers,
            (n) =>
              Effect.gen(function* () {
                const got = yield* Effect.result(
                  Effect.tryPromise({ try: () => store.read(ticketStream(project, n)), catch: (e) => String(e) }).pipe(
                    Effect.flatMap((events) =>
                      Effect.try({ try: () => reduceTicket(events).title, catch: (e) => String(e) }),
                    ),
                  ),
                )
                titles.set(
                  n,
                  Result.isFailure(got)
                    ? { failed: got.failure }
                    : typeof got.success === 'string' && got.success.trim() !== ''
                      ? { known: got.success }
                      : { none: true },
                )
              }),
            { concurrency: 'unbounded' },
          )
          return per.map((e): LandedPath => {
            if (e.commits === undefined || !('lines' in e.commits)) return e as LandedPath
            const lines = e.commits.lines.map((l): LandedCommit => ({
              sha: l.sha,
              subject: l.subject,
              ...(l.n === null ? {} : { ticket: { n: l.n, title: titles.get(l.n) ?? { none: true as const } } }),
            }))
            return { ...e, commits: { lines } }
          })
        })

      /**
       * **The conflict round's pre-merge** (#1120): `git merge --no-commit --no-ff <baseSha>` in
       * this attempt's own worktree, so the fixer stands in the conflict the lane proved. No
       * fetch: the worktree shares the mirror's objects, and `baseSha` is what the lane read
       * there. No mirror permit: the worktree is detached and the merge writes no shared ref.
       *
       * **Not `mergeBase`'s failure branch.** There a failed merge is the end and is aborted.
       * Here a failed merge *is* the answer, and is left standing; it is a merge that
       * succeeds (or fails with no unmerged path) that is aborted and refused. Any read
       * that fails is `failed`: unknown is never *no conflict*.
       */
      const mergeForConflict = (baseSha: string): Effect.Effect<ConflictMergeAnswer> =>
        Effect.gen(function* () {
          const abort = () => gitAskedEffect(['merge', '--abort'])
          // An earlier uncommitted resolution was never built or reviewed. A failed read of
          // `MERGE_HEAD` is *absent* only on exit 1; any other failure is unknown and `failed`.
          const standing = yield* mergeHeadState()
          if (standing.state === 'unknown') {
            return { failed: `MERGE_HEAD could not be read: ${standing.detail}` }
          }
          if (standing.state === 'standing') {
            const aborted = yield* abort()
            if (Result.isFailure(aborted)) {
              return { failed: `a merge already stands and could not be aborted: ${aborted.failure.detail}` }
            }
          }
          // `-z` and every untracked file by name, as `kept-run-port` reads it: an untracked
          // directory is not collapsed to `?? private/`, and no name is quoted. The configured
          // path is normalised (`./.env.local` is how git names `.env.local`).
          const dirty = yield* gitAskedEffect(['status', '--porcelain', '-z', '--untracked-files=all'])
          if (Result.isFailure(dirty)) return { failed: `the tree could not be checked: ${dirty.failure.detail}` }
          const planted = posix.normalize(recipe.env.plantAt)
          if (dirty.success.trim() !== '' && !onlyThePlantedFileIsDirty(dirty.success, planted)) {
            const named = dirty.success
              .split('\0')
              .map((line) => line.trim())
              .filter((line) => line !== '')
              .join(', ')
            return { failed: `the tree holds changes the merge would trip on: ${named}` }
          }
          const fork = yield* gitAskedEffect(['merge-base', 'HEAD', baseSha])
          const fromSha = Result.isSuccess(fork) ? fork.success.trim() : ''
          if (fromSha === '') {
            return { failed: `the common ancestor with ${baseSha.slice(0, 7)} could not be read` }
          }
          // Recorded before the merge, because the review runs after the round has committed.
          const headBefore = yield* gitAskedEffect(['rev-parse', 'HEAD'])
          const branchSha = Result.isSuccess(headBefore) ? headBefore.success.trim() : ''
          if (branchSha === '') {
            return { failed: 'the branch head could not be read before the merge' }
          }
          const merged = yield* gitAskedEffect(['merge', '--no-commit', '--no-ff', baseSha])
          if (Result.isSuccess(merged)) {
            yield* abort()
            const head = yield* gitAskedEffect(['rev-parse', 'HEAD'])
            const at = Result.isSuccess(head) ? head.success.trim().slice(0, 7) : 'unreadable'
            return {
              failed: `the lane's conflict did not reproduce in the worktree (HEAD ${at}, base ${baseSha.slice(0, 7)})`,
            }
          }
          const unmerged = yield* gitAskedEffect(['diff', '--name-only', '--diff-filter=U', '-z'])
          const paths = Result.isSuccess(unmerged) ? unmerged.success.split('\0').filter((p) => p !== '') : []
          if (paths.length === 0) {
            yield* abort()
            return {
              failed: Result.isFailure(unmerged)
                ? `the unmerged paths could not be read: ${unmerged.failure.detail}`
                : `the merge of ${baseSha.slice(0, 7)} failed with no conflicted path: ${merged.failure.detail}`,
            }
          }
          // The overlap `BaseMoved` uses: what the base changed, within what the branch changed.
          // NUL-delimited, so a name git would quote is still a path. An unreadable side is
          // `failed`, with the merge put back: a round briefed on an overlap nobody read would
          // be reviewed against a lost-changes question with nothing under it.
          const theirs = yield* pathsBetween(`${fromSha}..${baseSha}`)
          const mine = yield* pathsBetween(`${fromSha}..HEAD`)
          if (theirs === null || mine === null) {
            yield* abort()
            return {
              failed: `what the base and the branch each changed since ${fromSha.slice(0, 7)} could not be read`,
            }
          }
          return { conflicted: { paths, fromSha, branchSha, overlap: theirs.filter((p) => mine.includes(p)) } }
        })

      /**
       * **What a resolved conflict round's merge looked like, rebuilt for a continuation**
       * (#1120): the fork point and the overlap that `mergeForConflict` read are in no event,
       * so a review resumed after a hold reads them again from the committed merge. `null`
       * unless the head is a merge commit with `baseSha` in its history: then there is
       * nothing to show, and the review reads the ordinary prompt.
       */
      const conflictEvidence = (
        baseSha: string,
      ): Effect.Effect<{ fromSha: string; overlap: readonly string[]; branchSha: string } | null> =>
        Effect.gen(function* () {
          // The merge commit need not be `HEAD`: the fixer or a formatter may have committed after
          // it. It is the merge on the path from `baseSha` to `HEAD` that has `baseSha` as a parent.
          const merges = yield* gitAskedEffect([
            'rev-list',
            '--merges',
            '--parents',
            '--ancestry-path',
            `${baseSha}..HEAD`,
          ])
          if (Result.isFailure(merges)) return null
          const line = merges.success
            .split('\n')
            .map((l) => l.trim().split(/\s+/))
            .filter((parts) => parts.slice(1).includes(baseSha))
            .at(-1)
          const ours = line?.[1]
          if (ours === undefined || ours === baseSha) return null
          const ancestor = yield* gitAskedEffect(['merge-base', '--is-ancestor', baseSha, 'HEAD'])
          if (Result.isFailure(ancestor)) return null
          const fork = yield* gitAskedEffect(['merge-base', ours, baseSha])
          const fromSha = Result.isSuccess(fork) ? fork.success.trim() : ''
          if (fromSha === '') return null
          const base = yield* pathsBetween(`${fromSha}..${baseSha}`)
          const mine = yield* pathsBetween(`${fromSha}..${ours}`)
          if (base === null || mine === null) return null
          return { fromSha, overlap: base.filter((p) => mine.includes(p)), branchSha: ours }
        })

      /**
       * **Whether the command `build` refused fails on the base too** (#744, 0108 §13) — the port
       * `runAttempt` asks before a `BuildRed` buys a round. `unknown` is `notRed` with the reason
       * noted: a base that could not be checked never holds a pass.
       *
       * Aborted when this pass's scope closes, so a drain waits for the check the way it waits
       * for `build`. The instance is `baseCheckFor(store)`'s, shared with every other pass in
       * this conductor, which is what makes two asks about one commit one run (0122).
       */
      /**
       * **The `run:` commands' wrap** (#1153, S6a). The base check builds an identical one in `baseCheckQuestion`
       * with no appends (its keys name no step, so it appends nothing here), so a command is wrapped one way.
       */
      const runSandbox =
        sandboxDecision.kind === 'sandboxed' && passSandbox.service !== undefined
          ? makeRunSandbox(passSandbox.service, {
              appends: invocationAppends(runId),
              project,
              mirror: mirrorPathFor(project, home),
              cache: join(home, 'cache', project),
              additions: sandboxDecision.project_additions,
              codexNamed: runtimesOf(recipe).includes('codex'),
            })
          : undefined
      const baseAbort = new AbortController()
      yield* Effect.addFinalizer(() => Effect.sync(() => baseAbort.abort()))
      const baseIsRed = (asked: { action: string; mergedOnto: string | null }) =>
        Effect.gen(function* () {
          // A PR branch is built by the PR's own walk before it is pushed (#1312): nothing checks it as a base, so a red
          // one is never found here — which would release the fix for a ticket cut from `branch.personal` and never
          // make the PR branch green (#1341).
          if (attemptCut !== null && attemptCut.pr !== null)
            return { notRed: `${attemptBase()} is a PR branch; the PR's own walk builds it` }
          // The ticket opened for this red asks nothing of it, however its first read of the log went (#1266):
          // an unread state is not an answer that this is not the fix ticket.
          let named = yield* baseStateEffect({ store, project, base: attemptBase(), recipe })
          for (let again = 0; again < 3 && 'unread' in named; again++)
            named = yield* baseStateEffect({ store, project, base: attemptBase(), recipe })
          // Still unread: whether this is the fix ticket is unknown, and the cached red must not release it.
          if ('unread' in named) return { notRed: `base state not read: ${named.unread}` }
          if ('red' in named && named.red.fix?.externalRef === String(options.issue))
            return { notRed: 'this ticket is the one opened to make the base green' }
          const baseSha = asked.mergedOnto ?? continuation?.diffBaseSha ?? worktree?.baseSha ?? null
          const built = yield* baseCheckQuestion({
            project,
            base: attemptBase(),
            // Checked below: a pass with no base commit builds nothing.
            baseSha: baseSha ?? '',
            recipe,
            action: asked.action,
            env,
            home,
            sandbox: passSandbox,
            checkId: runId,
            signal: baseAbort.signal,
            token: options.token,
            gitEnv: options.gitEnv,
          }).pipe(Effect.provideService(Repo, repo))
          if ('notBuilt' in built) {
            runLog.note(
              'base',
              built.notBuilt === 'not a run: action in the recipe'
                ? `base not checked: \`${asked.action}\` is not a run: action in the recipe's build list`
                : `base not checked: ${built.notBuilt}`,
            )
            return { notRed: built.notBuilt }
          }
          if (baseSha === null) return { notRed: 'no base commit was cut' }
          const { question, observed } = built
          const answer = yield* baseCheckFor(store, log, home).ask(question)
          // A command that ran is a run of the project's: observed from what the pass decided, never `BaseChecked.boundary`.
          if (answer.verdict !== 'unknown' && answer.from === 'ran') {
            if (observed !== null) yield* observeTheSandbox(observed, runId)
          }
          if (answer.verdict === 'red') {
            return {
              red: {
                command: question.command,
                base: attemptBase(),
                baseSha,
                evidence: answer.evidence,
                boundary: answer.boundary,
              },
            }
          }
          if (answer.verdict === 'unknown') runLog.note('base', `base not checked: ${answer.why}`)
          return { notRed: answer.verdict }
        })

      /**
       * `design` — the document into the worktree, and onto the branch (0066 §5,
       * `#300`).
       *
       * **Both, always.** The finalizer below removes the worktree on every
       * ending, and the only thing that gets out past it is what
       * `publishWhatIsCommitted` pushed — so a note that was written and not
       * committed is gone when the pass ends, together with everything the
       * locator points at. `filePlugin` is where that is argued and why there is
       * no field for the other answer.
       *
       * **The dep of a plugin and never a step's own work.** `design`'s default is
       * nothing (0065 §4), so there is no `defaultsAt` row for this and a recipe
       * that declares no `file:` never reaches it — which is what lets a
       * destination be turned on one machine at a time.
       *
       * Under `cwd`, which is the worktree and the only place a pass writes: the
       * path has already been refused by `whyThePathEscapes` **twice** — once by
       * the schema, about the string a person wrote, when the recipe resolved,
       * and once by `createFileAction` itself, about what `{{issue}}` made of
       * that string, before it called this (`#310`). So what is left here is
       * `join` and the directories above it.
       * A trailing newline is added where the document has none, because a file in
       * a repository is read by `git diff` and by editors that both complain about
       * one that has not got one.
       *
       * **`notKept` and never a throw.** `design` may not refuse (0058 §3), and an
       * exception out of a plugin is a step that did not finish with no words on
       * it; this way the sentence a person reads is the write's own.
       *
       * **A commit that had nothing to commit is still kept, and it is asked
       * rather than inferred from the exit code.** Running the same ticket twice
       * writes the same bytes, and `git commit` exits non-zero on an empty index —
       * so *the file is already there* and *the commit was refused* arrive the same
       * way, and an unconditional `rev-parse` after both would report the base as
       * though the note had landed on it. `git diff --cached --quiet` separates
       * them first: nothing staged is kept at the head there already, and a commit
       * that then failed is `notKept`, because the evidence says *committed to the
       * branch* and that has to be true where it says it.
       */
      const keep = (spec: { readonly path: string; readonly document: string }): Effect.Effect<KeptAnswer> =>
        Effect.gen(function* () {
          const at = join(cwd, spec.path)
          const written = yield* Effect.result(
            Effect.tryPromise({
              try: () =>
                mkdir(dirname(at), { recursive: true }).then(() =>
                  writeFile(at, spec.document.endsWith('\n') ? spec.document : `${spec.document}\n`, 'utf8'),
                ),
              catch: (error) => error as Error,
            }),
          )
          if (Result.isFailure(written)) return { notKept: written.failure.message }

          // `-f`, so a project whose own `.gitignore` covers the path it asked for
          // is told by `git add` rather than by a note that silently never landed:
          // a plain `git add --` answers *the following paths are ignored* and
          // exits 0, and this keep would then report a commit it did not make.
          // Narrow by construction — the argument is the one path just written,
          // and `--only` below keeps the commit to it too.
          const added = yield* gitAskedEffect(['add', '-f', '--', spec.path])
          if (Result.isFailure(added)) return { notKept: `git add refused it: ${added.failure.detail}` }
          // `--quiet` implies `--exit-code`, so a *right* here is *nothing staged*
          // and a left is a difference to commit — the one place in this file where
          // the failing branch is the ordinary one.
          const staged = yield* gitAskedEffect(['diff', '--cached', '--quiet', '--', spec.path])
          if (Result.isFailure(staged)) {
            // `--only`, so a commit at `design` cannot pick up anything else the
            // worktree happens to be holding: what this action is answering for is
            // the one path it wrote.
            const committed = yield* gitAskedEffect([
              'commit',
              '-m',
              `docs(design): the shape for #${options.issue}`,
              '--only',
              '--',
              spec.path,
            ])
            if (Result.isFailure(committed)) {
              return { notKept: `git commit refused it: ${committed.failure.detail}` }
            }
          }
          const head = yield* gitAskedEffect(['rev-parse', 'HEAD'])
          return Result.isFailure(head) ? { at: spec.path } : { at: spec.path, head: head.success }
        })

      /**
       * `keptRun` — the git a `run:` at `implement` needs, in its own module so
       * a test can reach it (`kept-run-port.ts`, `#390`). Recorded the way
       * `firstDispatch` records the agent's own commit: `recordDiff` so
       * `task_view.head_sha` names this commit, and `RunProposedCompletion` so a
       * later attempt's `headOf` reads the same head.
       */
      const restoreReview = restoreAfterReview({ git: gitAskedEffect, plantAt: recipe.env.plantAt })
      const { clean, keep: keepRun } = keptRunPort({
        git: gitAskedEffect,
        plantAt: recipe.env.plantAt,
        issue: String(options.issue),
        recordCompletion: (head) =>
          Effect.gen(function* () {
            yield* recordDiff(branch, head)
            yield* appendNow(runId, [
              {
                type: 'RunProposedCompletion',
                actor: 'conductor',
                data: parsePayload('RunProposedCompletion', { headSha: head }),
              },
            ])
          }),
      })

      /**
       * `implement` — the design back off the path a `file:` kept it at (0066 §4,
       * 0069 §4, `#301`), and `keep`'s mirror.
       *
       * **Written in `file-port.ts` rather than here, and that is the whole of
       * the difference** (`#303`): this is the core's only contact with a
       * locator, so it is the one place 0066 §4 can actually erode, and a
       * closure over `cwd` inside a two-thousand-line function is a place no
       * test can reach. Out there it is a value
       * `unit/a-locator-the-core-did-not-write.test.ts` calls with a URL and
       * asks *what did you do with it*. The reasoning that was in this docblock
       * moved with the code it is about; the filesystem is handed in, and is
       * still `readFile` and nothing else.
       */
      const read = readWhatAFileKept(cwd, { read: (at) => readFile(at, 'utf8') })
      /** …which is already the Effect the action holds. */
      const readPort = read

      /** `implement`'s dispatch, in the action's own fiber. An arrow: `dispatch` is declared below. */
      const workPort: WorkPortDeps = {
        work: (spec: WorkDispatch, context: ActionContext) => dispatch(spec, context),
      }

      /**
       * **The ticket, for every plugin that writes part of it down** — the one
       * the `queue:` action took, or the number this run was started with where
       * nothing took one.
       *
       * A `const` handed to two rows below rather than an expression written at
       * each (`#310`). `{{issue}}` in a `prompt:` and `{{issue}}` in a `file:`
       * path have to be the same number, and two expressions that agree today
       * are two things that can drift apart tomorrow; one closure makes the
       * agreement structural rather than a coincidence a test has to notice.
       *
       * Read when the action runs and not here, so `took` is the claim this pass
       * made rather than whatever it was before `claim`.
       */
      const issue = () =>
        Effect.sync(() =>
          took === null
            ? { ref: String(options.issue), title: '', body: '' }
            : {
                ...took.ticket,
                ...(took.claimVersion === undefined
                  ? {}
                  : { bodyAt: { stream: took.ticketId, version: took.claimVersion } }),
              },
        )

      /**
       * What a declared plugin needs in order to run — the things only a caller
       * with a machine under it can build (`AttemptOptions.actionsAt`).
       *
       * A reviewer, the diff's file list, an environment resolver, the cut and the
       * lane. This is `stepDeps` under its old name: turning a declared list into a
       * runnable action is neither the sequence nor the outcome rules, so by 0058
       * §2b it is the caller's and not the pass's.
       */
      const stepDeps: ActionPortDeps = {
        // Replaced by `attemptBase()` where `actionsAt` hands it to a declared action.
        base: passBase,
        env: envForExtension,
        // 0108 §17 (#1222): a refusing `run:` that goes red then green asks these reads. The base is worked out when
        // the check asks, not here: `worktree` is assigned after this object is built.
        flaky: flakyPortOf({
          store,
          stream: () => integrationStream(project, attemptBase()),
          diffPaths: () => {
            const baseSha = continuation?.diffBaseSha ?? worktree?.baseSha ?? null
            return baseSha === null ? Effect.succeed(null) : pathsBetween(`${baseSha}...HEAD`)
          },
          backlog: () => readBacklogEffect({ project }),
          head: () =>
            Effect.map(gitAskedEffect(['rev-parse', 'HEAD']), (got) =>
              Result.isSuccess(got) ? got.success.trim() : undefined,
            ),
        }),
        agent: {
          runtime: options.runtime,
          issue,
          diff: (from?: string) =>
            (from === undefined ? changeStart() : Effect.succeed(from)).pipe(
              Effect.flatMap((start) => diffBetween(start)),
            ),
          diffSinceMerge: (reviewed: string, base: string) => diffSinceMerge(reviewed, base),
          // `landedOnBaseRead`: a read that cannot be made is text, not a dead review.
          landed: landedOnBaseRead,
          restore: restoreReview,
          // A getter, because `admit` is what writes it: `createAgentAction` and
          // `createDraftAction` read `deps.settingsPath` when the action *runs*,
          // which is at `design`, `review`, `proposed` or `merge` — so always
          // after `cut`, and since `#265` the first of those is the very next step.
          get settingsPath() {
            return reviewSettingsPath
          },
          // The reviewer and the design agent share one settings file, so one decision (#1150).
          sandboxFor: (forRun: string, cwd: string, keys: { step: Step; action: string; runtime: string }) =>
            sandboxOf(reviewDecision, { runId: forRun, worktree: cwd }, { stream: runId, ...keys }),
          // The ceiling, and the default: a `review` whose `agent:` declares a
          // `limits:` narrows it in `actionsFromRecipe`, which is the seam that
          // holds the action (`#314`).
          limits: {
            turns: numericTurns(ceiling.run.turns),
            wallMs: parseDuration(ceiling.run.wall),
            diffBytes: recipe.runtime.budget.diff,
            // The pass's own, unnarrowable here for the reason `spendFor`
            // carries it unchanged too: a dispatch's `limits:` refuses `usd`
            // by name, so there is nothing for `actionsFromRecipe` to narrow
            // (`#370`).
            usd: ceiling.run.usd,
          },
        },
        // **A sibling of `agent` and not a key on it** (`#314`): an action is
        // handed one runtime and never chooses between two, so choosing belongs
        // to the seam that builds it. `actionsFromRecipe` asks this for every
        // `agent:` entry's own name.
        runtimeFor: runtimeNamed,
        watch: {
          changedFiles: () =>
            Effect.gen(function* () {
              const start = yield* changeStart()
              const names = yield* gitOrDieEffect(changedFilesArgs(start))
              return names.split('\n').filter(Boolean)
            }),
        },
        // The fourth, and the one that makes rather than judges: `admit`'s
        // `worktree:` action cuts through this (0065 §2, `#268`).
        worktree: { cut },
        // The fifth, and the only one that changes the base branch: `merge`'s
        // `merge:` action lands through this (0065 §2, `#270`).
        merge: { land },
        // The sixth, and the other one that makes rather than judges: `claim`'s
        // `queue:` action takes the ticket through this (0065 §2, `#269`).
        queue: { take },
        // The seventh, and the one that writes the change: `implement`'s `agent:`
        // action dispatches through this (0065 §1, `#266`). Its own row rather
        // than a field on `agent` above, because the two share only the key a
        // recipe writes — a cold reviewer wants a runtime and a diff, and this
        // wants the hook wired, the socket served and the receipt measured.
        //
        // An arrow rather than `{ work: dispatch }`: `dispatch` is declared six
        // hundred lines down, and this object literal is evaluated here.
        work: workPort,
        // The eighth, and the one that neither makes nor judges: `design`'s
        // `file:` action keeps the document through this (0066 §5, `#300`). It has
        // no `defaultsAt` row, because `design`'s default is nothing — so nothing
        // reaches it unless a recipe declared a destination, which is what lets a
        // destination be turned on one machine at a time.
        // `issue` is the same closure `agent` above was handed, because the
        // placeholder a `file:` path expands and the one a `prompt:` expands are
        // one number (`#310`).
        file: { keep, issue },
        // The ninth, and the other end of the eighth: `implement`'s
        // `file-brief:` action reads the design back through this (0069 §4,
        // `#301`). Its own row rather than a field on `file` above, because the
        // two are two plugins — a recipe may keep a design without reading one
        // back — and it has no `defaultsAt` row either: an unconfigured
        // `implement` is briefed with the document the pass is already carrying,
        // exactly as it was before this existed.
        fileBrief: { read: readPort },
        // The eleventh, and `implement`'s own rather than a field on `file` above:
        // a `run:` written after the agent there commits what it changed
        // through this (`#390`), using the same two git calls regardless of
        // what failed or passed — see `clean` and `keepRun` above for why
        // neither reads the tree before acting on it. No `defaultsAt` row,
        // because an unconfigured `implement` runs no command at all.
        keptRun: {
          clean,
          keep: keepRun,
        },
        // The twelfth: the pass's one decision, and the wrap only a sandboxed one gets (#1152). Absent
        // `sandbox` under a *sandboxed* decision is refused by name in `actionPortsFromRecipe`.
        sandboxDecision,
        // A `run:` that is not wrapped has no wrap to record its boundary, so it is recorded here (#1164).
        ...(sandboxDecision.kind === 'sandboxed'
          ? {}
          : {
              recordUnwrapped: (keys: { step: Step; action: string }) =>
                recordUnwrapped(
                  sandboxDecision,
                  { step: keys.step, action: keys.action, runId: null },
                  invocationAppends(runId).before,
                ),
            }),
        ...(runSandbox === undefined ? {} : { sandbox: runSandbox }),
      }

      /**
       * **`--no-merge`, as the `human:` action it always was.**
       *
       * This is not a second mechanism (#20). It asks for the same
       * `signoff` a declared `human:` at `merge` asks for, and the way to
       * ask for it is to be one: `runActionPipeline` emits the event for a
       * `needs-approval` verdict, `endingOf` reads it as `held`, the pass stops,
       * and `outcomeOf` says `blocked`. A recipe that declares a person there holds
       * whether or not the flag was passed. And the hold is bound to `onSha` like
       * any other verdict, so a force-push invalidates it by arithmetic.
       *
       * Placed after the declared checks and before whatever lands, which is where
       * the old loop asked: the recipe's own actions run first and the flag holds
       * what they let past. `heldBeforeTheLane` is that placement.
       */
      const alsoHeldAtMerge = (): ActionPort[] => {
        const held: ActionPort[] = []
        // **Never re-asked on a continuation** (#465, 0120 §6's *Watch out*)
        // — `options.merge` belonged to the call that was asked, and the
        // approval this run is continuing from already answered the one
        // question `--no-merge` exists to hold.
        if (continuation === null && options.merge === false) {
          held.push(
            makeHumanAction({
              name: 'no-merge',
              question: `Merge ${branch} into ${attemptBase()}? Every step passed, and this run was asked not to merge.`,
            }),
          )
        }
        return held
      }

      /**
       * **What runs at a step the recipe says nothing about** — that step's
       * *default plugin*, and nothing else
       * ([0065](../../../doc/decisions-archive/0065-the-default-is-a-plugin.md) §2–3).
       *
       * The default is an entry in the plugin system rather than a code path
       * beside it: the workflow guarantees the ten steps turn and no step has a
       * built-in implementation, so the behaviour a recipe gets for free arrives
       * here by name and is replaceable by writing one line in the file.
       *
       * **`admit` is the first row, and `#268` is what put it here.** `admit`
       * used to cut the worktree in its body, from `branch.main` and
       * `repo.submodules`, where no recipe could see, name or replace it. Now the
       * body is empty and this is what an unconfigured `admit` runs — the same
       * action a declared `worktree:` builds, over the same values, because
       * `branchOf` and `submodulesOf` are the one place that knows where each is
       * written. So *the default cut* and *a pasted block that says what the
       * default did* are the same pass, which is what makes the block safe to
       * paste.
       *
       * **`merge` is the second row, and `#270` is what put it here.** It landed
       * the branch in its body, from `branch.main`, where no recipe could see, name
       * or replace it. Now the body is empty and this is what an unconfigured
       * `merge` runs — the same `integrate` call a declared `merge:` builds, over
       * the same base, because `land` above is handed the base by the pass rather
       * than reading one off the action (0061 §4). So *the default merge* and *a
       * pasted block that says what the default did* are the same landing.
       *
       * **`claim` is the third row to arrive and the first in the list, and `#269`
       * is what put it here.** The three paragraphs above are in the order the
       * tickets opened their keys; the branches below are in **step order**, which
       * is the order a reader of a pass meets them, and the two disagree only
       * because `claim` moved last. It took the item in its body, from `source:`
       * and `source.assignee`, where no recipe could see, name or replace it. Now
       * the body is empty and this is what an unconfigured `claim` runs — the same
       * action a declared `queue:` builds, over the same four values, because
       * `queueOf` is the one place that knows which spelling a file used. So *the
       * default take* and *a pasted block that says what the default did* select
       * over one list of kinds, which is what makes the block safe to paste.
       *
       * **`design` opened a key here and took no row, and that is the decision
       * rather than an omission** (`#265`). 0065 §4's table names *an `agent:`
       * that drafts* as its default, and what this step actually did was
       * `ports.draft` answering `{ document: "" }` — a port that dispatched
       * nothing, because no plugin served `design`. So the default *is* nothing,
       * and writing a drafting agent in here instead would not be moving the work
       * out of the body: it would buy an agent on every pass of every project
       * whose recipe never mentioned `design`, which is §7's footgun and not §2's
       * decision. A recipe that wants one writes it, and that is the capability
       * the key is for; the three rows below stay the three things that *did*
       * happen in a body.
       *
       * **And it is the one row that cannot be wrong loudly** (`#269`). A replaced
       * `admit` starts nothing and a replaced `merge` lands nothing, and each of
       * those shows on the card as a step that ran and a thing that did not happen.
       * A replaced `claim` cannot fail that way — `queue:` is the only kind legal
       * at this step and a second one is refused by name (`step-matrix.test.ts`),
       * so the substitution here is never *nothing takes the ticket*: it is **a
       * different four values taking a different ticket**, which looks like an
       * ordinary pass about an issue somebody did not expect, or like a machine
       * with nothing to do. There is no verdict that tells those apart, which is
       * why the accessors are the seam: a pasted block and an unpasted one reach
       * `runnableNow` through `queueOf`, and `lingtai add` reads the file back.
       *
       * **`[]` and an omitted key are the same thing here, and 0065 §2's *`[]`
       * runs nothing* is not built.** `StepMap` resolves both to `[]` (0061 §5:
       * *the file may omit a step; the resolved recipe may not*), so by the time a
       * list reaches this seam the difference is gone — the refusal that would
       * keep them apart belongs at resolve, on the file's own bytes, and 0065 §6
       * is where it is written down. Until it lands, an `admit: []` cuts and a
       * `merge: []` merges.
       *
       * **That is the safe direction and it is deliberate**, because the other
       * reading is 0065 §6's silent failure with this repository's own recipe as
       * the subject: `admit: []` and `merge: []` mean *skipped* in every recipe on
       * the machine today, and a diff that made the first mean *cut nothing* would
       * stop every pass at the first step that needs a tree, while the second
       * would stop merging in a daemon nobody had told to expect it. So the blocks
       * `#270` prints are safe to paste and safe not to paste, and the day `[]`
       * starts meaning nothing is a version bump and a refusal rather than a
       * change of behaviour under an unchanged file.
       *
       * **And a recipe that declares something *else* at `merge` no longer
       * lands**, which is the substitution rule doing exactly what it says (0065
       * §2) rather than a hole: the default is replaced, nothing in the list
       * merges, `landedAt()` stays null and the pass falls through to the
       * requeued or failed ending rather than reporting a landing it did not
       * make. A recipe that wants checks *and* the merge declares both, which is
       * what the printed block is for.
       */
      const defaultsAt = (step: Step): readonly ActionPort[] => {
        if (step === 'claim') {
          return [makeQueueAction({ name: DEFAULT_ACTION.claim, ...queueOf(recipe) }, { take })]
        }
        if (step === 'admit') {
          return [
            makeWorktreeAction(
              { name: DEFAULT_ACTION.admit, base: attemptBase(), submodules: submodulesOf(recipe) },
              { cut },
            ),
          ]
        }
        if (step === 'implement') {
          /**
           * **The agent that writes the change, where the recipe names none**
           * (0065 §1, `#266`).
           *
           * Unlike `design`, this row is not optional: the port it replaced
           * dispatched on every pass, so *behaves exactly as it does today* means
           * an unconfigured `implement` still buys the one agent — on
           * `runtime.agent`, which is what `dispatch` runs and what a recipe's own
           * `agent:` is held to by `agentRefusal` before the claim.
           *
           * `prompt: ""` because the implementer's brief is `options.prompt`,
           * rendered with the ticket and the design. A recipe's `prompt:` is
           * appended to that and never substituted for it — the rule the cold
           * reviewer follows — so the default adding nothing is the default
           * changing nothing.
           */
          return [makeWorkAction({ name: DEFAULT_ACTION.implement, prompt: '' }, workPort)]
        }
        if (step === 'merge') {
          // The strategy `mergePlugin`'s schema defaults to, because `integrate`
          // offers one — and no base, for the reason that plugin declares none:
          // the base is one value that flows, and `land` above already has it, so
          // *the default merge* and *a pasted block that says what the default
          // did* cannot land onto different branches (0061 §4).
          return [makeMergeAction({ name: DEFAULT_ACTION.merge, strategy: 'merge-commit' }, { land })]
        }
        return []
      }

      const actionsAt = (step: Step, actions: readonly StepAction[]): readonly ActionPort[] => {
        // The base is the attempt's, asked when the step runs: `stepDeps` is built before a claim has decided it.
        const declared = actionPortsFromRecipe(step, actions, { ...stepDeps, base: attemptBase() })
        // **A default replaces what would have run; a hold composes with it**
        // (0065 §3). That is why `alsoHeldAtMerge` stays outside the substitution
        // and composes either way: `--no-merge` holds a recipe that declares
        // nothing at `merge` exactly as it holds one that declares a person.
        const running = declared.length > 0 ? declared : defaultsAt(step)
        return step === 'merge' ? heldBeforeTheLane(running) : running
      }

      /**
       * **Where a hold at `merge` goes once the lane is in the list** (`#270`).
       *
       * It was `[...running, ...alsoHeldAtMerge()]`, and that was right while the
       * landing happened in `merge`'s *body* — after the whole pipeline, so an
       * appended hold stopped it. Since `mergePlugin` serves `merge` the landing is
       * an action in this list, and appending after it is `#58` again: the
       * pipeline would merge the branch and then ask a person whether to.
       *
       * So the hold goes **after everything that checks and before the thing that
       * lands**, which is the same sentence the old order was saying. `--no-merge`
       * is what catches getting it backwards, and it does: with nothing declared
       * the list is the hold and then the lane, and the integrator is never
       * reached (`conduct-a-whole-attempt.test.ts`).
       *
       * Found by `kind` rather than by position, because a recipe may declare its
       * own `merge:` with checks written **before** the lane — and a `--no-merge`
       * that was a no-op for such a recipe would be a flag that silently stopped
       * meaning anything. Before, and not either side: `actionsAt` refuses anything
       * written after the lane (0065 §8), so the list this searches is checks and
       * then the lane, and the index it finds is the last entry or nothing.
       */
      const heldBeforeTheLane = (running: readonly ActionPort[]): readonly ActionPort[] => {
        const held = alsoHeldAtMerge()
        if (held.length === 0) return running
        const lands = running.findIndex((action) => action.kind === 'merge')
        return lands === -1 ? [...running, ...held] : [...running.slice(0, lands), ...held, ...running.slice(lands)]
      }

      /**
       * Every event the pipeline produces, in order, before the next action
       * starts — and since `#502` the `StepStarted`/`StepEnded` pair
       * `runStep` writes around it (`AttemptEvent`).
       *
       * On the run's own stream, which is where every verdict has always gone. The
       * pipeline does not touch the store and neither does the pass, for the reason
       * `PipelineOptions` gives — *an action that ran but whose verdict was never
       * recorded is the failure this design exists to remove.*
       */
      const emit = (event: AttemptEvent): Effect.Effect<number> =>
        Effect.suspend(() => {
          // An action's dispatch bills through here (`runActionPipeline`), not `runSpentFrom`.
          if (event.type === 'RunSpent') {
            const costUsd = (event.data as { costUsd?: number | null }).costUsd
            if (costUsd === null || costUsd === undefined) spent.unknown += 1
            else spent.usd += costUsd
          }
          // The version it landed at, which is what a `PassRouted` names (#931).
          return appendNow(runId, [
            {
              type: event.type,
              actor: 'conductor',
              data: parsePayload(event.type, event.data),
            } as ToAppend,
          ])
        })

      /**
       * `implement`, the first time — the hook, the agent, and the receipt.
       *
       * Three ways not to pass and the money is why they are three (0057 §2, 0031
       * §3): **asked** buys a decision at `proposed`; **started and left no
       * receipt** buys nothing and stands the pass down, the commit being the
       * receipt; **never started** stands the *conductor* down, because what it met
       * is about the account rather than the diff.
       *
       * **The hook is proven to fail closed before anything is dispatched.** A hook
       * that fails *open* records nothing and says nothing, which is the one failure
       * the whole hook exists to prevent. A hook that will not is reported as a
       * `did-not-finish` rather than released back to the queue: it is a fact about
       * this machine, and another pass meets it identically — so the honest answer
       * is a person, not the queue.
       *
       * **And the receipt is measured from where the tree stands now, not from
       * where it was cut** (`#265`). See `startedAt` below.
       */
      /**
       * **A recipe's `prompt:` at `implement`, appended and never substituted**
       * (`#266`) — the rule `buildDesignPrompt` and `createAgentAction` already
       * follow, and the same heading, so an agent meets one convention.
       *
       * A project can add what it cares about; it cannot remove the ticket, the
       * design, or the refusal a round was bought on. `""` — which is what
       * `defaultsAt` writes — adds nothing at all, so a recipe that declares
       * nothing gets the prompt it got before this key existed, byte for byte.
       */
      const alsoText = (extra: string): string => `\n\n## Also for this project\n\n${extra}\n`

      const firstDispatch = (brief: Brief, spec: WorkDispatch): Effect.Effect<Worked> =>
        Effect.gen(function* () {
          const tree = cutTree()
          inConflictRound = false
          /**
           * **Where this agent found the tree** — and the whole of what the receipt
           * below is measured against (`#265`).
           *
           * It was `tree.baseSha`, which is the same commit for as long as `implement`
           * is the first step that may write one. `design` may since `agentPlugin`
           * declared it: a recipe's drafting agent runs in *this* worktree, unhooked
           * and writable, and a document it committed there would move `HEAD` past the
           * base before this is called. `tree.baseSha` then reads *something was
           * committed* for a run that committed nothing, which is 0057 §2's one guard
           * answering about the wrong agent — and the pass would go to `build` and
           * `review` on a branch holding a design note and no implementation, with
           * `RunProposedCompletion` naming the drafting agent's commit as this run's.
           *
           * So it is asked rather than assumed, which is what `fixRound` already does
           * one function down: it compares against `brief.context.onSha`, *the head
           * this round is about*, for this reason a round earlier. The prompt telling a
           * design agent not to commit stays where it is and is not what makes this
           * true: prose in a prompt is not a guard, and the agent that ignores it is
           * exactly the one the guard is for.
           */
          // **Each agent is measured from where it first found the tree** (#1245): a step redone whole runs every
          // agent again, and one that finished before the cut-off must still find its own work counted. An agent
          // that never ran before has no entry, and finds the tree as the one before it left it.
          const startKey = `${brief.context.onSha}:${spec.name}`
          const earlierStart = brief.context.rerun === undefined ? undefined : agentStarts.get(startKey)
          // **A continuation's first agent starts where the log says the step began** (#1246): this process has
          // no `agentStarts`, and the re-cut head already holds the WIP a redone `implement` is measured against.
          const carried = firstStartOf(brief.context) === null ? brief.context.redo?.startedAt : undefined
          const startedAt = earlierStart ?? carried ?? (yield* gitOrDieEffect(['rev-parse', 'HEAD']))
          if (!agentStarts.has(startKey)) agentStarts.set(startKey, startedAt)
          const redoNote = yield* redoNoteOf(brief.context, startedAt)
          const implementDecision = yield* decideSandbox
          const wired = yield* Effect.result(
            host.wire({
              runId,
              hookBinary: options.hookBinary,
              home,
              ...(implementDecision.kind === 'sandboxed' ? { sandboxed: true } : {}),
            }),
          )
          if (Result.isFailure(wired)) return { stopped: `the hook was not wired: ${wired.failure.detail}` }
          const wiring = wired.success

          const smoke = yield* Effect.result(host.smokeTest(options.hookBinary, runBinary))
          if (Result.isFailure(smoke)) {
            return { stopped: `the hook's smoke test did not run: ${smoke.failure.detail}` }
          }
          if (!smoke.success.ok) return { stopped: `the hook did not fail closed: ${smoke.success.detail}` }

          // The action's own bound where it declared one (`#314`). A fix round is
          // this same `implement` entry again, so a narrowed `implement` bounds the
          // rounds too — which is what makes `attemptCeiling`'s *then N round(s)*
          // arithmetic true of the narrowed figure rather than of the ceiling.
          const spend = spendFor(spec.limits)
          const dispatched = runtimeNamed(spec.agent ?? options.runtime.capabilities.id)
          const agentEnv = runnableEnv({ ...env.values, ...wiring.env })
          // The session id derives from this, never the stream's `runId` (#1201).
          const dispatchId = rerunId(runId, brief.context)
          const spawned = dispatched.invocation?.({
            runId: dispatchId,
            cwd: tree.path,
            settingsPath: wiring.settingsPath,
            env: agentEnv,
            limits: spend,
          })

          const ran = yield* Effect.result(
            Effect.scoped(
              Effect.gen(function* () {
                const server = yield* host.serve({
                  socketPath: wiring.socketPath,
                  store,
                  onDecision: (_r, hook, verdict, call) =>
                    runLog.note(call.tool === '' ? hook : call.tool, `${verdict.padEnd(6)}${call.target}`),
                  onLifecycle: (_r, hook) => runLog.note('hook', hook),
                })
                hookRuns = server

                yield* appendNow(runId, [
                  {
                    type: 'RunStarted',
                    actor: 'conductor',
                    data: parsePayload('RunStarted', {
                      ticketId,
                      // **The runtime that actually ran, not the pass's
                      // default** (`#314`). This field answers *which runtime
                      // wrote this*, and a step naming a second one makes the
                      // default a wrong answer to it. No schema change and no
                      // upcaster: the field exists and `model` beside it
                      // already carries the recipe's, or `""`.
                      runtime: dispatched.capabilities.id,
                      // The recipe's `model:` where it named one, and the
                      // runtime's own default where it did not (0063 §2) —
                      // which is what the empty string has always meant here.
                      model: spec.model ?? '',
                      promptVersion: next.version,
                      baseSha: tree.baseSha,
                      configHash: resolved.configHash,
                      worktree: tree.path,
                      invocation: spawned ? { command: spawned.command, args: [...spawned.args], limits: spend } : null,
                    }),
                  },
                ])
                yield* appendNow(runId, [
                  {
                    type: 'StepsResolved',
                    actor: 'conductor',
                    data: parsePayload('StepsResolved', stepsResolved(runId, resolved)),
                  },
                ])

                // **The implementer's prompt, recorded by the conductor before the
                // hook server learns the run** (#928, 0100 §14). `register` reads
                // the stream's length for the hook's expected version, so this is
                // awaited first and never after: a `RunPrompted` appended later
                // would make the hook's next append a `ConcurrencyError`. The hook
                // appends no prompt of its own.
                // A run an account limit cut off is handed its recorded brief again (#1205).
                const recordedBrief =
                  brief.context.recorded?.name === spec.name ? (brief.context.recorded.prompt ?? null) : null
                const implementerParts: RecordPart[] =
                  recordedBrief !== null
                    ? [withRedoParagraph(recordedBrief, redoNote)]
                    : afterOpeningLines(
                        renderPromptParts(
                          options.prompt,
                          { number: Number(brief.ticket.ref), title: brief.ticket.title, body: brief.ticket.body },
                          buildCommands(recipe.steps),
                          next.failure,
                          // **What `design` produced, and this is the one reader of
                          // it** (`#265`). `agentPlugin` serves the step: a recipe
                          // declaring an `agent:` there buys a document, and a document
                          // nothing hands on is an agent run whose answer no reader ever
                          // sees. `""` renders as it always did.
                          //
                          // **The document and not the locator** (`#297`). The built-in
                          // dispatch fetches nothing, so it renders the copy the pass is
                          // already holding and never learns what kind of string
                          // `TheDesign.locator` is (0066 §4). A plugin at `implement`
                          // that wants the location reads it off `context.design` itself.
                          brief.design.document,
                          took?.claimVersion === undefined || took.ticket !== brief.ticket
                            ? {}
                            : { bodyAt: { stream: took.ticketId, version: took.claimVersion } },
                        ),
                        // The recipe's own words at `implement` (`#266`), the split paragraph and the redo
                        // note are instructions, so they go right after the opening lines, ahead of the
                        // ticket (#1404).
                        [
                          ...(spec.prompt === '' ? [] : [alsoText(spec.prompt)]),
                          ...(reduced.split === null
                            ? []
                            : [
                                splitReturnParagraph(
                                  splitRead ??
                                    reduced.split.children.map((c) => ({
                                      number: c.number,
                                      title: null,
                                      stateReason: null,
                                    })),
                                  doneWhenItems(brief.ticket.body),
                                ),
                              ]),
                          ...(redoNote === null ? [] : [`${redoNote}\n\n`]),
                        ],
                      )
                const implementerFor = {
                  _tag: 'Action' as const,
                  step: 'implement' as const,
                  name: spec.name,
                  round: 0,
                }
                const implementerVersion = yield* runtimeVersionOfEffect(dispatched, agentEnv, tree.path)
                yield* Effect.promise(() =>
                  recordPrompt(
                    store,
                    runId,
                    {
                      for: implementerFor,
                      promptVersion: next.version,
                      runtimeVersion: implementerVersion,
                      prompt: implementerParts,
                    },
                    log,
                  ),
                )

                yield* Effect.acquireRelease(
                  Effect.promise(() => store.read(runId).then((events) => server.register(runId, events.length))),
                  () => Effect.sync(() => void server.unregister(runId)),
                )

                // **An agent is running, and nothing else has judged the tree
                // it leaves behind** (`#468`). Cleared below the moment this
                // dispatch returns with a commit; left standing on every other
                // return so a crash or an interruption between here and there
                // still keeps a dirty tree rather than losing it with the
                // worktree.
                stoppedBy = 'interrupted'
                // The run's own interruption waits for the agent to stop before
                // the socket's scope closes (#1043).
                const outcome = yield* dispatched.run({
                  ...(brief.context.signal === undefined ? {} : { signal: brief.context.signal }),
                  runId: dispatchId,
                  cwd: tree.path,
                  prompt: implementerParts.map((part) => (typeof part === 'string' ? part : part.text)).join(''),
                  ...(spec.model === undefined ? {} : { model: spec.model }),
                  settingsPath: wiring.settingsPath,
                  log: runLog,
                  env: agentEnv,
                  limits: spend,
                  ...(yield* sandboxOf(
                    implementDecision,
                    { runId: dispatchId, worktree: tree.path },
                    { stream: runId, step: 'implement', action: spec.name, runtime: dispatched.capabilities.id },
                  )),
                })
                yield* Effect.promise(() => server.flush(runId).catch(() => {}))
                return { outcome, version: server.get(runId)?.version ?? 1 }
              }),
            ),
          )
          if (Result.isFailure(ran)) {
            return { stopped: `the hook socket was not served: ${ran.failure.detail}` }
          }
          const { outcome, version } = ran.success

          if (outcome.failure) {
            runLog.note('run', `failed — ${outcome.failure.kind}: ${outcome.failure.detail}`)
            // **Both, for a run stopped at a ceiling, whose receipt is its spend.**
            // A `RunFinished` there is not a contradiction: turns were taken and
            // money was spent, and the ending is what `RunFailed` says. True of
            // `out-of-usd` for the same reason it is of `out-of-turns` (`#370`).
            const receipt: ToAppend[] =
              outcome.failure.kind === 'out-of-turns' || outcome.failure.kind === 'out-of-usd'
                ? [
                    {
                      type: 'RunFinished',
                      actor: 'conductor',
                      data: parsePayload('RunFinished', {
                        exitCode: outcome.exitCode ?? 1,
                        turns: outcome.turns,
                        durationMs: outcome.durationMs,
                        costUsd: outcome.costUsd,
                        ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
                      }),
                    },
                  ]
                : []
            yield* appendFrom(runId, version, [
              ...receipt,
              {
                type: 'RunFailed',
                actor: 'conductor',
                data: parsePayload('RunFailed', outcome.failure),
              },
              runSpentFrom(
                outcome,
                { _tag: 'Action', step: 'implement', name: spec.name, round: 0 },
                dispatched.capabilities.id,
              ),
            ])
            if (outcome.failure.kind === 'never-started') {
              // That agent touched nothing, so there is nothing in the worktree
              // it could have left dirty — `interrupted` does not stand for it.
              stoppedBy = null
              return {
                neverStarted: {
                  agent: dispatched.capabilities.id,
                  detail: outcome.failure.detail,
                },
              }
            }
            // Every other failure kind is an agent that was running and stopped
            // mid-run (`#468`): `interrupted`, set before the dispatch above, is
            // replaced with the runtime's own word for why.
            stoppedBy = outcome.failure.kind
            // Kept now, on `HEAD`, before any step after this one reads the worktree (`#1243`).
            yield* keepUncommittedWork()
            const cause = outcome.failure.kind
            // What the cut-off run left, WIP included, so the stored outcome keeps the receipt (#1250).
            const left = yield* gitOrDieEffect(['rev-parse', 'HEAD'])
            const kept = left === startedAt ? {} : { head: left }
            // **An abnormal ending is decided like any other outcome** (0108 §21): a budget or a wall is
            // `AgentFailed`, redone by rule. A crash keeps its cell, which `rerunInPlace` redoes.
            const failedRun =
              cause === 'crash' || cause === 'no-commits' || cause === 'no-structured-answer'
                ? null
                : decideImplementOutcome({
                    declared: null,
                    endedAbnormally: true,
                    startedAt,
                    head: left,
                    findingsOffered: 0,
                  })
            if (failedRun !== null) {
              return {
                stopped: `${outcome.failure.kind}: ${outcome.failure.detail}`,
                declared: failedRun,
                ...kept,
              }
            }
            return {
              ...kept,
              stopped: `${outcome.failure.kind}: ${outcome.failure.detail}`,
              // Neither word is one this dispatch's own runtime ever reports
              // (`no-commits` is `head === startedAt`'s own check, two lines
              // down; `no-structured-answer` is the reviewer's flag, never
              // this agent's), so excluding them costs nothing and keeps the
              // field typed to `#466`'s five.
              ...(cause === 'no-commits' || cause === 'no-structured-answer' ? {} : { interrupted: cause }),
            }
          }

          yield* appendFrom(runId, version, [
            {
              type: 'RunFinished',
              actor: 'conductor',
              data: parsePayload('RunFinished', {
                exitCode: outcome.exitCode ?? 0,
                turns: outcome.turns,
                durationMs: outcome.durationMs,
                costUsd: outcome.costUsd,
                ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
              }),
            },
            runSpentFrom(
              outcome,
              { _tag: 'Action', step: 'implement', name: spec.name, round: 0 },
              dispatched.capabilities.id,
            ),
          ])
          log(`run finished: ${outcome.turns} turns, ${spentWords(outcome.costUsd)}`)
          runLog.note('run', `finished: ${outcome.turns} turns, ${spentWords(outcome.costUsd)}`)

          const head = yield* gitOrDieEffect(['rev-parse', 'HEAD'])
          // **The commit is the receipt** (0057 §2), and it is *this* agent's commit:
          // `startedAt` and not `tree.baseSha`, so a step before this one that left a
          // commit of its own cannot stand in for one. An agent that ran and committed
          // nothing left no receipt, and the pass stops rather than buying a round to
          // fix a diff that does not exist.
          // **What the agent declared decides, and the head only corrects it** (0108 §21, #1250): an
          // `Implemented` that moved nothing is `AgentFailed`, and so is a final message that declared
          // nothing parseable. The sha it is measured from is the step's first start, never this run's.
          // **`AlreadyDone` is decided against the body this attempt claimed** (#1251): the text the prompt pasted,
          // read from this pass's own claim and never fetched again, and its version is that claim's. Without a
          // version the check could not name what it read, so it is not offered.
          const claimedBody = took?.ticket.body ?? brief.ticket.body
          const claimedAt = took?.claimVersion
          const read = parseImplementOutcome(outcome.text ?? null)
          if (read !== null && read.form !== 'fence') runLog.note('outcome', outcomeFormNote(read.form))
          const decidedRaw = decideImplementOutcome({
            declared: read?.declared ?? null,
            endedAbnormally: false,
            startedAt,
            head,
            findingsOffered: 0,
            doneWhen: doneWhenItems(claimedBody),
            offersAlreadyDone: claimedAt !== undefined,
          })
          const decided: ImplementOutcome =
            decidedRaw._tag === 'AlreadyDone' && claimedAt !== undefined
              ? { ...decidedRaw, baseSha: continuation?.diffBaseSha ?? tree.baseSha, bodyVersion: claimedAt }
              : decidedRaw._tag === 'AgentFailed' && read === null
                ? withUnreadTail(decidedRaw, outcome.text ?? null)
                : decidedRaw
          const moved = head !== startedAt
          // `keepUncommittedWork` still reads *no commits* where nothing moved (#1243).
          stoppedBy = decided._tag === 'AgentFailed' ? 'agent-failed' : moved ? null : 'no-commits'
          if (moved) yield* recordDiff(branch, head)
          // Completion is proposed only for what the agent declared `Implemented`; a run that is
          // `AgentFailed` or `Unclear` has not offered finished work, and no check follows it.
          if (decided._tag === 'Implemented') {
            yield* appendNow(runId, [
              {
                type: 'RunProposedCompletion',
                actor: 'conductor',
                data: parsePayload('RunProposedCompletion', { headSha: head }),
              },
            ])
          }
          if (decided._tag !== 'Implemented') {
            // A normal `AgentFailed` ending is redone and the redo resets, so what it left uncommitted
            // is kept first, as an abnormal stop's is (0108 §20, #1276).
            let kept: { head?: string } = moved ? { head } : {}
            if (decided._tag === 'AgentFailed') {
              yield* keepUncommittedWork()
              const left = yield* gitOrDieEffect(['rev-parse', 'HEAD'])
              kept = left === startedAt ? {} : { head: left }
            }
            return {
              stopped: (outcome.text ?? '').trim().slice(0, 8_000),
              declared: decided,
              ...kept,
            }
          }
          return { committed: head }
        })

      /**
       * `implement`, a second time — **and the round was already bought.**
       *
       * `proposed` decided this, `offerFor` had already counted, and neither
       * decision is re-made here: what arrives is `Brief.again`, which is the
       * judge's own words plus the criterion the round was bought on. `fixBrief` is
       * what turns that into a prompt, unchanged, and the three shapes it takes are
       * read off the arrival rather than off a `FixOn` somebody passed down —
       * findings on `context.recheck` (0038 §2), the lane's paths from a `merge`
       * that refused, and a command's own output for everything else.
       *
       * **`FixRequested` is gone (#502): the route that bought this round
       * already said so.** `PassRouted{next: {_tag: 'FixRefusal', round}}` is
       * appended by `routeProposal` before this is ever called, and carries
       * `from`/`round` already — a second event naming the same decision
       * would be the round's own fact told twice.
       */
      const fixRound = (brief: Brief, again: NonNullable<Brief['again']>, spec: WorkDispatch): Effect.Effect<Worked> =>
        Effect.gen(function* () {
          // The same entry's runtime and bound as the run it is a round of: a fix
          // is `implement` again, and buying it from a different agent than the one
          // that wrote the code would be a warm review's mistake spelled backwards.
          const dispatched = runtimeNamed(spec.agent ?? options.runtime.capabilities.id)
          const tree = cutTree()
          const round = brief.context.round ?? 1
          const findings = brief.context.recheck ?? []
          const from = again.printed?.step ?? 'proposed'
          const said = again.printed?.detail ?? again.asked ?? again.why
          // A conflict is briefed on the conflict first, and a passing review's open
          // findings follow it as context (#1119). Keyed on the lane's own reason
          // and not on `from` alone: a `verify-failed` or `push-rejected` also
          // arrives from `merge`, and is output, not a merge to run.
          const conflict = from === 'merge' && again.printed?.because === 'conflict'
          // The count said against the knob's own bound: a conflict resolution is counted
          // apart from the refusal fixes, as it is bounded apart from them (0108 §8).
          const counted = conflict ? (brief.context.conflictRound ?? 1) : round
          // A conflict round of any kind, including a granted one from an old wait whose brief
          // tells the agent to merge: it may leave a merge standing, so the keep checks (#1120).
          inConflictRound = conflict
          // The merge the conductor stood up before this agent started (#1120); read from the
          // context the round was dispatched with, which the route may clear for the next lap.
          const mergeAsked = conflict ? brief.context.conflictMerge : undefined
          // What each side did to the conflicted paths, read before the dispatch (#1121).
          const landed =
            mergeAsked === undefined
              ? undefined
              : yield* landedOnBaseRead({
                  paths: mergeAsked.paths,
                  fromSha: mergeAsked.fromSha,
                  toSha: mergeAsked.baseSha,
                  conflicted: mergeAsked.paths,
                  ...(mergeAsked.branchSha === undefined ? {} : { branchSha: mergeAsked.branchSha }),
                })
          const merge =
            mergeAsked === undefined ? undefined : { ...mergeAsked, ...(landed === undefined ? {} : { landed }) }
          const refusal = conflict
            ? ({
                on: 'conflict',
                base: attemptBase(),
                paths: said,
                findings,
                ...(merge === undefined ? {} : { merged: merge }),
              } as const)
            : findings.length > 0
              ? ({ on: 'findings', findings } as const)
              : ({ on: 'output', output: said } as const)
          // How many findings the fixer is shown, which is the range a `Disputed` may name: a
          // refusal that is one command's output, or a merge's, is finding 1 (#1250).
          const offered =
            refusal.on === 'output'
              ? 1
              : refusal.on === 'conflict'
                ? Math.max(1, refusal.findings.length)
                : refusal.findings.length

          // Keyed on where the fix came from and not on `refusal`: a conflict round
          // keeps its own session id whichever brief it was given.
          const fixId = rerunId(
            from === 'merge'
              ? `${runId}:fix:${round}:merge:${continuation?.resumedWaitId ?? 'start'}:${++conflictFixes}`
              : `${runId}:fix:${round}`,
            brief.context,
          )

          // A conflict resolution is bounded by its own knob, never the refusal fixes' (0108 §8).
          const bound = conflict ? ceiling.attempt.conflictResolutions : ceiling.attempt.refusalFixes
          log(`fixing ${from} — round ${counted} of ${bound}`)
          runLog.note('fix', `round ${counted} for ${from}`)

          const fixDecision = yield* decideSandbox
          // **Wired per round, as the first dispatch is** (#1346): a fix round is the run's own next round,
          // not an agent beside it, so it reports under the attempt's run (`runId`, never `fixId`) and serves
          // its own socket — the first dispatch's scope closed when it returned. A conflict round shares this.
          const fixWired = yield* Effect.result(
            host.wire({
              runId,
              hookBinary: options.hookBinary,
              home,
              ...(fixDecision.kind === 'sandboxed' ? { sandboxed: true } : {}),
            }),
          )
          if (Result.isFailure(fixWired)) return { stopped: `the hook was not wired: ${fixWired.failure.detail}` }
          const wiring = fixWired.success
          const fixSmoke = yield* Effect.result(host.smokeTest(options.hookBinary, runBinary))
          if (Result.isFailure(fixSmoke)) {
            return { stopped: `the hook's smoke test did not run: ${fixSmoke.failure.detail}` }
          }
          if (!fixSmoke.success.ok) return { stopped: `the hook did not fail closed: ${fixSmoke.success.detail}` }

          // The merge-base with the base, so a base merge anybody made is not the
          // ticket's change (#937). The fallback is never `tree.baseSha` alone once
          // there is a continuation — see `baseShaOr`'s own comment.
          // The reviewer's own spelling (`DIFF_FLAGS`), as `fixBrief`'s doc says the
          // two should be looking at the same change, and the two shas it ran between.
          // A step redone whole (#1245) reads the diff as it stands at the head it was reset to.
          const underReview = yield* changeStart(continuation?.diffBaseSha ?? tree.baseSha).pipe(
            Effect.flatMap((start) => diffBetween(start)),
          )
          const redoNote = yield* redoNoteOf(brief.context, brief.context.redo?.startedAt ?? brief.context.onSha)
          // The same flag `firstDispatch` sets before its own dispatch, and for
          // the same reason (`#468`): an agent is running, and nothing has
          // judged what it leaves in the worktree if it is interrupted here.
          stoppedBy = 'interrupted'
          // The brief and the `for`, built once: each is recorded before the dispatch
          // and then handed to it / to the `RunSpent` below (#923).
          const recordedFix =
            brief.context.recorded?.name === spec.name ? (brief.context.recorded.prompt ?? null) : null
          const fixParts: RecordPart[] =
            recordedFix !== null
              ? [withRedoParagraph(recordedFix, redoNote)]
              : [
                  ...fixBriefParts({
                    refusal,
                    round: counted,
                    of: bound,
                    action: from,
                    diff: underReview.text,
                    ...(underReview.from === null || underReview.to === null
                      ? {}
                      : { diffAt: { from: underReview.from, to: underReview.to } }),
                    diffBytes: recipe.runtime.budget.diff,
                    checks: buildCommands(recipe.steps),
                    ticket: {
                      title: brief.ticket.title,
                      body: brief.ticket.body,
                      ...(took?.claimVersion === undefined || took.ticket !== brief.ticket
                        ? {}
                        : { bodyAt: { stream: took.ticketId, version: took.claimVersion } }),
                    },
                    ...(continuation?.advice === undefined ? {} : { advice: continuation.advice }),
                    ...(again.objection != null
                      ? { overruled: { objection: again.objection, ruling: again.why } }
                      : continuation?.declined === undefined
                        ? {}
                        : { declined: continuation.declined }),
                    // Placed by the brief itself, ahead of the long parts (#1404), and still as parts,
                    // so no recorded offset depends on where the text before them happened to end.
                    redo: redoNote,
                    also: spec.prompt,
                  }),
                ]
          const fixPrompt = fixParts.map((part) => (typeof part === 'string' ? part : part.text)).join('')
          const fixFor: SpentFor = {
            _tag: 'Action',
            step: 'implement',
            name: spec.name,
            round,
            // The lap a person's grant paid for is capped at one round
            // (`runAttempt`'s `roundLimit`), so this is that round.
            ...(continuation?.grant && !('byTriage' in continuation && continuation.byTriage)
              ? { grant: continuation.resumedWaitId }
              : {}),
          }
          const fixEnv = runnableEnv({ ...env.values, ...wiring.env })
          const fixVersion = yield* runtimeVersionOfEffect(dispatched, fixEnv, tree.path)
          yield* Effect.promise(() =>
            recordPrompt(
              store,
              runId,
              { for: fixFor, promptVersion: `fix@${fixPrompt.length}`, runtimeVersion: fixVersion, prompt: fixParts },
              log,
            ),
          )
          // Only a defect is the made-up crash outcome; an interruption stays one.
          // The run's own interruption waits for the agent to stop before it continues.
          const fixSandbox = yield* sandboxOf(
            fixDecision,
            { runId: fixId, worktree: tree.path },
            { stream: runId, step: 'implement', action: spec.name, runtime: dispatched.capabilities.id },
          )
          const fixRan = yield* Effect.result(
            Effect.scoped(
              Effect.gen(function* () {
                const server = yield* host.serve({
                  socketPath: wiring.socketPath,
                  store,
                  onDecision: (_r, hook, verdict, call) =>
                    runLog.note(call.tool === '' ? hook : call.tool, `fix:${round} ${verdict.padEnd(6)}${call.target}`),
                  onLifecycle: (_r, hook) => runLog.note('hook', `fix:${round} ${hook}`),
                })
                hookRuns = server
                // After `recordPrompt`: `register` reads the stream's length (#928).
                yield* Effect.acquireRelease(
                  Effect.promise(() => store.read(runId).then((events) => server.register(runId, events.length))),
                  () => Effect.sync(() => void server.unregister(runId)),
                )
                const result = yield* dispatched
                  .run({
                    ...(brief.context.signal === undefined ? {} : { signal: brief.context.signal }),
                    runId: fixId,
                    cwd: tree.path,
                    prompt: fixPrompt,
                    ...(spec.model === undefined ? {} : { model: spec.model }),
                    settingsPath: wiring.settingsPath,
                    log: taggedTrace(runLog, `fix:${round}`),
                    traceTools: true,
                    env: fixEnv,
                    limits: spendFor(spec.limits),
                    ...fixSandbox,
                  })
                  .pipe(
                    Effect.catchDefect((err) =>
                      Effect.succeed({
                        exitCode: null,
                        turns: 0,
                        durationMs: 0,
                        costUsd: null,
                        failure: { kind: 'crash' as const, detail: (err as Error).message },
                        text: null,
                        sessionId: '',
                        usage: undefined,
                      }),
                    ),
                  )
                // A flush that fails loses the round's `RunTouchedFile` rows: stop the pass, never record a clean round.
                yield* Effect.tryPromise({
                  try: () => server.flush(runId),
                  catch: (err) => ({ detail: `flushing the round's hook events failed: ${(err as Error).message}` }),
                })
                return result
              }),
            ),
          )
          if (Result.isFailure(fixRan)) {
            return { stopped: `the hook socket was not served: ${fixRan.failure.detail}` }
          }
          const fixed = fixRan.success

          const after = yield* gitOrDieEffect(['rev-parse', 'HEAD'])
          // A redone round is measured from where it first began, never the re-cut head (#1246).
          const committed = after !== (brief.context.redo?.startedAt ?? brief.context.onSha)

          // A judge or a person reads this verdict, not a transcript — bounded the
          // same way claude-code.ts clips a crash's `detail`. Carried as `stopped`
          // below on a decline, so the fixer's own words reach `StepEnded`'s
          // evidence directly: `FixApplied.said` was the only place they used to
          // land, and `#502` drops that event.
          const FIX_SAID_MAX_CHARS = 500
          const fixSaid = fixed.text === null ? null : fixed.text.slice(0, FIX_SAID_MAX_CHARS)

          // **`FixApplied` is gone (#502): `StepEnded`'s own outcome carries the
          // round's commit and evidence now** — `runStep`'s wrapper around this
          // dispatch writes it once the pipeline reads `fixed` back through
          // `actionOf`/`outcomeOf`. `RunSpent` is still this dispatch's own, since
          // spend is never reduced into a step's own outcome (0110).
          yield* appendNow(runId, [runSpentFrom(fixed, fixFor, dispatched.capabilities.id)])
          runLog.note(
            'fix',
            `round ${round}: ${committed ? after.slice(0, 7) : 'no commit'}` +
              ` · ${fixed.turns} turns, ${fixed.costUsd ?? 'unknown'} usd` +
              (fixed.failure ? ` · ${fixed.failure.kind}` : ''),
          )

          if (fixed.failure?.kind === 'never-started') {
            // Whose wall it was, for the sentence the pause carries (`fixWall`).
            fixWall = { action: from, round }
            // That agent touched nothing either, for `firstDispatch`'s own reason.
            stoppedBy = null
            return {
              neverStarted: { agent: dispatched.capabilities.id, detail: fixed.failure.detail },
            }
          }
          // **A fixer that committed and was then cut off by a crash** is still cut off
          // (#1201, #1249): the walk reruns it in place, so the commit is not the end of the round.
          const cutOffTransient = fixed.failure?.kind === 'crash'
          // **Nor a fixer that committed and then met the account's wall** (#1205): it is released `AccountLimit`
          // at the ending like any run the wall cut off, never walked on to a review.
          const cutOffByWall = fixed.failure?.kind === 'crash' && wallOf(fixed.failure.detail) !== null
          // **What the fixer declared decides, and the head only corrects it** (#1250), for a run that
          // ended normally. One cut off keeps the cells above: `interrupted` names the runtime's cause.
          const roundStart = brief.context.redo?.startedAt ?? brief.context.onSha
          // **A fixer cut off by its budget is `AgentFailed`, whatever it committed first** (0108 §21,
          // #1250): the commit is not the end of the round. A crash keeps its cell, which the walk reruns.
          const failedKind = fixed.failure?.kind
          const budgetEnded =
            failedKind !== undefined &&
            failedKind !== 'crash' &&
            failedKind !== 'no-commits' &&
            failedKind !== 'no-structured-answer'
          const readFix = fixed.failure == null ? parseImplementOutcome(fixed.text) : null
          if (readFix !== null && readFix.form !== 'fence') runLog.note('outcome', outcomeFormNote(readFix.form))
          const decidedFixRaw =
            fixed.failure == null || budgetEnded
              ? decideImplementOutcome({
                  declared: readFix?.declared ?? null,
                  endedAbnormally: budgetEnded,
                  startedAt: roundStart,
                  head: after,
                  findingsOffered: offered,
                })
              : null
          const decidedFix =
            decidedFixRaw !== null && decidedFixRaw._tag === 'AgentFailed' && fixed.failure == null && readFix === null
              ? withUnreadTail(decidedFixRaw, fixed.text)
              : decidedFixRaw
          if (
            !committed ||
            cutOffTransient ||
            cutOffByWall ||
            budgetEnded ||
            (decidedFix !== null && decidedFix._tag !== 'Implemented')
          ) {
            // A decline judged the findings or the refusal rather than being cut
            // off mid-run, so `interrupted` does not stand for it either; a
            // crash or a wall does, in the runtime's own word for it (`#468`).
            stoppedBy = fixed.failure ? fixed.failure.kind : decidedFix?._tag === 'AgentFailed' ? 'agent-failed' : null
            yield* keepUncommittedWork()
            const cause = fixed.failure?.kind
            // The head the round left, WIP included, kept on the stored outcome (#1250).
            const left = yield* gitOrDieEffect(['rev-parse', 'HEAD'])
            const kept = left === roundStart ? {} : { head: left }
            return {
              ...kept,
              stopped: fixed.failure
                ? `the fixing agent did not finish (${fixed.failure.kind}: ${fixed.failure.detail}), ` +
                  'so there is nothing new for the review to read'
                : (fixSaid ?? 'the fixing agent committed nothing, so there is nothing new for the review to read'),
              // **`committed` false and no `failure`** is the fixer declaring something other than
              // `Implemented`; a crash is `Interrupted` for the walk to rerun; a budget is `AgentFailed`.
              ...(budgetEnded || cause === undefined
                ? { declared: decidedFix! }
                : cause === 'no-commits' || cause === 'no-structured-answer'
                  ? {}
                  : { interrupted: cause }),
            }
          }
          // A commit clears `interrupted`, but not a failure that still ended
          // the round (`#468`): a fixer that committed half the fix and then hit
          // `out-of-turns` left the rest in the worktree, and `stoppedBy` is what
          // tells `keepUncommittedWork` to look — null only where the dispatch
          // itself reports none.
          stoppedBy = fixed.failure ? fixed.failure.kind : null
          // Kept before `build` reads the worktree, so a check sees the head that lands (#1209, #1243).
          yield* keepUncommittedWork()
          // The head the steps after this judge is the one the keep may have moved (#1209): a WIP
          // on top of the round's commit is what `build` and `review` read, so it is what is recorded.
          const reached = yield* gitOrDieEffect(['rev-parse', 'HEAD'])
          // **A conflict round must have committed the merge** (#1120): `baseSha` has to be in
          // the head's history, or `build` and `review` would be spent on a resolution that is
          // not one. A failed read is *not an ancestor*.
          if (merge !== undefined) {
            const ancestor = yield* gitAskedEffect(['merge-base', '--is-ancestor', merge.baseSha, 'HEAD'])
            if (Result.isFailure(ancestor)) {
              return { stopped: `the round committed without the merge of ${merge.baseSha.slice(0, 7)}` }
            }
          }
          yield* recordDiff(branch, reached)
          return { committed: reached }
        })

      /**
       * **What the `agent:` at `implement` wraps** (`#266`) — and the brief is
       * built here now rather than by the step's body.
       *
       * The three things a brief is made of reach it three ways, and all three
       * are already facts somebody else made: the ticket is what `claim`'s
       * `queue:` action took and this closure is holding, and the design and the
       * *why again* are reduces over the visit list that `runStep` puts on the
       * context (`designOn`, `sentBackTo` in `run-attempt.ts`). Nothing is remembered
       * twice.
       *
       * **`again` is still what decides which of the two dispatches runs**, and
       * that has not moved: a first visit renders the implementer's prompt, and a
       * round the judge bought renders `fixBrief` against what the refusal said.
       *
       * The throw is `madeBy`'s, which is the shape this replaces: a pass reaches
       * `implement` only after `claim` passed, and `claim` passes only on a take,
       * so no item here is the pass's own bookkeeping gone wrong. The pipeline
       * turns it into this action's verdict and the pass still reaches `end`.
       */
      const dispatch = (spec: WorkDispatch, context: ActionContext): Effect.Effect<Worked> => {
        if (took === null) {
          return Effect.die(
            new Error(
              'the `implement` step has no item — the step that makes it did not run, ' +
                "and the spine says it did. This is the attempt's own bookkeeping and not a " +
                'judgement about the change.',
            ),
          )
        }
        const brief: Brief = {
          ticket: took.ticket,
          design: context.design ?? NO_DESIGN,
          again: context.again ?? null,
          context,
        }
        return brief.again === null ? firstDispatch(brief, spec) : fixRound(brief, brief.again, spec)
      }

      // **Six, and none of `cut`, `take`, `land` or `draft` is one of them**:
      // `admit`'s work is a `worktree:` action (`#268`), `claim`'s is a `queue:`
      // one (`#269`), `merge`'s is a `merge:` one (`#270`) and `design`'s is an
      // `agent:` one (`#265`), all four reached through `stepDeps` like every
      // other plugin's. `draft` is the one of the four that left no dep behind:
      // the drafting agent is built from `stepDeps.agent`, which the cold
      // reviewer already needed.
      //
      // `item` and `onStream` are what the `take` row left behind, and they ask
      // rather than do: the fact is this closure's, made by the dep above and read
      // back by the bodies that need it, exactly as `cutTree` is (`#268`). Both are
      // synchronous, because there is nothing to await — the pass's own `claim`
      // step has already run the action that filled them.
      const ports: AttemptPorts = {
        onStream: () => onStream,
        readEnd,
        mode: modeOf(recipe),
        recordEnd,
      }

      // ---- the pass ----------------------------------------------------------
      // The claim, then nine steps. Everything above this line is refusals
      // that cost nothing and state the pass will need; everything below it
      // is the ending, written once.
      //
      // `context`, `bodies` and `ceilings` are one object and one call each,
      // held here rather than reconstructed, so the claim and the walk are
      // judged against the same tree in the same pass. `actionsAt` and `judge`
      // are already named above this line (`#462`'s own move for the second).
      /**
       * What the walk starts from. `cwd` and `env` are the pass's throughout;
       * `onSha` is empty until `admit` has something to report, `round` starts
       * at zero and `recheck` at nothing, and the loop rebuilds all three per
       * visit (`contextFor`).
       */
      const passContext: ActionContext = { runId, onSha: '', cwd, env: runnableEnv(env.values), log: runLog }
      const passBodies = bodiesFor(ports)

      /**
       * **The claim runs before the walk, and a store that refuses one of its
       * own appends is read here rather than as the claim's own ending** — the
       * same reason the second check below exists (`unappended`'s own doc).
       * `claimed.ending.ending !== 'passed'` is one of the three declines
       * `#463` moved out here, never a defect: `queue:` answers `did-not-finish`
       * at this step, never `refused` (`claim` is not one of `REFUSING_STEPS`).
       */
      const claimed = yield* claimStepEffect({
        recipe,
        context: passContext,
        emit,
        actionsAt,
        bodies: passBodies,
        ceilings,
        judge,
      })
      if (unappended !== null) {
        log(`the store refused an append during the claim: ${whyOf(unappended)}`)
        return yield* Effect.die(unappended)
      }

      /**
       * **`claim` took nothing, so there is no item here to write on** — and
       * this is the one ending that must reach none of the three below.
       *
       * `claim` cannot refuse (0058 §2, `attempt-steps.ts`): its three declines are
       * `did-not-finish` with `passed-over`, `not-claimed` or `claim-unconfirmed`.
       * Left to fall through, a blocked branch appends a `signoff`'s request to a
       * run stream with no `RunStarted`, appends `WaitStarted` to
       * `ticketId`, comments **Lingtai is waiting on you** and sets
       * `lingtai:waiting` — for an item this pass never claimed.
       *
       * Both declines are worse than noise. `passedOver` is `runnableNow` saying
       * GitHub is not offering it — `lingtai:hold`, a blocker, an assignee — and a
       * block there takes the ticket out of `queued`, which is the state
       * `selectRunnable` requires (`queue.ts`), so removing the label no longer
       * makes it runnable. `notClaimed: held` is **another conductor's live
       * item**: the block replaces that item's lifecycle and relabels its issue
       * while its agent is still working. The old engine returned `discover`/
       * `claim` here and wrote nothing at all.
       *
       * So: nothing is appended and nothing is told. `released` is set because
       * the `ensuring` at the bottom would otherwise append `TicketReleased`
       * and write `lingtai:queued` over exactly those two items —
       * `releaseTicket` appends whoever holds it.
       *
       * **`claim-unconfirmed` is the exception, and it is the reason `Taken` has
       * four cases.** The append may have committed and then lost its
       * connection, so the item may be held *by this run* — and giving back
       * something this run may hold is the one honest move. A decline runs no
       * `end` (`onStream` is set for this decline alone, so `release` has
       * something to act on): nothing resolves and no outcome is computed, so
       * the release gives the item back with no plan to record. Nothing is
       * recorded and nothing is carried out, so the pass that does reach an
       * ending resolves it (`endPlan`, `release`).
       */
      if (claimed.ending.ending !== 'passed') {
        // `claim` is not `RefusingStep`, so `endingOf` never answers `refused`
        // here — the cast is the same one `EndingAt<'claim'>` makes for every
        // reader of a claim visit's own ending.
        const stopped = { step: 'claim' as const, ending: claimed.ending as StepReport }
        const why = detailOf(stopped)
        const mayHold = stopped.ending.ending === 'did-not-finish' && stopped.ending.because === 'claim-unconfirmed'
        if (mayHold) yield* release(`the claim was not confirmed: ${said(why)}`, { _tag: 'ClaimUnconfirmed' })
        released = true
        log(`nothing claimed: ${said(why)}`)
        return {
          ok: false,
          ticketId,
          runId,
          stage: 'claim',
          detail: why,
        } satisfies RunOnceResult
      }

      // One `ProposalRouted` for one route: what the batch after the walk appends, and what a
      // `land-again` appends itself before it waits (#1221).
      const routeEvent = (route: RouteTaken) => ({
        type: 'ProposalRouted' as const,
        actor: 'conductor',
        // `{runId, offer, reply, decision}` (0120 §3, §5; `events.ts`'s
        // own doc on `ProposalRouted`) — the five derived fields
        // (`from`/`chose`/`to`/`why`/`ceiling`) stay on `RouteTaken`
        // for this file's own reading (the run-log line above,
        // `restartReason`, `nextPrompt`'s brief) but are not stored a
        // second time; a reader of the event replays `routeNext`.
        data: parsePayload('ProposalRouted', {
          runId,
          // `ended` is the `StepEnded` the proposal was taken from, recorded
          // when it was emitted: this batch comes after every lap (#931). The
          // findings and output are on it, so a route that names it does not
          // repeat them (0100 §14, #932); one that cannot name it keeps them.
          offer: {
            ...route.offer,
            proposal: route.ended === null ? route.offer.proposal : stripEvidence(route.offer.proposal),
            ended: route.ended,
          },
          reply: route.reply,
          decision: route.decision,
        }),
      })

      // **The project's base, once, before an agent is paid** (#1208, 0108 §13): where its last check was red
      // this attempt asks again on its own base commit, and a red answer releases the ticket `BaseRed` with
      // no agent run. Read off the log alone (the look already decided on the mirror), and never for a
      // continuation, whose base is not the one the red record is about. A log that cannot be read is no
      // reason to skip the question: the guard at `proposed` asks again.
      let baseState = yield* baseStateEffect({ store, project, base: attemptBase(), recipe })
      if ('unread' in baseState) baseState = yield* baseStateEffect({ store, project, base: attemptBase(), recipe })
      // **The ticket opened to make this base green asks nothing about it** (#1266, 0108 §13): named by the
      // log, never by a label. A red `build` there reaches the judge as on any ticket and buys `fixRefusal`.
      const isBaseFix =
        'red' in baseState && baseState.red.fix !== null && baseState.red.fix.externalRef === String(options.issue)
      const baseFirst =
        continuation === null && !isBaseFix && 'red' in baseState ? { action: baseState.red.action } : undefined
      if (continuation === null && 'unread' in baseState)
        runLog.note('base', `base state not read: ${baseState.unread}`)
      const pass = yield* runAttemptEffect({
        recipe,
        context: passContext,
        // A `land-again` spends the attempt's budget, so its route is durable before the wait: a store that
        // refuses answers false and the attempt holds for a person instead of spending a retry nobody can replay.
        appendRoute: (route) =>
          appendAt(runId, [routeEvent(route)]).pipe(
            Effect.as(true),
            Effect.catchDefect((defect: unknown) =>
              Effect.sync(() => {
                log(`ProposalRouted was refused by the store: ${whyOf(defect)}`)
                return false
              }),
            ),
          ),
        emit,
        recordPrompt: (call) => recordPrompt(store, runId, call, log),
        actionsAt,
        sandboxAt: (step) => sandboxOutcomeOf(refusals.drain(step)),
        bodies: passBodies,
        ceilings,
        judge,
        // A parent after a split ends `satisfied` the moment its check passes; any other ticket waits to be confirmed (#1251).
        splitParent: reduced.split !== null,
        mergeBase,
        stepRedoWaits: options.stepRedoWaits,
        headNow: () =>
          gitAskedEffect(['rev-parse', 'HEAD']).pipe(
            Effect.map((r) => (Result.isSuccess(r) ? r.success.trim() : null)),
          ),
        // The redo's head is on the run's stream before its wait begins, so a kill during it can be continued (#1398).
        saveHead: () =>
          Effect.gen(function* () {
            refsAppendFailed = false
            const detail = yield* publishWhatIsCommitted
            // A save is a head the run's own stream can re-cut: a push that failed, a row the store refused and a
            // stream that cannot be read are each a save that did not happen, whatever the publish returned.
            const events = yield* Effect.tryPromise({ try: () => store.read(runId), catch: (error) => error }).pipe(
              Effect.result,
            )
            if (Result.isFailure(events))
              return { failed: `the run's stream could not be read — ${whyOf(events.failure)}` }
            if (refsAppendFailed) return { failed: 'the account of the publication was not appended' }
            const head = releasedHeadOf(events.success)
            return 'cannot' in head ? { failed: detail === null ? head.cannot : `${detail}; ${head.cannot}` } : null
          }),
        resetToHead: () =>
          Effect.gen(function* () {
            // **Never reset over work that was not saved** (0108 §20, #1245): a keep that failed left
            // `stoppedBy` set, so it is asked once more, and a tree still unkept is not touched.
            yield* keepUncommittedWork()
            if (wipFailure !== null && stoppedBy !== null && !inConflictRound)
              return { failed: `the cut-off run's unsaved work could not be kept first — ${wipFailure}` }
            return yield* resetToHead({ git: gitAskedEffect, plantAt: recipe.env.plantAt })
          }),
        mergeForConflict,
        // A fixer that committed its merge before it was cut off leaves the base an ancestor of HEAD (#1245).
        mergeAlreadyIn: (baseSha: string) =>
          gitAskedEffect(['merge-base', '--is-ancestor', baseSha, 'HEAD']).pipe(Effect.map(Result.isSuccess)),
        conflictEvidence,
        ...(isBaseFix ? {} : { baseIsRed }),
        ...(baseFirst === undefined ? {} : { baseFirst }),
        // **Where this walk jumps to, once `admit` and `prepared` have
        // rebuilt the tree a held pass left** (#465, 0120 §6) — absent for
        // every ordinary pass, which starts at `admit` and walks the
        // whole spine as it always has.
        ...(continuation !== null
          ? {
              from: {
                step: continuation.step,
                waive: continuation.waive,
                ...(continuation.readClipped === undefined ? {} : { readClipped: continuation.readClipped }),
                ...continuation.approval,
                roundsSpent: continuation.roundsSpent,
                ...(continuation.personRounds === undefined ? {} : { personRounds: continuation.personRounds }),
                baseMergesSpent: continuation.baseMergesSpent,
                conflictRoundsSpent: continuation.conflictRoundsSpent,
                stepRedosSpent: continuation.stepRedosSpent,
                landingRetriesSpent: continuation.landingRetriesSpent,
                ...(continuation.baseRed !== undefined ? { baseRed: continuation.baseRed } : {}),
                ...(continuation.landedOnBase !== null ? { landedOnBase: continuation.landedOnBase } : {}),
                ...(continuation.roundLimit !== undefined ? { roundLimit: continuation.roundLimit } : {}),
                ...('byTriage' in continuation && continuation.byTriage ? { byTriage: true as const } : {}),
                ...(continuation.grant ? { grant: continuation.grant, findings: continuation.findings } : {}),
                ...(continuation.grant && !('byTriage' in continuation && continuation.byTriage)
                  ? { grantWait: continuation.resumedWaitId }
                  : {}),
                ...(continuation.grant && continuation.conflict !== undefined
                  ? { conflict: continuation.conflict }
                  : {}),
                ...(continuation.conflictResolved !== null ? { conflictResolved: continuation.conflictResolved } : {}),
                ...(continuation.reviewedHead !== null ? { reviewedHead: continuation.reviewedHead } : {}),
                ...(continuation.alreadyDone !== null ? { alreadyDone: continuation.alreadyDone } : {}),
                ...('answered' in continuation && continuation.answered !== undefined
                  ? { answered: continuation.answered }
                  : {}),
                ...(continuation.released?.rerun.for != null
                  ? {
                      redo: {
                        for: {
                          step: continuation.released.rerun.for.step,
                          name: continuation.released.rerun.for.name,
                          round: continuation.released.rerun.for.round,
                        },
                        prompt: continuation.released.rerun.prompt,
                        accountReruns: continuation.released.rerun.accountReruns,
                        why: continuation.released.rerun.why,
                        ...(continuation.released.rerun.startedAt === undefined
                          ? {}
                          : { startedAt: continuation.released.rerun.startedAt }),
                        ...('unread' in continuation.released.rerun && continuation.released.rerun.unread !== undefined
                          ? { unread: continuation.released.rerun.unread }
                          : {}),
                      },
                    }
                  : {}),
              },
            }
          : {}),
      })
      // An observer's own bug must not cost the ending: `runLog` is a trace,
      // not a record (its own header), so a throw here is noted and the
      // ending below still gets written.
      try {
        // The claim's own visit put back at the front — `runAttempt` no longer
        // carries it (`#463`), and `test/one-attempt.ts`'s `once()` checks every
        // visit's own outcome against the run stream, claim's included.
        options.onPass?.({ ...pass, steps: [claimed, ...pass.steps] })
      } catch (err) {
        runLog.note('pass', `onPass threw: ${err instanceof Error ? err.message : String(err)}`)
      }

      /**
       * **A store that refused an append is not a step's verdict about the
       * change, however the walk reported it.**
       *
       * `runStep` catches whatever a step throws and reports *did-not-finish:
       * threw* (`run-attempt.ts`), which is right for a body that failed and wrong for
       * the store underneath it: the ending below would read that as `blocked`,
       * park the item on *Waiting on you* over a dropped connection and ask a
       * person to acknowledge a diagnosis naming a step that did its work. So
       * the defect is raised here instead, before a word of the ending is
       * written, and the handler at the bottom answers it as it answered every
       * append the old engine made — the item is released, the pass ends
       * `unexpected`, and the queue takes it again after the backoff.
       *
       * Only the appends nothing else answers for: the tolerant three call
       * `appendAt`, having already decided their row costs less than the ending
       * it is about (`appendNow`).
       */
      if (unappended !== null) {
        log(`the store refused an append during the attempt: ${whyOf(unappended)}`)
        return yield* Effect.die(unappended)
      }

      log(attemptLine(pass.steps, recipe.steps))
      const tookNow = (): Claimed | null => took
      const summaryOf = (wait?: WaitReason): AttemptSummary => ({
        ref: tookNow()?.ticket.ref ?? String(options.issue),
        title: tookNow()?.ticket.title ?? '',
        ran: ranVisits(pass.steps, recipe.steps),
        cost: { ...spent },
        ...(wait === undefined ? {} : { wait }),
      })
      /**
       * **Every decision the router made, on the log** (`#271`).
       *
       * The note below is what `lingtai attach` and the task page's run log show
       * while a pass is in flight, and it stays: a trace is what answers *what is
       * it doing now*. What it cannot answer is *why did that pass buy a round*,
       * because the file is deleted on the ending where the change landed (0034),
       * so until this append existed the one decision the whole loop turns on was
       * the one thing no ending recorded.
       *
       * One append rather than one per route: they were all decided by the walk
       * that has just returned, and a reader asking what a pass did wants them
       * whole or not at all. An empty list appends nothing — a pass that sailed
       * through decided nothing, and `pass.steps` already says it got through.
       *
       * **`appendAt` and a swallowed refusal, which is `noteRefs`' rule and not a
       * laxness**: *the account never costs the thing it is an account of.* This
       * is the only store write between the walk returning and the landing's own
       * `appendNow(ticketId, [TicketLanded, ...endPlan])`, because
       * `publishWhatIsCommitted` is skipped on a landing — so a strict append
       * here would let a dropped connection on a purely informational row reach
       * the defect handler, release an item whose branch is already on `main`,
       * leave `end`'s plan unresolved and hand the ticket to a second pass that
       * reworks a merged change. A route nobody can read back is worth less than
       * that by any measure, so it is said and not raised. `appendAt` is what
       * this class of caller is for (`appendNow`'s own doc).
       */
      for (const route of pass.routes) {
        runLog.note('route', `${route.from} → ${route.to}: ${route.why}`)
      }
      // A route already appended before its wait (`land-again`, #1221) is not appended a second time.
      const unwritten = pass.routes.filter((route) => route.appended !== true)
      if (unwritten.length > 0) {
        yield* appendAt(runId, unwritten.map(routeEvent)).pipe(
          // A defect and not an interrupt: the pass is still interruptible here.
          Effect.catchDefect((defect: unknown) =>
            Effect.sync(() => {
              const why = whyOf(defect)
              runLog.note('route', `the ${pass.routes.length} route(s) were not appended — ${why}`)
              log(`ProposalRouted was refused by the store: ${why}`)
            }),
          ),
        )
      }

      const outcome = outcomeOf(pass.end)
      // For `release`, which is declared above this scope and has to know which
      // outcome the plan it is holding is about (`endedAs`).
      endedAs = outcome
      const headSha = headReached(pass.steps)
      /**
       * **The refs go before the question, and this line is what makes that
       * true** (`#250`, 0062 §1).
       *
       * A person asked *merge this anyway?* wants the branch already on origin to
       * answer it with, and a publish that happens only while the scope unwinds
       * happens after every append below and after GitHub has been told. So the
       * publish is asked for here, on every ending but a landing — where the lane
       * has already pushed and `didLand` will delete the run log.
       *
       * The finalizer still runs and is not redundant: it is the only thing that
       * covers a crash or an interruption between here and the end of the scope,
       * and on the paths that reach this line it finds the head already published
       * and writes the `already-published` row that says *the finalizer fired* —
       * which is the fact `#250` had to infer from a `RUN_LOG_END` line.
       *
       * `null` is *nothing to say*: the refs are where this ending promised them,
       * or there was nothing committed to promise. A string is git's own words,
       * and it travels onto the card rather than being swallowed — the person is
       * still owed the question, and is told the branch is not there.
       */
      const notPushed = outcome === 'landed' ? null : yield* publishWhatIsCommitted
      const unpushed = notPushed === null ? '' : ` (and ${branch} was not pushed: ${said(notPushed, 120)})`
      /**
       * **What a person can be asked to merge: the head this pass put on origin
       * for `branch`, or null where it put none there.**
       *
       * `headSha` cannot answer that, and the gap is not small. `headReached` is
       * the last `head` a *visit* reported and `admit` reports the base sha so that
       * the head the pass is judged against always has a value (`attempt-steps.ts`),
       * so it is the commit the worktree was **cut** at on every ending whose step
       * moved the tree without reporting it. Binding a request to that asks a
       * person to merge `agent/<n>@<base>` while origin holds this pass's actual
       * commits at another sha: `approve()` compares the two, refuses every one as
       * `stale`, and until somebody clicks it the board draws the item
       * `awaitingApproval` at a sha nothing is at (`#92`, and `#84`'s *a card
       * offers the move that is left, never a control that refuses*). The endings
       * that stop at `implement` are the widest such gap and no longer ask at all
       * — nothing judged them, see `judged` below — so what this now carries is the
       * other half: a push origin refused.
       *
       * `published` is set by the publish a few lines above — the one ending that
       * skips it is a landing, which does not reach here — so it is exactly *what
       * is fetchable under `branch` right now*: null where nothing was committed,
       * null where origin refused the leased ref (`arm-only`, a broken transport),
       * and the head itself where the push went. Where it is null there is nothing
       * to approve and the block below is the whole of what a person is told, which
       * is what the old engine did on both endings that reach a person without a
       * commit.
       */
      const onOrigin = published
      const stopped = pass.stopped
      /** What the router decided last, which is what sent a pass to a person. */
      const lastRoute = pass.routes.at(-1) ?? null
      /** Every finding the pass's plugins raised, for a card and for a restart. */
      const findings = pass.steps.flatMap((visit) => visit.results.flatMap((result) => result.findings))
      /** How many rounds the pass actually bought — a route back into the spine. */
      const roundsSpent = pass.routes.filter((route) => route.to !== 'waiting' && route.to !== 'claim').length
      /** Whether `pass.end` is the one `Requeued` cause a route spends — the rest of the requeued section's own test. */
      const restarted = pass.end._tag === 'Requeued' && pass.end.cause._tag === 'NewAttempt'

      /**
       * **The `run` every `WaitReason` carries, patched on here** — the one
       * fact only `conduct.ts` holds and `nextOf`/`routeNext` cannot:
       * `unpushed`, known only after the pass, from `notPushed`, and
       * `keptAt` from `kept` (`#421`) — what the inline `publishWhatIsCommitted`
       * call above left behind, which may go stale if the finalizer's own
       * second call then publishes (out of scope here, same as `unpushed`
       * itself already is).
       */
      const runRef: AttemptRef = {
        runId,
        ...(notPushed === null
          ? {}
          : { unpushed: { branch, said: said(notPushed, 120), ...(kept === null ? {} : { keptAt: kept }) } }),
      }

      /**
       * **The `WaitReason` a person is owed — `pass.end.reason` verbatim, with
       * `run` patched on** (#502, 0118 §1's own header: *a `WaitReason` is
       * built by `routeNext` and `nextOf`, and nothing else does*).
       *
       * **`pass.unanswered` is the split, not `pass.end._tag`** (`#463`):
       * `end` is forced to a `WaitOnPerson` even where this file never
       * classified the stop (`unansweredEnd` in `run-attempt.ts`), and that
       * manufactured `AgentCrashed` is not the richer sentence `stopped`
       * already carries — but both branches now reach the same `WaitOnPerson`
       * shape, so there is nothing left for this file to rebuild: the old hold translators
       * and `hold-of.ts` are gone, and so is the patching they
       * did — `ceilingHit`'s turns/dollars and `declined`'s `said` are spend,
       * which lives on `RunSpent` alone and not on the wait (0110), and
       * `MergeRefused`'s `paths`/`baseSha`/`headSha` go with `IntegrationRefused`'s
       * own fields, which 0120 drops in favour of the merge action's own
       * `Conflicted` result. `waitWords` turns the reason back into the
       * line/`needs`/`diagnosis` every reader below still wants.
       */
      const waitReasonFor = (): WaitReason => {
        // `outcomeOf` answers `blocked` for `WaitOnPerson` alone, and this is
        // only read on a `blocked` outcome — so the loop's own type cannot see
        // it, but `pass.end` is always one here. `OwnQuestion` is excluded by
        // hand: it carries no `run` at all, and nothing a pass ends with is
        // ever that variant — only `ask.ts`'s pre-claim question is.
        const reason = (pass.end as Extract<AttemptEnd, { _tag: 'WaitOnPerson' }>).reason as Exclude<
          WaitReason,
          { _tag: 'OwnQuestion' }
        >
        const resumed =
          continuation === null
            ? undefined
            : waitsFromState(reduced).find((w) => w.waitId === continuation.resumedWaitId)
        const standing = standingFor({
          reason,
          granted: continuation?.grant !== undefined,
          onSha: continuation?.onSha ?? '',
          resumed,
          head: headNow,
          wip: wips.length > 0 ? wips : null,
          // A keep that failed leaves the edits in the tree, for the finalizer to save
          // as a WIP after this wait is written — so it is not an unmoved head either.
          unpushed: notPushed !== null || wipFailure !== null,
        })
        return { ...reason, run: runRef, ...(standing === null ? {} : { standing }) } as WaitReason
      }

      // ---- landed -------------------------------------------------------------
      const merged = landedAt()
      if (outcome === 'landed' && merged !== null) {
        // **In the same append as the landing, so the two cannot come apart**
        // (`endPlan`). The pass resolved this against `landed` before this line
        // and appended nothing; one transaction is what makes an
        // `EndActionsResolved{landed}` over an unrecorded landing unreachable
        // rather than merely unlikely.
        yield* remembered(
          landTicketEffect(
            ticketId,
            { mergeCommit: merged, base: attemptBase(), endPlan, draft: draftOfLanding() },
            store,
            ticketSnapshots,
          ),
        )
        endResolved = endPlan
        // What is left is telling the issue, which reads the plan that was just
        // appended rather than the stream.
        released = true
        // The summary of the review that cleared this run, read off the run's own stream: a
        // continuation's pass has no review visit of its own. The last review, summary or not —
        // an earlier one describes a diff that has since changed (#896). A failed read posts the
        // landing line alone, and the attempt number falls back to 1 as the detail page's does.
        const summary = yield* Effect.promise(() =>
          store
            .read(runId)
            .then((events) => {
              const review = stepOutcomesOf(events).findLast((o) => o.runId === runId && o.step === 'review')
              return review === undefined ? null : (reviewSummaryOf(review)?.summary ?? null)
            })
            .catch(() => null),
        )
        const attempt = yield* Effect.promise(() =>
          store
            .read(ticketId)
            .then((events) => reduceTicket(events).runs.indexOf(runId) + 1 || 1)
            .catch(() => 1),
        )
        yield* tellGitHubAboutEffect({
          store,
          github: options.client,
          ticketId,
          ...ticketSnapshots,
          labels: labelsFor('landed', { base: attemptBase(), main: recipe.branch.main }),
          editEnded: true,
          appended: endResolved,
          landed: { mergeCommit: merged, base: attemptBase(), attempt, summary },
        })
        log(`landed ${merged.slice(0, 7)} on ${attemptBase()}`)
        // **Every kept ref for this ticket, not only this run's own** (`#421`)
        // — an earlier run of the same ticket may have left one too, and a
        // landing is the one place either is ever cleaned up: the worktree
        // still exists (`repo.remove` is a finalizer, above) and the publish
        // finalizer is skipped on this path (`didLand` below), so nothing
        // else reaches here afterwards.
        yield* Effect.gen(function* () {
          const refsHere = yield* gitAskedEffect([
            'for-each-ref',
            '--format=%(refname)',
            `refs/lingtai/unpushed/${options.issue}/`,
          ])
          if (Result.isFailure(refsHere)) {
            runLog.note(
              'push',
              `kept refs for #${options.issue} were not listed on landing — ${refsHere.failure.detail}`,
            )
            return
          }
          for (const ref of refsHere.success.split('\n').filter(Boolean)) {
            const dropped = yield* gitAskedMirror(['update-ref', '-d', ref])
            if (Result.isFailure(dropped))
              runLog.note('push', `${ref} was not dropped on landing — ${dropped.failure.detail}`)
          }
        })
        // The publish is skipped on a landing, so a WIP the landed branch carries is accounted for here.
        yield* noteAllKept(branch)
        didLand = true
        return { ok: true, ticketId, runId, mergeCommit: merged, summary: summaryOf() } satisfies RunOnceResult
      }

      // ---- satisfied: the base already held the work (#1251, 0108 §21) ----------
      // A split parent whose check passed ends here at once, in the one append `landTicketEffect` makes for a
      // landing. Nothing is merged and no lane is used. The ticket ending is refused by the reducer's own transition
      // when it has already ended, and a stream that moved is a person's: the walk's end is then held, not lost.
      if (pass.end._tag === 'Satisfied') {
        const done = pass.end
        const ended = yield* remembered(
          satisfyTicketEffect(
            ticketId,
            { baseSha: done.baseSha, bodyVersion: done.bodyVersion, items: [...done.items], endPlan },
            store,
            ticketSnapshots,
          ),
        )
        if (ended.ok) {
          endResolved = endPlan
          released = true
          yield* tellGitHubAboutEffect({
            store,
            github: options.client,
            ticketId,
            ...ticketSnapshots,
            labels: labelsFor('landed'),
            editEnded: true,
            appended: endResolved,
          })
          // The recipe's `end` may not close the issue (`end: []`, or a close restricted to `when: landed`),
          // and a satisfied ticket is terminal with nothing else to finish it (#1263).
          yield* tellGitHubEffect({ store, github: options.client, ticketId, change: { kind: 'closed' } })
          log(`satisfied on ${done.baseSha.slice(0, 7)}: the base already held the work`)
          didLand = true
          return {
            ok: true,
            ticketId,
            runId,
            mergeCommit: done.baseSha,
            satisfied: true,
            summary: summaryOf(),
          } satisfies RunOnceResult
        }
        const why = 'refusal' in ended ? `the ticket had already ended (${ended.refusal.reason})` : 'the stream moved'
        log(`satisfied was not recorded: ${why}`)
        runLog.note('end', `satisfied was not recorded: ${why}`)
        yield* release(`the satisfied ending was not recorded: ${why}`)
        return {
          ok: false,
          ticketId,
          runId,
          stage: 'satisfied-refused',
          detail: why,
          summary: summaryOf(),
        } satisfies RunOnceResult
      }

      // ---- requeued: the base is red (#1208, 0108 §13) --------------------------
      // The branch is already published at its head (above, on every ending that did not land). Nothing
      // about this ticket is a person's to decide: it is released, and the queue passes the project over
      // until the base moves.
      if (pass.end._tag === 'Requeued' && pass.end.cause._tag === 'BaseRed') {
        const cause = pass.end.cause
        const why = `the base is red: \`${cause.command}\` fails on ${cause.base} at ${cause.baseSha.slice(0, 7)}; taken again once ${cause.base} moves`
        log(why)
        runLog.note('base', why)
        yield* release(why, cause)
        // After the release, so it never waits on this (#1266): one ticket for the first red since the last green.
        yield* proposeBaseFix({
          store,
          tickets: githubTicketStore(options.client),
          project,
          base: attemptBase(),
          recipe,
          note: (message) => {
            log(message)
            runLog.note('base', message)
          },
        })
        return {
          ok: false,
          ticketId,
          runId,
          stage: 'base-red',
          detail: why,
          summary: summaryOf(),
        } satisfies RunOnceResult
      }

      // ---- requeued: a second approach was bought (0040) -----------------------
      /**
       * **The arm is on origin before anything names it, or no restart is
       * recorded at all** (0040, 0062 §2).
       *
       * `publishWhatIsCommitted` above is deliberately tolerant — a
       * `--force-with-lease` a sibling claim invalidated, or a dropped network,
       * returns git's words and pushes nothing — and every other ending is right
       * to go on regardless: a person is still owed the question, and is told the
       * branch is not there. **A restart is the one ending that cannot.** It
       * spends one of `ceiling.restarts`, and the event it appends promises the
       * next agent a ref to `git fetch` (`attempts.ts`). Recorded over a refused
       * publish it spends the ceiling, names a ref that never existed, and the
       * worktree holding the commits is deleted by the finalizer a moment later.
       *
       * The old engine pushed strictly before the append and said why in as many
       * words: *a push that is refused must leave no arm on the log.* This is
       * that rule, asked of the publish that already ran rather than of a second
       * push — which also keeps the `arm-only` case a restart, because there the
       * command exited non-zero and the arm **is** up.
       *
       * Where it is not, the pass falls through to the `failed` ending below: no
       * restart is consumed, the reason there already carries `unpushed`, and the
       * item comes back through the backoff with its ceiling intact.
       *
       * **A WIP on top of the judged head is still the arm being up** (`#468`).
       * `armPublished` is the WIP's own sha once `keepUncommittedWork` has run
       * (`publishWhatIsCommitted` sets `armPublished = head`, and `head` is the
       * WIP once one exists), while `headSha` stays `headReached(pass.steps)` —
       * the commit `review` judged, which the WIP sits on top of rather than
       * replaces. Comparing the two shas directly would read the arm as down on
       * every ending that kept a WIP, though it is on origin and `headSha` is
       * its ancestor. Accepted only when the WIP's own parent is `headSha`: a
       * WIP whose parent is something else carries a tree the restart was never
       * decided about, and falls through to `failed` same as an unpublished arm.
       */
      const armIsUp =
        armPublished !== null &&
        (armPublished === headSha || wips.some((w) => w.sha === armPublished && w.parent === headSha))
      if (restarted && !armIsUp) {
        runLog.note(
          'restart',
          `no restart was recorded — ${arm} is not on origin at ${headSha.slice(0, 7) || 'the base'}`,
        )
        log(`not starting over — ${arm} was not published, so no restart is spent`)
      }
      if (restarted && armIsUp) {
        const restart = reduced.newAttempts.length + 1
        const reason = restartReason({
          action: lastRoute?.from ?? 'review',
          rounds: roundsSpent,
          n: restart,
          of: ceiling.ticket.newAttempts,
        })
        // **`PassRestarted` is gone (#502): `TicketReleased{cause: Restart}`
        // is the one event now** — what it also carried (the arm, its head,
        // the findings still live) is on the previous run's own stream,
        // which the next prompt already reads (`attempts.ts`'s `lastRun`,
        // `ticket.ts`'s own header on `RestartRecord`).
        log(`starting over — restart ${restart} of ${ceiling.ticket.newAttempts}`)
        runLog.note('restart', reason)
        yield* release(reason, { _tag: 'NewAttempt', newAttempt: restart })
        return {
          ok: false,
          ticketId,
          runId,
          stage: 'restart',
          detail: reason,
          summary: summaryOf(),
        } satisfies RunOnceResult
      }

      // ---- blocked: a person now holds it -------------------------------------
      if (outcome === 'blocked') {
        const held = stopped?.ending.ending === 'held'
        const reason = waitReasonFor()
        /**
         * **A released attempt whose saved head is gone starts over if a restart is left** (#1205, 0108 §15);
         * otherwise the wait below is the person's, and it names the head — the cut's own `notCut` detail.
         */
        // A person who chose this attempt over a restart is not restarted past: the wait names the head (#1218).
        if (
          headGone !== null &&
          continuation?.released?.by !== 'person' &&
          reduced.newAttempts.length < ceiling.ticket.newAttempts
        ) {
          const restart = reduced.newAttempts.length + 1
          const why = `the saved head cannot be continued (${headGone}) — restart ${restart} of ${ceiling.ticket.newAttempts}`
          log(why)
          runLog.note('restart', why)
          yield* release(why, { _tag: 'NewAttempt', newAttempt: restart })
          return {
            ok: false,
            ticketId,
            runId,
            stage: 'restart',
            detail: why,
            summary: summaryOf(),
          } satisfies RunOnceResult
        }
        /**
         * **A run an account limit cut off is the ticket's to take again, not a person's** (0108 §11, #1205).
         * The lock first and the release second: a look between the two would claim the ticket and walk
         * straight back into the wall. Where the lock did not append (a read or an append failed) the ticket
         * keeps today's crash wait, since a release nothing holds back is a loop of walls.
         */
        if (
          reason._tag === 'AgentCrashed' &&
          reason.cause === 'crash' &&
          (reason.step === 'design' || reason.step === 'implement' || reason.step === 'review')
        ) {
          const wall = wallOf(reason.detail)
          if (
            wall !== null &&
            (yield* standDownAccount({ of: 'mid-run', step: reason.step }, wall, reason.detail)).locked
          ) {
            const why = `the ${reason.step} step's agent met the ${wall} account limit; taken again once it lifts`
            runLog.note('account-limit', why)
            yield* release(why, { _tag: 'AccountLimit', runId, step: reason.step, runtime: wall })
            return {
              ok: false,
              ticketId,
              runId,
              stage: reason.step,
              detail: why,
              summary: summaryOf(),
            } satisfies RunOnceResult
          }
        }
        const said_ = waitWords(reason, { branch, base: attemptBase(), findings })
        /**
         * **Something judged this diff and said no** — the second half of when a
         * person may be offered *merge it anyway*, and the half `onOrigin` cannot
         * answer.
         *
         * Two shapes, and they are the two the old engine asked on. `stopped ===
         * null` is the router having sent the pass to a person: `proposed` weighed
         * an arriving refusal, or a `review` that passed carrying findings, and
         * spent what it had — `unfixed` and `disagreement` under the old engine.
         * A `refused` ending is a step's own declared actions refusing, which is
         * the `build` gone red and the lane that would not take it.
         *
         * **An unreadable answer needs no third shape, since `#472` routes it
         * through `nextOf`'s `Propose` like every other fall-short** — and the
         * two shapes above already cover three of the four steps it can
         * happen at (`AnswerUnreadable` is legal at `design`, `review`,
         * `proposed` and `merge`, `attempt-next.ts:316`, 0120 §2's table).
         * `review`'s is special-cased `passed` by `endingOf` (a reviewer's
         * `failed` is findings, not a refusal), so `routeProposal`'s `reported`
         * is `null` and it lands on `stopped === null`, the first shape.
         * `proposed` and `merge` are both `REFUSING_STEPS`, so `endingOf`
         * reports either one's own unreadable answer `refused`, and both land
         * on the second shape, `stopped.ending.ending === 'refused'`. `design`
         * is neither — not special-cased and not a `REFUSING_STEPS` member —
         * so its own unreadable draft is an ordinary `did-not-finish`, and
         * `judged` is `false` for it: the next paragraph's rule, not a third
         * shape, and correct here for the same reason it is at `admit` — no
         * commit exists yet for *merge it anyway* to be an offer about.
         *
         * **Every other blocked ending judged nothing, and must not offer the
         * control.** `did-not-finish` at `implement` is the `#237`/`#249` shape —
         * an agent stopped at `runtime.limits.run.turns` having committed twice — and
         * `admit`'s is a clone that did not finish. Asked there, a `signoff`'s request
         * sets `task_view.awaitingSha`, `standing.tsx` draws **Approve**, and
         * `refusingOn` (`approve.ts`) finds nothing to be refusing — the pass stopped
         * at `implement`, so `build` and `review` never ran and left no row — so one
         * click merges a half-finished diff the build and the cold reviewer never
         * read, with no `note`, no `StepWaived` and nothing on the log saying
         * anything was skipped. On a card whose own diagnosis reads *the limit is a
         * scope alarm … requeue*. The old engine appended no request on that ending
         * and Requeue was the only move offered; this is that, as a predicate
         * rather than as a list of endings.
         *
         * A plugin that asked for a person has already had its own request emitted
         * by the pipeline, which is what `held` excludes — and the request is only
         * worth making where origin is holding something to merge (`onOrigin`).
         */
        const judged = stopped === null || stopped.ending.ending === 'refused'
        /**
         * **`ApprovalRequested` is gone (#502), and so is the event it used to
         * compose this from** — a person reading the ticket's own question is
         * told the commit is still on origin and could be merged as it
         * stands, named for itself rather than for the action that refused
         * (naming it after that action would be the pointer a person reads,
         * not the question) — `whatRefused` still supplies which runtime,
         * where one answers. The signoff that turns the control on is
         * appended separately, below.
         */
        const question =
          !held && judged && onOrigin !== null
            ? `Merge ${branch} into ${attemptBase()} anyway? ${said_.line}` +
              (whatRefused(stopped) === null ? '' : ` (\`${whatRefused(stopped)}\`)`)
            : said_.line
        /**
         * **The offer needs its own `signoff`, now that `ApprovalRequested` is
         * gone (#502).** The comment above only covers `approve.ts`'s own
         * fallback (`run.headSha`) — which lets the click through once a
         * person has already found the control — but nothing upstream of
         * that ever turns the control on: `task_view.awaiting_sha` and
         * `StandingView.awaitingSha` are written off the run's `AttemptState`
         * (`task-view.ts`'s `rowOf`) and `boardFactOf`'s `SignoffRequested`, both of
         * which need a `signoff`-yield action with a live `requested` on
         * some `StepEnded`, and the router sending a pass here is not one —
         * it runs no action at all. So this appends one itself, on the run's
         * own stream, naming the point the merge-anyway question is standing
         * in for.
         *
         * **Named `conductor:judge`/`conductor:unfixed`, not `judge`/`unfixed`**
         * (`#503`). This `StepEnded` is appended last, so it wins every key it
         * shares with the step's own `StepEnded` —
         * `task_view.verdicts["${runId}:${step}:${name}"]`, `run.steps`, and
         * `run.lifecycle.step`, which `refusingOn` (`approve.ts`) then
         * *excludes* as the signoff an approval is itself answering. A
         * declared action named plainly `judge` (legal: that is what people
         * actually call a `judge:` entry, `recipe.ts`'s `judgePlugin`) would
         * have its own refusal overwritten and then filtered out of what
         * Approve demands a reason for — landing a refused check with nothing
         * on the log saying it was waived. `conductor:` is a namespace the
         * recipe validator now refuses any declared name from entering
         * (0110 §9, `:` reserved), so this key can never collide. `onSha` is
         * `headSha` — `approve.ts`'s own fallback and this offer's subject are
         * the same commit, or a correct approval reads as stale.
         */
        if (!held && judged && onOrigin !== null) {
          yield* appendNow(runId, [
            {
              type: 'StepEnded',
              actor: 'conductor',
              data: parsePayload('StepEnded', {
                runId,
                outcome: {
                  step: stopped?.step ?? 'proposed',
                  round: roundsSpent,
                  actions: [
                    {
                      plugin: 'conductor',
                      name: stopped?.step === 'merge' ? 'conductor:unfixed' : 'conductor:judge',
                      onSha: headSha,
                      evidence: question,
                      yields: 'signoff',
                      result: { _tag: 'Completed', requested: { question } },
                    },
                  ],
                },
              }),
            },
          ])
        }
        const waitId = crypto.randomUUID()
        // The plan rides in the same append as the block, for the landing's
        // reason: a `when: blocked` action recorded as carried out for a block
        // the log does not carry is the same orphan one ending along (`endPlan`).
        yield* remembered(holdTicketEffect(ticketId, { waitId, reason, endPlan }, store, ticketSnapshots))
        endResolved = endPlan
        released = true
        yield* tellGitHubAboutEffect({
          store,
          github: options.client,
          ticketId,
          ...ticketSnapshots,
          question,
          waitId,
          editEnded: true,
          labels: labelsFor('waiting'),
          appended: endResolved,
        })
        // #655: a run that started and met the account's limit. The wait above is
        // the ticket's and is already written; this only locks the account.
        const walled = reason._tag === 'AgentCrashed' && reason.cause === 'crash' ? wallOf(reason.detail) : null
        if (reason._tag === 'AgentCrashed' && walled !== null) {
          yield* standDownAccount({ of: 'mid-run', step: reason.step }, walled, reason.detail)
        }
        log(`held at ${headSha.slice(0, 7) || 'the base'} — ${question}`)
        return {
          ok: 'held',
          ticketId,
          runId,
          headSha,
          step: stopped?.step ?? 'proposed',
          summary: summaryOf(reason),
        } satisfies RunOnceResult
      }

      // ---- failed: the item goes back to the queue -----------------------------
      // **And one ending locks the account rather than backing the item off** (0031 §3). A
      // `never-ran` met something account-wide, so every queued item on that runtime would meet it
      // identically: the item is released like any other failure and nothing else
      // on that runtime is taken until the lock lifts.
      if (stopped?.ending.ending === 'never-ran') {
        const at = stopped.ending.at
        const round = wallMetBy()
        yield* standDownAccount(
          // A `never-ran` at `implement` is the *run's* wall — **unless the agent
          // there was a round's rather than the implementer's**, which is the one
          // thing `StepNeverRan` cannot say and `fixWall` is recorded for. At any
          // other step it is a declared plugin's agent, which 0041 §3 reuses this
          // whole mechanism for.
          //
          // **The cell is open since `#266` and the sentence did not change.** It
          // used to read *`implement` has no cell open, so this is the body's own
          // stand-down*; the stand-down is `createWorkAction`'s now, and it is the
          // same wall met by the same runtime on the same brief — so `{of: "run"}`
          // is still what a person is owed, and `at` is the action's name rather
          // than the runtime's, which this branch has never read — the runtime is
          // `stopped.ending.runtime`, taken from the result that never ran.
          //
          // **`design` was beside `implement` on the `{of: "run"}` line until
          // `#265`, on the premise this comment stated: that it had no cell open.**
          // `agentPlugin` declares the step now, so a `never-ran` there can only be
          // a declared action's — the body dispatches nothing and `defaultsAt` has
          // no row — and the pause has to name it. Its own variant rather than
          // `{of: "step"}`'s, because that sentence ends *nothing judged the diff*
          // and there is no diff one step before `implement`.
          round !== null && stopped.step === 'implement'
            ? { of: 'fix', action: round.action, round: round.round }
            : stopped.step === 'implement'
              ? { of: 'run' }
              : stopped.step === 'design'
                ? { of: 'draft', step: `design:${at ?? 'agent'}` }
                : { of: 'step', step: `${stopped.step}:${at ?? 'agent'}` },
          stopped.ending.runtime,
          stopped.ending.detail,
        )
      }
      const reason =
        stopped === null
          ? `the attempt ended without landing and without asking anybody${unpushed}`
          : `the \`${stopped.step}\` step ${stopped.ending.ending}: ${said(detailOf(stopped))}${unpushed}`
      yield* release(reason)
      return {
        ok: false,
        ticketId,
        runId,
        stage: stopped?.step ?? 'pass',
        detail: stopped === null ? reason : detailOf(stopped),
        summary: summaryOf(),
      } satisfies RunOnceResult
    })

    return yield* Effect.scoped(claimed).pipe(
      Effect.catchDefect((defect) => {
        const detail = defect instanceof Error ? defect.message : String(defect)
        return release(`unexpected failure: ${detail}`).pipe(
          Effect.as({
            ok: false as const,
            ticketId,
            runId,
            stage: 'unexpected',
            detail,
          }),
        )
      }),
      // A run that was interrupted still has to give the item back. `release` is
      // idempotent, so the paths above that already released are unaffected.
      Effect.ensuring(
        Effect.gen(function* () {
          // Interrupted while a step waited to be redone: the next claim redoes it and quotes what it was to (#1398).
          // A stream that cannot be read is not a stream with no redo in it: the read is asked again, and where it
          // still fails nothing is released, so the claim is the dead-worker scan's, which reads the stream itself.
          const events = yield* Effect.tryPromise({ try: () => store.read(runId), catch: (error) => error }).pipe(
            Effect.retry({ times: 2 }),
            Effect.result,
          )
          if (Result.isFailure(events)) {
            log(
              `the run was interrupted and its stream could not be read, so its claim is left to the scan: ${whyOf(events.failure)}`,
            )
            return
          }
          const pending = continuableRedoOf(events.success)
          yield* release(
            'the run was interrupted',
            pending === null ? null : { _tag: 'StepRedoPending', runId, step: pending.step },
          )
        }),
      ),
    )
  })
  return run.pipe(
    // Only a caught defect is the run's own to say (#791): every other status
    // comes up from the spans beneath it, and `ok`, `held` and the rest of
    // `stage` are never read — a pass held for a signoff has nothing below it
    // that failed, and one held on a crash has an action that did.
    Effect.tap((result) =>
      result.ok === false && result.stage === 'unexpected' ? Effect.annotateCurrentSpan(FAILED, true) : Effect.void,
    ),
    // A root: `runQueue` calls this once per ticket, and a pass is one trace
    // rather than a branch of the queue's (#791). No stack trace — it is a path.
    Effect.withSpan(
      'conductor.run',
      { root: true, attributes: { 'lingtai.ticket': options.issue } },
      { captureStackTrace: false },
    ),
  )
}
