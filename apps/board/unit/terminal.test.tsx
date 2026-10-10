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
