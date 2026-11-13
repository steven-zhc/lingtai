import { makeGuard } from '@lingtai/daemon'
/** `lingtai pause` / `resume` / `now` over a memory store (#992). */
import { readControl, requestShutdown } from '@lingtai/daemon/control'
import {
  type ProjectState,
  CONTROL_STREAM,
  accountStream,
  parsePayload,
  projectStream,
  reduceProject,
} from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { accountLimits, pausedProjects } from '../src/doctor.ts'
import { nowVerdict } from '../src/now.ts'
import { pauseProjects, refuseIfLocked, resumeProjects } from '../src/project-pause.ts'

/** The setup's pause, the one conductor-wide pause left, appended as `pauseConductorOnce` does. */
async function setupPause(store: ReturnType<typeof createMemoryEventStore>, reason: string): Promise<void> {
  await store.append(CONTROL_STREAM, await store.head(CONTROL_STREAM), [
    {
      type: 'ConductorPaused',
      actor: 'conductor',
      data: parsePayload('ConductorPaused', {
        by: 'lingtai',
        reason,
        until: null,
        cause: 'setup',
        holdsAcrossStarts: true,
      }),
    },
  ])
}

async function world(names: string[] = ['lingtai', 'other']) {
  const store = createMemoryEventStore()
  for (const project of names) {
    await store.append(projectStream(project), 0, [
      {
        type: 'ProjectConfigured',
        actor: 'conductor',
        data: { project, owner: 'o', base: 'main', configHash: 'h', fromSha: 's' },
      },
    ])
  }
  const projects = async () => Promise.all(names.map(async (n) => reduceProject(await store.read(projectStream(n)))))
  const lines: string[] = []
  const options = { store, projects, log: (l: string) => void lines.push(l) }
  const types = async (n: string) => (await store.read(projectStream(n))).map((e) => e.type)
  return { store, projects, lines, options, types }
}

describe('lingtai pause [project]', () => {
  it('pauses one project, then says already paused and appends nothing', async () => {
    const w = await world()
    expect(await Effect.runPromise(pauseProjects('lingtai', 'human:a', w.options))).toBe(0)
    expect(await w.types('lingtai')).toEqual(['ProjectConfigured', 'ProjectPaused'])
    expect(await w.types('other')).toEqual(['ProjectConfigured'])
    expect(w.lines[0]).toBe('lingtai: paused')

    w.lines.length = 0
    await Effect.runPromise(pauseProjects('lingtai', 'human:b', w.options))
    expect(await w.types('lingtai')).toEqual(['ProjectConfigured', 'ProjectPaused'])
    expect(w.lines[0]).toMatch(/^lingtai: already paused by human:a since /)

    // A stale project list does not name the actor: the standing pause does.
    const stale = async () =>
      [reduceProject(await w.store.read(projectStream('lingtai')))].map((p) => ({
        ...p,
        paused: { by: 'human:old', at: new Date(0) },
      }))
    w.lines.length = 0
    await Effect.runPromise(pauseProjects('lingtai', 'human:c', { ...w.options, projects: stale as never }))
    expect(w.lines[0]).toMatch(/^lingtai: already paused by human:a since /)
    expect(w.lines.at(-1)).toContain('an attempt already in flight finishes; nothing new starts')
  })

  it('bare pause pauses every project and appends no ConductorPaused', async () => {
    const w = await world()
    await Effect.runPromise(pauseProjects(undefined, 'human:a', w.options))
    expect(await w.types('lingtai')).toContain('ProjectPaused')
    expect(await w.types('other')).toContain('ProjectPaused')
    expect(await w.store.read(CONTROL_STREAM)).toEqual([])
  })

  it('refuses an unknown name with exit 2, the registered list, and no append', async () => {
    const w = await world()
    expect(await Effect.runPromise(pauseProjects('nosuch', 'human:a', w.options))).toBe(2)
    expect(w.lines.join('\n')).toContain('registered: lingtai, other')
    expect(await w.types('lingtai')).toEqual(['ProjectConfigured'])
  })
})

describe('lingtai resume [project]', () => {
  it('resumes a paused project, and says not paused otherwise', async () => {
    const w = await world()
    await Effect.runPromise(pauseProjects('lingtai', 'human:a', w.options))
    w.lines.length = 0
    await Effect.runPromise(resumeProjects('lingtai', 'human:a', w.options))
    await Effect.runPromise(resumeProjects('lingtai', 'human:a', w.options))
    expect(w.lines).toEqual(['lingtai: resumed', 'lingtai: not paused'])
    expect(await w.types('lingtai')).toEqual(['ProjectConfigured', 'ProjectPaused', 'ProjectResumed'])
    expect(await Effect.runPromise(resumeProjects('nosuch', 'human:a', w.options))).toBe(2)
  })

  it('bare resume lifts paused projects and a standing ConductorPaused', async () => {
    const w = await world()
    await Effect.runPromise(pauseProjects('lingtai', 'human:a', w.options))
    await setupPause(w.store, 'because')
    w.lines.length = 0
    await Effect.runPromise(resumeProjects(undefined, 'human:a', w.options))
    expect(w.lines).toContain('lingtai: resumed')
    expect(w.lines.join('\n')).toContain("lifted the setup's pause — because")
    expect((await w.store.read(CONTROL_STREAM)).map((e) => e.type)).toEqual(['ConductorPaused', 'ConductorResumed'])
    expect(await w.types('other')).toEqual(['ProjectConfigured'])
  })

  it("bare resume reads a person's old ConductorPaused as nothing standing", async () => {
    const w = await world()
    await w.store.append(CONTROL_STREAM, 0, [
      {
        type: 'ConductorPaused',
        actor: 'human:a',
        data: parsePayload('ConductorPaused', { by: 'human:a', reason: 'old', until: null, cause: 'person' }),
      },
    ])
    await Effect.runPromise(resumeProjects(undefined, 'human:a', w.options))
    expect(w.lines).toEqual(['nothing to resume'])
    expect((await w.store.read(CONTROL_STREAM)).map((e) => e.type)).toEqual(['ConductorPaused'])
  })

  it('bare resume with nothing standing appends nothing', async () => {
    const w = await world()
    await Effect.runPromise(resumeProjects(undefined, 'human:a', w.options))
    expect(w.lines).toEqual(['nothing to resume'])
    expect(await w.store.read(CONTROL_STREAM)).toEqual([])
  })

  it('reports the pause it lifted, not the one it first read, when the setup pauses in between', async () => {
    const w = await world()
    const real = w.store.head.bind(w.store)
    let raced = false
    // A drain stands, and the setup's pause lands before the first read: the append at the stale head is retried.
    await requestShutdown('human:a', 'x', null, w.store)
    const store = Object.assign(Object.create(w.store), {
      head: async (s: string) => {
        const h = await real(s)
        if (s === CONTROL_STREAM && !raced) {
          raced = true
          await w.store.append(CONTROL_STREAM, h, [
            {
              type: 'ConductorPaused',
              actor: 'conductor',
              data: {
                by: 'lingtai',
                reason: 'no tier',
                until: null,
                cause: 'setup',
                holdsAcrossStarts: true,
              },
            },
          ])
        }
        return h
      },
    })
    await Effect.runPromise(resumeProjects(undefined, 'human:a', { ...w.options, store }))
    expect(w.lines.join('\n')).toContain("lifted the setup's pause — no tier")
    // A resume is about the pause: the drain is still standing, and unmentioned.
    expect(w.lines.join('\n')).not.toContain('shutdown request')
    expect((await readControl(w.store)).shutdown).not.toBeNull()
  })

  it('appends nothing and says so when only a shutdown request stands', async () => {
    const w = await world()
    await requestShutdown('human:a', 'x', null, w.store)
    const before = await w.store.read(CONTROL_STREAM)
    await Effect.runPromise(resumeProjects(undefined, 'human:a', w.options))
    expect((await w.store.read(CONTROL_STREAM)).length).toBe(before.length)
    expect(w.lines.join('\n')).toContain('nothing to resume')
    expect(w.lines.join('\n')).not.toContain('shutdown request')
  })
})

describe('lingtai now on a paused project', () => {
  it('refuses with exit 1 and appends no RunRequested', async () => {
    const w = await world()
    await Effect.runPromise(pauseProjects('lingtai', 'human:a', w.options))
    let requested = 0
    const answered = await Effect.runPromise(
      nowVerdict(
        'lingtai',
        7,
        'human:a',
        (() => Effect.sync(() => void (requested += 1))) as never,
        makeGuard({ store: w.store, ceiling: 'not-the-holder' }),
      ),
    )
    expect(answered.code).toBe(1)
    expect(answered.verdict.detail).toMatch(/^lingtai is paused by human:a since .* — lingtai resume lingtai first$/)
    expect(requested).toBe(0)
  })

  it('says a failed read failed', async () => {
    const guard = { locksFor: () => Effect.fail(new Error('db down')) }
    expect(await Effect.runPromise(refuseIfLocked('lingtai', guard))).toBe(
      'could not read whether lingtai is paused — db down',
    )
  })
})

/** The world's project list, read as the Effect the checks take. */
const loaded = (w: { projects: () => Promise<ProjectState[]> }) => () => Effect.promise(() => w.projects())

describe('lingtai doctor', () => {
  it('lists a paused project as info, and nothing when none is', async () => {
    const w = await world()
    expect(await Effect.runPromise(pausedProjects(loaded(w)))).toEqual([])
    await Effect.runPromise(pauseProjects('lingtai', 'human:a', w.options))
    const rows = await Effect.runPromise(pausedProjects(loaded(w)))
    expect(rows).toMatchObject([{ name: 'daemon: paused projects', status: 'info' }])
    expect(rows[0]!.detail).toContain('lingtai (by human:a since ')
  })
})

describe('lingtai doctor: account limits (#1009)', () => {
  const until = new Date(2026, 10, 11, 23, 0)
  const recipeFor = (state: { project: string | null }) =>
    state.project === 'broken'
      ? Effect.die(new Error('schema error'))
      : Effect.succeed({
          recipe: { runtime: { agent: state.project === 'lingtai' ? 'claude-code' : 'codex' }, steps: {} },
        } as never)
  const limit = (store: Awaited<ReturnType<typeof world>>['options']['store']) =>
    store!.append(accountStream('claude-code'), 0, [
      {
        type: 'AccountLimitReached',
        actor: 'conductor',
        data: { runtime: 'claude-code', until: until.toISOString(), untilFrom: 'message', said: 'limit' },
      },
    ])

  it('gives one row naming who waits and who takes work, and none when nothing is limited', async () => {
    const w = await world()
    const store = w.options.store!
    expect(await Effect.runPromise(accountLimits(store, loaded(w), recipeFor))).toEqual([])
    await limit(store)
    const rows = await Effect.runPromise(
      accountLimits(store, loaded(w), recipeFor, () => new Date(2026, 10, 11, 20, 0)),
    )
    expect(rows).toMatchObject([{ name: 'account: claude-code', status: 'info' }])
    expect(rows[0]!.detail).toContain('at its usage limit until 23:00 (read from its message)')
    expect(rows[0]!.detail).toContain('waits: lingtai')
    expect(rows[0]!.detail).toContain('lingtai account lift claude-code once it is over')
  })

  it('does not list a paused project, or one held by another limited account, as taking work', async () => {
    const w = await world(['lingtai', 'other', 'third'])
    await limit(w.options.store!)
    await Effect.runPromise(pauseProjects('other', 'human:a', w.options))
    const rows = await Effect.runPromise(
      accountLimits(w.options.store!, loaded(w), recipeFor, () => new Date(2026, 10, 11, 20, 0)),
    )
    expect(rows[0]!.detail).toContain('takes work: third')
    expect(rows[0]!.detail).not.toContain('takes work: other')
    expect(rows[0]!.detail).not.toMatch(/takes work:.*other/)
    // codex limited too: the project that uses only codex waits as well.
    await w.options.store!.append(accountStream('codex'), 0, [
      {
        type: 'AccountLimitReached',
        actor: 'conductor',
        data: { runtime: 'codex', until: until.toISOString(), untilFrom: 'message', said: 'limit' },
      },
    ])
    const both = await Effect.runPromise(
      accountLimits(w.options.store!, loaded(w), recipeFor, () => new Date(2026, 10, 11, 20, 0)),
    )
    expect(both.find((r) => r.name === 'account: claude-code')!.detail).toContain('takes work: none')
  })

  it('says a passed limit lifts when the conductor next looks', async () => {
    const w = await world()
    await limit(w.options.store!)
    const rows = await Effect.runPromise(
      accountLimits(w.options.store!, loaded(w), recipeFor, () => new Date(2026, 10, 12, 1, 0)),
    )
    expect(rows[0]!.detail).toBe('until 2026-11-11 23:00 — passed; lifts when the conductor next looks')
  })
})
