import { HOLD_LABEL, PR_FIX_LABEL } from '@lingtai/conductor/labels'
import type { GithubReach } from '@lingtai/conductor/onboard'
/**
 * The labels a GitHub project's queue reads, made at `add` (#1486).
 *
 * A repository made from a template carries an issue form's `labels:` but not the
 * labels themselves, and GitHub drops an unknown label without an error, so the queue
 * later passes the issue over as `no-kind`. `add` therefore makes every kind the recipe
 * names, plus `lingtai:hold` and, in team mode, `lingtai:pr-fix`. A label that exists
 * is left alone, and nothing here ever makes the add fail.
 */
import { githubApp } from '@lingtai/env'
import { createGitHubClient, type GitHubClient, installationForRepo } from '@lingtai/github'
import { kindsOf, modeOf, type Recipe } from '@lingtai/recipe'
import { Effect } from 'effect'

import { attempt } from './add-github.ts'
import { lift } from './exit.ts'

/** Why a label is not there: GitHub refused it (`denied`), or nothing answered (`unchecked`). */
export type MissingLabel = { name: string; why: 'denied' | 'unchecked' }

export interface LabelOutcome {
  created: string[]
  existed: string[]
  missing: MissingLabel[]
}

/** What a test stubs: only `createLabel` is ever used. */
export type LabelClient = Pick<GitHubClient, 'createLabel'>

/** The names to make, in order: the kinds, the hold label, and `pr-fix` in team mode — one per lower-cased name. */
export function labelNames(recipe: Recipe): string[] {
  const all = [...kindsOf(recipe), HOLD_LABEL, ...(modeOf(recipe) === 'team' ? [PR_FIX_LABEL] : [])]
  const seen = new Set<string>()
  const names: string[] = []
  for (const name of all) {
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    names.push(name)
  }
  return names
}

/** Status 0 is the live client's "no answer" (a transport failure), not an HTTP response. */
const hasStatus = (err: unknown): boolean =>
  typeof err === 'object' &&
  err !== null &&
  typeof (err as { status?: unknown }).status === 'number' &&
  (err as { status: number }).status > 0

/** The client `add` used to reach the repository, built again from `reach` (an App machine looks its installation up once more). */
export const liveLabelClient = (owner: string, repo: string, reach: GithubReach): Effect.Effect<LabelClient, unknown> =>
  Effect.gen(function* () {
    if (reach.kind === 'gh') {
      return yield* lift(() => createGitHubClient({ auth: { kind: 'gh' }, owner, repo }))
    }
    const auth = githubApp()
    const installation = yield* lift(() => installationForRepo(auth, owner, repo))
    return yield* lift(() => createGitHubClient({ auth, owner, repo, installation }))
  })

/**
 * `createLabel` for each name in turn. A failure for one name is that name's alone and
 * never stops the others; a client that could not be built leaves every name unchecked.
 */
export const ensureLabelsEffect = (
  client: Effect.Effect<LabelClient, unknown>,
  names: readonly string[],
): Effect.Effect<LabelOutcome> =>
  Effect.gen(function* () {
    const out: LabelOutcome = { created: [], existed: [], missing: [] }
    const built = yield* attempt(client)
    if ('threw' in built) {
      out.missing = names.map((name) => ({ name, why: 'unchecked' as const }))
      return out
    }
    const github = built.ok
    yield* Effect.forEach(names, (name) =>
      Effect.gen(function* () {
        const made = yield* attempt(lift(() => github.createLabel(name)))
        if ('threw' in made) {
          out.missing.push({ name, why: hasStatus(made.threw) ? 'denied' : 'unchecked' })
        } else if (made.ok === 'created') {
          out.created.push(name)
        } else {
          out.existed.push(name)
        }
      }),
    )
    return out
  })
