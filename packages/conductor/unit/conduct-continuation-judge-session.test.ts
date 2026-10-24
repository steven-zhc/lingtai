/**
 * **A judge in a continued pass gets a session id no earlier continuation of the
 * run used** (#580).
 *
 * `judgements` is a local of one `conduct` call, so every continuation of a run
 * starts it again and its first judge was `…:judge:findings:1` each time. Claude
 * Code refuses a session id it has already been given (*Session ID … is already
 * in use*), which is #195's collision across continuations rather than within
 * one. The id now carries the wait the continuation resumes.
 *
 * Unit by [0060](../../../doc/decisions-archive/0060-the-gate-runs-unit-tests.md) §1.
 */
import type { Runtime } from '@lingtai/agent'
import { waitsOf, ticketStream } from '@lingtai/domain'
import { aResolution } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  JUDGED_BY_AN_AGENT,
  PROJECT,
  fakeGitHub,
  fakePorts,
  memoryStore,
  once,
  project,
  refusingRuntime,
} from '../test/one-pass.ts'

/** Rounds and restarts to spare: a granted continuation's own round is free and the next arrival
 * is offered `claim` and `waiting` only where a restart is left, so a judge is bought only then. */
const MANY_ROUNDS = JUDGED_BY_AN_AGENT.replace('rounds: 2, restarts: 0', 'rounds: 9, restarts: 3')

const judging = (ran: string[]): Runtime => ({
  ...refusingRuntime,
  run: async (request) => {
    ran.push(request.runId)
    if (!request.runId.includes(':judge:')) return refusingRuntime.run(request)
    return {
      ...(await refusingRuntime.run(request)),
      text: '```json\n{"next": "waiting", "why": "a person should read these"}\n```',
    }
  },
})

describe('a judge asked in a continuation has a session of its own', () => {
  // `GrantFixRound` continued twice, which is what #567 did. An `Approve` continuation
  // is not covered: an approved `ReviewFindings` goes on to `merge`, and no fixture
  // reaches a judge from an approval (#580 names a conflict after one).
  const cases = [{ kind: 'GrantFixRound', recipe: MANY_ROUNDS, laps: 2, firstJudges: true }] as const
  for (const { kind, recipe, laps, firstJudges } of cases) {
    it(`does not reuse an earlier id after ${kind}`, async () => {
      const store = memoryStore()
      const ticketId = ticketStream(PROJECT, 7)
      const ran: string[] = []
      const ports = fakePorts([], store)
      // A new head per fix and judgement, or the fixture answers one sha for ever and
      // no round has a diff in it.
      const git = ports.repo.git
      let head = 0
      ports.repo.git = (args, o) =>
        args[0] === 'rev-parse' && head > 0 ? Effect.succeed(`${'d'.repeat(39)}${head}`) : git(args, o)
      const inner = judging(ran)
      const runtime: Runtime = {
        ...inner,
        run: async (request) => {
          if (request.runId.includes(':judge:') || request.runId.includes(':fix:')) head += 1
          return inner.run(request)
        },
      }
      const args = (continuing?: { runId: string }) => ({
        project,
        client: fakeGitHub([], recipe),
        runtime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: false,
        home: '/tmp/fake-home',
        store,
        ...(continuing === undefined ? {} : { continuing }),
      })
      const judgesOf = () => ran.filter((id) => id.includes(':judge:'))

      const first = await once(args(), ports)
      if (first.ok !== 'held') throw new Error(`the first pass did not hold: ${JSON.stringify(first)}`)
      // A fresh claim has resumed no wait, and says so.
      for (const id of judgesOf()) expect(id).toContain(':judge:findings:start:')
      expect(judgesOf().length > 0).toBe(firstJudges)

      let runId = first.runId
      for (let lap = 0; lap < laps; lap++) {
        const wait = waitsOf(await store.read(ticketId)).at(-1)!
        const onSha = `${'d'.repeat(39)}${head}`
        await store.append(
          ticketId,
          (await store.read(ticketId)).length,
          aResolution(makeStream(ticketId), wait.waitId, { _tag: kind, onSha, ref: 'agent/7' }, 'human:steven'),
        )
        const before = judgesOf().length
        const next = await once(args({ runId }), ports)
        if (next.ok === false) throw new Error(`stopped at ${next.stage}: ${next.detail}`)
        const asked = judgesOf().slice(before)
        // A granted continuation buys no judge at all since #570: its rounds and its restarts
        // are both capped, so only a person is left on offer. Were one ever asked, its id
        // would still carry the wait it resumes (#580).
        expect(asked).toHaveLength(0)
        for (const id of asked) expect(id).toContain(`:judge:findings:${wait.waitId}:`)
        if (next.ok !== 'held') break
        runId = next.runId
      }

      const all = judgesOf()
      expect(new Set(all).size).toBe(all.length)
    })
  }
})
