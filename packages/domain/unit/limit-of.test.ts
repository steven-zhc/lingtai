import { describe, expect, it } from 'vitest'

import { limitOf, standDown } from '../src/index.ts'

describe('limitOf (#1214)', () => {
  const cases: [string, string][] = [
    ["You've hit your session limit · resets 11pm (America/Chicago)", '5-hour'],
    ['your 5-hour limit resets 11:20pm (America/Chicago)', '5-hour'],
    ["You've hit your weekly limit · resets Sep 19 at 9am (America/Chicago)", 'weekly'],
    ["You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage", 'monthly-spend'],
    ["You've hit your usage limit. Upgrade or try again at Nov 17th, 2026 9:00 AM.", 'usage'],
    ['something else entirely', 'usage'],
  ]
  it.each(cases)('%s → %s', (text, kind) => expect(limitOf(text)).toBe(kind))

  it('reads the limit that carries the reset when a message names two', () => {
    const text =
      "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage?from=cc_cli_limit_message · your 5-hour limit resets 11:20pm (America/Chicago)"
    expect(limitOf(text)).toBe('5-hour')
    const d = standDown({
      detail: text,
      backoffMs: 3_600_000,
      what: { of: 'mid-run', step: 'implement' },
      runtime: 'claude-code',
      now: new Date('2026-11-17T12:00:00Z'),
      zone: 'America/Chicago',
    })
    expect(d.limit.kind).toBe('5-hour')
    expect(d.limit.resetsAt).toBe(d.until.toISOString())
  })

  it('names no reset when the message named none', () => {
    const d = standDown({
      detail: "You've hit your monthly spend limit · raise it",
      backoffMs: 3_600_000,
      what: { of: 'mid-run', step: 'implement' },
      runtime: 'claude-code',
    })
    expect(d.limit).toEqual({ kind: 'monthly-spend', resetsAt: null })
    expect(d.untilFrom).toBe('backoff')
  })
})
