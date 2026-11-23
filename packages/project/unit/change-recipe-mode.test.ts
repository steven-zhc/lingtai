/** `changeRecipe` refuses team → solo while work is stranded (0130 §1, #1328): memory log, `Map` files. */
import { prStream, projectStream, ticketStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { EventStore } from '@lingtai/event-store/store'
import { type RecipeFiles } from '@lingtai/recipe'
import { fakeSandboxHost } from '@lingtai/recipe/test/sandbox-host'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { modeSwitchMessage } from '../src/change.ts'
import { ProjectFiles, changeRecipe, recipePath } from '../src/index.ts'
import { recordPrClosed, recordPrDraftOpened, recordPrInProgress, recordPrMerged, requestPrSubmit } from '../src/pr.ts'

const HOME = '/home/me/.lingtai'
const PATH = recipePath('app', HOME)
const BODY = `version: 2
branch:
  main: main
source:
  kinds: [bug]
  assignee:
    login: me
env:
  plantAt: .env.local
steps:
  proposed:
    - name: build
      run: pnpm test
`
const TEAM = `mode: team\n${BODY.replace('main: main', 'main: main\n  personal: team')}`
const SOLO = `mode: solo\n${BODY}`
const NONE = BODY

async function ticket(store: EventStore, issue: string, base: string, closed = false) {
  await store.append(ticketStream('app', issue), 0, [
    {
      type: 'TicketDiscovered',
      actor: 'conductor',
      data: { project: 'app', source: 'github-issue', externalRef: issue, title: `t${issue}`, kind: 'bug', labels: [] },
    },
    { type: 'TicketLanded', actor: 'conductor', data: { mergeCommit: `m${issue}`, base } },
    ...(closed ? [{ type: 'TicketClosed', actor: 'human:me', data: { by: 'human:me', reason: 'done' } }] : []),
  ])
}

const frozen = (tickets: string[]) => ({
  branch: 'team',
  main: 'main',
  frozenSha: 'f'.repeat(40),
  tickets: tickets.map((t) => ({ ticket: t, mergeCommit: `m${t}`, title: `t${t}` })),
})

async function world(initial: string, onRead?: (stream: string) => void) {
  const disk = new Map([[PATH, initial]])
  const store = createMemoryEventStore()
  await store.append(projectStream('app'), 0, [
    { type: 'ProjectRecipeChanged', actor: 'conductor', data: { sourceHash: 'h', source: initial, by: 'file' } },
  ])
  if (onRead !== undefined) {
    const read = store.read.bind(store)
    const head = store.head.bind(store)
    store.read = ((s: string, ...rest: unknown[]) => (onRead(s), (read as any)(s, ...rest))) as typeof store.read
    store.head = ((s: string, ...rest: unknown[]) => (onRead(s), (head as any)(s, ...rest))) as typeof store.head
  }
  const files: RecipeFiles = {
    read: async (p) => disk.get(p) ?? null,
    replace: async (p, t) => void disk.set(p, t),
  }
  const candidates = (issues: string[]) => () => Effect.succeed(issues.map((issue) => ({ issue })))
  const save = (next: string, issues: string[] = [], withPort = true) =>
    Effect.runPromise(
      changeRecipe(
        'app',
        {
          text: next,
          expected: disk.get(PATH) as string,
          base: 'main',
          signedIn: async () => ['claude-code' as const],
          hostFacts: fakeSandboxHost().hostFacts,
        },
        { by: 'human:me', store, home: HOME, ...(withPort ? { candidates: candidates(issues) } : {}) },
      ).pipe(Effect.provideService(ProjectFiles, files)),
    )
  return { disk, store, save, files, candidates }
}

describe('team → solo', () => {
  it('is refused naming a ticket landed on branch.personal, and writes nothing', async () => {
    const w = await world(TEAM)
    await ticket(w.store, '43', 'team')
    const before = (await w.store.read(projectStream('app'))).length
    const r = await w.save(SOLO, ['43'])
    expect(r).toMatchObject({ ok: false, reason: 'mode-switch' })
    expect((r as { message: string }).message).toContain('#43')
    expect(w.disk.get(PATH)).toBe(TEAM)
    expect((await w.store.read(projectStream('app'))).length).toBe(before)
  })

  it('is refused the same way for a ticket a person closed after it landed', async () => {
    const w = await world(TEAM)
    await ticket(w.store, '43', 'team', true)
    expect(await w.save(SOLO, ['43'])).toMatchObject({ ok: false, reason: 'mode-switch' })
  })

  it('is refused naming an open PR with an empty draft, whatever its column', async () => {
    const w = await world(TEAM)
    await ticket(w.store, '43', 'team')
    await Effect.runPromise(requestPrSubmit('app', 'team', 'human:me', w.store))
    const r = await w.save(SOLO, ['43'])
    expect(r).toMatchObject({ ok: false, reason: 'mode-switch' })
    expect((r as { message: string }).message).toContain('PR #1 is open')
    await Effect.runPromise(recordPrInProgress('app', 1, frozen(['43']), w.store))
    expect(await w.save(SOLO, ['43'])).toMatchObject({ ok: false, reason: 'mode-switch' })
  })

  it('is written when the only PR is merged and nothing landed since', async () => {
    const w = await world(TEAM)
    await ticket(w.store, '43', 'team')
    await Effect.runPromise(requestPrSubmit('app', 'team', 'human:me', w.store))
    await Effect.runPromise(recordPrInProgress('app', 1, frozen(['43']), w.store))
    await Effect.runPromise(recordPrMerged('app', 1, { how: 'host', headSha: 'a'.repeat(40), mergeSha: null }, w.store))
    expect(await w.save(SOLO, ['43'])).toMatchObject({ ok: true, written: true })
    expect(w.disk.get(PATH)).toBe(SOLO)
  })

  it('is refused naming the tickets of a PR closed without merging', async () => {
    const w = await world(TEAM)
    await ticket(w.store, '43', 'team')
    await Effect.runPromise(requestPrSubmit('app', 'team', 'human:me', w.store))
    await Effect.runPromise(recordPrInProgress('app', 1, frozen(['43']), w.store))
    await Effect.runPromise(
      recordPrDraftOpened('app', 1, { number: 9, nodeId: 'n', url: 'u', found: 'opened' }, w.store),
    )
    await Effect.runPromise(recordPrClosed('app', 1, { headSha: 'a'.repeat(40) }, w.store))
    const r = await w.save(SOLO, ['43'])
    expect(r).toMatchObject({ ok: false, reason: 'mode-switch' })
    expect((r as { message: string }).message).toContain('#43')
  })

  it('is refused the same way through the { changes } arm', async () => {
    const w = await world(TEAM)
    await ticket(w.store, '43', 'team')
    const r = await Effect.runPromise(
      changeRecipe(
        'app',
        {
          changes: [
            { path: ['mode'], value: 'solo' },
            { path: ['branch', 'personal'], value: undefined },
          ],
        },
        { by: 'human:me', store: w.store, home: HOME, candidates: w.candidates(['43']) },
      ).pipe(Effect.provideService(ProjectFiles, w.files)),
    )
    expect(r).toMatchObject({ ok: false, reason: 'mode-switch' })
    expect(w.disk.get(PATH)).toBe(TEAM)
  })

  it('is refused by name when the caller gave no way to read the draft', async () => {
    const w = await world(TEAM)
    expect(await w.save(SOLO, [], false)).toMatchObject({ ok: false, reason: 'mode-switch' })
    expect(w.disk.get(PATH)).toBe(TEAM)
  })

  it('fails the change, writing nothing, when a ticket stream cannot be read', async () => {
    const w = await world(TEAM)
    const read = w.store.read.bind(w.store)
    w.store.read = ((s: string, ...r: unknown[]) =>
      s.startsWith('ticket-') ? Promise.reject(new Error('boom')) : (read as any)(s, ...r)) as typeof w.store.read
    await expect(w.save(SOLO, ['43'])).rejects.toThrow('boom')
    expect(w.disk.get(PATH)).toBe(TEAM)
  })
})

describe('every other change reads no ticket or PR stream', () => {
  const guard = (s: string) => {
    if (s.startsWith('pr-') || s.startsWith('ticket-')) throw new Error(`read ${s}`)
  }

  it('solo → team is written', async () => {
    const w = await world(SOLO, guard)
    const r = await w.save(TEAM, [], false)
    expect(r).toMatchObject({ ok: true, written: true })
  })

  it('mode: solo over a file that named none is written', async () => {
    const w = await world(NONE, guard)
    expect(await w.save(SOLO, [], false)).toMatchObject({ ok: true, written: true })
  })

  it('a team edit that stays team is written', async () => {
    const w = await world(TEAM, guard)
    expect(await w.save(TEAM.replace('[bug]', '[bug, feature]'), [], false)).toMatchObject({ ok: true })
  })
})

describe('modeSwitchMessage', () => {
  const tickets = ['1', '2', '3', '4', '5', '6', '7'].map((ticket) => ({ ticket, mergeCommit: 'm', title: 't' }))
  it('names at most five tickets, then how many more', () => {
    const m = modeSwitchMessage('team', [], tickets)
    expect(m).toContain('#1, #2, #3, #4, #5 and 2 more')
    expect(m).not.toContain('#6')
  })
})

void prStream
