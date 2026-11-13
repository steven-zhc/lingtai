/**
 * `askInstallAndBuild` (#397): the two questions over `detect-setup.ts`'s
 * suggestion, returned as `RecipeChange[]` for the caller to hand to
 * `setRecipe` — never written here, as `packages/recipe/unit/write.test.ts`
 * hands a `RecipeChange[]` to `setRecipe` directly.
 */
import { type RecipeFiles, recipePath, resolveSource, setRecipe } from '@lingtai/recipe'
import type { SetupReader } from '@lingtai/setup'
import { Effect } from 'effect'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { acceptingDefaults } from '../src/question.ts'
import {
  askInstallAndBuildEffect,
  type AskInstallAndBuildInput,
  type SetupWorld,
  type TrialResult,
} from '../src/setup-build.ts'

const before = process.env['NO_COLOR']
beforeAll(() => {
  process.env['NO_COLOR'] = '1'
})
afterAll(() => {
  if (before === undefined) delete process.env['NO_COLOR']
  else process.env['NO_COLOR'] = before
})

const HOME = '/home/me/.lingtai'
const PATH = recipePath('app', HOME)

function world(answers: (string | null)[] = []): { world: SetupWorld; lines: string[] } {
  const lines: string[] = []
  const queue = [...answers]
  return {
    lines,
    world: {
      ask: async () => (queue.length > 0 ? queue.shift()! : null),
      log: (line) => lines.push(line),
    },
  }
}

/** A trial that cuts at `main`, running `run`. */
function trial(
  run: (install: string | null, build: string[]) => Promise<{ results: TrialResult[]; nothingDeclared: boolean }>,
  base = 'main',
): NonNullable<AskInstallAndBuildInput['tryBuild']> {
  return {
    base: Effect.succeed(base),
    run: (install, build) => Effect.tryPromise({ try: () => run(install, build), catch: (e) => e }),
  }
}

const askInstallAndBuild = (world: SetupWorld, input: AskInstallAndBuildInput) =>
  Effect.runPromise(askInstallAndBuildEffect(world, input))

const EMPTY_READER: SetupReader = { has: () => Effect.succeed(false), read: () => Effect.succeed(null) }

function reader(files: Record<string, string>): SetupReader {
  return { has: (path) => Effect.succeed(path in files), read: (path) => Effect.succeed(files[path] ?? null) }
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

function input(partial: Partial<AskInstallAndBuildInput> & { files: RecipeFiles }): AskInstallAndBuildInput {
  return {
    project: 'app',
    reader: EMPTY_READER,
    given: { install: null, build: null, check: null },
    tryBuild: null,
    home: HOME,
    ...partial,
  }
}

const BASE = `version: 2
repo:
  base: main
source:
  kinds: [bug]
env:
  plantAt: .env.local
`

describe('askInstallAndBuild', () => {
  it('flags alone produce named run: actions at steps.prepared and steps.build, with no question asked', async () => {
    const files = mapFiles({ [PATH]: BASE })
    const { world: w } = world([])
    const result = await askInstallAndBuild(
      w,
      input({
        given: { install: 'pnpm install --frozen-lockfile', build: ['pnpm lint', 'pnpm test'], check: null },
        files,
      }),
    )
    if ('refused' in result) throw new Error(result.refused)
    expect(result.changes).toEqual([
      { path: ['steps', 'prepared'], value: [{ name: 'install', run: 'pnpm install --frozen-lockfile' }] },
      {
        path: ['steps', 'build'],
        value: [
          { name: 'lint', run: 'pnpm lint' },
          { name: 'test', run: 'pnpm test' },
        ],
      },
    ])

    const written = await setRecipe('app', result.changes, { home: HOME, files })
    expect(written.written).toBe(true)
    const resolved = resolveSource(written.text, 'main', PATH)
    expect(resolved.recipe.steps.prepared).toEqual([
      { name: 'install', run: 'pnpm install --frozen-lockfile', timeout: '15m', env: [] },
    ])
    expect(resolved.recipe.steps.build).toEqual([
      { name: 'lint', run: 'pnpm lint', timeout: '15m', env: [] },
      { name: 'test', run: 'pnpm test', timeout: '15m', env: [] },
    ])
  })

  it('--install none and --build none remove the run: actions that were there', async () => {
    const FIXTURE = `version: 2
repo:
  base: main
source:
  kinds: [bug]
env:
  plantAt: .env.local
steps:
  prepared:
    - name: install
      run: pnpm install --frozen-lockfile
  build:
    - name: test
      run: pnpm test
`
    const files = mapFiles({ [PATH]: FIXTURE })
    const { world: w } = world([])
    const result = await askInstallAndBuild(
      w,
      input({ given: { install: 'none', build: ['none'], check: null }, files }),
    )
    if ('refused' in result) throw new Error(result.refused)
    expect(result.changes).toEqual([
      { path: ['steps', 'prepared'], value: [] },
      { path: ['steps', 'build'], value: [] },
    ])

    const written = await setRecipe('app', result.changes, { home: HOME, files })
    const resolved = resolveSource(written.text, 'main', PATH)
    expect(resolved.recipe.steps.prepared).toEqual([])
    expect(resolved.recipe.steps.build).toEqual([])
  })

  it('a --build with its value swallowed by the next flag (`""`) is refused rather than writing run: "" (#431 fix round, finding 2)', async () => {
    const files = mapFiles({ [PATH]: BASE })
    const { world: w } = world([])
    const result = await askInstallAndBuild(w, input({ given: { install: 'none', build: [''], check: null }, files }))
    expect(result).toEqual({ refused: expect.stringContaining('--build') })
    expect(files.replaced).toEqual([])
  })

  it('no TTY and no flags refuses by name, naming --install', async () => {
    const files = mapFiles({ [PATH]: BASE })
    const { world: w } = world([])
    const result = await askInstallAndBuild(w, input({ files }))
    expect(result).toEqual({ refused: expect.stringContaining('--install') })
  })

  it('answering "yes" takes the detected build list, written as bare run: actions', async () => {
    const files = mapFiles({ [PATH]: BASE })
    const detected = reader({
      'pnpm-lock.yaml': '',
      'package.json': JSON.stringify({ scripts: { 'fmt:check': 'oxfmt --check .', test: 'vitest run' } }),
    })
    const { world: w } = world(['', 'yes'])
    const result = await askInstallAndBuild(w, input({ reader: detected, files }))
    if ('refused' in result) throw new Error(result.refused)
    const build = result.changes.find((c) => c.path.join('.') === 'steps.build')
    expect(build?.value).toEqual([
      { name: 'format', run: 'pnpm fmt:check' },
      { name: 'test', run: 'pnpm test' },
    ])

    // `because` is not a field a run: action may carry — setRecipe must accept this.
    const written = await setRecipe('app', result.changes, { home: HOME, files })
    const resolved = resolveSource(written.text, 'main', PATH)
    expect(resolved.recipe.steps.build).toEqual([
      { name: 'format', run: 'pnpm fmt:check', timeout: '15m', env: [] },
      { name: 'test', run: 'pnpm test', timeout: '15m', env: [] },
    ])
  })

  it('pressing enter on a re-run (current answers equal the defaults) writes nothing', async () => {
    const FIXTURE = `version: 2
repo:
  base: main
source:
  kinds: [bug]
env:
  plantAt: .env.local
steps:
  prepared:
    - name: install
      run: pnpm install --frozen-lockfile
      timeout: 5m
      env: []
  build:
    - name: test
      run: pnpm test
      timeout: 5m
      env: []
`
    const files = mapFiles({ [PATH]: FIXTURE })
    const { world: w } = world(['', ''])
    const result = await askInstallAndBuild(w, input({ files }))
    if ('refused' in result) throw new Error(result.refused)
    expect(result.changes).toEqual([])

    const written = await setRecipe('app', result.changes, { home: HOME, files })
    expect(written).toEqual({ path: PATH, text: FIXTURE, written: false })
  })

  it('a file that extends: pnpm-workspace gets the answered build in place of the preset’s, and nothing at steps.proposed', async () => {
    const FIXTURE = `version: 2
extends: pnpm-workspace
repo:
  base: main
source:
  kinds: [bug]
env:
  plantAt: .env.local
`
    const files = mapFiles({ [PATH]: FIXTURE })
    const { world: w } = world([])
    const result = await askInstallAndBuild(
      w,
      input({ given: { install: 'pnpm install --frozen-lockfile', build: ['pnpm test'], check: null }, files }),
    )
    if ('refused' in result) throw new Error(result.refused)
    expect(result.changes.some((c) => c.path.join('.') === 'steps.proposed')).toBe(false)

    const written = await setRecipe('app', result.changes, { home: HOME, files })
    const resolved = resolveSource(written.text, 'main', PATH)
    expect(resolved.recipe.steps.build).toEqual([{ name: 'test', run: 'pnpm test', timeout: '15m', env: [] }])
    expect(resolved.recipe.steps.proposed).toEqual([])
    // The preset's own install is untouched — only `build` was named by this call,
    // so the install keeps the preset's own timeout (10m) rather than the schema's.
    expect(resolved.recipe.steps.prepared).toEqual([
      { name: 'install', run: 'pnpm install --frozen-lockfile', timeout: '10m', env: [] },
    ])
  })

  it('declining an install the preset supplies writes the decline, not the preset default', async () => {
    const FIXTURE = `version: 2
extends: pnpm-workspace
repo:
  base: main
source:
  kinds: [bug]
env:
  plantAt: .env.local
`
    const files = mapFiles({ [PATH]: FIXTURE })
    const { world: w } = world([])
    const result = await askInstallAndBuild(
      w,
      input({ given: { install: 'none', build: ['pnpm test'], check: null }, files }),
    )
    if ('refused' in result) throw new Error(result.refused)
    expect(result.changes.some((c) => c.path.join('.') === 'steps.prepared' && Array.isArray(c.value))).toBe(true)

    const written = await setRecipe('app', result.changes, { home: HOME, files })
    const resolved = resolveSource(written.text, 'main', PATH)
    expect(resolved.recipe.steps.prepared).toEqual([])
    // The preset declares nothing at `proposed`, so nothing runs there after the write either.
    expect(resolved.recipe.steps.proposed).toEqual([])
  })

  it('declining the install on a first run, before the recipe file exists, still writes the decline', async () => {
    const files = mapFiles({})
    const { world: w } = world([])
    const result = await askInstallAndBuild(
      w,
      input({ given: { install: 'none', build: ['pnpm test'], check: null }, files }),
    )
    if ('refused' in result) throw new Error(result.refused)
    expect(result.changes).toEqual([
      { path: ['steps', 'prepared'], value: [] },
      { path: ['steps', 'build'], value: [{ name: 'test', run: 'pnpm test' }] },
    ])
  })

  it('removing an earlier command keeps the timeout and env of the one that is kept', async () => {
    const FIXTURE = `version: 2
repo:
  base: main
source:
  kinds: [bug]
env:
  plantAt: .env.local
steps:
  build:
    - name: lint
      run: pnpm lint
    - name: test
      run: pnpm test
      timeout: 45m
      env: [TURBO_TOKEN]
`
    const files = mapFiles({ [PATH]: FIXTURE })
    const { world: w } = world([])
    const result = await askInstallAndBuild(
      w,
      input({ given: { install: 'none', build: ['pnpm test'], check: null }, files }),
    )
    if ('refused' in result) throw new Error(result.refused)

    const written = await setRecipe('app', result.changes, { home: HOME, files })
    const resolved = resolveSource(written.text, 'main', PATH)
    expect(resolved.recipe.steps.build).toEqual([
      { name: 'test', run: 'pnpm test', timeout: '45m', env: ['TURBO_TOKEN'] },
    ])
  })

  it('adding a build command keeps the timeout and env of the ones already there', async () => {
    const FIXTURE = `version: 2
repo:
  base: main
source:
  kinds: [bug]
env:
  plantAt: .env.local
steps:
  build:
    - name: test
      run: pnpm test
      timeout: 45m
      env: [TURBO_TOKEN]
`
    const files = mapFiles({ [PATH]: FIXTURE })
    const { world: w } = world([])
    const result = await askInstallAndBuild(
      w,
      input({ given: { install: 'none', build: ['pnpm test', 'pnpm lint'], check: null }, files }),
    )
    if ('refused' in result) throw new Error(result.refused)

    const written = await setRecipe('app', result.changes, { home: HOME, files })
    const resolved = resolveSource(written.text, 'main', PATH)
    expect(resolved.recipe.steps.build).toEqual([
      { name: 'test', run: 'pnpm test', timeout: '45m', env: ['TURBO_TOKEN'] },
      { name: 'lint', run: 'pnpm lint', timeout: '15m', env: [] },
    ])
  })

  it('a typed command with a --filter flag is named after the script it runs, never the flag’s value', async () => {
    const files = mapFiles({ [PATH]: BASE })
    const { world: w } = world([])
    const result = await askInstallAndBuild(
      w,
      input({
        given: { install: 'none', build: ['pnpm --filter web test', 'pnpm --filter web lint'], check: null },
        files,
      }),
    )
    if ('refused' in result) throw new Error(result.refused)
    const build = result.changes.find((c) => c.path.join('.') === 'steps.build')
    expect(build?.value).toEqual([
      { name: 'test', run: 'pnpm --filter web test' },
      { name: 'lint', run: 'pnpm --filter web lint' },
    ])
  })

  it('a typed command that execs a binary is named after the binary, never "exec"', async () => {
    const files = mapFiles({ [PATH]: BASE })
    const { world: w } = world([])
    const result = await askInstallAndBuild(
      w,
      input({ given: { install: 'none', build: ['pnpm exec playwright test'], check: null }, files }),
    )
    if ('refused' in result) throw new Error(result.refused)
    const build = result.changes.find((c) => c.path.join('.') === 'steps.build')
    expect(build?.value).toEqual([{ name: 'playwright', run: 'pnpm exec playwright test' }])
  })

  it('declining the build on a file that extends a preset logs it and keeps none of the preset’s checks', async () => {
    const FIXTURE = `version: 2
extends: pnpm-workspace
repo:
  base: main
source:
  kinds: [bug]
env:
  plantAt: .env.local
`
    const files = mapFiles({ [PATH]: FIXTURE })
    const { world: w, lines } = world([])
    const result = await askInstallAndBuild(
      w,
      input({ given: { install: 'none', build: ['none'], check: null }, files }),
    )
    if ('refused' in result) throw new Error(result.refused)
    expect(lines).toContain('nothing will check a diff before review')

    const written = await setRecipe('app', result.changes, { home: HOME, files })
    const resolved = resolveSource(written.text, 'main', PATH)
    expect(resolved.recipe.steps.build).toEqual([])
    expect(resolved.recipe.steps.proposed).toEqual([])
  })

  it('a first run bundled with extends: in the same setRecipe call keeps the answers and none of the preset’s checks', async () => {
    const files = mapFiles({})
    const { world: w } = world([])
    const result = await askInstallAndBuild(
      w,
      input({ given: { install: 'none', build: ['pnpm test'], check: null }, files }),
    )
    if ('refused' in result) throw new Error(result.refused)

    const bundle = [
      { path: ['extends'], value: 'pnpm-workspace' },
      { path: ['repo', 'base'], value: 'main' },
      { path: ['source', 'kinds'], value: ['bug'] },
      { path: ['env', 'plantAt'], value: '.env.local' },
      ...result.changes,
    ]
    const written = await setRecipe('app', bundle, { home: HOME, files })
    const resolved = resolveSource(written.text, 'main', PATH)
    expect(resolved.recipe.steps.prepared).toEqual([])
    expect(resolved.recipe.steps.build).toEqual([{ name: 'test', run: 'pnpm test', timeout: '15m', env: [] }])
    expect(resolved.recipe.steps.proposed).toEqual([])
  })

  it('a file that already writes its own steps.prepared/build gets no steps.proposed change', async () => {
    const FIXTURE = `version: 2
extends: pnpm-workspace
repo:
  base: main
source:
  kinds: [bug]
env:
  plantAt: .env.local
steps:
  prepared:
    - name: install
      run: npm ci
  build:
    - name: test
      run: pnpm test
      timeout: 45m
      env: [TURBO_TOKEN]
`
    const files = mapFiles({ [PATH]: FIXTURE })
    const { world: w, lines } = world([])
    const result = await askInstallAndBuild(
      w,
      input({ given: { install: 'npm ci', build: ['pnpm test', 'pnpm lint'], check: null }, files }),
    )
    if ('refused' in result) throw new Error(result.refused)
    expect(result.changes.some((c) => c.path.join('.') === 'steps.proposed')).toBe(false)
    expect(lines.some((l) => l.includes('removed') && l.includes('steps.proposed'))).toBe(false)
  })

  it('a typed pnpm command using -w (workspace-root) is named after the script, not "check-1"', async () => {
    const files = mapFiles({ [PATH]: BASE })
    const { world: w } = world([])
    const result = await askInstallAndBuild(
      w,
      input({ given: { install: 'none', build: ['pnpm -w test', 'pnpm -w lint'], check: null }, files }),
    )
    if ('refused' in result) throw new Error(result.refused)
    const build = result.changes.find((c) => c.path.join('.') === 'steps.build')
    expect(build?.value).toEqual([
      { name: 'test', run: 'pnpm -w test' },
      { name: 'lint', run: 'pnpm -w lint' },
    ])
  })

  const typedBuild = async (build: string[], text = BASE) => {
    const files = mapFiles({ [PATH]: text })
    const { world: w } = world([])
    const result = await askInstallAndBuild(w, input({ given: { install: 'none', build, check: null }, files }))
    if ('refused' in result) throw new Error(result.refused)
    return result.changes.find((c) => c.path.join('.') === 'steps.build')?.value as { name: string; run: string }[]
  }

  it('a typed non-manager command is named by itself', async () => {
    expect(await typedBuild(['uv run pytest'])).toEqual([{ name: 'uv run pytest', run: 'uv run pytest' }])
    expect(await typedBuild(['  uv   run  pytest '])).toEqual([{ name: 'uv run pytest', run: '  uv   run  pytest ' }])
  })

  it('manager scripts keep their script names', async () => {
    expect(await typedBuild(['pnpm test', 'npm run lint'])).toEqual([
      { name: 'test', run: 'pnpm test' },
      { name: 'lint', run: 'npm run lint' },
    ])
  })

  it('a long typed command is cut to 40 characters ending in …, and two that cut alike stay distinct', async () => {
    const a = `python -m pytest --maxfail=1 tests/unit/${'a'.repeat(10)}`
    const b = `python -m pytest --maxfail=1 tests/unit/${'b'.repeat(10)}`
    const got = await typedBuild([a, b])
    expect(got[0]!.name).toHaveLength(40)
    expect(got[0]!.name.endsWith('…')).toBe(true)
    expect(got[1]!.name).toBe(`${got[0]!.name}-2`)
  })

  it('a typed pnpm script with a colon is named without one, and the recipe resolves', async () => {
    const files = mapFiles({ [PATH]: BASE })
    const { world: w } = world([])
    const result = await askInstallAndBuild(
      w,
      input({ given: { install: 'none', build: ['pnpm fmt:check', 'uv run pytest'], check: null }, files }),
    )
    if ('refused' in result) throw new Error(result.refused)
    const build = result.changes.find((c) => c.path.join('.') === 'steps.build')?.value as { name: string }[]
    expect(build.map((b) => b.name)).toEqual(['fmt-check', 'uv run pytest'])
    for (const change of result.changes) await setRecipe('app', [change], { home: HOME, files })
    expect(() => resolveSource(files.replaced.at(-1)!.text, PATH, PATH)).not.toThrow()
  })

  it('a re-run keeps the name the file already gave a matched run, and a new name never collides with a kept one', async () => {
    const kept = `${BASE}steps:
  build:
    - name: check-1
      run: uv run pytest
    - name: test
      run: make test
`
    expect(await typedBuild(['uv run pytest', 'make test', 'ruff check .'], kept)).toEqual([
      { name: 'check-1', run: 'uv run pytest' },
      { name: 'test', run: 'make test' },
      { name: 'ruff check .', run: 'ruff check .' },
    ])
    expect(await typedBuild(['make test', 'pnpm test'], kept)).toEqual([
      { name: 'test', run: 'make test' },
      { name: 'test-2', run: 'pnpm test' },
    ])
  })

  it('a red trial build under --check-build yes refuses and returns no changes', async () => {
    const files = mapFiles({ [PATH]: BASE })
    const failing = {
      results: [{ command: 'pnpm test', outcome: 'failed', evidence: 'FAIL: 1 test failed' }] as TrialResult[],
      nothingDeclared: false,
    }
    const { world: w, lines } = world([''])
    const result = await askInstallAndBuild(
      w,
      input({
        given: { install: 'none', build: ['pnpm test'], check: 'yes' },
        tryBuild: trial(async () => failing),
        files,
      }),
    )
    expect(result).toEqual({ refused: expect.any(String) })
    expect(lines.some((l) => l.includes('FAIL: 1 test failed'))).toBe(true)
  })
})

describe('a red trial build prints what ran and what did not', () => {
  const run = async (report: { results: TrialResult[]; nothingDeclared: boolean }) => {
    const files = mapFiles({ [PATH]: BASE })
    const { world: base, lines } = world([''])
    const asked: string[] = []
    const w: SetupWorld = {
      ...base,
      ask: async (prompt) => {
        asked.push(prompt)
        return base.ask(prompt)
      },
    }
    await askInstallAndBuild(
      w,
      input({
        given: { install: 'none', build: ['a', 'b', 'c'], check: 'yes' },
        tryBuild: trial(async () => report),
        files,
      }),
    )
    return Object.assign(lines, { asked })
  }
  const red: TrialResult[] = [
    { command: 'b', outcome: 'failed', evidence: 'boom' },
    { command: 'c', outcome: 'not-run', because: '`b` failed first' },
  ]

  it('lists a command that never ran as not run, never under failed:', async () => {
    const lines = await run({ results: red, nothingDeclared: false })
    expect(lines.some((l) => l.startsWith('failed: b') && l.includes('boom'))).toBe(true)
    expect(lines).toContain('not run: c — `b` failed first')
    expect(lines.some((l) => l.startsWith('failed: c'))).toBe(false)
    expect(lines.asked.some((q) => q.includes('keep the list as it is'))).toBe(true)
  })

  it('says once, after the list, that no env was declared', async () => {
    const lines = await run({ results: red, nothingDeclared: true })
    const sentence = lines.filter((l) => l.startsWith('the recipe declares no env, so these ran without any'))
    expect(sentence).toHaveLength(1)
    expect(sentence[0]).toContain(`declare it under env: in ${PATH}`)
    expect(lines.indexOf(sentence[0]!)).toBeGreaterThan(lines.indexOf('not run: c — `b` failed first'))
  })

  it('does not say it when env is declared', async () => {
    const lines = await run({ results: red, nothingDeclared: false })
    expect(lines.some((l) => l.includes('declares no env'))).toBe(false)
  })

  it('does not say it when nothing failed', async () => {
    const lines = await run({
      results: [{ command: 'a', outcome: 'passed', evidence: '' }],
      nothingDeclared: true,
    })
    expect(lines.some((l) => l.includes('declares no env'))).toBe(false)
  })
})

describe('the PATH note', () => {
  it('a manager that is not on PATH is still suggested, with a line naming it', async () => {
    const files = mapFiles({ [PATH]: BASE })
    const { world: w, lines } = world([])
    await askInstallAndBuild(
      w,
      input({
        reader: reader({ 'uv.lock': '', 'pyproject.toml': '[tool.pytest.ini_options]\nx = 1\n' }),
        files,
        onPath: async () => false,
      }),
    )
    expect(lines).not.toContain('install: uv sync --frozen — uv.lock is at the root')
    expect(lines).toContain("uv is not on this machine's PATH; the conductor runs these commands here")
    expect(lines.filter((l) => l.includes('not on this machine'))).toHaveLength(1)
  })

  it('the gofmt check probes gofmt, not the builtin test', async () => {
    const files = mapFiles({ [PATH]: BASE })
    const { world: w, lines } = world([])
    await askInstallAndBuild(
      w,
      input({
        reader: reader({ 'go.mod': 'module x\n' }),
        files,
        onPath: async (tool: string) => tool !== 'gofmt',
      }),
    )
    expect(lines).toContain("gofmt is not on this machine's PATH; the conductor runs these commands here")
    expect(lines.some((l) => l.startsWith('test is not'))).toBe(false)
  })

  it('a Maven wrapper probes java, not ./mvnw', async () => {
    const files = mapFiles({ [PATH]: BASE })
    const { world: w, lines } = world([])
    await askInstallAndBuild(
      w,
      input({
        reader: reader({ 'pom.xml': '<project/>', mvnw: '' }),
        files,
        onPath: async (tool: string) => tool !== 'java',
      }),
    )
    expect(lines).toContain("java is not on this machine's PATH; the conductor runs these commands here")
    expect(lines.some((l) => l.includes('mvnw'))).toBe(false)
  })

  it('a probe that throws logs nothing', async () => {
    const files = mapFiles({ [PATH]: BASE })
    const { world: w, lines } = world([])
    await askInstallAndBuild(
      w,
      input({
        reader: reader({ 'uv.lock': '' }),
        files,
        onPath: async () => {
          throw new Error('boom')
        },
      }),
    )
    expect(lines.some((l) => l.includes('PATH'))).toBe(false)
  })
})

describe('the trial outcome the card reads', () => {
  const passing = {
    results: [{ command: 'a', outcome: 'passed', evidence: '' }] as TrialResult[],
    nothingDeclared: false,
  }

  it('returns the wall time around tryBuild, under fake timers', async () => {
    vi.useFakeTimers()
    try {
      const { world: w } = world()
      const pending = askInstallAndBuild(
        w,
        input({
          given: { install: 'none', build: ['a'], check: 'yes' },
          tryBuild: trial(async () => {
            await vi.advanceTimersByTimeAsync(125_000)
            return passing
          }),
          files: mapFiles({ [PATH]: BASE }),
        }),
      )
      const result = await vi.runAllTimersAsync().then(() => pending)
      expect(result).toMatchObject({ trial: { trial: 'passed', ms: 125_000 } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('is not-run for a declined, an unoffered and an empty list', async () => {
    const files = () => mapFiles({ [PATH]: BASE })
    const declined = await askInstallAndBuild(
      world().world,
      input({
        given: { install: 'none', build: ['a'], check: 'no' },
        tryBuild: trial(async () => passing),
        files: files(),
      }),
    )
    expect(declined).toMatchObject({ trial: { trial: 'not-run', because: 'declined' } })
    const unoffered = await askInstallAndBuild(
      world().world,
      input({ given: { install: 'none', build: ['a'], check: null }, files: files() }),
    )
    expect(unoffered).toMatchObject({ trial: { trial: 'not-run', because: 'no checkout' } })
    const empty = await askInstallAndBuild(
      world().world,
      input({ given: { install: 'none', build: [], check: null }, files: files() }),
    )
    expect(empty).toMatchObject({ trial: { trial: 'not-run', because: 'no checks' } })
  })

  it('names the first failed command when the person keeps a red list', async () => {
    const failing = {
      results: [{ command: 'pnpm test', outcome: 'failed', evidence: 'x' }] as TrialResult[],
      nothingDeclared: false,
    }
    const result = await askInstallAndBuild(
      world(['keep']).world,
      input({
        given: { install: 'none', build: ['pnpm test'], check: 'yes' },
        tryBuild: trial(async () => failing),
        files: mapFiles({ [PATH]: BASE }),
      }),
    )
    expect(result).toMatchObject({ trial: { trial: 'failed-kept', command: 'pnpm test' } })
  })
})

describe('why a default is what it is (#773)', () => {
  const UV = { 'uv.lock': '', 'pyproject.toml': '[tool.pytest.ini_options]\nx = 1\n' }
  const ROOT = 'install: uv sync --frozen — uv.lock is at the root'

  /** Like `liveAsk`: prints `shape.why` where the question is drawn, then answers with the default. */
  const terminal = (): { world: SetupWorld; lines: string[] } => {
    const lines: string[] = []
    return {
      lines,
      world: {
        ask: async (_prompt, shape) => {
          for (const line of shape?.why ?? []) lines.push(line)
          return ''
        },
        log: (line) => lines.push(line),
      },
    }
  }

  it('is printed when the question is asked at a terminal', async () => {
    const files = mapFiles({ [PATH]: BASE })
    const { world: w, lines } = terminal()
    await askInstallAndBuild(w, input({ reader: reader(UV), files }))
    expect(lines).toContain(ROOT)
  })

  it('is not printed when --install answers the question', async () => {
    const files = mapFiles({ [PATH]: BASE })
    const { world: w, lines } = terminal()
    await askInstallAndBuild(
      w,
      input({ reader: reader(UV), files, given: { install: 'make deps', build: ['none'], check: null } }),
    )
    expect(lines.join('\n')).not.toContain('is at the root')
  })

  it('is not printed under --defaults', async () => {
    const files = mapFiles({ [PATH]: BASE })
    const lines: string[] = []
    const w = acceptingDefaults({ ask: async () => null, log: (line) => lines.push(line) })
    await askInstallAndBuild(w, input({ reader: reader(UV), files }))
    expect(lines.join('\n')).not.toContain('is at the root')
  })

  it('is not printed when there is no terminal to ask at', async () => {
    const files = mapFiles({ [PATH]: BASE })
    const { world: w, lines } = world([])
    await askInstallAndBuild(w, input({ reader: reader(UV), files }))
    expect(lines.join('\n')).not.toContain('is at the root')
  })
})

describe('a failed trial offers keep, edit or drop (#758)', () => {
  const LISTED = `${BASE}steps:
  prepared:
    - name: install
      run: npm ci
  build:
    - name: a
      run: a
    - name: b
      run: b
    - name: c
      run: c
`
  const fail = (command: string, rest: string[] = []): { results: TrialResult[]; nothingDeclared: boolean } => ({
    results: [
      { command, outcome: 'failed', evidence: 'boom' },
      ...rest.map((c): TrialResult => ({ command: c, outcome: 'not-run', because: `\`${command}\` failed first` })),
    ],
    nothingDeclared: false,
  })
  const ok = (...commands: string[]) => ({
    results: commands.map((command): TrialResult => ({ command, outcome: 'passed', evidence: '' })),
    nothingDeclared: false,
  })
  const asking = (answers: string[]) => {
    const { world: base, lines } = world(answers)
    const asked: string[] = []
    const w: SetupWorld = {
      ...base,
      ask: async (prompt) => {
        asked.push(prompt)
        return base.ask(prompt)
      },
    }
    return { w, lines, asked }
  }

  it('says what the two questions are, with the base, and what is not yet written', async () => {
    for (const [recipeExisted, ending] of [
      [false, 'Nothing is written yet.'],
      [true, 'This list is not written yet.'],
    ] as const) {
      const { w, asked } = asking(['', 'yes', 'no'])
      await askInstallAndBuild(
        w,
        input({
          tryBuild: trial(async () => ok('a'), 'develop'),
          recipeExisted,
          files: mapFiles({ [PATH]: LISTED }),
        }),
      )
      expect(asked.some((q) => q.includes('Each attempt runs these checks before review — keep this list?'))).toBe(true)
      const q = asked.find((x) => x.includes('Try them once now'))!
      expect(q).toContain('on `develop`, to see that they work?')
      expect(q).toContain(ending)
    }
  })

  it('edit goes back to the build question, install asked once, one change returned', async () => {
    const calls: string[][] = []
    const { w, asked } = asking(['', 'yes', 'yes', 'edit', 'no', 'x', '', 'yes'])
    const result = await askInstallAndBuild(
      w,
      input({
        tryBuild: trial(async (_i, build) => {
          calls.push(build)
          return calls.length === 1 ? fail('a', ['b', 'c']) : ok('x')
        }),
        files: mapFiles({ [PATH]: LISTED }),
      }),
    )
    if ('refused' in result) throw new Error(result.refused)
    expect(calls).toEqual([['a', 'b', 'c'], ['x']])
    expect(asked.filter((q) => q.includes('install command'))).toHaveLength(1)
    expect(result.changes.filter((c) => c.path.join('.') === 'steps.build')).toHaveLength(1)
    expect(result.trial).toMatchObject({ trial: 'passed' })
  })

  it('drop removes the failed check and tries the rest again without asking again', async () => {
    const calls: string[][] = []
    const { w, asked } = asking(['', 'yes', 'yes', 'drop'])
    const result = await askInstallAndBuild(
      w,
      input({
        tryBuild: trial(async (_i, build) => {
          calls.push(build)
          return calls.length === 1 ? fail('b', ['c']) : ok('a', 'c')
        }),
        files: mapFiles({ [PATH]: LISTED }),
      }),
    )
    if ('refused' in result) throw new Error(result.refused)
    expect(calls).toEqual([
      ['a', 'b', 'c'],
      ['a', 'c'],
    ])
    expect(asked.filter((q) => q.includes('Try them once now'))).toHaveLength(1)
    const build = result.changes.find((c) => c.path.join('.') === 'steps.build')
    expect(build?.value).toEqual([
      { name: 'a', run: 'a' },
      { name: 'c', run: 'c' },
    ])
  })

  it('drop of the only check runs no second trial and says nothing will check a diff', async () => {
    const calls: string[][] = []
    const { w, lines } = asking(['', 'yes', 'yes', 'drop'])
    const result = await askInstallAndBuild(
      w,
      input({
        tryBuild: trial(async (_i, build) => {
          calls.push(build)
          return fail('a')
        }),
        files: mapFiles({ [PATH]: LISTED.replace(/ {4}- name: [bc]\n {6}run: [bc]\n/g, '') }),
      }),
    )
    if ('refused' in result) throw new Error(result.refused)
    expect(calls).toHaveLength(1)
    expect(lines).toContain('nothing will check a diff before review')
    expect(result.trial).toMatchObject({ trial: 'not-run', because: 'no checks' })
  })

  it('a failed install offers keep and edit only, and edit starts at the install question', async () => {
    const { w, asked } = asking(['', 'yes', 'yes', 'edit', 'pnpm i', 'yes', 'no'])
    let n = 0
    await askInstallAndBuild(
      w,
      input({
        tryBuild: trial(async () => (++n === 1 ? fail('npm ci', ['a', 'b', 'c']) : ok('a'))),
        files: mapFiles({ [PATH]: LISTED }),
      }),
    )
    const choice = asked.find((q) => q.includes('keep the list as it is'))!
    expect(choice).not.toContain('drop')
    expect(asked.filter((q) => q.includes('install command'))).toHaveLength(2)
  })

  it('refuses edit by naming --build or --install when the answer was a flag', async () => {
    const byBuild = await askInstallAndBuild(
      world(['edit']).world,
      input({
        given: { install: 'none', build: ['a'], check: 'yes' },
        tryBuild: trial(async () => fail('a')),
        files: mapFiles({ [PATH]: BASE }),
      }),
    )
    expect(byBuild).toEqual({ refused: expect.stringContaining('--build') })
    const byInstall = await askInstallAndBuild(
      world(['edit']).world,
      input({
        given: { install: 'npm ci', build: ['a'], check: 'yes' },
        tryBuild: trial(async () => fail('npm ci', ['a'])),
        files: mapFiles({ [PATH]: BASE }),
      }),
    )
    expect(byInstall).toEqual({ refused: expect.stringContaining('--install') })
  })
})
