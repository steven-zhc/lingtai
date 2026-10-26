import { describe, expect, it } from 'vitest'

import { EVENT_AT, EVENTS, RETIRED, type EventType } from '../src/index.ts'

describe('EVENT_AT (#628)', () => {
  it('declares [] for exactly the retired types', () => {
    for (const type of Object.keys(EVENTS) as EventType[]) {
      expect(EVENT_AT[type].length === 0, type).toBe(RETIRED.has(type))
    }
  })
})
