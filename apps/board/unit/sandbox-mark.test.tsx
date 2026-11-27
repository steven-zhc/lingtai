/** The sandbox mark on the filter's rows, the cards and the landed rows (#1166). */
import { readFileSync } from 'node:fs'

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Card, LandedRow } from '../src/app/page.tsx'
import { Projects } from '../src/app/projects.tsx'
import { ProjectSandboxMark } from '../src/app/sandbox-mark.tsx'
import type { BoardCard } from '../src/lib/board.ts'
import { GLYPH, SENTENCES, sandboxStates, type SandboxState, type SandboxStateName } from '../src/lib/sandbox-state.ts'
import { emptyBill } from '../src/lib/spend.ts'

const NAMES = Object.keys(SENTENCES) as SandboxStateName[]
const st = (state: SandboxStateName): SandboxState => ({ state, sentence: SENTENCES[state] })

describe('ProjectSandboxMark', () => {
  it.each(NAMES)('renders %s with its class, glyph and sentence, and is no link', (name) => {
    const out = renderToStaticMarkup(<ProjectSandboxMark state={st(name)} />)
    expect(out).toContain(`sbx-${name}`)
    expect(out).toContain(`aria-label="${SENTENCES[name]}"`)
    expect(out).toContain('<svg')
    if (name === 'off') expect(out.match(/<path/g)).toHaveLength(1)
    else expect(out).toContain(`d="${GLYPH[name]}"`)
    // No text inside the mark: only the svg and its paths.
    expect(out.slice(out.indexOf('<span class="sbx-mark"')).replace(/<[^>]*>/g, '')).toBe('')
    expect(out).not.toContain('<a')
    expect(out).not.toContain('pause-tag')
  })

  it('draws nothing without a state', () => {
    expect(renderToStaticMarkup(<ProjectSandboxMark state={undefined} />)).toBe('')
  })
})

describe('sandboxStates', () => {
  it('skips a project with no name', () => {
    expect(sandboxStates([{ project: null } as never]).size).toBe(0)
  })
})

describe('the filter menu', () => {
  const locks = new Map([['b', [{ kind: 'paused' as const, by: 'x', since: new Date(0) }]]])
  const render = (sandbox?: ReadonlyMap<string, SandboxState>) =>
    renderToStaticMarkup(
      <Projects filters={['a', 'b']} only={undefined} app registered={['a', 'b']} locks={locks} sandbox={sandbox} />,
    )

  it('puts the mark beside the pause tag on a paused row, and none in the summary or all-projects tab', () => {
    const out = render(new Map([['b', st('off')]]))
    const row = out.slice(out.indexOf('href="/p/b/ticket"'))
    expect(row).toContain('sbx-off')
    expect(row).toContain('pause-tag')
    const head = out.slice(0, out.indexOf('href="/p/a/ticket"'))
    expect(head).not.toContain('sbx')
  })

  it('renders as before when no map is given', () => {
    expect(render()).not.toContain('sbx')
  })
})

const board = {
  taskId: 't',
  project: 'p',
  column: 'queued',
  ref: '1',
  kind: 'bug',
  title: 'T',
  costUsd: emptyBill(),
  repairCostUsd: emptyBill(),
} as unknown as BoardCard

describe('cards and landed rows', () => {
  it('Card draws no mark', () => {
    expect(renderToStaticMarkup(<Card card={board} showProject={false} issue={null} paused={false} />)).not.toContain(
      'sbx',
    )
  })

  it('a waiting Card draws none either', () => {
    const w = { ...board, column: 'waiting', note: null, short: null, cause: null, triage: null, move: null } as never
    expect(renderToStaticMarkup(<Card card={w} showProject issue={null} paused={false} />)).not.toContain('sbx')
  })

  it('LandedRow draws none', () => {
    const c = {
      ...board,
      column: 'landed',
      closed: false,
      turns: null,
      costUsd: emptyBill(),
      updatedAt: null,
      progress: null,
    }
    expect(renderToStaticMarkup(<LandedRow card={c as never} showProject issue={null} />)).not.toContain('sbx')
  })
})

describe('the home rail', () => {
  it('draws the sandbox slot once, immediately before <Health', () => {
    const src = readFileSync(new URL('../src/app/page.tsx', import.meta.url), 'utf8')
    expect(src.match(/sandboxSlot\(/g)).toHaveLength(1)
    const rail = src.slice(src.indexOf('className="rail"'))
    const slot = rail.indexOf("sandboxSlot(param, key('sandbox'))")
    const health = rail.indexOf('<Health')
    expect(slot).toBeGreaterThan(-1)
    expect(slot).toBeLessThan(health)
    const between = rail.slice(slot + "sandboxSlot(param, key('sandbox'))".length, health)
    // The mode slot sits between the shield and the dot (#1463).
    expect(
      between
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
        .replace("{modeSlot(ctx.reads.board, param, key('mode'))}", '')
        .trim(),
    ).toBe('}')
  })
})
