import { readFileSync } from 'node:fs'

import { ceilingReading, ceilingSentences, attemptCeiling } from '@lingtai/conductor/ceiling'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CeilingSay } from '../src/app/ceiling-say.tsx'

const limits = {
  refusalFixes: 6,
  conflictResolutions: 6,
  newAttempts: 2,
  turns: 350,
  wall: '75m',
  wallMs: 75 * 60_000,
}

describe('the spend card', () => {
  const reading = ceilingReading(limits)
  const html = renderToStaticMarkup(
    <div>
      <div className="stats">
        {[1, 2, 3, 4, 5].map((n) => (
          <div className="stat" key={n} />
        ))}
      </div>
      <CeilingSay summary={reading.summary} sentences={ceilingSentences(reading)} />
    </div>,
  )

  it('draws five cells, the summary and a closed fold of capitalised plural sentences', () => {
    expect(html.match(/class="stat"/g)).toHaveLength(5)
    expect(html).toContain('A ticket gets at most 53 implement runs, 75m and 350 turns each — 3975m at most.')
    expect(html).toMatch(/<details class="say-more"><summary>how this is counted<\/summary>/)
    expect(html).not.toContain('<details open')
    const paragraphs = [...html.matchAll(/<p>([^<]*)<\/p>/g)].map((m) => m[1] ?? '')
    expect(paragraphs.length).toBeGreaterThanOrEqual(3)
    for (const p of paragraphs) {
      expect(p).toMatch(/^[A-Z]/)
      expect(p).not.toMatch(/\(s\)|\(es\)/)
    }
  })

  it('reads the same figures the CLI sentence is built from', () => {
    expect(reading).toMatchObject({ runs: 53, attempts: 3, perAttempt: 16 })
    expect(attemptCeiling(limits)).toContain('3 attempts of 16 runs')
    expect(attemptCeiling(limits)).toContain('6 refusal fixes')
  })

  it('imports nothing but React, so no server-only module reaches the client graph', () => {
    const source = readFileSync(new URL('../src/app/ceiling-say.tsx', import.meta.url), 'utf8')
    expect(source.match(/^import .*$/gm) ?? []).toEqual([])
  })

  it('has a five-column .stats and no sibling rule', () => {
    const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.stats \{[^}]*grid-template-columns: repeat\(5, 1fr\)/)
    expect(css).not.toContain('.stat + .stat')
  })
})
