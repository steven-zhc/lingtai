import { describe, expect, it } from 'vitest'

import { STREAM_ID_PATTERN, StreamId } from '../src/envelope.ts'
import { ATTEMPT_STREAM_PREFIX, parsePrStream, prStream } from '../src/streams.ts'

describe('STREAM_ID_PATTERN', () => {
  it('is built to the same source as the literal it replaced', () => {
    expect(STREAM_ID_PATTERN.source).toBe('^(ticket|pass|int|prj|pr|ctl|chat|ext|bkl|rcp|acct)-[\\w.-]+$')
  })

  it('keeps the attempt stream prefix value', () => {
    expect(ATTEMPT_STREAM_PREFIX).toBe('pass-')
  })
})

describe('StreamId', () => {
  it.each([
    'ticket-lingtai-123',
    'pass-a1b2c3',
    'int-lingtai-main',
    'prj-lingtai',
    'ctl-conductor',
    'chat-abc',
    'ext-subscribers',
    'bkl-lingtai-5',
    `rcp-${'a'.repeat(64)}`,
    'int-lingtai-feat.x',
  ])('accepts %s', (id) => {
    expect(StreamId.safeParse(id).success).toBe(true)
  })

  it.each(['ticket-', 'pass-', 'xyz-1', 'wi lingtai', 'WI-1'])('refuses %s', (id) => {
    expect(StreamId.safeParse(id).success).toBe(false)
  })
})

describe('the PR stream', () => {
  it('is accepted, and told apart from a project stream', () => {
    expect(StreamId.safeParse('pr-chapter-garden-12').success).toBe(true)
    expect(parsePrStream('pr-chapter-garden-12')).toEqual({ project: 'chapter-garden', n: 12 })
    expect(parsePrStream('prj-chapter-garden')).toBeNull()
  })

  it('round-trips through prStream and refuses a number that is not positive', () => {
    expect(parsePrStream(prStream('lingtai', 3))).toEqual({ project: 'lingtai', n: 3 })
    expect(parsePrStream('pr-lingtai-0')).toBeNull()
    expect(parsePrStream('pr-lingtai-x')).toBeNull()
    expect(parsePrStream('pr-1')).toBeNull()
  })
})
