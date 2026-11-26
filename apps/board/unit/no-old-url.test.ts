import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

/** Source may not name, build or link an old board address (#1501). The patterns are built from fragments so this file does not match itself. */
const ROOT = new URL('../../../', import.meta.url).pathname
const SKIP = new Set(['node_modules', '.next', 'dist', '.turbo'])
const S = '/'
/** Where a board address can begin: a quote, a template's `}` or a call's `)`, or a host (`:3200`, `http://b`). */
const START = `(?:['"\`})]|:\\d+|https?:${S}${S}[^${S}\\s'"\`]+)`
/** A project page is `/p/<project>/pr/…`, so a `/pr/` that follows `/p/<segment>` is the new shape. */
const NOT_PROJECT_PAGE = `(?<!${S}p${S}[^${S}\\s'"\`]*)`
const QUERY = `(?:[^\\s'"\`]*&)?project=`
export const OLD: readonly { re: RegExp; write: string }[] = [
  {
    re: new RegExp(`${S}task${S}`),
    write: '`/p/<project>/ticket/<n>` (`ticketPath` in `apps/board/src/lib/paths.ts`)',
  },
  { re: new RegExp(`${START}${NOT_PROJECT_PAGE}${S}pr${S}`), write: '`/p/<project>/pr[/…]` (`prPath`)' },
  { re: new RegExp(`${START}${NOT_PROJECT_PAGE}${S}recipe${S}`), write: '`/p/<project>/recipe` (`recipePath`)' },
  {
    re: new RegExp(`${START}${S}\\?${QUERY}|${S}(?:landed|backlog)\\?${QUERY}`),
    write: '`homePath`, `landedHref` or `backlogPath` (`?project=` is not an address)',
  },
]

function* files(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* files(p)
    else if (/\.(ts|tsx|mts|js|mjs|json|md)$/.test(e.name)) yield p
  }
}

describe('no old board URL in source (#1501)', () => {
  it('finds none under apps/ and packages/', () => {
    const found: string[] = []
    for (const top of ['apps', 'packages']) {
      for (const pkg of readdirSync(join(ROOT, top))) {
        const dir = join(ROOT, top, pkg)
        if (!readdirSync(dir).length) continue
        for (const f of files(dir)) {
          if (f === new URL(import.meta.url).pathname) continue
          readFileSync(f, 'utf8')
            .split('\n')
            .forEach((line, i) => {
              for (const { re, write } of OLD)
                if (re.test(line))
                  found.push(`${relative(ROOT, f)}:${i + 1}  ${line.trim().slice(0, 100)}  → write ${write}`)
            })
        }
      }
    }
    expect(found).toEqual([])
  })
})

describe('the guard matches the ways an old address is written (#1501)', () => {
  const hit = (line: string) => OLD.some(({ re }) => re.test(line))
  it.each([
    '`${boardUrl()}/pr/${project}/1`',
    '`${boardUrl()}/recipe/${project}`',
    "'/pr/lingtai/1'",
    'href="http://localhost:3200/?project=lingtai"',
    'href="http://localhost:3200/?a=1&project=lingtai"',
    "'/?a=1&project=x'",
    '`${base}/landed?kind=bug&project=x`',
    "'/backlog?project=x'",
    "'/task/ticket-x-1'",
  ])('flags %s', (line) => {
    expect(hit(line)).toBe(true)
  })
  it.each([
    '`/p/${project}/pr/1`',
    '`${boardUrl()}/p/${project}/pr/1`',
    "'/p/x/recipe/'",
    'packages/recipe/src/index.ts',
    "'@lingtai/recipe/settings'",
    '`~/.lingtai/${project}/recipe.yml`',
    "'/report?project=x'",
    "'/setup/repository/added?project=x'",
  ])('leaves %s alone', (line) => {
    expect(hit(line)).toBe(false)
  })
})
