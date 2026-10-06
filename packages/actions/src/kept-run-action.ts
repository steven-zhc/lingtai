/**
 * The `run` at `implement`: a command that runs after the implementing agent
 * and commits what it changed onto the attempt's branch — `#390`.
 *
 * **It wraps an ordinary process action and does not reimplement it.** The
 * inner action is `createProcessAction`'s, built exactly as a `run:` at `build`
 * or `proposed` is; what this adds is the one thing `implement` needs that no
 * other step does — the step may not refuse (`REFUSING_STEPS`,
 * `packages/conductor/src/pass.ts`), so a formatter that exits non-zero cannot
 * become a refusal the step has no way to make.
 *
 * **So this action never returns `failed`.** When the inner action passes, the
 * port commits whatever it changed (`KeptRunActionDeps.keep`); when it does
 * not — a non-zero exit, a timeout, or the commit itself refused — the port
 * puts the tracked files back to `HEAD` (`KeptRunActionDeps.restore`) and the
 * step still passes, with the failure first in `evidence`. `build`'s own copy
 * of the same command is the backstop that catches it, at the cost of the one
 * fix round 0057 §2 already prices — this is a second chance for that gate to
 * never fire, not a second gate.
 *
 * **What the command found dirty, it must leave alone.** The implementing
 * agent may have left the worktree carrying uncommitted work it decided
 * against — an edit it chose not to commit, an experiment it never staged.
 * `baseline()` is read *before* `inner.run` so `keep` and `restore` both know
 * what that was, and neither ever stages, commits or deletes any of it: `keep`
 * commits only what changed *since* the baseline, and `restore` removes only
 * what the command left behind, never what was already there (`#390`).
 *
 * **The port is handed in rather than built here**, for `createFileAction`'s
 * reason: a filesystem and a `git` binary are things only a caller with a
 * machine under it has, and `packages/conductor/src/kept-run-port.ts` is that
 * caller's. `from-recipe.ts` refuses the action by name when no port is
 * supplied, rather than quietly falling back to a plain process action that
 * commits nothing.
 */
import type { Action, ActionContext, ActionResult } from './action.ts'

/** What the port answered after the inner action passed. */
export type KeptRunAnswer =
  /** Committed, at this head — the whole of what moves `onSha`. */
  | { readonly committed: string }
  /** Staged everything but the baseline and found nothing different from `HEAD`. */
  | { readonly clean: true }
  /** The commit itself was refused, in words a person reads (0043). */
  | { readonly notKept: string }

/** What `restore` answered. A failure here is said, never swallowed (`#390`). */
export type RestoreAnswer = { readonly ok: true } | { readonly failed: string }

/**
 * The port, as the only thing this action needs from its caller.
 *
 * A method on an object rather than a bare function, so the shape matches
 * `FileActionDeps` and a reader meets one convention.
 */
export interface KeptRunActionDeps {
  /** What is already dirty or untracked before the command runs — `keep` and `restore` leave every one of these alone. */
  baseline(): Promise<ReadonlySet<string>>
  /** Stages everything but `baseline`, and commits it where there is a difference from `HEAD`. */
  keep(spec: { readonly name: string }, baseline: ReadonlySet<string>): Promise<KeptRunAnswer>
  /** Puts tracked files back to `HEAD` and removes what the run left untracked — called only when the run did not pass. */
  restore(baseline: ReadonlySet<string>): Promise<RestoreAnswer>
}

/** The tail every evidence string carries once `restore` has run, naming it when `restore` itself did not finish the job. */
function restoreCaveat(restored: RestoreAnswer): string {
  return 'failed' in restored ? ` — the tree was not fully restored (${restored.failed})` : ''
}

export function createKeptRunAction(name: string, inner: Action, deps: KeptRunActionDeps): Action {
  return {
    name,
    kind: 'run',

    async run(context: ActionContext): Promise<ActionResult> {
      const baseline = await deps.baseline()
      const ran = await inner.run(context)

      if (ran.verdict !== 'passed') {
        const restored = await deps.restore(baseline)
        return {
          verdict: 'passed',
          evidence:
            `${ran.evidence} — nothing committed, the tree is back where \`${name}\` found it; ` +
            "`build` judges the agent's commit as it stands" +
            restoreCaveat(restored),
          findings: [],
        }
      }

      const kept = await deps.keep({ name }, baseline)
      if ('committed' in kept) {
        return {
          verdict: 'passed',
          evidence: `${ran.evidence} — committed ${kept.committed.slice(0, 7)}`,
          findings: [],
          head: kept.committed,
        }
      }
      if ('clean' in kept) {
        return { verdict: 'passed', evidence: `${ran.evidence} — nothing to commit`, findings: [] }
      }

      const restored = await deps.restore(baseline)
      return {
        verdict: 'passed',
        evidence:
          `${ran.evidence} — the commit was refused (${kept.notKept}); nothing committed, the tree is back ` +
          `where \`${name}\` found it` +
          restoreCaveat(restored),
        findings: [],
      }
    },
  }
}
