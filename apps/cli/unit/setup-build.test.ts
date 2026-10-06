/**
 * `askInstallAndBuild` (#397): the two questions over `detect-setup.ts`'s
 * suggestion, returned as `RecipeChange[]` for the caller to hand to
 * `setRecipe` — never written here, as `packages/recipe/unit/write.test.ts`
 * hands a `RecipeChange[]` to `setRecipe` directly.
 */
import { type RecipeFiles, recipePath, resolveSource, setRecipe } from '@lingtai/recipe'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { SetupReader } from '../src/detect-setup.ts'
import {
  askInstallAndBuild,
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

const EMPTY_READER: SetupReader = { has: async () => false, read: async () => null }

function reader(files: Record<string, string>): SetupReader {
  return { has: async (path) => path in files, read: async (path) => files[path] ?? null }
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

  it('a red trial build under --check-build yes refuses and returns no changes', async () => {
    const files = mapFiles({ [PATH]: BASE })
    const failing: TrialResult[] = [{ command: 'pnpm test', ok: false, evidence: 'FAIL: 1 test failed' }]
    const { world: w, lines } = world([''])
    const result = await askInstallAndBuild(
      w,
      input({
        given: { install: 'none', build: ['pnpm test'], check: 'yes' },
        tryBuild: async () => failing,
        files,
      }),
    )
    expect(result).toEqual({ refused: expect.any(String) })
    expect(lines.some((l) => l.includes('FAIL: 1 test failed'))).toBe(true)
  })
})
