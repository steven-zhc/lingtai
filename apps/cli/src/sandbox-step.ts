import type { RecipeChange } from '@lingtai/recipe'
/**
 * The sandbox question of `lingtai add` and `init` (#1160): asked after the
 * agents. **On by default**, and the block is written whether or not this host can provide it — a host that
 * cannot is told so, with srt's own sentences and the install command, never refused. Off is a choice with one
 * line on what it gives up, and writes `sandbox: { enabled: false }` so the choice is on record.
 *
 * `required` is never written here: a host that cannot run the sandbox would then refuse the project it just added.
 */
import {
  type Proposal,
  SANDBOX_OFF_LINE,
  hostsRefusal,
  parseHosts,
  sandboxChanges,
  sandboxCannotSentence,
} from '@lingtai/setup'
import { Effect } from 'effect'

import { type Answered, questionEffect, type QuestionWorld } from './question.ts'

export type SandboxAnswer = { changes: RecipeChange[] } | { refused: string }

type Validate = (answer: string) => Effect.Effect<string | null, unknown>

/** Whether agents and build commands run in the sandbox: `on` or `off`. */
export function askSandboxMode(
  world: QuestionWorld,
  at: {
    given: string | null
    current: 'on' | 'off' | null
    validate?: Validate
    kept?: string | undefined
  },
): Effect.Effect<Answered, unknown> {
  return questionEffect(world, {
    name: 'the sandbox',
    flag: '--sandbox on|off',
    given: at.given,
    prompt: 'run agents and build commands in the sandbox?',
    choices: ['on', 'off'],
    fallback: 'on',
    ...(at.current === null ? {} : { current: at.current }),
    ...(at.validate === undefined ? {} : { validate: at.validate }),
    kept: at.kept,
  })
}

/** The hosts a sandboxed run may reach beyond `builtIns`: comma-separated, or `none`. */
export function askSandboxHosts(
  world: QuestionWorld,
  at: {
    given: string | null
    /** `none`, or the comma-separated hosts the recipe already allows; null where it says nothing. */
    current: string | null
    builtIns: readonly string[]
    validate: Validate
    kept?: string | undefined
  },
): Effect.Effect<Answered, unknown> {
  return questionEffect(world, {
    name: 'the extra sandbox hosts',
    flag: '--sandbox-hosts <a.example,b.example>|none',
    given: at.given,
    prompt: `more hosts a sandboxed run may reach, comma-separated, or none (already allowed: ${at.builtIns.join(', ')})`,
    fallback: 'none',
    ...(at.current === null ? {} : { current: at.current }),
    kept: at.kept,
    validate: at.validate,
  })
}

export const askSandbox = Effect.fn('sandbox-step.askSandbox')(function* (
  world: QuestionWorld,
  at: {
    proposal: NonNullable<Proposal['sandbox']>
    flags: Readonly<Record<string, string>>
    kept: string
    /**
     * What the recipe says now, on a rerun (#1474): `enabled: null` is an absent block, which is off, and `allow`
     * its extra hosts. Each answer defaults to it, and an answer equal to it writes nothing.
     */
    current?: { enabled: boolean; allow: readonly string[]; required?: boolean }
  },
): Effect.fn.Return<SandboxAnswer, unknown> {
  const cannot = sandboxCannotSentence(at.proposal)
  const given = at.flags['sandbox'] ?? null
  // Said where it is drawn — never when a flag answers it.
  if (cannot !== null && given === null) world.log(cannot)

  const mode = yield* askSandboxMode(world, {
    given,
    current: at.current === undefined ? null : at.current.enabled ? 'on' : 'off',
    kept: at.kept,
  })
  if ('refused' in mode) return mode

  if (mode.answer === 'off') {
    world.log(SANDBOX_OFF_LINE)
    // The recipe already says off (or says nothing, which is off): nothing is written over it.
    if (at.current !== undefined && !at.current.enabled) return { changes: [] }
    return {
      changes:
        at.current === undefined
          ? sandboxChanges({ enabled: false, allow: [] })
          : [
              { path: ['sandbox', 'enabled'], value: false },
              // `required` beside `enabled: false` does not resolve: off takes the requirement with it.
              ...(at.current.required === true ? [{ path: ['sandbox', 'required'], value: false }] : []),
            ],
    }
  }

  const hosts = yield* askSandboxHosts(world, {
    given: at.flags['sandbox-hosts'] ?? null,
    current: at.current === undefined ? null : at.current.allow.length === 0 ? 'none' : at.current.allow.join(','),
    builtIns: at.proposal.builtIns,
    validate: (answer) => Effect.succeed(answer === 'none' ? null : hostsRefusal(parseHosts(answer))),
    kept: at.kept,
  })
  if ('refused' in hosts) return hosts
  const allow = hosts.answer === 'none' ? [] : parseHosts(hosts.answer)
  if (at.current === undefined) return { changes: sandboxChanges({ enabled: true, allow }) }
  // On a rerun only what changed is written: `sandboxChanges` replaces the whole block, and a hand-set
  // `required` would go with it.
  const same = allow.length === at.current.allow.length && allow.every((h, i) => h === at.current!.allow[i])
  return {
    changes: [
      ...(at.current.enabled ? [] : [{ path: ['sandbox', 'enabled'], value: true }]),
      ...(same ? [] : [{ path: ['sandbox', 'network', 'allow'], value: allow }]),
    ],
  }
})
