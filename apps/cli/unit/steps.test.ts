/** The phases of a long command (#622): a spinner on a terminal, the same bytes everywhere else. */
import { describe, expect, it } from 'vitest'

import { createSteps, lineSpinner, type Spinner } from '../src/steps.ts'

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

describe('lineSpinner', () => {
  it('leaves stdin alone, so Ctrl+C stays a SIGINT for the wait to handle', () => {
    const before = [
      process.stdin.listenerCount('keypress'),
      process.stdin.listenerCount('data'),
      process.listenerCount('SIGINT'),
    ]
    const writes: string[] = []
    const spinner = lineSpinner({ write: (t) => writes.push(t) })
    spinner.start('still draining')
    spinner.message('still draining after 60s')
    spinner.clear()
    expect([
      process.stdin.listenerCount('keypress'),
      process.stdin.listenerCount('data'),
      process.listenerCount('SIGINT'),
    ]).toEqual(before)
    expect(writes[0]).toContain('still draining')
    expect(writes.at(-1)).toBe('\r\x1b[J')
  })

  it('keeps the whole message on a narrow terminal, wrapped and redrawn in place', () => {
    const writes: string[] = []
    const spinner = lineSpinner({ write: (t) => writes.push(t), columns: 80 })
    const long = `still draining after 30s — ${'x'.repeat(60)}. ctrl-c stops waiting, and tells the supervisor nothing`
    spinner.start(long)
    expect(writes[0]!.split('\n').join('')).toContain(long)
    expect(writes[0]!.split('\n').length).toBeGreaterThan(1)
    spinner.clear()
    expect(writes.at(-1)).toBe('\r\u001b[1A\u001b[J')
  })
})
