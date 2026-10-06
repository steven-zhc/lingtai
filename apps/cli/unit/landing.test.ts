import { type RecipeFiles, recipePath, resolveSource } from '@lingtai/recipe'
/**
 * `askLanding` and `askLimits` (#399) — the setup's questions over #392's
 * seam, writing with #395's `setRecipe`. No filesystem: the recipe file is a
 * `Map`, exactly as `packages/recipe/unit/write.test.ts` tests the writer
 * underneath this, and no terminal: `world()` below scripts the answers the
 * same way `apps/cli/unit/question.test.ts` does for the seam itself.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { askLanding, askLimits } from '../src/landing.ts'
import type { QuestionWorld } from '../src/question.ts'

// `paint` reads `FORCE_COLOR` on every call; `NO_COLOR` wins outright ahead of
// it, so assertions reading `lines`/`asked` as bare strings do not depend on
// whatever the process running `pnpm test` happens to export.
const before = process.env['NO_COLOR']
beforeAll(() => {
  process.env['NO_COLOR'] = '1'
})
afterAll(() => {
  if (before === undefined) delete process.env['NO_COLOR']
  else process.env['NO_COLOR'] = before
})

const HOME = '/home/me/.lingtai'
const PROJECT = 'app'
const PATH = recipePath(PROJECT, HOME)

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

function world(answers: (string | null)[] = []): { world: QuestionWorld; lines: string[]; asked: string[] } {
  const lines: string[] = []
  const asked: string[] = []
  const queue = [...answers]
  return {
    lines,
    asked,
    world: {
      ask: async (prompt) => {
        asked.push(prompt)
        return queue.length > 0 ? queue.shift()! : null
      },
      log: (line) => lines.push(line),
    },
  }
}

// Flow mappings written *without* internal padding — `editRecipe`'s own
// renderer (`RENDER` in `emit.ts`) strips it, and a line this file writes
// with padding renders differently from the line `editRecipe` computes for
// it, which an edit whose insertion point lands beside that line cannot
// carry (`emit.ts`'s `carry`/`onto`, and its own refusal says so).

/** A resolvable recipe with `merge:` written — the fixture `write.test.ts` asks for the shape of. */
const FIXTURE = `version: 2
repo: {base: main, submodules: false}
source: {kinds: [bug], exclude: []}
env: {required: [], plantAt: .env.local}
steps:
  merge:
    - name: land the branch
      merge: {strategy: merge-commit}
runtime: {agent: claude-code, limits: {turns: 10, wall: 2m, rounds: 2, restarts: 0}}
`

/** The same, holding at `proposed` beside a judge, so removing the hold can be told apart from removing the judge. */
const HOLDING = `version: 2
repo: {base: main, submodules: false}
source: {kinds: [bug], exclude: []}
env: {required: [], plantAt: .env.local}
steps:
  proposed:
    - name: approval
      human: "Merge this? It is my own code."
    - name: the lines or the approach
      judge: claude-code
      when: findings
runtime: {agent: claude-code, limits: {turns: 10, wall: 2m, rounds: 2, restarts: 0}}
`

/** No `runtime.limits` at all — every number is the schema's own default. */
const INHERITING = `version: 2
repo: {base: main, submodules: false}
source: {kinds: [bug], exclude: []}
env: {required: [], plantAt: .env.local}
steps: {}
runtime: {agent: claude-code}
`

describe('askLanding', () => {
  it('--land hold writes exactly one human: at steps.proposed, and leaves steps.merge untouched', async () => {
    const files = mapFiles({ [PATH]: FIXTURE })
    const { world: w } = world()
    const result = await askLanding(w, PROJECT, 'hold', { home: HOME, files, defaultBranch: async () => 'main' })
    expect(result).toEqual({ ok: true })

    const written = (await files.read(PATH))!
    expect(written.match(/human:/g)).toHaveLength(1)
    expect(resolveSource(written, PATH, PATH)).toBeTruthy()

    const before = resolveSource(FIXTURE, PATH, PATH).recipe.steps.merge
    const after = resolveSource(written, PATH, PATH).recipe.steps.merge
    expect(after).toEqual(before)

    // The merge step's own three lines, untouched by an edit to a sibling step.
    const mergeBlock = '  merge:\n    - name: land the branch\n      merge: {strategy: merge-commit}\n'
    expect(FIXTURE).toContain(mergeBlock)
    expect(written).toContain(mergeBlock)
  })

  it('--land hold a second time writes nothing — written: false', async () => {
    const files = mapFiles({ [PATH]: FIXTURE })
    await askLanding(world().world, PROJECT, 'hold', { home: HOME, files, defaultBranch: async () => 'main' })
    expect(files.replaced).toHaveLength(1)
    const afterFirst = await files.read(PATH)

    await askLanding(world().world, PROJECT, 'hold', { home: HOME, files, defaultBranch: async () => 'main' })
    expect(files.replaced).toHaveLength(1)
    expect(await files.read(PATH)).toBe(afterFirst)
  })

  it('--land release on a file holding at proposed sets repo.base, drops the hold, and keeps the judge', async () => {
    const files = mapFiles({ [PATH]: HOLDING })
    const { world: w } = world()
    const result = await askLanding(w, PROJECT, 'release', { home: HOME, files, defaultBranch: async () => 'main' })
    expect(result).toEqual({ ok: true })

    const written = (await files.read(PATH))!
    expect(written).not.toContain('human:')
    expect(written).toContain('judge: claude-code')
    const resolved = resolveSource(written, PATH, PATH).recipe
    expect(resolved.repo.base).toBe('release')
  })

  it('with no terminal and no flag, refuses naming --land, and replace is never called', async () => {
    const files = mapFiles({ [PATH]: FIXTURE })
    const w: QuestionWorld = { ask: async () => null, log: () => {} }
    const result = await askLanding(w, PROJECT, null, { home: HOME, files, defaultBranch: async () => null })
    expect(result).toMatchObject({ refused: expect.stringContaining('--land') })
    expect(files.replaced).toEqual([])
  })
})

describe('askLimits', () => {
  it('--rounds 0 --wall 30m --budget 4 each land at their runtime.limits key', async () => {
    const files = mapFiles({ [PATH]: FIXTURE })
    const { world: w, lines } = world()
    const result = await askLimits(w, PROJECT, { rounds: '0', wall: '30m', budget: '4' }, { home: HOME, files })
    expect(result).toEqual({ ok: true })

    const written = (await files.read(PATH))!
    const limits = resolveSource(written, PATH, PATH).recipe.runtime.limits
    expect(limits.rounds).toBe(0)
    expect(limits.wall).toBe('30m')
    expect(limits.usd).toBe(4)

    // passCeiling's own sentence, with the dollar figure this run answered.
    expect(lines.some((l) => l.includes('$4'))).toBe(true)
  })

  it('--budget none removes usd', async () => {
    const files = mapFiles({ [PATH]: FIXTURE.replace('rounds: 2, restarts: 0', 'rounds: 2, restarts: 0, usd: 7') })
    const result = await askLimits(
      world().world,
      PROJECT,
      { rounds: '2', wall: '2m', budget: 'none' },
      { home: HOME, files },
    )
    expect(result).toEqual({ ok: true })
    const written = (await files.read(PATH))!
    expect(resolveSource(written, PATH, PATH).recipe.runtime.limits.usd).toBeUndefined()
  })

  it('pressing enter on an inherited default writes nothing', async () => {
    const files = mapFiles({ [PATH]: INHERITING })
    // Three questions, three empty answers — the terminal's "enter" (#392).
    const result = await askLimits(world(['', '', '']).world, PROJECT, {}, { home: HOME, files })
    expect(result).toEqual({ ok: true })
    expect(files.replaced).toEqual([])
  })

  it('the budget prompt contains $', async () => {
    const files = mapFiles({ [PATH]: FIXTURE })
    const { world: w, asked } = world(['', '', ''])
    await askLimits(w, PROJECT, {}, { home: HOME, files })
    expect(asked.some((line) => line.includes('$'))).toBe(true)
  })
})
