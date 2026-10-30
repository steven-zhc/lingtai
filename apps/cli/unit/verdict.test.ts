/** The wait-answering commands' verdict: its layout and its `--json` document (0121 §5, #621). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { stripColour } from '../src/output.ts'
import { fromOutcome, logVerdict, refusal, renderVerdict, VERBS, verdictJson, type Verdict } from '../src/verdict.ts'

const saved = process.env['NO_COLOR']
beforeEach(() => {
  process.env['NO_COLOR'] = '1'
})
afterEach(() => {
  if (saved === undefined) delete process.env['NO_COLOR']
  else process.env['NO_COLOR'] = saved
})

const TICKET = 'ticket-lingtai-617'

describe('renderVerdict, plain', () => {
  it('approve accepted: one line, #n and the outcome, no indented detail', () => {
    const v: Verdict = {
      outcome: 'accepted',
      ticketId: TICKET,
      subject: '#617',
      form: 'sentence',
      detail: 'landed on main in 5c60992',
    }
    expect(renderVerdict(VERBS.approve.accepted, v)).toEqual(['✓ approved #617 — landed on main in 5c60992'])
  })

  it('approve accepted but unscheduled: the reason it was not scheduled, and the command that schedules it', () => {
    const lines = renderVerdict(VERBS.approve.accepted, {
      outcome: 'accepted',
      ticketId: TICKET,
      subject: '#617',
      form: 'sentence',
      detail: 'continues at merge, but the continuation was not scheduled (store down); run it again to schedule it',
      next: 'lingtai approve lingtai --issue 617',
    })
    expect(lines.join('\n')).toContain('(store down)')
    expect(lines.at(-1)).toBe('  next: lingtai approve lingtai --issue 617')
  })

  it('approve refused: the reason code in parentheses and the detail verbatim', () => {
    const lines = renderVerdict(VERBS.approve.refused, {
      outcome: 'refused',
      ticketId: TICKET,
      reason: 'reason-required',
      detail: 'a step still refuses the head — say why with --note',
    })
    expect(lines).toEqual([
      `✗ not approved (reason-required) ${TICKET}`,
      '  a step still refuses the head — say why with --note',
    ])
  })

  it('grant-fix-round: granted, and granted but not scheduled', () => {
    expect(
      renderVerdict(VERBS['grant-fix-round'].accepted, { outcome: 'accepted', ticketId: TICKET, detail: 'x' })[0],
    ).toBe(`✓ fix round granted ${TICKET}`)
    const failed = renderVerdict(VERBS['grant-fix-round'].accepted, {
      outcome: 'accepted',
      ticketId: TICKET,
      detail: 'scheduling failed: boom',
    })
    expect(failed.join('\n')).toContain('scheduling failed: boom')
    expect(renderVerdict(VERBS['grant-fix-round'].refused, refusal(1, 'not-waiting', 'x').verdict)[0]).toBe(
      '✗ fix round refused (not-waiting)',
    )
  })

  it('requeue, close, ask and answer print the conductor’s sentence word for word', () => {
    for (const verb of ['requeue', 'close', 'ask', 'answer'] as const) {
      const ok = fromOutcome({ ok: true, ticketId: TICKET, detail: `${verb} said so` })
      expect(renderVerdict(VERBS[verb].accepted, ok.verdict)).toEqual([
        `✓ ${VERBS[verb].accepted} ${TICKET}`,
        `  ${verb} said so`,
      ])
      const no = fromOutcome({ ok: false, ticketId: TICKET, detail: `${TICKET} is claimed` })
      expect(renderVerdict(VERBS[verb].refused, no.verdict)).toEqual([
        `✗ ${VERBS[verb].refused} ${TICKET}`,
        `  ${TICKET} is claimed`,
      ])
    }
  })

  it('now names the project and the issue', () => {
    expect(
      renderVerdict(VERBS.now.accepted, {
        outcome: 'accepted',
        subject: 'lingtai #617',
        detail: 'requested lingtai #617',
      }),
    ).toEqual(['✓ requested lingtai #617', '  requested lingtai #617'])
  })

  it('--reject: the removed flag and the command that ends the wait', () => {
    const answered = refusal(
      2,
      'removed-flag',
      '--reject is gone: it asked the same question again and ended nothing.',
      {
        next: 'lingtai requeue lingtai --issue 617',
      },
    )
    expect(answered.code).toBe(2)
    expect(renderVerdict(VERBS.approve.refused, answered.verdict)).toEqual([
      '✗ not approved (removed-flag)',
      '  --reject is gone: it asked the same question again and ended nothing.',
      '  next: lingtai requeue lingtai --issue 617',
    ])
  })

  it('prints no escape sequence under NO_COLOR', () => {
    const text = renderVerdict('approved', { outcome: 'accepted', ticketId: TICKET, detail: 'd' }).join('\n')
    expect(text).toBe(stripColour(text))
  })

  it('logVerdict logs each line and returns the exit code', () => {
    const lines: string[] = []
    const code = logVerdict(VERBS.close, refusal(2, 'blank', 'say why'), (l) => lines.push(l))
    expect(code).toBe(2)
    expect(lines).toEqual(['✗ not closed (blank)', '  say why'])
  })
})

describe('verdictJson', () => {
  it('approve accepted', () => {
    expect(
      verdictJson({
        outcome: 'accepted',
        ticketId: TICKET,
        detail: 'continues at merge',
        extra: { continuesAt: 'merge' },
      }),
    ).toEqual({ outcome: 'accepted', ticketId: TICKET, detail: 'continues at merge', continuesAt: 'merge' })
  })

  it('approve accepted but unscheduled carries unscheduled and next', () => {
    expect(
      verdictJson({
        outcome: 'accepted',
        ticketId: TICKET,
        detail: 'd',
        next: 'lingtai approve lingtai --issue 617',
        extra: { continuesAt: 'merge', unscheduled: 'store down' },
      }),
    ).toEqual({
      outcome: 'accepted',
      ticketId: TICKET,
      detail: 'd',
      next: 'lingtai approve lingtai --issue 617',
      continuesAt: 'merge',
      unscheduled: 'store down',
    })
  })

  it('approve refused keeps the conductor’s code', () => {
    expect(verdictJson({ outcome: 'refused', ticketId: TICKET, reason: 'reason-required', detail: 'say why' })).toEqual(
      { outcome: 'refused', ticketId: TICKET, reason: 'reason-required', detail: 'say why' },
    )
  })

  it.each([
    ['no-project', 1],
    ['no-github-app', 1],
    ['not-blocked', 1],
    ['not-waiting', 1],
    ['blank', 2],
    ['removed-flag', 2],
  ])('the CLI’s own refusal %s is an outcome with exit %i', (reason, code) => {
    const answered = refusal(code, reason, 'because')
    expect(answered.code).toBe(code)
    expect(verdictJson(answered.verdict)).toEqual({ outcome: 'refused', reason, detail: 'because' })
  })

  it('an outcome with no code of its own leaves reason out rather than null', () => {
    const doc = verdictJson(fromOutcome({ ok: false, ticketId: TICKET, detail: 'claimed' }).verdict)
    expect(doc).toEqual({ outcome: 'refused', ticketId: TICKET, detail: 'claimed' })
    expect('reason' in doc).toBe(false)
  })

  it('an outcome that names a reason carries it on a refusal, and never on an acceptance', () => {
    expect(
      verdictJson(fromOutcome({ ok: false, ticketId: TICKET, reason: 'busy', detail: 'being decided' }).verdict),
    ).toEqual({ outcome: 'refused', ticketId: TICKET, reason: 'busy', detail: 'being decided' })
    expect('reason' in verdictJson(fromOutcome({ ok: true, ticketId: TICKET, reason: 'x', detail: 'd' }).verdict)).toBe(
      false,
    )
  })

  it('requeue --into-body reports written', () => {
    expect(
      verdictJson(
        fromOutcome({ ok: false, ticketId: TICKET, detail: 'refused after write' }, { written: true }).verdict,
      ),
    ).toEqual({ outcome: 'refused', ticketId: TICKET, detail: 'refused after write', written: true })
  })

  it('now reports project, issue and by, and no ticketId', () => {
    const doc = verdictJson({
      outcome: 'accepted',
      subject: 'lingtai #617',
      detail: 'requested lingtai #617',
      extra: { project: 'lingtai', issue: 617, by: 'human:x' },
    })
    expect(doc).toEqual({
      outcome: 'accepted',
      detail: 'requested lingtai #617',
      project: 'lingtai',
      issue: 617,
      by: 'human:x',
    })
  })

  it('grant-fix-round unscheduled', () => {
    expect(
      verdictJson({ outcome: 'accepted', ticketId: TICKET, detail: 'd', extra: { unscheduled: 'boom' } }),
    ).toMatchObject({
      unscheduled: 'boom',
    })
  })
})
