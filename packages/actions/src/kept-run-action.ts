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
 * **The command's own exit code never becomes a `failed` verdict.** When the
 * inner action passes, the port commits whatever it changed
 * (`KeptRunActionDeps.keep`); when it does not — a non-zero exit, a timeout, or
 * the commit itself refused — the port puts the tracked files back to `HEAD`
 * (`KeptRunActionDeps.restore`) and the step still passes, with the failure
 * first in `evidence`. `build`'s own copy of the same command is the backstop
 * that catches it, at the cost of the one fix round 0057 §2 already prices —
 * this is a second chance for that gate to never fire, not a second gate.
 *
 * **A `failed` verdict is still how this action answers when it cannot tell
 * what is safe to touch, or cannot put what it touched back.** `baseline()`
 * answering `unreadable`, or `restore()` answering `{ failed }`, are both the
 * port's own git plumbing failing rather than a judgement about the diff — a
 * stale `.git/index.lock` is the ordinary way the second happens. Neither is
 * absorbed the way the command's exit code is: `implement` is not a refusing
 * step, so `endingOf` turns a `failed` here into `did-not-finish` and the pass
 * stops for a person, rather than letting `build` judge a tree nobody can
 * vouch for (`#390`).
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
 * What is already dirty or untracked before the command runs, or why that
 * could not be told. An `unreadable` answer is read the same as a `failed`
 * `restore` — the action has no way to tell the agent's own leftovers apart
 * from what the command is about to do, so it refuses rather than guessing
 * and risking either a sweep into the commit or a deletion (`#390`).
 */
export type BaselineAnswer = { readonly paths: ReadonlySet<string> } | { readonly unreadable: string }

/**
 * The port, as the only thing this action needs from its caller.
 *
 * A method on an object rather than a bare function, so the shape matches
 * `FileActionDeps` and a reader meets one convention.
 */
export interface KeptRunActionDeps {
  /** What is already dirty or untracked before the command runs — `keep` and `restore` leave every one of these alone. */
  baseline(): Promise<BaselineAnswer>
  /** Stages everything but `baseline`, and commits it where there is a difference from `HEAD`. */
  keep(spec: { readonly name: string }, baseline: ReadonlySet<string>): Promise<KeptRunAnswer>
  /** Puts tracked files back to `HEAD` and removes what the run left untracked — called only when the run did not pass. */
  restore(baseline: ReadonlySet<string>): Promise<RestoreAnswer>
}

export function createKeptRunAction(name: string, inner: Action, deps: KeptRunActionDeps): Action {
  return {
    name,
    kind: 'run',

    async run(context: ActionContext): Promise<ActionResult> {
      const baseline = await deps.baseline()
      // **Refused by name rather than guessed at.** Neither `keep` nor
      // `restore` is safe to call without knowing what was already dirty:
      // `keep` would sweep an agent's abandoned work into the commit, and
      // `restore` would delete it outright. `implement` is not a refusing
      // step, so this is `failed` rather than `passed` — it stops the pass
      // for a person instead of quietly proceeding on a tree nobody checked.
      if ('unreadable' in baseline) {
        return {
          verdict: 'failed',
          evidence: `git status refused it: ${baseline.unreadable} — \`${name}\` did not run, nothing committed`,
          findings: [],
        }
      }

      const ran = await inner.run(context)

      if (ran.verdict !== 'passed') {
        const restored = await deps.restore(baseline.paths)
        if ('failed' in restored) {
          return {
            verdict: 'failed',
            evidence: `${ran.evidence} — the tree could not be restored (${restored.failed}); build must not judge it`,
            findings: [],
          }
        }
        return {
          verdict: 'passed',
          evidence:
            `${ran.evidence} — nothing committed, the tree is back where \`${name}\` found it; ` +
            "`build` judges the agent's commit as it stands",
          findings: [],
        }
      }

      const kept = await deps.keep({ name }, baseline.paths)
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

      const restored = await deps.restore(baseline.paths)
      if ('failed' in restored) {
        return {
          verdict: 'failed',
          evidence:
            `${ran.evidence} — the commit was refused (${kept.notKept}), and the tree could not be restored ` +
            `(${restored.failed}); build must not judge it`,
          findings: [],
        }
      }
      return {
        verdict: 'passed',
        evidence:
          `${ran.evidence} — the commit was refused (${kept.notKept}); nothing committed, the tree is back ` +
          `where \`${name}\` found it`,
        findings: [],
      }
    },
  }
}
