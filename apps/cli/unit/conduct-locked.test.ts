/**
 * One project's lock skips that project and no other (0126); the conductor-wide
 * pause still ends the whole pass.
 */
import { loadProject, reachAccountLimit } from '@lingtai/conductor'
import { CeilingUnchecked, type Guard, lockedEffect, makeGuard } from '@lingtai/daemon'
import { accountStream, projectStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { conductProjects } from '../src/conduct.ts'

const runConduct = (o: Parameters<typeof conductProjects>[0]) => Effect.runPromise(conductProjects(o))
/** The ports are Effects; these fakes are written as promises. */
const effectOf =
  <A extends unknown[], B extends string | null>(f: (...a: A) => Promise<B>) =>
  (...a: A) =>
    Effect.promise(() => f(...a))

async function twoProjects() {
  const store = createMemoryEventStore()
  for (const project of ['first', 'second', 'third']) {
    await store.append(projectStream(project), 0, [
      {
        type: 'ProjectConfigured',
        actor: 'conductor',
        data: { project, owner: 'o', base: 'main', configHash: 'h', fromSha: 's' },
      },
    ])
  }
  const projects = [
    (await loadProject('first', store))!,
    (await loadProject('second', store))!,
    (await loadProject('third', store))!,
  ]
  return { store, projects }
}

describe('a pass with one project locked', () => {
  it('looks at the others and reports the locked one as not looked at', async () => {
    const { store, projects } = await twoProjects()
    const entered: string[] = []
    const lines: string[] = []
    const outcome = await runConduct({
      projects,
      codeSha: null,
      store,
      outcome: { projects: 0, ran: 0, refused: [] },
      log: (l) => lines.push(l),
      locked: effectOf(async (name) => (name === 'first' ? 'first is paused by human:a since then' : null)),
      work: effectOf(async (project) => {
        entered.push(project.project!)
        return 'looked-away'
      }),
    })
    expect(entered).toEqual(['second', 'third'])
    expect(outcome.projects).toBe(2)
    expect(lines).toContain('first: not looked at — first is paused by human:a since then')
  })

  it('a read that failed skips that project too', async () => {
    const { store, projects } = await twoProjects()
    const entered: string[] = []
    await runConduct({
      projects,
      codeSha: null,
      store,
      outcome: { projects: 0, ran: 0, refused: [] },
      log: () => {},
      locked: effectOf(async (name) => (name === 'second' ? 'could not read whether second is paused — x' : null)),
      work: effectOf(async (project) => {
        entered.push(project.project!)
        return 'looked-away'
      }),
    })
    expect(entered).toEqual(['first', 'third'])
  })

  it('a conductor-wide pause still ends the pass', async () => {
    const { store, projects } = await twoProjects()
    const entered: string[] = []
    const lines: string[] = []
    await runConduct({
      projects,
      codeSha: null,
      store,
      outcome: { projects: 0, ran: 0, refused: [] },
      log: (l) => lines.push(l),
      paused: Effect.promise(async () => 'paused by human:ops — migrating'),
      locked: effectOf(async () => null),
      work: effectOf(async (project) => {
        entered.push(project.project!)
        return 'looked-away'
      }),
    })
    expect(entered).toEqual([])
    expect(lines).toEqual(['first: not looked at — paused by human:ops — migrating'])
  })

  it('skips the project that uses a limited runtime and looks at the other (#1009)', async () => {
    const { store, projects } = await twoProjects()
    await store.append(accountStream('claude-code'), 0, [
      {
        type: 'AccountLimitReached',
        actor: 'conductor',
        data: {
          runtime: 'claude-code',
          until: new Date(Date.now() + 3_600_000).toISOString(),
          untilFrom: 'message',
          said: 'limit',
        },
      },
    ])
    const guard = makeGuard({
      store,
      ceiling: {
        configuredUsd: () => undefined,
        todaysSpend: () => Effect.succeed({ reportedCents: 0, estimatedCents: 0 }),
      },
      recipeFor: async (state) =>
        ({ recipe: { runtime: { agent: state.project === 'first' ? 'claude-code' : 'codex' }, steps: {} } }) as never,
    })
    const entered: string[] = []
    const lines: string[] = []
    await runConduct({
      projects: projects.slice(0, 2),
      codeSha: null,
      store,
      outcome: { projects: 0, ran: 0, refused: [] },
      log: (l) => lines.push(l),
      locked: lockedEffect(guard),
      work: effectOf(async (project) => {
        entered.push(project.project!)
        return 'looked-away'
      }),
    })
    expect(entered).toEqual(['second'])
    expect(lines.find((l) => l.startsWith('first: not looked at'))).toContain("claude-code's usage limit")
  })

  it('a wall one project meets locks its runtime for the later projects of the same pass, and pauses nobody (#1011)', async () => {
    const { store, projects } = await twoProjects()
    const guard = makeGuard({
      store,
      ceiling: {
        configuredUsd: () => undefined,
        todaysSpend: () => Effect.succeed({ reportedCents: 0, estimatedCents: 0 }),
      },
      recipeFor: async (state) =>
        ({
          recipe: { runtime: { agent: state.project === 'second' ? 'codex' : 'claude-code' }, steps: {} },
        }) as never,
    })
    const entered: string[] = []
    const lines: string[] = []
    await runConduct({
      projects,
      codeSha: null,
      store,
      outcome: { projects: 0, ran: 0, refused: [] },
      log: (l) => lines.push(l),
      locked: lockedEffect(guard),
      work: effectOf(async (project) => {
        entered.push(project.project!)
        // What the attempt that met the wall does: it locks the runtime it dispatched.
        if (project.project === 'first') {
          await Effect.runPromise(
            reachAccountLimit(store, 'claude-code', {
              until: new Date(Date.now() + 3_600_000).toISOString(),
              untilFrom: 'message',
              said: 'limit',
            }),
          )
        }
        return 'looked-away'
      }),
    })
    expect(entered).toEqual(['first', 'second'])
    expect(lines.find((l) => l.startsWith('third: not looked at'))).toContain("claude-code's usage limit")
    expect(await store.read('ctl-conductor')).toEqual([])
  })
})

describe('lockedEffect over a guard whose read fails or dies', () => {
  const gated = async (guard: Guard) => {
    const { store, projects } = await twoProjects()
    const entered: string[] = []
    const lines: string[] = []
    await runConduct({
      projects: projects.slice(0, 1),
      codeSha: null,
      store,
      outcome: { projects: 0, ran: 0, refused: [] },
      log: (l) => lines.push(l),
      locked: lockedEffect(guard),
      work: effectOf(async (project) => {
        entered.push(project.project!)
        return 'looked-away'
      }),
    })
    return { entered, lines }
  }

  it('answers the ceiling sentence for a failure, and the look it gates starts nothing', async () => {
    const { entered, lines } = await gated({
      locksFor: () => Effect.fail(new CeilingUnchecked({ why: 'spend is behind' })),
    })
    expect(entered).toEqual([])
    expect(lines).toEqual([
      'first: not looked at — could not check the daily ceiling: spend is behind — taking no work',
    ])
  })

  it('answers the same sentence for a check that dies', async () => {
    const { entered, lines } = await gated({
      locksFor: () => Effect.die(new CeilingUnchecked({ why: 'spend is behind' })),
    })
    expect(entered).toEqual([])
    expect(lines).toEqual([
      'first: not looked at — could not check the daily ceiling: spend is behind — taking no work',
    ])
  })

  it('is told a read that died as a refusal of the project, not a look that ends', async () => {
    const { store, projects } = await twoProjects()
    const outcome = { projects: 0, ran: 0, refused: [] as { project: string; detail: string }[] }
    const lines: string[] = []
    await runConduct({
      projects: projects.slice(0, 1),
      codeSha: null,
      store,
      outcome,
      log: (l) => lines.push(l),
      work: () => Effect.die(new Error('x')),
    })
    expect(outcome.refused).toEqual([{ project: 'first', detail: 'x' }])
    expect(lines).toContain('first: x')
  })
})
