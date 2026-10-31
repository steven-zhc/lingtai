/**
 * `renderSetupCard` and the ready line (#754): pure, so every fact comes in on
 * `facts`. Rows are found by label, never by comparing the whole screen.
 */
import { resolveSource } from '@lingtai/recipe'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DoctorReport } from '../src/doctor.ts'
import { stripColour } from '../src/output.ts'
import {
  type CardRecipe,
  cardRecipe,
  formatTrialTime,
  renderReadyLine,
  renderSetupCard,
  type SetupCardFacts,
} from '../src/setup-card.ts'

afterEach(() => vi.unstubAllEnvs())

const RECIPE: CardRecipe = {
  code: '/Users/me/workspace/chapter-garden',
  base: 'lingtai-base',
  remote: '/Users/me/workspace/chapter-garden',
  tickets: 'db',
  kinds: ['bug', 'feature', 'documentation'],
  writer: { agent: 'claude-code', model: null },
  reviewer: { agent: 'claude-code', model: 'opus' },
  checks: ['npm run check', 'npm run build'],
  approves: true,
}

const FACTS: SetupCardFacts = {
  command: 'init',
  project: 'chapter-garden-a',
  updated: false,
  home: '/Users/me/lingtai-trial/a',
  homeIsNew: true,
  userHome: '/Users/me',
  store: { store: 'sqlite', path: '/Users/me/lingtai-trial/a/lingtai.db', where: 'config.yml', from: 'config.yml' },
  runtimes: [
    { id: 'claude-code', state: 'signed-in', signedIn: true, detail: '' },
    { id: 'codex', state: 'did-not-start', signedIn: false, detail: '' },
  ],
  recipe: RECIPE,
  trial: { trial: 'passed', ms: 41_000 },
  recipePath: '/Users/me/lingtai-trial/a/chapter-garden-a/recipe.yml',
}

const rows = (facts: SetupCardFacts): string[] => stripColour(renderSetupCard(facts)).split('\n')
const row = (facts: SetupCardFacts, label: string): string =>
  rows(facts)
    .find((l) => l.trimStart().startsWith(`${label} `))
    ?.trim() ?? ''

describe('renderSetupCard', () => {
  it('draws a heading and three groups a blank line apart', () => {
    const lines = rows(FACTS)
    expect(lines[0]).toBe('init  chapter-garden-a')
    expect(lines.filter((l) => l === '')).toHaveLength(3)
    expect(lines).toEqual(expect.arrayContaining(['this machine', 'this project', 'each pass']))
  })

  it('aligns every value in one column', () => {
    const cols = rows(FACTS)
      .filter((l) => l.startsWith('  '))
      .map((l) => /^ {2}(?:lands on|\S+) +/.exec(l)![0].length)
    expect(new Set(cols).size).toBe(1)
  })

  it('never prints a Postgres URL with its password', () => {
    const store = {
      store: 'postgres',
      url: 'postgres://u:s3cret@db.x.supabase.co:5432/p',
      directUrl: 'postgres://u:s3cret@db.x.supabase.co:5432/p',
      where: 'environment',
      from: 'x',
    } as SetupCardFacts['store']
    const out = renderSetupCard({ ...FACTS, store })
    expect(out).not.toContain('s3cret')
    expect(row({ ...FACTS, store }, 'log')).toMatch(/^log +Postgres · db\.x\.supabase\.co$/)
  })

  it('shows the SQLite file name, and a refusal as said', () => {
    expect(row(FACTS, 'log')).toContain('SQLite · lingtai.db')
    const refused = { refused: 'nothing chosen', because: 'nothing chosen' } as const
    expect(row({ ...FACTS, store: refused }, 'log')).toContain('nothing chosen')
  })

  it('marks agents ✓, ✗ and ? — never ✓ for a probe that could not tell', () => {
    expect(row(FACTS, 'agents')).toContain('claude-code ✓')
    expect(row(FACTS, 'agents')).toContain('codex ?')
    const out = row(
      { ...FACTS, runtimes: [{ id: 'codex', state: 'signed-out', signedIn: false, detail: '' }] },
      'agents',
    )
    expect(out).toContain('codex ✗')
  })

  it('writes the trial time as 41s and 2m 05s', () => {
    expect(row(FACTS, 'trial')).toContain('✓ 41s')
    expect(row({ ...FACTS, trial: { trial: 'passed', ms: 125_000 } }, 'trial')).toContain('✓ 2m 05s')
    expect(formatTrialTime(100)).toBe('<1s')
  })

  it('says why the trial did not run, and what a kept red list was', () => {
    for (const because of ['declined', 'no checkout', 'no checks'] as const) {
      expect(row({ ...FACTS, trial: { trial: 'not-run', because } }, 'trial')).toContain('not run — ')
    }
    const kept = row({ ...FACTS, trial: { trial: 'failed-kept', command: 'npm run check', ms: 1000 } }, 'trial')
    expect(kept).toContain('✗ npm run check — kept as written')
  })

  it('reads reviews none, and checks none, and the approve sentence', () => {
    const bare = { ...FACTS, recipe: { ...RECIPE, reviewer: null, checks: [], approves: false } }
    expect(row(bare, 'reviews')).toMatch(/^reviews +none$/)
    expect(row(bare, 'checks')).toContain('none — nothing checks a diff before review')
    expect(row(bare, 'approve')).toContain('a pass lands with no one asking')
    expect(row(FACTS, 'approve')).toContain('you approve every pass before it lands')
    expect(row(FACTS, 'reviews')).toContain('claude-code, opus')
  })

  it('puts updated in the heading on a re-registration, and new on home only for a new home', () => {
    expect(rows({ ...FACTS, updated: true })[0]).toBe('init  chapter-garden-a  updated')
    expect(row(FACTS, 'home')).toContain('~/lingtai-trial/a  new')
    expect(row({ ...FACTS, homeIsNew: false }, 'home')).not.toContain('new')
  })

  it('lands on the base in a remote that is the checkout, under ~', () => {
    expect(row(FACTS, 'lands on')).toContain('lingtai-base, in ~/workspace/chapter-garden')
    expect(row(FACTS, 'code')).toContain('~/workspace/chapter-garden  local')
  })

  it('redacts a URL remote and prints an scp-style one as written', () => {
    const url = { ...FACTS, recipe: { ...RECIPE, remote: 'https://u:pw@github.com/o/r.git' } }
    expect(renderSetupCard(url)).not.toContain('pw@')
    const scp = { ...FACTS, recipe: { ...RECIPE, remote: 'git@github.com:o/r' } }
    expect(row(scp, 'lands on')).toContain('lingtai-base, in git@github.com:o/r')
    const bad = { ...FACTS, recipe: { ...RECIPE, remote: 'https://u:s3cret@github.com:bad/o/r' } }
    expect(renderSetupCard(bad)).not.toContain('s3cret')
  })

  it('names the tickets source and kinds in order', () => {
    expect(row(FACTS, 'tickets')).toContain('Lingtai’s table · bug › feature › documentation')
    expect(row({ ...FACTS, recipe: { ...RECIPE, tickets: 'github' } }, 'tickets')).toContain('GitHub issues')
  })

  it('plain mode carries no escape', () => {
    vi.stubEnv('NO_COLOR', '1')
    expect(renderSetupCard(FACTS)).not.toContain('\x1b')
    expect(renderReadyLine({ threw: 'x' }, '/r')).not.toContain('\x1b')
  })
})

describe('cardRecipe', () => {
  it('reads the recipe as written', () => {
    const text = `version: 2
env:
  plantAt: .env.local
repo:
  base: main
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
