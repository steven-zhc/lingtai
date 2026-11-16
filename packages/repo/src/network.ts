import { UNREACHABLE_WAITS, classify } from '@lingtai/domain'
import { type Duration, Effect, Result } from 'effect'

import { RepoFailed } from './git.ts'

/**
 * Run `effect` again while it fails because origin could not be reached, or
 * answered a push with a 5xx (`remote-error`, #1125).
 *
 * **Wrap the permit, never the other way round**: `retryUnreachable(mirrorWrite(…))`
 * takes and releases a permit per try and sleeps with none held (0122 §6, #1026).
 *
 * When the tries run out the last `RepoFailed` comes back with `(after N tries)`
 * on its detail; a caller reads it with `classify`.
 */
export const retryUnreachable = <A, R>(
  effect: Effect.Effect<A, RepoFailed, R>,
  waits: readonly Duration.Input[] = UNREACHABLE_WAITS,
): Effect.Effect<A, RepoFailed, R> =>
  Effect.gen(function* () {
    const tries = waits.length + 1
    for (let i = 0; ; i++) {
      const result = yield* Effect.result(effect)
      if (Result.isSuccess(result)) return result.success
      const err = result.failure
      const said = classify({ platform: 'git', text: err.stderr ?? err.detail })?.kind
      if (said !== 'unreachable' && said !== 'remote-error') return yield* Effect.fail(err)
      const wait = waits[i]
      if (wait === undefined) {
        return yield* Effect.fail(new RepoFailed({ ...err, detail: `${err.detail} (after ${tries} tries)` }))
      }
      yield* Effect.sleep(wait)
    }
  })
