/** The phases of a long command (#622): a spinner on a terminal, the same bytes everywhere else. */
import { Writable } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

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
    expect(events).toEqual(['start:still draining after 30s', 'message:still draining after 60s', 'clear'])
  })

  it('clears a live spinner before the next phase writes its line', () => {
    const events: string[] = []
    const steps = createSteps(() => {}, { live: true, spinner: fakeSpinner(events) })
    steps.progress('waiting')
    steps.begin('checking again')
    expect(events).toEqual(['start:waiting', 'clear'])
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
