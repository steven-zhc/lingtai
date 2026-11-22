/**
 * What a PR that waits on a person shows (#1314): one pure view over the reduced PR state, read by `lingtai pr` and by the PR
 * page, so the two say the same thing. It reads the log's facts and never git; spend is the `spend` projection's.
 */
import type { PayloadOf } from './events.ts'
import { type PrState, conflictRoundsLeft, grantedFor } from './pr.ts'

type WaitReason = PayloadOf<'PrWaiting'>['reason']

/** The waits a person can end with `lingtai pr retry`: the sync ones and the three CI ones (#1355). */
const RETRYABLE: ReadonlySet<WaitReason> = new Set<WaitReason>([
  'ci-red',
  'ci-none-started',
  'ci-timeout',
  'sync-conflict',
  'sync-red',
  'sync-unknown',
  'sync-rewritten',
  'sync-locked',
])

export interface PrWaitFacts {
  readonly project: string
  /** The local checkout's path, for `git -C`; null where the project has none on this machine. */
  readonly checkout: string | null
  /** The recipe's `attempt.conflictResolutions`: what a commit is allowed before a person adds to it. */
  readonly conflictResolutions: number
}

/** A wait the PR's own conflict agent could not end: both sides, the rounds, and how to resolve it by hand. **Null is unknown.** */
export interface PrConflictWait {
  readonly kind: 'conflict'
  readonly since: Date | null
  readonly reason: 'sync-conflict' | 'sync-locked'
  readonly detail: string
  /** The `main` commit being merged. */
  readonly commit: string | null
  readonly merging: 'main' | 'back' | null
  readonly mainAhead: number | null
  readonly paths: readonly string[] | null
  readonly roundsUsed: number | null
  readonly roundsAllowed: number | null
  readonly ours: readonly { readonly issue: string; readonly title: string; readonly mergeCommit: string }[] | null
  readonly theirs: readonly { readonly sha: string; readonly author: string; readonly subject: string }[] | null
  readonly lastRefusal: { readonly step: string; readonly said: string } | null
  readonly commands: readonly string[]
}

/** Any other wait: what happened, and — for the ones a retry ends — the one command. Nothing invented. */
export interface PrPlainWait {
  readonly kind: 'plain'
  readonly since: Date | null
  readonly reason: PayloadOf<'PrWaiting'>['reason']
  readonly step: string
  readonly detail: string
  readonly commands: readonly string[]
}

export type PrWaitView = PrConflictWait | PrPlainWait

const short = (sha: string): string => sha.slice(0, 7)

/** A path as a shell reads it: quoted unless plain, keeping a leading `~/` live. */
const shellPath = (path: string): string => {
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(path)) return path
  const quote = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`
  return path.startsWith('~/') ? `~/${quote(path.slice(2))}` : quote(path)
}

/** The mock's four lines (0130 §6): switch to the PR branch, merge `main`, push, and check again. */
function commandsFor(state: PrState, facts: PrWaitFacts): string[] {
  const git = facts.checkout === null ? 'git' : `git -C ${shellPath(facts.checkout)}`
  const prBranch = state.prBranch ?? '<pr-branch>'
  const main = state.main ?? 'main'
  const never = state.lastPushed === null
  return [
    never ? `${git} switch -c ${prBranch} ${short(state.frozenSha ?? '')}` : `${git} switch ${prBranch}`,
    `${git} merge origin/${main} # resolve, commit`,
    never ? `${git} push -u origin ${prBranch}` : `${git} push`,
    `lingtai pr retry ${facts.project} # checks it, builds it, goes on`,
  ]
}

/** The view of a waiting PR, or null when it is not waiting. */
export function prWaitOf(state: PrState, facts: PrWaitFacts): PrWaitView | null {
  const wait = state.wait
  if (state.status !== 'waiting' || wait === null) return null
  const since = state.waitSince
  if (wait.reason === 'sync-conflict' || wait.reason === 'sync-locked') {
    const c = wait.conflict ?? null
    const used = c === null ? null : conflictRoundsLeft(state, c.merging, c.commit, facts.conflictResolutions).used
    return {
      kind: 'conflict',
      since,
      reason: wait.reason,
      detail: wait.detail,
      commit: c?.commit ?? null,
      merging: c?.merging ?? null,
      mainAhead: c?.mainAhead ?? null,
      paths: c?.paths ?? null,
      roundsUsed: used,
      roundsAllowed: c === null ? null : facts.conflictResolutions + grantedFor(state, c.merging, c.commit),
      ours:
        c === null || c.unread?.ours
          ? null
          : c.ours.map((o) => ({ issue: o.number, title: o.title, mergeCommit: o.mergeCommit })),
      theirs: c === null || c.unread?.theirs ? null : c.theirs,
      lastRefusal: c?.last ?? null,
      commands: commandsFor(state, facts),
    }
  }
  return {
    kind: 'plain',
    since,
    reason: wait.reason,
    step: wait.step,
    detail: wait.detail,
    commands: RETRYABLE.has(wait.reason) ? [`lingtai pr retry ${facts.project}`] : [],
  }
}
