import { waitWords } from '@lingtai/domain'
import { describeWaitLines } from '@lingtai/projector'
/**
 * `lingtai status`'s two ticket-source lines, named after where a project's
 * tickets actually live rather than always `GitHub` (`#389`).
 *
 * `status()` itself calls `selectRunnable` and `readTasks`, which reach the
 * log, so it is not unit-reachable — `offerLine` and `offerFailedLine` are
 * pulled out of it for exactly that reason, the way `status.ts`'s own design
 * note asks for.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { stripColour } from '../src/output.ts'
import {
  offerFailedLine,
  offerLine,
  renderStatus,
  conflictLines,
  waitDetail,
  statusJson,
  type StatusFilter,
  type StatusReport,
  type StatusRow,
  type StatusWait,
} from '../src/status.ts'

describe('offerLine', () => {
  it('names GitHub for a github project', () => {
    expect(offerLine('GitHub', 3, null)).toBe('  from GitHub: 3 eligible')
  })

  it('names the ticket table for a db project, never GitHub', () => {
    const line = offerLine('the ticket table', 5, null)
    expect(line).toBe('  from the ticket table: 5 eligible')
    expect(line).not.toContain('GitHub')
  })

  it('appends the passed-over clause when there is one', () => {
    expect(offerLine('GitHub', 3, '1 blocked-by')).toBe('  from GitHub: 3 eligible, 1 blocked-by')
  })
})

describe('offerFailedLine', () => {
  it('names GitHub as what is unavailable for a github project', () => {
    expect(offerFailedLine('GitHub', new Error('503'))).toBe('  (GitHub unavailable: 503 — the queue cannot be listed)')
  })

  it('names the ticket table for a db project, never GitHub', () => {
    const line = offerFailedLine('the ticket table', new Error('no such table'))
    expect(line).toBe('  (the ticket table unavailable: no such table — the queue cannot be listed)')
    expect(line).not.toContain('GitHub')
  })
})

// --- #618: the sections, and `--json` ----------------------------------------------------------

const row = (over: Partial<StatusRow> & Pick<StatusRow, 'taskId' | 'ref'>): StatusRow => ({
  kind: 'bug',
  title: `title of ${over.ref}`,
  state: 'queued',
  restarts: 0,
  arm: null,
  held: null,
  unoffered: false,
  wait: null,
  run: null,
  ...over,
})

const asked: StatusWait = {
  reason: 'OwnQuestion',
  line: 'which   approach\nshould I take?',
  needs: 'judgement',
  words: 'waiting for your answer',
  detail: ['your judgement is needed'],
  raw: true,
}

const fixture: StatusReport = {
  message: null,
  projects: [
    {
      project: 'lingtai',
      base: 'main',
      filter: {
        ok: true,
        facts: [
          ['recipe', '3f2a91c9d04e from main'],
          ['picks up', 'bug > tech-debt   (in priority order)'],
          ['excludes', 'nothing'],
          ['assignee', 'any issue, whoever it is assigned to'],
          ['a pass', '1h'],
          ['retries', 'after 1h, unless a repair is pending'],
        ],
        recipe: '3f2a91c9d04e0000',
        ref: 'main',
        kinds: ['bug', 'tech-debt'],
        exclude: [],
      },
      source: 'GitHub',
      eligible: 3,
      offerError: null,
      passedOver: [{ ref: 9, reason: 'agent:hold' }],
      passedOverLine: '1 passed over — agent:hold 1',
      dependenciesUnread: 'GitHub reported no issue dependencies for this repository',
      runnable: [
        row({ taskId: 't612', ref: '612', held: 'backing off — runnable in 32m', restarts: 1, arm: 'restart 1 of 3' }),
        row({ taskId: 't613', ref: '613', kind: 'tech-debt', unoffered: true }),
      ],
      known: [
        row({ taskId: 't612', ref: '612', held: 'backing off — runnable in 32m', restarts: 1, arm: 'restart 1 of 3' }),
        row({ taskId: 't609', ref: '609', state: 'waiting', wait: asked }),
        row({
          taskId: 't610',
          ref: '610',
          state: 'waiting',
          wait: {
            reason: 'Refused',
            line: 'the gate refused',
            needs: 'acknowledgement',
            words: null,
            detail: [],
            raw: false,
          },
        }),
        row({ taskId: 't611', ref: '611', state: 'verifying' }),
        row({ taskId: 't600', ref: '600', state: 'landed' }),
      ],
    },
    {
      project: 'broken',
      base: null,
      filter: {
        ok: false,
        facts: [
          ['recipe', 'INVALID — not valid'],
          ['', 'nothing will be taken from this project'],
        ],
        problem: 'not valid',
      },
      source: null,
      eligible: null,
      offerError: null,
      passedOver: [],
      passedOverLine: null,
      dependenciesUnread: null,
      runnable: [],
      known: [],
    },
    {
      project: 'down',
      base: 'main',
      filter: fixture0Ok(),
      source: 'the ticket table',
      eligible: null,
      offerError: 'no such table',
      passedOver: [],
      passedOverLine: null,
      dependenciesUnread: null,
      runnable: [],
      known: [],
    },
  ],
}

function fixture0Ok(): Extract<StatusFilter, { ok: true }> {
  return { ok: true, facts: [['recipe', 'abc from main']], recipe: 'abc', ref: 'main', kinds: ['bug'], exclude: ['x'] }
}

describe('statusJson', () => {
  it('pins the whole shape', () => {
    const off = { restarts: 0, held: null, arm: null, unoffered: false }
    const r = (ref: string, kind = 'bug') => ({ taskId: `t${ref}`, ref, kind, title: `title of ${ref}` })
    expect(statusJson(fixture)).toEqual({
      projects: [
        {
          project: 'lingtai',
          base: 'main',
          filter: {
            ok: true,
            recipe: '3f2a91c9d04e0000',
            ref: 'main',
            kinds: ['bug', 'tech-debt'],
            exclude: [],
            facts: [
              { key: 'recipe', value: '3f2a91c9d04e from main' },
              { key: 'picks up', value: 'bug > tech-debt   (in priority order)' },
              { key: 'excludes', value: 'nothing' },
              { key: 'assignee', value: 'any issue, whoever it is assigned to' },
              { key: 'a pass', value: '1h' },
              { key: 'retries', value: 'after 1h, unless a repair is pending' },
            ],
          },
          source: 'GitHub',
          eligible: 3,
          offerError: null,
          passedOver: [{ ref: 9, reason: 'agent:hold' }],
          dependenciesUnread: 'GitHub reported no issue dependencies for this repository',
          runnable: [
            { ...r('612'), restarts: 1, held: 'backing off — runnable in 32m', arm: 'restart 1 of 3' },
            { ...r('613', 'tech-debt'), restarts: 0, held: null, arm: null },
          ],
          byState: {
            queued: [
              { ...r('612'), ...off, restarts: 1, held: 'backing off — runnable in 32m', arm: 'restart 1 of 3' },
            ],
            waiting: [
              { ...r('609'), ...off },
              { ...r('610'), ...off },
            ],
            verifying: [{ ...r('611'), ...off }],
            landed: [{ ...r('600'), ...off }],
          },
          waiting: [
            {
              taskId: 't609',
              ref: '609',
              reason: 'OwnQuestion',
              line: asked.line,
              needs: 'judgement',
              asked: true,
              detail: ['your judgement is needed'],
              raw: true,
            },
            {
              taskId: 't610',
              ref: '610',
              reason: 'Refused',
              line: 'the gate refused',
              needs: 'acknowledgement',
              asked: false,
              detail: [],
              raw: false,
            },
          ],
        },
        {
          project: 'broken',
          base: null,
          filter: {
            ok: false,
            problem: 'not valid',
            facts: [
              { key: 'recipe', value: 'INVALID — not valid' },
              { key: '', value: 'nothing will be taken from this project' },
            ],
          },
          source: null,
          eligible: null,
          offerError: null,
          passedOver: [],
          dependenciesUnread: null,
          runnable: [],
          byState: {},
          waiting: [],
        },
        {
          project: 'down',
          base: 'main',
          filter: {
            ok: true,
            recipe: 'abc',
            ref: 'main',
            kinds: ['bug'],
            exclude: ['x'],
            facts: [{ key: 'recipe', value: 'abc from main' }],
          },
          source: 'the ticket table',
          eligible: null,
          offerError: 'no such table',
          passedOver: [],
          dependenciesUnread: null,
          runnable: [],
          byState: {},
          waiting: [],
        },
      ],
    })
  })
})

describe('renderStatus keeps every fact the old output printed', () => {
  const plain = renderStatus(fixture, { all: false }).join('\n')

  it.each([
    'lingtai', // the project's name
    'base',
    'main',
    '(unrecorded)', // base, and unrecorded
    '3f2a91c9d04e from main', // the recipe's hash and ref
    'bug > tech-debt   (in priority order)',
    'any issue, whoever it is assigned to',
    'after 1h, unless a repair is pending',
    'RECIPE INVALID'.replace('RECIPE ', ''), // an unresolvable recipe says so
    'nothing will be taken from this project',
    'from GitHub: 3 eligible, 1 passed over — agent:hold 1', // eligible, and what was passed over
    '(GitHub reported no issue dependencies for this repository)',
    '(the ticket table unavailable: no such table — the queue cannot be listed)',
    'Queue  2 runnable — 1 running, 1 landed', // `runnable` and `elsewhere`, the waits not counted twice
    '#612',
    'backing off — runnable in 32m',
    'restart 1 of 3', // the clock and the arm
    '[not offered]',
    'Waiting on you',
    '#609',
    'waiting for your answer: which approach should I take?', // one line, whitespace folded
    'the gate refused',
    'next: lingtai answer lingtai --issue 609 "<choice>"',
  ])('prints %s', (fact) => {
    expect(plain).toContain(fact)
  })

  it('does not count a wait as "N waiting on you"', () => {
    expect(plain).not.toMatch(/\d+ waiting on you/)
  })

  it('adds the diagnosis under --all, and says the raw failure is on the log', () => {
    const all = renderStatus(fixture, { all: true }).join('\n')
    expect(all).toContain('your judgement is needed')
    expect(all).toContain('(the failure itself is on the log, and on the card)')
    expect(all).toContain('#609')
    expect(all).toContain('[waiting for your answer]')
    expect(plain).not.toContain('your judgement is needed')
  })

  it('says the one-line answer when there is nothing to report', () => {
    expect(renderStatus({ projects: [], message: 'no projects registered — run lingtai add <owner>/<repo>' })).toEqual([
      'no projects registered — run lingtai add <owner>/<repo>',
    ])
  })

  it('is plain with NO_COLOR and coloured under FORCE_COLOR, with the same visible text', () => {
    const keep = { no: process.env['NO_COLOR'], force: process.env['FORCE_COLOR'], term: process.env['TERM'] }
    try {
      delete process.env['TERM']
      delete process.env['NO_COLOR']
      process.env['FORCE_COLOR'] = '1'
      const coloured = renderStatus(fixture, { all: true })
      expect(coloured.join('\n')).toContain('\u001b[')
      delete process.env['FORCE_COLOR']
      process.env['NO_COLOR'] = '1'
      const bare = renderStatus(fixture, { all: true })
      expect(bare.join('\n')).not.toContain('\u001b')
      expect(coloured.map(stripColour)).toEqual(bare)
    } finally {
      for (const [name, value] of [
        ['NO_COLOR', keep.no],
        ['FORCE_COLOR', keep.force],
        ['TERM', keep.term],
      ] as const) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it('aligns the table columns', () => {
    const lines = renderStatus(fixture, { all: false })
    const header = lines.findIndex((l) => l.includes('ID') && l.includes('STATE'))
    const states = lines[header]!.indexOf('STATE')
    expect(lines[header + 1]!.indexOf('[backing off')).toBe(states)
    expect(lines[header + 2]!.indexOf('[not offered]')).toBe(states)
  })
})

describe('lingtai status through @effect/cli', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.doUnmock('../src/status.ts')
  })

  async function run(
    argv: string[],
    read: (o: unknown) => Promise<StatusReport>,
  ): Promise<{ code: number; out: string }> {
    vi.resetModules()
    vi.doMock('../src/status.ts', async (orig) => ({
      ...(await orig<typeof import('../src/status.ts')>()),
      readStatus: read,
    }))
    const { runCli } = await import('../src/cli.ts')
    let out = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((t: unknown) => ((out += String(t)), true))
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void (out += `${a.join(' ')}\n`))
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void (out += `${a.join(' ')}\n`))
    const code = await runCli(['node', 'lingtai', ...argv])
    return { code, out }
  }

  it.each([
    ['status', 'lingtai', '--all'],
    ['status', '--all', 'lingtai'],
  ])('parses %j', async (...argv) => {
    const seen: unknown[] = []
    const { code } = await run(argv, async (o) => (seen.push(o), { projects: [], message: 'none' }))
    expect(code).toBe(0)
    expect(seen).toEqual([{ project: 'lingtai', all: true }])
  })

  it('prints the one document under --json', async () => {
    const { code, out } = await run(['status', '--json'], async () => fixture)
    expect(code).toBe(0)
    expect(JSON.parse(out)).toMatchObject({ version: 1, command: 'status', projects: [{ project: 'lingtai' }, {}, {}] })
  })

  it('reports a runtime failure as unavailable, not usage, and exits 1', async () => {
    const failing = async (): Promise<StatusReport> => {
      throw new Error('no store configured')
    }
    const json = await run(['status', '--json'], failing)
    expect(json.code).toBe(1)
    expect(JSON.parse(json.out)).toEqual({
      version: 1,
      command: 'status',
      error: { code: 'unavailable', message: 'no store configured' },
    })
    const text = await run(['status'], failing)
    expect(text.code).toBe(1)
    expect(text.out).toContain('no store configured')
  })

  it('refuses a flag it does not know, as a usage error', async () => {
    const { code, out } = await run(['status', '--refresh', '--json'], async () => fixture)
    expect(code).toBe(1)
    expect(JSON.parse(out).error.code).toBe('usage')
  })
})

describe('statusJson lists every running pass with its step (#640)', () => {
  it('gives each running row a runId, step and round', () => {
    const report = {
      message: null,
      projects: [
        {
          project: 'lingtai',
          base: 'main',
          filter: { ok: false, problem: 'x', facts: [] },
          source: 'github',
          eligible: 0,
          offerError: null,
          passedOver: [],
          passedOverLine: null,
          dependenciesUnread: false,
          runnable: [],
          known: [
            row({
              taskId: 'a',
              ref: '1',
              state: 'running',
              run: { runId: 'pass-a', step: { step: 'build', round: 0 } },
            }),
            row({
              taskId: 'b',
              ref: '2',
              state: 'running',
              run: { runId: 'pass-b', step: { step: 'review', round: 1 } },
            }),
          ],
        },
      ],
    } as unknown as StatusReport
    const running = (statusJson(report).projects as { byState: { running: Record<string, unknown>[] } }[])[0]!.byState
      .running
    expect(running.map((r) => [r.runId, r.step, r.round])).toEqual([
      ['pass-a', 'build', 0],
      ['pass-b', 'review', 1],
    ])
  })

  it('says so when a run stream could not be read, rather than reporting no step', () => {
    const report = {
      message: null,
      projects: [
        {
          project: 'lingtai',
          base: 'main',
          filter: { ok: false, problem: 'x', facts: [] },
          source: 'github',
          eligible: 0,
          offerError: null,
          passedOver: [],
          passedOverLine: null,
          dependenciesUnread: false,
          runnable: [],
          known: [
            row({ taskId: 'a', ref: '1', state: 'running', run: { runId: 'pass-a', step: null, error: 'boom' } }),
          ],
        },
      ],
    } as unknown as StatusReport
    const running = (statusJson(report).projects as { byState: { running: Record<string, unknown>[] } }[])[0]!.byState
      .running
    expect(running[0]).toMatchObject({ runId: 'pass-a', step: null, round: null, stepError: 'boom' })
  })
})

describe('conflictLines (#652)', () => {
  const reason = {
    _tag: 'ProposedEscalated',
    run: { runId: 'r', ref: 'agent/1', sha: 'abc' },
    proposal: { _tag: 'MergeConflict', output: 'x', paths: ['a.ts'], baseSha: 'a', headSha: 'b' },
    because: { _tag: 'NotAsked' },
  } as never
  const triage = (total: number, resolution = 'Requeue') =>
    ({
      started: null,
      result: {
        _tag: 'TriageAdvised',
        cause: { _tag: 'ConflictingHunks', hunks: [], total },
        resolution,
        summary: 'why',
        want: null,
      },
    }) as never

  it('recommends a fix round at 5 hunks or fewer and shows triage’s own resolution and summary', () => {
    const c = conflictLines(reason, triage(2))
    expect(c?.rec).toContain('recommends a fix round')
    expect(c?.advised).toBe('triage advised Requeue: why')
  })

  it('recommends triage’s resolution above 5 hunks', () => {
    expect(conflictLines(reason, triage(8, 'Close'))).toEqual({ rec: 'recommends Close — why', advised: null })
  })

  it('recommends triage’s resolution when the saved head is gone, as the task page does', () => {
    expect(conflictLines(reason, triage(2), false)).toEqual({ rec: 'recommends Requeue — why', advised: null })
    expect(conflictLines(reason, triage(2), true)?.rec).toContain('recommends a fix round')
  })

  it('says the saved head could not be checked, and recommends no fix round, when the read failed', () => {
    const c = conflictLines(reason, triage(2), { unreadable: 'rate limited' })
    expect(c?.rec).toBe('recommends Requeue — why')
    expect(c?.advised).toContain('saved head could not be checked (rate limited)')
  })

  it('names an unreadable saved head even when triage advised the round it cannot offer', () => {
    const c = conflictLines(reason, triage(2, 'GrantFixRound'), { unreadable: 'timeout' })
    expect(c?.rec).toBe('triage advised GrantFixRound — why')
    expect(c?.advised).toContain('saved head could not be checked (timeout)')
  })

  it('names the read failure and triage’s advice above 5 hunks too', () => {
    const c = conflictLines(reason, triage(10, 'GrantFixRound'), { unreadable: 'timeout' })
    expect(c?.rec).toBe('triage advised GrantFixRound — why')
    expect(c?.advised).toContain('saved head could not be checked (timeout)')
  })

  it('leaves the divergent-hunk clause out when no hunk is divergent', () => {
    expect(conflictLines(reason, triage(2))?.rec).not.toContain('divergent hunk')
  })

  it('says nothing for no triage', () => {
    expect(conflictLines(reason, undefined)).toBeNull()
  })
})

describe('waitDetail (#656)', () => {
  const run = { runId: 'r', ref: 'agent/1', sha: 'abc' }
  const triage = (resolution = 'Requeue') =>
    ({
      started: null,
      result: {
        _tag: 'TriageAdvised',
        cause: { _tag: 'ConflictingHunks', hunks: [], total: 2 },
        resolution,
        summary: 'why',
        want: null,
      },
    }) as never
  const disagrees = { _tag: 'FixerDisagrees', run, said: 'the hunks overlap' } as never
  const detail = (reason: never, t: never | undefined) =>
    waitDetail(waitWords(reason, { branch: 'agent/1', base: '', findings: [] }), reason, t, true)

  it('prints the recommendation and triage’s own words for a reason with no recommendation line', () => {
    const lines = detail(disagrees, triage())
    expect(lines.some((l) => l.includes('recommends a fix round'))).toBe(true)
    expect(lines).toContain('triage advised Requeue: why')
  })

  it('prints what it printed before when there is no triage', () => {
    const words = waitWords(disagrees, { branch: 'agent/1', base: '', findings: [] })
    expect(detail(disagrees, undefined)).toEqual(describeWaitLines(words).map((l) => l.text))
    expect(detail(disagrees, undefined).join('\n')).not.toContain('recommends')
  })
})
