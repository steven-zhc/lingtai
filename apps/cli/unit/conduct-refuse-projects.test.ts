/**
 * A turn-wide refusal is recorded on each project it skipped, once (#1477).
 *
 * `conductorTurn` reaches the default log and the environment with no seam, so
 * the recording is the exported `refuseProjects`, driven here over the memory
 * store; that the hook branch calls it is visible only in the diff.
 */
import { projectStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { readProject } from '@lingtai/project'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { conductProjects, refuseProjects } from '../src/conduct.ts'

const detail = 'no lingtai-hook binary at /x/lingtai-hook'

async function setup() {
  const store = createMemoryEventStore()
  for (const project of ['first', 'second']) {
    await store.append(projectStream(project), 0, [
      {
        type: 'ProjectConfigured',
        actor: 'conductor',
        data: { project, owner: 'steven-zhc', base: 'main', configHash: 'h', fromSha: 's' },
      },
    ])
  }
  const read = async () => [(await readProject('first', store))!, (await readProject('second', store))!]
  const types = async (project: string) => (await store.read(projectStream(project))).map((e) => e.type)
  return { store, read, types }
}

describe('refuseProjects', () => {
  it('records one ProjectRefused per project, and a second identical turn records nothing', async () => {
    const { store, read, types } = await setup()
    const turn = async () =>
      Effect.runPromise(refuseProjects(await read(), detail, { store, codeSha: 'abc', log: () => {} }))
    await turn()
    await turn()
    for (const p of ['first', 'second']) expect((await types(p)).filter((t) => t === 'ProjectRefused')).toHaveLength(1)
    expect((await read())[0]!.refused?.detail).toBe(detail)
  })

  it('is followed by ProjectRecovered on the first turn that looks at the project again', async () => {
    const { store, read, types } = await setup()
    await Effect.runPromise(refuseProjects(await read(), detail, { store, codeSha: null, log: () => {} }))
    await Effect.runPromise(
      conductProjects({
        projects: await read(),
        codeSha: null,
        store,
        outcome: { projects: 0, ran: 0, refused: [] },
        log: () => {},
        work: () => Effect.succeed('looked' as const),
      }),
    )
    expect((await types('first')).filter((t) => t === 'ProjectRecovered')).toHaveLength(1)
    expect((await read())[0]!.refused).toBeNull()
  })
})
