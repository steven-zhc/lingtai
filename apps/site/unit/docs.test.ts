import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { STEPS } from '@lingtai/domain'
import { describe, expect, it } from 'vitest'

import {
  DOCS_PUBLIC,
  decidedOn,
  decisionsByNumber,
  docRoot,
  entriesOf,
  fileOf,
  GITHUB_BLOB,
  headingsOf,
  ledeOf,
  published,
  resolveHref,
  servable,
  SECTIONS,
  slugify,
  slugOf,
  statuses,
  statusParts,
  titleOf,
  treeOf,
  unpublished,
} from '@/lib/docs'

/**
 * The projection is tested against the real `doc/`, not a fixture.
 *
 * A fixture would test that the code can read a directory, which is not the
 * claim. The claim is that *this repository's* documentation renders — that
 * every file a section names is there, that the links inside those files reach
 * somewhere, and that nothing is quietly dropped. A fixture passes on the day
 * somebody deletes `tutorial.md`.
 */

describe('what the site publishes', () => {
  it('takes every guide the sections name, and they all exist', async () => {
    const guides = SECTIONS.find((s) => s.id === 'guides')
    expect(guides).toBeDefined()
    const files = Array.isArray(guides!.files) ? guides!.files : []
    // `filesOf` drops a file that is not on disk, so a name that disappeared
    // from `doc/` would leave the site quietly one page short.
    const { filesOf } = await import('@/lib/docs')
    expect(await filesOf(guides!)).toEqual(files)
  })

  it('takes every decision in the directory, and not the archive', async () => {
    const all = await published()
    expect(all).toContain('tutorial.md')
    expect(all).toContain('decisions/0100-one-append-only-log.md')
    expect(all.filter((f) => f.startsWith('decisions/')).length).toBeGreaterThan(10)
    // The archive is history the code cites, never what is decided now.
    expect(all.some((f) => f.startsWith('decisions-archive/'))).toBe(false)
  })

  it('names what it does not publish rather than dropping it', async () => {
    const missing = await unpublished()
    // `doc/research/` is a market study and not documentation, so it is not
    // projected — and the index says so. The failure this guards against is
    // the *silent* omission, not the omission.
    expect(missing).toContain('research/market-opportunities.md')
    expect(missing).not.toContain('README.md')
  })

  it('refuses a slug that climbs out of doc/', () => {
    expect(fileOf('../package')).toBeNull()
    expect(fileOf('../../package')).toBeNull()
    expect(fileOf('tutorial')).toBe('tutorial.md')
  })

  it("serves a directory's index.md at the directory", async () => {
    // `/docs/plugins/` and not `/docs/plugins/index/`, which is the route a
    // person guesses when they take a segment off a plugin's page. The pair
    // round-trips, because `generateStaticParams` builds the route `slugOf`
    // gives and the page reads it back with `fileOf`.
    expect(slugOf('plugins/index.md')).toBe('plugins')
    expect(fileOf('plugins')).toBe('plugins/index.md')
    expect(await published()).toContain('plugins/index.md')
  })

  it('does not publish the plugin page template, and does not hide it either', async () => {
    // A leading underscore is the one convention `markdownIn` reads: the
    // template is a shape to fill in, and published it would be a page whose
    // every section is an instruction about a different one. `unpublished()`
    // still names it, so the index links to it on GitHub rather than dropping
    // it — the cost of an allow-list, paid out loud.
    expect(await published()).not.toContain('plugins/_template.md')
    expect(await unpublished()).toContain('plugins/_template.md')
  })
})

const RESOLUTION_LABELS = [
  'Approve and continue',
  'Continue fixing current work',
  'Answer the question',
  'Start over from base',
  'Add to the ticket and start over',
  'Close the ticket',
]

// Shell variants and chaff repeat what a reader only needs once, so prose is
// counted without code blocks.
const proseOf = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, '')
    .trim()
    .split(/\s+/).length

describe('the tutorial stays a first-run path', () => {
  it('keeps the beginner path to init, one ticket and start', async () => {
    const body = await readFile(path.join(docRoot, 'tutorial.md'), 'utf8')
    // #1061: a fact that is not on the first-run path goes to tutorial-more.md.
    expect(proseOf(body), 'the first-run path has become a reference manual again').toBeLessThan(400)
    expect(body).not.toContain('<details>')
    expect(body).not.toContain('CHAPTER_GARDEN_DIR')
    expect(body).not.toContain('$VISUAL')
    expect(body).not.toContain('--land hold')
    expect(body).toContain('(tutorial-more.md)')
    expect(
      headingsOf(body)
        .filter((h) => h.depth === 2)
        .map((h) => h.text),
    ).toEqual([
      'Before you start',
      'Step 1 — Set up this machine',
      'Step 2 — Open one ticket',
      'Step 3 — Start',
      'Next',
    ])
  })

  it('keeps the options, the hold, the refusal and GitHub on the second page', async () => {
    const body = await readFile(path.join(docRoot, 'tutorial-more.md'), 'utf8')
    expect(body).not.toContain('<details')
    expect(body).not.toContain('CHAPTER_GARDEN_DIR')
    expect(await servable()).toContain('tutorial-more.md')
    const hold = body.indexOf('\n## Hold every attempt')
    const refusal = body.indexOf('\n## Watch a check refuse')
    const github = body.indexOf('\n## Part 2')
    expect(hold).toBeGreaterThan(0)
    expect(refusal).toBeGreaterThan(hold)
    expect(github).toBeGreaterThan(refusal)
    expect(proseOf(body.slice(hold, refusal)), 'the hold has become a manual').toBeLessThan(400) // #1061
    expect(proseOf(body.slice(refusal, github)), 'the refusal step has become a manual').toBeLessThan(350)
    expect(proseOf(body.slice(github)), 'the GitHub half has become a reference manual').toBeLessThan(600)
    expect(
      headingsOf(body)
        .filter((h) => h.depth === 2)
        .map((h) => h.text),
    ).toEqual([
      'What each init option means',
      'Hold every attempt for approval',
      'Watch a check refuse',
      'Part 2 — Move the project to GitHub',
    ])
  })

  it('keeps the repository-detection list on the recipe page, with no disclosure', async () => {
    const body = await readFile(path.join(docRoot, 'recipe.md'), 'utf8')
    expect(body).toContain('Using your own repository?')
    expect(body).not.toContain('<details')
  })
})

describe('what a document says it is', () => {
  it("takes the title from the file's own heading", () => {
    expect(titleOf('# The seams\n\nbody', 'fallback')).toBe('The seams')
    expect(titleOf('no heading here', 'fallback')).toBe('fallback')
  })

  it('takes a lede from prose, and skips tables, quotes and lists', () => {
    expect(ledeOf('# T\n\n| a | b |\n\n- one\n\nThe **real** first line.')).toBe('The real first line.')
  })

  it("reads each decision's status out of doc/README.md", async () => {
    const status = await statuses()
    // The index is the one place a decision's status is written, and a decision
    // that is accepted with a part unbuilt has to say so on its page too.
    expect(status.get('decisions/0100-one-append-only-log')).toMatch(/^accepted/)
    expect(status.get('decisions/0103-a-pass-is-ten-fixed-steps')).toMatch(/not yet built/)
  })

  it('gives every entry a title that is not just its filename', async () => {
    const decisions = SECTIONS.find((s) => s.id === 'decisions')!
    for (const entry of await entriesOf(decisions)) {
      expect(entry.title).not.toBe(entry.slug)
    }
  })
})

describe('where a link inside a document goes', () => {
  const isPublished = (file: string) =>
    [
      'tutorial.md',
      'tutorial-more.md',
      'decisions-archive/0022-the-seams.md',
      'decisions-archive/0016-the-settled-model.md',
    ].includes(file)

  it('opens the tutorial diagram from the same site build as the page', async () => {
    const more = await readFile(path.join(docRoot, 'tutorial-more.md'), 'utf8')
    expect(more).toContain('[Open the diagram at full size](img/recipe.svg)')
    expect(resolveHref('tutorial-more.md', 'img/recipe.svg', isPublished)).toBe('/img/docs/recipe.svg')
  })

  it('sends a link between two projected documents to its route here', () => {
    expect(resolveHref('decisions-archive/0022-the-seams.md', '0016-the-settled-model.md', isPublished)).toBe(
      '/docs/decisions-archive/0016-the-settled-model/',
    )
    expect(resolveHref('tutorial.md', 'decisions-archive/0022-the-seams.md', isPublished)).toBe(
      '/docs/decisions-archive/0022-the-seams/',
    )
    expect(resolveHref('decisions-archive/0022-the-seams.md', '../tutorial.md', isPublished)).toBe('/docs/tutorial/')
  })

  it('sends a link to the events manifest to its page', () => {
    expect(resolveHref('tutorial.md', 'events.json', isPublished)).toBe('/docs/events/')
    expect(resolveHref('plugins/index.md', '../events.json', isPublished)).toBe('/docs/events/')
  })

  it('publishes the requirements beside the tutorial and keeps operating on GitHub', async () => {
    const served = await servable()
    const served$ = (file: string) => served.includes(file)
    expect(served).toContain('requirements.md')
    expect(served).not.toContain('operating.md')
    expect(resolveHref('tutorial.md', 'requirements.md', served$)).toBe('/docs/requirements/')
    expect(resolveHref('tutorial.md', 'operating.md', served$)).toBe(`${GITHUB_BLOB}doc/operating.md`)
    expect(resolveHref('requirements.md', '../README.md', served$)).toBe(`${GITHUB_BLOB}README.md`)
  })

  it('publishes the safety page the home page links to', async () => {
    const served = await servable()
    expect(served).toContain('safety.md')
    expect(resolveHref('tutorial.md', 'safety.md', (f) => served.includes(f))).toBe('/docs/safety/')
  })

  it('publishes the best practices page', async () => {
    const served = await servable()
    expect(served).toContain('guide.md')
    expect(resolveHref('tutorial.md', 'guide.md', (f) => served.includes(f))).toBe('/docs/guide/')
  })

  it('publishes the recipe guide beside the tutorial without publishing the reference', async () => {
    const served = await servable()
    const served$ = (file: string) => served.includes(file)
    expect(served).toContain('recipe.md')
    expect(served).not.toContain('reference.md')
    expect(served).not.toContain('operating.md')
    expect(resolveHref('tutorial.md', 'recipe.md', served$)).toBe('/docs/recipe/')
    expect(resolveHref('recipe.md', 'plugins/run.md', served$)).toBe('/docs/plugins/run/')
    expect(await readFile(path.join(docRoot, 'tutorial.md'), 'utf8')).toContain('(recipe.md)')
  })

  it('publishes the concepts page, built from doc/, and links it from the tutorial', async () => {
    const served = await servable()
    const served$ = (file: string) => served.includes(file)
    expect(served).toContain('concepts.md')
    expect(resolveHref('tutorial.md', 'concepts.md', served$)).toBe('/docs/concepts/')
    expect(await readFile(path.join(docRoot, 'tutorial.md'), 'utf8')).toContain('(concepts.md)')
    const body = await readFile(path.join(docRoot, 'concepts.md'), 'utf8')
    expect(body).toContain('(img/concepts.svg)')
    await expect(readFile(path.join(docRoot, 'img/concepts.svg'), 'utf8')).resolves.toContain('<svg')
    let at = -1
    for (const step of STEPS) {
      const next = body.indexOf(`\`${step}\``, at + 1)
      expect(next, `the page names ${step} after the step before it`).toBeGreaterThan(at)
      at = next
    }
  })

  it('quotes only the labels the board shows', async () => {
    const body = await readFile(path.join(docRoot, 'concepts.md'), 'utf8')
    const copy = await readFile(path.join(docRoot, '../apps/board/src/lib/resolution-copy.ts'), 'utf8')
    const labels = [...body.matchAll(/\*\*([A-Z][^*]+)\*\*/g)]
      .map((m) => m[1]!)
      .filter((l) => RESOLUTION_LABELS.includes(l))
    expect(labels.length).toBeGreaterThanOrEqual(6)
    for (const label of RESOLUTION_LABELS) expect(copy, label).toContain(`title: '${label}'`)
  })

  it('publishes the Symphony page and links it from the requirements', async () => {
    const served = await servable()
    const served$ = (file: string) => served.includes(file)
    expect(served).toContain('from-symphony.md')
    expect(resolveHref('requirements.md', 'from-symphony.md', served$)).toBe('/docs/from-symphony/')
    const requirements = await readFile(path.join(docRoot, 'requirements.md'), 'utf8')
    expect(requirements).toContain('(from-symphony.md)')
  })

  it('keeps the anchor', () => {
    expect(resolveHref('tutorial.md', 'decisions-archive/0022-the-seams.md#the-seams', isPublished)).toBe(
      '/docs/decisions-archive/0022-the-seams/#the-seams',
    )
  })

  it('sends a link to source code to the repository, where the code is', () => {
    expect(
      resolveHref('decisions-archive/0016-the-settled-model.md', '../../packages/domain/src/events.ts', isPublished),
    ).toBe(`${GITHUB_BLOB}packages/domain/src/events.ts`)
  })

  it('sends a link to a document nobody projected to the repository too', () => {
    expect(resolveHref('tutorial.md', 'research/market-opportunities.md', isPublished)).toBe(
      `${GITHUB_BLOB}doc/research/market-opportunities.md`,
    )
  })

  it('sends architecture.html to the copy the build made, or to GitHub while docs are private', () => {
    expect(resolveHref('decisions-archive/0022-the-seams.md', '../architecture.html', isPublished)).toBe(
      DOCS_PUBLIC ? '/doc/architecture.html' : `${GITHUB_BLOB}doc/architecture.html`,
    )
  })

  it('leaves an absolute link and a bare anchor alone', () => {
    expect(resolveHref('tutorial.md', 'https://github.com/x', isPublished)).toBe('https://github.com/x')
    expect(resolveHref('tutorial.md', '#done-when', isPublished)).toBe('#done-when')
  })
})

describe('finding your way around one document', () => {
  it('gives a heading the anchor GitHub would have given it', () => {
    expect(slugify('8. Deliberately not building')).toBe('8-deliberately-not-building')
    expect(slugify('The layers')).toBe('the-layers')
    expect(slugify('`end` — what it does')).toBe('end--what-it-does')
  })

  it('takes ## through ####, and never a hash inside a fence', () => {
    const headings = headingsOf(
      ['# Title', '## One', '```', '## not a heading', '```', '### Two', '#### Three'].join('\n'),
    )
    expect(headings.map((h) => [h.depth, h.id])).toEqual([
      [2, 'one'],
      [3, 'two'],
      [4, 'three'],
    ])
  })

  it('gives a repeated heading its own anchor, as GitHub does', () => {
    expect(headingsOf('## Done when\n\n## Done when').map((h) => h.id)).toEqual(['done-when', 'done-when-1'])
  })

  it('puts every anchor written in doc/ on a heading that exists', async () => {
    // The one check that matters: these anchors were written against the files
    // as GitHub renders them, and a projection that invents its own slugs
    // breaks them silently. `#### The layers` in `operating.md` is why `####`
    // gets an id at all.
    const files = await published()
    const headings = new Map<string, Set<string>>()
    for (const file of files) {
      const body = await readFile(path.join(docRoot, file), 'utf8')
      headings.set(file, new Set(headingsOf(body).map((h) => h.id)))
    }

    // `events.json#Name` is served as `/docs/events/#Name`: an entry's id, not a heading.
    const manifest = JSON.parse(await readFile(path.join(docRoot, 'events.json'), 'utf8')) as {
      events: { name: string }[]
    }
    const eventNames = new Set(manifest.events.map((e) => e.name))

    const dangling: string[] = []
    for (const file of files) {
      const body = await readFile(path.join(docRoot, file), 'utf8')
      for (const [, href] of body.matchAll(/\]\(([^)\s]*#[^)\s]*)\)/g)) {
        if (href === undefined) continue
        const resolved = resolveHref(file, href, (f) => files.includes(f))
        if (!resolved.startsWith('#') && !resolved.startsWith('/docs/')) continue
        const [route = '', anchor = ''] = resolved.split('#', 2)
        if (route === '/docs/events/') {
          if (!eventNames.has(anchor)) dangling.push(`${file} → ${href}`)
          continue
        }
        // `fileOf` back from the route, and not `${route}.md`: a directory's
        // `index.md` is served at the directory, so the arithmetic that assumed
        // one route per `.md` path would look for `plugins.md` and find nothing.
        const target = route === '' ? file : fileOf(route.slice('/docs/'.length).replace(/\/$/, ''))
        if (target === null || headings.get(target)?.has(anchor) !== true) {
          dangling.push(`${file} → ${href}`)
        }
      }
    }
    expect(dangling, 'an anchor in doc/ lands nowhere on the site').toEqual([])
  })
})

describe("what a decision's page says about it", () => {
  it('takes the date from the file, and every decision states one', async () => {
    expect(decidedOn('# 0016\n\n**Status** accepted · 2026-09-02 · supersedes')).toBe('2026-09-02')
    expect(decidedOn('# A guide\n\nno date here')).toBeNull()

    const undated: string[] = []
    for (const file of (await published()).filter((f) => f.startsWith('decisions/'))) {
      if (decidedOn(await readFile(path.join(docRoot, file), 'utf8')) === null) undated.push(file)
    }
    expect(undated, 'a decision that does not say when it was made').toEqual([])
  })

  it('makes the decision a status names a link to it', async () => {
    const numbers = await decisionsByNumber()
    expect(numbers.get('0103')).toBe('decisions/0103-a-pass-is-ten-fixed-steps')

    const parts = statusParts('see 0103', (n) => {
      const slug = numbers.get(n)
      return slug === undefined ? null : `/docs/${slug}/`
    })
    expect(parts).toEqual([{ text: 'see ' }, { text: '0103', href: '/docs/decisions/0103-a-pass-is-ten-fixed-steps/' }])
  })

  it('leaves a number that is not a decision as text', () => {
    expect(statusParts('accepted 2026', () => null)).toEqual([{ text: 'accepted ' }, { text: '2026' }])
  })

  it("carries the repository's sentence and does not restate it", async () => {
    const status = await statuses()
    expect(status.get('decisions/0100-one-append-only-log')).toBe('accepted')
    expect(status.get('decisions/0103-a-pass-is-ten-fixed-steps')).toBe('accepted; part not yet built')
  })
})

describe('treeOf', () => {
  it('lists Events in the guides group straight after CLI, and once', async () => {
    const tree = await treeOf()
    const guides = tree.find((group) => group.id === 'guides')
    expect(guides).toBeDefined()
    const slugs = guides!.entries.map((entry) => entry.slug)
    const at = slugs.indexOf('cli')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(guides!.entries[at + 1]).toEqual({ slug: 'events', title: 'Events' })
    expect(tree.flatMap((group) => group.entries).filter((entry) => entry.slug === 'events')).toHaveLength(1)
  })

  it('keeps every sidebar title to three words, so no entry wraps at 13rem', async () => {
    const titles = (await treeOf()).flatMap((group) => group.entries.map((entry) => entry.title))
    for (const title of titles) expect(title.split(/\s+/).length, title).toBeLessThanOrEqual(3)
  })
})

describe('short titles with the old title as a subtitle', () => {
  const SHORT: Record<string, string> = {
    'tutorial.md': 'Tutorial',
    'concepts.md': 'Concepts',
    'recipe.md': 'Recipe',
    'cli.md': 'CLI',
    'requirements.md': 'Requirements',
    'safety.md': 'Safety',
    'why.md': 'Why Lingtai',
  }
  for (const [file, short] of Object.entries(SHORT)) {
    it(`${file}: titled ${short}, and its lede is not the subtitle`, async () => {
      const body = await readFile(path.join(docRoot, file), 'utf8')
      expect(titleOf(body, file)).toBe(short)
      const subtitle = body.split('\n')[2]!
      expect(subtitle).toMatch(/^\*[^*].*\*$/)
      const lede = ledeOf(body)
      expect(lede).not.toBe('')
      expect(lede).not.toBe(subtitle.slice(1, -1))
    })
  }
})
