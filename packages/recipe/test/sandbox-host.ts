/**
 * What a unit test hands `resolveLocalRecipeEffect` for the host (#1147): never the real check, which spawns.
 * `fakeSandboxHost` counts how often each of the two is asked, so *an absent block never asks* is an assertion.
 */
import type { HostFacts } from '@lingtai/sandbox'
import { SandboxUnavailable } from '@lingtai/sandbox'
import { Effect } from 'effect'

import type { SandboxHostOptions } from '../src/sandbox.ts'

export const FAKE_HOME = '/home/me'

export const fakeFacts = (over: Partial<HostFacts> = {}): HostFacts => ({
  platform: 'linux',
  home: FAKE_HOME,
  tmpdir: '/tmp',
  stateDir: `${FAKE_HOME}/.lingtai`,
  pnpmHome: `${FAKE_HOME}/.local/share/pnpm`,
  path: ['/usr/local/bin', '/usr/bin', '/bin'],
  ...over,
})

export interface FakeSandboxHost extends SandboxHostOptions {
  readonly asked: { host: number; facts: number }
}

/** `can: false` answers with `reason` and `sentences`, as S3's `hostCanSandbox` does. */
export const fakeSandboxHost = (
  options: {
    can?: boolean | (() => boolean)
    reason?: string
    sentences?: readonly string[]
    facts?: HostFacts
    /** What the host check does instead of answering: a failure that is not `SandboxUnavailable`. */
    defect?: unknown
  } = {},
): FakeSandboxHost => {
  const asked = { host: 0, facts: 0 }
  const can = options.can ?? true
  return {
    asked,
    host: Effect.suspend(() => {
      asked.host += 1
      if (options.defect !== undefined) return Effect.die(options.defect)
      return (typeof can === 'function' ? can() : can)
        ? Effect.void
        : Effect.fail(
            new SandboxUnavailable({
              reason: options.reason ?? 'host dependencies are missing',
              sentences: options.sentences ?? ['bubblewrap (bwrap) not installed'],
            }),
          )
    }),
    hostFacts: Effect.suspend(() => {
      asked.facts += 1
      return Effect.succeed(options.facts ?? fakeFacts())
    }),
  }
}

/** For a test that is not about the sandbox: the facts are there, the host is never asked. */
export const skipSandboxHost: SandboxHostOptions = { host: 'skip', hostFacts: Effect.succeed(fakeFacts()) }
