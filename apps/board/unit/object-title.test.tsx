import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ObjectTitle, joinMeta, taskTone } from '../src/app/object-title.tsx'
import { rulesOf } from '../test/css-rules.ts'

// #1459: every page about one object has one title form, drawn by ObjectTitle and by nothing else; a page that is a
// view of a project has none. The sizes are the --fs-* variables, the radius is --radius, and `hlab` is gone.
const app = new URL('../src/app/', import.meta.url).pathname
const css = readFileSync(join(app, 'globals.css'), 'utf8')

const tsxUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return tsxUnder(path)
    return path.endsWith('.tsx') ? [path] : []
  })

describe('ObjectTitle', () => {
  it('draws the tag, then the one h1, then the metadata line, for a PR and a setup page', () => {
    const pr = renderToStaticMarkup(
      <ObjectTitle tag="merged" tone="pass" title="the title" meta={joinMeta(['PR 6', 'main'])} />,
    )
    expect(pr).toContain('class="ot ot--pass"')
    expect(pr.indexOf('class="ot-tag">merged<')).toBeLessThan(pr.indexOf('<h1'))
    expect(pr.indexOf('<h1')).toBeLessThan(pr.indexOf('class="ot-meta"'))
    expect(pr.match(/<h1/g)).toHaveLength(1)
    expect(pr).toContain('PR 6 · main')
    const setup = renderToStaticMarkup(<ObjectTitle tag="setup" tone="muted" title="Repository" />)
    expect(setup).toContain('class="ot ot--muted"')
    expect(setup).toContain('class="ot-tag">setup<')
    expect(setup).not.toContain('ot-meta')
  })

  it("leads the task page's title line with the state word, and draws no tag", () => {
    const html = renderToStaticMarkup(
      <ObjectTitle tone={taskTone('blocked')} lead="waiting on you" title="a ticket" meta="#1 ↗" />,
    )
    expect(html).toContain('class="ot ot--signal"')
    expect(html).toContain('class="sstate">waiting on you<')
    expect(html).not.toContain('ot-tag')
    expect(html.indexOf('class="sstate"')).toBeGreaterThan(html.indexOf('<h1'))
    expect(html.indexOf('class="sstate"')).toBeLessThan(html.indexOf('a ticket'))
    expect(html.indexOf('a ticket')).toBeLessThan(html.indexOf('class="ot-meta"'))
  })

  it('draws no subject for a task that is not a work item', () => {
    const html = renderToStaticMarkup(<ObjectTitle tone="muted" lead="queued" />)
    expect(html).not.toContain('data-rank="subject"')
  })

  it('has a tone for every task state', () => {
    expect(taskTone('blocked')).toBe('signal')
    expect(taskTone('running')).toBe('accent')
    expect(taskTone('landed')).toBe('pass')
    expect(taskTone('queued')).toBe('muted')
  })
})

describe("ObjectTitle's rules", () => {
  const rules = rulesOf(css).filter((r) => /^\.ot(\b|-)/.test(r.selector.trim()) || r.selector.includes('.ot--'))
  it('are found', () => expect(rules.length).toBeGreaterThan(5))
  it('size type with --fs-* and the radius with --radius, and carry no literal colour', () => {
    for (const r of rules) {
      for (const m of r.body.matchAll(/font-size\s*:\s*([^;]+)/g))
        expect(m[1]!.trim(), r.selector).toMatch(/^var\(--fs-/)
      for (const m of r.body.matchAll(/border-radius\s*:\s*([^;]+)/g))
        expect(m[1]!.trim(), r.selector).toBe('var(--radius)')
      expect(r.body, r.selector).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
    }
    const tag = rules.find((r) => r.selector.trim() === '.ot-tag')!
    expect(tag.body).toContain('var(--fs-xs)')
    expect(tag.body).toMatch(/padding:\s*2px 8px/)
    const title = rules.find((r) => r.selector.trim() === '.ot-title')!
    expect(title.body).toContain('var(--fs-xl)')
    expect(title.body).toMatch(/font-weight:\s*700/)
    expect(rules.find((r) => r.selector.trim() === '.ot-meta')!.body).toContain('var(--fs-2xs)')
  })
})

describe('one title form', () => {
  const files = tsxUnder(app)
  it('has no hlab in any .tsx, and none in the stylesheet', () => {
    expect(files.filter((f) => /hlab/.test(readFileSync(f, 'utf8'))).map((f) => relative(app, f))).toEqual([])
    for (const gone of ['.hlab', '.hfact', '.ld-header', '.prp-chip', '.prp-title']) expect(css).not.toContain(gone)
  })
  it('has no second <h1>: only ObjectTitle (and the dev preview) draws one', () => {
    const drawn = files
      .filter((f) => /<h1/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(app, f))
      .sort()
    expect(drawn).toEqual(['dev/waiting/page.tsx', 'object-title.tsx'])
  })
})
