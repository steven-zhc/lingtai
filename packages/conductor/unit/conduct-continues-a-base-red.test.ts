import type { Action, ActionContext } from '@lingtai/actions'
/**
 * **A ticket released for a red base is taken again as the same attempt** (#1211, 0108 §13, §15): its worktree
 * is re-cut at the release's saved head, the green base is merged in as a base merge, and `build`, `review` and
 * `proposed` run as after any base merge. Nothing is implemented again. A head that is no longer on origin
 * starts over (a restart) or holds for a person; a read of origin that fails leaves the ticket queued.
 */
import { type PayloadOf } from '@lingtai/domain'
import { STEPS, type Step } from '@lingtai/domain'
import { StepMap } from '@lingtai/recipe'
import { RepoFailed } from '@lingtai/repo'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import type { RunPorts } from '../src/ports.ts'
import {
  runAttemptEffect,
  attemptPortsFrom,
  type AttemptOptions,
  type StepBodies,
  type StepEnding,
} from '../src/run-attempt.ts'
import {
  JUDGED,
  PROJECT,
  fakeGitHub,
  fakePorts,
  memoryStore,
  once,
  project,
  restartRecipe,
  runtime,
} from '../test/one-attempt.ts'

const HEAD = 'c'.repeat(40)
const RED_BASE = 'a'.repeat(40)
const GREEN_BASE = 'b'.repeat(40)
const OLD_RUN = 'pass-old'
const TICKET = `ticket-${PROJECT}-7`

type Origin = { ls: 'ok' | 'moved' | 'gone' | 'fails' | 'garbled'; base: string }

/** The ticket as #1208 leaves it: claimed once, then released `BaseRed` with its head kept. */
async function releasedForARedBase(store: ReturnType<typeof memoryStore>) {
  await store.append(TICKET, 0, [
    { type: 'TicketClaimed', actor: 'conductor', data: { runId: OLD_RUN, worker: 'w', title: null, kind: null } },
  ])
  await store.append(TICKET, 1, [
    {
      type: 'TicketReleased',
      actor: 'conductor',
      data: {
        runId: OLD_RUN,
        reason: 'the base is red',
        cause: {
          _tag: 'BaseRed',
          runId: OLD_RUN,
          headSha: HEAD,
          base: 'main',
          baseSha: RED_BASE,
          command: 'pnpm test',
          boundary: 'unsandboxed',
        },
      },
    },
  ])
}

function portsFor(did: string[], store: ReturnType<typeof memoryStore>, origin: Origin): RunPorts {
  const base = fakePorts(did, store)
  return {
    ...base,
    repo: {
      ...base.repo,
      baseHead: () => Effect.succeed({ at: origin.base }),
      git: (args, o) => {
        if (args[0] !== 'ls-remote') return base.repo.git(args, o)
        did.push('ls-remote')
        if (origin.ls === 'fails')
          return Effect.fail(
            new RepoFailed({ operation: 'git ls-remote', detail: 'offline', command: args, exitCode: 128 }),
          )
        if (origin.ls === 'gone') return Effect.succeed('')
        if (origin.ls === 'garbled') return Effect.succeed('fatal: nonsense\n')
        const sha = origin.ls === 'moved' ? 'd'.repeat(40) : HEAD
        return Effect.succeed(`${sha}\t${args[2]}\n`)
      },
    },
  }
}

const options = (store: ReturnType<typeof memoryStore>, recipe: string) => ({
  project,
  client: fakeGitHub([], recipe),
  runtime,
  issue: 7,
  hookBinary: '/tmp/fake/lingtai-hook',
  prompt: 'fix {{issue}}',
  merge: false,
  home: '/tmp/fake-home',
  store,
  log: () => {},
})

describe('a ticket released for a red base', () => {
  it('is continued as the same run, with the green base merged in, and implements nothing', async () => {
    const store = memoryStore()
    await releasedForARedBase(store)
    const did: string[] = []
    await once(options(store, JUDGED), portsFor(did, store, { ls: 'ok', base: GREEN_BASE }))

    const ticket = await store.read(TICKET)
    const continued = ticket.filter((e) => e.type === 'TicketContinued')
    expect(continued).toHaveLength(1)
    expect((continued[0]!.data as PayloadOf<'TicketContinued'>).runId).toBe(OLD_RUN)
    // Re-cut at the saved head, never at the base.
    const run = await store.read(OLD_RUN)
    const started = run.filter((e) => e.type === 'StepStarted').map((e) => (e.data as { step: string }).step)
    expect(started).toContain('build')
    expect(started).toContain('review')
    expect(started).not.toContain('implement')
    const routed = run.filter((e) => e.type === 'ProposalRouted').map((e) => e.data as PayloadOf<'ProposalRouted'>)
    expect(routed[0]!.offer.proposal).toMatchObject({ _tag: 'BaseMoved', fromSha: RED_BASE, toSha: GREEN_BASE })
    const chosen = routed[0]!.decision._tag === 'Selected' ? routed[0]!.decision.candidate : null
    expect(routed[0]!.offer.available.find((c) => c.id === chosen)?.next).toMatchObject({
      _tag: 'MergeBaseBranch',
      toSha: GREEN_BASE,
      merge: 1,
    })
  })

  it('starts over from the base, counting a restart, when the branch on origin has moved', async () => {
    const store = memoryStore()
    await releasedForARedBase(store)
    const did: string[] = []
    await once(options(store, restartRecipe(1)), portsFor(did, store, { ls: 'moved', base: GREEN_BASE }))
    const released = (await store.read(TICKET))
      .filter((e) => e.type === 'TicketReleased')
      .map((e) => (e.data as PayloadOf<'TicketReleased'>).cause)
    expect(released.at(-1)).toMatchObject({ _tag: 'NewAttempt', newAttempt: 1 })
  })

  it('holds for a person naming the head, with no restart left, when it is gone', async () => {
    const store = memoryStore()
    await releasedForARedBase(store)
    await once(options(store, JUDGED), portsFor([], store, { ls: 'gone', base: GREEN_BASE }))
    // The claim is the continuation; the cut then finds the head gone, and the wait says so.
    const waits = (await store.read(OLD_RUN)).map((e) => JSON.stringify(e.data)).join('\n')
    expect(waits).toContain(`the saved head ${HEAD.slice(0, 7)} of agent/7 is no longer on origin`)
  })

  it.each(['fails', 'garbled'] as const)('is left queued, never read as gone, when origin %s', async (ls) => {
    const store = memoryStore()
    await releasedForARedBase(store)
    const result = await once(options(store, restartRecipe(1)), portsFor([], store, { ls, base: GREEN_BASE }))
    expect(result).toMatchObject({ ok: false })
    const ticket = await store.read(TICKET)
    expect(ticket.map((e) => e.type)).toEqual(['TicketClaimed', 'TicketReleased'])
  })
})

describe('the walk of a continuation for a red base', () => {
  const context: ActionContext = { runId: 'pass-1', onSha: HEAD, cwd: '/nowhere', env: {} }
  const PASSED = { verdict: 'passed' as const, evidence: 'green', findings: [] }
  const bodies = Object.fromEntries(
    STEPS.map((step) => [step, (): Effect.Effect<StepEnding> => Effect.succeed<StepEnding>({ ending: 'passed' })]),
  ) as unknown as StepBodies
  const actionsAt =
    (): AttemptOptions['actionsAt'] =>
    (step: Step): Action[] =>
      step === 'admit'
        ? [{ name: 'cut', kind: 'worktree', yields: 'worktree', run: async (c) => ({ ...PASSED, head: c.onSha }) }]
        : step === 'build'
          ? [{ name: 'tests', kind: 'run', yields: 'verdict', run: async () => PASSED }]
          : []
  const walk = (over: Partial<AttemptOptions> & { conflictEvidence?: (baseSha: string) => Promise<any> }) =>
    Effect.runPromise(
      runAttemptEffect(
        attemptPortsFrom({
          recipe: { steps: StepMap.parse({}) },
          context,
          emit: () => {},
          bodies,
          actionsAt: actionsAt(),
          ceilings: { refusalFixes: 2, conflictResolutions: 1, newAttempts: 0, newAttemptsSpent: 0 },
          mergeBase: async (toSha) => ({ head: `merged-onto-${toSha.slice(0, 7)}` }),
          ...over,
        }),
      ),
    )
  const baseRed = { toSha: GREEN_BASE, fromSha: RED_BASE, action: 'tests' }
  const green = async () => ({ notRed: 'green' })

  it('merges the base in once, then builds, reviews and goes to proposed, never implementing', async () => {
    const baseIsRed = vi.fn(green)
    const result = await walk({ from: { step: 'build', waive: [], baseRed }, baseIsRed })
    expect(baseIsRed).toHaveBeenCalledWith({ action: 'tests', mergedOnto: GREEN_BASE })
    const steps = result.steps.map((s) => s.step)
    expect(steps).toEqual(expect.arrayContaining(['build', 'review', 'proposed']))
    expect(steps).not.toContain('implement')
    expect(result.routes).toHaveLength(1)
    expect(result.routes[0]!.offer.proposal).toMatchObject({ _tag: 'BaseMoved', fromSha: RED_BASE, toSha: GREEN_BASE })
  })

  it('carries the attempt’s base merges: the merge is the next one', async () => {
    const result = await walk({
      from: { step: 'build', waive: [], baseRed, roundsSpent: 1, baseMergesSpent: 1 },
      baseIsRed: green,
    })
    const route = result.routes[0]!
    expect(route.offer.available.find((c) => c.next._tag === 'MergeBaseBranch')?.next).toMatchObject({
      _tag: 'MergeBaseBranch',
      merge: 2,
    })
  })

  it('carries the attempt’s rounds: a refusal after the merge finds none left to buy', async () => {
    const refusing: AttemptOptions['actionsAt'] = (step: Step): Action[] =>
      step === 'admit'
        ? [{ name: 'cut', kind: 'worktree', yields: 'worktree', run: async (c) => ({ ...PASSED, head: c.onSha }) }]
        : step === 'build'
          ? [
              {
                name: 'tests',
                kind: 'run',
                yields: 'verdict',
                run: async () => ({ verdict: 'failed', evidence: 'x', findings: [] }),
              },
            ]
          : []
    const result = await walk({
      from: { step: 'build', waive: [], baseRed, roundsSpent: 2 },
      baseIsRed: green,
      actionsAt: refusing,
    })
    expect(result.steps.map((s) => s.step)).not.toContain('implement')
    expect(result.end._tag).toBe('WaitOnPerson')
  })

  it('releases the ticket again, head kept, when the base is red on the new commit', async () => {
    const newRed = {
      red: { command: 'pnpm test', base: 'main', baseSha: GREEN_BASE, evidence: 'x', boundary: 'unsandboxed' },
    }
    const result = await walk({ from: { step: 'build', waive: [], baseRed }, baseIsRed: async () => newRed })
    expect(result.end).toEqual({
      _tag: 'Requeued',
      cause: {
        _tag: 'BaseRed',
        runId: 'pass-1',
        headSha: HEAD,
        base: 'main',
        baseSha: GREEN_BASE,
        command: 'pnpm test',
        boundary: 'unsandboxed',
      },
    })
    expect(result.routes).toHaveLength(0)
  })

  it('merges without a check when no build action runs the red command any more', async () => {
    const baseIsRed = vi.fn(green)
    const result = await walk({ from: { step: 'build', waive: [], baseRed: { ...baseRed, action: null } }, baseIsRed })
    expect(baseIsRed).not.toHaveBeenCalled()
    expect(result.routes).toHaveLength(1)
  })

  it('merges onto the new base after conflict evidence is restored, not the old conflict base', async () => {
    const OLD = 'e'.repeat(40)
    const bases: string[] = []
    const result = await walk({
      from: { step: 'build', waive: [], baseRed, conflictResolved: { baseSha: OLD, paths: ['a.ts'] } },
      baseIsRed: green,
      conflictEvidence: async () => ({ overlap: ['a.ts'], fromSha: RED_BASE }),
      mergeBase: async (toSha) => {
        bases.push(toSha)
        return { head: 'm' }
      },
    })
    expect(bases).toEqual([GREEN_BASE])
    expect(result.routes).toHaveLength(1)
  })

  it('holds for a person, spending nothing, when the base merge fails', async () => {
    const result = await walk({
      from: { step: 'build', waive: [], baseRed },
      baseIsRed: green,
      mergeBase: async () => ({ failed: 'conflict' }),
    })
    expect(result.end).toMatchObject({ _tag: 'WaitOnPerson', reason: { because: { _tag: 'JudgeHandedOver' } } })
  })
})
