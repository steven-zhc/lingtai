/**
 * **A base red twice opens one ticket, keyed by the first red commit since the last green** (#1266, 0108 §13).
 * Over the memory store and a fake `TicketStore`.
 */
import { baseStateOf, integrationStream, parsePayload } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { Recipe } from '@lingtai/recipe'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { proposeBaseFix } from '../src/base-fix.ts'
import { lookAtBase, passOverBaseRed } from '../src/base-red.ts'
import type { Offered } from '../src/discover.ts'
import type { ProposedRef, ProposedTicket, TicketStore } from '../src/ticket-store.ts'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const builds = [{ name: 'tests', run: 'pnpm test' }]
const recipe = {
  source: { kinds: ['fix', 'bug'] },
  steps: { build: builds, claim: [] },
} as unknown as Recipe
const stream = integrationStream('p', 'main')

async function check(store: ReturnType<typeof createMemoryEventStore>, sha: string, ok: boolean) {
  const at = (await store.read(stream)).length
  await store.append(stream, at, [
    {
      type: 'BaseChecked',
      actor: 'conductor',
      data: parsePayload('BaseChecked', {
        base: 'main',
        baseSha: sha,
        command: 'pnpm test',
        ok,
        exitCode: ok ? 0 : 1,
        durationMs: 1,
        evidence: ok ? '' : 'FAIL a.test.ts',
        runId: `r${at}`,
      }),
    },
  ])
}

function fakeTickets(options: { fail?: boolean; ref?: string } = {}) {
  const proposed: ProposedTicket[] = []
  const withdrawn: string[][] = []
  const tickets: TicketStore = {
    source: 'fake',
    propose: (ticket) =>
      options.fail === true
        ? Effect.fail(new Error('github is down'))
        : Effect.sync((): ProposedRef => {
            proposed.push(ticket)
            return { externalRef: options.ref ?? '212', url: `https://x/${options.ref ?? '212'}`, created: true }
          }),
    withdraw: (...args) => Effect.sync(() => void withdrawn.push(args)),
  }
  return { tickets, proposed, withdrawn }
}

const propose = (store: ReturnType<typeof createMemoryEventStore>, tickets: TicketStore, notes: string[] = []) =>
  Effect.runPromise(
    proposeBaseFix({ store, tickets, project: 'p', base: 'main', recipe, note: (m) => void notes.push(m) }),
  )

const state = async (store: ReturnType<typeof createMemoryEventStore>) => {
  const s = baseStateOf(await store.read(stream), () => builds)
  if (!('red' in s)) throw new Error('not red')
  return s.red
}

describe('the key of the base-fix ticket', () => {
  it('is the first red since the last green, and moves only after a green', async () => {
    const store = createMemoryEventStore()
    await check(store, A, false)
    await check(store, B, false)
    expect((await state(store)).key).toBe(`base-red:main:${A}`)
    await check(store, B, true)
    await check(store, C, false)
    expect((await state(store)).key).toBe(`base-red:main:${C}`)
  })
})

describe('proposing the base-fix ticket', () => {
  it('proposes one ticket with the key, title, first kind and body, and records it', async () => {
    const store = createMemoryEventStore()
    await check(store, A, false)
    const { tickets, proposed } = fakeTickets()
    await propose(store, tickets)
    expect(proposed).toHaveLength(1)
    expect(proposed[0]).toMatchObject({
      key: `base-red:main:${A}`,
      title: 'fix(base): pnpm test is green on main again',
      kind: 'fix',
      labels: [],
    })
    expect(proposed[0]?.body).toContain('FAIL a.test.ts')
    expect(proposed[0]?.body).toContain('`pnpm test` exits 0 on `main`')
    const recorded = (await store.read(stream)).filter((e) => e.type === 'BaseFixProposed')
    expect(recorded).toHaveLength(1)
    expect((await state(store)).fix).toEqual({ externalRef: '212', url: 'https://x/212' })
  })

  it('proposes nothing for the same red again, nor on a later commit still red', async () => {
    const store = createMemoryEventStore()
    await check(store, A, false)
    const { tickets, proposed } = fakeTickets()
    await propose(store, tickets)
    await propose(store, tickets)
    await check(store, B, false)
    await propose(store, tickets)
    expect(proposed).toHaveLength(1)
  })

  it('proposes a second ticket for red, green, red again', async () => {
    const store = createMemoryEventStore()
    await check(store, A, false)
    const { tickets, proposed } = fakeTickets()
    await propose(store, tickets)
    await check(store, B, true)
    await check(store, C, false)
    await propose(store, tickets)
    expect(proposed.map((p) => p.key)).toEqual([`base-red:main:${A}`, `base-red:main:${C}`])
  })

  it('falls back to bug when the recipe has no kinds', async () => {
    const store = createMemoryEventStore()
    await check(store, A, false)
    const { tickets, proposed } = fakeTickets()
    await Effect.runPromise(
      proposeBaseFix({
        store,
        tickets,
        project: 'p',
        base: 'main',
        recipe: { source: { kinds: [] }, steps: { build: builds, claim: [] } } as unknown as Recipe,
        note: () => {},
      }),
    )
    expect(proposed[0]?.kind).toBe('bug')
  })

  it('says a failed propose and appends nothing', async () => {
    const store = createMemoryEventStore()
    await check(store, A, false)
    const notes: string[] = []
    await propose(store, fakeTickets({ fail: true }).tickets, notes)
    expect(notes.join('\n')).toContain('github is down')
    expect((await store.read(stream)).filter((e) => e.type === 'BaseFixProposed')).toEqual([])
  })

  it('retries when an unrelated append lands between the read and the write', async () => {
    const real = createMemoryEventStore()
    await check(real, A, false)
    let raced = false
    const store = {
      read: real.read.bind(real),
      append: async (...args: Parameters<typeof real.append>) => {
        if (!raced) {
          raced = true
          await check(real, A, false)
        }
        return real.append(...args)
      },
    } as unknown as ReturnType<typeof createMemoryEventStore>
    await propose(store, fakeTickets().tickets)
    expect((await real.read(stream)).filter((e) => e.type === 'BaseFixProposed')).toHaveLength(1)
  })

  it('withdraws its own ticket when another opener recorded the same key first', async () => {
    const real = createMemoryEventStore()
    await check(real, A, false)
    let raced = false
    const store = {
      read: real.read.bind(real),
      append: async (...args: Parameters<typeof real.append>) => {
        if (!raced) {
          raced = true
          const at = (await real.read(stream)).length
          await real.append(stream, at, [
            {
              type: 'BaseFixProposed',
              actor: 'conductor',
              data: parsePayload('BaseFixProposed', {
                project: 'p',
                base: 'main',
                baseSha: A,
                key: `base-red:main:${A}`,
                externalRef: '100',
                url: null,
              }),
            },
          ])
        }
        return real.append(...args)
      },
    } as unknown as ReturnType<typeof createMemoryEventStore>
    const { tickets, withdrawn } = fakeTickets({ ref: '212' })
    await propose(store, tickets)
    expect(withdrawn.map((w) => [w[0], w[1]])).toEqual([['212', '100']])
    expect((await real.read(stream)).filter((e) => e.type === 'BaseFixProposed')).toHaveLength(1)
  })
})

describe('the look with a base-fix ticket', () => {
  const offered = (...refs: number[]): Offered => ({
    runnable: refs.map((n) => ({ ref: String(n), title: `t${n}`, kind: 'bug', parent: null, subIssues: null })),
    skipped: [],
    kindColors: {},
    dependenciesUnread: null,
  })

  async function held() {
    const store = createMemoryEventStore()
    await check(store, A, false)
    await propose(store, fakeTickets().tickets)
    return Effect.runPromise(lookAtBase({ store, project: 'p', base: 'main', recipe }, Effect.succeed({ at: A })))
  }

  it('offers the fix ticket alone and skips the rest as base-red', async () => {
    const { offered: after, line } = passOverBaseRed(await held(), offered(7, 212, 9))
    expect(after.runnable.map((r) => r.ref)).toEqual(['212'])
    expect(after.skipped.map((s) => [s.ref, s.reason])).toEqual([
      [7, 'base-red'],
      [9, 'base-red'],
    ])
    expect(line).toContain('offering #212 to fix it')
  })

  it('skips everything, and names the ticket, when it is not in the queue', async () => {
    const { offered: after, line } = passOverBaseRed(await held(), offered(7))
    expect(after.runnable).toEqual([])
    expect(line).toContain('#212, opened to fix it, is not in the queue')
  })
})

describe('a failure after the ticket exists', () => {
  it('names the ticket it opened when recording it fails', async () => {
    const real = createMemoryEventStore()
    await check(real, A, false)
    const store = {
      read: real.read.bind(real),
      append: async () => {
        throw new Error('disk full')
      },
    } as unknown as ReturnType<typeof createMemoryEventStore>
    const notes: string[] = []
    await propose(store, fakeTickets().tickets, notes)
    expect(notes.join('\n')).toContain('https://x/212')
    expect(notes.join('\n')).not.toContain('no ticket was opened')
  })
})
