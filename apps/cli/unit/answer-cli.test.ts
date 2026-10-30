/** The wait-answering commands through `@effect/cli` (#621): what is parsed, and what is refused before a handler runs. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { INTEGER_FLAGS, runCli } from '../src/cli.ts'

const seen = vi.hoisted(() => ({ calls: [] as { command: string; options: unknown }[] }))

vi.mock('../src/close.ts', () => ({
  closeVerdict: async (options: unknown) => {
    seen.calls.push({ command: 'close', options })
    return { code: 0, verdict: { outcome: 'accepted', ticketId: 'ticket-p-5', detail: 'closed it' } }
  },
}))
vi.mock('../src/requeue.ts', () => ({
  requeueVerdict: async (options: unknown) => {
    seen.calls.push({ command: 'requeue', options })
    return { code: 0, verdict: { outcome: 'accepted', ticketId: 'ticket-p-5', detail: 'back in the queue' } }
  },
}))
vi.mock('../src/grant-fix-round.ts', () => ({
  grantFixRoundVerdict: async (options: unknown) => {
    seen.calls.push({ command: 'grant-fix-round', options })
    return {
      code: 1,
      verdict: { outcome: 'refused', reason: 'head-moved', ticketId: 'ticket-p-5', detail: 'the head moved' },
    }
  },
}))
vi.mock('../src/ask.ts', () => ({
  askVerdict: async (options: unknown) => {
    seen.calls.push({ command: 'ask', options })
    return { code: 0, verdict: { outcome: 'accepted', ticketId: 'ticket-p-5', detail: 'asked' } }
  },
  answerVerdict: async (options: unknown) => {
    seen.calls.push({ command: 'answer', options })
    return { code: 0, verdict: { outcome: 'accepted', ticketId: 'ticket-p-5', detail: 'answered' } }
  },
}))
vi.mock('../src/now.ts', () => ({
  nowVerdict: async (project: string, issue: number, by: string) => {
    seen.calls.push({ command: 'now', options: { project, issue, by } })
    return {
      code: 0,
      verdict: { outcome: 'accepted', subject: `${project} #${issue}`, detail: `requested ${project} #${issue}` },
    }
  },
}))

async function capture(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((t: string | Uint8Array) => ((out += String(t)), true))
  vi.spyOn(process.stderr, 'write').mockImplementation((t: string | Uint8Array) => ((err += String(t)), true))
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void (out += `${a.join(' ')}\n`))
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void (err += `${a.join(' ')}\n`))
  const code = await runCli(['node', 'lingtai', ...args])
  return { code, out, err }
}

const saved = process.env['NO_COLOR']
beforeEach(() => {
  seen.calls.length = 0
  process.env['NO_COLOR'] = '1'
})
afterEach(() => {
  vi.restoreAllMocks()
  if (saved === undefined) delete process.env['NO_COLOR']
  else process.env['NO_COLOR'] = saved
})

describe('the sentence after the project', () => {
  it('joins every word, whichever side of --issue they are on', async () => {
    await capture(['close', 'p', '--issue', '5', 'superseded', 'by', '9'])
    await capture(['close', 'p', 'superseded', '--issue', '5'])
    expect(seen.calls.map((c) => c.options)).toEqual([
      { project: 'p', issue: 5, reason: 'superseded by 9' },
      { project: 'p', issue: 5, reason: 'superseded' },
    ])
  })

  it('reaches ask and answer whole, and an absent one arrives blank for the command to refuse', async () => {
    await capture(['ask', 'p', '--issue', '5', 'which', 'groups?'])
    await capture(['answer', 'p', '--issue', '5', 'the second'])
    await capture(['ask', 'p', '--issue', '5'])
    expect(seen.calls.map((c) => c.options)).toEqual([
      { project: 'p', issue: 5, text: 'which groups?' },
      { project: 'p', issue: 5, text: 'the second' },
      { project: 'p', issue: 5, text: '' },
    ])
  })
})

describe('requeue', () => {
  it('--note with nothing after it is recorded as the empty string, as leaving it off is', async () => {
    await capture(['requeue', 'p', '--issue', '5', '--note'])
    await capture(['requeue', 'p', '--issue', '5'])
    await capture(['requeue', 'p', '--issue', '5', '--note', '--into-body', 'the answer'])
    expect(seen.calls.map((c) => c.options)).toEqual([
      { project: 'p', issue: 5, note: '' },
      { project: 'p', issue: 5, note: '' },
      { project: 'p', issue: 5, note: '', intoBody: 'the answer' },
    ])
  })

  it('--into-body with no text is refused in its own words, exit 2, before anything runs', async () => {
    for (const argv of [
      ['requeue', 'p', '--issue', '5', '--into-body'],
      ['requeue', 'p', '--issue', '5', '--into-body', '  '],
    ]) {
      const r = await capture(argv)
      expect(r).toEqual({ code: 2, out: '', err: '--into-body takes text\n' })
    }
    expect(seen.calls).toEqual([])
  })
})

describe('grant-fix-round', () => {
  it('--if-head with no value is refused in its own words, exit 2', async () => {
    const r = await capture(['grant-fix-round', 'p', '--issue', '5', '--if-head'])
    expect(r).toEqual({ code: 2, out: '', err: '--if-head takes the commit SHA, full or at least 7 characters\n' })
    expect(seen.calls).toEqual([])
  })

  it('prints a refusal as one verdict line and the detail, exit 1', async () => {
    const r = await capture(['grant-fix-round', 'p', '--issue', '5', '--if-head', 'abc1234'])
    expect(r.code).toBe(1)
    expect(r.out).toBe('✗ fix round refused (head-moved) ticket-p-5\n  the head moved\n')
    expect(seen.calls[0]?.options).toEqual({ project: 'p', issue: 5, ifHead: 'abc1234' })
  })

  it('--json prints a refusal as an outcome and not as the error document', async () => {
    const r = await capture(['grant-fix-round', 'p', '--issue', '5', '--json'])
    expect(r.code).toBe(1)
    expect(r.out.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(r.out)).toEqual({
      version: 1,
      command: 'grant-fix-round',
      outcome: 'refused',
      ticketId: 'ticket-p-5',
      reason: 'head-moved',
      detail: 'the head moved',
    })
  })
})

describe('approve --reject', () => {
  it('is refused by name with the command that ends the wait, exit 2', async () => {
    const r = await capture(['approve', 'p', '--issue', '5', '--reject'])
    expect(r.code).toBe(2)
    expect(r.out).toBe(
      [
        '✗ not approved (removed-flag)',
        '  --reject is gone: it asked the same question again and ended nothing.',
        '  next: lingtai requeue p --issue 5',
        '',
      ].join('\n'),
    )
  })

  it('--json says the same as an outcome', async () => {
    const r = await capture(['approve', 'p', '--issue', '5', '--reject', '--json'])
    expect(r.code).toBe(2)
    expect(JSON.parse(r.out)).toMatchObject({
      command: 'approve',
      outcome: 'refused',
      reason: 'removed-flag',
      next: 'lingtai requeue p --issue 5',
    })
  })
})

describe('now', () => {
  it('takes --issue or a second positional, and prints what it requested', async () => {
    const a = await capture(['now', 'p', '--issue', '7'])
    const b = await capture(['now', 'p', '7'])
    expect(a.out).toBe('✓ requested p #7\n  requested p #7\n')
    expect(b.out).toBe(a.out)
    expect(seen.calls.map((c) => (c.options as { issue: number }).issue)).toEqual([7, 7])
  })

  it('--json reports project, issue and who', async () => {
    const r = await capture(['now', 'p', '--issue', '7', '--json'])
    expect(JSON.parse(r.out)).toMatchObject({ version: 1, command: 'now', outcome: 'accepted' })
  })

  it('refuses a missing or non-numeric issue with its usage line, exit 2', async () => {
    const none = await capture(['now', 'p'])
    expect(none.code).toBe(2)
    expect(none.out).toContain('lingtai now <project> --issue <n>')
    const word = await capture(['now', 'p', 'seven'])
    expect(word.code).toBe(2)
    expect(seen.calls).toEqual([])
  })
})

describe('usage', () => {
  it('a missing --issue under --json is the one usage error document', async () => {
    const r = await capture(['approve', 'p', '--json'])
    expect(r.code).toBe(1)
    expect(r.err).toBe('')
    expect(JSON.parse(r.out)).toMatchObject({ version: 1, command: 'approve', error: { code: 'usage' } })
  })
})

describe('integer flags (#770)', () => {
  const flags: [string, string][] = [
    ['approve', 'issue'],
    ['requeue', 'issue'],
    ['grant-fix-round', 'issue'],
    ['ask', 'issue'],
    ['answer', 'issue'],
    ['close', 'issue'],
    ['now', 'issue'],
    ['run', 'issue'],
    ['run', 'max'],
    ['end', 'issue'],
    ['board', 'port'],
  ]

  it('covers every entry of the list', () => {
    const listed = Object.entries(INTEGER_FLAGS).flatMap(([c, fs]) => fs.map((f) => `${c} ${f}`))
    expect(flags.map(([c, f]) => `${c} ${f}`).sort()).toEqual(listed.sort())
  })

  it.each(flags)('%s --%s refuses what is not a whole number, by name, exit 2', async (command, flag) => {
    const cases: [string[], string][] = [
      [[`--${flag}`, ''], `, not ''`],
      [[`--${flag}=`], `, not ''`],
      [[`--${flag}=abc`], `, not 'abc'`],
      [[`--${flag}`, 'abc'], `, not 'abc'`],
      [[`--${flag}`, '1.5'], `, not '1.5'`],
      [[`--${flag}`, '-3'], `, not '-3'`],
      [[`--${flag}`], ''],
    ]
    for (const [rest, tail] of cases) {
      const r = await capture([command, ...rest])
      expect(r.code).toBe(2)
      expect(r.out).toBe('')
      expect(r.err).toMatch(new RegExp(`^--${flag} takes (an issue number|a number|a port number)${tail}\\n$`))
      expect(r.err).not.toContain('a integer')
      vi.restoreAllMocks()
      const j = await capture([command, ...rest, '--json'])
      expect(j.code).toBe(2)
      expect(j.out.trim().split('\n')).toHaveLength(1)
      expect(JSON.parse(j.out)).toMatchObject({ command, error: { code: 'usage' } })
      vi.restoreAllMocks()
    }
  })

  it('a second occurrence is checked too', async () => {
    expect((await capture(['approve', 'p', '--issue', '5', '--issue', 'x'])).code).toBe(2)
  })

  it('--issue 5 and --issue=5 still parse', async () => {
    await capture(['close', 'p', '--issue', '5', 'done'])
    await capture(['close', 'p', '--issue=5', 'done'])
    expect(seen.calls.map((c) => (c.options as { issue: number }).issue)).toEqual([5, 5])
  })
})
