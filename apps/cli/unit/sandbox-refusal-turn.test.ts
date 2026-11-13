/**
 * A recipe that requires a sandbox the host cannot provide refuses the project, per project (#1147).
 *
 * The per-project half of a pass, on the memory log, with `currentRecipe` as the daemon's turn calls it and the
 * host answer a counting fake: nothing here spawns `bwrap`. The refusal is one `ProjectRefused` however many
 * sweeps see it, and the first sweep after the host can is the `ProjectRecovered` (0126: not a pause).
 */
import { currentRecipe, loadProject } from '@lingtai/conductor'
import { projectStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { recipePath } from '@lingtai/recipe'
import { fakeSandboxHost } from '@lingtai/recipe/test/sandbox-host'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { type TurnOutcome, conductProjects } from '../src/conduct.ts'

const HOME = '/home/me/.lingtai'
const PROJECT = 'app'
const RECIPE = `version: 2
repo:
  base: main
source:
  kinds: [bug]
env:
  plantAt: .env.local
steps:
  proposed:
    - name: build
      run: pnpm test
sandbox:
  required: true
`

describe('a required sandbox on a host that cannot provide it', () => {
  it('appends one ProjectRefused over two sweeps, and a ProjectRecovered once the host can', async () => {
    const store = createMemoryEventStore()
    await store.append(projectStream(PROJECT), 0, [
      {
        type: 'ProjectConfigured',
        actor: 'conductor',
        data: { project: PROJECT, owner: null, base: 'main', configHash: 'h', fromSha: 's' },
      },
    ])
    let can = false
    const host = fakeSandboxHost({ can: () => can })

    const sweep = async (): Promise<TurnOutcome> => {
      const state = (await loadProject(PROJECT, store))!
      return Effect.runPromise(
        conductProjects({
          projects: [state],
          codeSha: 'a'.repeat(40),
          store,
          outcome: { projects: 0, ran: 0, refused: [] },
          log: () => {},
          work: (project, where) =>
            Effect.promise(async () => {
              where.ref = 'main'
              await currentRecipe(project, undefined, 'main', {
                home: HOME,
                signedIn: async () => ['claude-code'],
                read: async (p) => (p === recipePath(PROJECT, HOME) ? RECIPE : null),
                ...host,
              })
              return 'looked' as const
            }),
        }),
      )
    }
    const types = async () => (await store.read(projectStream(PROJECT))).map((e) => e.type)

    expect((await sweep()).refused).toHaveLength(1)
    expect((await sweep()).refused).toHaveLength(1)
    expect(await types()).toEqual(['ProjectConfigured', 'ProjectRefused'])
    const refused = (await store.read(projectStream(PROJECT)))[1]!
    expect((refused.data as { detail: string }).detail).toContain('sandbox.required:')

    can = true
    expect((await sweep()).refused).toEqual([])
    expect((await sweep()).refused).toEqual([])
    expect(await types()).toEqual(['ProjectConfigured', 'ProjectRefused', 'ProjectRecovered'])
    expect(host.asked.host).toBe(4)
  })
})
