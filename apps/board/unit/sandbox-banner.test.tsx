/** #1167: the rows under the bar for a degraded or stopped sandbox. */
import { SANDBOX_REQUIRED_REFUSAL, declaredSandbox } from '@lingtai/recipe'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SandboxRows } from '../src/app/sandbox-banner.tsx'
import {
  SENTENCES,
  forgetSandboxRows,
  lastSandboxRows,
  rememberSandboxRows,
  sandboxBannerRows,
  type SandboxFacts,
} from '../src/lib/sandbox-state.ts'

const on = declaredSandbox('sandbox:\n  enabled: true\n')
const off = declaredSandbox('sandbox:\n  enabled: false\n')
const none = declaredSandbox('repo: x\n')
const facts = (f: Partial<SandboxFacts>): SandboxFacts => ({ refused: null, declared: on, observed: null, ...f })
const REFUSAL = `${SANDBOX_REQUIRED_REFUSAL} (bwrap is missing) — install what is missing, or set required: false`

describe('sandboxBannerRows', () => {
  it('stopped carries the host’s own reason; degraded the fixed sentence', () => {
    const rows = sandboxBannerRows(
      [
        { project: 'a', facts: facts({ refused: REFUSAL }) },
        { project: 'b', facts: facts({ observed: 'degraded' }) },
      ],
      undefined,
    )
    expect(rows).toEqual([
      { kind: 'stopped', project: 'a', reason: 'bwrap is missing' },
      { kind: 'degraded', project: 'b', reason: SENTENCES.degraded },
    ])
  })

  it('stopped with an unknown shape falls back to the fixed sentence', () => {
    const rows = sandboxBannerRows([{ project: 'a', facts: facts({ refused: SANDBOX_REQUIRED_REFUSAL }) }], undefined)
    expect(rows[0]?.reason).toBe(SENTENCES.stopped)
  })

  it('off by choice, sandboxed, unknown and unreadable never get a row', () => {
    const rows = sandboxBannerRows(
      [
        { project: 'a', facts: facts({ declared: none }) },
        { project: 'b', facts: facts({ declared: off, observed: 'degraded' }) },
        { project: 'c', facts: facts({ observed: 'sandboxed' }) },
        { project: 'd', facts: facts({ declared: 'none' }) },
      ],
      undefined,
    )
    expect(rows).toEqual([])
  })

  it('only the project in scope', () => {
    const all = [
      { project: 'a', facts: facts({ observed: 'degraded' }) },
      { project: 'b', facts: facts({ observed: 'degraded' }) },
    ]
    expect(sandboxBannerRows(all, 'b').map((r) => r.project)).toEqual(['b'])
  })
})

describe('SandboxRows', () => {
  it('renders nothing with no rows', () => {
    expect(renderToStaticMarkup(<SandboxRows rows={[]} install="x" />)).toBe('')
  })

  it('degraded: label, project link, sentence, reason, install command, the recipe link', () => {
    const html = renderToStaticMarkup(
      <SandboxRows
        rows={[{ kind: 'degraded', project: 'p', reason: SENTENCES.degraded }]}
        install="brew install ripgrep"
      />,
    )
    expect(html).toContain('sbx-degraded')
    expect(html).toContain('Sandbox degraded')
    expect(html).toContain('this project is running without a sandbox')
    expect(html).toContain('href="/p/p/ticket"')
    expect(html).toContain('<code>brew install ripgrep</code>')
    expect(html).toContain('href="/p/p/recipe#sandbox"')
  })

  it('stopped: red, the reason and the fix, and no Resume or Lift', () => {
    const html = renderToStaticMarkup(
      <SandboxRows
        rows={[{ kind: 'stopped', project: 'p', reason: 'bwrap is missing' }]}
        install="sudo apt install bubblewrap"
      />,
    )
    expect(html).toContain('sbx-stopped')
    expect(html).toContain('this project is stopped: it requires a sandbox this host cannot provide')
    expect(html).toContain('bwrap is missing')
    expect(html).toContain('<code>sudo apt install bubblewrap</code>')
    expect(html).not.toContain('<button')
    expect(html.toLowerCase()).not.toContain('resume')
    expect(html.toLowerCase()).not.toContain('lift')
  })

  it('shows the recipe fix alone on a platform with no install command', () => {
    const html = renderToStaticMarkup(
      <SandboxRows rows={[{ kind: 'stopped', project: 'p', reason: 'x' }]} install={undefined} />,
    )
    expect(html).not.toContain('<code>')
    expect(html).toContain('set required: false')
  })
})

describe('the skeleton count', () => {
  it('is 0 before any answer, then the last answer per scope', () => {
    forgetSandboxRows()
    expect(lastSandboxRows(undefined)).toBe(0)
    rememberSandboxRows(undefined, 2)
    rememberSandboxRows('p', 1)
    expect(lastSandboxRows(undefined)).toBe(2)
    expect(lastSandboxRows('p')).toBe(1)
    expect(lastSandboxRows('q')).toBe(0)
  })
})
