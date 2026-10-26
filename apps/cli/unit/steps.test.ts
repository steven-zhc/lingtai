/** The phases of a long command (#622): a spinner on a terminal, the same bytes everywhere else. */
import { Writable } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import { waitForTheLock } from '../src/restart.ts'
import { createSteps, oraSpinner, type Spinner } from '../src/steps.ts'

function fakeSpinner(events: string[]): () => Spinner {
  return () => ({
    start: (m) => events.push(`start:${m}`),
    message: (m) => events.push(`message:${m}`),
    clear: () => events.push('clear'),
  })
}

describe('createSteps', () => {
  it('writes the label of a phase as one line', () => {
    const lines: string[] = []
    createSteps((l) => lines.push(l), { live: false }).begin('checking')
    expect(lines).toEqual(['checking'])
  })

  it('off a terminal, progress is written exactly as the wait always wrote it', () => {
    const lines: string[] = []
    const events: string[] = []
    const steps = createSteps((l) => lines.push(l), { live: false, spinner: fakeSpinner(events) })
    steps.progress('still draining after 300s — 1 in flight. ctrl-c stops waiting')
    expect(lines).toEqual(['still draining after 300s — 1 in flight. ctrl-c stops waiting'])
    expect(events).toEqual([])
  })

  it('on a terminal, progress moves a spinner and adds nothing to the scrollback', () => {
    const lines: string[] = []
    const events: string[] = []
    const steps = createSteps((l) => lines.push(l), { live: true, spinner: fakeSpinner(events) })
    steps.begin('draining')
    steps.progress('still draining after 30s')
    steps.progress('still draining after 60s')
    steps.end()
    expect(lines).toEqual(['draining'])
    expect(events).toEqual([
      'start:draining…',
      'message:still draining after 30s',
      'message:still draining after 60s',
      'clear',
    ])
  })

  it('begins a spinner with the phase, before any progress is reported', () => {
    const events: string[] = []
    createSteps(() => {}, { live: true, spinner: fakeSpinner(events) }).begin('starting')
    expect(events).toEqual(['start:starting…'])
  })

  describe('on a real terminal', () => {
    const KEYS = ['NO_COLOR', 'TERM', 'FORCE_COLOR'] as const
    const run = (env: Record<string, string | undefined>): string[] => {
      const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
      const tty = [process.stdin.isTTY, process.stdout.isTTY]
      process.stdin.isTTY = true
      process.stdout.isTTY = true
      for (const k of KEYS) delete process.env[k]
      Object.assign(process.env, env)
      try {
        const events: string[] = []
        const steps = createSteps(() => {}, { spinner: fakeSpinner(events) })
        steps.begin('draining')
        steps.progress('still draining')
        return events
      } finally {
        process.stdin.isTTY = tty[0] as boolean
        process.stdout.isTTY = tty[1] as boolean
        for (const k of KEYS) {
          if (saved[k] === undefined) delete process.env[k]
          else process.env[k] = saved[k]
        }
      }
    }

    it('shows a spinner when colour is on (the control for the cases below)', () => {
      expect(run({ TERM: 'xterm-256color', FORCE_COLOR: '1' })).toEqual(['start:draining…', 'message:still draining'])
    })

    it.each([
      ['NO_COLOR', { NO_COLOR: '1', FORCE_COLOR: '1' }],
      ['TERM=dumb', { TERM: 'dumb' }],
    ])('shows no spinner when colour is off (%s)', (_name, env) => {
      expect(run(env)).toEqual([])
    })
  })

  it('clears a live spinner before the next phase writes its line', () => {
    const events: string[] = []
    const steps = createSteps(() => {}, { live: true, spinner: fakeSpinner(events) })
    steps.progress('waiting')
    steps.begin('checking again')
    expect(events).toEqual(['start:waiting', 'clear', 'start:checking again…'])
  })
})

describe('oraSpinner', () => {
  it('never puts stdin in raw mode, so Ctrl+C stays a SIGINT for the wait to handle', () => {
    const raw = vi.fn()
    const stdin = process.stdin as unknown as { setRawMode?: (mode: boolean) => unknown }
    const had = stdin.setRawMode
    stdin.setRawMode = raw
    const before = [
      process.stdin.listenerCount('keypress'),
      process.stdin.listenerCount('data'),
      process.listenerCount('SIGINT'),
    ]
    const writes: string[] = []
    const realTty = [process.stdout.isTTY, process.stderr.isTTY]
    process.stdout.isTTY = true
    process.stderr.isTTY = true
    const stream = Object.assign(new Writable({ write: (c, _e, done) => (writes.push(String(c)), done()) }), {
      isTTY: true,
      columns: 80,
      cursorTo: () => true,
      clearLine: () => true,
      moveCursor: () => true,
    }) as unknown as NodeJS.WriteStream
    try {
      const spinner = oraSpinner(stream)
      spinner.start('still draining')
      spinner.message('still draining after 60s')
      spinner.clear()
    } finally {
      process.stdout.isTTY = realTty[0] as boolean
      process.stderr.isTTY = realTty[1] as boolean
      if (had === undefined) delete stdin.setRawMode
      else stdin.setRawMode = had
    }
    expect(raw).not.toHaveBeenCalled()
    expect([
      process.stdin.listenerCount('keypress'),
      process.stdin.listenerCount('data'),
      process.listenerCount('SIGINT'),
    ]).toEqual(before)
    expect(writes.join('')).toContain('still draining')
    // The hide-cursor escape is what routes through restore-cursor and its SIGINT listener.
    expect(writes.join('')).not.toContain('\u001B[?25l')
  })
})

describe("Ctrl+C during the drain's wait", () => {
  it("reaches waitForTheLock's handler while the real spinner runs, and the wait gives up as interrupted", async () => {
    const before = process.listenerCount('SIGINT')
    const stream = Object.assign(new Writable({ write: (_c, _e, done) => done() }), {
      isTTY: true,
      columns: 80,
      cursorTo: () => true,
      clearLine: () => true,
      moveCursor: () => true,
    }) as unknown as NodeJS.WriteStream
    const steps = createSteps(() => {}, { live: true, spinner: () => oraSpinner(stream) })
    const raw = vi.fn()
    const stdin = process.stdin as unknown as { setRawMode?: (mode: boolean) => unknown }
    const had = stdin.setRawMode
    stdin.setRawMode = raw
    try {
      const waiting = waitForTheLock('draining', null, () => {}, {
        ask: async () => 'holder',
        pollMs: 5,
        sayEveryMs: 1,
        progress: (line) => steps.progress(line),
      })
      await new Promise((r) => setTimeout(r, 30))
      // The wait's own handler is the one extra listener; the spinner adds none.
      expect(process.listenerCount('SIGINT')).toBe(before + 1)
      process.emit('SIGINT')
      expect(await waiting).toBe('interrupted')
    } finally {
      steps.end()
      if (had === undefined) delete stdin.setRawMode
      else stdin.setRawMode = had
    }
    expect(raw).not.toHaveBeenCalled()
    expect(process.listenerCount('SIGINT')).toBe(before)
  })
})
