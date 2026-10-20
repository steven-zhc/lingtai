import { decideRoute, EVENTS, offerFor } from '@lingtai/domain'
import type { Action, Envelope, Finding, JudgeReply, Proposal } from '@lingtai/domain'
import { anOutcome, aResolution, aWait, aWaitId } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
/**
 * Every event type renders something, and the ones the ticket named render the
 * thing they carry.
 *
 * The first test is driven off `EVENTS` — the catalogue itself, not the list a
 * test happened to think of — so a forty-first type is covered the moment it is
 * added. That is the property #87 was about: `summarise` handled six types and
 * the other thirty-four fell to a default that printed the empty string, so
 * *what actually happened* was a column of timestamps and type names.
 *
 * It asserts against an **empty** payload on purpose. A formatter is allowed
 * not to recognise what it is given; it is not allowed to say nothing.
 */
import { describe, expect, it } from 'vitest'

import { describePayload, shortActor, summarise } from '../src/lib/history.ts'

function e(type: string, data: unknown, actor = 'conductor'): Envelope {
  return {
    seq: 1n,
    streamId: 'ticket-lingtai-59',
    version: 1,
    type,
    schemaVer: 1,
    data,
    actor,
    causation: null,
    at: new Date('2026-09-04T17:12:15Z'),
  }
}

describe('a line of history', () => {
  it('says something for every type in the catalogue, whatever the payload', () => {
    for (const type of Object.keys(EVENTS)) {
      for (const data of [{}, null, { of: 'an unexpected shape' }]) {
        expect(summarise(e(type, data)), `${type} with ${JSON.stringify(data)}`).not.toBe('')
      }
    }
  })

  it('falls back to the payload for a type no formatter has learned', () => {
    // Not in the catalogue at all — the case a renderer is always one commit
    // away from, and the one that used to render as a blank row.
    const said = summarise(e('SomethingNobodyHasWrittenYet', { thing: 'happened', n: 3 }))
    expect(said).toContain('thing=happened')
    expect(said).toContain('n=3')
  })

  /**
   * A requeue's note is optional (#424), and `WorkItemUnblocked.note` can be
   * `""` on the real log now — rendered without a dangling colon, which is
   * what `${by}: ${note}` would leave behind for an empty one.
   */
  it('renders a note-free unblock as just who, with no trailing colon', () => {
    const itemStream = makeStream('ticket-lingtai-59')
    const said = summarise(aResolution(itemStream, aWaitId(), { _tag: 'Requeue' }, 'human:steven', '')[0]!)
    expect(said).toBe('human:steven')

    const withNote = summarise(
      aResolution(itemStream, aWaitId(), { _tag: 'Requeue' }, 'human:steven', 'main has moved')[0]!,
    )
    expect(withNote).toBe('human:steven: main has moved')
  })

  /**
   * **Where a route landed on a person, since `#502` changed what the event
   * stores.** `PassRouted` carries `{offer, reply, decision}` now, not the
   * five derived fields this row used to print — a route that bought a round
   * or spent a restart is read through `boardFactOf`'s own `RoundOpened`/
   * `Restarted` facts, so `history.ts`'s own `FORMAT.PassRouted` entry is
   * only ever reached for the remaining case, `routeNext` answering
   * `WaitOnPerson`. Two ways there: no judge declared (`NotAsked`), and a
   * judge choosing a candidate a spent ceiling had already excluded.
   */
  it('says where a route went, when it lands on a person', () => {
    const buildRed: Proposal = { _tag: 'BuildRed', output: 'tsc failed' }
    const notAsked = offerFor(buildRed, { rounds: 0, restarts: 0 }, { rounds: 0, restarts: 0 })
    const said = summarise(
      e('PassRouted', {
        runId: 'pass-1',
        offer: notAsked,
        reply: { _tag: 'NotAsked' },
        decision: decideRoute(notAsked, { _tag: 'NotAsked' }),
      }),
    )
    expect(said).toContain('build → waiting')
    expect(said).toContain('tsc failed')

    const reviewFindings: Proposal = {
      _tag: 'ReviewFindings',
      findings: [{ file: 'x.ts', line: 1, claim: 'no', failureScenario: 'it breaks', severity: 'blocker' }],
    }
    const spent = offerFor(reviewFindings, { rounds: 1, restarts: 1 }, { rounds: 1, restarts: 1 })
    const reply: JudgeReply = { _tag: 'Selected', candidate: 'restart', why: 'start over' }
    const said2 = summarise(
      e('PassRouted', { runId: 'pass-1', offer: spent, reply, decision: decideRoute(spent, reply) }),
    )
    expect(said2).toContain('review → waiting')
    expect(said2).toContain('restarts` is spent')
  })

  /** A copy with no checkout records `sha: null`, which the schema allows. */
  it('says who started a conductor with no recorded commit, rather than the raw payload', () => {
    const said = summarise(
      e('ConductorStarted', { by: 'daemon', reason: null, sha: null, dirty: false, worker: 'h:1', handoff: null }),
    )
    expect(said).toBe('daemon started an unrecorded commit')
  })

  /**
   * **The two silent outcomes get a sentence, or the silence is back on the
   * page** (`#251`).
   *
   * `#250` left no ref and no account of why, and the row that would have said
   * so is this one. A `RunRefsPublished` rendering as a bare `—` would put a
   * reader back where that incident left them, so the four outcomes are four
   * sentences — and a refusal says the head, because that is what says whether
   * there is anything still to rescue.
   */
  it('says what a claim left on origin, including when it left nothing', () => {
    const row = (data: Record<string, unknown>) =>
      summarise(e('RunRefsPublished', { branch: 'agent/250', arm: 'agent/250-attempt-1', ...data }))

    expect(row({ outcome: 'published', headSha: 'a'.repeat(40), detail: null })).toContain(
      'agent/250 and agent/250-attempt-1 at aaaaaaa',
    )
    expect(row({ outcome: 'already-published', headSha: 'a'.repeat(40), detail: null })).toContain('already there')
    expect(row({ outcome: 'nothing-committed', headSha: null, detail: null })).toBe(
      'nothing committed, so no ref was left',
    )
    // With a head: there are commits behind the refusal, so there is something
    // to go and get.
    expect(row({ outcome: 'refused', headSha: 'a'.repeat(40), detail: 'stale info' })).toBe(
      'agent/250 at aaaaaaa was not pushed: stale info',
    )
    // Without one: the `rev-parse` itself failed and nothing is known to exist.
    expect(row({ outcome: 'refused', headSha: null, detail: 'not a git repository' })).toBe(
      'agent/250 was not pushed, and no head was read: not a git repository',
    )
    // Both halves, because they are opposite: the branch is somebody else's
    // and the arm is this run's work, on origin, fetchable.
    expect(row({ outcome: 'arm-only', headSha: 'a'.repeat(40), detail: 'stale info' })).toBe(
      'agent/250 was not pushed: stale info — agent/250-attempt-1 at aaaaaaa is there',
    )
    // The refs went and the record did not, so the row above this one on the
    // page says the opposite of what a reader needs to act on (`#252`).
    expect(
      row({
        outcome: 'unrecorded',
        headSha: 'a'.repeat(40),
        detail: 'agent/250 — the connection is closed, and again — the connection is closed',
      }),
    ).toBe(
      'aaaaaaa is on origin and nothing records it: agent/250 — the connection is closed, and again — the connection is closed',
    )
  })

  /**
   * **`published`/`already-published` never name `branch` beside a sha it was
   * never pushed** (`#468`). `branchCarries` is the typed field that says so
   * — never whether `detail` happens to be set, since a failed WIP keep also
   * writes `detail` on these two outcomes while `branch` was pushed at
   * exactly `headSha`.
   */
  it('never says branch and arm share a sha the branch never got', () => {
    const row = (data: Record<string, unknown>) =>
      summarise(e('RunRefsPublished', { branch: 'agent/7', arm: 'agent/7-attempt-1', ...data }))

    expect(row({ outcome: 'published', headSha: 'c'.repeat(40), detail: null, branchCarries: false })).toBe(
      'agent/7-attempt-1 at ccccccc',
    )
    expect(row({ outcome: 'already-published', headSha: 'c'.repeat(40), detail: null, branchCarries: false })).toBe(
      'already there — agent/7-attempt-1 at ccccccc',
    )
  })

  /**
   * **A failed WIP keep's `detail` on `published`/`already-published` is not
   * `branch`'s absence** (`#468`) — `branchCarries` stays `true` because
   * `branch` was pushed at exactly `headSha`, and the row names both refs
   * alongside the keep's own failure.
   */
  it('names both refs when a WIP keep failed but branch still carries the sha', () => {
    const row = (data: Record<string, unknown>) =>
      summarise(e('RunRefsPublished', { branch: 'agent/7', arm: 'agent/7-attempt-1', ...data }))

    const detail = 'the dirty tree was not kept — git commit failed: disk full'
    expect(row({ outcome: 'published', headSha: 'c'.repeat(40), detail, branchCarries: true })).toBe(
      `agent/7 and agent/7-attempt-1 at ccccccc — ${detail}`,
    )
  })

  /**
   * **A kept WIP sits on the arm one commit ahead of what `branch` carries,
   * and the row must not say the two refs share a sha** (`#468`). `armSha` is
   * the field that says the arm's own head differs from `headSha`; without
   * it the row before this fix read `agent/7 and agent/7-attempt-1 at
   * bbbbbbb` though the arm was actually at `ccccccc` — a sentence a person
   * fetching `agent/7-attempt-1` would find false.
   */
  it('names the arm at its own later sha when a kept WIP sits ahead of what branch carries', () => {
    const row = (data: Record<string, unknown>) =>
      summarise(e('RunRefsPublished', { branch: 'agent/7', arm: 'agent/7-attempt-1', ...data }))

    expect(
      row({
        outcome: 'published',
        headSha: 'b'.repeat(40),
        armSha: 'c'.repeat(40),
        detail: null,
        branchCarries: true,
      }),
    ).toBe('agent/7 at bbbbbbb and agent/7-attempt-1 at ccccccc')

    expect(
      row({
        outcome: 'already-published',
        headSha: 'b'.repeat(40),
        armSha: 'c'.repeat(40),
        detail: null,
        branchCarries: true,
      }),
    ).toBe('already there — agent/7 at bbbbbbb and agent/7-attempt-1 at ccccccc')
  })

  /**
   * **Absent `branchCarries` means carried** (`#468`) — every row written
   * before this field existed had `branch` at `headSha`, and replaying one
   * must read exactly as it always did.
   */
  it('reads an old row with no branchCarries field as branch carrying the sha', () => {
    const row = (data: Record<string, unknown>) =>
      summarise(e('RunRefsPublished', { branch: 'agent/7', arm: 'agent/7-attempt-1', ...data }))

    expect(row({ outcome: 'published', headSha: 'c'.repeat(40), detail: null })).toBe(
      'agent/7 and agent/7-attempt-1 at ccccccc',
    )
  })

  it('keeps a null in the payload, because a null is a statement', () => {
    expect(describePayload({ prompt: null })).toBe('prompt=null')
  })

  /**
   * The two kinds of block, told apart on the row (#83). `held at the merge
   * gate: …` and `conflict: agent/112 does not merge into develop: …` were both
   * `WorkItemBlocked` with a string, and the history printed the string.
   */
  it('says which kind of block it was, and what it recommends', () => {
    const itemStream = makeStream('ticket-lingtai-59')
    const [blocked] = aWait(itemStream, {
      _tag: 'MergeRefused',
      run: { runId: 'pass-1' },
      reason: 'no-commits',
      raw: 'agent/112 holds nothing main does not.',
    })
    const said = summarise(blocked!)
    expect(said).toContain('acknowledgement:')
    expect(said).toContain('no-commits: agent/112 holds nothing main does not.')
    expect(said).toContain('recommends requeue')
  })

  it('prints the bare question when nothing is recommended', () => {
    const itemStream = makeStream('ticket-lingtai-59')
    const [blocked] = aWait(itemStream, {
      _tag: 'OwnQuestion',
      question: 'held at the merge gate: agent/112 into develop',
      by: 'human:steven',
    })
    const said = summarise(blocked!)
    expect(said).toContain('held at the merge gate: agent/112 into develop')
    expect(said).not.toContain('recommends')
  })

  it('falls to the raw payload when hold does not parse — an old or unrecognised shape', () => {
    const said = summarise(e('WorkItemBlocked', { hold: { _tag: 'SomethingElse' } }))
    expect(said).toContain('SomethingElse')
  })

  it('names the action on a gate row, not only the point', () => {
    const build = e('StepStarted', { step: 'prepared', action: 'build', runId: 'pass-1', onSha: 'abc' })
    const lint = e('StepStarted', { step: 'prepared', action: 'lint', runId: 'pass-1', onSha: 'abc' })
    expect(summarise(build)).toBe('prepared · build')
    // Three gates at one point used to render as three identical rows.
    expect(summarise(build)).not.toBe(summarise(lint))
  })

  /**
   * **A dropped answer and a clean review used to be the same row** (`#279`).
   *
   * `StepFailed` with `findings: []` renders as the bare step, which is what a
   * reviewer that read the diff and had nothing to refuse it on writes. `#269`'s
   * third review said four things, ended one closing brace short of valid JSON, and
   * had this row as its only appearance on the page.
   */
  it('says the answer could not be read, where a zero would have said nothing', () => {
    const event = makeStream('pass-1')
    const ended = (
      evidence: string,
      result:
        | { _tag: 'AnswerUnreadable'; raw: string }
        | { _tag: 'Completed'; assessment: { verdict: 'refused'; findings: Finding[] } },
    ): Envelope => {
      const action: Action = {
        plugin: 'agent',
        name: 'cold reviewer',
        onSha: 'a'.repeat(40),
        evidence,
        yields: 'verdict',
        result,
      }
      return event('StepEnded', { runId: 'pass-1', outcome: anOutcome('review', 0, [action]) })
    }

    const dropped = summarise(ended('…', { _tag: 'AnswerUnreadable', raw: '…' }))

    expect(dropped).toBe('review · cold reviewer — the answer could not be read')
    // The row it was, and still is for every failure whose answer was read: a
    // refusal with no findings is silent and a refusal with them counts them.
    const refused = { _tag: 'Completed' as const, assessment: { verdict: 'refused' as const, findings: [] } }
    expect(summarise(ended('exit 1', refused))).toBe('review · cold reviewer')
    expect(dropped).not.toBe(summarise(ended('exit 1', refused)))
  })

  it('renders the plan StepsResolved carries, including the empty points', () => {
    const said = summarise(
      e('StepsResolved', {
        runId: 'pass-1',
        configHash: '3f8a1c2b9d04',
        steps: [
          { step: 'admit', actions: [] },
          { step: 'prepared', actions: ['build', 'lint'] },
          { step: 'proposed', actions: ['review'] },
          { step: 'merge', actions: [] },
          { step: 'end', actions: ['comment', 'close'] },
        ],
      }),
    )
    // The evidence behind every `skipped` on the page: a point with nothing
    // planned reads as nothing planned, rather than as a point that vanished.
    expect(said).toBe('admit — · prepared build+lint · proposed review · merge — · end comment+close')
  })

  it('says what IssueUpdated changed and to what', () => {
    const said = summarise(
      e('IssueUpdated', { project: 'lingtai', issue: '59', change: 'labels', detail: 'lingtai:working' }),
    )
    expect(said).toBe('labels: lingtai:working')
  })

  it('says how the run was started', () => {
    const said = summarise(
      e('RunStarted', {
        ticketId: 'ticket-lingtai-59',
        runtime: 'claude-code',
        model: 'opus-5',
        promptVersion: 'ticket@1911',
        baseSha: '1f7d07be3c2a91',
        configHash: '3f8a1c2b9d04ee',
        worktree: '/tmp/wt',
        invocation: null,
      }),
    )
    expect(said).toBe('claude-code · opus-5 · base 1f7d07b · recipe 3f8a1c2b9d04')
  })

  it('gives RunPrompted a detail of its own, so its actor is not read as one', () => {
    const said = summarise(
      e('RunPrompted', { promptVersion: 'ticket@1911', bytes: 4593, prompt: '…' }, 'agent:pass-78db72ff-d659'),
    )
    expect(said).toBe('ticket@1911, 4593 bytes')
  })

  it("shortens a run's actor to something an actor column can hold", () => {
    expect(shortActor('agent:pass-78db72ff-d659-4515-a5d3-150a0e8a3b33')).toBe('agent:pass-78db72ff')
    expect(shortActor('conductor')).toBe('conductor')
    expect(shortActor('human:steven')).toBe('human:steven')
  })
})
