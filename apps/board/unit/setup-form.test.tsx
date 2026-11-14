import { STEPS } from '@lingtai/domain'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { ReadView } from '../src/app/setup/repository/read/read-model.ts'

vi.mock('../src/app/setup/repository/read/actions.ts', () => ({
  addRepository: async () => ({ ok: true, project: 'p' }),
  previewAdd: async () => ({ refused: 'x' }),
}))

const line = <T,>(value: T) => ({ value, note: 'because', known: true })

const view = (target: ReadView['target']): ReadView => ({
  project: 'p',
  target,
  remote: null,
  base: line('main'),
  install: line('pnpm install'),
  stack: line(['node']),
  checks: line([{ name: 'test', run: 'pnpm test', ticked: true, why: 'a script' }]),
  runtimes: [{ id: 'claude-code', signedIn: true, remedy: null, noTurnCeiling: false }],
  writer: line('claude-code'),
  reviewer: line('claude-code'),
  tickets: line('github' as const),
  githubOff: null,
  ticketsLocked: false,
  kinds: line(['bug']),
  heldBy: line('agent:hold'),
  end: line(true),
  limits: { turns: 300, wall: '1h', rounds: 3, restarts: 1 },
  sandbox: null,
})

const render = async (target: ReadView['target']) => {
  const { SetupForm } = await import('../src/app/setup/repository/read/setup-form.tsx')
  return renderToStaticMarkup(<SetupForm view={view(target)} />)
}

const label = (html: string, k: string) => html.indexOf(`<span class="s2-k">${k}</span>`)
const step = (html: string, s: string) => html.indexOf(`<b>${s}</b>`)

const UNDER: Record<string, string[]> = {
  claim: ['tickets', 'kinds', 'held by'],
  admit: ['base'],
  prepared: ['stack', 'install'],
  implement: ['agent'],
  build: ['checks'],
  review: ['reviewer'],
  end: ['end'],
}

it('groups every answer under its own step, the steps in order', async () => {
  const html = await render({ kind: 'github', owner: 'o', repo: 'r' })
  const at = STEPS.map((s) => step(html, s))
  expect(at.every((n) => n >= 0)).toBe(true)
  expect([...at].sort((a, b) => a - b)).toEqual(at)
  STEPS.forEach((s, i) => {
    const next = i + 1 < STEPS.length ? at[i + 1]! : html.length
    for (const k of UNDER[s] ?? []) {
      const where = label(html, k)
      expect(where, `${k} under ${s}`).toBeGreaterThan(at[i]!)
      expect(where, `${k} before the step after ${s}`).toBeLessThan(next)
    }
  })
  expect(html).toContain('nothing to set here')
})

it('a local target has no end line and keeps base disabled', async () => {
  const html = await render({ kind: 'local', path: '/tmp/x' })
  expect(html).not.toContain('<span class="s2-k">end</span>')
  expect(step(html, 'end')).toBeGreaterThan(-1)
  const base = label(html, 'base')
  expect(base).toBeGreaterThan(-1)
  const line = html.slice(base, html.indexOf('s2-line', base + 1))
  expect(line).toContain('made from the branch checked out')
  expect(line).not.toContain('s2-change')
})

describe('the sandbox step (#1160)', () => {
  const withSandbox = async (sandbox: ReadView['sandbox']) => {
    const { SetupForm } = await import('../src/app/setup/repository/read/setup-form.tsx')
    return renderToStaticMarkup(<SetupForm view={{ ...view({ kind: 'github', owner: 'o', repo: 'p' }), sandbox }} />)
  }

  it('is absent where the view carries none — an existing recipe is never asked', async () => {
    expect(await withSandbox(null)).not.toContain('Sandbox')
  })

  it('shows the built-in hosts, on by default, and the line off gives up', async () => {
    const html = await withSandbox({ builtIns: ['api.example.com'], cannot: null, offLine: 'it reaches everything' })
    expect(html).toContain('Sandbox')
    expect(html).toContain('api.example.com')
    expect(html).toContain('it reaches everything')
    expect(html).not.toContain('cannot run the sandbox')
  })

  it('a failed read still offers the step, on, for a new recipe (#1160)', async () => {
    const { emptyView } = await import('../src/app/setup/repository/read/view.ts')
    const target = { kind: 'github', owner: 'o', repo: 'p' } as const
    expect(emptyView(target, 'p', null, 'it took too long').sandbox).toBeNull()
    const asked = emptyView(target, 'p', null, 'it took too long', {
      verdict: { can: false, reason: 'bwrap is missing', sentences: [] },
      install: { missing: ['bwrap'], command: 'apt install bubblewrap' },
      builtIns: ['api.example.com'],
    })
    expect(asked.sandbox).toMatchObject({ builtIns: ['api.example.com'] })
    expect(asked.sandbox?.cannot).toContain('Install: apt install bubblewrap')
    expect(asked.sandbox?.cannot).toContain('will run without one')
    expect(await withSandbox(asked.sandbox)).toContain('<input type="radio" checked=""/><span><b>On</b>')
  })

  it('says plainly when the host cannot provide it', async () => {
    const html = await withSandbox({
      builtIns: [],
      cannot: 'This machine cannot run the sandbox yet: no bwrap.',
      offLine: 'x',
    })
    expect(html).toContain('This machine cannot run the sandbox yet: no bwrap.')
  })
})
