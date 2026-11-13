/**
 * A pause one project's run appended stops the next project in the same pass
 * (#210).
 *
 * `conductorTurn` read the control stream once for the whole pass and then
 * walked every registered project. A run that meets an account-wide wall stands
 * the conductor down (0031 §3), and the project after it was claimed anyway,
 * straight into the same wall — the pause was on the log and nothing between
 * the two projects asked it.
 *
 * No database: `conductProjects` takes its store and each project's work as
 * parameters, so this is the per-project half with the work stood in for, as
 * `integration/conduct.test.ts` does on Postgres. The first project's work
 * appends the conductor's own pause; the claim is that the second is never
 * entered.
 */
import { loadProject } from '@lingtai/conductor'
import { readControl } from '@lingtai/daemon/control'
import { CONTROL_STREAM, projectStream } from '@lingtai/domain'
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

describe('a pass across several projects', () => {
  it('asks whether the conductor is paused before each project, not once for the pass', async () => {
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
    const projects = [(await loadProject('first', store))!, (await loadProject('second', store))!]

    const entered: string[] = []
    const lines: string[] = []
    const outcome = await runConduct({
      projects,
      codeSha: null,
      store,
      outcome: { projects: 0, ran: 0, refused: [] },
      log: (line) => lines.push(line),
      paused: Effect.promise(async () => {
        const c = await readControl(store)
        return c.paused ? `paused by ${c.by} — ${c.reason}` : null
      }),
      work: effectOf(async (project, where) => {
        entered.push(project.project!)
        where.ref = 'main'
        // What `pauseConductorOnce` appends over a tier a runtime cannot provide:
        // the conductor's own pause, the one that stops every project.
        await store.append(CONTROL_STREAM, (await store.read(CONTROL_STREAM)).length, [
          {
            type: 'ConductorPaused',
            actor: 'conductor',
            data: { by: 'lingtai', reason: 'the weekly limit', cause: 'setup', holdsAcrossStarts: true },
          },
        ])
        return 'looked'
      }),
    })

    expect(entered).toEqual(['first'])
    expect(outcome.projects).toBe(1)
    expect(lines.join('\n')).toContain('second: not looked at — paused by lingtai — the weekly limit')
  })
})
