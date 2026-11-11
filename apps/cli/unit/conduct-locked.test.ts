/**
 * One project's lock skips that project and no other (0126); the conductor-wide
 * pause still ends the whole pass.
 */
import { loadProject } from '@lingtai/conductor'
import { projectStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

import { conductProjects } from '../src/conduct.ts'

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
    const outcome = await conductProjects({
      projects,
      codeSha: null,
      store,
      outcome: { projects: 0, ran: 0, refused: [] },
      log: (l) => lines.push(l),
      locked: async (name) => (name === 'first' ? 'first is paused by human:a since then' : null),
      work: async (project) => {
        entered.push(project.project!)
        return 'nothing'
      },
    })
    expect(entered).toEqual(['second', 'third'])
    expect(outcome.projects).toBe(2)
    expect(lines).toContain('first: not looked at — first is paused by human:a since then')
  })

  it('a read that failed skips that project too', async () => {
    const { store, projects } = await twoProjects()
    const entered: string[] = []
    await conductProjects({
      projects,
      codeSha: null,
      store,
      outcome: { projects: 0, ran: 0, refused: [] },
      log: () => {},
      locked: async (name) => (name === 'second' ? 'could not read whether second is paused — x' : null),
      work: async (project) => {
        entered.push(project.project!)
        return 'nothing'
      },
    })
    expect(entered).toEqual(['first', 'third'])
  })

  it('a conductor-wide pause still ends the pass', async () => {
    const { store, projects } = await twoProjects()
    const entered: string[] = []
    const lines: string[] = []
    await conductProjects({
      projects,
      codeSha: null,
      store,
      outcome: { projects: 0, ran: 0, refused: [] },
      log: (l) => lines.push(l),
      paused: async () => 'paused by human:ops — migrating',
      locked: async () => null,
      work: async (project) => {
        entered.push(project.project!)
        return 'nothing'
      },
    })
    expect(entered).toEqual([])
    expect(lines).toEqual(['first: not looked at — paused by human:ops — migrating'])
  })
})
