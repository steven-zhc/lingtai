/** The phases of a long command (#622): a spinner on a terminal, the same bytes everywhere else. */
import { describe, expect, it } from 'vitest'

import { createSteps, type Spinner } from '../src/steps.ts'

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
