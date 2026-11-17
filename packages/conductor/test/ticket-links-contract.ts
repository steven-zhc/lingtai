/**
 * The link verbs of `dbTickets` (#1226) — a contract of their own, not a case in
 * `describeTicketsContract`, whose subject is `Tickets` and which `memoryTickets`
 * also runs.
 */
import { describe, expect, it } from 'vitest'

import type { DbTickets } from '../src/db-tickets.ts'

export function describeTicketLinksContract(name: string, fresh: () => { store: DbTickets; project: string }): void {
  let project = ''
  const make = async (n: number) => {
    const made = fresh()
    project = made.project
    const t = made.store
    for (let i = 1; i <= n; i++) await t.createIssue({ title: `t${i}`, body: '', labels: [] })
    return t
  }

  describe(`${name}: ticket links`, () => {
    it('counts open blockers on all three reads, as a number, and stops at a close', async () => {
      const t = await make(2)
      await t.addBlockedBy(2, 1)
      const since = new Date(0)
      for (const read of [
        async () => (await t.listOpenIssues()).find((i) => i.number === 2)!,
        () => t.getIssue(2),
        async () => (await t.listIssuesSince(since)).find((i) => i.number === 2)!,
      ]) {
        const issue = await read()
        expect(typeof issue.dependencies?.blockedBy).toBe('number')
        expect(issue.dependencies?.blockedBy).toBe(1)
      }
      await t.closeIssue(1)
      expect((await t.getIssue(2)).dependencies?.blockedBy).toBe(0)
      expect((await t.listOpenIssues())[0]!.dependencies?.blockedBy).toBe(0)
      expect((await t.listIssuesSince(since)).find((i) => i.number === 2)!.dependencies?.blockedBy).toBe(0)
    })

    it('refuses a self-block', async () => {
      const t = await make(1)
      await expect(t.addBlockedBy(1, 1)).rejects.toThrow('#1 cannot block itself')
    })

    it('refuses a number with no ticket, on either side, writing nothing', async () => {
      const t = await make(2)
      await expect(t.addBlockedBy(2, 9)).rejects.toThrow('no ticket #9')
      await expect(t.addBlockedBy(9, 1)).rejects.toThrow('no ticket #9')
      expect(await t.listBlockedBy(2)).toEqual([])
    })

    it('refuses a link that closes a cycle, naming it, and writes nothing', async () => {
      const t = await make(3)
      await t.addBlockedBy(3, 1)
      await t.addBlockedBy(1, 2)
      await expect(t.addBlockedBy(2, 3)).rejects.toThrow('#2 blocked by #3 would close a cycle: #2 → #3 → #1 → #2')
      expect(await t.listBlockedBy(2)).toEqual([])
    })

    it('refuses a cycle through a closed ticket', async () => {
      const t = await make(2)
      await t.addBlockedBy(2, 1)
      await t.closeIssue(1)
      await expect(t.addBlockedBy(1, 2)).rejects.toThrow('would close a cycle')
    })

    it('adding twice leaves one link; removing an absent link succeeds', async () => {
      const t = await make(2)
      await t.addBlockedBy(2, 1)
      await t.addBlockedBy(2, 1)
      expect(await t.listBlockedBy(2)).toHaveLength(1)
      expect((await t.getIssue(2)).dependencies?.blockedBy).toBe(1)
      await t.removeBlockedBy(2, 1)
      await t.removeBlockedBy(2, 1)
      expect(await t.listBlockedBy(2)).toEqual([])
      expect((await t.getIssue(2)).dependencies?.blockedBy).toBe(0)
      await expect(t.removeBlockedBy(9, 1)).rejects.toThrow('no ticket #9')
    })

    it('lists open and closed blockers ascending, with the project as repository', async () => {
      const t = await make(3)
      await t.addBlockedBy(3, 2)
      await t.addBlockedBy(3, 1)
      await t.closeIssue(1)
      expect(await t.listBlockedBy(3)).toEqual([
        { repository: project, number: 1, title: 't1', state: 'closed' },
        { repository: project, number: 2, title: 't2', state: 'open' },
      ])
      await expect(t.listBlockedBy(9)).rejects.toThrow('no ticket #9')
    })
  })
}
