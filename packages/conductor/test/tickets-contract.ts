/**
 * What a `Tickets` is, stated once and run against every implementation
 * (`#377`), the same way `describeEventStoreContract`
 * (`packages/event-store/test/contract.ts`) is for `EventStore`.
 *
 * `make` is called once per case, so a fresh implementation never carries a
 * number or a label over from the case before it.
 *
 * **`since` for the "at or after" case is chosen wide rather than exact.** A
 * cutoff of the epoch, or of the year 3000, needs no cooperation from the
 * implementation's clock — real or synthetic — to land on the right side of
 * every ticket this suite creates, which is what keeps this file usable
 * against a future database-backed `Tickets` as well as against
 * `memoryTickets()`. Pinning the exact boundary against a controlled clock is
 * `unit/tickets.test.ts`'s, because only that implementation's clock is
 * something a test can place.
 *
 * **`commentBodies` is how this reaches a comment's stored text.** `Tickets`
 * itself carries no verb for reading one back, so a `comment` that drops the
 * body or overwrites the previous row instead of appending is, to anything
 * holding only a `Tickets`, indistinguishable from one that stored it — which
 * is exactly the gap `tell.ts`'s audit-trail rule cannot survive. Pass the
 * implementation's own inspection seam (`memoryTickets()`'s `commentBodies`, or
 * a database-backed implementation's own equivalent) and the comment case
 * verifies storage directly; omit it and that one assertion is skipped, same
 * as every other case still runs.
 *
 * **The option's return may be a promise.** `memoryTickets()`'s
 * `commentBodies` answers synchronously, but a database-backed implementation
 * (`dbTickets`, #380) cannot — `await`ing a plain array still answers the
 * array, so one `await` at the call site serves both.
 */
import { describe, expect, it } from 'vitest'

import type { Tickets } from '../src/ticket-store.ts'

export function describeTicketsContract<T extends Tickets>(
  name: string,
  make: () => T | Promise<T>,
  options: { commentBodies?: (t: T, issue: number) => readonly string[] | Promise<readonly string[]> } = {},
): void {
  const tickets = async (): Promise<T> => await make()

  describe(`${name}: the Tickets contract`, () => {
    it('lists open tickets by number; a closed one is not listed', async () => {
      const t = await tickets()
      const open = await t.createIssue({ title: 'open', body: '', labels: [] })
      const closed = await t.createIssue({ title: 'closed', body: '', labels: [] })
      await t.closeIssue(closed.number)

      const listed = (await t.listOpenIssues()).map((i) => i.number)
      expect(listed).toContain(open.number)
      expect(listed).not.toContain(closed.number)
    })

    it('getIssue of an unknown number rejects', async () => {
      const t = await tickets()
      await expect(t.getIssue(999_999)).rejects.toBeTruthy()
    })

    it('createIssue returns a fresh number, and the ticket is listed open with its labels', async () => {
      const t = await tickets()
      const created = await t.createIssue({ title: 'new work', body: 'the body', labels: ['bug', 'agent:hold'] })

      const listing = (await t.listOpenIssues()).find((i) => i.number === created.number)
      expect(listing).toBeDefined()
      expect(listing?.state).toBe('open')
      expect(listing?.labels.map((l) => l.name).sort()).toEqual(['agent:hold', 'bug'])
    })

    it('setLabels replaces the whole set, and getIssue reads the new one', async () => {
      const t = await tickets()
      const created = await t.createIssue({ title: 'x', body: '', labels: ['bug'] })

      await t.setLabels(created.number, ['feature', 'agent:hold'])

      const got = await t.getIssue(created.number)
      expect(got.labels.map((l) => l.name).sort()).toEqual(['agent:hold', 'feature'])
    })

    it('comment appends and returns a fresh id each time; earlier comments are untouched', async () => {
      const t = await tickets()
      const created = await t.createIssue({ title: 'x', body: 'original body', labels: [] })

      const first = await t.comment(created.number, 'first')
      const second = await t.comment(created.number, 'second')

      expect(first.id).not.toBe(second.id)
      const got = await t.getIssue(created.number)
      expect(got.body).toBe('original body')

      if (options.commentBodies) {
        expect(await options.commentBodies(t, created.number)).toEqual(['first', 'second'])
      }
    })

    it('updateBody replaces only the body: title, labels and state unchanged', async () => {
      const t = await tickets()
      const created = await t.createIssue({ title: 'x', body: 'old body', labels: ['bug'] })

      await t.updateBody(created.number, 'new body')

      const got = await t.getIssue(created.number)
      expect(got.body).toBe('new body')
      expect(got.title).toBe('x')
      expect(got.labels.map((l) => l.name)).toEqual(['bug'])
      expect(got.state).toBe('open')
    })

    it("closeIssue removes it from listOpenIssues; getIssue still answers it, state: 'closed'", async () => {
      const t = await tickets()
      const created = await t.createIssue({ title: 'x', body: '', labels: [] })

      await t.closeIssue(created.number)

      const open = (await t.listOpenIssues()).map((i) => i.number)
      expect(open).not.toContain(created.number)
      const got = await t.getIssue(created.number)
      expect(got.state).toBe('closed')
    })

    it('listIssuesSince(t) includes tickets created at or after t, closed ones too', async () => {
      const t = await tickets()
      const open = await t.createIssue({ title: 'open', body: '', labels: [] })
      const closed = await t.createIssue({ title: 'closed', body: '', labels: [] })
      await t.closeIssue(closed.number)

      const everything = (await t.listIssuesSince(new Date(0))).map((i) => i.number)
      expect(everything).toContain(open.number)
      expect(everything).toContain(closed.number)

      const nothingYet = await t.listIssuesSince(new Date('3000-01-01'))
      expect(nothingYet.map((i) => i.number)).not.toContain(open.number)
    })
  })
}
