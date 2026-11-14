/**
 * `hostCanSandbox` and `wrap` (#1146). Wraps nothing yet: no caller imports this package.
 *
 * **srt's `env` is never read.** `wrapWithSandboxArgv` returns `process.env`, which in the daemon holds
 * `LINGTAI_DATABASE_URL`; the port does not surface it, and the `env` returned here is the caller's filtered
 * environment plus the policy's variables.
 */
import { randomBytes } from 'node:crypto'

import { Context, Duration, Effect, Layer, type Scope } from 'effect'

import {
  customConfigFor,
  instanceConfig,
  policyVariables,
  runDomains,
  resolvedPolicy,
  type CallerAdditions,
  type HostFacts,
  type PolicyInputs,
  type ProjectAdditions,
  cacheDir,
} from './policy.ts'
import {
  Host,
  SandboxFs,
  type SrtPort,
  SandboxPolicyRefused,
  SandboxUnavailable,
  SandboxWrapFailed,
  Srt,
} from './port.ts'
import { refuseProtected } from './protect.ts'
import { quoteArgv } from './quote.ts'
import { groupViolations, isComplete, type RefusedRead } from './refusals.ts'

export interface WrapInput {
  readonly project: string
  readonly worktree: string
  readonly mirror: string
  /** The command as an argv. `run:` text is `['/bin/sh', '-c', run]`. */
  readonly command: readonly string[]
  /** The caller's already-filtered environment (`runnableEnv`). */
  readonly env: Readonly<Record<string, string>>
  readonly project_additions?: ProjectAdditions | undefined
  readonly caller_additions?: CallerAdditions | undefined
}

export interface Wrapped {
  readonly argv: readonly string[]
  /** The caller's environment plus the policy's variables. Spawn with this and `shell: false`. */
  readonly env: Readonly<Record<string, string>>
  readonly commandId: string
  /**
   * srt's store total when `wrap` began, or undefined when it could not be read, in which case the read says
   * `unreadable` rather than guess. Only `refusedConnections` uses it.
   */
  readonly violationsBefore: number | undefined
}

export interface SandboxApi {
  readonly hostCanSandbox: Effect.Effect<void, SandboxUnavailable>
  readonly wrap: (
    input: WrapInput,
  ) => Effect.Effect<Wrapped, SandboxUnavailable | SandboxWrapFailed | SandboxPolicyRefused, Scope.Scope>
  /**
   * The connections srt refused this invocation, read from its process-wide 100-entry store. **Call it after the
   * child exits and before the scope `wrap` ran in closes**: closing it cleans up srt's per-command state. Never
   * fails: a read that cannot be made is `unreadable`, never an empty list. A deny srt records without a command
   * (`recordOutboundDeny`) is in no read by id and moves no count we can attribute.
   */
  readonly refusedConnections: (wrapped: Wrapped) => Effect.Effect<RefusedRead>
  /** The policy `wrap` would hand srt for this input, as a value, using this service's own host. */
  readonly policyOf: (input: PolicyInputs) => ReturnType<typeof resolvedPolicy>
}

export class Sandbox extends Context.Service<Sandbox, SandboxApi>()('@lingtai/sandbox/Sandbox') {}

const sentenceOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** A per-process answer lives this long, as `signedInProbe` caches sign-in. */
export const HOST_CHECK_TTL = Duration.minutes(1)

const abs = (name: string, path: string | undefined): string | undefined =>
  path && path.startsWith('/') ? undefined : `${name} is unset or not absolute`

/** Refuses by name when a host fact a policy is built on is missing or relative: a relative path protects nothing. */
const checkFacts = (host: HostFacts): Effect.Effect<void, SandboxUnavailable> => {
  const bad = [abs('HOME', host.home), abs('TMPDIR', host.tmpdir), abs('stateDir', host.stateDir)].filter(
    (s): s is string => s !== undefined,
  )
  return bad.length === 0 ? Effect.void : Effect.fail(new SandboxUnavailable({ reason: bad.join('; '), sentences: [] }))
}

/** Whether this host can run srt: the one question the resolver and `wrap` both ask, so they cannot disagree about *can*. */
export const checkHost = (srt: SrtPort, host: HostFacts): Effect.Effect<void, SandboxUnavailable> =>
  Effect.gen(function* () {
    if (host.platform !== 'darwin' && host.platform !== 'linux') {
      return yield* new SandboxUnavailable({ reason: `platform ${host.platform} cannot be sandboxed`, sentences: [] })
    }
    yield* checkFacts(host)
    const supported = yield* srt.isSupportedPlatform.pipe(
      // A thrown exception's message is never a sentence here: it can carry a temp path that varies per failure.
      Effect.mapError(() => new SandboxUnavailable({ reason: 'srt could not tell the platform', sentences: [] })),
    )
    if (!supported) {
      return yield* new SandboxUnavailable({ reason: 'srt does not support this platform', sentences: [] })
    }
    const check = yield* srt.checkDependencies.pipe(
      Effect.mapError(() => new SandboxUnavailable({ reason: 'checkDependencies failed', sentences: [] })),
    )
    if (check.errors.length > 0) {
      return yield* new SandboxUnavailable({ reason: 'host dependencies are missing', sentences: check.errors })
    }
  })

export const makeSandbox = Effect.gen(function* () {
  const srt = yield* Srt
  const host = yield* Host
  const fs = yield* SandboxFs

  yield* Effect.addFinalizer(() => srt.reset.pipe(Effect.ignore))

  const hostCanSandbox = yield* Effect.cachedWithTTL(checkHost(srt, host), HOST_CHECK_TTL)

  // One initialisation per process, shared by concurrent first callers. A failed one is cached too: a daemon
  // restart is the retry, since a second `initialize` after a failure is not a path srt documents.
  const init = yield* Effect.cached(
    srt
      .initialize(instanceConfig(host))
      .pipe(
        Effect.mapError((e) => new SandboxUnavailable({ reason: 'initialize failed', sentences: [sentenceOf(e)] })),
      ),
  )

  const wrap = (input: WrapInput) =>
    Effect.gen(function* () {
      const project = input.project_additions
      const refusals = refuseProtected([...(project?.write ?? []), ...(project?.deny ?? [])], host, {
        mirror: input.mirror,
      })
      if (refusals.length > 0) return yield* new SandboxPolicyRefused({ refusals })

      yield* init
      yield* hostCanSandbox
      yield* fs
        .ensureDir(cacheDir(host, input.project))
        .pipe(
          Effect.mapError(
            (e) =>
              new SandboxUnavailable({ reason: 'the project cache could not be created', sentences: [sentenceOf(e)] }),
          ),
        )

      // Before anything of this invocation's can reach the store.
      const violationsBefore = yield* srt.violationTotal.pipe(Effect.orElseSucceed(() => undefined))

      // 128 random bits, never derived from the command, the run or the clock.
      const commandId = yield* Effect.sync(() => randomBytes(16).toString('base64url'))
      yield* Effect.acquireRelease(
        srt
          .registerCommandNetworkLists(commandId, { allowedDomains: runDomains(input) })
          .pipe(Effect.mapError((cause) => new SandboxWrapFailed({ cause }))),
        () => srt.unregisterCommandNetworkLists(commandId).pipe(Effect.ignore),
      )

      // Only a wrap that succeeded owes a cleanup: srt undoes its own count when one throws.
      const wrapped = yield* Effect.acquireRelease(
        srt
          .wrapWithSandboxArgv(quoteArgv(input.command), customConfigFor(host, input), { commandId })
          .pipe(Effect.mapError((cause) => new SandboxWrapFailed({ cause }))),
        () => srt.cleanupAfterCommand.pipe(Effect.ignore),
      )

      return {
        argv: wrapped.argv,
        env: { ...input.env, ...policyVariables(host, input.project) },
        commandId,
        violationsBefore,
      } satisfies Wrapped
    })

  const refusedConnections = (wrapped: Wrapped): Effect.Effect<RefusedRead> =>
    Effect.gen(function* () {
      // Fixed texts, never the caught message: it can carry a temp path.
      if (wrapped.violationsBefore === undefined) {
        return { kind: 'unreadable', reason: 'the violation count could not be read at wrap' } as const
      }
      const before = wrapped.violationsBefore
      const violations = yield* srt.violationsFor(wrapped.commandId)
      const after = yield* srt.violationTotal
      return { kind: 'entries', entries: groupViolations(violations), complete: isComplete(before, after) } as const
    }).pipe(
      Effect.catch(() => Effect.succeed({ kind: 'unreadable', reason: 'srt violations could not be read' } as const)),
    )

  const policyOf = (input: PolicyInputs) => resolvedPolicy(host, input)

  return { hostCanSandbox, wrap, refusedConnections, policyOf } satisfies SandboxApi
})

/** Needs `Srt`, `Host` and `SandboxFs`; resets the instance when its scope closes. */
export const SandboxLayer: Layer.Layer<Sandbox, never, Srt | Host | SandboxFs> = Layer.effect(Sandbox, makeSandbox)
