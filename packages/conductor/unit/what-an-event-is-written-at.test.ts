/**
 * **Every event a pass appends is at a step its `at` names** (#628).
 *
 * `EVENT_AT` (`domain/src/events.ts`) is the declaration; this holds it to real
 * passes, *appended ⊆ declared* and never equality — an event no fixture reaches
 * (`RunContextExhausted`) is declared all the same.
 *
 * **Which step was active** is folded from the log alone, with no change to
 * production code: envelopes of every stream sorted by `seq` (one counter in
 * `memoryStore`), the step starting at `claim` and moving at each `StepStarted`.
 * `claim`, `end` and routing visits write no `StepStarted` (`pass.ts:1388`), and
 * `conduct.ts` appends `PassRouted`, the held `StepEnded` and `WaitStarted` after
 * `runPass` returns. **So the window is strict while a step is open** — between
 * its `StepStarted` and its `StepEnded` an envelope is allowed at that step and
 * no other, so `RunStarted` declared only at `end` is caught — **and loose once
 * it has closed**: the step in force *or* `proposed` *or* `end`. **The cost:** a
 * type declared only at `proposed` or `end` is checked loosely after a step has
 * closed. A tighter check would need `conduct.ts` to announce those visits.
 *
 * **No row here is a `build` refusal that buys a round**: only `runPlugin`
 * serves `build`, and `run:` spawns a real process (`actions/src/command.ts:43`),
 * which is integration under 0060 §1. Row 2 of `what-a-pass-writes-today.test.ts`
 * (refusal at `review`, a judge, an `implement` round, green) is the stand-in
 * for a refusal that buys a round.
 */
import { EVENT_AT, type At, type Envelope, type EventType } from '@lingtai/domain'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  fakeGitHub,
  fakePorts,
  JUDGED,
  memoryStore,
  once,
  project,
  refusingRuntime,
  runtime,
  streams,
} from '../test/one-pass.ts'

interface Misplaced {
  readonly type: string
  readonly seq: bigint
  readonly window: readonly string[]
  readonly declared: readonly At[]
}

function bySeq(a: Envelope, b: Envelope): number {
  return a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0
}

/** Every envelope whose type is not declared at a step it could have been appended at. */
export function misplaced(envelopes: readonly Envelope[], at: Readonly<Record<EventType, readonly At[]>>): Misplaced[] {
  const found: Misplaced[] = []
  let current: string = 'claim'
  let started = false
  let open = false
  for (const e of [...envelopes].sort(bySeq)) {
    if (e.type === 'StepStarted') {
      current = (e.data as { step: string }).step
      started = true
      open = true
    }
    const window = !started ? ['claim'] : open ? [current] : [current, 'proposed', 'end']
    const declared = at[e.type as EventType]
    if (!declared.some((s) => window.includes(s))) found.push({ type: e.type, seq: e.seq, window, declared })
    if (e.type === 'StepEnded') open = false
  }
  return found
}

function everything(store: ReturnType<typeof memoryStore>): Envelope[] {
  return [...streams(store).values()].flat()
}

const base = {
  project,
  issue: 7,
  hookBinary: '/tmp/fake/lingtai-hook',
  prompt: 'fix {{issue}}',
  merge: true,
  home: '/tmp/fake-home',
}

/** The passes the ticket names, each run against the fakes. */
const PASSES: Record<string, () => Promise<ReturnType<typeof memoryStore>>> = {
  'a pass that lands': async () => {
    const store = memoryStore()
    await once({ ...base, client: fakeGitHub([]), runtime, store }, fakePorts([], store, true))
    return store
  },
  'a review refusal with no judge, which waits for a person': async () => {
    const store = memoryStore()
    const noJudge = JUDGED.replace(/ {2}proposed:[\s\S]*?(?=runtime:)/, '')
    await once(
      { ...base, client: fakeGitHub([], noJudge), runtime: refusingRuntime, store },
      fakePorts([], store, true),
    )
    return store
  },
  'a review refusal that a judge sends back for a fix round': async () => {
    const store = memoryStore()
    const seen = { n: 0 }
    const twoSided: typeof refusingRuntime = {
      ...refusingRuntime,
      run: async (request) => {
        if (!request.runId.includes(':review:')) return runtime.run(request)
        seen.n += 1
        return seen.n === 1
          ? refusingRuntime.run(request)
          : { ...(await runtime.run(request)), text: JSON.stringify({ findings: [] }) }
      },
    }
    const ports = fakePorts([], store, true)
    const git = ports.repo.git
    ports.repo.git = (args, o) =>
      args[0] === 'rev-parse' && seen.n > 0 ? Effect.succeed('d'.repeat(40)) : git(args, o)
    await once({ ...base, client: fakeGitHub([], JUDGED), runtime: twoSided, store }, ports)
    return store
  },
  'a merge conflict': async () => {
    const store = memoryStore()
    const ports = fakePorts([], store, true)
    ports.repo.integrate = () =>
      Effect.sync(() => ({ ok: false, reason: 'conflict', detail: 'both sides touched src/fix.ts' }) as never)
    await once({ ...base, client: fakeGitHub([]), runtime, store }, ports)
    return store
  },
}

describe('what an event is written at (#628)', () => {
  for (const [name, drive] of Object.entries(PASSES)) {
    it(`${name} appends only at declared steps`, async () => {
      const store = await drive()
      const all = everything(store)
      expect(all.length).toBeGreaterThan(0)
      if (name.includes('waits for a person')) expect(all.some((e) => e.type === 'WaitStarted')).toBe(true)
      if (name === 'a merge conflict') expect(all.some((e) => e.type === 'PassRouted')).toBe(true)
      expect(misplaced(all, EVENT_AT)).toEqual([])
    })
  }

  it('fails when an event is declared away from where a pass writes it', async () => {
    const store = await PASSES['a pass that lands']!()
    const wrong = { ...EVENT_AT, RunStarted: ['claim'] } as Record<EventType, readonly At[]>
    expect(new Set(misplaced(everything(store), wrong).map((m) => m.type))).toEqual(new Set(['RunStarted']))
  })

  it('fails when an event written inside a step is declared only at end or proposed', async () => {
    const store = await PASSES['a pass that lands']!()
    for (const away of ['end', 'proposed'] as const) {
      const wrong = { ...EVENT_AT, RunStarted: [away] } as Record<EventType, readonly At[]>
      expect(new Set(misplaced(everything(store), wrong).map((m) => m.type))).toEqual(new Set(['RunStarted']))
    }
  })
})
