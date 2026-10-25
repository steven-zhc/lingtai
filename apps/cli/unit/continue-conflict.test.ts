/**
 * `lingtai continue-conflict` (#559): what it prints, and the outcomes it keeps
 * apart when it submits. Every port is a fake; `resolveWait` itself is held to
 * the same refusals in `packages/conductor/unit/resolve-wait.test.ts`.
 */
import { CONTROL_STREAM, ticketStream, type Envelope, type ProjectState } from '@lingtai/domain'
import { describe, expect, it, vi } from 'vitest'

import { continueConflictCommand, parseChoices, type ContinueConflictDeps } from '../src/continue-conflict.ts'

const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const ticketId = ticketStream('p', 7)

const env = (streamId: string, type: string, data: unknown, seq: number): Envelope =>
  ({ streamId, type, data, seq, at: new Date(seq * 1000), version: 1 }) as unknown as Envelope

const own = [
  env(
    ticketId,
    'WaitStarted',
    {
      waitId: 'w1',
      runId: 'run-1',
      reason: {
        _tag: 'ProposedEscalated',
        run: { runId: 'run-1' },
        proposal: { _tag: 'MergeConflict', output: 'c', paths: ['a.ts'], baseSha: BASE, headSha: HEAD },
      },
    },
    1,
  ),
]
const run = [env('run-1', 'RunRefsPublished', { outcome: 'published', branch: 'agent/7', headSha: HEAD }, 1)]

const harness = (
  resolve?: ContinueConflictDeps['resolve'],
  conflicts?: ContinueConflictDeps extends never ? never : unknown,
) => {
  const lines: string[] = []
  const deps: ContinueConflictDeps = {
    events: async (stream) => (stream === ticketId ? own : run),
    load: async () => ({ project: 'p', owner: null }) as unknown as ProjectState,
    ports: async () => ({
      ok: true,
      client: { refSha: async (ref: string) => (ref === 'heads/main' ? BASE : HEAD) },
      base: 'main',
      conflicts:
        (conflicts as never) ??
        (async () => [{ path: 'a.ts', hunkLines: [3, 9], hunkTexts: ['<<<<<<< x', '<<<<<<< y'] }]),
    }),
    resolve: resolve ?? (vi.fn() as never),
    by: 'human:test',
  }
  return { lines, deps, log: (l: string) => lines.push(l) }
}

describe('continue-conflict', () => {
  it('prints base, head, every counted row and the exact command, and appends nothing', async () => {
    const h = harness()
    expect(await continueConflictCommand({ project: 'p', issue: 7 }, h.log, h.deps)).toBe(0)
    const out = h.lines.join('\n')
    expect(out).toContain(BASE)
    expect(out).toContain(HEAD)
    expect(out).toContain('a.ts:3')
    expect(out).toContain('a.ts:9')
    expect(out).toContain('no advice — your own intent is required')
    expect(out).toContain(`--if-base ${BASE} --if-head ${HEAD}`)
    expect(h.deps.resolve).not.toHaveBeenCalled()
  })

  it('refuses to fabricate choices for rows with no advice, naming them', async () => {
    const h = harness()
    const code = await continueConflictCommand(
      { project: 'p', issue: 7, ifBase: BASE, ifHead: HEAD, acceptRecommended: true },
      h.log,
      h.deps,
    )
    expect(code).toBe(1)
    expect(h.lines.join('\n')).toContain('a.ts:3, a.ts:9')
    expect(h.deps.resolve).not.toHaveBeenCalled()
  })

  it('refuses a confirmation whose base or head is not the one now printed', async () => {
    const h = harness()
    const code = await continueConflictCommand(
      { project: 'p', issue: 7, ifBase: 'c'.repeat(40), ifHead: HEAD, choices: { 'a.ts:3': 'mechanical' } },
      h.log,
      h.deps,
    )
    expect(code).toBe(1)
    expect(h.lines.join('\n')).toContain('moved since you read it')
    expect(h.deps.resolve).not.toHaveBeenCalled()
  })

  it('submits every confirmed hunk, and reports each outcome distinctly', async () => {
    const choices = { 'a.ts:3': 'mechanical', 'a.ts:9': { behavior: 'keep the base timeout' } }
    const submit = async (result: unknown) => {
      const resolve = vi.fn(async () => result) as never
      const h = harness(resolve)
      const code = await continueConflictCommand(
        { project: 'p', issue: 7, ifBase: BASE, ifHead: HEAD, choices },
        h.log,
        h.deps,
      )
      return { code, out: h.lines.join('\n'), resolve: resolve as unknown as ReturnType<typeof vi.fn> }
    }

    const ok = await submit({ ok: true, ticketId })
    expect(ok.code).toBe(0)
    expect(ok.out).toContain('confirmed; an AI will continue')
    expect(ok.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: expect.objectContaining({
          _tag: 'ContinueConflict',
          ref: 'agent/7',
          grantExtraRound: false,
          hunks: [
            { _tag: 'Mechanical', path: 'a.ts', line: 3 },
            { _tag: 'Divergent', path: 'a.ts', line: 9, behavior: 'keep the base timeout', adopted: null },
          ],
        }),
      }),
    )

    expect((await submit({ ok: true, ticketId, rescheduled: true })).out).toContain('already confirmed')
    const unscheduled = await submit({ ok: true, ticketId, unscheduled: 'boom' })
    expect(unscheduled.code).toBe(1)
    expect(unscheduled.out).toContain('not scheduled')
    for (const reason of ['base-moved', 'head-moved', 'ref-missing', 'ref-moved']) {
      const refused = await submit({ ok: false, ticketId, reason, detail: 'nope' })
      expect(refused.code).toBe(1)
      expect(refused.out).toContain(`not confirmed (${reason})`)
    }
  })

  it('draws a past-one-by-one conflict as a refusal that points at requeue', async () => {
    const many = Array.from({ length: 21 }, (_, i) => i + 1)
    const h = harness(undefined, async () => [{ path: 'a.ts', hunkLines: many }])
    expect(await continueConflictCommand({ project: 'p', issue: 7 }, h.log, h.deps)).toBe(1)
    expect(h.lines.join('\n')).toContain('21 hunks')
    expect(h.lines.join('\n')).toContain('requeue')
  })

  it('refuses a choices key that names no counted hunk instead of falling back to a recommendation', async () => {
    const h = harness()
    const code = await continueConflictCommand(
      {
        project: 'p',
        issue: 7,
        ifBase: BASE,
        ifHead: HEAD,
        choices: { 'a.ts:4': 'mechanical' },
        acceptRecommended: true,
      },
      h.log,
      h.deps,
    )
    expect(code).toBe(2)
    expect(h.lines.join('\n')).toContain('a.ts:4')
    expect(h.deps.resolve).not.toHaveBeenCalled()
  })

  describe('an already confirmed, unscheduled continuation', () => {
    const recorded = {
      _tag: 'ContinueConflict',
      baseSha: BASE,
      headSha: HEAD,
      ref: 'agent/7',
      hunks: [{ _tag: 'Mechanical', path: 'a.ts', line: 3 }],
      grantExtraRound: false,
    }
    const approved = [
      ...own,
      env(ticketId, 'WaitResolved', { waitId: 'w1', resolution: recorded }, 2),
      env(ticketId, 'WaitApproved', { waitId: 'w1', grantRef: 'agent/7' }, 3),
    ]
    const requested = (seq: number, data: object = {}) =>
      env(
        CONTROL_STREAM,
        'ContinueRequested',
        { project: 'p', issue: '7', runId: 'run-1', by: 'human:x', waitId: 'w1', ...data },
        seq,
      )
    const go = async (opts: object, control: Envelope[] | 'unreadable' = [requested(4)]) => {
      const resolve = vi.fn(async () => ({ ok: true, ticketId, rescheduled: true })) as never
      const h = harness(resolve)
      h.deps.events = async (stream) => {
        if (stream === CONTROL_STREAM && control === 'unreadable') throw new Error('connection reset')
        return stream === ticketId ? approved : stream === CONTROL_STREAM ? (control as Envelope[]) : run
      }
      const code = await continueConflictCommand({ project: 'p', issue: 7, ...opts }, h.log, h.deps)
      return { code, lines: h.lines.join('\n'), resolve: resolve as unknown as ReturnType<typeof vi.fn> }
    }

    it('says requested, and exits 0, only when a ContinueRequested for this wait is on the log', async () => {
      const r = await go({})
      expect(r.code).toBe(0)
      expect(r.lines).toContain('the continuation was requested at')
      expect(r.lines).not.toContain('--if-base')
      expect(r.resolve).not.toHaveBeenCalled()
    })

    it('says nothing was scheduled, and exits 1, for an approved wait with no ContinueRequested', async () => {
      const r = await go({}, [])
      expect(r.code).toBe(1)
      expect(r.lines).toContain('no continuation request for this confirmation is on the log')
      expect(r.lines).toContain(`--if-base ${BASE} --if-head ${HEAD}`)
      expect(r.lines).not.toContain('was requested')
      expect(r.resolve).not.toHaveBeenCalled()
    })

    it('does not count a row for another wait, run or issue', async () => {
      const rows = [requested(4, { waitId: 'w0' }), requested(4, { runId: 'run-0' }), requested(4, { issue: '8' })]
      for (const row of rows) {
        const r = await go({}, [row])
        expect(r.code).toBe(1)
        expect(r.lines).toContain('no continuation request for this confirmation is on the log')
      }
    })

    it('says a request made before requests named their wait may still start the run, and prints no recovery', async () => {
      const r = await go({}, [requested(4, { waitId: null })])
      expect(r.code).toBe(0)
      expect(r.lines).toContain('before requests named their wait')
      expect(r.lines).not.toContain('--if-base')
    })

    it('does not call an unreadable control stream unscheduled, and prints a retry of the same inspection', async () => {
      const r = await go({}, 'unreadable')
      expect(r.code).toBe(1)
      expect(r.lines).toContain('could not be read')
      expect(r.lines).not.toContain('no continuation request')
      expect(r.lines).toContain('lingtai continue-conflict p --issue 7')
      expect(r.lines).not.toContain('--if-base')
    })

    it('refuses a base or head other than the recorded one, and choices that differ', async () => {
      expect((await go({ ifBase: 'c'.repeat(40), ifHead: HEAD })).resolve).not.toHaveBeenCalled()
      const other = await go({ ifBase: BASE, ifHead: HEAD, choices: { 'a.ts:3': { behavior: 'x' } } })
      expect(other.code).toBe(1)
      expect(other.resolve).not.toHaveBeenCalled()
    })

    it('refuses --accept-recommended when the recorded hunk is not what triage recommended', async () => {
      expect((await go({ ifBase: BASE, ifHead: HEAD, acceptRecommended: true })).resolve).not.toHaveBeenCalled()
    })

    it('the printed recovery command, with just the recorded base and head, resends the record', async () => {
      const r = await go({ ifBase: BASE, ifHead: HEAD }, [])
      expect(r.code).toBe(0)
      expect(r.resolve).toHaveBeenCalledWith(expect.objectContaining({ resolution: recorded }))
    })

    it('resends the recorded resolution when the caller agrees with it', async () => {
      const r = await go({ ifBase: BASE, ifHead: HEAD, choices: { 'a.ts:3': 'mechanical' } })
      expect(r.code).toBe(0)
      expect(r.resolve).toHaveBeenCalledWith(expect.objectContaining({ resolution: recorded }))
    })
  })

  it('reports a completed continuation, once the item has left approved, as done rather than as not continuable', async () => {
    const h = harness()
    h.deps.events = async () => [
      ...own,
      env(
        ticketId,
        'WaitResolved',
        { waitId: 'w1', resolution: { _tag: 'ContinueConflict', baseSha: BASE, headSha: HEAD, ref: 'agent/7' } },
        2,
      ),
      env(ticketId, 'WaitApproved', { waitId: 'w1', grantRef: 'agent/7' }, 3),
      env(ticketId, 'TicketClaimed', { runId: 'run-2', title: null, kind: null }, 4),
    ]
    expect(await continueConflictCommand({ project: 'p', issue: 7 }, h.log, h.deps)).toBe(0)
    expect(h.lines.join('\n')).toContain('was taken up')
    expect(h.lines.join('\n')).not.toContain('not waiting')
  })

  it('does not call a confirmation taken up when the approved ticket was closed before any claim', async () => {
    const h = harness()
    h.deps.events = async () => [
      ...own,
      env(
        ticketId,
        'WaitResolved',
        { waitId: 'w1', resolution: { _tag: 'ContinueConflict', baseSha: BASE, headSha: HEAD, ref: 'agent/7' } },
        2,
      ),
      env(ticketId, 'WaitApproved', { waitId: 'w1', grantRef: 'agent/7' }, 3),
      env(ticketId, 'TicketClosed', { reason: 'operator', by: 'human:x' }, 4),
    ]
    expect(await continueConflictCommand({ project: 'p', issue: 7 }, h.log, h.deps)).toBe(1)
    expect(h.lines.join('\n')).not.toContain('was taken up')
  })

  it('reports a landed ticket as complete rather than as not continuable', async () => {
    const h = harness()
    h.deps.events = async () => [
      ...own,
      env(ticketId, 'TicketLanded', { mergeCommit: 'm'.repeat(40), base: 'main' }, 2),
    ]
    expect(await continueConflictCommand({ project: 'p', issue: 7 }, h.log, h.deps)).toBe(0)
    expect(h.lines.join('\n')).toContain('landed')
  })

  it('parses the choices file strictly', () => {
    expect(parseChoices({ 'a.ts:1': { answer: 'x' } })).toEqual({ 'a.ts:1': { _tag: 'Answer', answerId: 'x' } })
    expect(parseChoices({ 'a.ts:1': 3 })).toMatch(/must be/)
    expect(parseChoices([])).toMatch(/JSON object/)
  })
})
