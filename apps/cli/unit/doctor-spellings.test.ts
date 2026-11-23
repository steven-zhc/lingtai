/** #1307: the `recipe: <project> spelling` row, `--fix`, and the refusal of `--fix --json`. */
import { projectStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { ProjectFiles, recipePath } from '@lingtai/project'
import { OldSpellingRefusedError, resolveSource, type RecipeFiles } from '@lingtai/recipe'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { fixOldSpellings, fixRefusal, recipeSpellings, renderSpellingFixes } from '../src/doctor.ts'

type ProjectState = Effect.Success<ReturnType<Parameters<typeof fixOldSpellings>[0]>>[number]
const HOME = '/home/me/.lingtai'
const OLD = `version: 2
# keep me
repo:
  base: develop # goes
  submodules: true # stays
source:
  kinds: [bug]
env:
  plantAt: .env.local
runtime:
  agent: claude-code
  assignee:
    take: both # on the take
`

function world(initial: Record<string, string>, failFor?: string) {
  const disk = new Map(Object.entries(initial))
  const store = createMemoryEventStore()
  const files: RecipeFiles = {
    read: async (p) => disk.get(p) ?? null,
    replace: async (p, text) => {
      if (failFor !== undefined && p === recipePath(failFor, HOME)) throw new Error('disk full')
      disk.set(p, text)
    },
  }
  const fix = (projects: string[]) =>
    Effect.runPromise(
      fixOldSpellings(
        () => Effect.succeed(projects.map((project) => ({ project }) as ProjectState)),
        {
          recipe: (state) =>
            Effect.try({
              try: () => resolveSource(disk.get(recipePath(state.project!, HOME)) ?? '', 'main', 'recipe.yml'),
              catch: (err) => err as Error,
            }),
        },
        { by: 'human:me', store, home: HOME },
      ).pipe(Effect.provideService(ProjectFiles, files)),
    )
  const events = async (p: string) => (await store.read(projectStream(p))).map((e) => e.data as { by: string })
  return { disk, store, fix, events }
}

const refused = (): OldSpellingRefusedError => {
  try {
    resolveSource(OLD, 'main', 'recipe.yml')
  } catch (err) {
    return err as OldSpellingRefusedError
  }
  throw new Error('resolved')
}

describe('recipeSpellings', () => {
  const failed = (project: string, err: OldSpellingRefusedError) =>
    ({ project, ok: false, problem: err.message, oldSpellings: err.spellings }) as never

  it('fails, naming each old key and the command', () => {
    const [row] = recipeSpellings([failed('app', refused())])
    expect(row).toMatchObject({ name: 'recipe: app spelling', status: 'fail', fix: 'lingtai doctor --fix' })
    expect(row!.detail).toContain('repo.base: write `branch: { main: <value> }`')
    expect(row!.detail).toContain('runtime.assignee: write it as `source.assignee`')
    expect(row!.detail).toContain('lingtai doctor --fix')
  })

  it('is ok for a recipe that resolves, and a skip for another refusal or streams that cannot be read', () => {
    expect(recipeSpellings([{ project: 'a', ok: true } as never])[0]!.status).toBe('ok')
    expect(recipeSpellings([{ project: 'x', ok: false, problem: 'bad' }])[0]!.status).toBe('skip')
    expect(recipeSpellings(null)[0]!.status).toBe('skip')
  })
})

describe('fixOldSpellings', () => {
  it('rewrites the file, keeps unrelated comments, appends one change, and a second run does nothing', async () => {
    const w = world({ [recipePath('app', HOME)]: OLD })
    const [first] = (await w.fix(['app']))!
    expect(first).toMatchObject({ project: 'app', outcome: 'written' })
    const text = w.disk.get(recipePath('app', HOME))!
    expect(text).toContain('# keep me')
    expect(text).toContain('# stays')
    expect(text).not.toContain('# goes')
    const after = resolveSource(text, 'main', 'recipe.yml')
    expect(after.recipe.branch.main).toBe('develop')
    expect(after.recipe.source.assignee?.take).toBe('all')
    expect(text).not.toContain('runtime.assignee')
    expect(await w.events('app')).toEqual([expect.objectContaining({ by: 'human:me' })])

    const appended = (await w.store.read(projectStream('app'))).length
    const [second] = (await w.fix(['app']))!
    expect(second).toMatchObject({ outcome: 'nothing' })
    expect(w.disk.get(recipePath('app', HOME))).toBe(text)
    expect((await w.store.read(projectStream('app'))).length).toBe(appended)
  })

  it('rewrites take: both at a claim queue, which the intermediate widening parse used to refuse', async () => {
    const text = `version: 2
branch:
  main: develop
source:
  kinds: [bug]
env:
  plantAt: .env.local
runtime:
  agent: claude-code
steps:
  claim:
    - name: take
      queue:
        kinds: [bug]
        exclude: []
        backoff: 1h
        assignee:
          take: both
`
    const w = world({ [recipePath('app', HOME)]: text })
    const [out] = (await w.fix(['app']))!
    expect(out).toMatchObject({ project: 'app', outcome: 'written' })
    const after = w.disk.get(recipePath('app', HOME))!
    expect(after).toContain('take: all')
    expect(after).not.toContain('both')
  })

  it("a worktree that held only admit's base is left as `worktree: {}`, and the fix says it failed", async () => {
    const text = `version: 2
source:
  kinds: [bug]
env:
  plantAt: .env.local
runtime:
  agent: claude-code
steps:
  admit:
    - name: cut
      worktree:
        base: develop
`
    const w = world({ [recipePath('app', HOME)]: text })
    const [out] = (await w.fix(['app']))!
    // `submodules` is required and has no default, so no value is guessed: the file stays as it was.
    expect(out).toMatchObject({ project: 'app', outcome: 'failed' })
    expect(w.disk.get(recipePath('app', HOME))).toBe(text)
  })

  it('a project that fails does not stop the next, and the failure is named', async () => {
    const w = world({ [recipePath('a', HOME)]: OLD, [recipePath('b', HOME)]: OLD }, 'a')
    const out = (await w.fix(['a', 'b']))!
    expect(out.map((f) => f.outcome)).toEqual(['failed', 'written'])
    expect(renderSpellingFixes(out).join('\n')).toContain('a: not fixed')
  })

  it('a recipe lookup that fails for another reason is failed, not nothing to fix', async () => {
    const w = world({})
    const out = await Effect.runPromise(
      fixOldSpellings(
        () => Effect.succeed([{ project: 'app' } as ProjectState]),
        { recipe: () => Effect.fail(new Error('database down')) },
        { by: 'human:me', store: w.store, home: HOME },
      ),
    )
    expect(out).toEqual([{ project: 'app', outcome: 'failed', detail: 'database down' }])
  })

  it('answers null where the project streams cannot be read, and writes nothing', async () => {
    const w = world({})
    const out = await Effect.runPromise(
      fixOldSpellings(() => Effect.fail(new Error('down')), {}, { by: 'human:me', store: w.store, home: HOME }),
    )
    expect(out).toBeNull()
  })
})

describe('fixRefusal', () => {
  it('refuses --fix with --json by name, and nothing else', () => {
    expect(fixRefusal({ fix: true, json: true })).toMatch(/--fix.*--json/)
    expect(fixRefusal({ fix: true, json: false })).toBeNull()
    expect(fixRefusal({ fix: false, json: true })).toBeNull()
  })
})
