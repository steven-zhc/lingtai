/**
 * The live `pressed` behind `waitForApp`'s "press Create on that page, or any
 * key here to skip" (#393, #394) — resolving on the first keypress at a real
 * terminal, raw mode so a bare key (not Enter) counts.
 *
 * Pulled out of `init.ts` so `first-project.ts` can give `lingtai add` the
 * same working skip without the two files importing each other — the same
 * reason `app-check.ts` and `board.ts`'s `boardAt` were pulled out.
 */

/** The slice of `process.stdin` `waitForKeypress` needs — narrow enough that a real socket can stand in for it in a test. */
export interface RawStdin {
  readonly isTTY: boolean | undefined
  setRawMode: (mode: boolean) => void
  resume: () => void
  pause: () => void
  on: (event: 'data', listener: (data: Buffer) => void) => void
  removeListener: (event: 'data', listener: (data: Buffer) => void) => void
}

/**
 * Resolves on the first keypress at a TTY, or never (until `signal` aborts)
 * with no TTY — exported so a real OS-backed stream can exercise the backlog
 * guard below without a real terminal (#393).
 *
 * Raw mode so a bare keypress resolves it rather than waiting on Enter —
 * undone in every exit path, or `ctrl-c stops it` (init.ts's board line)
 * would stop working for the rest of the session.
 *
 * `resumeLine` is what Ctrl+C prints is still true — `init.ts`'s own line by
 * default, since that was this function's only caller before #394; `lingtai
 * add` (`first-project.ts`) names itself instead, same reason `kept` does.
 */
export function waitForKeypress(
  stdin: RawStdin,
  signal: AbortSignal,
  resumeLine = 'lingtai init again continues from here',
): Promise<void> {
  return new Promise((resolve) => {
    if (!stdin.isTTY) {
      signal.addEventListener('abort', () => resolve(), { once: true })
      return
    }
    // Set once the wait ends any way at all, so the deferred swap below —
    // scheduled before any of that can happen — never re-attaches `onData`
    // onto a stdin this promise has already let go of.
    let settled = false
    const done = () => {
      settled = true
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', discard)
      stdin.removeListener('data', onData)
      signal.removeEventListener('abort', onAbort)
    }
    const onData = (data: Buffer) => {
      // Ctrl+C in raw mode arrives as this byte, not SIGINT — and must never count as a skip.
      if (data.toString('utf8') === '\x03') {
        done()
        console.log(`\nstopped — nothing further was asked, and ${resumeLine}`)
        process.exit(130)
      }
      done()
      resolve()
    }
    // A key pressed while stdin was paused during the board's boot sits in
    // the tty's own buffer and would otherwise arrive the instant `resume`
    // below is called — not a deliberate skip of a wait that has not visibly
    // started yet. Discard that backlog, then switch to listening for an
    // actual press.
    //
    // A single `setImmediate` is not enough: entered from an I/O continuation
    // (`waitForApp` awaits `world.open` before racing this in), the swap below
    // would run in the *check* phase of the loop iteration already under way —
    // before the *poll* phase that delivers a byte already sitting in the
    // tty's buffer, so that byte would reach `onData` instead of `discard`.
    // An immediate scheduled from inside an executing immediate is deferred to
    // the *next* iteration's check phase, which comes after that iteration's
    // poll phase — late enough for the backlog to have already been read and
    // discarded. (Verified against a real pty, and a pipe, in #393's review.)
    const discard = (data: Buffer) => {
      if (data.toString('utf8') === '\x03') {
        done()
        console.log(`\nstopped — nothing further was asked, and ${resumeLine}`)
        process.exit(130)
      }
    }
    const onAbort = () => {
      done()
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', discard)
    setImmediate(() => {
      setImmediate(() => {
        if (settled) return
        stdin.removeListener('data', discard)
        stdin.on('data', onData)
      })
    })
  })
}
