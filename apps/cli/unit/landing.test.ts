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

/**
 * `extends: pnpm-workspace` and no `steps:` key — `steps.proposed` resolves
 * entirely from the preset (`presets.ts`'s `build` action). The onboarding
 * shape `doc/design/395.md` and `write.test.ts`'s widening tests describe.
 */
const PRESET_NO_STEPS = `version: 2
extends: pnpm-workspace
repo: {base: main}
source: {kinds: [bug], exclude: []}
env: {required: [], plantAt: .env.local}
runtime: {agent: claude-code, limits: {turns: 10, wall: 2m, rounds: 2, restarts: 0}}
`

/**
 * `repo.base: main` but the branch a pass actually cuts from and lands on is
 * `steps.admit`'s `worktree.base: release` (`#268`'s v2 spelling) — the
 * shape `baseOf`/`baseWrittenAt` (`settings.ts:222-245`) exist to read
 * correctly instead of assuming `repo.base`.
 */
const WORKTREE_ADMIT = `version: 2
repo: {base: main, submodules: false}
source: {kinds: [bug], exclude: []}
env: {required: [], plantAt: .env.local}
steps:
  admit:
    - name: cut the tree
      worktree: {base: release, submodules: false}
runtime: {agent: claude-code, limits: {turns: 10, wall: 2m, rounds: 2, restarts: 0}}
`

/**
 * `repo.base: ""` already on disk — the shape a bare `--land` with no value
 * used to write before this fix, and the one case `baseOf` can actually
 * produce that answers nothing, so `current` must read as null and
 * `defaultBranch` must get its turn.
 */
const EMPTY_BASE = `version: 2
repo: {base: "", submodules: false}
source: {kinds: [bug], exclude: []}
env: {required: [], plantAt: .env.local}
steps: {}
runtime: {agent: claude-code, limits: {turns: 10, wall: 2m, rounds: 2, restarts: 0}}
`

/** A terse `steps.proposed` entry, with none of `runPlugin`'s defaulted fields (`timeout`, `env`) written. */
const TERSE_PROPOSED = `version: 2
repo: {base: main, submodules: false}
source: {kinds: [bug], exclude: []}
env: {required: [], plantAt: .env.local}
steps:
  proposed:
    - name: smoke
      run: pnpm smoke
runtime: {agent: claude-code, limits: {turns: 10, wall: 2m, rounds: 2, restarts: 0}}
`

describe('askLanding', () => {
  it('a bare --land with no value is refused, and nothing is written', async () => {
    const files = mapFiles({ [PATH]: FIXTURE })
    const result = await askLanding(world().world, PROJECT, '', {
      home: HOME,
      files,
      defaultBranch: async () => 'main',
    })
    expect(result).toMatchObject({ refused: expect.any(String) })
    expect(files.replaced).toEqual([])
    const resolved = resolveSource((await files.read(PATH))!, PATH, PATH).recipe
    expect(resolved.repo.base).toBe('main')
  })

  it('an empty repo.base already on disk answers nothing, so the default branch is fetched and offered', async () => {
    const files = mapFiles({ [PATH]: EMPTY_BASE })
    const { world: w, asked } = world([])
    let calls = 0
    const result = await askLanding(w, PROJECT, null, {
      home: HOME,
      files,
      defaultBranch: async () => {
        calls++
        return 'trunk'
      },
    })
    expect(result).toMatchObject({ refused: expect.any(String) })
    expect(calls).toBe(1)
    expect(asked[0]).toContain('[trunk]')
  })

  it('--land hold on a file with its own terse steps.proposed entry leaves that entry exactly as written', async () => {
    const files = mapFiles({ [PATH]: TERSE_PROPOSED })
    const { world: w } = world()
    const result = await askLanding(w, PROJECT, 'hold', { home: HOME, files, defaultBranch: async () => 'main' })
    expect(result).toEqual({ ok: true })

    const written = (await files.read(PATH))!
    const smokeBlock = '  proposed:\n    - name: smoke\n      run: pnpm smoke\n'
    expect(TERSE_PROPOSED).toContain(smokeBlock)
    expect(written).toContain(smokeBlock)
    // The schema's own defaults for `runPlugin`'s other fields, never pinned
    // into an entry the person wrote without them.
    expect(written).not.toContain('timeout:')
    expect(written).not.toMatch(/run: pnpm smoke\n\s+env:/)
  })

  it('--land hold never calls defaultBranch — a flag already answers the question', async () => {
    const files = mapFiles({ [PATH]: FIXTURE })
    let calls = 0
    const result = await askLanding(world().world, PROJECT, 'hold', {
      home: HOME,
      files,
      defaultBranch: async () => {
        calls++
        return 'main'
      },
    })
    expect(result).toEqual({ ok: true })
    expect(calls).toBe(0)
  })

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

  it('--land hold on a file inheriting its steps from a preset keeps the preset build and adds only the hold', async () => {
    const files = mapFiles({ [PATH]: PRESET_NO_STEPS })
    const { world: w } = world()
    const result = await askLanding(w, PROJECT, 'hold', { home: HOME, files, defaultBranch: async () => 'main' })
    expect(result).toEqual({ ok: true })

    const written = (await files.read(PATH))!
    const resolved = resolveSource(written, PATH, PATH).recipe
    // The preset's check is at `build:` (b21b89ea), and widening keeps it there.
    expect(resolved.steps.build).toEqual([
      { name: 'build', run: 'pnpm typecheck && pnpm lint && pnpm test', timeout: '15m', env: [] },
    ])
    expect(resolved.steps.proposed).toEqual([
      { name: 'hold every pass', human: "Land this? The setup was answered 'hold'." },
    ])
  })

  it("on a recipe cutting from steps.admit's worktree.base, the default offered is that base, not repo.base", async () => {
    const files = mapFiles({ [PATH]: WORKTREE_ADMIT })
    const { world: w, asked } = world([])
    // No flag and no queued answer: the question is asked and refused, but
    // its own default — shown in the bracket — must be the branch the
    // conductor actually cuts from, read before the refusal happens.
    const result = await askLanding(w, PROJECT, null, { home: HOME, files, defaultBranch: async () => 'main' })
    expect(result).toMatchObject({ refused: expect.any(String) })
    expect(asked[0]).toContain('[release]')
  })

  it("--land develop on a recipe cutting from steps.admit's worktree.base writes it there, and leaves repo.base untouched", async () => {
    const files = mapFiles({ [PATH]: WORKTREE_ADMIT })
    const { world: w } = world()
    const result = await askLanding(w, PROJECT, 'develop', { home: HOME, files, defaultBranch: async () => 'main' })
    expect(result).toEqual({ ok: true })

    const written = (await files.read(PATH))!
    const resolved = resolveSource(written, PATH, PATH).recipe
    expect(resolved.repo.base).toBe('main')
    expect(resolved.steps.admit).toEqual([{ name: 'cut the tree', worktree: { base: 'develop', submodules: false } }])
  })

  it('with no terminal and no flag, refuses naming --land, and replace is never called', async () => {
    const files = mapFiles({ [PATH]: FIXTURE })
    const w: QuestionWorld = { ask: async () => null, log: () => {} }
    const result = await askLanding(w, PROJECT, null, { home: HOME, files, defaultBranch: async () => null })
    expect(result).toMatchObject({ refused: expect.stringContaining('--land') })
    expect(files.replaced).toEqual([])
  })

  it('--land release on a hand-written hold carrying a comment removes the hold and its comment (0104 §14)', async () => {
    const COMMENTED_HOLD = `version: 2
repo: {base: main, submodules: false}
source: {kinds: [bug], exclude: []}
env: {required: [], plantAt: .env.local}
steps:
  proposed:
    # I want to see every merge while we learn the loop
    - name: approval
      human: "Merge this? It is my own code."
runtime: {agent: claude-code, limits: {turns: 10, wall: 2m, rounds: 2, restarts: 0}}
`
    const files = mapFiles({ [PATH]: COMMENTED_HOLD })
    const result = await askLanding(world().world, PROJECT, 'release', {
      home: HOME,
      files,
      defaultBranch: async () => 'main',
    })
    expect(result).toEqual({ ok: true })
    const written = (await files.read(PATH))!
    expect(written).not.toContain('human:')
    expect(written).not.toContain('I want to see every merge')
  })
})

/**
 * `runtime.limits` is the wide ceiling; `steps.implement` narrows it for the
 * one step that actually spends it. `add()`'s own sentence (`onboard.ts`'s
 * `limitsFor(…, 'implement')`) prints the narrow figure, not the ceiling.
 */
const NARROW_IMPLEMENT = `version: 2
repo: {base: main, submodules: false}
source: {kinds: [bug], exclude: []}
env: {required: [], plantAt: .env.local}
steps:
  implement:
    - name: work
      agent: claude-code
      prompt: 'fix {{issue}}'
      limits: {turns: 4, wall: 10m}
runtime: {agent: claude-code, limits: {turns: 10, wall: 2h, rounds: 2, restarts: 0}}
`

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

  it('the budget prompt shows an existing ceiling in money, formatted by show', async () => {
    const files = mapFiles({ [PATH]: FIXTURE.replace('rounds: 2, restarts: 0', 'rounds: 2, restarts: 0, usd: 7') })
    const { world: w, asked } = world(['', '', ''])
    await askLimits(w, PROJECT, {}, { home: HOME, files })
    // `show`'s `$${Number(value).toFixed(2)}` is what turns `usd: 7` into this
    // bracket — the prompt's own literal ("like $5") would satisfy a bare
    // `.includes('$')`, so this pins the formatted current value instead.
    expect(asked[2]).toContain('[$7.00]')
  })

  it('the budget prompt shows "none" rather than money when no ceiling is set', async () => {
    const files = mapFiles({ [PATH]: FIXTURE })
    const { world: w, asked } = world(['', '', ''])
    await askLimits(w, PROJECT, {}, { home: HOME, files })
    expect(asked[2]).toContain('[none]')
  })

  it("the printed ceiling is implement's own narrower bound, not the recipe's wide runtime.limits", async () => {
    const files = mapFiles({ [PATH]: NARROW_IMPLEMENT })
    const { world: w, lines } = world(['', '', ''])
    // Pressing enter on every question — the ceiling itself is unchanged by
    // this run, only the sentence that reports it is under test.
    const result = await askLimits(w, PROJECT, {}, { home: HOME, files })
    expect(result).toEqual({ ok: true })

    const printed = lines.find((l) => l.includes('a pass'))!
    expect(printed).toContain('10m')
    expect(printed).toContain('4 turns')
    expect(printed).not.toContain('2h')
  })

  it('a Ctrl+C at the third question keeps the first two answers — each is its own setRecipe call', async () => {
    const files = mapFiles({ [PATH]: FIXTURE })
    // Two typed answers, then the budget question's `ask` returns null — the
    // same shape a Ctrl+C leaves a readline-backed `ask` in.
    const result = await askLimits(world(['0', '30m']).world, PROJECT, {}, { home: HOME, files })
    expect(result).toMatchObject({ refused: expect.stringContaining('the spend ceiling') })

    const written = (await files.read(PATH))!
    const limits = resolveSource(written, PATH, PATH).recipe.runtime.limits
    expect(limits.rounds).toBe(0)
    expect(limits.wall).toBe('30m')
    expect(files.replaced).toHaveLength(2)
  })

  it('a wall narrower than steps.implement is refused by name, not thrown, with the rounds answer already written', async () => {
    const files = mapFiles({ [PATH]: NARROW_IMPLEMENT })
    // `steps.implement` is bounded to `wall: 10m`; writing the ceiling to
    // `5m` trips 0070 §5's narrowing refusal inside `setRecipe`'s own
    // `resolveSource` call, which must surface as `{refused}` rather than an
    // uncaught `RecipeInvalidError` — the flags pass validation (`5m` is a
    // valid positive duration), so only the write itself catches this.
    const result = await askLimits(world().world, PROJECT, { rounds: '3', wall: '5m' }, { home: HOME, files })
    expect(result).toMatchObject({ refused: expect.stringContaining('may only narrow') })

    // The rounds answer, asked and written first, stays on disk.
    const written = (await files.read(PATH))!
    expect(resolveSource(written, PATH, PATH).recipe.runtime.limits.rounds).toBe(3)
    expect(files.replaced).toHaveLength(1)
  })
})
