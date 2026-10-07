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
 * **The command's own exit code never becomes a `failed` verdict.** The
 * worktree is put back to the agent's own `HEAD` before the command runs
 * (`KeptRunActionDeps.clean`) and, when the command did not pass, put back
 * again afterwards — so a command that only half-finished never leaves its
 * partial work in the tree `build` is about to judge. When the command passes,
 * the port commits whatever it changed (`KeptRunActionDeps.keep`); when it
 * does not, the step still passes, with the failure first in `evidence`.
 * `build`'s own copy of the same command is the backstop that catches it, at
 * the cost of the one fix round 0057 §2 already prices — this is a second
 * chance for that gate to never fire, not a second gate.
 *
 * **A `failed` verdict is still how this action answers when the worktree
 * cannot be put back.** A `clean` that answers `{ failed }`, before the
 * command or after one that did not pass, is the port's own git plumbing
 * failing rather than a judgement about the diff — a stale `.git/index.lock`
 * is the ordinary way that happens. `implement` is not a refusing step, so
 * `endingOf` turns a `failed` here into `did-not-finish` and the pass stops
 * for a person, rather than letting `build` judge a tree nobody can vouch for
 * (`#390`).
 *
 * **The port is handed in rather than built here**, for `createFileAction`'s
 * reason: a filesystem and a `git` binary are things only a caller with a
 * machine under it has, and `packages/conductor/src/conduct.ts` is that
 * caller's. `from-recipe.ts` refuses the action by name when no port is
 * supplied, rather than quietly falling back to a plain process action that
 * commits nothing.
 */
import type { Action, ActionContext, ActionResult } from './action.ts'

/** What `clean` answered. A failure here is said, never swallowed (`#390`). */
export type CleanAnswer = { readonly ok: true } | { readonly failed: string }

/** What `keep` answered after the inner action passed. */
export type KeptRunAnswer =
  /** Committed, at this head — the whole of what moves `onSha`. */
  | { readonly committed: string }
  /** Staged everything and found nothing different from `HEAD`. */
  | { readonly nothing: true }
  /** The commit itself was refused, in words a person reads (0043). */
  | { readonly failed: string }

/**
 * The port, as the only thing this action needs from its caller.
 *
 * A method on an object rather than a bare function, so the shape matches
 * `FileActionDeps` and a reader meets one convention.
 */
export interface KeptRunActionDeps {
  /**
   * Puts the worktree back to the agent's own `HEAD` — `git reset --hard
   * HEAD`, then `git clean -fd` with the planted env file excluded. Called
   * before the command runs, and again afterwards when it did not pass or
   * when the commit was refused.
   */
  clean(): Promise<CleanAnswer>
  /** Stages everything and commits it, where there is a difference from `HEAD`. */
  keep(name: string): Promise<KeptRunAnswer>
}

export function createKeptRunAction(name: string, inner: Action, deps: KeptRunActionDeps): Action {
  return {
    name,
    kind: 'run',

    async run(context: ActionContext): Promise<ActionResult> {
      const cleaned = await deps.clean()
      if ('failed' in cleaned) {
        return {
          verdict: 'failed',
          evidence: `"${name}" did not run: the worktree could not be put back to HEAD first (${cleaned.failed})`,
          findings: [],
        }
      }

      const ran = await inner.run(context)

      if (ran.verdict !== 'passed') {
        const recleaned = await deps.clean()
        if ('failed' in recleaned) {
          return {
            verdict: 'failed',
            evidence: `${ran.evidence} — and the tree could not be put back afterwards (${recleaned.failed}); build must not judge it`,
            findings: [],
          }
        }
        return {
          verdict: 'passed',
          evidence: `${ran.evidence} — nothing committed, \`build\` judges the agent's commit as it stands`,
          findings: [],
        }
      }

      const kept = await deps.keep(name)
      if ('committed' in kept) {
        return {
          verdict: 'passed',
          evidence: `${ran.evidence} — committed ${kept.committed.slice(0, 7)}`,
          findings: [],
          head: kept.committed,
        }
      }
      if ('nothing' in kept) {
        return { verdict: 'passed', evidence: `${ran.evidence} — nothing to commit`, findings: [] }
      }

      const recleaned = await deps.clean()
      if ('failed' in recleaned) {
        return {
          verdict: 'failed',
          evidence:
            `${ran.evidence} — the commit was refused (${kept.failed}), and the tree could not be put back ` +
            `(${recleaned.failed}); build must not judge it`,
          findings: [],
        }
      }
      return {
        verdict: 'passed',
        evidence:
          `${ran.evidence} — the commit was refused (${kept.failed}); nothing committed, \`build\` judges ` +
          "the agent's commit as it stands",
        findings: [],
      }
    },
  }
}
