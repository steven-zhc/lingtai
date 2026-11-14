import type { RecipeChange } from '@lingtai/recipe'
/**
 * The sandbox question of `lingtai add` and `init` (#1160): asked once, of a recipe that is new, after the
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

import { questionEffect, type QuestionWorld } from './question.ts'

export type SandboxAnswer = { changes: RecipeChange[] } | { refused: string }

export const askSandbox = Effect.fn('sandbox-step.askSandbox')(function* (
  world: QuestionWorld,
  at: {
    proposal: NonNullable<Proposal['sandbox']>
    flags: Readonly<Record<string, string>>
    kept: string
  },
): Effect.fn.Return<SandboxAnswer, unknown> {
  const cannot = sandboxCannotSentence(at.proposal)
  const given = at.flags['sandbox'] ?? null
  // Said where it is drawn — never when a flag answers it.
  if (cannot !== null && given === null) world.log(cannot)

  const mode = yield* questionEffect(world, {
    name: 'the sandbox',
    flag: '--sandbox on|off',
    given,
    prompt: 'run agents and build commands in the sandbox?',
    choices: ['on', 'off'],
    fallback: 'on',
    kept: at.kept,
  })
  if ('refused' in mode) return mode

  if (mode.answer === 'off') {
    world.log(SANDBOX_OFF_LINE)
    return { changes: sandboxChanges({ enabled: false, allow: [] }) }
  }

  const hosts = yield* questionEffect(world, {
    name: 'the extra sandbox hosts',
    flag: '--sandbox-hosts <a.example,b.example>|none',
    given: at.flags['sandbox-hosts'] ?? null,
    prompt: `more hosts a sandboxed run may reach, comma-separated, or none (already allowed: ${at.proposal.builtIns.join(', ')})`,
    fallback: 'none',
    kept: at.kept,
    validate: (answer) => Effect.succeed(answer === 'none' ? null : hostsRefusal(parseHosts(answer))),
  })
  if ('refused' in hosts) return hosts
  const allow = hosts.answer === 'none' ? [] : parseHosts(hosts.answer)
  return { changes: sandboxChanges({ enabled: true, allow }) }
})
