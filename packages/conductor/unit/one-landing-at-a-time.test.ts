/**
 * **Two passes reaching `merge` together land one after the other, and the
 * second re-checks on the moved base** (#639).
 *
 * Two real `runOnce` calls, no `lane` handed to either — so the lane under test
 * is the one `conduct.ts` falls back to, and a wrapper removed from `land`, or a
 * lane made per call, lets the second `integrate` start beside the first and
 * fails here. The fake `integrate` decides `base-moved` through the production
 * `baseMovedOn`; the route a `base-moved` takes is #593's
 * (`a-base-that-moved.test.ts`).
 */
import { baseMovedOn } from '@lingtai/repo'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  RECIPE,
  fakeGitHub,
  issue as theIssue,
  fakePorts,
  memoryStore,
  once,
  project,
  runtime,
  streams,
} from '../test/one-pass.ts'

const tick = () => new Promise((r) => setTimeout(r, 0))

async function race(secondFiles: string[]) {
  const forkedFrom = 'm0'.padEnd(40, '0')
  const origin = { main: forkedFrom, touched: [] as string[] }
  const forks = new Map<string, string>()
  const filesOf = new Map<string, string[]>()
  const calls: string[] = []
  let inFlight = 0
  let maxInFlight = 0
  const storeA = memoryStore()
  const storeB = memoryStore()

  const waited = () => [...streams(storeB).values()].flat().some((e) => e.type === 'MergeLaneWaited')

  const portsFor = (store: typeof storeA) => {
    const ports = fakePorts([], store, true)
    ports.repo.integrate = (o) =>
      Effect.promise(async () => {
        const first = calls.length === 0
        calls.push(o.branch)
        if (!forks.has(o.branch)) forks.set(o.branch, forkedFrom)
        if (!filesOf.has(o.branch)) filesOf.set(o.branch, first ? ['lib/x.ts'] : secondFiles)
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        try {
          if (first) {
            // Hold the first landing until the second pass has said it is waiting;
            // with no lane the second `integrate` starts here instead.
            for (let i = 0; i < 500 && !waited() && calls.length === 1; i++) await tick()
          }
          const fork = forks.get(o.branch)!
          const files = filesOf.get(o.branch)!
          const paths = fork === origin.main ? [] : baseMovedOn(files, origin.touched)
          if (paths.length > 0) {
            forks.set(o.branch, origin.main)
            return {
              ok: false,
              reason: 'base-moved',
              detail: paths.join('\n'),
              baseMoved: { paths, fromSha: fork, toSha: origin.main },
            } as never
          }
          origin.main = `${calls.length}`.repeat(40)
          origin.touched.push(...files)
          return { ok: true, mergeCommit: origin.main } as never
        } finally {
          inFlight--
        }
      })
    return ports
  }

  const clientFor = (number: number) => {
    const client = fakeGitHub([], RECIPE)
    const own = { ...theIssue, number, url: `https://example.invalid/${number}` }
    client.getIssue = async () => own
    client.listOpenIssues = async () => [own]
    return client
  }

  const options = (store: typeof storeA, issue: number) => ({
    project,
    client: clientFor(issue),
    runtime,
    issue,
    hookBinary: '/tmp/fake/lingtai-hook',
    prompt: 'fix {{issue}}',
    merge: true,
    home: '/tmp/fake-home',
    store,
  })

  const first = once(options(storeA, 7), portsFor(storeA))
  // Let the first pass get as far as its landing before the second starts.
  for (let i = 0; i < 500 && calls.length === 0; i++) await tick()
  const second = once(options(storeB, 8), portsFor(storeB))
  const [a, b] = await Promise.all([first, second])
  const events = [...streams(storeB).values()].flat()
  return { a, b, calls, maxInFlight, events }
}

describe('two passes reaching merge together', () => {
  it('re-reviews the second when main moved under its files', async () => {
    const { a, b, calls, maxInFlight, events } = await race(['lib/x.ts'])
    if (a.ok !== true || b.ok !== true) throw new Error(`did not land: ${JSON.stringify({ a, b })}`)
    expect(maxInFlight).toBe(1)
    expect(calls).toHaveLength(3) // a, then b refused as base-moved, then b again
    const waits = events.filter((e) => e.type === 'MergeLaneWaited')
    expect(waits).toHaveLength(1)
    expect((waits[0]!.data as { behind: { runId: string } }).behind.runId).toBe(a.runId)
    // The refusal sends b back through build and review (#593), not straight to a landing.
    const steps = events.flatMap((e) => (e.type === 'StepStarted' ? [(e.data as { step: string }).step] : []))
    expect(steps.slice(steps.indexOf('merge'))).toContain('build')
  })

  it('lands the second as it was when the files are disjoint', async () => {
    const { a, b, calls, maxInFlight, events } = await race(['notes/y.md'])
    if (a.ok !== true || b.ok !== true) throw new Error(`did not land: ${JSON.stringify({ a, b })}`)
    expect(maxInFlight).toBe(1)
    expect(calls).toHaveLength(2)
    expect(events.filter((e) => e.type === 'MergeLaneWaited')).toHaveLength(1)
  })
})
