/**
 * The task page, arranged: the answer on the first screen, the rest a record.
 *
 * **Judged by four questions** (#152) — *what* state and how long, *why* in the
 * words of whatever stopped it, *so what* in one sentence, *now what* as the
 * moves — and the page failed it while being complete: the answer was in there,
 * and the reader composed it out of four tickets' sentences.
 *
 * The two snapshots are the arrangement and not the markup: each rank, in the
 * order it is on the page, with the words it holds. **A later ticket that adds
 * a sentence has to say which rank it goes in**, because the snapshot will name
 * it — and a sentence that lands in rank 3 will not fit in one.
 *
 * What is not asserted, said rather than left to be discovered: the pixels.
 * *No scrolling at 1280×800* is a fact about the stylesheet this suite has no
 * browser to measure. What is asserted is the half the markup decides — the
 * moves come before anything that can grow.
 */
import { readFileSync } from 'node:fs'

import type { StepPlan } from '@lingtai/conductor/filter'
import type { Envelope } from '@lingtai/domain'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { RECORD_TABS, TaskBody, UnpushedBanner } from '../src/app/task/[id]/page.tsx'
import type { OutgoingView } from '../src/lib/prompt.ts'
import {
  foldRun,
  standingOf,
  totalsOf,
  type Claim,
  type DiscussionView,
  type RunView,
  type TaskDetail,
  type TicketView,
} from '../src/lib/task.ts'

const NOW = new Date('2026-09-14T09:00:00Z')
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterAll(() => {
  vi.useRealTimers()
})

let seq = 0n
function e(streamId: string, type: string, data: unknown, at = '2026-09-14T04:27:00Z'): Envelope {
  seq += 1n
  return { seq, streamId, version: 1, type, schemaVer: 1, data, actor: 'conductor', causation: null, at: new Date(at) }
}

const ITEM = 'ticket-lingtai-147'
const RUN = 'pass-52feebd1-0000-0000-0000-000000000000'
const BASE = 'b'.repeat(40)
const HEAD = 'a4e9df9'.padEnd(40, '0')

/** A `verdict`-yield action, the shape a gate's own check or review declares (#502). */
function verdictAction(name: string, evidence: string, verdict: 'accepted' | 'refused', onSha = HEAD) {
  return {
    plugin: 'run',
    name,
    onSha,
    evidence,
    yields: 'verdict',
    result: { _tag: 'Completed', assessment: { verdict, findings: [] } },
  }
}
const claim: Claim = { runId: RUN, at: '2026-09-14T04:00:00.000Z', repair: false, released: null }

const TICKET: TicketView = {
  project: 'lingtai',
  ref: '147',
  title: 'the reviewer crashes on a reused session id',
  kind: 'bug',
  labels: ['bug'],
  url: 'https://github.com/example/lingtai/issues/147',
  body: 'The reviewer crashed.',
  found: true,
  askedGitHub: true,
  problem: null,
}

const CRASH = 'the reviewer did not finish (crash): Error: Session ID 1d391e10 is already in use.'

const task = (own: Envelope[], runs: RunView[], rest: Partial<TaskDetail> = {}): TaskDetail => ({
  taskId: ITEM,
  unpushedMirror: null,
  standing: standingOf(own, runs),
  want: null,
  ticket: TICKET,
  runs,
  discussions: [],
  outgoing: null,
  queued: null,
  held: null,
  totals: totalsOf(runs),
  spendCurrency: { lag: 0 },
  history: [],
  ...rest,
})

/** `ticket-lingtai-147` on 2026-09-14, as the ticket quotes it. */
function blocked(): TaskDetail {
  const run = foldRun(claim, 1, [
    e(RUN, 'RunStarted', { baseSha: BASE }),
    e(RUN, 'RunProposedCompletion', { headSha: HEAD }),
    e(RUN, 'StepStarted', { step: 'proposed', round: 0 }),
    e(RUN, 'StepEnded', {
      outcome: { step: 'proposed', round: 0, actions: [verdictAction('review', CRASH, 'refused')] },
    }),
    e(RUN, 'RunFinished', { turns: 30, durationMs: 900_000, exitCode: 0 }),
  ])
  const own = [
    e(ITEM, 'TicketClaimed', { runId: RUN }, '2026-09-14T04:00:00Z'),
    e(
      ITEM,
      'WaitStarted',
      {
        // `done`'s round-count narrative and `recommendation`'s custom reading
        // are not on a `WaitReason` (0118 §1 did not carry them) — an accepted
        // loss `wait-words.ts`'s own header documents.
        waitId: 'wait-147',
        reason: {
          _tag: 'CheckRefused',
          run: { runId: RUN },
          step: 'proposed',
          action: 'review',
          evidence: CRASH,
          findings: [],
        },
      },
      '2026-09-14T04:27:00Z',
    ),
  ]
  const outgoing: OutgoingView = {
    text: '#147 — the reviewer crashes on a reused session id\n\nThe reviewer crashed.\n',
    version: 'ticket@1924',
    basedOn: 'ticket@1924',
    attempt: 2,
    edit: null,
    delta: { added: 0, removed: 0 },
    problem: null,
  }
  const discussion: DiscussionView = {
    chatId: 'chat-1',
    attempt: 1,
    waiting: true,
    costUsd: 0.12,
    held: null,
    turns: [
      {
        question: 'did the reviewer run at all?',
        by: 'human:steven',
        at: '2026-09-14T05:00:00.000Z',
        reading: [],
        answer: {
          text: 'No — it crashed on start.',
          failure: null,
          cannot: [],
          read: [],
          costUsd: 0.12,
          proposal: null,
        },
      },
      {
        question: 'so is requeue safe?',
        by: 'human:steven',
        at: '2026-09-14T05:01:00.000Z',
        reading: [],
        answer: null,
      },
    ],
  }
  return task(own, [run], { outgoing, discussions: [discussion] })
}

function running(): TaskDetail {
  const run = foldRun(claim, 1, [e(RUN, 'RunStarted', { baseSha: BASE })])
  return task([e(ITEM, 'TicketClaimed', { runId: RUN }, '2026-09-14T08:40:00Z')], [run])
}

const page = (t: TaskDetail) => renderToStaticMarkup(<TaskBody task={t} />)

describe('unpushed work', () => {
  const ref = `refs/lingtai/unpushed/147/${RUN}`
  const arm = 'refs/heads/agent/147-arm-1'
  const unpushed = {
    branch: 'agent/147',
    said: 'remote rejected the push',
    keptAt: { _tag: 'Mirror' as const, ref, sha: HEAD, arm },
  }
  const mirror = { path: '/tmp/local mirror/lingtai.git', sha: HEAD }
  const banner = (
    work: typeof unpushed | { branch: string; said: string; keptAt?: { _tag: 'Arm'; ref: string; sha: string } },
    checked: TaskDetail['unpushedMirror'],
  ) => renderToStaticMarkup(<UnpushedBanner unpushed={work} mirror={checked} />)

  it('shows the local mirror rescue command and the credentials it uses', () => {
    const html = banner(unpushed, mirror)
    expect(html).toContain('remote rejected the push')
    expect(html).toContain(`git -C &#x27;/tmp/local mirror/lingtai.git&#x27; push origin &#x27;+${ref}:${arm}&#x27;`)
    expect(html).toContain('your own git credentials')
  })

  it('offers no command when the kept ref is absent or points elsewhere', () => {
    const absent = banner(unpushed, { ...mirror, sha: null })
    expect(absent).toContain('no longer in the mirror')
    expect(absent).not.toContain('git -C')
    const changed = banner(unpushed, { ...mirror, sha: BASE })
    expect(changed).toContain('no longer names the recorded commit')
    expect(changed).not.toContain('git -C')
  })

  it('names an arm already on origin and says when no commits were kept', () => {
    expect(banner({ ...unpushed, keptAt: { _tag: 'Arm', ref: arm, sha: HEAD } }, null)).toContain(
      `The commits are on origin at ${arm}`,
    )
    expect(banner({ branch: 'agent/147', said: 'push failed' }, null)).toContain('The commits were not kept')
  })

  it('puts the banner before the standing block', () => {
    const t = blocked()
    const html = page({ ...t, standing: { ...t.standing, unpushed }, unpushedMirror: mirror })
    const body = html.slice(html.indexOf('class="detail-body"'))
    expect(body.indexOf('data-rank="unpushed"')).toBeLessThan(body.indexOf('class="standing'))
  })
})

/**
 * Each rank, in page order, with the words in it. The record is its row names
 * only: the record is consulted, and what is in it is not the arrangement.
 */
function arrangement(html: string): string {
  const marks = [...html.matchAll(/data-rank="([a-z-]+)"/g)]
  return marks
    .map((mark, i) => {
      const next = marks[i + 1]?.index
      // Up to the opening of the next rank's own element, not into it.
      const chunk = html.slice(mark.index, next === undefined ? html.length : html.lastIndexOf('<', next))
      if (mark[1] === 'record') {
        return `record: ${[...chunk.matchAll(/class="rname">([^<]+)</g)].map((m) => m[1]).join(' · ')}`
      }
      const text = chunk
        .slice(chunk.indexOf('>') + 1)
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      return `${mark[1]}: ${text}`
    })
    .join('\n')
}

/** Every class this palette paints brass. See `globals.css`'s `--signal`. */
const BRASS =
  /btn pri|standing onyou|class="rec"|pill sig|class="question"|class="note"|class="chat"[^>]*>[\s\S]*chatcannot/

describe('a blocked task', () => {
  it('is arranged as the four questions, then the record', () => {
    expect(arrangement(page(blocked()))).toMatchSnapshot()
  })

  it('puts the ranks in order: coordinates, state, why, so what, moves, pair, record', () => {
    const html = page(blocked())
    const at = (rank: string) => html.indexOf(`data-rank="${rank}"`)
    const order = ['coords', 'state', 'why', 'so-what', 'moves', 'pair', 'record'].map(at)
    expect(order.every((i) => i > -1)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('reads an advised wait as ticket, where, triage, resolutions, record', () => {
    const t = blocked()
    const standing: TaskDetail['standing'] = {
      ...t.standing,
      triageStatus: {
        _tag: 'Done',
        result: {
          _tag: 'TriageAdvised',
          cause: { _tag: 'WrongApproach' },
          resolution: 'Requeue',
          summary: 'Start again from the current base',
          want: 'Get the reviewer running',
        },
      },
    }
    const html = page({ ...t, standing, want: 'Get the reviewer running' })
    const positions = ['subject', 'where', 'triage', 'resolutions', 'record'].map((rank) =>
      html.indexOf(`data-rank="${rank}"`),
    )
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(html.indexOf('Send attempt 2')).toBeLessThan(html.indexOf('>Close</button>'))
    expect(html.slice(0, positions[4])).not.toContain('<pre class="sraw"')
    expect(html.slice(positions[4])).toContain(`<pre class="sraw">${CRASH}</pre>`)
  })

  it('puts a recommended body edit before the other resolutions in reading order', () => {
    const t = blocked()
    const standing: TaskDetail['standing'] = {
      ...t.standing,
      triageStatus: {
        _tag: 'Done',
        result: {
          _tag: 'TriageAdvised',
          cause: { _tag: 'WrongApproach' },
          resolution: 'EditBodyAndRequeue',
          summary: 'Add the missing context',
          want: 'Get the reviewer running',
        },
      },
    }
    const html = page({ ...t, standing })
    const resolutions = html.slice(html.indexOf('data-rank="resolutions"'), html.indexOf('data-rank="pair"'))
    expect(resolutions.indexOf('data-resolution="EditBodyAndRequeue"')).toBeLessThan(
      resolutions.indexOf('data-resolution="Requeue"'),
    )
    expect(resolutions.indexOf('Text to add to the ticket body')).toBeLessThan(resolutions.indexOf('Send attempt 2'))
    expect(resolutions).toContain('Triage recommended')
  })

  it('keeps the raw refusal in Attempts, after the decision', () => {
    const html = page(blocked())
    const why = html.slice(html.indexOf('data-rank="why"'), html.indexOf('data-rank="so-what"'))
    const attempts = html.slice(html.indexOf('id="record-attempts"'))
    expect(why).not.toContain('<pre class="sraw"')
    expect(attempts).toContain('<details class="sreason" open=""')
    expect(attempts).toContain(CRASH)
  })

  it('prints each identifier once', () => {
    const read = page(blocked()).replace(/<[^>]*>/g, ' ')
    const count = (needle: string) => read.split(needle).length - 1
    expect(count(ITEM)).toBe(1)
    // Short or as the whole uuid, the run is printed once: the attempt row's.
    expect(count('pass-52feebd1')).toBe(1)
  })
})

describe('a running task', () => {
  it('is arranged with the live log where a refusal would be', () => {
    expect(arrangement(page(running()))).toMatchSnapshot()
  })

  it("follows the run's log at rank 2, open, in the slot and the teal", () => {
    const html = page(running())
    const why = html.slice(html.indexOf('data-rank="why"'), html.indexOf('data-rank="so-what"'))
    expect(why).toContain('<details class="alog slog" open=""')
    expect(html).toContain('class="standing live"')
    // One follower for one file: the attempt row points up instead.
    expect(html.split('<details class="alog').length - 1).toBe(1)
    expect(html).toContain('being followed at the top of this page')
  })

  it('wears no brass anywhere, because nobody is waiting on you', () => {
    // An answered turn with everything in it the box paints amber on a blocked
    // page: `cannot` lines, and a proposal whose primary button is brass.
    const talk: DiscussionView = {
      chatId: 'chat-2',
      attempt: 1,
      waiting: false,
      costUsd: 0.2,
      held: null,
      turns: [
        {
          question: 'what would you change?',
          by: 'human:steven',
          at: '2026-09-14T08:50:00.000Z',
          reading: [],
          answer: {
            text: 'The session id.',
            failure: null,
            cannot: ['run the reviewer'],
            read: [],
            costUsd: 0.2,
            proposal: { kind: 'prompt', text: 'use a fresh session id' },
          },
        },
      ],
    }
    const quiet = page({ ...running(), discussions: [talk] })
    // Not vacuous: the turn rendered, with its cannot line and its buttons.
    expect(quiet).toContain('class="chatcannot"')
    expect(quiet).toContain('Use for the next run')
    expect(quiet).toContain('class="chat quiet"')
    expect(quiet).not.toMatch(BRASS)
    // The cannot rule's amber is the stylesheet's, so the override is read there.
    const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.chat\.quiet \.chatcannot\s*\{[^}]*border-left-color:\s*var\(--rule-2\)/)

    // And the same turn on the blocked page is brass, which is what makes the
    // assertions above mean something.
    const loud = page({ ...blocked(), discussions: [talk] })
    expect(loud).toMatch(BRASS)
    expect(loud.replace(/btn pri/g, '')).toMatch(/class="chat"[^>]*>[\s\S]*chatcannot/)
  })
})

/**
 * The rail, on the page about the one run (#189).
 *
 * The card said which point a run was at, how long it had been there and what
 * bounded it; the page listed the five points off a fold with no `running` and
 * no `never-ran`, inside a closed row, and lit nothing. These assert the reading
 * is here, from the same `Rail`, and that the record's segments can say the one
 * state the old list could not.
 */
describe('the rail on the task page', () => {
  const PLAN: StepPlan = new Map([
    [
      'proposed',
      [
        { name: 'build', budgetMs: 20 * 60_000 },
        { name: 'review', budgetMs: null },
      ],
    ],
  ]) as unknown as StepPlan

  const resolved = e(
    RUN,
    'StepsResolved',
    {
      steps: [
        { step: 'prepared', actions: ['install'] },
        { step: 'admit', actions: [] },
        { step: 'proposed', actions: ['build', 'review'] },
        { step: 'merge', actions: [] },
        { step: 'end', actions: [] },
      ],
    },
    '2026-09-14T08:40:00Z',
  )

  function building(plan?: StepPlan): TaskDetail {
    const run = foldRun(
      claim,
      1,
      [
        e(RUN, 'RunStarted', { baseSha: BASE }, '2026-09-14T08:40:00Z'),
        resolved,
        e(RUN, 'StepStarted', { step: 'prepared', round: 0 }, '2026-09-14T08:40:30Z'),
        e(
          RUN,
          'StepEnded',
          { outcome: { step: 'prepared', round: 0, actions: [verdictAction('install', 'ok', 'accepted')] } },
          '2026-09-14T08:41:00Z',
        ),
        e(RUN, 'RunFinished', { turns: 9, durationMs: 600_000, exitCode: 0 }, '2026-09-14T08:50:00Z'),
        e(RUN, 'StepStarted', { step: 'proposed', round: 0 }, '2026-09-14T08:57:26Z'),
      ],
      { plan },
    )
    return task([e(ITEM, 'TicketClaimed', { runId: RUN }, '2026-09-14T08:40:00Z')], [run])
  }

  const why = (html: string) => html.slice(html.indexOf('class="swhere"'), html.indexOf('data-rank="so-what"'))
  const record = (html: string) => html.slice(html.indexOf('data-rank="record"'))

  /**
   * **Since `#502`, `StepStarted` carries `{step, round}` alone** — 0120's own
   * Consequences: the board loses which action of a step is running, and with
   * it the per-action budget this test used to read while a point was still
   * in flight. There is no `build` to name any more and no `/ 20m` to draw —
   * the point itself (`proposed`) and the elapsed time are all that survive.
   */
  it('says which point and the elapsed at rank 2, with no per-action name or bound', () => {
    const html = page(building(PLAN))
    const rank = why(html)
    // The rail is the card's own: the same classes, drawn by the same `Rail`.
    expect(rank).toContain('class="seq"')
    expect(rank).toMatch(/class="slab l-at">proposed</)
    expect(rank).toMatch(/class="snow"[^>]*>\s*2m34s</)
    expect(rank).not.toContain(' / ')
    // The rail itself is not inside a disclosure. The ticket opening above
    // this rank is deliberately collapsed.
    const before = rank.slice(0, rank.indexOf('class="seq"'))
    expect(before).not.toMatch(/<details(?![^>]*open)/)
  })

  it('draws no denominator where nothing bounds the phase, and never a zero', () => {
    const rank = why(page(building()))
    expect(rank).toMatch(/class="snow"[^>]*>\s*2m34s</)
    expect(rank).not.toContain(' / ')
  })

  /**
   * **Since `#502` neither named action reads as specifically running** —
   * there is no action-level `StepStarted` any more, so `foldProgress`
   * cannot say which of `build`/`review` is the one in flight; both read
   * `pending`. A third cell appears after them: the placeholder `StepStarted`
   * sets `verdicts['proposed:']` (empty action name) to `running`, and
   * `foldProgress` draws that as an "extra" action the plan did not name.
   */
  it("draws proposed's build and review as two pending cells, plus the running placeholder", () => {
    const rank = why(page(building(PLAN)))
    const proposed = rank.match(
      /<li class="seg s-running"[^>]*><span class="sbar">((?:<span class="scell[^"]*"><\/span>)+)<\/span>/,
    )
    expect(proposed?.[1]).toBe(
      '<span class="scell t-pending"></span><span class="scell t-pending"></span><span class="scell t-run"></span>',
    )
  })

  it("is the board's own Rail, imported by both routes and defined in neither", () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
    for (const route of ['../src/app/page.tsx', '../src/app/task/[id]/page.tsx', '../src/app/standing.tsx']) {
      expect(read(route)).not.toMatch(/function (Rail|Segs)\b/)
    }
    expect(read('../src/app/page.tsx')).toMatch(/from ["']\.\/rail\.tsx["']/)
    expect(read('../src/app/task/[id]/page.tsx')).toMatch(/from ["']\.\.\/\.\.\/rail\.tsx["']/)
    expect(read('../src/app/rail.tsx')).toMatch(/export function Rail\b/)
  })

  /**
   * **A held item draws the rail too, since `#415`.** It used to be drawn
   * only while a run was in flight, so the one line a reader came here for —
   * what refused, what is left to spend — was missing on the state this page
   * exists to explain.
   */
  it('is drawn at rank 2 for a blocked item, not just a running one', () => {
    const rank = why(page(blocked()))
    expect(rank).toContain('class="seq"')
    expect(rank).toContain('proposed:review refused')
  })

  /**
   * **`loadTask`'s own `held`, not just the board's.** Nothing else on this
   * page composes the budget line, so a test that never sets `task.held`
   * cannot tell the prop apart from a deleted one — every fixture above
   * leaves it at the `task()` helper's default of `null` (`#415`).
   */
  it("carries loadTask's held line down through Standing into the rail", () => {
    const rank = why(page({ ...blocked(), held: '1 of 3 rounds · 0 restarts left' }))
    expect(rank).toContain('proposed:review refused')
    expect(rank).toContain('<span class="shold"> — 1 of 3 rounds · 0 restarts left</span>')
  })

  /**
   * **And not for a landed item.** `over` stays `landed` there (0041 §4's
   * later points correctly recorded nothing), and `planFor` is never asked
   * for one — the same line `RailCandidate.over` draws on the board.
   */
  it('is not drawn at rank 2 for a landed item', () => {
    const events = [
      e(RUN, 'RunStarted', { baseSha: BASE }),
      resolved,
      e(RUN, 'StepStarted', { step: 'prepared', round: 0 }),
      e(RUN, 'StepEnded', {
        outcome: { step: 'prepared', round: 0, actions: [verdictAction('install', 'ok', 'accepted')] },
      }),
      e(RUN, 'RunFinished', { turns: 12, durationMs: 600_000, exitCode: 0 }),
    ]
    const own = [
      e(ITEM, 'TicketClaimed', { runId: RUN }, '2026-09-14T04:00:00Z'),
      e(ITEM, 'TicketLanded', { mergeCommit: HEAD, base: 'main' }, '2026-09-14T04:30:00Z'),
    ]
    const landed = task(own, [foldRun(claim, 1, events, { over: true })])
    expect(landed.standing.state).toBe('landed')
    expect(why(page(landed))).not.toContain('class="seq"')
  })

  it('draws a configured point that never ran as never-ran on a landed item, apart from pending', () => {
    const events = [
      e(RUN, 'RunStarted', { baseSha: BASE }),
      resolved,
      e(RUN, 'StepStarted', { step: 'prepared', round: 0 }),
      e(RUN, 'StepEnded', {
        outcome: { step: 'prepared', round: 0, actions: [verdictAction('install', 'ok', 'accepted')] },
      }),
      e(RUN, 'RunFinished', { turns: 12, durationMs: 600_000, exitCode: 0 }),
    ]
    const own = [
      e(ITEM, 'TicketClaimed', { runId: RUN }, '2026-09-14T04:00:00Z'),
      e(ITEM, 'TicketLanded', { mergeCommit: HEAD, base: 'main' }, '2026-09-14T04:30:00Z'),
    ]
    // `over` is what `loadTask` passes for the attempt that landed.
    const landed = task(own, [foldRun(claim, 1, events, { over: true })])
    expect(landed.standing.state).toBe('landed')
    const html = record(page(landed))
    expect(html).toContain('class="seg s-never-ran"')
    expect(html).toMatch(/<li class="seg s-never-ran"[^>]*title="proposed: build, review — configured and did not run/)
    expect(html).not.toMatch(/\d+ pending/)

    // And the same stream on an item that did not land is only not reached yet:
    // `over` is the whole of the difference.
    const midway = record(page(task(own.slice(0, 1), [foldRun(claim, 1, events)])))
    expect(midway).not.toContain('s-never-ran')
    expect(midway).toContain('class="seg s-pending"')
  })
})

describe('the record', () => {
  /** Always the same five, in the same order, whatever the state (0118 §2, #417). */
  it('is five tabs in a fixed order, the same five in every state, open on history', () => {
    const run = foldRun(claim, 1, [
      e(RUN, 'RunStarted', { baseSha: BASE }),
      e(RUN, 'RunProposedCompletion', { headSha: HEAD }),
      e(RUN, 'StepStarted', { step: 'proposed', round: 0 }),
      e(RUN, 'StepEnded', {
        outcome: { step: 'proposed', round: 0, actions: [verdictAction('review', 'ok', 'accepted')] },
      }),
      e(RUN, 'RunFinished', { turns: 12, durationMs: 600_000, exitCode: 0 }),
    ])
    const landed = task(
      [
        e(ITEM, 'TicketClaimed', { runId: RUN }, '2026-09-14T04:00:00Z'),
        e(ITEM, 'TicketLanded', { mergeCommit: HEAD, base: 'main' }, '2026-09-14T04:30:00Z'),
      ],
      [run],
    )
    const queuedTask = task([], [], {
      queued: {
        position: 2,
        inLine: 5,
        notOffered: null,
        runnableAt: null,
        paused: false,
        dependenciesUnread: null,
        plan: null,
        problem: null,
      },
    })
    // Not vacuous: each is the state its name says.
    expect(landed.standing.state).toBe('landed')
    expect(queuedTask.standing.state).toBe('queued')
    expect(page(queuedTask)).toContain('offered by GitHub')
    for (const t of [blocked(), running(), landed, queuedTask]) {
      const html = page(t)
      const tabs = [
        ...html.matchAll(/<button type="button" role="tab" id="rtab-([a-z]+)" aria-selected="(true|false)"/g),
      ]
      expect(tabs.map((r) => r[1])).toEqual([...RECORD_TABS])
      // History, and only history, is selected — whatever the state: a page
      // that picked the opening tab by state was read from the top every time.
      expect(tabs.map((r) => r[2])).toEqual(['true', 'false', 'false', 'false', 'false'])
      // Every panel is in the markup the server sent, so a reader with no
      // JavaScript — and this suite, with no DOM to click a tab in — still
      // gets the whole record.
      const panels = [...html.matchAll(/<div role="tabpanel" id="record-([a-z]+)"/g)]
      expect(panels.map((r) => r[1])).toEqual([...RECORD_TABS])
    }
    // `ticket`, and it was `prompt`: the tab opens with the ticket and only
    // then the document each attempt was handed, so it was labelled by the
    // second thing in it — and the one place holding *what was asked*
    // announced itself as the agent's input. `history`, first, and not nested
    // under `attempts`: the log is the point of an event-sourced system being
    // legible and belongs beside the other four, not a scroll under the ledger.
    expect([...RECORD_TABS]).toEqual(['history', 'diff', 'findings', 'attempts', 'ticket'])
  })
})

describe('a ticket whose project keeps its tickets in the database', () => {
  /**
   * `found: null` on an untouched ticket used to always read as "GitHub could
   * not be asked, so whether it exists is not known" — true for a rate limit,
   * false for a `db` project, which was never going to ask GitHub at all. An
   * unclaimed `db` ticket is every one of them while #382 is unwired, so this
   * sentence appearing for all of them was the reachable case (#384).
   */
  it('never says existence is unknown for a project GitHub was never asked about', () => {
    const dbTicket = task([], [], {
      ticket: {
        ...TICKET,
        found: null,
        askedGitHub: false,
        body: null,
        problem: "demo's tickets are read from the database",
      },
    })

    const html = page(dbTicket)
    expect(html).not.toContain('could not be asked')
    expect(html).not.toContain('is not known here')
  })
})
