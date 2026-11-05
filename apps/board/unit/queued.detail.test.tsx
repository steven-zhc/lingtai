import type { StepPlan } from '@lingtai/conductor/filter'
import type { Envelope } from '@lingtai/domain'
import { renderToStaticMarkup } from 'react-dom/server'
/**
 * A ticket Lingtai has not touched has a page, and one nothing knows about
 * still has none.
 *
 * Every card in the Queued column 404'd, because `queued` is the one state no
 * event carries: an issue nobody has run has no stream, `loadTask` reduced
 * nothing, and the route called `notFound()`. **Two facts were being flattened
 * into one 404** — *it does not exist* and *I have not touched it* — and the
 * page gave the first when it meant the second (#113).
 *
 * So the first three groups are about telling them apart, and the rest are
 * about the page that exists once they are: where it is in line, what is
 * holding it, and what pressing the button runs.
 *
 * The reducers are pure and exported for exactly this, the split every reduce in
 * `task.ts` makes; the rendering is asserted on the markup for the reason #101
 * established — these are facts about what a reader is shown.
 */
import { describe, expect, it } from 'vitest'

import { planStepLine } from '../src/app/rail.tsx'
import { Coords, Standing, detailClass } from '../src/app/standing.tsx'
import type { OutgoingView } from '../src/lib/prompt.ts'
import {
  backoffOf,
  holding,
  place,
  planOf,
  queuedChip,
  queuedSentence,
  whyLabel,
  type PlanView,
  type QueuedView,
} from '../src/lib/queued.ts'
import type { InFlight } from '../src/lib/queued.ts'
import type { StandingView, TaskAnswer } from '../src/lib/task.ts'

let seq = 0n

function e(streamId: string, type: string, data: unknown, at = '2026-09-09T04:12:15Z'): Envelope {
  seq += 1n
  return {
    seq,
    streamId,
    version: 1,
    type,
    schemaVer: 1,
    data,
    actor: 'conductor',
    causation: null,
    at: new Date(at),
  }
}

// ------------------------------------------------------- where in line ----

const QUEUED: QueuedView = {
  position: 4,
  inLine: 11,
  notOffered: null,
  runnableAt: null,
  paused: false,
  dependenciesUnread: null,
  plan: null,
  kind: 'bug',
  kinds: ['bug', 'tech-debt', 'feature', 'documentation'],
  behind: null,
  problem: null,
}

describe('where it is in line', () => {
  it('numbers the place and says how long the line is', () => {
    expect(place(QUEUED)).toBe('4th of 11 in line')
    expect(place({ ...QUEUED, position: 1, inLine: 1 })).toBe('1st of 1 in line')
    expect(place({ ...QUEUED, position: 2 })).toBe('2nd of 11 in line')
    expect(place({ ...QUEUED, position: 3 })).toBe('3rd of 11 in line')
    // The teens are the ones a naive rule gets wrong.
    expect(place({ ...QUEUED, position: 12, inLine: 40 })).toBe('12th of 40 in line')
    expect(place({ ...QUEUED, position: 21, inLine: 40 })).toBe('21st of 40 in line')
  })

  /**
   * Null rather than a made-up place. An item nothing would claim is not
   * standing in the line, and `holding` is the answer instead.
   */
  it('says nothing about a place it is not in', () => {
    expect(place({ ...QUEUED, position: null })).toBeNull()
  })
})

describe('what is holding it', () => {
  /**
   * `#100`'s three states, which read identically in the column and were
   * absent from this page entirely because the page could not be opened.
   */
  it('says nothing about the card that is simply next', () => {
    expect(holding(QUEUED)).toBeNull()
  })

  it("says when a backing-off item returns, in `lingtai status`'s own words", () => {
    const now = Date.parse('2026-09-09T04:00:00Z')
    const view = { ...QUEUED, position: null, runnableAt: '2026-09-09T04:32:00Z' }
    expect(holding(view, now)).toBe('backing off — runnable in 32m')
  })

  /**
   * A pause outranks a backoff: an item whose backoff lifts in a minute still
   * does not move while the conductor is taking nothing, so the time would be
   * the more precise of two answers and the wrong one.
   */
  it('puts a pause above a backoff', () => {
    const now = Date.parse('2026-09-09T04:00:00Z')
    const view = { ...QUEUED, position: null, paused: true, runnableAt: '2026-09-09T04:32:00Z' }
    expect(holding(view, now)).toBe('paused — nothing will start')
  })

  /**
   * And an issue GitHub is not offering outranks both, because it is the one
   * that survives a resume: `Run it now` would append a request that matches
   * nothing, and that is the fact somebody about to press it needs.
   */
  it('puts a ticket GitHub is not offering above either', () => {
    const view = { ...QUEUED, position: null, paused: true, notOffered: 'it carries a label this recipe excludes' }
    expect(holding(view)).toBe('GitHub is not offering it — it carries a label this recipe excludes')
  })
})

describe("the backoff, reduced from the item's own stream", () => {
  const HOUR = 3_600_000
  const now = Date.parse('2026-09-09T04:12:15Z')

  it('holds nothing that has never been attempted', () => {
    expect(backoffOf([], HOUR, now)).toBeNull()
  })

  it('holds an item whose last claim is inside the window', () => {
    const own = [e('ticket-lingtai-89', 'TicketClaimed', { runId: 'pass-1' }, '2026-09-09T03:45:00Z')]
    expect(backoffOf(own, HOUR, now)?.toISOString()).toBe('2026-09-09T04:45:00.000Z')
  })

  it('lets go once the window is past', () => {
    const own = [e('ticket-lingtai-89', 'TicketClaimed', { runId: 'pass-1' }, '2026-09-09T02:45:00Z')]
    expect(backoffOf(own, HOUR, now)).toBeNull()
  })

  /**
   * **The repair exemption is gone with the log it read** (`#502`). Nothing
   * has bought a repair since `#143`, and `RepairRequested` — the event the
   * old exemption read — is not a type this build's catalogue carries any
   * more: the reset this ticket's merge runs leaves no pre-`#143` row for
   * `backoffOf` to find pending. `queued.ts`'s own `backoffOf` passes
   * `repairPending: false` unconditionally now, so a claim inside the window
   * holds exactly as any other does.
   */
  it('holds an item inside the window even where a repair would once have jumped it', () => {
    const own = [e('ticket-lingtai-89', 'TicketClaimed', { runId: 'pass-1' }, '2026-09-09T03:45:00Z')]
    expect(backoffOf(own, HOUR, now)?.toISOString()).toBe('2026-09-09T04:45:00.000Z')
  })

  /**
   * And only until then. The claim is the repair, so a log that still holds the
   * event does not exempt an old ticket from the backoff for ever.
   */
  it('holds an item once the claim has consumed the retired repair', () => {
    const own = [
      e('ticket-lingtai-89', 'TicketClaimed', { runId: 'pass-1' }, '2026-09-09T03:30:00Z'),
      e(
        'ticket-lingtai-89',
        'RepairRequested',
        {
          runId: 'pass-1',
          attempt: 1,
          reason: 'conflict',
          after: 'pass-1',
        },
        '2026-09-09T03:40:00Z',
      ),
      e('ticket-lingtai-89', 'TicketClaimed', { runId: 'pass-2' }, '2026-09-09T03:45:00Z'),
    ]
    expect(backoffOf(own, HOUR, now)?.toISOString()).toBe('2026-09-09T04:45:00.000Z')
  })
})

// --------------------------------------------------- what will happen ----

const STEPS: StepPlan = new Map([
  ['admit', []],
  ['prepared', [{ name: 'install', budgetMs: 300_000 }]],
  [
    'proposed',
    [
      { name: 'build', budgetMs: 900_000 },
      { name: 'review', budgetMs: null },
    ],
  ],
  ['merge', []],
  ['end', [{ name: 'close the ticket', budgetMs: null }]],
])

const PLAN: PlanView = planOf(STEPS, {
  limits: { turns: 150, wall: '1h', rounds: 2, restarts: 0 },
  tier: 'guarded',
})

/** The queued page with the panel's plan filled in, as a resolved answer would draw it. */
const planPage = (plan: PlanView | null) =>
  renderToStaticMarkup(
    <Standing
      subject={null}
      standing={NEVER_RUN}
      project="lingtai"
      issue={112}
      taskId="ticket-lingtai-112"
      discussions={[]}
      outgoing={null}
      queued={{ ...QUEUED, position: 1, inLine: 2, plan }}
      inFlight={null}
    />,
  )

describe('what will happen', () => {
  /**
   * ADR 0016 §4 before a run as well as after one: a step that is merely left
   * out looks exactly like one that was configured and silently did not run,
   * and only the second is Lingtai's bug. 0061 §5 is the same rule with the
   * count this ticket gave it — *the resolved recipe may not omit a step*.
   */
  it('names all ten steps, including the ones nothing is configured at', () => {
    expect(PLAN.steps.map((p) => p.step)).toEqual([
      'claim',
      'admit',
      'prepared',
      'design',
      'implement',
      'build',
      'review',
      'proposed',
      'merge',
      'end',
    ])
    // Seven of the ten, from two lists that do not overlap: the four no plugin
    // implements — `claim`, `admit`, `design`, `implement` — and `build`,
    // `review` and `merge`, which *this recipe* leaves empty. Four plus three,
    // with nothing counted twice. The first four can never be anything else;
    // the other three are a fact about the file, and this one still declares
    // its build and its reviewer at `proposed:`. The sibling assertion below
    // counts the same seven in rendered HTML.
    expect(PLAN.steps.filter((p) => p.skipped).map((p) => p.step)).toEqual([
      'claim',
      'admit',
      'design',
      'implement',
      'build',
      'review',
      'merge',
    ])
    expect(PLAN.steps[7]?.actions).toEqual(['build', 'review'])
  })

  it("carries the recipe's limits, in the recipe's own words", () => {
    expect(PLAN.turns).toBe(150)
    expect(PLAN.wall).toBe('1h')
    // The third number in the same block, because what a pass costs is all
    // three of them and 0039 §3 put them together for exactly that reason.
    expect(PLAN.rounds).toBe(2)
    // And the fourth, because what a *ticket* costs is the product of the two
    // ceilings (0040 §5) — a page built from one of them names the wrong one.
    expect(PLAN.restarts).toBe(0)
  })

  it('renders the plan and the bounds together', () => {
    const html = planPage(PLAN)

    expect(html).toContain('What Attempt 1 will do')
    expect(html).not.toContain('What the next attempt does at each step')
    expect(html).not.toContain('srailplan')
    expect(html).toContain('<ol class="planlist">')
    expect(html).toContain('prepared')
    expect(html).toContain('install')
    expect(html).toContain('close the ticket')
    // Seven steps run nothing here: the four no plugin implements, and `build`,
    // `review` and `merge`, which this recipe leaves empty. Each is named in one
    // muted line rather than omitted — 0016 §4 — and none gets a row of its own.
    expect(html).toContain('nothing configured at: claim, admit, design, implement, build, review, merge')
    expect(html.match(/<li><b>/g)).toHaveLength(PLAN.steps.length - 7)
    expect(html).toContain('150 turns · 1h · guarded · 2 round(s) back · then straight to you')
  })

  /**
   * A repair is default-on and spends an agent without being asked again, so it
   * is stated when it is off too (0025 §2) — a default that is invisible when
   * it is off is a default nobody can audit.
   */
  it('says so when a refusal buys nothing', () => {
    // `rounds: 0` is the whole of what `repair.on: false` used to say (0039
    // §4), and it has to render as loudly: a project that sends every refusal
    // to a person is making a choice somebody should be able to see.
    const none = planOf(STEPS, {
      limits: { turns: 300, wall: '2h', rounds: 0, restarts: 0 },
      tier: 'guarded',
    })
    expect(planPage(none)).toContain('straight to you')
  })

  /**
   * **The other ceiling, on the one page where somebody is deciding whether to
   * press the button** (0040 §5).
   *
   * `rounds: 0, restarts: 2` is 0040's *never patch, start over twice* and it
   * is the configuration this footer used to describe backwards: no round is
   * bought, and then the ticket is released for two further passes — three
   * agent runs — before any refusal is the operator's. Saying `straight to
   * you` there is the 2026-09-10 drain failure on the page that costs the most
   * to be wrong on.
   */
  it('does not promise a refusal is yours when a restart is bought', () => {
    const over = planOf(STEPS, {
      limits: { turns: 150, wall: '1h', rounds: 0, restarts: 2 },
      tier: 'guarded',
    })
    const html = planPage(over)

    expect(html).toContain('no rounds · 2 restart(s)')
    expect(html).not.toContain('straight to you')
  })

  /**
   * Never merely absent, and never guessed. A page that invented five points
   * would be inviting somebody to press a button on a description of something
   * else (#76).
   */
  it('says the recipe could not be read rather than showing a plan', () => {
    const html = planPage(null)
    expect(html.match(/The recipe could not be read/g)).toHaveLength(1)
    expect(html).not.toContain('prepared')
  })
})

// ---------------------------------------------------------- the block ----

const NEVER_RUN: StandingView = {
  state: 'queued',
  triageStatus: null,
  since: null,
  onYou: false,
  who: 'queued',
  question: null,
  needs: null,
  diagnosis: null,
  attempt: null,
  attempts: 0,
  asked: false,
  askedQuestion: null,
  runId: null,
  awaitingSha: null,
  headSha: null,
  failed: [],
  saidBy: null,
  deciding: null,
  restarts: 0,
  restartsOf: 0,
  waitId: null,
  reason: null,
  unpushed: null,
  approvedSha: null,
}

// The block and the bar's coordinates, which is where *never run* and *offered
// by GitHub* went when every identifier moved up there (#152).
const render = (standing: StandingView, queued: QueuedView | null, unknown: string | null = null) =>
  renderToStaticMarkup(
    <>
      <Coords standing={standing} taskId="ticket-lingtai-112" queued={queued} />
      <Standing
        subject={null}
        standing={standing}
        project="lingtai"
        issue={112}
        taskId="ticket-lingtai-112"
        discussions={[]}
        outgoing={null}
        queued={queued}
        unknown={unknown}
      />
    </>,
  )

describe('the block, for a ticket that has never run', () => {
  it('states the state, the place in line, and that nothing has run it', () => {
    const html = render(NEVER_RUN, { ...QUEUED, plan: PLAN })

    expect(html).toContain('queued')
    expect(html).toContain('4th of 11 in line')
    expect(html).toContain('never run')
    expect(html).toContain('offered by GitHub')
    expect(html).not.toContain('waiting for a conductor to take it')
  })

  /**
   * The render clock is not an answer. Stamping it would put *queued now* on a
   * ticket that has sat open for a week — the substitution the card already
   * refuses (`BoardCard.updatedAt`).
   */
  it('gives no age to a ticket the log has never moved', () => {
    expect(render(NEVER_RUN, QUEUED)).not.toContain('class="sage" title=')
  })

  /** `lingtai now`, on the page that says why the item is not moving. */
  it('ends in the move a queued item has', () => {
    expect(render(NEVER_RUN, QUEUED)).toContain('Run it now')
  })

  /**
   * The same three-states-read-alike defect as #100, one page along: a card
   * that is queued *and backing off* is the one that will not be taken next,
   * and the time is the only thing that distinguishes it.
   */
  it('says when a backing-off ticket returns rather than merely that it is queued', () => {
    const html = render(NEVER_RUN, {
      ...QUEUED,
      position: null,
      runnableAt: new Date(Date.now() + 32 * 60_000).toISOString(),
    })

    expect(html).toContain('backing off — runnable in 32m')
    // And the button is still there: a request jumps the backoff (0028 §3).
    expect(html).toContain('Run it now')
  })

  /** #113's first requirement, as a sentence rather than as a status code. */
  it('says it cannot tell, when GitHub could not be asked', () => {
    const html = render(NEVER_RUN, null, '403 on /repos/…: rate limit exceeded')

    expect(html).toContain('whether it exists is not known here')
    expect(html).toContain('rate limit exceeded')
  })

  /**
   * Never merely absent (#76). A recipe that will not parse and a GitHub behind
   * a rate limit both leave the queue unanswered, and only the reason tells
   * them apart.
   */
  it('says why the queue could not be read', () => {
    const html = render(NEVER_RUN, { ...QUEUED, position: null, problem: 'secondary rate limit' })

    expect(html).toContain('Its place in the queue could not be read: secondary rate limit')
    expect(html).not.toContain('offered by GitHub')
  })

  /** Nothing about the queue reaches a block that is not one. */
  it('leaves every other state exactly as it was', () => {
    const blocked: StandingView = {
      ...NEVER_RUN,
      state: 'blocked',
      since: '2026-09-08T04:12:15.000Z',
      onYou: true,
      who: 'waiting on you',
      attempts: 2,
    }
    const html = render(blocked, null)

    expect(html).not.toContain('Run it now')
    expect(html).not.toContain('what will happen')
    expect(html).not.toContain('in line')
  })
})

// ------------------------------------------------------------ the panel ----

/**
 * 0118 §2: a queued page draws the waiting page's panel. Its place, the sentence
 * and what is behind it are GitHub's; what is running is the log's.
 */
describe('the queued panel', () => {
  const FLIGHT: InFlight = { running: [{ project: 'lingtai', issue: '899' }], slots: 1 }
  const panel = (queued: QueuedView | null, github?: Promise<TaskAnswer>, inFlight: InFlight | null = FLIGHT) =>
    renderToStaticMarkup(
      <Standing
        subject={null}
        standing={NEVER_RUN}
        project="lingtai"
        issue={112}
        taskId="ticket-lingtai-112"
        discussions={[]}
        outgoing={null}
        queued={queued}
        inFlight={inFlight}
        github={github}
      />,
    )
  const never = () => new Promise<TaskAnswer>(() => {})

  it('draws the place, the sentence, no ask and three facts, and no Where it is', () => {
    const html = panel({ ...QUEUED, behind: { issue: '120', title: 'x', kind: 'feature' } })
    const at = (needle: string) => html.indexOf(needle)

    expect(at('triage-band')).toBeGreaterThan(-1)
    expect(at('In line')).toBeGreaterThan(at('triage-band'))
    expect(html).toContain('cause-chip--queue">4th of 11</p>')
    expect(at('3 ahead of it')).toBeGreaterThan(at('4th of 11'))
    expect(at('Nothing is needed from you')).toBeGreaterThan(at('3 ahead of it'))
    expect(html.match(/class="fact"/g)).toHaveLength(3)
    expect(html).toContain('why here')
    expect(html).toContain('<a href="/task/ticket-lingtai-899">#899</a>')
    expect(html).toContain('it starts when any of them ends')
    expect(html).toContain('#120 · feature')
    expect(html).not.toContain('Where it is')
    expect(html).not.toContain('waiting for a conductor to take it')
  })

  it('draws placeholders for what GitHub decides, and what is running at once', () => {
    const html = panel(null, never())

    expect(html).toContain('In line')
    // Four in the panel itself (the chip, the sentence, behind it, the plan list); other parts of the page wait for GitHub on their own.
    const band = html.slice(html.indexOf('triage-band'), html.indexOf('</section>', html.indexOf('triage-band')))
    expect(band.match(/asking GitHub…/g)).toHaveLength(4)
    expect(html).toContain('running now')
    expect(html).toContain('<a href="/task/ticket-lingtai-899">#899</a>')
    expect(html).not.toContain('Nothing is needed from you')
    expect(html).not.toContain('why here')
  })

  it('names a hold and asks nothing, and says a failure rather than drawing a skeleton', () => {
    const paused = panel({ ...QUEUED, position: null, paused: true })
    expect(paused).toContain('paused')
    expect(paused).not.toContain('Nothing is needed from you')

    const failed = panel({ ...QUEUED, position: null, problem: 'secondary rate limit' })
    expect(failed).toContain('Its place in the queue could not be read: secondary rate limit')
    expect(failed).not.toContain('asking GitHub…')
    expect(failed).not.toContain('Nothing is needed from you')
  })

  it('does not claim a slot when the recipe could not be read', () => {
    const html = panel(QUEUED, undefined, null)
    expect(html).toContain('the slot count is not known')
  })

  it('at 1st of 2 draws the band, the chip, the sentence, the all-clear, then the facts, in that order', () => {
    const view = { ...QUEUED, position: 1, inLine: 2 }
    const html = panel(view)
    const after = (needle: string, from: number) => {
      const i = html.indexOf(needle, from)
      expect(i, `${needle} after ${from}`).toBeGreaterThan(-1)
      return i
    }

    const band = after('triage-band', 0)
    const inLine = after('In line', band)
    const chip = after(`cause-chip--queue">${queuedChip(view, FLIGHT)}</p>`, inLine)
    expect(queuedChip(view, FLIGHT)).toBe('1st of 2')
    const summary = after('triage-summary"', chip)
    const sentence = after(queuedSentence(view, FLIGHT), summary)
    const clear = after('Nothing is needed from you', sentence)
    const first = after('class="fact"', clear)
    const label = after(`<span class="fk">${whyLabel(1)}</span>`, first)
    const second = after('class="fact"', label + 1)
    const third = after('class="fact"', second + 1)
    expect(third).toBeGreaterThan(second)
    expect(html.match(/class="fact"/g)).toHaveLength(3)
    // The first fact's label is the one for place 1, and is not the other one's.
    expect(html.slice(first, second)).not.toContain(whyLabel(4))
  })

  it('names the queued and running frames, and leaves approved alone', () => {
    expect(detailClass('queued', false)).toContain('detail--queued')
    expect(detailClass('running', false)).toContain('detail--running')
    expect(detailClass('approved', false)).toBe('detail detail--framed')
    expect(detailClass('blocked', false)).toBe('detail detail--waiting')
  })
})

describe('planStepLine', () => {
  it('joins the actions of a step that runs, and says nothing for a skipped one', () => {
    expect(planStepLine('proposed', ['build', 'review'], false)).toBe('build, review')
    expect(planStepLine('claim', [], true)).toBe('')
    expect(planStepLine('claim', ['x'], true)).toBe('')
  })
})

describe('the queued panel, filled (#912)', () => {
  const OUT = {
    version: 'v-secret',
    attempt: 1,
    basedOn: 'abc',
    text: 'do the thing',
    problem: null,
    edit: null,
    delta: { added: 0, removed: 0 },
  } as unknown as OutgoingView
  const html = renderToStaticMarkup(
    <Standing
      subject={null}
      standing={NEVER_RUN}
      project="lingtai"
      issue={112}
      taskId="ticket-lingtai-112"
      discussions={[]}
      outgoing={OUT}
      queued={{ ...QUEUED, position: 1, inLine: 2, plan: PLAN }}
      inFlight={null}
    />,
  )
  const at = (needle: string, from = 0) => {
    const i = html.indexOf(needle, from)
    expect(i, needle).toBeGreaterThan(-1)
    return i
  }

  it('draws the plan, the closed prompt, Discussion, then three cards, in that order', () => {
    const plan = at('What Attempt 1 will do')
    const prompt = at('<details class="asec closedrow">', plan)
    const reading = html.indexOf('sreading')
    expect(reading).toBeGreaterThan(-1)
    const discussion = at('data-rank="discussion"', prompt)
    const moves = at('Moves', discussion)
    const run = at('Run it now', moves)
    const edit = at('Edit the prompt', run)
    at('Close the ticket', edit)
    expect(html.slice(prompt, html.indexOf('</details>', prompt))).toContain('12 bytes')
    expect(html).toContain('closed: read only to check or edit')
    expect(html).not.toContain('v-secret')
  })

  it('has nothing amber and nothing recommended, and Run it now is teal', () => {
    expect(html).not.toContain('btn pri')
    expect(html).not.toContain('sresolution--recommended')
    expect(html).toContain('class="btn go"')
  })
})
