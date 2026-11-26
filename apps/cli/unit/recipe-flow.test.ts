import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { recipePath, ProjectFiles } from '@lingtai/project'
/**
 * `askRecipe` (#432): an absent file is created once, with every first-run
 * answer, the caller's seeds, and a comment above each block named in
 * `SAID`. An existing file is still edited one answer at a time, and its own
 * comments are not rewritten. No filesystem — the file seam is a `Map`, by
 * 0060 §1.
 */
import { type RecipeFiles, resolveSource, SETUP_HOLD_TEXT } from '@lingtai/recipe'
import { applySetup, EMPTY_SETUP_READER } from '@lingtai/setup'
import type { RuntimeFound } from '@lingtai/setup'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { isMap, isScalar, parseDocument, type Node, type YAMLMap } from 'yaml'

import type { QuestionWorld } from '../src/question.ts'
import { askRecipeEffect, changedLeftBehind, ENV_PLANT_AT, SAID, type RecipeAt } from '../src/recipe-flow.ts'

/** A test hands its seeded port in beside the question's options; it is provided, never passed (0128 §7). */
type TestAt = RecipeAt & { files: RecipeFiles }
const askRecipe = (world: QuestionWorld, { files, ...at }: TestAt) =>
  Effect.runPromise(askRecipeEffect(world, at).pipe(Effect.provideService(ProjectFiles, files)))

const HOME = '/home/me/.lingtai'

/** `askRecipe` writes nothing (#968): the answers it returns are written by `applySetup`, as `lingtai add` does. */
async function askAndWrite(world: QuestionWorld, at: TestAt): Promise<Awaited<ReturnType<typeof askRecipe>>> {
  const result = await askRecipe(world, at)
  if ('ok' in result) {
    await Effect.runPromise(
      applySetup(
        { home: at.home ?? HOME, by: 'human:me', store: createMemoryEventStore() },
        result.answers,
        Effect.void,
      ).pipe(Effect.provideService(ProjectFiles, at.files)),
    )
  }
  return result
}

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
  { id: 'claude-code', state: 'signed-in', signedIn: true, detail: 'signed in' },
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
  flags: { install: 'none', mode: 'solo' },
  buildFlags: ['none'] as readonly string[],
  defaultBranch: async () => null,
  history: async () => [] as readonly string[],
  home: HOME,
}

describe('askRecipe — an absent file (#432)', () => {
  it('prints no group heading before any question (#753)', async () => {
    const world = defaultsWorld()

    await askAndWrite(world, {
      ...BASE_AT,
      project: 'widget',
      local: true,
      seeds: [
        { path: ['branch', 'main'], value: 'main' },
        { path: ['repo', 'remote'], value: 'https://github.com/acme/widget.git' },
        { path: ['env', 'plantAt'], value: ENV_PLANT_AT },
      ],
      kept: 'the seeded recipe is kept',
      again: 'lingtai add --local /repo',
      keptBeforeWrite: 'Nothing was written',
      files: mapFiles(),
    } satisfies TestAt)

    const headings = new Set(Object.values(SAID))
    expect(world.logged.filter((line) => [...headings].some((h) => line.includes(h)))).toEqual([])
  })

  it('creates a local project once, with every first-run answer and a SAID comment above each block', async () => {
    const files = mapFiles()
    const world = defaultsWorld()
    const seeds = [
      { path: ['branch', 'main'], value: 'main' },
      { path: ['repo', 'remote'], value: 'https://github.com/acme/widget.git' },
      { path: ['env', 'plantAt'], value: ENV_PLANT_AT },
    ]

    const result = await askAndWrite(world, {
      ...BASE_AT,
      project: 'widget',
      local: true,
      seeds,
      kept: 'the seeded recipe is kept',
      again: 'lingtai add --local /repo',
      keptBeforeWrite: 'Nothing was written',
      files,
    } satisfies TestAt)

    expect(result).toMatchObject({ ok: true })
    expect(files.replaced).toHaveLength(1)

    const path = recipePath('widget', HOME)
    const text = files.replaced[0]!.text
    const resolved = resolveSource(text, path, path).recipe
    expect(resolved.branch.main).toBe('main')
    expect(resolved.repo?.remote).toBe('https://github.com/acme/widget.git')
    expect(resolved.env.plantAt).toBe(ENV_PLANT_AT)
    expect(resolved.source.tickets).toBe('db')
    expect(resolved.source.kinds).toEqual(['bug', 'feature', 'tech-debt', 'documentation'])
    expect(resolved.runtime.agent).toBe('claude-code')

    // `steps.proposed` and `runtime.limits` are not yet decided at the point
    // this write happens — `askLanding`/`askLimits` have not asked — so they
    // alone may carry no comment; every other block does (#432 fix round,
    // finding 2). `steps.end` is decided only on the GitHub path (#749); the
    // local path seeds none, so it has no block to comment.
    for (const [dotted, sentence] of Object.entries(SAID)) {
      const comment = commentAbove(text, dotted)
      // `sandbox` is asked only where the caller read the host (#1160), which this test does not.
      if (comment === '')
        expect(['steps.end', 'steps.proposed', 'runtime.limits', 'sandbox', 'discuss'], dotted).toContain(dotted)
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
    // A new recipe declares the writer as its judge for `findings` (#1448), and no hold.
    expect((doc.getIn(['steps', 'proposed']) as { toJSON(): unknown }).toJSON()).toEqual([
      { name: 'send findings back to the writer', judge: doc.getIn(['runtime', 'agent']), when: 'findings' },
    ])
  })

  it('--land hold on a new recipe writes the hold and then the findings judge, and the file resolves (#1490)', async () => {
    const files = mapFiles()
    const result = await askAndWrite(defaultsWorld(), {
      ...BASE_AT,
      project: 'widget',
      local: true,
      flags: { ...BASE_AT.flags, land: 'hold' },
      seeds: [
        { path: ['branch', 'main'], value: 'main' },
        { path: ['repo', 'remote'], value: 'https://github.com/acme/widget.git' },
        { path: ['env', 'plantAt'], value: ENV_PLANT_AT },
      ],
      kept: 'the seeded recipe is kept',
      again: 'lingtai add --local /repo',
      keptBeforeWrite: 'Nothing was written',
      files,
    } satisfies TestAt)
    expect(result).toMatchObject({ ok: true })

    const path = recipePath('widget', HOME)
    const text = files.replaced.at(-1)!.text
    const raw = parseDocument(text).getIn(['steps', 'proposed']) as { toJSON(): unknown }
    expect(raw.toJSON()).toEqual([
      { name: 'hold every attempt', human: SETUP_HOLD_TEXT },
      { name: 'send findings back to the writer', judge: 'claude-code', when: 'findings' },
    ])
    expect(resolveSource(text, path, path).recipe.steps.proposed).toMatchObject([
      { human: SETUP_HOLD_TEXT },
      { judge: 'claude-code', when: 'findings' },
    ])
  })

  it('creates a GitHub project once, falling back to source.tickets: github when the question took its own default', async () => {
    const files = mapFiles()
    const world = defaultsWorld()
    const seeds = [
      { path: ['branch', 'main'], value: 'main' },
      { path: ['env', 'plantAt'], value: ENV_PLANT_AT },
    ]

    const result = await askAndWrite(world, {
      ...BASE_AT,
      project: 'widget',
      local: false,
      seeds,
      kept: 'the seeded recipe is kept',
      again: 'lingtai add --local /repo',
      keptBeforeWrite: 'Nothing was written',
      files,
    } satisfies TestAt)

    expect(result).toMatchObject({ ok: true })
    expect(files.replaced).toHaveLength(1)

    const path = recipePath('widget', HOME)
    const text = files.replaced[0]!.text
    const resolved = resolveSource(text, path, path).recipe
    expect(resolved.source.tickets).toBe('github')
  })
})

describe('askRecipe — an existing file (#432)', () => {
  const FIXTURE = `version: 2
branch:
  main: main
repo:
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

    const result = await askAndWrite(world, {
      ...BASE_AT,
      project: 'widget',
      local: false,
      seeds: [],
      flags: { ...BASE_AT.flags, kinds: 'bug,feature' },
      kept: 'Nothing was written',
      again: 'lingtai add --local /repo',
      keptBeforeWrite: 'Nothing was written',
      files,
    } satisfies TestAt)

    expect(result).toMatchObject({ ok: true })
    // Only `source.kinds` differs from the fixture — every other question
    // took the file's own current answer, and `setRecipe` writes nothing
    // when a change sets the value already there (`write.ts`'s own rule).
    expect(files.replaced).toHaveLength(1)

    const text = files.replaced[0]!.text
    expect(text).toContain('# a note somebody left here')
    const resolved = resolveSource(text, path, path).recipe
    expect(resolved.source.kinds).toEqual(['bug', 'feature'])

    // A recipe already on disk gets no findings judge added (#1490).
    expect(parseDocument(text).getIn(['steps', 'proposed'])).toBeUndefined()

    // No `SAID` sentence was inserted — this file already existed.
    for (const dotted of Object.keys(SAID)) {
      expect(commentAbove(text, dotted), dotted).not.toBe(SAID[dotted])
    }
  })
})

describe('askRecipe — --defaults (#433)', () => {
  const TWO_RUNTIMES: readonly RuntimeFound[] = [
    { id: 'claude-code', state: 'signed-in', signedIn: true, detail: 'signed in' },
    { id: 'codex', state: 'signed-in', signedIn: true, detail: 'signed in' },
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
      { path: ['branch', 'main'], value: 'main' },
      { path: ['repo', 'remote'], value: 'https://github.com/acme/widget.git' },
      { path: ['env', 'plantAt'], value: ENV_PLANT_AT },
    ]

    const result = await askAndWrite(world, {
      ...BASE_AT,
      project: 'widget',
      local: true,
      flags: { ...BASE_AT.flags, defaults: '', mode: 'solo', 'refusal-fixes': '5' },
      seeds,
      kept: 'the seeded recipe is kept',
      again: 'lingtai add --local /repo',
      keptBeforeWrite: 'Nothing was written',
      files,
    } satisfies TestAt)

    expect(result).toMatchObject({ ok: true })
    expect(asked).toEqual([])

    const path = recipePath('widget', HOME)
    const text = files.replaced.at(-1)!.text
    const resolved = resolveSource(text, path, path).recipe
    expect(resolved.runtime.limits.attempt.refusalFixes).toBe(5)
  })

  const SEEDS = [
    { path: ['branch', 'main'], value: 'main' },
    { path: ['repo', 'remote'], value: 'https://github.com/acme/widget.git' },
    { path: ['env', 'plantAt'], value: ENV_PLANT_AT },
  ]

  /** Two runtimes signed in, no recipe: the writer is claude-code and the reviewer codex (#727). */
  async function runTwo(
    runtimes: readonly RuntimeFound[],
    world: QuestionWorld,
    flags: Record<string, string>,
    files = mapFiles(),
  ) {
    const path = recipePath('widget', HOME)
    const before = (await files.read(path)) ?? ''
    const result = await askAndWrite(world, {
      ...BASE_AT,
      runtimes,
      project: 'widget',
      local: false,
      flags: { ...BASE_AT.flags, ...flags },
      seeds: SEEDS,
      kept: 'the seeded recipe is kept',
      again: 'lingtai add --local /repo',
      keptBeforeWrite: 'Nothing was written',
      files,
    } satisfies TestAt)
    const text = files.replaced.at(-1)?.text ?? before
    return { result, files, text, resolved: text === '' ? null : resolveSource(text, path, path).recipe }
  }

  const NO_TERMINAL: QuestionWorld = {
    ask: async (prompt) => {
      throw new Error(`a terminal was asked: ${prompt}`)
    },
    log: () => {},
  }

  it('with two runtimes signed in, --defaults writes claude-code as the writer and codex as the reviewer (#727)', async () => {
    const { result, text, resolved } = await runTwo(TWO_RUNTIMES, NO_TERMINAL, { defaults: '', mode: 'solo' })
    expect(result).toMatchObject({ ok: true })
    expect(resolved!.runtime.agent).toBe('claude-code')
    expect(text).toMatch(/agent: codex/)
  })

  it('the writer is the enum-first runtime however the runtimes are listed (#727)', async () => {
    const { result, resolved } = await runTwo([...TWO_RUNTIMES].reverse(), NO_TERMINAL, { defaults: '', mode: 'solo' })
    expect(result).toMatchObject({ ok: true })
    expect(resolved!.runtime.agent).toBe('claude-code')
  })

  it('a typed yes at "use every default?" still asks the branch first, and nothing after it (#1488)', async () => {
    const asked: string[] = []
    const world: QuestionWorld = {
      ask: async (prompt) => {
        asked.push(prompt)
        if (prompt.includes('use every default?')) return 'yes'
        if (prompt.includes('anyone else')) return 'solo'
        if (prompt.includes('governs and merges into')) return 'main'
        throw new Error(`a terminal was asked: ${prompt}`)
      },
      log: () => {},
    }
    const { result, resolved } = await runTwo(TWO_RUNTIMES, world, { land: 'main' })
    expect(result).toMatchObject({ ok: true })
    // The harness's `BASE_AT` decides the mode; the branch is asked, and only then the defaults.
    expect(asked, JSON.stringify(asked)).toHaveLength(2)
    expect(asked[0]).toContain('governs and merges into')
    expect(asked[1]).toContain('use every default?')
    expect(resolved!.runtime.agent).toBe('claude-code')
  })

  it('a recipe whose writer is codex keeps codex under --defaults (#727)', async () => {
    const first = await runTwo(TWO_RUNTIMES, NO_TERMINAL, { defaults: '', mode: 'solo', agent: 'codex' })
    expect(first.resolved!.runtime.agent).toBe('codex')
    // The judge follows the writer, never the reviewer (claude-code here) (#1490).
    const proposedOf = (text: string) =>
      (parseDocument(text).getIn(['steps', 'proposed']) as { toJSON(): unknown }).toJSON()
    expect(proposedOf(first.text)).toEqual([
      { name: 'send findings back to the writer', judge: 'codex', when: 'findings' },
    ])
    expect(first.resolved!.steps.proposed).toMatchObject([{ judge: 'codex', when: 'findings' }])
    const path = recipePath('widget', HOME)
    const files = mapFiles({ [path]: first.text })
    const again = await runTwo(TWO_RUNTIMES, NO_TERMINAL, { defaults: '', mode: 'solo' }, files)
    expect(again.result).toMatchObject({ ok: true })
    expect(again.resolved!.runtime.agent).toBe('codex')
    // A rerun on the file the first run wrote still holds exactly one findings judge.
    expect(proposedOf(again.text)).toEqual([
      { name: 'send findings back to the writer', judge: 'codex', when: 'findings' },
    ])
  })

  // A CI job with no TTY and no --defaults is not asked "use every default?"
  // either — `given` for that question is null exactly when `--defaults` is
  // not on the command line, and with no terminal `world.ask` would return
  // null for it the same as for any other question. Blocking the run there
  // would refuse a run every other flag already answers in full, and would
  // reroute a refusal that belongs to one specific missing flag through
  // "every default" instead, silently taking every other default along with
  // it (#433 fix round, findings 1 and 2).
  const FULLY_FLAGGED = {
    mode: 'solo',
    main: 'main',
    agent: 'claude-code',
    model: '',
    reviewer: 'none',
    install: 'none',
    tickets: 'github',
    kinds: 'bug',
    land: 'main',
    'refusal-fixes': '3',
    'conflict-resolutions': '3',
    wall: '1h',
    budget: '5',
  }

  it('with no terminal and no --defaults, but every question already answered by a flag, the run succeeds without being asked anything beyond "every default?" itself (#433 fix round, finding 1)', async () => {
    const files = mapFiles()
    const asked: string[] = []
    // The real no-TTY `ask` (`question.ts`'s `liveAsk`) answers null without
    // ever printing a prompt — unlike a terminal's own `ask`, calling it is
    // not itself "asking the operator anything". "Every default?" still
    // calls it once, harmlessly; a world that threw on any *other* call would
    // prove no later recipe question reaches it.
    const world: QuestionWorld = {
      ask: async (prompt) => {
        asked.push(prompt)
        if (asked.length === 1) return null
        throw new Error(`a terminal was asked: ${prompt}`)
      },
      log: () => {},
    }
    const seeds = [
      { path: ['branch', 'main'], value: 'main' },
      { path: ['env', 'plantAt'], value: ENV_PLANT_AT },
    ]

    const result = await askAndWrite(world, {
      ...BASE_AT,
      project: 'widget',
      local: false,
      flags: FULLY_FLAGGED,
      seeds,
      kept: 'the seeded recipe is kept',
      again: 'lingtai add --local /repo',
      keptBeforeWrite: 'Nothing was written',
      files,
    } satisfies TestAt)

    expect(result).toMatchObject({ ok: true })
    expect(asked).toEqual(['use every default? [yes]: '])

    const path = recipePath('widget', HOME)
    const text = files.replaced.at(-1)!.text
    const resolved = resolveSource(text, path, path).recipe
    expect(resolved.runtime.limits.attempt.refusalFixes).toBe(3)
    expect(resolved.source.kinds).toEqual(['bug'])
  })

  it('with no terminal and no --defaults, a question whose own flag is missing refuses by its own name, not "every default" (#433 fix round, finding 2)', async () => {
    const files = mapFiles()
    const world: QuestionWorld = { ask: async () => null, log: () => {} }
    const { kinds: _omitted, ...withoutKinds } = FULLY_FLAGGED
    const seeds = [
      { path: ['branch', 'main'], value: 'main' },
      { path: ['env', 'plantAt'], value: ENV_PLANT_AT },
    ]

    const result = await askAndWrite(world, {
      ...BASE_AT,
      project: 'widget',
      local: false,
      flags: withoutKinds,
      seeds,
      kept: 'the seeded recipe is kept',
      again: 'lingtai add --local /repo',
      keptBeforeWrite: 'Nothing was written',
      files,
    } satisfies TestAt)

    expect(result).toEqual({ refused: 'the kinds needs an answer: pass --kinds <a,b,c>. Nothing was written' })
    expect(files.replaced).toHaveLength(0)
  })
})

describe('askRecipe — the trial run (#436)', () => {
  const run = async (flags: Record<string, string>) => {
    const calls: string[][] = []
    const result = await askAndWrite(defaultsWorld(), {
      ...BASE_AT,
      project: 'widget',
      local: true,
      flags: { install: 'none', mode: 'solo', ...flags },
      buildFlags: ['pnpm test'],
      seeds: [
        { path: ['branch', 'main'], value: 'main' },
        { path: ['env', 'plantAt'], value: ENV_PLANT_AT },
      ],
      kept: 'kept',
      again: 'lingtai add --local /repo',
      keptBeforeWrite: 'Nothing was written',
      files: mapFiles(),
      tryBuild: {
        base: Effect.succeed('main'),
        run: (_install, build) =>
          Effect.sync(() => {
            calls.push(build)
            return {
              results: [{ command: 'pnpm test', outcome: 'passed' as const, evidence: '' }],
              nothingDeclared: false,
            }
          }),
      },
    } satisfies TestAt)
    return { result, calls }
  }

  it('does not run under --defaults', async () => {
    const { result, calls } = await run({ defaults: '', mode: 'solo' })
    expect(result).toMatchObject({ ok: true })
    expect(calls).toEqual([])
  })

  it('runs under --defaults --check-build yes, and tells the caller how it went', async () => {
    const { calls, result } = await run({ defaults: '', mode: 'solo', 'check-build': 'yes' })
    expect(calls).toEqual([['pnpm test']])
    expect(result).toMatchObject({ ok: true, trial: { trial: 'passed' } })
  })

  it('tells the caller a declined trial was not run', async () => {
    const { result } = await run({ 'check-build': 'no' })
    expect(result).toMatchObject({ trial: { trial: 'not-run', because: 'declined' } })
  })

  it('skips --check-build no without asking', async () => {
    const { calls } = await run({ 'check-build': 'no' })
    expect(calls).toEqual([])
  })

  describe('a kept failed list says it is written only once it is', () => {
    const failing = {
      base: Effect.succeed('main'),
      run: () =>
        Effect.succeed({
          results: [{ command: 'pnpm test', outcome: 'failed' as const, evidence: 'boom' }],
          nothingDeclared: false,
        }),
    }
    const go = async (stopAfterKeep: boolean) => {
      let kept = false
      const logged: string[] = []
      const files = mapFiles()
      const result = await askAndWrite(
        {
          ask: async (prompt) => {
            if (kept && stopAfterKeep) return null
            if (prompt.includes('use every default?')) return 'no'
            if (prompt.includes('keep the list as it is')) {
              kept = true
              return 'keep'
            }
            return ''
          },
          log: (line) => logged.push(line),
        },
        {
          ...BASE_AT,
          project: 'widget',
          local: true,
          flags: { install: 'none', mode: 'solo', 'check-build': 'yes' },
          buildFlags: ['pnpm test'],
          seeds: [
            { path: ['branch', 'main'], value: 'main' },
            { path: ['env', 'plantAt'], value: ENV_PLANT_AT },
          ],
          kept: 'kept',
          again: 'lingtai add --local /repo',
          keptBeforeWrite: 'Nothing was written',
          files,
          tryBuild: failing,
        } satisfies TestAt,
      )
      return { result, logged, files }
    }

    it('does not say it when a later question ends the command before the write', async () => {
      const { result, logged, files } = await go(true)
      expect(result).toHaveProperty('refused')
      expect(files.replaced).toHaveLength(0)
      expect(logged.some((l) => l.includes('kept the list as tried'))).toBe(false)
    })

    it('says it after the write', async () => {
      const { result, logged } = await go(false)
      expect(result).toMatchObject({ ok: true, trial: { trial: 'failed-kept' } })
      expect(logged.some((l) => l.includes('kept the list as tried') && l.includes(recipePath('widget', HOME)))).toBe(
        true,
      )
    })
  })
})

describe('askRecipe — a draft, never a write (#1182)', () => {
  it('a whole run writes nothing to the port, on an absent file and on an existing one', async () => {
    const absent = mapFiles()
    const first = await askRecipe(defaultsWorld(), {
      ...BASE_AT,
      project: 'widget',
      local: true,
      seeds: [
        { path: ['branch', 'main'], value: 'main' },
        { path: ['repo', 'remote'], value: 'https://github.com/acme/widget.git' },
        { path: ['env', 'plantAt'], value: ENV_PLANT_AT },
      ],
      kept: 'k',
      again: 'a',
      keptBeforeWrite: 'Nothing was written',
      files: absent,
    } satisfies TestAt)
    expect(first).toMatchObject({ ok: true })
    expect(absent.replaced).toEqual([])

    const path = recipePath('widget', HOME)
    const existing = mapFiles({
      [path]: 'version: 2\nbranch:\n  main: main\nsource:\n  kinds: [bug]\nenv:\n  plantAt: .env.local\n',
    })
    const second = await askRecipe(defaultsWorld(), {
      ...BASE_AT,
      project: 'widget',
      local: true,
      seeds: [],
      kept: 'k',
      again: 'a',
      keptBeforeWrite: 'Nothing was written',
      files: existing,
    } satisfies TestAt)
    expect(second).toMatchObject({ ok: true })
    expect(existing.replaced).toEqual([])
  })
})

describe('askRecipe — the discuss agent of a new recipe (#1476)', () => {
  const CODEX_ONLY: readonly RuntimeFound[] = [
    { id: 'claude-code', state: 'signed-out', signedIn: false, detail: 'token expired' },
    { id: 'codex', state: 'signed-in', signedIn: true, detail: 'signed in' },
  ]
  const written = async (runtimes: readonly RuntimeFound[], codexText: RecipeAt['codexText']) => {
    const files = mapFiles()
    const result = await askAndWrite(defaultsWorld(), {
      ...BASE_AT,
      runtimes,
      codexText,
      project: 'widget',
      local: true,
      flags: { ...BASE_AT.flags, defaults: '' },
      seeds: [
        { path: ['branch', 'main'], value: 'main' },
        { path: ['repo', 'remote'], value: 'https://github.com/acme/widget.git' },
        { path: ['env', 'plantAt'], value: ENV_PLANT_AT },
      ],
      kept: 'kept',
      again: 'lingtai add --local /repo',
      keptBeforeWrite: 'Nothing was written',
      files,
    } satisfies TestAt)
    expect(result).toMatchObject({ ok: true })
    return parseDocument(files.replaced.at(-1)!.text)
  }

  it('claude-code signed out with codex_text: discuss.agent is codex, and no model is written', async () => {
    const doc = await written(CODEX_ONLY, () => ({ model: 'gpt-x' }) as never)
    expect(doc.getIn(['discuss', 'agent'])).toBe('codex')
    expect(doc.getIn(['discuss', 'model'])).toBeUndefined()
  })

  it('claude-code signed out without codex_text, or with an unreadable one: no discuss block', async () => {
    expect((await written(CODEX_ONLY, () => undefined)).has('discuss')).toBe(false)
    const unreadable = () => {
      throw new Error('unreadable')
    }
    expect((await written(CODEX_ONLY, unreadable)).has('discuss')).toBe(false)
  })

  it('claude-code signed in: no discuss block, whatever codex_text says', async () => {
    const both: readonly RuntimeFound[] = [
      { id: 'claude-code', state: 'signed-in', signedIn: true, detail: 'signed in' },
      { id: 'codex', state: 'signed-in', signedIn: true, detail: 'signed in' },
    ]
    expect((await written(both, () => ({ model: 'gpt-x' }) as never)).has('discuss')).toBe(false)
  })
})

describe('askRecipe — a GitHub rerun asks what the first run asks (#1474)', () => {
  const project = 'widget'
  const path = recipePath(project, HOME)
  const seeds = [
    { path: ['branch', 'main'], value: 'main' },
    { path: ['repo', 'remote'], value: 'https://github.com/acme/widget.git' },
    { path: ['env', 'plantAt'], value: ENV_PLANT_AT },
  ]

  /** Answers "use every default?" no, so every question is asked; `mode` and the sandbox are answered, the rest default. */
  function answerer(mode: 'team' | 'solo', over: (prompt: string) => string | undefined = () => undefined) {
    const prompts: string[] = []
    const world: QuestionWorld = {
      ask: async (prompt) => {
        prompts.push(prompt)
        if (prompt.includes('use every default')) return 'no'
        if (prompt.includes('Does anyone else')) return mode
        if (prompt.includes('in the sandbox')) return 'on'
        return over(prompt) ?? ''
      },
      log: () => {},
    }
    return { world, prompts }
  }
  const bare = (prompts: string[]) => prompts.map((p) => p.replace(/ \[[^\]]*\]: $/, ''))
  const sandbox = { verdict: { can: true }, install: null, builtIns: ['api.example.com'] } as never
  const at = (files: RecipeFiles, existing: Set<string>) =>
    ({
      ...BASE_AT,
      flags: { install: 'none' },
      project,
      local: false,
      seeds,
      kept: 'kept',
      again: 'lingtai add acme/widget',
      keptBeforeWrite: 'Nothing was written',
      defaultBranch: async () => 'main',
      proposal: { sandbox, kinds: { known: false }, detected: { known: false } } as never,
      team: {
        knownLogin: 'me',
        hostname: () => 'laptop',
        branchExists: (name: string) => Effect.succeed(existing.has(name)),
      },
      files,
    }) satisfies TestAt

  it('asks the same questions, in the same order, over an existing recipe as over an absent one', async () => {
    const files = mapFiles()
    const first = answerer('team')
    const made = await askAndWrite(first.world, at(files, new Set(['me/laptop'])))
    expect(made).toMatchObject({ ok: true })
    const second = answerer('team')
    const again = await askAndWrite(second.world, at(files, new Set(['me/laptop'])))
    expect(again).toMatchObject({ ok: true })
    expect(bare(second.prompts).length).toBeGreaterThan(8)
    expect(bare(second.prompts)).toEqual(bare(first.prompts))
    for (const asked of ['Does anyone else', 'GitHub login', 'branch Lingtai works on', 'in the sandbox']) {
      if (asked === 'GitHub login') continue // known on this machine, so asked of neither run
      expect(bare(second.prompts).some((p) => p.includes(asked))).toBe(true)
    }
  })

  it('a typed yes at "use every default?" is asked after the mode and the personal branch, and answers neither (#1488)', async () => {
    const prompts: string[] = []
    const world: QuestionWorld = {
      ask: async (prompt) => {
        prompts.push(prompt)
        if (prompt.includes('use every default')) return 'yes'
        if (prompt.includes('Does anyone else')) return 'team'
        if (prompt.includes('branch Lingtai works on')) return 'me/chosen'
        throw new Error(`a terminal was asked after the defaults: ${prompt}`)
      },
      log: () => {},
    }
    const files = mapFiles()
    const result = await askAndWrite(world, at(files, new Set(['me/chosen'])))
    expect(result).toMatchObject({ ok: true })
    const asked = bare(prompts)
    expect(asked[0]).toContain('Does anyone else')
    expect(asked[1]).toContain('branch Lingtai works on')
    expect(asked[2]).toBe('use every default?')
    expect(asked).toHaveLength(3)
    expect(resolveSource(files.replaced.at(-1)!.text, path, path).recipe.branch.personal).toBe('me/chosen')
  })

  it('--defaults asks nothing and takes team and the personal branch by their defaults (#1488)', async () => {
    const files = mapFiles()
    const world: QuestionWorld = {
      ask: async (prompt) => {
        throw new Error(`a terminal was asked: ${prompt}`)
      },
      log: () => {},
    }
    const result = await askAndWrite(world, {
      ...at(files, new Set(['me/laptop'])),
      flags: { install: 'none', defaults: '' },
    })
    expect(result).toMatchObject({ ok: true })
    const recipe = resolveSource(files.replaced.at(-1)!.text, path, path).recipe
    expect(recipe.branch.personal).toBe('me/laptop')
    expect(recipe.mode).toBe('team')
  })

  it('team to solo writes mode: solo and drops the keys that are read only in team mode, and names the change', async () => {
    const files = mapFiles()
    await askAndWrite(answerer('team').world, at(files, new Set(['me/laptop'])))
    expect(files.replaced.at(-1)!.text).toMatch(/mode: team/)

    const solo = answerer('solo')
    const result = await askAndWrite(solo.world, at(files, new Set(['me/laptop'])))
    expect(result).toMatchObject({ ok: true, changed: { mode: { from: 'team', to: 'solo' } } })
    const text = files.replaced.at(-1)!.text
    const recipe = resolveSource(text, path, path).recipe
    expect(text).toMatch(/mode: solo/)
    expect(recipe.branch.personal).toBeUndefined()
  })

  it('a new personal branch is cut from the old one, which holds what landed and has not reached main', async () => {
    const files = mapFiles()
    await askAndWrite(answerer('team').world, at(files, new Set(['me/laptop'])))

    const next = answerer('team', (p) => (p.includes('branch Lingtai works on') ? 'me-next' : undefined))
    const result = await askAndWrite(next.world, at(files, new Set(['me/laptop'])))
    expect(result).toMatchObject({
      ok: true,
      make: { name: 'me-next', from: 'me/laptop' },
      changed: { branch: { from: 'me/laptop', to: 'me-next', made: true } },
    })
    expect(next.prompts.some((p) => p.includes('does not exist. Make it from origin/me/laptop'))).toBe(true)
  })

  it('a new personal branch that exists is used as it is, and nothing is made', async () => {
    const files = mapFiles()
    await askAndWrite(answerer('team').world, at(files, new Set(['me/laptop'])))
    const next = answerer('team', (p) => (p.includes('branch Lingtai works on') ? 'me-next' : undefined))
    const result = await askAndWrite(next.world, at(files, new Set(['me/laptop', 'me-next'])))
    expect(result).toMatchObject({ ok: true, changed: { branch: { from: 'me/laptop', to: 'me-next', made: false } } })
    expect(result).not.toHaveProperty('make')
  })

  it("a discovered login that is not the recipe's is asked, with the recipe's as the default, and one that is absent is asked too", async () => {
    const files = mapFiles()
    await askAndWrite(answerer('team', (p) => (p.includes('GitHub login') ? 'alice' : undefined)).world, {
      ...at(files, new Set(['me/laptop'])),
      team: { knownLogin: null, hostname: () => 'laptop', branchExists: () => Effect.succeed(true) },
    })
    expect(resolveSource(files.replaced.at(-1)!.text, path, path).recipe.source.assignee).toMatchObject({
      login: 'alice',
    })

    // Authenticated as bob: every default is taken, and the recipe keeps alice.
    const asked = answerer('team')
    await askAndWrite(asked.world, {
      ...at(files, new Set(['me/laptop'])),
      team: { knownLogin: 'bob', hostname: () => 'laptop', branchExists: () => Effect.succeed(true) },
    })
    expect(asked.prompts.some((p) => p.includes('GitHub login') && p.includes('[alice]'))).toBe(true)
    expect(resolveSource(files.replaced.at(-1)!.text, path, path).recipe.source.assignee).toMatchObject({
      login: 'alice',
    })

    // No login discovered at all: the first run's question is asked on the rerun too.
    const none = answerer('team')
    await askAndWrite(none.world, {
      ...at(files, new Set(['me/laptop'])),
      team: { knownLogin: null, hostname: () => 'laptop', branchExists: () => Effect.succeed(true) },
    })
    expect(none.prompts.some((p) => p.includes('GitHub login'))).toBe(true)
  })

  it('a login the recipe keeps in its claim queue is the default, and is not written over by the discovered one', async () => {
    const files = mapFiles()
    await askAndWrite(answerer('team', (p) => (p.includes('GitHub login') ? 'alice' : undefined)).world, {
      ...at(files, new Set(['me/laptop'])),
      team: { knownLogin: null, hostname: () => 'laptop', branchExists: () => Effect.succeed(true) },
    })
    // The same recipe with its assignee where a queue at `claim` keeps it, and none at `source.assignee`.
    const doc = parseDocument(files.replaced.at(-1)!.text)
    doc.deleteIn(['source', 'assignee'])
    doc.setIn(
      ['steps', 'claim'],
      [
        {
          name: 'queue',
          queue: { kinds: ['bug'], exclude: [], backoff: '1h', assignee: { login: 'alice', take: 'mine' } },
        },
      ],
    )
    await files.replace(path, doc.toString())

    const rerun = answerer('team')
    const result = await askAndWrite(rerun.world, {
      ...at(files, new Set(['me/laptop'])),
      team: { knownLogin: 'me', hostname: () => 'laptop', branchExists: () => Effect.succeed(true) },
    })
    expect(result).not.toHaveProperty('refused')
    // Asked, with the queue's login as the default, since the discovered `me` is not it.
    expect(rerun.prompts.some((p) => p.includes('GitHub login') && p.includes('[alice]'))).toBe(true)
    const kept = parseDocument(files.replaced.at(-1)!.text).toJS() as {
      steps: { claim: { queue: { assignee: { login: string } } }[] }
    }
    expect(kept.steps.claim[0]!.queue.assignee.login).toBe('alice')
  })

  it("--defaults keeps the recipe's login when authentication discovers another, and asks nothing", async () => {
    const files = mapFiles()
    await askAndWrite(answerer('team', (p) => (p.includes('GitHub login') ? 'alice' : undefined)).world, {
      ...at(files, new Set(['me/laptop'])),
      team: { knownLogin: null, hostname: () => 'laptop', branchExists: () => Effect.succeed(true) },
    })
    const prompts: string[] = []
    const world: QuestionWorld = {
      ask: async (prompt) => {
        prompts.push(prompt)
        return null
      },
      log: () => {},
    }
    const result = await askAndWrite(world, {
      ...at(files, new Set(['me/laptop'])),
      flags: { install: 'none', defaults: '' },
      team: { knownLogin: 'bob', hostname: () => 'laptop', branchExists: () => Effect.succeed(true) },
    })
    expect(result).not.toHaveProperty('refused')
    expect(resolveSource(files.replaced.at(-1)!.text, path, path).recipe.source.assignee).toMatchObject({
      login: 'alice',
    })
  })

  it('reads the commits a change left behind, and says where a new branch was really made from', async () => {
    const files = mapFiles()
    await askAndWrite(answerer('team').world, at(files, new Set(['me/laptop'])))
    const reads: string[] = []
    const base = at(files, new Set(['me/laptop', 'me-next']))
    const withCommits = {
      ...base,
      team: {
        ...base.team,
        commitsOnlyIn: (b: string, h: string) => {
          reads.push(`${b}..${h}`)
          return Effect.succeed(['abc123def land ticket 7'])
        },
      },
    }
    const existing = await askAndWrite(
      answerer('team', (p) => (p.includes('branch Lingtai works on') ? 'me-next' : undefined)).world,
      withCommits,
    )
    expect(reads).toEqual(['me-next..me/laptop'])
    const said = changedLeftBehind((existing as { changed?: never }).changed)
      .map((l) => l.what)
      .join('\n')
    expect(said).toContain('abc123def land ticket 7')

    // The old branch is gone from GitHub: the new one is cut from main, and the card does not say otherwise.
    const gone = await askAndWrite(
      answerer('team', (p) => (p.includes('branch Lingtai works on') ? 'me-newer' : undefined)).world,
      at(files, new Set(['main'])),
    )
    const lines = changedLeftBehind((gone as { changed?: never }).changed)
      .map((l) => l.what)
      .join('\n')
    expect(gone).toMatchObject({ make: { from: 'main' } })
    expect(lines).toContain('me-newer was made from origin/main')
    expect(lines).not.toContain('may be deleted')
  })

  it('what a rerun changed reaches the card as lines: the personal branch left as it is, or the old branch', () => {
    const lines = changedLeftBehind({
      mode: { from: 'team', to: 'solo', personal: 'me/laptop', main: 'main' },
      branch: { from: 'me/laptop', to: 'me-next', made: false },
    })
    expect(lines.map((l) => l.what).join('\n')).toContain('nothing on it is waiting to reach main')
    expect(lines.map((l) => l.command).join('\n')).toContain('origin/me-next..origin/me/laptop')
    expect(changedLeftBehind({ branch: { from: 'a', to: 'b', made: true } })[0]!.what).toContain('may be deleted')
    expect(changedLeftBehind(undefined)).toEqual([])
  })
})
