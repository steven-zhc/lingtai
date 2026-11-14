/**
 * The board's side of `claude.oauth_token` (#1169): one function the server
 * action calls, over ports so a unit test drives it. The token is `Redacted`
 * from the form field on, and the answer never carries it — only *saved*, or
 * the refusal's sentence.
 */
import { claudeTokenState } from '@lingtai/env'
import { environmentWinsSentence, type MachineText, setClaudeTokenEffect } from '@lingtai/setup'
import { Effect, Redacted } from 'effect'

export type ClaudeTokenAnswer = { ok: true; say: string } | { ok: false; say: string }

export interface ClaudeTokenPorts {
  file: MachineText
  path: string
  /** The board process's own environment. */
  env: NodeJS.ProcessEnv
}

/** Whether a token is set, read afresh on every call — never which, never the value. */
export function claudeTokenSetAt(ports: ClaudeTokenPorts) {
  try {
    return claudeTokenState(ports.env, ports.path, ports.file.read(ports.path))
  } catch {
    return { unreadable: `${ports.path} could not be read, so claude.oauth_token is unknown` }
  }
}

export const saveClaudeToken = (
  ports: ClaudeTokenPorts,
  field: FormDataEntryValue | null,
): Promise<ClaudeTokenAnswer> =>
  Effect.runPromise(
    setClaudeTokenEffect(ports.file, ports.path, Redacted.make(typeof field === 'string' ? field : ''), ports.env).pipe(
      Effect.map((done): ClaudeTokenAnswer => ({
        ok: true,
        say: done.environmentWins
          ? `saved — ${environmentWinsSentence("the board process's")}`
          : 'saved — the file is read per call, so a run sees it at once',
      })),
      Effect.catch((refused) => Effect.succeed<ClaudeTokenAnswer>({ ok: false, say: refused.say })),
    ),
  )
