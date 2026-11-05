import {
  composePrompt,
  DIFF_FLAGS,
  sha256Hex,
  type Envelope,
  type PromptPart,
  type PromptRefEntry,
} from '@lingtai/domain'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import { HistoryRow } from '../src/app/history-row.tsx'
import {
  expandRecorded,
  memoisedGit,
  resetGitMemo,
  shownOf,
  skeletonLines,
  type RunGit,
} from '../src/lib/expand-prompts.ts'
import { toLine } from '../src/lib/history.ts'
import { Attempt } from '../test/attempt-tab.tsx'

const TICKET = 'ticket-lingtai-933'
const RUN = 'pass-0000aaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const FROM = 'a'.repeat(40)
const TO = 'b'.repeat(40)
const BODY = 'The ticket body, as the pass fetched it.'
const EVIDENCE = 'the build gate said: all green'
const DIFF = 'diff --git a/x b/x\n+added\n'

const env = (streamId: string, version: number, type: string, data: unknown): Envelope => ({
  seq: BigInt(version),
  streamId,
  version,
  type,
  schemaVer: 2,
  data,
  actor: 'conductor',
  causation: null,
  at: new Date('2026-11-01T10:00:00Z'),
})

const streams = new Map<string, readonly Envelope[]>([
  [TICKET, [env(TICKET, 1, 'TicketClaimed', { body: BODY })]],
  [
    RUN,
    [
      env(RUN, 1, 'StepEnded', {
        outcome: { actions: [{ name: 'build', evidence: EVIDENCE }] },
      }),
    ],
  ],
])

/** A recorded prompt: markers in place of values, plus the entries that say what each is. */
function record(parts: PromptPart[]) {
  const c = composePrompt(parts)
  const refs: PromptRefEntry[] = c.refs.map((r, i) => ({ ...r, sha256: sha256Hex(c.values[i]!) }))
  return { handed: c.handed, prompt: c.recorded, refs }
}

const bodyRef = { _tag: 'TicketBody', stream: TICKET, version: 1 } as const
const diffRef = { _tag: 'Diff', from: FROM, to: TO } as const

/** What git is asked, and the answers: `cat-file` succeeds; `diff` gives DIFF with a trailing newline git would trim. */
function fakeGit(diff = DIFF, calls: string[][] = []): RunGit {
  return (args) => {
    calls.push([...args])
    if (args[0] === 'cat-file') return Promise.resolve('')
    return Promise.resolve(diff)
  }
}

beforeEach(() => resetGitMemo())

describe('expandRecorded (#933)', () => {
  it('gives back the prompt exactly as it was handed, from the log and from git', async () => {
    const r = record([
      '# Ticket\n',
      { text: BODY, ref: bodyRef },
      '\n## Diff\n',
      { text: DIFF.trim(), ref: diffRef },
      '\nend',
    ])
    const got = await expandRecorded(r, { project: 'lingtai', streams, run: fakeGit(DIFF.trim()) })
    expect(got.unresolved).toEqual([])
    expect(got.text).toBe(r.handed)
  })

  it('leaves a ref on a stream the tab does not hold as a marker, with the reason', async () => {
    const other = { _tag: 'TicketBody', stream: 'ticket-lingtai-1', version: 1 } as const
    const r = record(['x ', { text: BODY, ref: other }])
    const got = await expandRecorded(r, { project: 'lingtai', streams, run: fakeGit() })
    expect(got.text).toBe(r.prompt)
    expect(got.unresolved.map((u) => u.why)).toEqual(["not on this ticket's streams"])
  })

  it('says why a diff did not resolve when git fails, and does not reject', async () => {
    const r = record(['d ', { text: DIFF.trim(), ref: diffRef }])
    const run: RunGit = () => Promise.reject(new Error('fatal: not a git repository'))
    const got = await expandRecorded(r, { project: 'lingtai', streams, run })
    expect(got.text).toBe(r.prompt)
    expect(got.unresolved[0]!.why).toContain('is not in the mirror')
  })

  it('refuses a diff whose hash differs, and keeps the marker', async () => {
    const r = record(['d ', { text: DIFF.trim(), ref: diffRef }])
    const got = await expandRecorded(r, {
      project: 'lingtai',
      streams,
      run: fakeGit('diff --git a/y b/y\n+other0\n'.padEnd(DIFF.trim().length, 'x')),
    })
    expect(got.text).toBe(r.prompt)
    expect(got.unresolved[0]!.why).toMatch(/sha256|bytes/)
  })

  it('catches anything thrown and shows the prompt as recorded', async () => {
    const r = record(['d ', { text: BODY, ref: bodyRef }])
    const broken = new Map<string, readonly Envelope[]>()
    Object.defineProperty(broken, 'get', {
      value: () => {
        throw new Error('boom')
      },
    })
    const got = await expandRecorded(r, { project: 'lingtai', streams: broken, run: fakeGit() })
    expect(got.text).toBe(r.prompt)
    expect(got.unresolved[0]!.why).toBe('boom')
  })

  it('runs the diff with the conductor flags and the commit checks first', async () => {
    const calls: string[][] = []
    const r = record(['d ', { text: DIFF.trim(), ref: diffRef }])
    await expandRecorded(r, { project: 'lingtai', streams, run: fakeGit(DIFF.trim(), calls) })
    expect(calls).toContainEqual(['diff', ...DIFF_FLAGS, `${FROM}...${TO}`])
    expect(calls.filter((c) => c[0] === 'cat-file')).toHaveLength(2)
  })

  it('calls git once per argv across two renders of the same attempt', async () => {
    const calls: string[][] = []
    const r = record(['d ', { text: DIFF.trim(), ref: diffRef }])
    const run = fakeGit(DIFF.trim(), calls)
    await expandRecorded(r, { project: 'lingtai', streams, run })
    const first = calls.length
    await expandRecorded(r, { project: 'lingtai', streams, run })
    expect(first).toBe(3)
    expect(calls).toHaveLength(3)
  })

  it('does not keep a failure, so the next render asks again', async () => {
    let n = 0
    const run: RunGit = () => (++n === 1 ? Promise.reject(new Error('no such sha')) : Promise.resolve(''))
    const git = memoisedGit(run)
    expect((await git(['cat-file'], '/m')).ok).toBe(false)
    expect((await git(['cat-file'], '/m')).ok).toBe(true)
    expect(n).toBe(2)
  })

  it('hands the resolver the text the repo helper trimmed, as the conductor recorded it', async () => {
    const r = record(['d ', { text: DIFF.trim(), ref: diffRef }])
    // The runner stands for `packages/repo`'s `git`, which trims; the hash is of the trimmed text.
    const got = await expandRecorded(r, { project: 'lingtai', streams, run: fakeGit(DIFF.trim()) })
    expect(got.unresolved).toEqual([])
  })

  it('sizes the placeholder from the prompt as handed, between 3 and 40 lines', () => {
    expect(skeletonLines(10)).toBe(3)
    expect(skeletonLines(800)).toBe(10)
    expect(skeletonLines(10_000_000)).toBe(40)
    const r = record(['d ', { text: 'z'.repeat(1600), ref: diffRef }])
    expect(shownOf(r, { project: 'lingtai', streams, run: fakeGit() })!.lines).toBe(21)
    expect(shownOf({ prompt: 'plain', refs: [] }, { project: 'lingtai', streams })).toBeNull()
  })
})

describe('the attempt tab draws the prompt as handed (#933)', () => {
  const view = (text: string) =>
    ({
      runId: RUN,
      attempt: 1,
      at: '2026-11-01T10:00:00.000Z',
      baseSha: null,
      headSha: null,
      configHash: null,
      turns: 1,
      costUsd: { reportedCents: 0, reportedRuns: 0, estimates: [], unknown: 0 },
      durationMs: 1,
      outcome: { state: 'finished', detail: null },
      files: [],
      diff: null,
      prompt: { version: 'ticket@1', bytes: 99, text },
      awaitingSha: null,
      steps: [],
      progress: null,
    }) as never

  it('shows an implementer prompt with a body ref and a step-value ref byte for byte', async () => {
    const stepRef = { _tag: 'StepValue', stream: RUN, version: 1, action: 'build', field: 'evidence' } as const
    const r = record(['# T\n', { text: BODY, ref: bodyRef }, '\n', { text: EVIDENCE, ref: stepRef }])
    const shown = await expandRecorded(r, { project: 'lingtai', streams, run: fakeGit() })
    const html = renderToStaticMarkup(
      <Attempt run={view(r.prompt)} promptShown={{ lines: 3, shown: Promise.resolve(shown) as never }} />,
    )
    // A resolved value is drawn at once, so render with the value itself.
    const resolved = renderToStaticMarkup(
      <Attempt run={view(r.prompt)} promptShown={{ lines: 3, shown: shown as never }} />,
    )
    expect(resolved).toContain(BODY)
    expect(resolved).toContain(EVIDENCE)
    expect(resolved).not.toContain('⟪lingtai:')
    expect(html).toContain('expanding the prompt…')
  })

  it('keeps an unresolved marker in place and says why under it', async () => {
    const r = record(['x ', { text: DIFF.trim(), ref: diffRef }])
    const shown = await expandRecorded(r, { project: 'lingtai', streams, run: () => Promise.reject(new Error('gone')) })
    const html = renderToStaticMarkup(
      <Attempt run={view(r.prompt)} promptShown={{ lines: 3, shown: shown as never }} />,
    )
    expect(html).toContain('⟪lingtai:diff')
    expect(html).toContain('This reference could not be expanded: ')
  })

  it('draws a skeleton for a promise that never resolves and the rest of the tab in full', () => {
    const html = renderToStaticMarkup(
      <Attempt run={view('x')} promptShown={{ lines: 7, shown: new Promise(() => {}) }} />,
    )
    expect(html).toContain('expanding the prompt…')
    expect(html.match(/sk-line/g)).toHaveLength(7)
    expect(html).toContain('>Changes<')
    expect(html).toContain('>Events<')
  })

  it('draws an Events row for a review RunPrompted with its diff expanded', async () => {
    const r = record(['review:\n', { text: DIFF.trim(), ref: diffRef }])
    const event = env(RUN, 2, 'RunPrompted', {
      promptVersion: 'review@1',
      bytes: r.handed.length,
      prompt: r.prompt,
      refs: r.refs,
    })
    const shown = await expandRecorded(r, { project: 'lingtai', streams, run: fakeGit(DIFF.trim()) })
    const line = toLine(event, { attempts: new Map([[RUN, 1]]) })
    const html = renderToStaticMarkup(<HistoryRow line={line} expanded={{ lines: 3, shown: shown as never }} />)
    expect(html).toContain('+added')
    expect(html).not.toContain('⟪lingtai:diff')
  })
})
