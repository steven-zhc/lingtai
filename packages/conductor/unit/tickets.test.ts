/**
 * `Tickets` (`#377`): the type pins and the one implementation this run has,
 * run against the shared contract.
 *
 * **`expectTypeOf` is not enough.** Vitest's run mode does not typecheck, so a
 * broken pin stays green here. What catches it is `pnpm typecheck` — the
 * conductor's `tsc --noEmit` includes `unit/` — so the two assignments below
 * are a `tsc` claim, never a `pnpm test` one.
 */
import type { GitHubClient } from '@lingtai/github'
import { describe, expect, it } from 'vitest'

import type { PassClient } from '../src/conduct.ts'
import type { IssueChannel } from '../src/tell.ts'
import type { Tickets } from '../src/ticket-store.ts'
import { type MemoryTickets, memoryTickets } from '../test/memory-tickets.ts'
import { describeTicketsContract } from '../test/tickets-contract.ts'

/**
 * A GitHub whose `Tickets` methods it does not have is a `Tickets` that lost
 * one. Written as an assignment rather than `satisfies`, because there is no
 * value of `GitHubClient` to hand `satisfies` here — `createGitHubClient`
 * needs a network.
 */
const _gitHubSatisfiesTickets: Tickets = {} as GitHubClient

/**
 * `IssueChannel` is `Tickets` narrowed on `getIssue`'s return — see `tell.ts`'s
 * header. This is the other half of the ticket's type-level requirement: a
 * `Tickets` must still satisfy the write side the way the full `GitHubClient`
 * does today.
 */
const _ticketsSatisfiesIssueChannel: IssueChannel = {} as Tickets

/**
 * `PassClient` (`conduct.ts`, `#378`) is `Tickets & RefChannel` plus `owner`
 * and `repo` — the same claim as the two pins above, made about the type
 * every caller still hands `runOnce` a real `GitHubClient` for.
 */
const _gitHubSatisfiesPassClient: PassClient = {} as GitHubClient

describeTicketsContract<MemoryTickets>('memoryTickets', () => memoryTickets(), {
  commentBodies: (t, issue) => t.commentBodies(issue),
})

describe('memoryTickets, beyond the shared contract', () => {
  it('touches no clock by default: a created ticket is stamped by the synthetic counter, not the wall clock', async () => {
    const t = memoryTickets()
    await t.createIssue({ title: 'a', body: '', labels: [] })
    await t.createIssue({ title: 'b', body: '', labels: [] })

    // The synthetic counter starts at the epoch, so nothing it stamps is "at
    // or after" a cutoff near the real now — were this reading `Date.now()`
    // instead, both tickets would land on the near side of that cutoff.
    const sinceNearRealNow = await t.listIssuesSince(new Date(Date.now() - 1000))
    expect(sinceNearRealNow).toEqual([])
  })

  it("listIssuesSince filters on the creation time it stored, placed exactly by an injected clock", async () => {
    const times = [new Date('2026-01-01T00:00:00Z'), new Date('2026-01-02T00:00:00Z'), new Date('2026-01-03T00:00:00Z')]
    let i = 0
    const t = memoryTickets({ now: () => times[i++]! })

    const first = await t.createIssue({ title: 'first', body: '', labels: [] })
    const second = await t.createIssue({ title: 'second', body: '', labels: [] })
    const third = await t.createIssue({ title: 'third', body: '', labels: [] })

    const sinceSecond = (await t.listIssuesSince(times[1]!)).map((x) => x.number)
    expect(sinceSecond).toEqual([second.number, third.number])
    expect(sinceSecond).not.toContain(first.number)
  })

  it('getIssue rejects for an unknown number rather than answering a stub', async () => {
    const t = memoryTickets()
    await expect(t.getIssue(1)).rejects.toBeTruthy()
  })

  it('comment stores the body rather than discarding it, and appends rather than overwriting', async () => {
    const t = memoryTickets()
    const created = await t.createIssue({ title: 'x', body: '', labels: [] })

    await t.comment(created.number, 'first')
    await t.comment(created.number, 'second')

    expect(t.commentBodies(created.number)).toEqual(['first', 'second'])
  })

  it('dependencies is { blockedBy: 0 }, never null — a rule on this implementation, not on every Tickets (ticket-store.ts)', async () => {
    const t = memoryTickets()
    const created = await t.createIssue({ title: 'x', body: '', labels: [] })

    const listing = (await t.listOpenIssues()).find((i) => i.number === created.number)
    expect(listing?.dependencies).toEqual({ blockedBy: 0 })
    const got = await t.getIssue(created.number)
    expect(got.dependencies).toEqual({ blockedBy: 0 })
  })

  it('returns copies: mutating a result does not change what the next call answers', async () => {
    const t = memoryTickets()
    const created = await t.createIssue({ title: 'x', body: '', labels: ['bug'] })
    const got = await t.getIssue(created.number)
    ;(got.labels as { name: string; color: string | null }[]).push({ name: 'intruder', color: null })

    const again = await t.getIssue(created.number)
    expect(again.labels.map((l) => l.name)).toEqual(['bug'])
  })
})
