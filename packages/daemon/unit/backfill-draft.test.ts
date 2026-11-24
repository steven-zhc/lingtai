/**
 * The start's reconcile backfills the draft of a team project and not of a solo one (#1394).
 */
import { prStream, ticketStream } from '@lingtai/domain'
import type { ProjectState } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { reconcileEffect } from '../src/reconcile.ts'
import type { DaemonStore } from '../src/store.ts'

type Recipe = Parameters<typeof import('@lingtai/project').backfillDraft>[1]
const daemonStore = { streams: () => Effect.succeed([] as string[]) } as unknown as DaemonStore

const projectOf = (name: string): ProjectState => ({
  project: name,
  owner: 'steven-zhc',
  base: 'main',
  configHash: 'seeded',
  fromSha: '0'.repeat(40),
  refused: null,
  paused: null,
  recipe: null,
  sandboxObserved: null,
  version: 1,
  lastSeq: null,
})

const recipeFor = (mode: 'team' | 'solo') =>
  ({ ...(mode === 'team' ? { mode } : {}), branch: { main: 'main', personal: 'team' } }) as unknown as Recipe

const landedTicket = (store: ReturnType<typeof createMemoryEventStore>, project: string) =>
  store.append(ticketStream(project, '1'), 0, [
    {
      type: 'TicketDiscovered',
      actor: 'conductor',
      data: { project, source: 'github-issue', externalRef: '1', title: 't', kind: 'bug', labels: [] },
    },
    { type: 'TicketLanded', actor: 'conductor', data: { mergeCommit: 'm1', base: 'team' } },
  ])

describe('the start backfills the draft', () => {
  it('asks for both projects and appends only on the team project', async () => {
    const store = createMemoryEventStore()
    await store.append('prj-team-p', 0, [
      {
        type: 'ProjectRecipeChanged',
        actor: 'conductor',
        data: { sourceHash: 'h', source: 'mode: team\n', by: 'file' },
      },
    ])
    await landedTicket(store, 'team-p')
    await landedTicket(store, 'solo-p')
    const asked: string[] = []
    const lines: string[] = []
    await Effect.runPromise(
      reconcileEffect({
        store,
        daemonStore,
        home: '/nonexistent',
        projects: [projectOf('team-p'), projectOf('solo-p')],
        log: (l) => lines.push(l),
        draft: {
          recipe: (p) => Effect.sync(() => (asked.push(p), recipeFor(p === 'team-p' ? 'team' : 'solo'))),
          candidates: () => Effect.succeed([{ issue: '1' }]),
        },
      }),
    )
    expect(asked).toEqual(['team-p', 'solo-p'])
    expect(await store.head(prStream('team-p', 1))).toBe(1)
    expect(await store.head(prStream('solo-p', 1))).toBe(0)
    expect(lines).toContain('backfilled 1 draft ticket(s) of team-p')
  })

  it('omitting the port skips the step without failing', async () => {
    const store = createMemoryEventStore()
    await landedTicket(store, 'team-p')
    await Effect.runPromise(
      reconcileEffect({ store, daemonStore, home: '/nonexistent', projects: [projectOf('team-p')] }),
    )
    expect(await store.head(prStream('team-p', 1))).toBe(0)
  })
})
