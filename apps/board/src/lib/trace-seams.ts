import { setRequestObserver } from '@lingtai/github'
import { setAcquireObserver } from '@lingtai/projector'

import { traced } from './timing.ts'

/**
 * Hands the shared packages their one way to be measured (#1144). **They start
 * no spans of their own**: the board exports only its own scope, and the daemon
 * exports every one, so a span begun inside a package would miss this trace and
 * land in every pass's. Each package offers a seam that does nothing until
 * somebody installs it, and the board is the only one that does.
 *
 * Called from `installTracing`, so with no `telemetry.otlp_endpoint` nothing is
 * installed and a request or a read is what it was.
 */
export function installTraceSeams(): void {
  setRequestObserver((info, run) =>
    traced(
      'github.request',
      (span) =>
        run((remaining) => {
          // Absent or not a number is left off: never `0`, which would claim a limit that was not seen.
          if (remaining !== undefined) span.setAttribute('lingtai.ratelimit.remaining', remaining)
        }),
      info.page === undefined
        ? { 'lingtai.method': info.method }
        : { 'lingtai.method': info.method, 'lingtai.page': info.page },
    ),
  )
  // A sibling inside the read's own span: how long the read waited for one of the pool's connections.
  setAcquireObserver((run) => traced('db.acquire', () => run()))
}
