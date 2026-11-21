/**
 * The `github-actions` adapter of `CiProvider` (#1339): two reads on the `GitHub` Effect face for `observe`, and the
 * workflow files at the PR's head for `detect`. It decides nothing — the verdict is `ciVerdict`'s.
 */
import type { CiCheck, CiCheckState } from '@lingtai/domain'
import type { CheckRun, GitHub } from '@lingtai/github'
import { Effect } from 'effect'
import { parse as parseYaml } from 'yaml'

import type { CiProviderShape } from './ci.ts'

export interface GithubActionsDeps {
  readonly github: GitHub
  /** `git` in the project's mirror: an exit code is an answer, never a failure. */
  readonly git: (
    args: readonly string[],
  ) => Effect.Effect<{ readonly code: number | null; readonly stdout: string }, Error>
}

const asDate = (iso: string | null): Date | undefined => (iso === null ? undefined : new Date(iso))

/** A check run's state: only GitHub's documented `conclusion`s are read as themselves, anything else is `unknown`. */
export function checkRunState(run: Pick<CheckRun, 'status' | 'conclusion'>): CiCheckState {
  if (run.status === 'in_progress') return 'running'
  if (run.status !== 'completed') return 'queued'
  switch (run.conclusion) {
    case 'success':
    case 'failure':
    case 'neutral':
    case 'skipped':
    case 'cancelled':
      return run.conclusion
    case 'timed_out':
      return 'timed-out'
    default:
      return 'unknown'
  }
}

const statusState = (state: string): CiCheckState =>
  state === 'success'
    ? 'success'
    : state === 'pending'
      ? 'running'
      : state === 'failure' || state === 'error'
        ? 'failure'
        : 'unknown'

/** Whether a workflow file's top-level `on` names `pull_request` or `pull_request_target`: a string, a list or a map key. */
export function runsOnPullRequest(source: string): boolean {
  let doc: unknown
  try {
    // `yaml`'s default is YAML 1.2, where the key `on` is a string (1.1 reads it as `true`).
    doc = parseYaml(source)
  } catch {
    return true // a file that does not parse counts as configured: the safe side
  }
  if (typeof doc !== 'object' || doc === null) return true
  const on = (doc as Record<string, unknown>)['on']
  const names = ['pull_request', 'pull_request_target']
  if (typeof on === 'string') return names.includes(on)
  if (Array.isArray(on)) return on.some((e) => typeof e === 'string' && names.includes(e))
  if (typeof on === 'object' && on !== null) return names.some((name) => name in on)
  return true
}

export function githubActionsProvider(deps: GithubActionsDeps): CiProviderShape {
  const { github, git } = deps
  return {
    capabilities: { trigger: 'on-push', canRerun: false, canReadLogs: false },
    detect: (head) =>
      Effect.gen(function* () {
        const listed = yield* git(['ls-tree', '--name-only', head.sha, '.github/workflows/'])
        if (listed.code !== 0)
          return yield* Effect.fail(new Error(`git ls-tree answered exit ${listed.code ?? 'nothing'}`))
        const files = listed.stdout
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => /\.ya?ml$/.test(l))
        for (const file of files) {
          const shown = yield* git(['show', `${head.sha}:${file}`])
          if (shown.code !== 0)
            return yield* Effect.fail(new Error(`git show ${file} answered exit ${shown.code ?? 'nothing'}`))
          if (runsOnPullRequest(shown.stdout)) return 'configured' as const
        }
        return 'none' as const
      }),
    start: () => Effect.void,
    observe: (sha) =>
      Effect.gen(function* () {
        const runs = yield* github.checkRunsAt(sha)
        const combined = yield* github.combinedStatusAt(sha)
        const checks: CiCheck[] = runs.map((r) => ({
          name: r.name,
          state: checkRunState(r),
          url: r.url,
          startedAt: asDate(r.startedAt),
          endedAt: asDate(r.completedAt),
          // Listing a run's uploaded artifacts needs `actions: read`, which 0.16 does not ask for: the check's `details_url` as its log link only.
          artifacts: r.detailsUrl === '' ? [] : [{ kind: 'log' as const, name: 'log', url: r.detailsUrl }],
        }))
        // `total_count: 0` is *no statuses*: the combined state reads `pending` then, and that is not a check.
        if (combined.total > 0) {
          for (const s of combined.statuses) {
            checks.push({ name: s.context, state: statusState(s.state), url: s.url ?? '' })
          }
        }
        return { checks }
      }),
  }
}
