/**
 * `dayReading`, the pure half of the board's day reading: the fetched-prices
 * note is `/spend`'s `text` alone (#677), never the bar's `short`.
 */
import { describe, expect, it } from 'vitest'

import { dayReading } from '../src/lib/day-spend.ts'

const day = {
  reportedCents: 2224,
  reportedRuns: 3,
  estimatedCents: 1656,
  estimatedRuns: 18,
  fetchedRuns: 18,
  unknown: 0,
  unknownWhy: [],
}

describe('dayReading', () => {
  it('puts the note in text when asked', () => {
    expect(dayReading(day, 200, { fetchedNote: true }).text).toContain('(18 at fetched LiteLLM prices)')
  })

  it('leaves it out of text by default', () => {
    expect(dayReading(day, 200).text).not.toContain('LiteLLM')
  })

  it('never puts it in short', () => {
    expect(dayReading(day, 200, { fetchedNote: true }).short).not.toContain('LiteLLM')
    expect(dayReading(day, 200).short).toBe('today $22.24 + ~$16.56 est. + 0 unknown / $200')
  })
})
