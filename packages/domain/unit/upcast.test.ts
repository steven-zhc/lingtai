/**
 * The upcasting hook.
 *
 * The invariant that matters is not "the registry is empty" — it was, until a
 * real field had to be added — but that **every type past version 1 has an
 * unbroken chain of steps from 1 up to its current version**. A bump without its
 * upcaster is the failure worth guarding: it makes every historical row of that
 * type unreadable, and it does so at the moment someone replays a year of them.
 */
import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import {
  MissingUpcasterError,
  SCHEMA_VER,
  STEPS,
  UPCASTERS,
  type UpcastRegistry,
  parseStoredPayload,
  upcast,
} from '../src/index.ts'

describe('upcast', () => {
  it('is a no-op at the current version', () => {
    const data = { turn: 12 }
    expect(upcast('RunContextExhausted', 1, data)).toBe(data)
  })

  it('has an unbroken chain of steps for every type past version 1', () => {
    const bumped = (Object.keys(SCHEMA_VER) as (keyof typeof SCHEMA_VER)[]).filter((type) => SCHEMA_VER[type] > 1)

    for (const type of bumped) {
      for (let from = 1; from < SCHEMA_VER[type]; from++) {
        expect(
          UPCASTERS[type]?.[from],
          `${type} is at schemaVer ${SCHEMA_VER[type]} with no upcaster from ${from}`,
        ).toBeTypeOf('function')
      }
    }
  })

  it('has no upcaster for a type that never moved', () => {
    // A step for a type still at version 1 is dead code that will be trusted.
    for (const type of Object.keys(UPCASTERS) as (keyof typeof SCHEMA_VER)[]) {
      expect(SCHEMA_VER[type]).toBeGreaterThan(1)
    }
  })

  /**
   * The first real bump. `ProjectConfigured` v1 recorded the repository name but
   * not its owner, so `lingtai status` could not resolve a recipe for a project it
   * had itself registered.
   */
  it('walks a v1 ProjectConfigured all the way up, filling both fields with null', () => {
    const v1 = { project: 'nextloom-ai-admin', configHash: 'abc', fromSha: 'def' }
    const upcasted = parseStoredPayload('ProjectConfigured', 1, v1)

    // Null, not a guess. A v1 event genuinely recorded neither.
    expect(upcasted).toEqual({ ...v1, owner: null, base: null })
  })

  it('adds only what a v2 ProjectConfigured is missing', () => {
    const v2 = { project: 'p', owner: 'steven-zhc', configHash: 'abc', fromSha: 'def' }
    expect(parseStoredPayload('ProjectConfigured', 2, v2)).toEqual({ ...v2, base: null })
  })

  it('leaves a v3 ProjectConfigured alone', () => {
    const v3 = { project: 'p', owner: 'steven-zhc', base: 'develop', configHash: 'a', fromSha: 'd' }
    expect(parseStoredPayload('ProjectConfigured', 3, v3)).toEqual(v3)
  })

  it('refuses a payload written by a newer build', () => {
    // Not recoverable, ever: there is no downcasting, and guessing at a field
    // this build has never seen is how history gets misread.
    expect(() => upcast('RunContextExhausted', 2, {})).toThrow(MissingUpcasterError)
  })

  it('refuses a payload it has no step for', () => {
    expect(() => upcast('RunContextExhausted', 0, {})).toThrow(MissingUpcasterError)
  })

  describe('with a chain of steps', () => {
    // A hypothetical history for one event: v1 held `turn`, v2 renamed it to
    // `atTurn`, v3 added `reason`. This is the shape a real bump would take.
    const registry: UpcastRegistry = {
      RunContextExhausted: {
        1: (d) => ({ atTurn: (d as { turn: number }).turn }),
        2: (d) => ({ ...(d as object), reason: 'compaction' }),
      },
    }
    const supported = 3

    function upcastTo(stored: number, data: unknown): unknown {
      // `upcast` walks to `SCHEMA_VER[type]`, which is 1 here, so the chain is
      // driven directly to keep the shipped catalogue untouched.
      let current = data
      for (let from = stored; from < supported; from++) {
        const step = registry.RunContextExhausted?.[from]
        if (!step) throw new MissingUpcasterError('RunContextExhausted', stored, supported)
        current = step(current)
      }
      return current
    }

    it('walks a v1 payload all the way to v3', () => {
      expect(upcastTo(1, { turn: 41 })).toEqual({ atTurn: 41, reason: 'compaction' })
    })

    it('starts mid-chain when the payload is already partway up', () => {
      expect(upcastTo(2, { atTurn: 41 })).toEqual({ atTurn: 41, reason: 'compaction' })
    })

    it('throws by name when a step is missing', () => {
      const gappy: UpcastRegistry = { RunContextExhausted: { 2: registry.RunContextExhausted![2]! } }
      expect(() => {
        let current: unknown = { turn: 1 }
        for (let from = 1; from < supported; from++) {
          const step = gappy.RunContextExhausted?.[from]
          if (!step) throw new MissingUpcasterError('RunContextExhausted', 1, supported)
          current = step(current)
        }
      }).toThrow(/RunContextExhausted needs an upcaster from schemaVer 1/)
    })
  })
})

/**
 * The widening that made a run explainable (#88).
 *
 * Two types moved together for one reason: the log recorded *that* an agent was
 * given a prompt and *which* runtime took it, and neither the document nor the
 * command. Unlike the gate rename, a v1 payload here is not unparseable — it is
 * merely silent — so the step's whole job is to say `null` where a reader might
 * otherwise assume the field was empty.
 */
describe('the prompt and the invocation', () => {
  it('walks a v1 RunStarted up, with a null invocation', () => {
    const v1 = {
      ticketId: 'ticket-lingtai-59',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1911',
      baseSha: 'base000',
      configHash: 'cfg',
      worktree: '/tmp/wt',
    }
    // Null, not a reconstruction. The argv of a run that happened in August is
    // not recoverable from a payload that never held it, and a plausible guess
    // at "what command did we run" is worse than the gap.
    expect(parseStoredPayload('RunStarted', 1, v1)).toEqual({ ...v1, invocation: null })
  })

  it('walks a v1 RunPrompted up, keeping its length and admitting it has no text', () => {
    // #59's, verbatim: a template name and a byte count.
    const v1 = { promptVersion: 'ticket@1911', bytes: 4593 }
    expect(parseStoredPayload('RunPrompted', 1, v1)).toEqual({ ...v1, prompt: null })
  })

  it('leaves a v2 of either alone', () => {
    const invocation = {
      command: 'claude',
      args: ['-p', '<prompt: recorded as RunPrompted>'],
      tier: 'guarded',
      limits: { turns: 150, wallMs: 3_600_000 },
    }
    const started = {
      ticketId: 'ticket-lingtai-88',
      runtime: 'claude-code',
      model: '',
      promptVersion: 'ticket@1932+a1b2c3d4',
      baseSha: 'base000',
      configHash: 'cfg',
      worktree: '/tmp/wt',
      invocation,
    }
    expect(parseStoredPayload('RunStarted', 2, started)).toEqual(started)

    const prompted = { promptVersion: 'ticket@12', bytes: 12, prompt: 'do the thing' }
    expect(parseStoredPayload('RunPrompted', 2, prompted)).toEqual(prompted)
  })
})

describe('parseStoredPayload', () => {
  it('validates after upcasting, so a bad step is caught by the schema', () => {
    expect(parseStoredPayload('RunContextExhausted', 1, { turn: 41 })).toEqual({ turn: 41 })
    expect(() => parseStoredPayload('RunContextExhausted', 1, { turn: 'forty-one' })).toThrow()
  })
})

/**
 * **The rename that made this file earn its keep, and the reset that spent it.**
 *
 * ADR 0018's `diff` point became `proposed`, nine types carried a `Step` when
 * it landed, and the step could not be skipped at any of them: the enum no
 * longer holds the old value, so a stored row was unparseable rather than
 * merely stale. That is the good version of the failure, and it is why the
 * rename was affordable.
 *
 * **What is asserted here now is that all nine are gone** (`#247`).
 * [0061](../../../doc/decisions-archive/0061-the-recipe-is-the-pipeline.md) §7 spends
 * that history by *resetting* the log rather than upcasting it;
 * `the-pipeline.md`'s T5b folded it into
 * [013](../../../doc/experiments/013-the-log-before-the-third-reset.md) and T5
 * cut it. A store with no rows holds none at version 1, so the nine versions
 * and the nine steps came down together — which is the only shape this was
 * ever available in: at `StepPassed` the step could not come down alone while
 * `findings` sat above it, because *an unbroken chain of steps for every type
 * past version 1* at the top of this file makes a hole at 1 as loud as a
 * missing step.
 *
 * The cases below are what fails if a version or a step comes back without the
 * other, and what fails if `StepsResolved` is bumped again with no step under
 * it.
 */
/** All ten since 0058 §3; `.length(10)` is what the schema asserts. */
const TEN_STEPS = [...STEPS].map((step) => ({ step, actions: [] as string[] }))

describe('StepsResolved', () => {
  it('reads a ten-step plan back unchanged, recipe and all', () => {
    const plan = { runId: 'pass-01JX', configHash: 'abc', steps: TEN_STEPS, recipe: {} }
    expect(parseStoredPayload('StepsResolved', SCHEMA_VER.StepsResolved, plan)).toEqual(plan)
  })

  /**
   * #191, 0047 §3: `recipe` is absent — not null, not `{}` — on a plan that did
   * not record one, so a reader can tell *not recorded* from *recorded, and
   * empty*. Nothing upcasts into it any more, and nothing may: a recipe is read
   * from the base branch every pass (0005), so the one it had then is not the
   * one it has now.
   */
  it('keeps absent and empty apart on the recipe', () => {
    const without = parseStoredPayload('StepsResolved', 1, {
      runId: 'pass-01JX',
      configHash: 'abc',
      steps: TEN_STEPS,
    })
    expect('recipe' in without).toBe(false)

    const empty = parseStoredPayload('StepsResolved', 1, {
      runId: 'pass-01JX',
      configHash: 'abc',
      steps: TEN_STEPS,
      recipe: {},
    })
    expect('recipe' in empty).toBe(true)
    expect(empty.recipe).toEqual({})
  })

  /**
   * The count is the assertion 0047 rests on — *what a run was given is on the
   * log* — so a plan that records five steps or eleven is refused rather than
   * read as a run that was configured differently.
   */
  it('refuses a plan that is not all ten steps', () => {
    const short = { runId: 'pass-01JX', configHash: 'abc', steps: TEN_STEPS.slice(0, 5) }
    expect(() => parseStoredPayload('StepsResolved', SCHEMA_VER.StepsResolved, short)).toThrow()
  })
})

/**
 * The first step that removes a field ([0027](../../../doc/decisions-archive/0027-the-lease-is-deleted.md)).
 *
 * Most chains add one and say `null` where history is silent. Two go the other
 * way — this one and `StepDidNotFinish` 1 → 2 below (`#234`) — and the reason
 * this is a step rather than nothing at all is that the log holds thousands of
 * `leaseUntilMs` timestamps and **no event is rewritten**. The reader is what
 * stops believing them, and the tests here are the ones a replay of that
 * history depends on.
 */
describe('the lease, dropped on read', () => {
  const v1 = { runId: 'pass-1978cb64', worker: 'local:71410' }

  it('walks a v1 claim all the way up: title and kind null, no lease', () => {
    expect(parseStoredPayload('TicketClaimed', 1, { ...v1, leaseUntilMs: 1_788_385_279_411 })).toEqual({
      ...v1,
      title: null,
      kind: null,
    })
  })

  it('drops the lease from a v2 claim and touches nothing else', () => {
    const v2 = { ...v1, leaseUntilMs: 1_788_385_279_411, title: 'a ticket', kind: 'bug' }
    expect(parseStoredPayload('TicketClaimed', 2, v2)).toEqual({
      ...v1,
      title: 'a ticket',
      kind: 'bug',
    })
  })

  it('reads a v2 claim that never had one, because a missing field is not an error', () => {
    // Nothing wrote such a row. The step is a delete, so it has to be a no-op
    // on a payload that does not carry the key rather than throwing on one.
    const v2 = { ...v1, title: null, kind: null }
    expect(parseStoredPayload('TicketClaimed', 2, v2)).toEqual(v2)
  })

  it('leaves a v3 claim alone', () => {
    const v3 = { ...v1, title: 'a ticket', kind: 'bug' }
    expect(parseStoredPayload('TicketClaimed', 3, v3)).toEqual(v3)
  })

  /** `worker` stays: it is what recovery is decided on now, not decoration. */
  it("keeps the worker, which is the field the lease's job moved to", () => {
    const up = parseStoredPayload('TicketClaimed', 2, {
      ...v1,
      leaseUntilMs: 1,
      title: null,
      kind: null,
    })
    expect(up.worker).toBe('local:71410')
  })
})

/**
 * **The heading over `doc/reference.md`'s upcaster table is arithmetic, and
 * nothing re-derived it** (`#234`).
 *
 * The heading and the sentence under the table both carry the chain count, and
 * adding `StepDidNotFinish` moved the heading to *18 chains, 23 steps* and left
 * the prose reading *seventeen* — which is the exact failure the sentence
 * itself warns about, *a heading that is arithmetic on a number nobody
 * re-derived*, with a green suite under it. A reader who cannot tell which
 * number is current counts the table by hand, and four rows look deletable.
 *
 * So both numbers are read out of the document and checked against
 * `UPCASTERS`: a chain is a type with a step, a step is a function. The table
 * writes 0018's nine types as one row and the heading counts them as nine,
 * which is what the registry counts too.
 */
describe("doc/reference.md's upcaster counts", () => {
  const chains = Object.keys(UPCASTERS).length
  const steps = Object.values(UPCASTERS).reduce((n, c) => n + Object.keys(c ?? {}).length, 0)

  /** The document spells its counts, so the test has to read them that way. */
  const SPELLED: Record<string, number> = {
    six: 6,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seven: 7,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
  }

  const reference = async () => await readFile(new URL('../../../doc/reference.md', import.meta.url), 'utf8')

  it('counts the heading off the registry', async () => {
    const heading = /^## upcaster — (\d+) chains, (\d+) steps$/m.exec(await reference())
    expect(heading, 'no `## upcaster — N chains, M steps` heading in doc/reference.md').not.toBeNull()
    expect(Number(heading![1]), "doc/reference.md's chain count is not UPCASTERS'").toBe(chains)
    expect(Number(heading![2]), "doc/reference.md's step count is not UPCASTERS'").toBe(steps)
  })

  it("keeps the prose under the table on the heading's number", async () => {
    const prose = /of the \*\*([a-z-]+)\*\* chains below is its own row/.exec((await reference()).replace(/\n/g, ' '))
    expect(prose, 'doc/reference.md no longer says how many chains the table holds').not.toBeNull()
    expect(
      SPELLED[prose![1]!],
      `doc/reference.md spells "${prose![1]}" and the table has ${chains} chains` +
        ' — if the count has left the list, add the word to SPELLED',
    ).toBe(chains)
  })
})
