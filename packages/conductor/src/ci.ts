/**
 * CI is a provider behind an interface (0130 §5, #1339). **Designed for two, built for one**: `github-actions` is the
 * only adapter in 0.16 and Jenkins shapes `trigger: 'api'` and `start` without being built, because writing the second
 * adapter before the first interface has survived real use is guessing at the wrong abstractions.
 *
 * A provider only **talks to the CI**. The verdict, the required filter, the none-started rule, the timeout and what
 * each verdict does to the PR are Lingtai's (`ciVerdict` in `@lingtai/domain`, the `ci` step in `pr.ts`) and are shared
 * by every provider. Nothing here imports an adapter.
 */
import type { CiCheck } from '@lingtai/domain'
import { Context, type Effect } from 'effect'

export interface CiCapabilities {
  /** `on-push`: the code host starts the CI by itself. `api`: Lingtai has to start it (`start`). */
  readonly trigger: 'on-push' | 'api'
  readonly canRerun: boolean
  readonly canReadLogs: boolean
}

/** The commit a PR is at. */
export interface CiHead {
  readonly sha: string
  readonly branch: string
  readonly pr?: { readonly number: number } | undefined
}

export interface CiProviderShape {
  readonly capabilities: CiCapabilities
  /** Whether the project has CI that runs on a pull request at `head`. A failed read fails: never `none`. */
  detect(head: CiHead): Effect.Effect<'configured' | 'none', Error>
  /** Starts the CI on `head`. A no-op for an on-push provider. */
  start(head: CiHead): Effect.Effect<void, Error>
  /** The checks the CI reports on `sha`. A failed read fails: never *no checks*. */
  observe(sha: string): Effect.Effect<{ readonly checks: readonly CiCheck[] }, Error>
  /** A short excerpt of why a check failed, where the provider can read logs. */
  failureExcerpt?(check: CiCheck): Effect.Effect<string | null, Error>
}

export class CiProvider extends Context.Service<CiProvider, CiProviderShape>()('@lingtai/conductor/CiProvider') {}
