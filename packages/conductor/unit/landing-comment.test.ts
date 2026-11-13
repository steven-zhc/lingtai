import { createMemoryEventStore } from '@lingtai/event-store/memory'
/**
 * **A landing posts one comment on the issue, with the reviewer's summary** (#896).
 *
 * Memory event store and memory `Tickets`: no network, no Postgres.
 */
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { type RefChannel, landingComment, tellGitHubAboutEffect, unmention } from '../src/tell.ts'
import { memoryTickets } from '../test/memory-tickets.ts'

const ticketId = 'ticket-p-1'
const refs: RefChannel = { matchingRefs: async () => [], deleteRef: async () => {} }
const landed = { mergeCommit: 'ab5848a1234', base: 'main', attempt: 2, summary: 'Adds the comment.' }

async function world(failing = false) {
  const store = createMemoryEventStore()
  const tickets = memoryTickets()
  await tickets.createIssue({ title: 't', body: 'b', labels: [] })
  const order: string[] = []
  const github = {
    ...tickets,
    comment: async (n: number, body: string) => {
      order.push('comment')
      if (failing) throw new Error('refused')
      return tickets.comment(n, body)
    },
    closeIssue: async (n: number) => {
      order.push('close')
      return tickets.closeIssue(n)
    },
    getIssue: async () => ({ labels: [], body: 'b' }),
    ...refs,
  }
  await store.append(ticketId, 0, [
    { type: 'TicketLanded', actor: 'conductor', data: { mergeCommit: 'ab5848a1234', base: 'main' } },
  ])
  const tell = (extra: Record<string, unknown> = {}) =>
    Effect.runPromise(tellGitHubAboutEffect({ store, github, ticketId, landed, ...extra } as never))
  return { store, tickets, tell, order }
}

describe('the landing comment', () => {
  it('posts one comment with the landing line and the summary, records it, and posts nothing twice', async () => {
    const w = await world()
    await w.tell()
    await w.tell()
    expect(w.tickets.commentBodies(1)).toEqual([
      '**Landed on `main` in `ab5848a`.**\n\nAdds the comment.\n\nAttempt 2 · reviewed cold',
    ])
    const recorded = (await w.store.read(ticketId)).filter((e) => e.type === 'IssueUpdated')
    expect(recorded).toHaveLength(1)
    expect((recorded[0]!.data as { waitId?: string }).waitId).toBeUndefined()
  })

  it('a landing with no summary posts the landing line alone', async () => {
    const w = await world()
    await w.tell({ landed: { ...landed, summary: null } })
    expect(w.tickets.commentBodies(1)).toEqual(['**Landed on `main` in `ab5848a`.**'])
  })

  it('a failed post is recorded and not retried', async () => {
    const w = await world(true)
    await w.tell()
    await w.tell()
    expect(w.order).toEqual(['comment'])
    expect((await w.store.read(ticketId)).filter((e) => e.type === 'IssueUpdateFailed')).toHaveLength(1)
  })

  it('is posted before the end step closes the issue', async () => {
    const w = await world()
    await w.tell({
      appended: [{ type: 'EndActionsResolved', actor: 'conductor', data: { actions: [{ close: true }] } }],
    })
    expect(w.order).toEqual(['comment', 'close'])
  })

  it('mentions nobody, and leaves code spans alone', () => {
    const body = landingComment({ ...landed, summary: 'Thanks @someone, see `@types/node`.' })
    expect(body).toContain('@‍someone')
    expect(body).toContain('`@types/node`')
    expect(unmention('```\n@fenced\n```\n@real a@b.c')).toBe('```\n@fenced\n```\n@‍real a@b.c')
  })

  it('follows the renderer: escaped backticks open no span, a span may cross a line', () => {
    expect(unmention('\\`@someone\\`')).toBe('\\`@‍someone\\`')
    expect(unmention('`code\n@types/node`')).toBe('`code\n@types/node`')
  })

  it('names no local path', () => {
    const body = landingComment({
      ...landed,
      summary: 'Edits `/Users/alice/.lingtai/worktrees/app/pass-123/src/main.ts` and ~/.lingtai/x; see src/main.ts.',
    })
    expect(body).not.toContain('alice')
    expect(body).not.toContain('.lingtai')
    expect(body).toContain('src/main.ts')
  })
})

describe('the renderer and the redaction agree on the harder inputs (#896)', () => {
  it('a backtick fence whose info string holds a backtick is prose', () => {
    expect(unmention('```text \\`@someone\\`')).toBe('```text \\`@‍someone\\`')
  })

  it('a span does not cross a block boundary', () => {
    expect(unmention('`unfinished\n# @someone\nend`')).toBe('`unfinished\n# @‍someone\nend`')
  })

  it('names no path in a file link, or under a home with a space in it', () => {
    const body = landingComment({
      ...landed,
      summary:
        '[main.ts](file:///Users/alice/.lingtai/worktrees/app/pass-123/src/main.ts) and /Users/Alice Smith/.lingtai/worktrees/app/pass-123/src/main.ts',
    })
    expect(body).not.toMatch(/alice|Smith|\.lingtai/i)
  })

  it('names no path in a single-slash file link, or under a home with many or spaced words', () => {
    const body = landingComment({
      ...landed,
      summary:
        '[a](file:/Users/alice/.lingtai/worktrees/app/pass-123/src/main.ts) /Users/Al  Ice Smith Jr Third/.lingtai/w/x.ts C:\\Users\\A  B C D E\\.lingtai\\w\\x.ts',
    })
    expect(body).not.toMatch(/alice|Smith|Third|\.lingtai/i)
  })

  it('a heading line holds its own span, and only a paragraph-interrupting line ends one', () => {
    expect(unmention('# `unfinished\n@someone`')).toBe('# `unfinished\n@‍someone`')
    expect(unmention('`code\n2. @types/node`')).toBe('`code\n2. @types/node`')
    expect(unmention('`code\n    # @types/node`')).toBe('`code\n    # @types/node`')
  })
})
