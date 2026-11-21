/**
 * The write side of `copilot.github_token` (#1305): the fine-grained token with the *Copilot Requests*
 * permission a sandboxed Copilot run holds, which `copilotGithubToken` (`@lingtai/env`) reads.
 *
 * **The token is a secret.** It is a `Redacted` from the moment it leaves a prompt and is unwrapped in
 * exactly one place, `setMachineKey`. No sentence here quotes it, and none quotes the YAML parser, whose
 * message holds an excerpt of the offending line, which may be an older token.
 */
import { Effect, Redacted } from 'effect'

import { type MachineText, setMachineKey } from './claude-token.ts'

/** What a token Copilot honours starts with. */
export const COPILOT_TOKEN_PREFIX = 'github_pat_'

/** The refusal's sentence — it names the rule broken and never the value. */
export class CopilotTokenRefused {
  readonly _tag = 'CopilotTokenRefused'
  readonly say: string
  constructor(say: string) {
    this.say = say
  }
}

/** Trimmed, no whitespace inside, and `github_pat_…`; otherwise the rule broken, never the value. */
export function validateCopilotToken(
  token: Redacted.Redacted<string>,
): { ok: true; token: Redacted.Redacted<string> } | { ok: false; say: string } {
  const trimmed = Redacted.value(token).trim()
  if (trimmed === '') return { ok: false, say: 'the token is empty' }
  if (/\s/.test(trimmed)) return { ok: false, say: 'the token has whitespace inside it — paste it as one line' }
  if (trimmed.startsWith('ghp_')) {
    return {
      ok: false,
      say: 'a classic token, which Copilot ignores; make a fine-grained token with the Copilot Requests permission',
    }
  }
  if (!trimmed.startsWith(COPILOT_TOKEN_PREFIX)) {
    return {
      ok: false,
      say: `the token does not start with ${COPILOT_TOKEN_PREFIX} — make a fine-grained token with the Copilot Requests permission`,
    }
  }
  return { ok: true, token: Redacted.make(trimmed) }
}

/**
 * Sets `copilot.github_token` in the file through a document edit, so every other key and comment stays
 * where it was. Refuses a file that does not parse or is not a mapping, writing nothing. `environmentWins`
 * says whether `LINGTAI_COPILOT_GITHUB_TOKEN` is set in `env`, which a run reads first.
 */
export const setCopilotTokenEffect = (
  file: MachineText,
  path: string,
  token: Redacted.Redacted<string>,
  env: NodeJS.ProcessEnv,
): Effect.Effect<{ saved: true; environmentWins: boolean }, CopilotTokenRefused> =>
  Effect.gen(function* () {
    const checked = validateCopilotToken(token)
    if (!checked.ok) return yield* Effect.fail(new CopilotTokenRefused(checked.say))
    yield* setMachineKey(file, path, 'copilot', 'github_token', checked.token).pipe(
      Effect.mapError((say) => new CopilotTokenRefused(say)),
    )
    const raw = env['LINGTAI_COPILOT_GITHUB_TOKEN']
    return { saved: true as const, environmentWins: raw !== undefined && raw !== '' }
  })

/** The sentence said after a save while the variable is exported; `whose` names the process that was asked. */
export const copilotEnvironmentWinsSentence = (whose: string): string =>
  `LINGTAI_COPILOT_GITHUB_TOKEN is set in ${whose} environment, and a run reads it before the file — unset it for this token to be used`
