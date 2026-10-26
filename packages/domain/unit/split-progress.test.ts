/** `splitProgressOf` (#608): the state of a split write, folded off the parent's stream. */
import { describe, expect, it } from 'vitest'

import type { WaitId } from '../src/action.ts'
import { SplitChildWritten, SplitFailed, SplitLinkWritten, SplitStarted } from '../src/events.ts'
import { splitProgressOf } from '../src/split-progress.ts'
import { aSplit } from '../test/events.ts'
import { makeStream } from '../test/support.ts'

const WAIT = '11111111-1111-4111-8111-111111111111' as WaitId
const OTHER = '22222222-2222-4222-8222-222222222222' as WaitId
const plan = {
  children: [
    { key: 'a', title: 'a', body: 'a', kind: 'feature' },
    { key: 'b', title: 'b', body: 'b', kind: 'feature' },
  ],
  blockedBy: [{ ticket: 'b', blockedBy: 'a' }],
}
const ME = { waitId: WAIT, instance: 'board-1', running: true }

function stream() {
  const event = makeStream('ticket-lingtai-1')
  return {
    started: (instance = 'board-1', waitId = WAIT) => event('SplitStarted', { waitId, plan, instance }),
    child: (key: string, number: number, waitId = WAIT) =>
      event('SplitChildWritten', { waitId, key, number, id: 5_000_000_000 + number }),
    link: (ticket: string, blockedBy: string, waitId = WAIT) =>
      event('SplitLinkWritten', { waitId, ticket, blockedBy }),
    failed: (step = 'chain b←a', waitId = WAIT) => event('SplitFailed', { waitId, step, detail: 'boom' }),
    done: () => aSplit(event, WAIT, [161, 162])[0]!,
  }
}

describe('the progress events', () => {
  it('accept a well-formed payload and refuse extras and an empty instance', () => {
    expect(SplitStarted.safeParse({ waitId: WAIT, plan, instance: 'x' }).success).toBe(true)
    expect(SplitStarted.safeParse({ waitId: WAIT, plan, instance: '' }).success).toBe(false)
    expect(SplitChildWritten.safeParse({ waitId: WAIT, key: 'a', number: 1, id: 2 }).success).toBe(true)
    expect(SplitChildWritten.safeParse({ waitId: WAIT, key: 'a', number: 1, id: 2, title: 't' }).success).toBe(false)
    expect(SplitChildWritten.safeParse({ waitId: WAIT, key: 'a', number: 1 }).success).toBe(false)
    expect(SplitLinkWritten.safeParse({ waitId: WAIT, ticket: 'b', blockedBy: 'a' }).success).toBe(true)
    expect(SplitLinkWritten.safeParse({ waitId: WAIT, ticket: 'b' }).success).toBe(false)
    expect(SplitFailed.safeParse({ waitId: WAIT, step: 'read GitHub', detail: 'x' }).success).toBe(true)
    expect(SplitFailed.safeParse({ waitId: WAIT, step: 'read GitHub' }).success).toBe(false)
  })
})

describe('splitProgressOf', () => {
  it('is idle with no SplitStarted', () => {
    expect(splitProgressOf([], ME)).toEqual({ state: 'idle' })
  })

  it('is writing for this instance, with what is written so far', () => {
    const s = stream()
    const p = splitProgressOf([s.started(), s.child('a', 161), s.link('b', 'a')], ME)
    expect(p).toMatchObject({ state: 'writing', links: [{ ticket: 'b', blockedBy: 'a' }] })
    if (p.state === 'idle') throw new Error('unreachable')
    expect(p.children.map((c) => c.key)).toEqual(['a'])
    expect(p.plan).toEqual(plan)
  })

  it('is interrupted when another instance started it and nothing ended it', () => {
    const s = stream()
    expect(splitProgressOf([s.started('board-0'), s.child('a', 161)], ME).state).toBe('interrupted')
  })

  it('is interrupted when no writer is running in this process, though the instance is the asker\'s', () => {
    const s = stream()
    expect(splitProgressOf([s.started()], { ...ME, running: false }).state).toBe('interrupted')
  })

  it('is failed after a SplitFailed, whichever instance, and carries the step', () => {
    const s = stream()
    expect(splitProgressOf([s.started(), s.failed()], ME)).toMatchObject({
      state: 'failed',
      failed: { step: 'chain b←a', detail: 'boom' },
    })
    expect(splitProgressOf([s.started('board-0'), s.failed()], ME).state).toBe('failed')
  })

  it('is done once TicketSplit is on the stream', () => {
    const s = stream()
    expect(splitProgressOf([s.started(), s.child('a', 161), s.done()], ME).state).toBe('done')
  })

  it('is done for a split written before SplitStarted existed, with the recorded children and links', () => {
    const s = stream()
    const p = splitProgressOf([s.done()], ME)
    expect(p.state).toBe('done')
    if (p.state === 'idle') throw new Error('unreachable')
    expect(p.plan).toBeNull()
    expect(p.children.length).toBeGreaterThan(0)
  })

  it('drops links written for a key that now names another issue', () => {
    const s = stream()
    const p = splitProgressOf(
      [s.started(), s.child('a', 161), s.child('b', 162), s.link('b', 'a'), s.child('a', 170)],
      ME,
    )
    if (p.state === 'idle') throw new Error('unreachable')
    expect(p.links).toEqual([])
    expect(p.children.find((c) => c.key === 'a')!.number).toBe(170)
  })

  it('keeps the union of every attempt, and reads the latest attempt', () => {
    const s = stream()
    const p = splitProgressOf(
      [
        s.started('board-0'),
        s.child('a', 161),
        s.failed('create b'),
        s.started('board-0'),
        s.child('b', 162),
        s.child('a', 161),
      ],
      ME,
    )
    expect(p.state).toBe('interrupted')
    if (p.state === 'idle') throw new Error('unreachable')
    expect(p.children.map((c) => c.key).sort()).toEqual(['a', 'b'])
    expect(p.failed).toBeUndefined()
  })

  it('ignores another wait’s events', () => {
    const s = stream()
    const events = [s.started('board-1', OTHER), s.child('a', 161, OTHER), s.done()]
    expect(splitProgressOf(events.slice(0, 2), ME)).toEqual({ state: 'idle' })
    expect(splitProgressOf(events.slice(0, 2), { waitId: OTHER, instance: 'board-1', running: true }).state).toBe('writing')
  })
})
