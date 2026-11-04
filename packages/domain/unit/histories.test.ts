/**
 * The fixed histories (#798) are the input every one-reduce ticket reduces, so this
 * holds what they contain, that they are well-formed, and that none ever changes.
 *
 * The case labels are read from source with the TypeScript compiler, as
 * `effect-ratchet.test.ts` reads it, so a reducer that gains an event type fails
 * here until a history covers it.
 *
 * The test never writes `histories.hashes.json`: a red prints the entries to
 * paste. Entries are only ever added.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import type { Envelope } from '../src/index.ts'
import {
  CONTROL_FOLD_TYPES,
  EVENTS,
  backlogStream,
  parseTicketStream,
  reduceChat,
  reduceControl,
  reduceFinding,
  reduceAttempt,
  reduceTicket,
} from '../src/index.ts'
import { COVERS, NOW, histories, lateHistories, lateScenarios, reducerFixtures, scenarios } from '../test/histories.ts'
import hashes from './histories.hashes.json'

const src = (file: string) => fileURLToPath(new URL(`../src/${file}`, import.meta.url))

/** Every string `case` label inside the named function, kept when it is a catalogue event type. */
function caseLabels(file: string, fn: string): Set<string> {
  const text = readFileSync(src(file), 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const errors = (sf as unknown as { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics
  if (errors.length > 0) throw new Error(`${file} does not parse`)
  let found = false
  const labels = new Set<string>()
  const walk = (node: ts.Node): void => {
    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text in EVENTS) {
      labels.add(node.expression.text)
    }
    ts.forEachChild(node, walk)
  }
  sf.forEachChild((st) => {
    if (ts.isFunctionDeclaration(st) && st.name?.text === fn && st.body !== undefined) {
      found = true
      walk(st.body)
    }
  })
  if (!found) throw new Error(`${fn} not found in ${file}`)
  if (labels.size === 0) throw new Error(`${fn} yields no catalogue case labels — the check would be vacuous`)
  return labels
}

const singles = [
  ...Object.entries(histories),
  ...Object.entries(lateHistories),
  ...Object.entries(reducerFixtures),
].flatMap(([kind, byName]) =>
  Object.entries(byName as Record<string, readonly Envelope[]>).map(([name, events]) => ({
    kind: kind as keyof typeof histories,
    name,
    events,
  })),
)

const everyBundle = Object.entries({ ...scenarios, ...lateScenarios }).map(([name, s]) => ({
  name: `scenario.${name}`,
  s,
  events: [...s.ticket, ...s.runs.flat(), ...(s.integration ?? [])].sort((a, b) => (a.seq < b.seq ? -1 : 1)),
}))

const typesOf = (events: readonly Envelope[]) => new Set(events.map((e) => e.type))

describe('coverage', () => {
  for (const kind of Object.keys(COVERS) as (keyof typeof COVERS)[]) {
    it(`${kind}: every covered type appears in a history`, () => {
      const seen = new Set<string>()
      for (const h of singles.filter((s) => s.kind === kind)) for (const t of typesOf(h.events)) seen.add(t)
      expect(COVERS[kind].filter((t) => !seen.has(t))).toEqual([])
    })
  }

  it('COVERS holds every catalogue case label of reduceAttemptEvent, reduceTicketEvent, reduceControlEvent, reduceChatEvent and reduceFindingEvent', () => {
    const missing = (labels: Set<string>, covered: readonly string[]) => [...labels].filter((l) => !covered.includes(l))
    expect(missing(caseLabels('attempt.ts', 'reduceAttemptEvent'), COVERS.run)).toEqual([])
    expect(missing(caseLabels('ticket.ts', 'reduceTicketEvent'), COVERS.ticket)).toEqual([])
    expect(missing(caseLabels('control.ts', 'reduceControlEvent'), COVERS.control)).toEqual([])
    expect(missing(caseLabels('chat.ts', 'reduceChatEvent'), COVERS.chat)).toEqual([])
    expect(missing(caseLabels('backlog.ts', 'reduceFindingEvent'), COVERS.finding)).toEqual([])
  })

  it('COVERS.control is CONTROL_FOLD_TYPES', () => {
    expect([...COVERS.control]).toEqual([...CONTROL_FOLD_TYPES])
  })
})

describe('the histories reduce', () => {
  for (const h of singles.filter((s) => s.kind === 'run')) it(`run.${h.name}`, () => void reduceAttempt(h.events))
  for (const h of singles.filter((s) => s.kind === 'ticket')) it(`ticket.${h.name}`, () => void reduceTicket(h.events))
  for (const h of singles.filter((s) => s.kind === 'chat')) it(`chat.${h.name}`, () => void reduceChat(h.events))
  for (const h of singles.filter((s) => s.kind === 'finding' && s.name !== 'declinedThenAccepted')) {
    it(`finding.${h.name}`, () => void reduceFinding(h.events))
  }
  for (const h of singles.filter((s) => s.kind === 'control')) {
    it(`control.${h.name}`, () => void reduceControl(h.events, NOW))
  }
})

describe('shape', () => {
  const ordered = (events: readonly Envelope[]) => {
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.at.getTime()).toBeGreaterThan(events[i - 1]!.at.getTime())
      expect(events[i]!.seq).toBeGreaterThan(events[i - 1]!.seq)
    }
  }

  for (const h of singles) {
    it(`${h.kind}.${h.name}: one stream, versions 1…n, at increasing, before NOW`, () => {
      expect(h.events.length).toBeGreaterThan(0)
      expect(new Set(h.events.map((e) => e.streamId)).size).toBe(1)
      expect(h.events.map((e) => e.version)).toEqual(h.events.map((_, i) => i + 1))
      ordered(h.events)
      expect(h.events.at(-1)!.at.getTime()).toBeLessThan(NOW.getTime())
    })
  }

  for (const { name, s, events } of everyBundle) {
    it(`${name}: ids agree and time runs across the bundle`, () => {
      const ticketId = s.ticket[0]!.streamId
      expect(parseTicketStream(ticketId)).not.toBeNull()
      expect(new Set(s.ticket.map((e) => e.streamId)).size).toBe(1)
      for (const run of s.runs) {
        const started = run.find((e) => e.type === 'RunStarted')!
        expect((started.data as { ticketId: string }).ticketId).toBe(ticketId)
      }
      if (s.integration !== undefined) expect(s.integration[0]!.streamId).toBe('int-lingtai-main')
      for (const stream of [s.ticket, ...s.runs, ...(s.integration ? [s.integration] : [])]) {
        expect(stream.map((e) => e.version)).toEqual(stream.map((_, i) => i + 1))
      }
      ordered(events)
      expect(events.at(-1)!.at.getTime()).toBeLessThan(NOW.getTime())
    })
  }
})

describe('the cells that tell the old reduces from the new', () => {
  const CELLS = [
    'run.commitCompletedNoHead', // 1
    'run.worktreeNotDone', // 2
    'run.designAnswerUnreadable', // 3
    'run.laterActionNotReached', // 4
    'run.signoffRequestedThenLifecycle', // 5
    'run.failedThenFinished', // 6
    'run.verdictOnOlderHead', // 7
    'ticket.claimedAfterClosed', // 8
    'ticket.waitsResolvedBeforeClose', // 9
    'scenario.integratedWithoutLanding', // 10
    'scenario.answerAfterRunNote', // 11
    'ticket.continuedUnclaimedRun', // 12
    'chat.orphanAnswer', // 12
  ]
  const names = new Set([...singles.map((h) => `${h.kind}.${h.name}`), ...everyBundle.map((b) => b.name)])
  for (const cell of CELLS) it(cell, () => expect(names.has(cell)).toBe(true))
})

describe('the hash lock', () => {
  const sha = (events: readonly Envelope[]) =>
    createHash('sha256')
      .update(JSON.stringify(events, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
      .digest('hex')

  const built: Record<string, string> = {}
  for (const h of singles) built[`${h.kind}.${h.name}`] = sha(h.events)
  // A bundle is hashed as its streams in the order the scenario holds them, so the split is locked too.
  for (const { name, s } of everyBundle) built[name] = sha([...s.ticket, ...s.runs.flat(), ...(s.integration ?? [])])
  const locked = hashes as Record<string, string>

  it('no listed history changed or went missing', () => {
    const bad = Object.entries(locked).filter(([name, hash]) => built[name] !== hash)
    expect(bad.map(([name]) => name)).toEqual([])
  })

  it('every history is listed', () => {
    const unlisted = Object.entries(built).filter(([name]) => !(name in locked))
    expect(
      unlisted.map(([name]) => name),
      `add to histories.hashes.json:\n${JSON.stringify(Object.fromEntries(unlisted), null, 2)}`,
    ).toEqual([])
  })
})

describe('the finding reduce', () => {
  const f = histories.finding
  const at = (events: readonly Envelope[]) => reduceFinding(events)

  it('D7: accepted then proposed is accepted, with its issue', () => {
    const s = at(f.acceptedThenProposed)
    expect(s).toMatchObject({
      status: 'accepted',
      kind: 'tech-debt',
      labels: ['tech-debt'],
      proposed: { externalRef: '9200', url: null },
    })
  })

  it('D7: accepted alone is accepted and owes its issue', () => {
    expect(at(lateHistories.finding.acceptedOnly)).toMatchObject({ status: 'accepted', proposed: null })
  })

  it('D7: declined is declined, with its reason', () => {
    expect(at(f.declined)).toMatchObject({ status: 'declined', reason: 'not worth a ticket', by: 'steven' })
  })

  it('a decline after an accept throws, naming the stream', () => {
    const accepted = lateHistories.finding.acceptedOnly
    const stream = backlogStream('lingtai', 'minor-3')
    const declined = { ...f.declined[0]!, streamId: stream, seq: accepted[0]!.seq + 1n }
    expect(() => reduceFinding([...accepted, declined])).toThrow(stream)
    expect(() => reduceFinding(lateHistories.finding.declinedThenAccepted)).toThrow(backlogStream('lingtai', 'minor-4'))
  })
})
