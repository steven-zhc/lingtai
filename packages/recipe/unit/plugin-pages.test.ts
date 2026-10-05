/**
 * `doc/plugins/` against the closed set — the list of fourteen is **derived and
 * never typed**.
 *
 * A hand-kept count of steps or plugins has been wrong three times in two days
 * (`rail.tsx` twice in one night, both caught by a reviewer) for one reason:
 * nothing derived it. So the parent page's table is judged here against
 * `PLUGINS` itself — every plugin has a row, every row names a plugin, and a
 * row's steps are that plugin's own `at` keys in their own order. A fifteenth
 * plugin is then a red test rather than something somebody has to remember, and
 * so is a plugin whose `at` gained a step.
 *
 * **Beside the closed set rather than beside the site**, for the reason
 * `packages/actions/unit/tamper-watch.test.ts` reads `doc/tamper-watch.md`: the
 * document is what the code is judged against, and the judgement belongs where
 * the code is. What the *site* does with these files — that the section
 * publishes them, that the template is not published — is
 * `apps/site/unit/docs.test.ts`'s, one level up.
 */
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { PLUGINS } from '../src/recipe.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const pluginDoc = `${root}doc/plugins/`

/** One row of the parent page's table, as the three cells that carry a claim. */
interface Row {
  /** The plugin the row is about, off the first cell — linked or bare. */
  key: string
  /** Whether the first cell links to a page of its own. */
  linked: boolean
  /** The step names the second cell carries, in the order it carries them. */
  steps: string[]
  /** The third cell, which only has to be there. */
  says: string
}

/**
 * The table under `## The fourteen`, parsed rather than counted.
 *
 * Only that section: the page has other tables' worth of prose around it, and a
 * parser that swept the whole file would judge whatever the next edit adds.
 */
async function rowsOnTheParentPage(): Promise<Row[]> {
  const body = await readFile(`${pluginDoc}index.md`, 'utf8')
  const section = body.split(/^## /m).find((part) => part.startsWith('The fourteen'))
  if (section === undefined) throw new Error('doc/plugins/index.md has no `## The fourteen` section')

  const rows: Row[] = []
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
    const [first = '', serves = '', says = ''] = cells
    if (first === 'key' || /^-+$/.test(first)) continue
    const linked = /^\[`([^`]+)`\]\(/.exec(first)
    const bare = /^`([^`]+)`$/.exec(first)
    const key = linked?.[1] ?? bare?.[1]
    if (key === undefined) throw new Error(`a row's first cell names no plugin: ${line}`)
    rows.push({
      key,
      linked: linked !== null,
      steps: [...serves.matchAll(/`([^`]+)`/g)].map((m) => m[1]!),
      says,
    })
  }
  return rows
}

/** Every page under `doc/plugins/` that is a page — `_`-prefixed is a shape. */
async function pagesUnderPlugins(): Promise<string[]> {
  const names = await readdir(pluginDoc)
  return names.filter((n) => n.endsWith('.md') && !n.startsWith('_')).sort()
}

describe('the parent page lists the closed set', () => {
  it('gives every plugin a row, and every row a plugin', async () => {
    const rows = await rowsOnTheParentPage()
    expect(rows.map((row) => row.key).sort()).toEqual(PLUGINS.map((p) => p.key).sort())
    expect(rows).toHaveLength(PLUGINS.length)
  })

  it("names each plugin's own `at` steps, and nothing else", async () => {
    const rows = new Map((await rowsOnTheParentPage()).map((row) => [row.key, row]))
    for (const plugin of PLUGINS) {
      const row = rows.get(plugin.key)
      expect(row, `\`${plugin.key}:\` has no row on doc/plugins/index.md`).toBeDefined()
      // `serves` is `Object.keys(at)`, which is the order the plugin declares
      // them in — pipeline order for every one of the fourteen. Order and all:
      // a reader uses the column to see *when* in a pass the key is reached.
      expect(row!.steps, `the steps listed for \`${plugin.key}:\``).toEqual([...plugin.serves])
    }
  })

  it('says what a plugin serving no step serves, rather than leaving the cell blank', async () => {
    // `backlog:` is the row that earns the table — in the closed set, with a
    // field, and an `at` of `{}`. A page that could not say *this one serves no
    // step yet* would quietly omit it, which is the failure `unpublished()` in
    // `apps/site/src/lib/docs.ts` exists to prevent one level up.
    const row = (await rowsOnTheParentPage()).find((each) => each.key === 'backlog')
    expect(row?.steps).toEqual([])
    expect(row?.says, 'the backlog row says nothing about what it is for').not.toBe('')
  })

  it('gives every row a line of what the key is for', async () => {
    for (const row of await rowsOnTheParentPage()) {
      expect(row.says, `\`${row.key}:\` has an empty third cell`).not.toBe('')
    }
  })
})

describe('a page per plugin, once one is written', () => {
  it('has no page for something that is not a plugin', async () => {
    const keys = new Set<string>(PLUGINS.map((p) => p.key))
    const orphans = (await pagesUnderPlugins())
      .filter((name) => name !== 'index.md')
      .filter((name) => !keys.has(name.replace(/\.md$/, '')))
    expect(orphans, 'a page under doc/plugins/ that names no plugin').toEqual([])
  })

  it('is linked from the row it belongs to, so the two cannot drift', async () => {
    const written = new Set(await pagesUnderPlugins())
    for (const row of await rowsOnTheParentPage()) {
      const has = written.has(`${row.key}.md`)
      expect(row.linked, `\`${row.key}:\`: page ${has ? 'exists' : 'does not exist'}`).toBe(has)
    }
  })

  it("follows the template's sections, in the template's order", async () => {
    // The shape is read off `_template.md` rather than written here, for the
    // reason the whole file exists: a list of sections kept beside the template
    // is a second copy of it. Fourteen pages, one shape.
    const shape = sectionsOf(await readFile(`${pluginDoc}_template.md`, 'utf8'))
    expect(shape.length, 'the template has lost its sections').toBeGreaterThan(3)
    for (const name of (await pagesUnderPlugins()).filter((n) => n !== 'index.md')) {
      const sections = sectionsOf(await readFile(pluginDoc + name, 'utf8'))
      expect(sections, `doc/plugins/${name} does not follow the template`).toEqual(shape)
    }
  })
})

describe('a page stays inside the budget', () => {
  it('is no longer than the template says, and opens on a TL;DR table', async () => {
    // The limit is read off `_template.md` ("no page over N lines") rather than
    // written here: a number kept beside the sentence that states it is a second
    // copy of it. The budget was prose for a month and every page written in that
    // time was over it, so it is a test now.
    const template = await readFile(`${pluginDoc}_template.md`, 'utf8')
    const limit = Number(/no page over (\d+) lines/.exec(template)?.[1])
    expect(limit, 'the template no longer states a line budget').toBeGreaterThan(0)

    for (const name of (await pagesUnderPlugins()).filter((n) => n !== 'index.md')) {
      const body = await readFile(pluginDoc + name, 'utf8')
      const lines = body.trimEnd().split('\n').length
      expect(lines, `doc/plugins/${name} is ${lines} lines against a budget of ${limit}`).toBeLessThanOrEqual(limit)
      // The TL;DR is the first thing after the title: a table, before any heading.
      const beforeFirstSection = body.split(/^## /m)[0]!
      expect(beforeFirstSection, `doc/plugins/${name} has no TL;DR table`).toMatch(/^\| \*\*Does\*\* \|/m)
    }
  })
})

/**
 * A section an ADR's Status block says is superseded, cited as though current.
 *
 * `run:`'s lede led with *0037 §2, there is no plugin system* for as long as
 * that was true and for a while after it stopped being: 0067 found a plugin
 * system had been built and narrowed §2 to *the registry is closed*. Nothing
 * failed — a superseded citation reads exactly like a live one — so the page
 * kept telling a stranger that a third party can never do more than run a
 * command, which is the conclusion 0067 exists to stop.
 *
 * **Derived from the Status blocks**, and from either end of the supersession:
 * the superseding file records it (`0067`'s *Supersedes [0037] §2*) or the
 * superseded one does (`0030`'s §2, `0042`'s §8). Both shapes are in the
 * decisions today and neither is wrong, so this reads both rather than asking
 * anybody to pick — and a list of superseded sections kept beside this test
 * would be the hand-kept table the rest of the file exists to refuse.
 *
 * The rule is *name the superseder*, not *do not cite*: a page may quote a dead
 * section — `run:`'s `## Related` does — as long as it says so **where it cites
 * it**. The unit is therefore the block and not the page: one paragraph, one
 * list item, one table row. A page whose `## Related` names 0067 four screens
 * below a lede that does not would satisfy a page-wide check and still leave
 * the reader who stopped at the lede holding the old rule, which is exactly how
 * this went wrong.
 */
describe('a page does not cite a superseded section as current', () => {
  it('names the superseding decision in the same block, wherever it cites one', async () => {
    const replaced = await supersededSections()
    expect(
      replaced.get('0037 §2'),
      "no decision's Status records that 0067 superseded 0037 §2 — the case this test was written for",
    ).toBe('0067')

    for (const name of await pagesUnderPlugins()) {
      for (const block of blocksOf(await readFile(pluginDoc + name, 'utf8'))) {
        for (const [adr, section] of citationsIn(block)) {
          const by = replaced.get(`${adr} §${section}`)
          if (by === undefined) continue
          expect(
            block.includes(by),
            `doc/plugins/${name} cites ${adr} §${section} without naming ${by}, which superseded it:\n${block}`,
          ).toBe(true)
        }
      }
    }
  })
})

/** Every `[NNNN](../decisions/NNNN-….md) §M` in a span, as `NNNN` and `M`. */
function citationsIn(body: string): [string, string][] {
  const cited = /\]\(\.\.\/decisions\/(\d{4})-[^)]+\.md\)\s*§(\d+)/g
  return [...body.matchAll(cited)].map((m) => [m[1]!, m[2]!])
}

/**
 * The spans a reader takes one claim from: a paragraph, a list item, a table row.
 *
 * A `## Related` list is one paragraph to a blank-line split, and each bullet
 * of it is a separate claim about a separate decision — so a note under one
 * bullet must not excuse the citation under the next.
 */
function blocksOf(body: string): string[] {
  return body.split(/\n\s*\n/).flatMap((para) => para.split(/\n(?=\s*(?:[-*] |\|))/))
}

/**
 * `"0037 §2"` → `"0067"`, off the decisions' own Status blocks.
 *
 * The block is the paragraph under the title and the `·` between its clauses is
 * what bounds one, because a Status line says several things: *supersedes
 * [0016] §5's "Plugins are trusted code"* and *§2's … superseded by [0067]* are
 * two clauses on one line and only one of them is a supersession of this file's
 * own section. A clause that does not say `supersed` at all is not read — which
 * is how 0067's **Keeps** [0037] §1 stays a live citation.
 */
async function supersededSections(): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const decisions = `${root}doc/decisions-archive/`
  for (const name of (await readdir(decisions)).filter((n) => n.endsWith('.md'))) {
    const body = await readFile(decisions + name, 'utf8')
    const status = /\*\*Status\*\*([\s\S]*?)\n\n/.exec(body)?.[1]
    if (status === undefined) continue
    const self = /^(\d{4})/.exec(name)?.[1]
    if (self === undefined) continue
    for (const clause of status.split('·')) {
      // *this* file's §M, which the clause says another decision replaced.
      const mine = /§(\d+)'s[^§]*?superseded by\s*\**\s*\[(\d{4})\]/.exec(clause)
      if (mine !== null) out.set(`${self} §${mine[1]!}`, mine[2]!)
      // Another file's §M, which this clause says *this* decision replaced.
      const theirs = /supersedes\**\s*\[(\d{4})\]\([^)]*\)\s*§(\d+)/i.exec(clause)
      if (theirs !== null) out.set(`${theirs[1]!} §${theirs[2]!}`, self)
    }
  }
  return out
}

/** A document's `##` headings, in order — which is the whole of "the shape". */
function sectionsOf(body: string): string[] {
  return [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]!.trim())
}
