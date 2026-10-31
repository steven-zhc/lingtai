import { readFileSync } from 'node:fs'

import { renderToStaticMarkup } from 'react-dom/server'
/**
 * `/` in a home that has nothing set up (#767): a screen that names the home
 * and `lingtai init`, never Next's error page, and one that reads no log.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const loadBoard = vi.hoisted(() => vi.fn())
const choice = vi.hoisted(() => ({ now: {} as unknown }))

vi.mock('../src/lib/board.ts', async (orig) => ({ ...(await orig<object>()), loadBoard }))
vi.mock('@lingtai/env', async (orig) => ({
  ...(await orig<object>()),
  storeChoice: () => choice.now,
  stateDir: () => '/nonexistent/lingtai-trial/a',
  shownHome: () => '~/lingtai-trial/a',
}))

import { NotSetUp } from '../src/app/not-set-up.tsx'
import Page from '../src/app/page.tsx'

const HOME = { path: '/Users/x/lingtai-trial/a', shown: '~/lingtai-trial/a' }

describe('the setup screen', () => {
  it('names the home, lingtai init and the reload, inside the brand', () => {
    const html = renderToStaticMarkup(
      <NotSetUp
        home={HOME}
        nothing
        choice={{ because: 'nothing chosen', refused: 'nothing on this machine says which store it runs' }}
      />,
    )
    expect(html).toContain('Nothing is set up in ~/lingtai-trial/a.')
    expect(html).toContain('lingtai init')
    expect(html).toContain('eload this page after lingtai init')
    expect(html).toMatch(/class="brand"[^]*~\/lingtai-trial\/a[^]*<\/span><\/div>/)
  })

  it('says the refusal, not "nothing is set up", for any other', () => {
    const html = renderToStaticMarkup(
      <NotSetUp home={HOME} nothing={false} choice={{ because: 'two keys', refused: 'two keys disagreeing' }} />,
    )
    expect(html).toContain('two keys disagreeing')
    expect(html).not.toContain('Nothing is set up')
  })
})

describe('/ with the store refused', () => {
  beforeEach(() => loadBoard.mockClear())

  it('draws the setup screen, reads no log and opens no event stream', async () => {
    choice.now = { because: 'nothing chosen', refused: 'nothing on this machine says which store it runs' }
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }))
    expect(html).toContain('Nothing is set up in ~/lingtai-trial/a.')
    expect(html).toContain('lingtai init')
    expect(loadBoard).not.toHaveBeenCalled()
    expect(html).not.toContain('class="health')
  })

  it('says a two-keys refusal in the same screen', async () => {
    choice.now = { because: 'two keys', refused: 'config.yml names two stores' }
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }))
    expect(html).toContain('config.yml names two stores')
    expect(html).not.toContain('Nothing is set up')
    expect(loadBoard).not.toHaveBeenCalled()
  })
})

describe('Home stays a server component', () => {
  it.each(['../src/app/home.tsx', '../src/app/not-set-up.tsx'])(
    '%s imports no @lingtai/env value and is not "use client"',
    (path) => {
      const src = readFileSync(new URL(path, import.meta.url), 'utf8')
      expect(src).not.toMatch(/^['"]use client['"]/m)
      expect(src).not.toMatch(/^import (?!type).*@lingtai\/env/m)
    },
  )
})
