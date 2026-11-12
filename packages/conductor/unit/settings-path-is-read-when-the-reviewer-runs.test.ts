/**
 * **`settingsPath` stays a getter** (#1056, #1043, #370).
 *
 * `cut` writes `reviewSettingsPath` after the actions are built, so the deps the
 * reviewer holds must read it when the action *runs*. The path starts as `''`; a
 * reviewer that was handed the value at build time would run with no settings at
 * all. The pass builds the list `actionsAt` answers for `proposed` before `admit`
 * has cut anything, and the reviewer's request still carries the path `cut` wrote.
 */
import { actionPortsFromRecipe, type ActionPortDeps } from '@lingtai/actions'
import type { Runtime } from '@lingtai/agent'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { REVIEWED, fakeGitHub, fakePorts, memoryStore, once, project, runtime } from '../test/one-attempt.ts'

describe('the reviewer built before the cut', () => {
  it('reads the settings path the cut wrote', async () => {
    const asked: string[] = []
    const reviewer: Runtime = {
      ...runtime,
      run: async (request) => {
        // Only the cold reviewer sends an output schema (`#369`).
        if (request.outputSchema !== undefined) asked.push(request.settingsPath)
        return runtime.run(request)
      },
    }
    const store = memoryStore()
    const did: string[] = []

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
      fakePorts(did, store),
    )

    expect(did.some((line) => line.startsWith('unhookedSettings review'))).toBe(true)
    expect(asked.length).toBeGreaterThan(0)
    for (const path of asked) expect(path).toMatch(/\.review\.settings\.json$/)
  })
})

describe('the reviewer built before the cut, over the same deps shape', () => {
  it('reads the path written after the ports were built', async () => {
    let path = ''
    const seen: string[] = []
    const reviewer: Runtime = {
      ...runtime,
      run: async (request) => {
        seen.push(request.settingsPath)
        return runtime.run(request)
      },
    }
    const deps: ActionPortDeps = {
      agent: {
        runtime: reviewer,
        issue: () => Effect.succeed({ ref: '7', title: 't', body: '' }),
        diff: () => Effect.succeed('diff --git a/x b/x\n+1'),
        restore: () => Effect.succeed({ untouched: true as const }),
        get settingsPath() {
          return path
        },
        limits: { turns: 40, wallMs: 60_000, diffBytes: 400_000 },
      },
    }
    // Built first, as `actionsAt` does when a pass is set up before `admit`...
    const [port] = actionPortsFromRecipe('review', [{ name: 'review', agent: 'claude-code', prompt: 'read' }], deps)
    // ...and `cut` writes the path afterwards.
    path = '/tmp/after-the-cut.json'
    await Effect.runPromise(port!.run({ runId: 'r', onSha: 'a'.repeat(40), cwd: '/tmp/wt', env: {} }))
    expect(seen).toEqual(['/tmp/after-the-cut.json'])
  })
})
