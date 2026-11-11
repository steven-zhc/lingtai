import { makeGuard } from '@lingtai/daemon'
/** `lingtai pause` / `resume` / `now` over a memory store (#992). */
import { pauseConductor, readControl, requestShutdown } from '@lingtai/daemon/control'
import { CONTROL_STREAM, projectStream, reduceProject } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { pausedProjects } from '../src/doctor.ts'
import { nowVerdict } from '../src/now.ts'
import { pauseProjects, refuseIfLocked, resumeProjects } from '../src/project-pause.ts'

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
    await pauseConductor('human:a', 'because', w.store)
    w.lines.length = 0
    await Effect.runPromise(resumeProjects(undefined, 'human:a', w.options))
    expect(w.lines).toContain('lingtai: resumed')
    expect(w.lines.join('\n')).toContain('lifted the conductor-wide pause (cause person)')
    expect((await w.store.read(CONTROL_STREAM)).map((e) => e.type)).toEqual(['ConductorPaused', 'ConductorResumed'])
    expect(await w.types('other')).toEqual(['ProjectConfigured'])
  })

  it('bare resume with nothing standing appends nothing', async () => {
    const w = await world()
    await Effect.runPromise(resumeProjects(undefined, 'human:a', w.options))
    expect(w.lines).toEqual(['nothing to resume'])
    expect(await w.store.read(CONTROL_STREAM)).toEqual([])
  })

  it('reports the pause it lifted, not the one it first read, when the ceiling pauses in between', async () => {
    const w = await world()
    const real = w.store.head.bind(w.store)
    let raced = false
    // A drain stands, and the ceiling's pause lands before the first read: the append at the stale head is retried.
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
                reason: 'day ceiling',
                until: new Date(Date.now() + 3_600_000).toISOString(),
                cause: 'day-ceiling',
              },
            },
          ])
        }
        return h
      },
    })
    await Effect.runPromise(resumeProjects(undefined, 'human:a', { ...w.options, store }))
    expect(w.lines.join('\n')).toContain("also lifted today's spend ceiling")
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

  it('says the ceiling is waived when it lifts the day ceiling pause', async () => {
    const w = await world()
    const until = new Date(Date.now() + 3_600_000)
    await w.store.append(CONTROL_STREAM, 0, [
      {
        type: 'ConductorPaused',
        actor: 'conductor',
        data: { by: 'lingtai', reason: 'day ceiling', until: until.toISOString(), cause: 'day-ceiling' },
      },
    ])
    await Effect.runPromise(resumeProjects(undefined, 'human:a', w.options))
    expect(w.lines.join('\n')).toContain("also lifted today's spend ceiling")
    expect(w.lines.join('\n')).toContain('it is not checked again today')
  })
})

describe('lingtai now on a paused project', () => {
  it('refuses with exit 1 and appends no RunRequested', async () => {
    const w = await world()
    await Effect.runPromise(pauseProjects('lingtai', 'human:a', w.options))
    let requested = 0
    const answered = await nowVerdict(
      'lingtai',
      7,
      'human:a',
      (async () => void (requested += 1)) as never,
      makeGuard({ store: w.store }),
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

describe('lingtai doctor', () => {
  it('lists a paused project as info, and nothing when none is', async () => {
    const w = await world()
    expect(await pausedProjects(w.projects)).toEqual([])
    await Effect.runPromise(pauseProjects('lingtai', 'human:a', w.options))
    const rows = await pausedProjects(w.projects)
    expect(rows).toMatchObject([{ name: 'daemon: paused projects', status: 'info' }])
    expect(rows[0]!.detail).toContain('lingtai (by human:a since ')
  })
})
