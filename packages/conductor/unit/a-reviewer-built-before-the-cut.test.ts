/**
 * **A reviewer built by the pass's own `actionsAt` before `cut` reads the path
 * `cut` wrote** (#1056, #1043, #370).
 *
 * `actionsAt` hands `actionPortsFromRecipe` the pass's `stepDeps`. This wraps
 * that call: at the first step (`claim`, long before `admit` cuts) it builds a
 * reviewer over the very deps `actionsAt` passed, and at `review` it runs it.
 * A `settingsPath` copied when the deps were built would be `''` here.
 */
import type { ActionPort } from '@lingtai/actions'
import type { Runtime } from '@lingtai/agent'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { REVIEWED, fakeGitHub, fakePorts, memoryStore, once, project, runtime } from '../test/one-attempt.ts'

const early = vi.hoisted(() => ({ port: null as unknown, ran: null as Promise<unknown> | null }))

vi.mock('@lingtai/actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lingtai/actions')>()
  return {
    ...actual,
    actionPortsFromRecipe: (...args: Parameters<typeof actual.actionPortsFromRecipe>) => {
      const [step, , deps] = args
      if (step === 'claim' && early.port === null) {
        ;[early.port] = actual.actionPortsFromRecipe(
          'review',
          [{ name: 'early-review', agent: 'claude-code', prompt: 'EARLY-REVIEWER' }],
          deps,
        )
      }
      if (step === 'review' && early.ran === null) {
        early.ran = Effect.runPromise(
          (early.port as ActionPort).run({ runId: 'r', onSha: 'a'.repeat(40), cwd: '/tmp/wt', env: {} }),
        )
      }
      return actual.actionPortsFromRecipe(...args)
    },
  }
})

describe('a reviewer built through actionsAt before the cut', () => {
  it('reads the settings path written by the cut', async () => {
    const asked: string[] = []
    const reviewer: Runtime = {
      ...runtime,
      run: (request) => {
        if (request.prompt.includes('EARLY-REVIEWER')) asked.push(request.settingsPath)
        return runtime.run(request)
      },
    }
    const store = memoryStore()
    await once(
      {
        project,
        client: fakeGitHub([], REVIEWED),
        runtime: reviewer,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: false,
        home: '/tmp/fake-home',
        store,
        log: () => {},
      },
      fakePorts([], store),
    )
    await early.ran
    expect(early.port).not.toBeNull()
    expect(asked.length).toBeGreaterThan(0)
    for (const path of asked) expect(path).toMatch(/\.review\.settings\.json$/)
  })
})
