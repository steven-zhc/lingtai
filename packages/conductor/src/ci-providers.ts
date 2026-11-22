/**
 * The registry of CI providers by the name `pr.ci.provider` carries (#1338). 0.16 registers `github-actions` only; the
 * Jenkins adapter next release is one entry here and one file beside `ci-github-actions.ts`.
 */
import { type Recipe, ciOf } from '@lingtai/recipe'

import { type GithubActionsDeps, githubActionsProvider } from './ci-github-actions.ts'
import type { CiProviderShape } from './ci.ts'

export const CiProviders = {
  'github-actions': githubActionsProvider,
} as const satisfies Record<string, (deps: GithubActionsDeps) => CiProviderShape>

/** The provider a recipe names (`detect` asks `github-actions`), or null for `none`. */
export const ciProviderFor = (recipe: Recipe, deps: GithubActionsDeps): CiProviderShape | null =>
  ciOf(recipe).provider === 'none' ? null : CiProviders['github-actions'](deps)
