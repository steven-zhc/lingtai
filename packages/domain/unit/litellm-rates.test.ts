import { describe, expect, it } from 'vitest'

import { estimateRow, mergeSnapshot, ratesFromLiteLLM, type RateRow } from '../src/rate-card.ts'
import { LITELLM_FIXTURE } from '../test/litellm-fixture.ts'

const wanted = (model: string, runtime = 'codex') => [{ model, runtime }]
const run = (at: string, tokens: object, model = 'gpt-6-astra') => ({
  at: new Date(at),
  usage: [{ model, tokens }],
})

describe('ratesFromLiteLLM', () => {
  it('takes only the exact key under the runtime’s own provider, and prices the fixture to the cent', () => {
    const { rows } = ratesFromLiteLLM(LITELLM_FIXTURE, wanted('gpt-6-astra'), '2026-10-26')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ model: 'gpt-6-astra', input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 })
    const r = estimateRow(
      run('2026-10-26T12:00:00Z', { fresh: 5_620_000, cacheRead: 36_790_000, output: 92_000, reasoning: 34_000 }),
      rows,
    )
    // 56.2 + 36.79 + 4.6 + 1.7
    expect(r).toEqual({ usd: expect.closeTo(99.29, 2), fetched: true })
  })

  it('rejects a null input rate, an out-of-range rate, and a provider that is not the runtime’s', () => {
    expect(ratesFromLiteLLM(LITELLM_FIXTURE, wanted('chatgpt/gpt-6-astra'), 'd').rows).toEqual([])
    expect(ratesFromLiteLLM(LITELLM_FIXTURE, wanted('gpt-6-wild'), 'd')).toMatchObject({
      rows: [{ model: 'gpt-6-wild', withdrawn: true }],
      rejected: ['gpt-6-wild'],
    })
    expect(ratesFromLiteLLM(LITELLM_FIXTURE, wanted('gpt-6-astra', 'claude-code'), 'd').rows).toEqual([])
  })

  it('charges reasoning at its own rate when the entry has one', () => {
    const table = {
      m: {
        litellm_provider: 'openai',
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
        output_cost_per_reasoning_token: 4e-6,
      },
    }
    const { rows } = ratesFromLiteLLM(table, wanted('m'), '2026-10-26')
    expect(estimateRow(run('2026-10-26T00:00:00Z', { reasoning: 1_000_000 }, 'm'), rows)?.usd).toBeCloseTo(4)
  })
})

describe('the second and third review findings', () => {
  it('a mismatched candidate does not hide the runtime’s own, so a withdrawal still lands', () => {
    const wild = [
      { model: 'gpt-6-wild', runtime: 'claude-code' },
      { model: 'gpt-6-wild', runtime: 'codex' },
    ]
    expect(ratesFromLiteLLM(LITELLM_FIXTURE, wild, '2026-10-28').rows).toMatchObject([{ withdrawn: true }])
  })

  it('an explicit null reasoning price leaves reasoning tokens unknown, not at the output rate', () => {
    const table = {
      m: {
        litellm_provider: 'openai',
        input_cost_per_token: 1e-5,
        output_cost_per_token: 5e-5,
        output_cost_per_reasoning_token: null,
      },
    }
    const { rows } = ratesFromLiteLLM(table, wanted('m'), '2026-10-26')
    expect(estimateRow(run('2026-10-26T00:00:00Z', { reasoning: 1_000_000 }, 'm'), rows)).toBeNull()
    expect(estimateRow(run('2026-10-26T00:00:00Z', { output: 1_000_000 }, 'm'), rows)?.usd).toBeCloseTo(50)
  })
})

describe('estimateRow', () => {
  it('ignores the snapshot for a model the shipped card prices', () => {
    const { rows } = ratesFromLiteLLM(LITELLM_FIXTURE, wanted('claude-sonnet-5', 'claude-code'), '2026-11-01')
    expect(rows).toHaveLength(1)
    const r = estimateRow(run('2026-11-02T00:00:00Z', { fresh: 1_000_000 }, 'claude-sonnet-5'), rows)
    expect(r).toEqual({ usd: 2, fetched: false })
  })

  it('leaves a run unknown for a null price or a missing cache-read rate, but prices one without cache tokens', () => {
    const { rows } = ratesFromLiteLLM(LITELLM_FIXTURE, wanted('gpt-6-nocache'), '2026-10-26')
    expect(estimateRow(run('2026-10-27T00:00:00Z', { fresh: 1, cacheRead: 5 }, 'gpt-6-nocache'), rows)).toBeNull()
    expect(estimateRow(run('2026-10-27T00:00:00Z', { fresh: 1_000_000 }, 'gpt-6-nocache'), rows)?.usd).toBeCloseTo(2)
    expect(estimateRow(run('2026-10-27T00:00:00Z', { fresh: 1 }), [])).toBeNull()
  })
})

describe('mergeSnapshot', () => {
  const row = (from: string, input: number): RateRow => ({
    from,
    model: 'm',
    mode: '',
    input,
    output: 1,
    cacheRead: 1,
    cacheWrite: 1,
  })
  const price = (rows: RateRow[], at: string) =>
    estimateRow({ at: new Date(at), usage: [{ model: 'm', tokens: { fresh: 1_000_000 } }] }, rows)?.usd

  it('appends a row for a changed price, and a run from the earlier day keeps the earlier price', () => {
    const merged = mergeSnapshot([row('2026-10-26', 10)], [row('2026-10-27', 20)])!
    expect(merged).toHaveLength(2)
    expect(price(merged, '2026-10-26T12:00:00Z')).toBe(10)
    expect(price(merged, '2026-10-27T12:00:00Z')).toBe(20)
  })

  it('replaces the same day’s row and keeps earlier days', () => {
    const merged = mergeSnapshot([row('2026-10-26', 10), row('2026-10-27', 20)], [row('2026-10-27', 30)])!
    expect(merged.map((r) => [r.from, r.input])).toEqual([
      ['2026-10-26', 10],
      ['2026-10-27', 30],
    ])
  })

  it('a rejected entry withdraws a held price from its day on, and leaves earlier runs their price', () => {
    const { rows } = ratesFromLiteLLM(LITELLM_FIXTURE, wanted('gpt-6-wild'), '2026-10-28')
    const merged = mergeSnapshot([{ ...row('2026-10-26', 10), model: 'gpt-6-wild' }], rows)!
    const at = (d: string) =>
      estimateRow({ at: new Date(d), usage: [{ model: 'gpt-6-wild', tokens: { fresh: 1_000_000 } }] }, merged)?.usd
    expect(at('2026-10-27T00:00:00Z')).toBe(10)
    expect(at('2026-10-28T12:00:00Z')).toBeUndefined()
    // and with nothing held, nothing is written
    expect(mergeSnapshot([], rows)).toBeNull()
  })

  it('changes nothing when the rates are unchanged', () => {
    expect(mergeSnapshot([row('2026-10-26', 10)], [row('2026-10-27', 10)])).toBeNull()
  })
})
