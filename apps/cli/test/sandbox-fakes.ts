/**
 * The two sandbox members `runDoctor` requires (#1159), answered without touching the machine: a doctor test
 * names the host and the canary, counts how often each was asked, and nothing spawns.
 */
import { SandboxUnavailable } from '@lingtai/sandbox'
import { Effect } from 'effect'

import type { CanaryResult } from '../src/sandbox-canary.ts'

export interface FakeSandbox {
  readonly sandboxHost: Effect.Effect<void, SandboxUnavailable>
  readonly sandboxCanary: () => Effect.Effect<CanaryResult>
  readonly asked: { host: number; canary: number }
}

/** A host that can, by default, and a canary that was never meant to run: a machine where nothing asks for the sandbox. */
export const fakeSandbox = (
  options: { can?: boolean; sentences?: readonly string[]; canary?: Effect.Effect<CanaryResult> } = {},
): FakeSandbox => {
  const asked = { host: 0, canary: 0 }
  return {
    asked,
    sandboxHost: Effect.suspend(() => {
      asked.host += 1
      return options.can !== false
        ? Effect.void
        : Effect.fail(
            new SandboxUnavailable({
              reason: 'host dependencies are missing',
              sentences: [...(options.sentences ?? [])],
            }),
          )
    }),
    sandboxCanary: () => {
      asked.canary += 1
      return options.canary ?? Effect.succeed({ kind: 'could-not-run', why: 'no canary was meant to run' })
    },
  }
}
