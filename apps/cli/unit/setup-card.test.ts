/** The card draws descriptor rows and ancillary facts; it makes no recipe decisions. */
import { resolveSource } from '@lingtai/recipe'
import type { SetupRow } from '@lingtai/setup'
import { describe, expect, it } from 'vitest'

import type { DoctorReport } from '../src/doctor.ts'
import { stripColour } from '../src/output.ts'
import {
  cardRecipe,
  formatTrialTime,
  renderReadyLine,
  renderSetupCard,
  type SetupCardFacts,
} from '../src/setup-card.ts'

const item = (id: string, label: string, text: string, group: SetupRow['group'], changed = false): SetupRow => ({
  id,
  label,
  text,
  group,
  changed,
})
const FACTS: SetupCardFacts = {
  command: 'init',
  project: 'garden',
  updated: false,
  home: '/Users/me/lingtai',
  homeIsNew: true,
  userHome: '/Users/me',
  runtimes: [{ id: 'codex', signedIn: true, state: 'signed-in', detail: '' }],
  machine: [item('store', 'log', 'SQLite', 'machine'), item('ceiling', 'spend', 'up to $100 a day', 'machine')],
  rows: [
    item('where', 'code', '/repo  local', 'project'),
    item('sandbox', 'sandbox', 'on · api.example.com', 'project'),
    item('writer', 'writes', 'codex', 'attempt'),
    item('checks', 'checks', 'pnpm test', 'attempt'),
  ],
  trial: { trial: 'passed', ms: 41000 },
}

describe('renderSetupCard', () => {
  it('draws supplied rows in their groups, including sandbox and spend', () => {
    const out = stripColour(renderSetupCard(FACTS))
    for (const value of [
      'this machine',
      'this project',
      'each attempt',
      'on · api.example.com',
      'up to $100 a day',
      'pnpm test',
      'codex ✓',
      '~/lingtai  new',
      '✓ 41s',
    ])
      expect(out).toContain(value)
  })
  it('uses semantic change flags for rerun headings, never rendered arrows', () => {
    const same = stripColour(renderSetupCard({ ...FACTS, updated: true }))
    expect(same).toContain('garden  unchanged')
    expect(same).not.toContain('→')
    const changed = stripColour(
      renderSetupCard({
        ...FACTS,
        updated: true,
        machine: [item('ceiling', 'spend', 'up to $100 a day → up to $150 a day', 'machine', true)],
        rows: [item('writer', 'writes', 'codex → claude-code', 'attempt', true)],
      }),
    )
    expect(changed).toMatch(/writes +codex → claude-code/)
    expect(changed).toMatch(/spend +up to \$100 a day → up to \$150 a day/)
    expect(changed).not.toMatch(/unchanged|updated/)
    expect(stripColour(renderSetupCard({ ...FACTS, updated: false }))).not.toContain('unchanged')
  })
  it('keeps labels, left behind, trial and next instructions', () => {
    const out = stripColour(
      renderSetupCard({
        ...FACTS,
        labels: { slug: 'o/r', created: ['bug'], missing: [{ name: 'type: bug', why: 'denied' }] },
        leftBehind: [{ what: 'old branch is kept', command: 'git log old' }],
        next: 'lingtai start',
        trial: { trial: 'failed-kept', command: 'pnpm test', ms: 10 },
      }),
    )
    for (const value of [
      'made bug',
      "gh label create 'type: bug' --repo o/r",
      'old branch is kept',
      'git log old',
      'lingtai start',
      'pnpm test — kept as written',
    ])
      expect(out).toContain(value)
  })
  it('draws a machine-only card and formats trial time', () => {
    const { rows: _r, trial: _t, project: _p, ...machine } = FACTS
    const out = renderSetupCard(machine)
    expect(out).not.toContain('this project')
    expect(out).not.toContain('each attempt')
    expect(formatTrialTime(125000)).toBe('2m 05s')
    expect(formatTrialTime(100)).toBe('<1s')
  })
})

describe('cardRecipe', () => {
  it('reads the recipe as written', () => {
    const text = `version: 2
env:
  plantAt: .env.local
branch:
  main: main
repo:
  remote: /tmp/code
source:
  kinds: [bug]
  tickets: db
steps:
  implement:
    - name: write
      agent: claude-code
      model: sonnet
      prompt: p
  build:
    - name: check
      run: npm run check
  review:
    - name: read
      agent: codex
      prompt: p
  proposed:
    - name: approve
      human: approve
`
    const card = cardRecipe(resolveSource(text, '/r.yml', '/r.yml').recipe, '/tmp/code')
    expect(card).toMatchObject({
      base: 'main',
      remote: '/tmp/code',
      tickets: 'db',
      kinds: ['bug'],
      writer: { agent: 'claude-code', model: 'sonnet' },
      reviewer: { agent: 'codex', model: null },
      checks: ['npm run check'],
    })
  })
})

describe('renderReadyLine without a recipe (#755)', () => {
  const REPORT = { ok: 27, notChecked: 10, deferred: 3 }

  it('drops the recipe part on every outcome', () => {
    const lines = [
      renderReadyLine({ report: REPORT, toFix: { count: 0, failed: false } }),
      renderReadyLine({ report: REPORT, toFix: { count: 2, failed: false } }),
      renderReadyLine({ report: REPORT, toFix: { count: 2, failed: true } }),
      renderReadyLine({ threw: 'boom' }),
    ].map(stripColour)
    for (const line of lines) expect(line).not.toContain('recipe:')
    expect(lines[0]).toBe('✓ ready — doctor: all 27 passed · 10 not checked here · 3 not implemented yet')
    expect(lines[2]).toBe('✗ not ready')
  })
})

describe('renderReadyLine', () => {
  const result = (status: 'pass' | 'warn' | 'fail', fix: string) =>
    ({ name: fix, status, detail: 'd', fix, areas: [] }) as unknown as DoctorReport['results'][number]
  const report = (results: DoctorReport['results']): DoctorReport =>
    ({ results, ok: 27, failed: 0, skipped: 0, deferred: 3, notChecked: 10, warned: 0 }) as unknown as DoctorReport

  const ready = (r: DoctorReport) => {
    const bad = r.results.filter((x) => x.status === 'fail').length
    const warn = r.results.filter((x) => x.status === 'warn').length
    return { report: r, toFix: { count: bad + warn, failed: bad > 0 } }
  }

  it('is ready with doctor’s count when nothing is left to fix', () => {
    const line = stripColour(renderReadyLine(ready(report([])), '/r.yml'))
    expect(line).toMatch(/^✓ ready — doctor: all 27 passed · .*recipe: \/r\.yml$/)
  })

  it('is ready with N to fix on warnings alone', () => {
    const line = stripColour(renderReadyLine(ready(report([result('warn', 'a'), result('warn', 'b')])), '/r.yml'))
    expect(line).toBe('✓ ready · 2 to fix · recipe: /r.yml')
  })

  it('is not ready on a failure, and never says ready', () => {
    const line = stripColour(renderReadyLine(ready(report([result('fail', 'a'), result('warn', 'b')])), '/r.yml'))
    expect(line).toBe('✗ not ready · recipe: /r.yml')
    expect(line).not.toContain('✓ ready')
  })

  it('is not ready when doctor threw', () => {
    const line = stripColour(renderReadyLine({ threw: 'boom' }, '/r.yml'))
    expect(line).toBe('✗ not ready — doctor did not finish (boom) · recipe: /r.yml')
    expect(line).not.toContain('✓ ready')
  })
})
