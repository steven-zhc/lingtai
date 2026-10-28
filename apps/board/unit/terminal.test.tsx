import { renderToStaticMarkup } from 'react-dom/server'
/**
 * The screen `/setup/repository` and `/setup/wizard` are both reduced to
 * (#401). Choosing a repository and writing its recipe are the terminal's
 * now, so there is nothing left to fold-test besides the one query string
 * this screen still answers: `requested`.
 */
import { describe, expect, it } from 'vitest'

import { TerminalScreen } from '../src/app/setup/terminal.tsx'

describe('the terminal screen', () => {
  const out = renderToStaticMarkup(<TerminalScreen />)

  it('names the terminal command', () => {
    expect(out).toContain('pnpm lingtai add')
  })

  it('asks nothing of the person: no form and no repository in a query string', () => {
    expect(out).not.toContain('<form')
    expect(out).not.toContain('?repo=')
  })

  it('says nothing about a pending approval by default', () => {
    expect(out).not.toContain('owner has to approve')
  })
})

describe('a requested install', () => {
  it('says an organisation owner has to approve it', () => {
    const out = renderToStaticMarkup(<TerminalScreen requested />)
    expect(out).toContain('owner has to approve')
  })
})

describe('a gh machine', () => {
  const out = renderToStaticMarkup(<TerminalScreen gh />)

  it('says the gh login is used and shows lingtai add <owner>/<repo>', () => {
    expect(out).toContain('<code>gh</code> login')
    expect(out).toContain('lingtai add &lt;owner&gt;/&lt;repo&gt;')
  })

  it('offers no installation and no App picker', () => {
    for (const s of ['/setup/github-app', 'installations/new', 'the App can see', 'owner has to approve']) {
      expect(out).not.toContain(s)
    }
  })

  it('does not mention a pending approval even when requested', () => {
    expect(renderToStaticMarkup(<TerminalScreen gh requested />)).not.toContain('owner has to approve')
  })
})

describe('a machine that is not gh', () => {
  it('still describes the App picker', () => {
    expect(renderToStaticMarkup(<TerminalScreen />)).toContain('the App can see')
  })
})
