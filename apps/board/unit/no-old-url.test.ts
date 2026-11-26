import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Source may not name, build or link an old board address (#1501). The patterns are built from fragments so this file does not match itself. */
const ROOT = new URL('../../../', import.meta.url).pathname
const SKIP = new Set(['node_modules', '.next', 'dist', '.turbo'])
const S = '/'
const OLD: readonly { re: RegExp; write: string }[] = [
  { re: new RegExp(`${S}task${S}`), write: '`/p/<project>/ticket/<n>` (`ticketPath` in `apps/board/src/lib/paths.ts`)' },
  { re: new RegExp(`(?<![\\w\\]])${S}pr${S}`), write: '`/p/<project>/pr[/…]` (`prPath`)' },
  { re: new RegExp(`(?<![\\w\\]])${S}recipe${S}`), write: '`/p/<project>/recipe` (`recipePath`)' },
  {
    re: new RegExp(`(?:['"\`]${S}|${S}landed|${S}backlog)\\?project=`),
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
              for (const { re, write } of OLD) if (re.test(line)) found.push(`${relative(ROOT, f)}:${i + 1}  write ${write}`)
            })
        }
      }
    }
    expect(found).toEqual([])
  })
})
