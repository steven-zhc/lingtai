/**
 * What a recipe's `sandbox:` block means on this host (#1147).
 *
 * `checkSandboxBlock` runs inside `resolveLocalRecipeEffect`, after the text has resolved, and says what the
 * text alone could not: whether a path collides with something the policy protects (checked by
 * `@lingtai/sandbox`'s own `refuseProtected`, so the resolver and the wrap cannot disagree), and whether this
 * host can provide a sandbox the recipe requires. `sandboxDecision` is the one pure function S4–S6 call per run.
 *
 * Nothing here spawns. The host is two lazy Effects the caller hands in, so a test counts how often it is asked.
 */
import { posix } from 'node:path'

import {
  SandboxUnavailable,
  mirrorDir,
  refuseProtected,
  type HostFacts,
  type ProjectAdditions,
  type Refusal,
} from '@lingtai/sandbox'
import { readHost } from '@lingtai/sandbox/host'
import { Cause, Effect } from 'effect'

import type { Recipe } from './recipe.ts'
import { RecipeInvalidError } from './resolve.ts'
import type { SandboxBlock } from './sandbox-block.ts'

/**
 * The fixed head of the refusal `checkSandboxBlock` gives a recipe that requires a sandbox this host cannot
 * provide. `isSandboxRequiredRefusal` matches it, so the sentence and its reader change together (#1163).
 */
export const SANDBOX_REQUIRED_REFUSAL =
  'sandbox.required: this recipe requires a sandbox and this machine cannot provide one'

/**
 * Whether a `ProjectRefused` detail is the sandbox's own refusal — a required sandbox this host cannot give —
 * and not some other problem, nor a `sandbox.write` / `sandbox.deny` path refusal (a broken recipe, not a host).
 * A substring, because the detail is the whole error message and may carry other problems or a ref before it.
 */
export const isSandboxRequiredRefusal = (detail: string): boolean => detail.includes(SANDBOX_REQUIRED_REFUSAL)

/** S3's `hostCanSandbox`: succeeds when this host can sandbox, fails with srt's own sentences when it cannot. */
export type HostAnswer = Effect.Effect<void, SandboxUnavailable>

/** The host's `HOME`, `PNPM_HOME`, `PATH` and state directory, which the path rules compare against. */
export type HostFactsEffect = Effect.Effect<HostFacts, SandboxUnavailable>

/** What every resolve is handed about the host. `'skip'` is saving: a person may write `required: true` before installing `bwrap`. */
export interface SandboxHostOptions {
  readonly host: HostAnswer | 'skip'
  readonly hostFacts: HostFactsEffect
}

/**
 * What a caller that only *saves* a recipe hands in: the editor, `lingtai add` and onboarding. The real host
 * facts, because a path is refused at save, and no host answer, because saving is not running.
 */
export const HOST_FOR_SAVING: SandboxHostOptions = { host: 'skip', hostFacts: readHost }

/** The host's answer as a value: *can*, or *cannot* with the reason and srt's own sentences. */
export type HostVerdict =
  | { readonly can: true }
  | { readonly can: false; readonly reason: string; readonly sentences: readonly string[] }

export type SandboxDecision =
  | { readonly kind: 'sandboxed'; readonly project_additions: ProjectAdditions }
  | { readonly kind: 'unsandboxed'; readonly reason: 'off by choice' }
  | { readonly kind: 'unsandboxed'; readonly reason: 'degraded'; readonly why: string }
  | { readonly kind: 'refused'; readonly why: string }

/** `~` and `~/…` against the host's home, normalised: only for a comparison, never written back into the recipe. */
export const expandHome = (path: string, home: string): string =>
  path === '~' ? home : path.startsWith('~/') ? posix.join(home, path.slice(2)) : posix.normalize(path)

/** A failed or unreadable check is *cannot*, never *can*. The sentence is fixed text, never a defect's message. */
export const verdictOf = (host: HostAnswer): Effect.Effect<HostVerdict> =>
  host.pipe(
    Effect.as<HostVerdict>({ can: true }),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.succeed<HostVerdict>(
            (() => {
              const e = Cause.squash(cause)
              return e instanceof SandboxUnavailable
                ? { can: false, reason: e.reason, sentences: e.sentences }
                : { can: false, reason: 'the host check could not be read', sentences: [] }
            })(),
          ),
    ),
  )

const said = (why: { reason: string; sentences: readonly string[] }): string =>
  [why.reason, ...why.sentences].join('; ')

/**
 * `(block, host answer) → what this run is`. S4–S6 call it once per run, before the run starts.
 * Absent or `enabled: false` is *off by choice*; `required: true` on a host that cannot is *refused*.
 * What it returns is the policy's input shape (`WrapInput.project_additions`): S3 adds the built-ins.
 */
export const sandboxDecision = (
  block: SandboxBlock | undefined,
  answer: HostVerdict,
  home: string,
): SandboxDecision => {
  if (block === undefined || !block.enabled) return { kind: 'unsandboxed', reason: 'off by choice' }
  if (answer.can) {
    return {
      kind: 'sandboxed',
      project_additions: {
        network: block.network.allow,
        write: block.write.map((p) => expandHome(p, home)),
        deny: block.deny.map((p) => expandHome(p, home)),
      },
    }
  }
  const why = said(answer)
  return block.required ? { kind: 'refused', why } : { kind: 'unsandboxed', reason: 'degraded', why }
}

const RELATION: Record<Refusal['relation'], string> = {
  is: 'is',
  inside: 'lies inside',
  contains: 'contains',
  relative: 'is relative to nothing, and',
}

const refusalSentence = (list: 'write' | 'deny', index: number, r: Refusal): string =>
  `sandbox.${list}.${index}: "${r.path}" ${RELATION[r.relation]} ${r.protectedPath} (${r.kind}), ` +
  (list === 'write'
    ? 'which a project cannot grant a sandboxed run the right to write'
    : 'which the sandbox protects already, or which a deny there could not hold') +
  ' — name somewhere else'

/**
 * Everything the text alone could not decide, as one `RecipeInvalidError`. `hostFacts` runs only when the block
 * names a `write` or a `deny`; `host` only for an enabled, required block and never for `'skip'`.
 */
export const checkSandboxBlock = Effect.fn('recipe.sandbox-check')(function* (
  recipe: Recipe,
  project: string,
  ref: string,
  where: string,
  options: SandboxHostOptions,
) {
  const block = recipe.sandbox
  if (block === undefined) return
  const problems: string[] = []

  if (block.write.length + block.deny.length > 0) {
    const facts = yield* options.hostFacts.pipe(
      Effect.map((f): { facts: HostFacts } | { unread: string } => ({ facts: f })),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.succeed({
              unread: (() => {
                const e = Cause.squash(cause)
                return e instanceof SandboxUnavailable ? e.reason : 'the host could not be read'
              })(),
            }),
      ),
    )
    if ('unread' in facts) {
      problems.push(
        `sandbox.${block.write.length > 0 ? 'write' : 'deny'}: these paths could not be checked, ` +
          `because ${facts.unread} — a list that cannot be checked is refused, never accepted`,
      )
    } else {
      const mirror = mirrorDir(facts.facts, project)
      for (const list of ['write', 'deny'] as const) {
        block[list].forEach((path, i) => {
          for (const r of refuseProtected([expandHome(path, facts.facts.home)], facts.facts, { mirror })) {
            problems.push(refusalSentence(list, i, { ...r, path }))
          }
        })
      }
    }
  }

  if (block.enabled && block.required && options.host !== 'skip') {
    const verdict = yield* verdictOf(options.host)
    if (!verdict.can) {
      problems.push(
        `${SANDBOX_REQUIRED_REFUSAL} (${said(verdict)}) — ` +
          'install what is missing, or set required: false to run unsandboxed',
      )
    }
  }

  if (problems.length > 0) return yield* Effect.fail(new RecipeInvalidError(ref, problems, where))
})
