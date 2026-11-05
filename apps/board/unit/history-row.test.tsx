import type { Envelope } from '@lingtai/domain'
import { renderToStaticMarkup } from 'react-dom/server'
/**
 * A document inside a payload renders as a document.
 *
 * `RunPrompted` carries the exact prompt an agent was given (#88), and the row
 * rendered it as `JSON.stringify(data, null, 2)` — one line, thousands of
 * characters wide, every newline a literal `\n`. The most valuable event on the
 * stream was the least readable thing on the page (#101).
 *
 * The assertion is on the markup and not on `splitPayload` alone, because the
 * escaping was never a fact about the payload: it appeared in the render, so
 * that is where a test has to look.
 */
import { describe, expect, it } from 'vitest'

import { HistoryRow } from '../src/app/history-row.tsx'
import { splitPayload, toLine } from '../src/lib/history.ts'

const PROMPT = [
  '# Ticket',
  '',
  '## #83 — Blocked has only a question: no diagnosis',
  '',
  'When something goes wrong the system has exactly one thing it can do.',
].join('\n')

function e(type: string, data: unknown): Envelope {
  return {
    seq: 1800n,
    streamId: 'pass-f60112af-a598',
    version: 3,
    type,
    schemaVer: 2,
    data,
    actor: 'agent:pass-f60112af-a598-47ee-a21c-b277bda75822',
    causation: null,
    at: new Date('2026-09-04T17:12:15Z'),
  }
}

function render(event: Envelope): string {
  return renderToStaticMarkup(<HistoryRow line={toLine(event, { attempts: new Map() })} />)
}

describe('a payload that carries a document', () => {
  it('renders the prompt with its own newlines, and never as an escape', () => {
    const html = render(e('RunPrompted', { promptVersion: 'ticket@1924', bytes: 6268, prompt: PROMPT }))

    // The failure this closes, stated as the two characters it was made of.
    expect(html).not.toContain('\\n')
    // And the document itself, whole, with the newlines it was written with —
    // which is what a selection copies into `claude -p`.
    expect(html).toContain(PROMPT)
  })

  it('labels the block with the field it came from and its size', () => {
    const html = render(e('RunPrompted', { promptVersion: 'ticket@1924', bytes: 6268, prompt: PROMPT }))
    expect(html).toContain('prompt')
    expect(html).toContain(`${Buffer.byteLength(PROMPT, 'utf8')} bytes`)
  })

  it('keeps every other field as pretty-printed JSON, and the key of the one it lifted', () => {
    const { raw, documents } = splitPayload({ promptVersion: 'ticket@1924', bytes: 6268, prompt: PROMPT })
    expect(raw).toContain('"promptVersion": "ticket@1924"')
    expect(raw).toContain('"bytes": 6268')
    // Nothing is dropped: the key stays, saying how big it was and where to
    // look. It is JSON that still parses, and it holds no escaped document.
    expect(JSON.parse(raw).prompt).toMatch(/^‹document, \d+ bytes/)
    expect(raw).not.toContain('\\n')
    expect(documents).toEqual([
      // `log` because nothing said otherwise: `splitPayload` is given the event
      // type when there is one, and the reading that is never wrong when there
      // is not (#106).
      { field: 'prompt', text: PROMPT, bytes: Buffer.byteLength(PROMPT, 'utf8'), source: 'log' },
    ])
  })

  /**
   * A rule, not a list of field names. `RunFailed.detail` is a gate's stdout
   * and `WorkItemBlocked.diagnosis.raw` is a build log; an allowlist would have
   * been written for `prompt` and been a version behind for both.
   */
  it('lifts a document wherever it sits, including nested and in an array', () => {
    const { raw, documents } = splitPayload({
      kind: 'verify-failed',
      diagnosis: { raw: 'error TS2345: …\n  at build.ts:4' },
      findings: [{ scenario: 'given a\nthen b' }],
    })
    expect(documents.map((d) => d.field)).toEqual(['diagnosis.raw', 'findings[0].scenario'])
    expect(raw).not.toContain('\\n')
    expect(raw).toContain('"kind": "verify-failed"')
  })

  it('leaves a payload with no document exactly as it was stored', () => {
    const data = { promptVersion: 'ticket@1911', bytes: 4593, prompt: null }
    expect(splitPayload(data)).toEqual({ raw: JSON.stringify(data, null, 2), documents: [] })
  })
})

/**
 * The row is a sentence first (#887): the sentence leads, who said it and the
 * event's type follow, and `seq`, the stream id and the fields are one click
 * further, inside the open row.
 */
describe('a row reads as a sentence', () => {
  const ATTEMPTS = new Map([['pass-f60112af-a598', 1]])
  const html = (event: Envelope) => renderToStaticMarkup(<HistoryRow line={toLine(event, { attempts: ATTEMPTS })} />)
  /** The closed row, and what opens under it. */
  const parts = (markup: string) => {
    const at = markup.indexOf('</summary>')
    return { closed: markup.slice(0, at), open: markup.slice(at) }
  }

  it('puts the type after the sentence, small and beside it, and the actor in words between', () => {
    const { closed } = parts(html(e('RunPrompted', { promptVersion: 'ticket@1911', bytes: 4593, prompt: null })))
    const sentence = closed.indexOf('Attempt 1&#x27;s agent was prompted (4593 bytes)')
    const who = closed.indexOf('class="who"')
    const type = closed.indexOf('class="what">RunPrompted')
    expect(sentence).toBeGreaterThan(-1)
    expect(who).toBeGreaterThan(sentence)
    expect(type).toBeGreaterThan(who)
    // The whole actor is on hover, never in the text.
    expect(closed).toContain('title="agent:pass-f60112af-a598-47ee-a21c-b277bda75822"')
    expect(closed.replace(/title="[^"]*"/g, '')).not.toContain('pass-f60112af')
  })

  it('keeps seq, the stream id, the schema and the fields inside the open row only', () => {
    const { closed, open } = parts(html(e('RunPrompted', { promptVersion: 'ticket@1911', bytes: 4593, prompt: null })))
    for (const detail of ['seq 1800', 'pass-f60112af-a598 v3', 'schema 2', '&quot;promptVersion&quot;']) {
      expect(closed).not.toContain(detail)
      expect(open).toContain(detail)
    }
  })

  it('says that it recorded the type when no sentence can be built, with the fields in the open row', () => {
    const { closed, open } = parts(html(e('RunTouchedFile', { path: 42 })))
    expect(closed).toContain('recorded RunTouchedFile; open for its fields')
    expect(closed).not.toContain('path=')
    expect(open).toContain('&quot;path&quot;: 42')
  })
})
