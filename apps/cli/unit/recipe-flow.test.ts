/**
 * `askRecipe` (#432): an absent file is created once, with every first-run
 * answer, the caller's seeds, and a comment above each block named in
 * `SAID`. An existing file is still edited one answer at a time, and its own
 * comments are not rewritten. No filesystem — the file seam is a `Map`, by
 * 0060 §1.
 */
import { type RecipeFiles, recipePath, resolveSource } from '@lingtai/recipe'
import { describe, expect, it } from 'vitest'
import { isMap, isScalar, parseDocument, type Node, type YAMLMap } from 'yaml'

import { EMPTY_SETUP_READER } from '../src/detect-setup.ts'
import type { QuestionWorld } from '../src/question.ts'
import { askRecipe, ENV_PLANT_AT, SAID, type RecipeAt } from '../src/recipe-flow.ts'
import type { RuntimeFound } from '../src/runtimes.ts'

const HOME = '/home/me/.lingtai'

interface RecordingFiles extends RecipeFiles {
  replaced: { path: string; text: string }[]
}

function mapFiles(initial: Record<string, string> = {}): RecordingFiles {
  const store = new Map(Object.entries(initial))
  const replaced: { path: string; text: string }[] = []
  return {
    replaced,
    read: async (path) => store.get(path) ?? null,
    replace: async (path, text) => {
      replaced.push({ path, text })
      store.set(path, text)
    },
  }
}

const ONE_RUNTIME: readonly RuntimeFound[] = [
  { id: 'claude-code', installed: true, signedIn: true, detail: 'signed in' },
]

/** A `QuestionWorld` that answers every question with its own default. */
function defaultsWorld(): QuestionWorld & { logged: string[] } {
  const logged: string[] = []
  return { ask: async () => '', log: (line) => logged.push(line), logged }
}

/** The dotted-path comment `emitRecipe` puts above a block — `''` if there is none. */
function commentAbove(text: string, dotted: string): string {
  const doc = parseDocument(text)
  const path = dotted.split('.')
  const parent = (path.length === 1 ? doc.contents : doc.getIn(path.slice(0, -1), true)) as YAMLMap
  if (!isMap(parent)) return ''
  const pair = parent.items.find((p) => isScalar(p.key) && p.key.value === path[path.length - 1])
  if (!pair) return ''
  const comment = (pair.key as Node).commentBefore ?? (parent.items[0] === pair ? parent.commentBefore : '') ?? ''
  return comment.replace(/\s+/g, ' ').trim()
}

const BASE_AT = {
  runtimes: ONE_RUNTIME,
  reader: EMPTY_SETUP_READER,
  flags: { install: 'none' },
  buildFlags: ['none'] as readonly string[],
  defaultBranch: async () => null,
  history: async () => [] as readonly string[],
  home: HOME,
}

describe('askRecipe — an absent file (#432)', () => {
  it('creates a local project once, with every first-run answer and a SAID comment above each block', async () => {
    const files = mapFiles()
    const world = defaultsWorld()
    const seeds = [
      { path: ['repo', 'base'], value: 'main' },
      { path: ['repo', 'remote'], value: 'https://github.com/acme/widget.git' },
      { path: ['env', 'plantAt'], value: ENV_PLANT_AT },
    ]

    const result = await askRecipe(world, {
      ...BASE_AT,
      project: 'widget',
      local: true,
      seeds,
      kept: 'the seeded recipe is kept',
      keptBeforeWrite: 'Nothing was written',
      files,
    } satisfies RecipeAt)

    expect(result).toEqual({ ok: true })
    expect(files.replaced).toHaveLength(1)

    const path = recipePath('widget', HOME)
    const text = files.replaced[0]!.text
    const resolved = resolveSource(text, path, path).recipe
    expect(resolved.repo.base).toBe('main')
    expect(resolved.repo.remote).toBe('https://github.com/acme/widget.git')
    expect(resolved.env.plantAt).toBe(ENV_PLANT_AT)
    expect(resolved.source.tickets).toBe('db')
    expect(resolved.source.kinds).toEqual(['bug', 'feature', 'documentation'])
    expect(resolved.runtime.agent).toBe('claude-code')

    // `steps.proposed` and `runtime.limits` are not yet decided at the point
    // this write happens — `askLanding`/`askLimits` have not asked — so they
    // alone may carry no comment; every other block does (#432 fix round,
    // finding 2).
    for (const [dotted, sentence] of Object.entries(SAID)) {
      const comment = commentAbove(text, dotted)
      if (comment === '') expect(['steps.proposed', 'runtime.limits'], dotted).toContain(dotted)
      else expect(comment, dotted).toBe(sentence)
    }

    // The file carries only what was asked — no schema or plugin-schema
    // default spelled out as though it had been chosen (#432 fix round,
    // finding 2's own failure scenario).
    const doc = parseDocument(text)
    expect(doc.getIn(['runtime', 'limits'])).toBeUndefined()
    expect(doc.getIn(['runtime', 'tier'])).toBeUndefined()
    expect(doc.getIn(['runtime', 'budget'])).toBeUndefined()
    expect(doc.getIn(['discuss'])).toBeUndefined()
    expect(doc.getIn(['source', 'backoff'])).toBeUndefined()
    expect(doc.getIn(['repo', 'submodules'])).toBeUndefined()
    expect(doc.getIn(['env', 'deny'])).toBeUndefined()
    expect(doc.getIn(['env', 'required'])).toBeUndefined()
    expect(doc.getIn(['env', 'refuseHosts'])).toBeUndefined()
    expect(doc.getIn(['steps', 'proposed'])).toBeUndefined()
  })

  it('creates a GitHub project once, falling back to source.tickets: github when the question took its own default', async () => {
    const files = mapFiles()
    const world = defaultsWorld()
    const seeds = [
      { path: ['repo', 'base'], value: 'main' },
      { path: ['env', 'plantAt'], value: ENV_PLANT_AT },
    ]

    const result = await askRecipe(world, {
      ...BASE_AT,
      project: 'widget',
      local: false,
      seeds,
      kept: 'the seeded recipe is kept',
      keptBeforeWrite: 'Nothing was written',
      files,
    } satisfies RecipeAt)

    expect(result).toEqual({ ok: true })
    expect(files.replaced).toHaveLength(1)

    const path = recipePath('widget', HOME)
    const text = files.replaced[0]!.text
    const resolved = resolveSource(text, path, path).recipe
    expect(resolved.source.tickets).toBe('github')
  })
})

describe('askRecipe — an existing file (#432)', () => {
  const FIXTURE = `version: 2
repo:
  base: main
  remote: https://github.com/acme/widget.git
# a note somebody left here
source:
  kinds: [bug]
  tickets: github
env:
  plantAt: .env.local
runtime:
  agent: claude-code
steps:
  implement:
    - name: write the change
      agent: claude-code
      prompt: ''
  review: []
`

  it('is still written one answer at a time, and the hand-written comment is not touched', async () => {
    const path = recipePath('widget', HOME)
    const files = mapFiles({ [path]: FIXTURE })
    const world = defaultsWorld()

    const result = await askRecipe(world, {
      ...BASE_AT,
      project: 'widget',
      local: false,
      seeds: [],
      flags: { ...BASE_AT.flags, kinds: 'bug,feature' },
      kept: 'Nothing was written',
      keptBeforeWrite: 'Nothing was written',
      files,
    } satisfies RecipeAt)

    expect(result).toEqual({ ok: true })
    // Only `source.kinds` differs from the fixture — every other question
    // took the file's own current answer, and `setRecipe` writes nothing
    // when a change sets the value already there (`write.ts`'s own rule).
    expect(files.replaced).toHaveLength(1)

    const text = files.replaced[0]!.text
    expect(text).toContain('# a note somebody left here')
    const resolved = resolveSource(text, path, path).recipe
    expect(resolved.source.kinds).toEqual(['bug', 'feature'])

    // No `SAID` sentence was inserted — this file already existed.
    for (const dotted of Object.keys(SAID)) {
      expect(commentAbove(text, dotted), dotted).not.toBe(SAID[dotted])
    }
  })
})

describe('askRecipe — --defaults (#433)', () => {
  const TWO_RUNTIMES: readonly RuntimeFound[] = [
    { id: 'claude-code', installed: true, signedIn: true, detail: 'signed in' },
    { id: 'codex', installed: true, signedIn: true, detail: 'signed in' },
  ]

  it('asks no recipe question, and a flag given beside it still wins', async () => {
    const files = mapFiles()
    const asked: string[] = []
    const world: QuestionWorld = {
      ask: async (prompt) => {
        asked.push(prompt)
        throw new Error(`a terminal was asked: ${prompt}`)
      },
      log: () => {},
    }
    const seeds = [
      { path: ['repo', 'base'], value: 'main' },
      { path: ['repo', 'remote'], value: 'https://github.com/acme/widget.git' },
      { path: ['env', 'plantAt'], value: ENV_PLANT_AT },
    ]

    const result = await askRecipe(world, {
      ...BASE_AT,
      project: 'widget',
      local: true,
      flags: { ...BASE_AT.flags, defaults: '', rounds: '5' },
      seeds,
      kept: 'the seeded recipe is kept',
      keptBeforeWrite: 'Nothing was written',
      files,
    } satisfies RecipeAt)

    expect(result).toEqual({ ok: true })
    expect(asked).toEqual([])

    const path = recipePath('widget', HOME)
    const text = files.replaced.at(-1)!.text
    const resolved = resolveSource(text, path, path).recipe
    expect(resolved.runtime.limits.rounds).toBe(5)
  })

  it('a default that fails validation refuses by name rather than looping', async () => {
    const files = mapFiles()
    const world: QuestionWorld = {
      ask: async (prompt) => {
        throw new Error(`a terminal was asked: ${prompt}`)
      },
      log: () => {},
    }
    const seeds = [
      { path: ['repo', 'base'], value: 'main' },
      { path: ['repo', 'remote'], value: 'https://github.com/acme/widget.git' },
      { path: ['env', 'plantAt'], value: ENV_PLANT_AT },
    ]

    const result = await askRecipe(world, {
      ...BASE_AT,
      runtimes: TWO_RUNTIMES,
      project: 'widget',
      local: true,
      flags: { ...BASE_AT.flags, defaults: '' },
      seeds,
      kept: 'the seeded recipe is kept',
      keptBeforeWrite: 'Nothing was written',
      files,
    } satisfies RecipeAt)

    expect(result).toEqual({
      refused: 'which agent writes the change needs an answer: pass --agent <claude-code, codex>. Nothing was written',
    })
    expect(files.replaced).toHaveLength(0)
  })

  it('with no terminal and no --defaults, the run refuses and names --defaults', async () => {
    const files = mapFiles()
    const world: QuestionWorld = { ask: async () => null, log: () => {} }
    const seeds = [
      { path: ['repo', 'base'], value: 'main' },
      { path: ['repo', 'remote'], value: 'https://github.com/acme/widget.git' },
      { path: ['env', 'plantAt'], value: ENV_PLANT_AT },
    ]

    const result = await askRecipe(world, {
      ...BASE_AT,
      project: 'widget',
      local: true,
      seeds,
      kept: 'the seeded recipe is kept',
      keptBeforeWrite: 'Nothing was written',
      files,
    } satisfies RecipeAt)

    expect(result).toEqual({ refused: 'every default needs an answer: pass --defaults. Nothing was written' })
    expect(files.replaced).toHaveLength(0)
  })
})
