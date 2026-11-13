import { type Duration, Effect, Result } from 'effect'

import { RepoFailed } from './git.ts'

/**
 * Git's words for *somebody else got there first*.
 *
 * The bracketed reason differs — `fetch first`, `non-fast-forward` — and the
 * wording has moved between versions, so what is matched is the rejection
 * itself rather than any one cause of it. A push that failed for some other
 * reason (no credentials, no network) is not this, and goes to the unexpected
 * channel where it belongs. The exception is a protected base (`BASE_PROTECTED`).
 */
export const PUSH_REJECTED = /\[rejected\]|non-fast-forward|fetch first|updates were rejected/i

/**
 * GitHub's words for *this branch is protected*: `GH006` and `protected branch
 * hook declined` for a classic rule, `GH013` and `repository rule violations`
 * for a ruleset. Matched before `PUSH_REJECTED`, which a `[remote rejected]`
 * line would otherwise satisfy — and never retried, because nothing a later
 * push does can lift a setting (#662).
 */
export const BASE_PROTECTED = /protected branch hook declined|GH006|GH013|repository rule violations/i

/**
 * Git's English words for *origin did not answer* (#1029). Read off stderr that
 * `gitInvocation` has forced into English with `LC_ALL=C`; any wording not
 * listed here is not transient, and reads as it always did.
 */
const UNREACHABLE =
  /unable to access '|Could not resolve host|Could not connect to server|Failed to connect to|Operation timed out|Connection timed out|Connection reset|Connection refused|Recv failure|Send failure|early EOF|RPC failed|The requested URL returned error: 5\d\d|remote end hung up unexpectedly|SSL_ERROR_SYSCALL|gnutls_handshake/i

/** True when git's text says origin could not be reached. A real rejection always wins. */
export function isUnreachable(text: string): boolean {
  if (text === '') return false
  if (PUSH_REJECTED.test(text) || BASE_PROTECTED.test(text)) return false
  return UNREACHABLE.test(text)
}

/** `isUnreachable` over a failure: stderr when git gave one, the detail otherwise. */
export function isUnreachableFailure(err: RepoFailed): boolean {
  return isUnreachable(err.stderr ?? err.detail)
}

/**
 * Git's own frame for *the server answered the ref with a 5xx* (#1125):
 * `! [remote rejected] <src> -> <dst> (Internal Server Error)`. The frame is
 * git's, the parenthesised reason is the server's, and only RFC 9110's phrases
 * for 500, 502, 503 and 504 are read — `protected branch hook declined` and
 * `pre-receive hook declined` arrive on the same line and are not transient.
 * No `$` anchor: `retryUnreachable` appends ` (after N tries)` to the detail.
 */
const REMOTE_ERROR =
  /^\s*!\s+\[remote rejected\]\s+\S+\s+->\s+\S+\s+\((Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\)/im

/** True when git's text says the server answered a push with a 5xx. A real rejection always wins. */
export function isRemoteError(text: string): boolean {
  if (text === '') return false
  if (PUSH_REJECTED.test(text) || BASE_PROTECTED.test(text)) return false
  return REMOTE_ERROR.test(text)
}

/** `isRemoteError` over a failure: stderr when git gave one, the detail otherwise. */
export function isRemoteErrorFailure(err: RepoFailed): boolean {
  return isRemoteError(err.stderr ?? err.detail)
}

/** The ref a `[remote rejected]` line names, or null when the text has no such frame. */
export function remoteErrorRef(text: string): string | null {
  const m = /^\s*!\s+\[remote rejected\]\s+\S+\s+->\s+(\S+)/im.exec(text)
  return m?.[1]?.replace(/^refs\/heads\//, '') ?? null
}

/** The waits between tries: three tries in all, so the count is never written apart from the list. */
export const UNREACHABLE_WAITS: readonly Duration.Input[] = ['10 seconds', '30 seconds']

/**
 * Run `effect` again while it fails because origin could not be reached, or
 * answered a push with a 5xx (`isRemoteErrorFailure`, #1125).
 *
 * **Wrap the permit, never the other way round**: `retryUnreachable(mirrorWrite(…))`
 * takes and releases a permit per try and sleeps with none held (0122 §6, #1026).
 *
 * When the tries run out the last `RepoFailed` comes back with `(after N tries)`
 * on its detail; a caller reads it with `isUnreachableFailure`.
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
      if (!isUnreachableFailure(err) && !isRemoteErrorFailure(err)) return yield* Effect.fail(err)
      const wait = waits[i]
      if (wait === undefined) {
        return yield* Effect.fail(new RepoFailed({ ...err, detail: `${err.detail} (after ${tries} tries)` }))
      }
      yield* Effect.sleep(wait)
    }
  })
