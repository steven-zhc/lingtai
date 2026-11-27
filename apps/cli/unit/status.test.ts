import { blockersLanded } from '@lingtai/conductor'
import {
  ceilingFacts,
  NO_ACCOUNTS,
  emptyAccount,
  emptyControl,
  locksOn,
  waitWords,
  type ControlState,
  type ProjectState,
} from '@lingtai/domain'
import { describeWaitLines, type readTasksEffect } from '@lingtai/projector'
import { Effect } from 'effect'
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
  readingOf,
  readStatus,
  renderStatus,
  conflictLines,
  conflictRecommendation,
  waitDetail,
  waitPassOf,
  statusJson,
  type StatusFilter,
  type StatusReading,
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
  newAttempts: 0,
  arm: null,
  held: null,
  unoffered: false,
  wait: null,
  run: null,
  system: null,
  ...over,
})

const asked: StatusWait = {
  reason: 'OwnQuestion',
  line: 'which   approach\nshould I take?',
  short: null,
  needs: 'judgement',
  words: 'waiting for your answer',
  detail: [],
  recommendation: null,
  command: 'lingtai answer lingtai --issue 609 "<choice>"   (or the board)',
  raw: true,
}

const fixture: StatusReport = {
  message: null,
  projects: [
    {
      project: 'lingtai',
      locks: [],
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
        row({
          taskId: 't612',
          ref: '612',
          held: 'backing off — runnable in 32m',
          newAttempts: 1,
          arm: 'new attempt 1 of 3',
        }),
        row({ taskId: 't613', ref: '613', kind: 'tech-debt', unoffered: true }),
      ],
      known: [
        row({
          taskId: 't612',
          ref: '612',
          held: 'backing off — runnable in 32m',
          newAttempts: 1,
          arm: 'new attempt 1 of 3',
        }),
        row({ taskId: 't609', ref: '609', state: 'waiting', wait: asked }),
        row({
          taskId: 't610',
          ref: '610',
          state: 'waiting',
          wait: {
            reason: 'Refused',
            line: 'the gate refused',
            short: null,
            needs: 'acknowledgement',
            words: null,
            detail: [],
            recommendation: null,
            command: 'one of: lingtai start-new-attempt lingtai --issue 610   (or the board)',
            raw: false,
          },
        }),
        row({ taskId: 't611', ref: '611', state: 'verifying' }),
        row({ taskId: 't600', ref: '600', state: 'landed' }),
      ],
    },
    {
      project: 'broken',
      locks: [],
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
      locks: [],
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
    const off = { newAttempts: 0, held: null, arm: null, unoffered: false }
    const r = (ref: string, kind = 'bug') => ({ taskId: `t${ref}`, ref, kind, title: `title of ${ref}` })
    expect(statusJson(fixture)).toEqual({
      projects: [
        {
          project: 'lingtai',
          locks: [],
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
          whyNothingRuns: null,
          dependenciesUnread: 'GitHub reported no issue dependencies for this repository',
          runnable: [
            { ...r('612'), newAttempts: 1, held: 'backing off — runnable in 32m', arm: 'new attempt 1 of 3' },
            { ...r('613', 'tech-debt'), newAttempts: 0, held: null, arm: null },
          ],
          byState: {
            queued: [
              { ...r('612'), ...off, newAttempts: 1, held: 'backing off — runnable in 32m', arm: 'new attempt 1 of 3' },
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
              detail: [],
              recommendation: null,
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
              recommendation: null,
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
          locks: [],
          passedOver: [],
          whyNothingRuns: null,
          dependenciesUnread: null,
          runnable: [],
          byState: {},
          waiting: [],
        },
        {
          project: 'down',
          locks: [],
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
          whyNothingRuns: null,
          dependenciesUnread: null,
          runnable: [],
          byState: {},
          waiting: [],
        },
      ],
    })
  })
})

describe('lingtai status says the conductor\'s recorded refusal instead of "no reason was found" (#1477)', () => {
  const detail = 'no lingtai-hook binary at /x/lingtai-hook'
  const at = new Date()
  const project = (over: Partial<ProjectState>): ProjectState => ({
    project: 'p',
    owner: null,
    base: 'main',
    configHash: 'h',
    fromSha: 's',
    refused: { ref: null, detail, codeSha: null, at } as ProjectState['refused'],
    paused: null,
    recipe: null,
    sandboxObserved: null,
    highestPr: null,
    version: 1,
    lastSeq: null,
    ...over,
  })
  const queued = [
    { taskId: 'p#1', issue: '1', kind: 'bug', title: 'one', state: 'queued', newAttempts: 0, updatedAt: null },
  ] as unknown as Effect.Success<ReturnType<typeof readTasksEffect>>
  const control: ControlState = {
    paused: false,
    by: null,
    reason: null,
    shutdown: null,
    requested: [],
    continuing: [],
    discussions: [],
    dayCeiling: { reached: null, raised: null },
  }
  const reading = (state: ProjectState, over: StatusReading = {}): StatusReading => ({
    projects: () => Effect.succeed([state]),
    tasks: () => Effect.succeed(queued),
    control: () => Effect.succeed(control),
    accounts: () => Effect.succeed(new Map()),
    beacon: () => Effect.succeed({ up: true }),
    conductorHeld: () => Effect.succeed(false),
    ...over,
  })
  const said = async (state: ProjectState, over: StatusReading = {}) => {
    const report = await Effect.runPromise(readStatus({}, reading(state, over)))
    return { report, text: renderStatus(report, { all: false }).join('\n') }
  }

  it('prints the refused sentence for a project whose setup is fine, and not "no reason was found"', async () => {
    const { report, text } = await said(project({}))
    expect(report.projects[0]?.whyNothingRuns?.roots[0]?.root).toBe('refused')
    expect(text).toContain(detail)
    expect(text).not.toContain('no reason was found')
  })

  it("prints it where the project's setup failed (no GitHub credentials), the failure standing beside it", async () => {
    const { report, text } = await said(project({ owner: 'steven-zhc' }), {
      clientFor: (() => Promise.reject(new Error('no GitHub App configured'))) as never,
    })
    expect(report.projects[0]?.filter.ok).toBe(false)
    expect(report.projects[0]?.whyNothingRuns?.roots[0]?.root).toBe('refused')
    expect(text).toContain(detail)
  })

  it('prints it for a project whose setup failed and whose queue the log has no row for yet', async () => {
    const { report, text } = await said(project({ owner: 'steven-zhc' }), {
      clientFor: (() => Promise.reject(new Error('no GitHub App configured'))) as never,
      tasks: () => Effect.succeed([] as never),
    })
    expect(report.projects[0]?.whyNothingRuns?.roots[0]?.root).toBe('refused')
    expect(text).toContain(detail)
  })

  it('says nothing more of a project the conductor has not refused', async () => {
    const { report } = await said(project({ refused: null, owner: 'steven-zhc' }), {
      clientFor: (() => Promise.reject(new Error('no GitHub App configured'))) as never,
    })
    expect(report.projects[0]?.whyNothingRuns ?? null).toBeNull()
  })
})

describe('renderStatus says what landed on the personal branch (#1423)', () => {
  const withLines = (landedLines: readonly string[]): StatusReport => ({
    ...fixture,
    projects: [{ ...fixture.projects[0]!, landedLines }, ...fixture.projects.slice(1)],
  })

  it('prints the line for a ticket taken despite GitHub marking it blocked', () => {
    const line = `#1396: ${blockersLanded([1395], 'steven-zhc/studio')}`
    const plain = renderStatus(withLines([line]), { all: false }).join('\n')
    expect(plain).toContain('(#1396: its blockers #1395 landed on steven-zhc/studio)')
  })

  it('prints nothing for a project with none', () => {
    expect(renderStatus(fixture, { all: false }).join('\n')).not.toContain('landed on')
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
    'new attempt 1 of 3', // the clock and the arm
    '[not offered]',
    'Waiting on you',
    '#609',
    'waiting for your answer: which approach should I take?', // one line, whitespace reduced
    'the gate refused',
    'lingtai answer lingtai --issue 609 "<choice>"   (or the board)',
  ])('prints %s', (fact) => {
    expect(plain).toContain(fact)
  })

  it('does not count a wait as "N waiting on you"', () => {
    expect(plain).not.toMatch(/\d+ waiting on you/)
  })

  it('prints no next: line after the block, the command being under its row', () => {
    expect(plain.split('\n').some((l) => l.startsWith('next:'))).toBe(false)
  })

  it('under --all, never says "failure" or repeats the judgement line', () => {
    const all = renderStatus(fixture, { all: true }).join('\n')
    expect(all).not.toContain('your judgement is needed')
    expect(all).not.toContain('a failure needs acknowledging')
    expect(all).not.toContain('failure itself')
    expect(all).toContain('#609')
    expect(all).toContain('[waiting for your answer]')
  })

  describe('a pass held for approval', () => {
    const held: StatusWait = {
      reason: 'SignoffRequired',
      line: 'ready to land — the recipe asks you to approve each attempt',
      short: 'ready to land',
      needs: 'judgement',
      words: 'waiting for your review',
      detail: ['ready to land — the recipe asks you to approve each attempt'],
      recommendation: null,
      command:
        'lingtai approve lingtai --issue 1   (or lingtai start-new-attempt lingtai --issue 1 [--into-body "<text>"], or the board)',
      raw: true,
    }
    const report: StatusReport = {
      ...fixture,
      projects: [
        {
          ...fixture.projects[0]!,
          known: [row({ taskId: 't1', ref: '1', title: 'Add the chapter', state: 'waiting', wait: held })],
        },
      ],
    }

    it('under --all keeps the unpushed suffix when the sentence is longer than a line', () => {
      const long = `ready to land — ${'x'.repeat(168)}`
      const suffix = '(and agent/1 was not pushed: remote rejected the push)'
      const wait: StatusWait = { ...held, line: long, detail: [`${long} ${suffix}`] }
      const r: StatusReport = {
        ...report,
        projects: [{ ...report.projects[0]!, known: [row({ taskId: 't1', ref: '1', state: 'waiting', wait })] }],
      }
      expect(renderStatus(r, { all: true }).join('\n')).toContain(suffix)
    })

    it.each([false, true])('says the sentence once, then the command (all: %s)', (all) => {
      const out = renderStatus(report, { all }).join('\n')
      const lines = out.split('\n').map((l) => l.trim())
      expect(lines.filter((l) => l === 'ready to land — the recipe asks you to approve each attempt')).toHaveLength(1)
      expect(out).toContain('#1  Add the chapter')
      expect(out).toContain(`lingtai approve ${report.projects[0]!.project} --issue 1   (or lingtai start-new-attempt`)
      expect(out).not.toContain('failure')
      expect(out).not.toContain('your judgement is needed')
      expect(out).not.toContain('a failure needs acknowledging')
      expect(out).not.toContain('waiting for your review:')
    })
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
    read: (o: unknown) => Effect.Effect<StatusReport, unknown>,
  ): Promise<{ code: number; out: string }> {
    vi.resetModules()
    vi.doMock('../src/status.ts', async (orig) => ({
      ...(await orig<typeof import('../src/status.ts')>()),
      readStatus: read,
    }))
    const { runCli } = await import('../test/cli.ts')
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
    const { code } = await run(argv, (o) => Effect.sync(() => (seen.push(o), { projects: [], message: 'none' })))
    expect(code).toBe(0)
    expect(seen).toEqual([{ project: 'lingtai', all: true }])
  })

  it('prints the one document under --json', async () => {
    const { code, out } = await run(['status', '--json'], () => Effect.succeed(fixture))
    expect(code).toBe(0)
    expect(JSON.parse(out)).toMatchObject({ version: 1, command: 'status', projects: [{ project: 'lingtai' }, {}, {}] })
  })

  it('reports a runtime failure as unavailable, not usage, and exits 1', async () => {
    // A store failure is a defect (0101 §6): the message printed is the one it carries.
    const failing = (): Effect.Effect<StatusReport, unknown> => Effect.die(new Error('no store configured'))
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
    const { code, out } = await run(['status', '--refresh', '--json'], () => Effect.succeed(fixture))
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
          locks: [],
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
          locks: [],
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

  it('recommends a refusal fix at 5 hunks or fewer and shows triage’s own resolution and summary', () => {
    const c = conflictLines(reason, triage(2))
    expect(c?.rec).toContain('recommends a refusal fix')
    expect(c?.advised).toBe('triage advised Requeue: why')
  })

  it('recommends triage’s resolution above 5 hunks', () => {
    expect(conflictLines(reason, triage(8, 'Close'))).toEqual({ rec: 'recommends Close — why', advised: null })
  })

  it('recommends triage’s resolution when the saved head is gone, as the task page does', () => {
    expect(conflictLines(reason, triage(2), false)).toEqual({ rec: 'recommends StartNewAttempt — why', advised: null })
    expect(conflictLines(reason, triage(2), true)?.rec).toContain('recommends a refusal fix')
  })

  it('says the saved head could not be checked, and recommends no refusal fix, when the read failed', () => {
    const c = conflictLines(reason, triage(2), { unreadable: 'rate limited' })
    expect(c?.rec).toBe('recommends StartNewAttempt — why')
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
    expect(lines.some((l) => l.includes('recommends a refusal fix'))).toBe(true)
    expect(lines).toContain('triage advised Requeue: why')
  })

  it('names the recommended resolution as a field, for --json, without parsing the prose', () => {
    expect(conflictRecommendation(disagrees, triage(), true)).toBe('FixRefusal')
    expect(conflictRecommendation(disagrees, undefined, true)).toBeNull()
  })

  it('still prints triage’s resolution and summary when the saved head is absent and no resolution is recommended', () => {
    const words = waitWords(disagrees, { branch: 'agent/1', base: '', findings: [] })
    const lines = waitDetail(words, disagrees, triage('GrantFixRound'), false)
    expect(conflictRecommendation(disagrees, triage('GrantFixRound'), false)).toBeNull()
    expect(lines.some((l) => l.includes('triage advised GrantFixRound: why'))).toBe(true)
    expect(lines.some((l) => l.includes('recommends'))).toBe(false)
  })

  it('drops the reason’s own recommendation line when the shared rule recommends nothing', () => {
    const words = {
      needs: 'judgement',
      diagnosis: {
        what: 'it conflicted',
        done: null,
        recommendation: { action: 'start-new-attempt', why: 'try again' },
      },
    } as never
    const lines = waitDetail(words, disagrees, triage('GrantFixRound'), false)
    expect(lines.some((l) => l.includes('recommends'))).toBe(false)
    expect(lines).toContain('it conflicted')
    expect(lines.some((l) => l.includes('triage advised GrantFixRound: why'))).toBe(true)
  })

  it('prints what it printed before when there is no triage', () => {
    const words = waitWords(disagrees, { branch: 'agent/1', base: '', findings: [] })
    expect(detail(disagrees, undefined)).toEqual(describeWaitLines(words).map((l) => l.text))
    expect(detail(disagrees, undefined).join('\n')).not.toContain('recommends')
  })
})

describe('readingOf', () => {
  const project = {} as never
  const refSha = vi.fn(async (ref: string) => (ref === 'heads/agent/9' ? 'sha-1' : null))
  const clientFor = (async () => ({ refSha })) as never

  it('Saved goes on to the remote compare', async () => {
    const saved = { _tag: 'Saved', head: 'sha-1', ref: 'agent/9' } as const
    expect(await readingOf(saved, project, clientFor)).toBe(true)
    expect(await readingOf({ ...saved, head: 'sha-2' }, project, clientFor)).toBe(false)
  })

  it('every other tag is false without asking the remote', async () => {
    refSha.mockClear()
    for (const saved of [
      { _tag: 'WipHead', arm: 'a', armSha: 's', recorded: true },
      { _tag: 'BranchDiverged', arm: 'a', branch: 'b' },
      { _tag: 'NoSavedHead' },
    ] as const)
      expect(await readingOf(saved, project, clientFor)).toBe(false)
    expect(refSha).not.toHaveBeenCalled()
  })
})

describe('what holds new work (#1005)', () => {
  const NOW = new Date(2026, 10, 11, 16, 50)
  const at = new Date(2026, 10, 11, 14, 20)
  const control = (dayCeiling: Partial<ControlState['dayCeiling']>): ControlState => ({
    ...emptyControl,
    dayCeiling: { ...emptyControl.dayCeiling, ...dayCeiling },
  })
  const reachedToday = { day: '2026-11-11', reportedUsd: 20, estimatedUsd: 5, ceilingUsd: 25, at, seq: 1 }
  const report = (state: ControlState | { unread: string }, configured = 25, projects = ['lingtai']): StatusReport => {
    const base = fixture.projects[0]!
    const ok = 'unread' in state ? null : state
    return {
      ...fixture,
      now: NOW,
      ceiling: ok === null ? { unread: (state as { unread: string }).unread } : ceilingFacts(ok, NOW, configured),
      projects: projects.map((name) => ({
        ...base,
        project: name,
        locks:
          ok === null
            ? { unread: (state as { unread: string }).unread }
            : locksOn({ control: ok, accounts: NO_ACCOUNTS }),
      })),
    }
  }
  const text = (r: StatusReport) => renderStatus(r).map(stripColour).join('\n')

  it('says the reached ceiling once, with the way on, and what it stops', () => {
    const out = text(report(control({ reached: reachedToday }), 25, ['a', 'b']))
    expect(out).toContain(
      'reached at 14:20 — $25.00 ceiling; no new work starts until midnight · lingtai ceiling raise <usd> to go on today',
    )
    expect(out.match(/reached at 14:20/g)).toHaveLength(1)
    expect(out).toContain('nothing starts: ceiling')
  })

  it('shows a project waiting on a limited runtime the lock’s sentence in its Project section', () => {
    const limit = {
      until: new Date(2026, 10, 11, 23, 0),
      untilFrom: 'message' as const,
      said: 'limit',
      named: null,
      since: new Date(2026, 10, 11, 18, 2),
      seq: 1n,
    }
    const accounts = new Map([['claude-code' as const, { ...emptyAccount, runtime: 'claude-code' as const, limit }]])
    const r = report(control({}))
    r.projects[0]!.locks = locksOn({ control: control({}), accounts })
    const out = text(r)
    expect(out).toContain(
      "lingtai waits for claude-code's usage limit until 23:00 (read from its message) — lingtai account lift claude-code once it is over",
    )
    expect(out).toContain('nothing starts: account')
  })

  it('prints the named limit on the account lock’s line (#1214)', () => {
    const limit = {
      until: new Date(2099, 10, 11, 23, 0),
      untilFrom: 'message' as const,
      said: 'limit',
      named: { kind: '5-hour' as const, resetsAt: new Date(2099, 10, 11, 23, 20) },
      since: new Date(2026, 10, 11, 18, 2),
      seq: 1n,
    }
    const accounts = new Map([['claude-code' as const, { ...emptyAccount, runtime: 'claude-code' as const, limit }]])
    const r = report(control({}))
    r.projects[0]!.locks = locksOn({ control: control({}), accounts })
    expect(text(r)).toContain("Claude Code's 5-hour limit, resets 2099-11-11 23:20")
  })

  it('says a passed ceiling lifts at the next look, and does not count it as stopping', () => {
    const out = text(report(control({ reached: { ...reachedToday, day: '2026-11-10' } })))
    expect(out).toContain('reached on 2026-11-10 — it lifts when the conductor next looks')
    expect(out).not.toContain('nothing starts')
  })

  it('says a raise, and the sentence line is not this one', () => {
    const out = text(
      report(
        control({
          raised: { day: '2026-11-11', fromUsd: 25, toUsd: 40, by: 'human:steven', at: new Date(2026, 10, 11, 16, 40) },
        }),
      ),
    )
    expect(out).toContain('today only: raised from $25.00 to $40.00 by human:steven at 16:40')
  })

  it('says what could not be read, per project too', () => {
    const out = text(report({ unread: 'store down' }))
    expect(out).toContain('could not read whether the ceiling holds — store down')
    expect(out).toContain('could not read what holds lingtai — store down')
    expect(out).toContain('what holds it could not be read')
  })

  it('draws a paused project', () => {
    const r = report(control({}))
    r.projects[0]!.locks = [{ kind: 'paused', by: 'human:steven', since: at }]
    const out = text(r)
    expect(out).toContain('paused by human:steven since 14:20 — lingtai resume lingtai')
    expect(out).toContain('nothing starts: paused')
  })

  it('--json carries the ceiling with ISO dates and every lock', () => {
    const r = report(control({ reached: reachedToday }))
    r.projects[0]!.locks = [...(r.projects[0]!.locks as never[]), { kind: 'paused', by: 'human:steven', since: at }]
    const j = statusJson(r) as any
    expect(j.ceiling.reached.since).toBe(at.toISOString())
    expect(j.projects[0].locks.map((l: any) => l.kind)).toEqual(['ceiling', 'paused'])
    expect(statusJson(report({ unread: 'x' })).ceiling).toEqual({ unread: 'x' })
    expect(j.projects[0].locks[0].since).toBe(at.toISOString())
  })
})

describe('waitPassOf (#1030)', () => {
  const reason = {
    _tag: 'MergeRefused',
    run: { runId: 'r', ref: 'agent/1', sha: 'abc' },
    reason: 'push-rejected',
    raw: 'rejected',
  } as never
  const first = (base: string | null) => {
    const pass = waitPassOf('1', base)
    return waitDetail(waitWords(reason, pass), reason, undefined)[0]
  }
  it('names the project’s base in a refusal, and says the base when none is recorded', () => {
    expect(first('main')).toMatch(/^main moved while agent\/1/)
    expect(first(null)).toMatch(/^the base moved while agent\/1/)
  })
})

describe('whyNothingRuns under Queue (#1215)', () => {
  const root = (sentence: string, tickets: number[]) => ({ root: 'chain' as const, sentence, tickets })
  const withWhy = (): StatusReport => ({
    ...fixture,
    projects: [
      {
        ...fixture.projects[0]!,
        whyNothingRuns: {
          roots: [
            root('3 tickets wait on #9, which waits on you', [1, 2, 3]),
            root('1 ticket waits on #8, which is on hold', [4]),
          ],
        },
      },
    ],
  })

  it('prints one line and "and N more", and every root under --all', () => {
    const plain = renderStatus(withWhy(), {}).join('\n')
    expect(plain).toContain('3 tickets wait on #9, which waits on you')
    expect(plain).toContain(', and 1 more ticket for other reasons')
    expect(plain).not.toContain('#8, which is on hold')
    const all = renderStatus(withWhy(), { all: true }).join('\n')
    expect(all).toContain('#8, which is on hold')
    expect(all).not.toContain('for other reasons')
  })

  it('carries the first root in --json, the rest only under --all', () => {
    const one = (statusJson(withWhy()).projects as { whyNothingRuns: Record<string, unknown> }[])[0]!.whyNothingRuns
    expect(one).toEqual({
      root: 'chain',
      sentence: '3 tickets wait on #9, which waits on you',
      tickets: [1, 2, 3],
      moreTickets: 1,
    })
    const all = (statusJson(withWhy(), true).projects as { whyNothingRuns: { others: unknown[] } }[])[0]!.whyNothingRuns
    expect(all.others).toHaveLength(1)
  })
})

describe('renderStatus: what the system decided (#1259)', () => {
  it('prints the line under the ticket, in a section of its own', () => {
    const base = fixture.projects[0]!
    const decided = row({
      taskId: 't1',
      ref: '77',
      state: 'running',
      system: 'Triage read only unfinished; the step is being redone — 2 of 3 redos used',
    })
    const out = renderStatus(
      { ...fixture, projects: [{ ...base, known: [...base.known, decided] }] },
      { all: false },
    ).join('\n')
    expect(out).toContain('Decided for you')
    expect(out).toContain('#77')
    expect(out).toContain('the step is being redone — 2 of 3 redos used')
  })
  it('says nothing where no row carries one', () => {
    expect(renderStatus(fixture, { all: false }).join('\n')).not.toContain('Decided for you')
  })
})
