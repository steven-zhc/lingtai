import { describe, expect, it } from 'vitest'

import { STREAM_ID_PATTERN, StreamId } from '../src/envelope.ts'

describe('STREAM_ID_PATTERN', () => {
  it('is built to the same source as the literal it replaced', () => {
    expect(STREAM_ID_PATTERN.source).toBe('^(ticket|pass|int|prj|ctl|chat|ext|bkl)-[\\w.-]+$')
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
    'int-lingtai-feat.x',
  ])('accepts %s', (id) => {
    expect(StreamId.safeParse(id).success).toBe(true)
  })

  it.each(['ticket-', 'pass-', 'xyz-1', 'wi lingtai', 'WI-1'])('refuses %s', (id) => {
    expect(StreamId.safeParse(id).success).toBe(false)
  })
})
