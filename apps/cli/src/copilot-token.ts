/**
 * `copilot.github_token` asked for at a terminal (#1305): `lingtai token copilot`. The write is
 * `@lingtai/setup`'s (`setCopilotTokenEffect`); this file is how a person at a terminal gets the token
 * into it.
 *
 * **The token is a secret.** It is `Redacted` from the moment the hidden prompt returns it, no flag
 * carries it, and nothing here logs, echoes or appends it. Nothing is appended to the log either; this
 * is a machine-config edit, like `lingtai token claude`.
 */
import { join } from 'node:path'

import { copilotTokenState, stateDir } from '@lingtai/env'
import { copilotEnvironmentWinsSentence, type MachineText, setCopilotTokenEffect } from '@lingtai/setup'
import { Effect, Redacted } from 'effect'

import type { QuestionWorld } from './question.ts'

export interface CopilotTokenWorld extends Pick<QuestionWorld, 'ask' | 'log'> {
  machine: MachineText
  /** `config.yml`'s path. */
  path: string
  /** This process's environment — where `LINGTAI_COPILOT_GITHUB_TOKEN` would be. */
  env: NodeJS.ProcessEnv
  /** Whether there is a terminal to ask at. */
  interactive: boolean
}

/** `copilotTokenState` over this world's file; a read that threw is `unreadable`, never *not set*. */
const stateOf = (world: Pick<CopilotTokenWorld, 'machine' | 'path' | 'env'>): ReturnType<typeof copilotTokenState> => {
  try {
    return copilotTokenState(world.env, world.path, world.machine.read(world.path))
  } catch {
    return { unreadable: `${world.path} could not be read, so copilot.github_token is unknown` }
  }
}

/** `lingtai token copilot`: runs whenever asked. Exit code 0 saved or kept, 1 refused. */
export const copilotTokenCommand = (world: CopilotTokenWorld): Effect.Effect<0 | 1, unknown> =>
  Effect.gen(function* () {
    const state = stateOf(world)
    if ('unreadable' in state) {
      world.log(`${state.unreadable} — fix it and run this again`)
      return 1 as const
    }
    if (!world.interactive) {
      world.log('this needs a terminal — or set copilot.github_token in ~/.lingtai/config.yml by hand')
      return 1 as const
    }
    if (state.environment)
      world.log("a token is set in this process's environment (LINGTAI_COPILOT_GITHUB_TOKEN), which a run reads first")
    if (state.file) world.log(`a token is already set in ${world.path}`)
    if (state.environment || state.file) {
      const choice = yield* Effect.tryPromise(() =>
        world.ask('', { message: 'replace it, or keep it?', defaultValue: 'keep', choices: ['keep', 'replace'] }),
      )
      if (choice !== 'replace') {
        world.log('kept — nothing was changed')
        return 0 as const
      }
    }
    const pasted = yield* Effect.tryPromise(() =>
      world.ask('', {
        message:
          'a fine-grained personal access token (github_pat_…) with the Copilot Requests account permission (leave empty to skip)',
        defaultValue: '',
        secret: true,
      }),
    )
    if (pasted === null || pasted.trim() === '') {
      world.log('skipped — nothing was changed')
      return 0 as const
    }
    return yield* setCopilotTokenEffect(world.machine, world.path, Redacted.make(pasted), world.env).pipe(
      Effect.map((done) => {
        world.log(`saved copilot.github_token in ${world.path}`)
        if (done.environmentWins) world.log(copilotEnvironmentWinsSentence("this process's"))
        return 0 as const
      }),
      Effect.catch((refused) => {
        world.log(`${refused.say} — nothing was written`)
        return Effect.succeed(1 as const)
      }),
    )
  })

/** The live world for `lingtai token copilot`. */
export const liveCopilotTokenWorld = (
  base: Pick<CopilotTokenWorld, 'ask' | 'log' | 'machine' | 'interactive'>,
  env: NodeJS.ProcessEnv = process.env,
): CopilotTokenWorld => ({ ...base, path: join(stateDir(env), 'config.yml'), env })
