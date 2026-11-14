/**
 * The write side of `claude.oauth_token` (#1169, 0127 §8): the long-lived token
 * `claude setup-token` made, which a sandboxed Claude Code run holds and
 * `claudeOauthToken` (`@lingtai/env`) reads. One module, two inputs (0125): the
 * terminal and the board both call `setClaudeTokenEffect`.
 *
 * **The token is a secret.** It is a `Redacted` from the moment it leaves a
 * prompt, a child's stdout or a form field, and is unwrapped in exactly one
 * place — the `setIn` below. No sentence here quotes it, and none quotes the
 * YAML parser, whose message holds an excerpt of the offending line, which may
 * be an older token.
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { runtimesOf } from '@lingtai/recipe'
import { Effect, Redacted } from 'effect'
import { isMap, parseDocument } from 'yaml'

/** `config.yml` as `{ read, write }` — `init`'s `world.machine`, or `node:fs` through `liveMachineText`. */
export interface MachineText {
  read: (path: string) => string | null
  write: (path: string, text: string) => void
}

/**
 * `config.yml` over `node:fs`. Written beside, then renamed over: an
 * interruption mid-write leaves the old file or the new one, never half of
 * either. `0600`, because a database URL carries its password. The partial's
 * name carries a random suffix as well as the pid, so two writers in one
 * process (two board posts) never share one.
 */
export function liveMachineText(): MachineText {
  return {
    read: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
    write: (path, text) => {
      mkdirSync(dirname(path), { recursive: true })
      const partial = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.partial`
      writeFileSync(partial, text, { mode: 0o600 })
      chmodSync(partial, 0o600)
      renameSync(partial, path)
    },
  }
}

/** What `claude setup-token` prints a token as, and so what a token must start with. */
export const CLAUDE_TOKEN_PREFIX = 'sk-ant-oat01-'

/** The refusal's sentence — it names the rule broken and never the value. */
export class ClaudeTokenRefused {
  readonly _tag = 'ClaudeTokenRefused'
  readonly say: string
  constructor(say: string) {
    this.say = say
  }
}

/** Where a token is set, as `claudeTokenState` (`@lingtai/env`) answers it. */
export type ClaudeTokenSetAt = { environment: boolean; file: boolean } | { unreadable: string }

/** What a person is told when they skip, once. */
export const CLAUDE_TOKEN_SKIPPED =
  'sandboxed Claude Code runs will be refused until the token is set — run `lingtai token claude` when you have one'

/**
 * Whether the person is asked: the sandbox is on, some step names `claude-code`,
 * and neither the environment nor the file holds a token. Whether the project is
 * *new* is the caller's to know. An unreadable file does not ask — the caller
 * says so, and the add goes on.
 */
export function needsClaudeToken(
  recipe: Parameters<typeof runtimesOf>[0] & { sandbox?: { enabled: boolean } | undefined },
  state: ClaudeTokenSetAt,
): boolean {
  if ('unreadable' in state) return false
  if (recipe.sandbox === undefined || !recipe.sandbox.enabled) return false
  if (!runtimesOf(recipe).includes('claude-code')) return false
  return !state.environment && !state.file
}

/** Trimmed, no whitespace inside, and `sk-ant-oat01-…`; otherwise the rule broken, never the value. */
export function validateClaudeToken(
  token: Redacted.Redacted<string>,
): { ok: true; token: Redacted.Redacted<string> } | { ok: false; say: string } {
  const trimmed = Redacted.value(token).trim()
  if (trimmed === '') return { ok: false, say: 'the token is empty' }
  if (/\s/.test(trimmed)) return { ok: false, say: 'the token has whitespace inside it — paste it as one line' }
  if (!trimmed.startsWith(CLAUDE_TOKEN_PREFIX)) {
    return {
      ok: false,
      say: `the token does not start with ${CLAUDE_TOKEN_PREFIX} — is it what \`claude setup-token\` printed?`,
    }
  }
  return { ok: true, token: Redacted.make(trimmed) }
}

/**
 * Sets `claude.oauth_token` in the file through a document edit, so every other
 * key and comment stays where it was. Refuses a file that does not parse or is
 * not a mapping, writing nothing. `environmentWins` says whether
 * `LINGTAI_CLAUDE_OAUTH_TOKEN` is set in `env`, which a run reads first.
 */
export const setClaudeTokenEffect = (
  file: MachineText,
  path: string,
  token: Redacted.Redacted<string>,
  env: NodeJS.ProcessEnv,
): Effect.Effect<{ saved: true; environmentWins: boolean }, ClaudeTokenRefused> =>
  Effect.gen(function* () {
    const checked = validateClaudeToken(token)
    if (!checked.ok) return yield* Effect.fail(new ClaudeTokenRefused(checked.say))
    const text = yield* Effect.try({
      try: () => file.read(path),
      catch: () => new ClaudeTokenRefused(`${path} could not be read — nothing was written`),
    })
    const doc = parseDocument(text ?? '')
    if (doc.errors.length > 0) {
      return yield* Effect.fail(new ClaudeTokenRefused(`${path} does not parse as YAML — fix it and run this again`))
    }
    if (doc.contents !== null && !isMap(doc.contents)) {
      return yield* Effect.fail(new ClaudeTokenRefused(`${path} is not a mapping — fix it and run this again`))
    }
    doc.setIn(['claude', 'oauth_token'], Redacted.value(checked.token))
    const out = doc.toString()
    yield* Effect.try({
      try: () => file.write(path, out),
      catch: () => new ClaudeTokenRefused(`${path} could not be written — nothing was changed`),
    })
    const raw = env['LINGTAI_CLAUDE_OAUTH_TOKEN']
    return { saved: true as const, environmentWins: raw !== undefined && raw.trim() !== '' }
  })

/** The sentence said after a save while the variable is exported; `whose` names the process that was asked. */
export const environmentWinsSentence = (whose: string): string =>
  `LINGTAI_CLAUDE_OAUTH_TOKEN is set in ${whose} environment, and a run reads it before the file — unset it for this token to be used`
