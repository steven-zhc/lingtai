/**
 * `waitForKeypress` (#393), against a fake `RawStdin` — no filesystem, no
 * network, no real tty, so this is `unit/` by 0060 §1.
 *
 * What this file does *not* cover: the backlog race the review for #393
 * found (`init.ts:839`, now fixed by nesting the swap's `setImmediate`) is a
 * libuv poll-phase-versus-check-phase ordering that only a real pty — or a
 * raw-mode-capable pipe — reproduces; a plain in-memory double's `resume()`
 * cannot be made to lag behind a `setImmediate` the way a real fd's read does
 * without inventing the very timing the race depends on. That ordering was
 * verified by hand against a real pty, not by a test here.
 */
import { describe, expect, it } from 'vitest'

import { type RawStdin, waitForKeypress } from '../src/init.ts'

function fakeTtyStdin(): { stdin: RawStdin; press: (byte: string) => void; raw: boolean[] } {
  const listeners = new Set<(data: Buffer) => void>()
  const raw: boolean[] = []
  const stdin: RawStdin = {
    isTTY: true,
    setRawMode: (mode) => raw.push(mode),
    resume: () => {},
    pause: () => {},
    on: (_event, fn) => listeners.add(fn),
    removeListener: (_event, fn) => listeners.delete(fn),
  }
  return {
    stdin,
    raw,
    press: (byte) => {
      for (const l of listeners) l(Buffer.from(byte, 'utf8'))
    },
  }
}

describe('waitForKeypress (#393)', () => {
  it('with no TTY, never resolves until the signal aborts', async () => {
    const controller = new AbortController()
    let resolved = false
    const p = waitForKeypress({ isTTY: false } as RawStdin, controller.signal).then(() => {
      resolved = true
    })
    await new Promise((r) => setImmediate(r))
    expect(resolved).toBe(false)
    controller.abort()
    await p
    expect(resolved).toBe(true)
  })

  it('a real press resolves once the backlog-discard window has passed, and undoes raw mode', async () => {
    const { stdin, press, raw } = fakeTtyStdin()
    const controller = new AbortController()
    const p = waitForKeypress(stdin, controller.signal)
    // Past the window the fix opened (init.ts's nested setImmediate): a
    // press here is the deliberate kind, not backlog.
    await new Promise((r) => setImmediate(() => setImmediate(() => setImmediate(r))))
    press('a')
    await p
    expect(raw).toEqual([true, false])
  })

  it('aborting before any press resolves and undoes raw mode, without a press', async () => {
    const { stdin, raw } = fakeTtyStdin()
    const controller = new AbortController()
    const p = waitForKeypress(stdin, controller.signal)
    controller.abort()
    await p
    expect(raw).toEqual([true, false])
  })
})
