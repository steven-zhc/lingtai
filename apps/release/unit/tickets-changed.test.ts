import { landingSubject } from '@lingtai/repo/landing-subject'
import { describe, expect, it } from 'vitest'

import { landedTickets, readIssue, renderTickets, type Ticket } from '../src/tickets-changed.ts'

describe('landedTickets', () => {
  it('takes the subject the merge lane writes', () => {
    expect(landedTickets([landingSubject('agent/771')])).toEqual([771])
  })
  it('takes a literal landing subject', () => {
    expect(landedTickets(["Merge branch 'agent/5' into HEAD"])).toEqual([5])
  })
  it('does not take merges inside an agent branch, a PR merge, or looser shapes', () => {
    expect(
      landedTickets([
        'Merge main at 02d4f8f into agent/737',
        'Merge pull request #12 from x/y',
        "Merge branch 'claude/foo' into HEAD",
        "Merge branch 'agent/9' into main",
        " Merge branch 'agent/9' into HEAD",
        "Merge branch 'agent/x' into HEAD",
      ]),
    ).toEqual([])
  })
  it('lists a duplicate once, in first-landing order', () => {
    expect(landedTickets([landingSubject('agent/3'), landingSubject('agent/1'), landingSubject('agent/3')])).toEqual([
      3, 1,
    ])
  })
})

const t = (n: number, title: string, labels: string[]): Ticket => ({ n, found: true, title, labels })
const base = { repo: 'o/r', tag: 'v2', prev: 'v1' }

describe('renderTickets', () => {
  it('groups in kind order, omits empty groups, and closes with the compare link', () => {
    const out = renderTickets({
      ...base,
      tickets: [t(1, 'a doc', ['documentation']), t(2, 'a bug', ['bug']), t(3, 'a feat', ['feature'])],
    })
    expect(out).toBe(
      [
        '## Tickets landed',
        '',
        '### bug',
        '',
        '- #2 a bug',
        '',
        '### feature',
        '',
        '- #3 a feat',
        '',
        '### documentation',
        '',
        '- #1 a doc',
        '',
        'Full diff: https://github.com/o/r/compare/v1...v2',
        '',
      ].join('\n'),
    )
  })
  it('puts an issue with two kinds under the first in order', () => {
    const out = renderTickets({ ...base, tickets: [t(1, 'x', ['feature', 'bug'])] })
    expect(out).toContain('### bug\n\n- #1 x')
    expect(out).not.toContain('### feature')
  })
  it('puts an issue with none under Other', () => {
    expect(renderTickets({ ...base, tickets: [t(1, 'x', ['question'])] })).toContain('### Other\n\n- #1 x')
  })
  it('renders a not-found ticket in Other', () => {
    expect(renderTickets({ ...base, tickets: [{ n: 4, found: false }] })).toContain(
      '### Other\n\n- #4 (issue not found)',
    )
  })
  it('says there is nothing to compare against with no previous release', () => {
    const out = renderTickets({ repo: 'o/r', tag: 'v1', prev: undefined, tickets: [] })
    expect(out).toBe('## Tickets landed\n\nNo earlier release to compare against.\n')
  })
})

const stub =
  (status: number, body: unknown = {}) =>
  async () => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  })

describe('readIssue', () => {
  it('reads title and label names on 200', async () => {
    const f = stub(200, { title: 'T', labels: [{ name: 'bug' }, { name: 'x' }] })
    expect(await readIssue(f, 'o/r', 'tok', 7)).toEqual({ found: true, title: 'T', labels: ['bug', 'x'] })
  })
  it('sends the token and the issue url', async () => {
    let seen: { url: string; init?: RequestInit } | undefined
    await readIssue(
      async (url, init) => {
        seen = { url, init }
        return { status: 200, ok: true, json: async () => ({ title: 'T', labels: [] }) }
      },
      'o/r',
      'tok',
      7,
    )
    expect(seen?.url).toBe('https://api.github.com/repos/o/r/issues/7')
    expect(((seen?.init?.headers ?? {}) as Record<string, string>).Authorization).toBe('Bearer tok')
  })
  it('reads 404 as not found', async () => {
    expect(await readIssue(stub(404), 'o/r', 't', 1)).toEqual({ found: false })
  })
  it('throws on 403, 410 and 500, naming the status and the issue', async () => {
    await expect(readIssue(stub(410), 'o/r', 't', 9)).rejects.toThrow('410')
    await expect(readIssue(stub(403), 'o/r', 't', 8)).rejects.toThrow('#8')
    await expect(readIssue(stub(500), 'o/r', 't', 8)).rejects.toThrow('500')
  })
})
