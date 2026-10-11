/**
 * Which moves a held card offers, and whether triage runs on it — 0118 §1's
 * one place for a question five callers used to answer each for themselves
 * (#442, #443). Both are exhaustive over `Hold`'s nine tags, following
 * `doc/design/the-waiting-lane.md`'s table.
 *
 * `import type` only: a `Move` value is a bare `{ _tag: '...' }` literal, so
 * this file needs no runtime import from `./triage.ts` or `./hold.ts`, which
 * keeps it out of the load-order problem `triage.ts:5-11` describes.
 */
import type { Hold } from './hold.ts'
import type { Move } from './triage.ts'

/**
 * `doc/design/the-waiting-lane.md`'s table, row by row. Each `case` is
 * listed and there is no `default`: with `strict` on, a tenth `Hold` tag
 * makes this non-exhaustive and `pnpm typecheck` goes red rather than
 * silently falling through. Not `Match.exhaustive` — 0101 §4 keeps
 * `@lingtai/domain`'s only dependency `zod`.
 */
export function allowedMoves(hold: Hold): Move[] {
  switch (hold._tag) {
    case 'Question':
      return [{ _tag: 'Requeue' }, { _tag: 'Close' }, { _tag: 'Answer' }]
    case 'Asked':
      return [{ _tag: 'Requeue' }, { _tag: 'Close' }]
    case 'Human':
      return [{ _tag: 'Approve' }, { _tag: 'Requeue' }, { _tag: 'Close' }]
    case 'Routed':
    case 'CheckRed':
      return hold.run.unpushed === undefined
        ? [{ _tag: 'Approve' }, { _tag: 'Requeue' }, { _tag: 'Close' }]
        : [{ _tag: 'Requeue' }, { _tag: 'Close' }]
    // Its own case, not folded into the one above: `afterApproval` refuses
    // Approve on its own, whatever `unpushed` says — the `approve.ts`
    // producer never carries `unpushed` (it is bound to a sha already on
    // origin), so the two conditions cannot be merged into one expression
    // without one of them reading as dead code.
    case 'MergeRefused':
      return hold.afterApproval || hold.run.unpushed !== undefined
        ? [{ _tag: 'Requeue' }, { _tag: 'Close' }]
        : [{ _tag: 'Approve' }, { _tag: 'Requeue' }, { _tag: 'Close' }]
    case 'Ceiling':
    case 'DidNotFinish':
    case 'SetupRefused':
      return [{ _tag: 'Requeue' }, { _tag: 'Close' }]
  }
}

/**
 * Same table, its other column. No `default`, for the same reason as
 * {@link allowedMoves}.
 */
export function triageRuns(hold: Hold): boolean {
  switch (hold._tag) {
    case 'Question':
      return false
    case 'Asked':
    case 'Human':
    case 'Routed':
    case 'MergeRefused':
    case 'Ceiling':
    case 'DidNotFinish':
    case 'SetupRefused':
    case 'CheckRed':
      return true
  }
}
