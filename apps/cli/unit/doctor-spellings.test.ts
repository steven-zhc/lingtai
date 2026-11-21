/** #1307: the `recipe: <project> spelling` row, `--fix`, and the refusal of `--fix --json`. */
import { projectStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { ProjectFiles, recipePath } from '@lingtai/project'
import { resolveSource, type RecipeFiles } from '@lingtai/recipe'
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
            Effect.sync(() => resolveSource(disk.get(recipePath(state.project!, HOME)) ?? '', 'main', 'recipe.yml')),
        },
        { by: 'human:me', store, home: HOME },
      ).pipe(Effect.provideService(ProjectFiles, files)),
    )
  const events = async (p: string) => (await store.read(projectStream(p))).map((e) => e.data as { by: string })
  return { disk, store, fix, events }
}

describe('recipeSpellings', () => {
  const resolved = resolveSource(OLD, 'main', 'recipe.yml')
  const filter = (project: string, oldSpellings: readonly string[]) =>
    ({ project, ok: true, oldSpellings, recipe: resolved.recipe }) as never

  it('warns, naming each old key and the command', () => {
    const [row] = recipeSpellings([filter('app', resolved.oldSpellings)])
    expect(row).toMatchObject({ name: 'recipe: app spelling', status: 'warn', fix: 'lingtai doctor --fix' })
    expect(row!.detail).toContain('repo.base: develop → branch.main: develop')
    expect(row!.detail).toContain('runtime.assignee.take: both → take: all')
  })

  it('is ok with none, and a skip for a recipe that does not resolve or streams that cannot be read', () => {
    expect(recipeSpellings([filter('app', [])])[0]!.status).toBe('ok')
    expect(recipeSpellings([{ project: 'x', ok: false, problem: 'bad' }])[0]!.status).toBe('skip')
    expect(recipeSpellings(null)[0]!.status).toBe('skip')
  })
})

describe('fixOldSpellings', () => {
  it('rewrites the file, keeps unrelated comments, appends one change, and a second run does nothing', async () => {
    const w = world({ [recipePath('app', HOME)]: OLD })
    const before = resolveSource(OLD, 'main', 'recipe.yml')
    const [first] = (await w.fix(['app']))!
    expect(first).toMatchObject({ project: 'app', outcome: 'written' })
    const text = w.disk.get(recipePath('app', HOME))!
    expect(text).toContain('# keep me')
    expect(text).toContain('# stays')
    expect(text).toContain('# on the take')
    expect(text).not.toContain('# goes')
    const after = resolveSource(text, 'main', 'recipe.yml')
    expect(after.oldSpellings).toEqual([])
    expect(after.configHash).toBe(before.configHash)
    expect(await w.events('app')).toEqual([expect.objectContaining({ by: 'human:me' })])

    const appended = (await w.store.read(projectStream('app'))).length
    const [second] = (await w.fix(['app']))!
    expect(second).toMatchObject({ outcome: 'nothing' })
    expect(w.disk.get(recipePath('app', HOME))).toBe(text)
    expect((await w.store.read(projectStream('app'))).length).toBe(appended)
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
