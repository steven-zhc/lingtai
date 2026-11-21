/** `changeRecipe` (#1177): the file first, then the event naming who — a `Map` port and a memory log. */
import { projectStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { type RecipeFiles, sourceHashOf, sourceOf } from '@lingtai/recipe'
import { fakeSandboxHost, skipSandboxHost } from '@lingtai/recipe/test/sandbox-host'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { ProjectFiles, changeRecipe, loadProject, readProjectState, recipePath } from '../src/index.ts'

const HOME = '/home/me/.lingtai'
const PATH = recipePath('app', HOME)
const GOOD = `version: 2
branch:
  main: main
source:
  kinds: [bug]
env:
  plantAt: .env.local
steps:
  proposed:
    - name: build
      run: pnpm test
`
const EDITED = GOOD.replace('[bug]', '[bug, feature]')

function setup(initial: Record<string, string>, failReplace = false) {
  const disk = new Map(Object.entries(initial))
  const store = createMemoryEventStore()
  const order: string[] = []
  const files: RecipeFiles = {
    read: async (p) => disk.get(p) ?? null,
    replace: async (p, text) => {
      if (failReplace) throw new Error('disk full')
      order.push('replace')
      disk.set(p, text)
    },
  }
  const append = store.append.bind(store)
  store.append = ((...args: Parameters<typeof append>) => {
    order.push('append')
    return append(...args)
  }) as typeof store.append
  const run = <A, E>(e: Effect.Effect<A, E, never>) => Effect.runPromise(e)
  const text = (input: string, expected = GOOD, by = 'human:me') =>
    run(
      changeRecipe(
        'app',
        {
          text: input,
          expected,
          base: 'main',
          signedIn: async () => ['claude-code' as const],
          hostFacts: fakeSandboxHost().hostFacts,
        },
        { by, store, home: HOME },
      ).pipe(Effect.provideService(ProjectFiles, files)),
    )
  const eventsFull = async () =>
    (await store.read(projectStream('app'))).map((e) => {
      const d = e.data as { by: string; source: string }
      return { by: d.by, source: d.source }
    })
  const load = () =>
    run(
      loadProject('app', {
        home: HOME,
        store,
        base: 'main',
        ...skipSandboxHost,
        signedIn: async () => ['claude-code' as const],
      }).pipe(Effect.provideService(ProjectFiles, files), Effect.ignore),
    )
  const events = async () => (await store.read(projectStream('app'))).map((e) => e.data as { by: string })
  return { disk, store, order, files, text, events, eventsFull, load, run }
}

describe('changeRecipe', () => {
  it('writes the file, then appends who', async () => {
    const t = setup({ [PATH]: GOOD })
    expect(await t.text(EDITED)).toMatchObject({ ok: true, written: true })
    expect(t.order).toEqual(['replace', 'append'])
    expect(t.disk.get(PATH)).toBe(EDITED)
    expect((await t.events()).map((e) => e.by)).toEqual(['human:me'])
  })

  it('an equal text and a recorded hash write and append nothing', async () => {
    const t = setup({ [PATH]: GOOD })
    await t.text(EDITED)
    t.order.length = 0
    expect(await t.text(EDITED, EDITED)).toMatchObject({ ok: true, written: false })
    expect(t.order).toEqual([])
  })

  it('a file hand-edited away and saved back is written and appends nothing', async () => {
    const t = setup({ [PATH]: GOOD })
    await t.text(EDITED)
    t.disk.set(PATH, GOOD)
    t.order.length = 0
    expect(await t.text(EDITED, GOOD)).toMatchObject({ ok: true, written: true })
    expect(t.order).toEqual(['replace'])
  })

  it('a failed write appends nothing', async () => {
    const t = setup({ [PATH]: GOOD }, true)
    await expect(t.text(EDITED)).rejects.toThrow()
    expect(t.order).toEqual([])
    expect(await t.events()).toEqual([])
  })

  it('a failed append leaves the new file, and the next load records it by file', async () => {
    const t = setup({ [PATH]: GOOD })
    const append = t.store.append.bind(t.store)
    t.store.append = (async () => {
      throw new Error('log down')
    }) as typeof t.store.append
    await expect(t.text(EDITED)).rejects.toThrow(/written but not recorded/)
    expect(t.disk.get(PATH)).toBe(EDITED)
    t.store.append = append
    await t.run(
      loadProject('app', {
        home: HOME,
        store: t.store,
        base: 'main',
        ...skipSandboxHost,
        signedIn: async () => ['claude-code' as const],
      }).pipe(Effect.provideService(ProjectFiles, t.files), Effect.ignore),
    )
    expect((await t.events()).map((e) => e.by)).toEqual(['file'])
  })

  it('a change set is applied to the file and recorded by the caller', async () => {
    const t = setup({ [PATH]: GOOD })
    await t.run(
      changeRecipe(
        'app',
        { changes: [{ path: ['source', 'kinds'], value: ['bug', 'feature'] }] },
        { by: 'human:me', store: t.store, home: HOME },
      ).pipe(Effect.provideService(ProjectFiles, t.files)),
    )
    expect(t.order).toEqual(['replace', 'append'])
    expect((await t.events()).map((e) => e.by)).toEqual(['human:me'])
    expect((await readProjectState('app', t.store)).recipe?.by).toBe('human:me')
  })

  it('two saves at once each land with their own source and author', async () => {
    const t = setup({ [PATH]: GOOD })
    const B = EDITED.replace('feature', 'tech-debt')
    const [a, b] = await Promise.all([t.text(EDITED, GOOD, 'human:a'), t.text(B, GOOD, 'human:b')])
    const landed = await t.eventsFull()
    for (const [r, by, text] of [
      [a, 'human:a', EDITED],
      [b, 'human:b', B],
    ] as const) {
      if (r.ok) expect(landed).toContainEqual({ by, source: sourceOf(text) })
    }
    expect([a.ok, b.ok].filter(Boolean).length).toBeGreaterThanOrEqual(1)
    await t.load()
    const state = await readProjectState('app', t.store)
    expect(state.recipe?.sourceHash).toBe(sourceHashOf(sourceOf(t.disk.get(PATH)!)))
  })

  it('an interleaved pair records each writer’s own source, and the next load records the file by file', async () => {
    const t = setup({ [PATH]: GOOD })
    const B = EDITED.replace('feature', 'tech-debt')
    const append = t.store.append.bind(t.store)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let first = true
    t.store.append = (async (...args: Parameters<typeof append>) => {
      if (first) {
        first = false
        await gate
      }
      return append(...args)
    }) as typeof t.store.append
    const a = t.text(EDITED, GOOD, 'human:a')
    // A has written EDITED and is held before its append commits.
    while (t.disk.get(PATH) !== EDITED) await new Promise((r) => setTimeout(r, 0))
    expect(await t.text(B, EDITED, 'human:b')).toMatchObject({ ok: true, written: true })
    release()
    expect(await a).toMatchObject({ ok: true })
    expect(t.disk.get(PATH)).toBe(B)
    // Each event carries its own writer's source and author; nothing was read back from the file.
    expect(await t.eventsFull()).toEqual([
      { by: 'human:b', source: sourceOf(B) },
      { by: 'human:a', source: sourceOf(EDITED) },
    ])
    // The newest event is A's, not the file's; the next load records the file as it stands.
    await t.load()
    const events = await t.eventsFull()
    expect(events.at(-1)).toEqual({ by: 'file', source: sourceOf(B) })
    expect((await readProjectState('app', t.store)).recipe?.sourceHash).toBe(sourceHashOf(sourceOf(B)))
  })

  it('changes are applied to the snapshot they are compared with', async () => {
    const t = setup({ [PATH]: GOOD })
    const original = t.files.read
    let reads = 0
    t.files.read = async (p) => {
      const got = await original(p)
      // Another writer installs EDITED right after the first read of the file.
      if (++reads === 1) t.disk.set(PATH, EDITED)
      return got
    }
    // These changes turn EDITED back into GOOD's text: against the first read that is "no change".
    const r = await t.run(
      changeRecipe(
        'app',
        { changes: [{ path: ['source', 'kinds'], value: ['bug'] }] },
        { by: 'human:me', store: t.store, home: HOME },
      ).pipe(Effect.provideService(ProjectFiles, t.files)),
    )
    expect(r).toMatchObject({ ok: true })
    expect(t.disk.get(PATH)).toBe(await original(PATH))
    expect(await t.events()).toHaveLength(1)
  })
})
