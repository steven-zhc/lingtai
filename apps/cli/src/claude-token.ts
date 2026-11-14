/**
 * `claude.oauth_token` asked for at a terminal (#1169, 0127 §8). The write is
 * `@lingtai/setup`'s (`setClaudeTokenEffect`); this file is how a person at a
 * terminal gets the token into it, for `init`, `add` and `lingtai token claude`.
 *
 * **The token is a secret.** It is `Redacted` from the moment it is read off the
 * child's stdout or the paste prompt, no flag carries it (argv is readable in
 * `ps` and in shell history), and nothing here logs, echoes or appends it: the
 * child's output is echoed a whole line at a time with any token in it masked.
 * Nothing is appended to the log either; this is a machine-config edit, like
 * `writeGithubAuth`.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

import { claudeTokenState, stateDir } from '@lingtai/env'
import {
  CLAUDE_TOKEN_SKIPPED,
  type ClaudeTokenSetAt,
  environmentWinsSentence,
  type MachineText,
  needsClaudeToken,
  setClaudeTokenEffect,
} from '@lingtai/setup'
import { Effect, Redacted } from 'effect'

import type { QuestionWorld } from './question.ts'

/** What `claude setup-token` prints a token as. Global, so a line with two is two matches. */
const TOKEN_RUN = /sk-ant-oat01-[A-Za-z0-9_-]+/g

/** A line with every token run in it replaced, so the terminal never shows one. */
export const maskTokens = (line: string): string => line.replace(TOKEN_RUN, 'sk-ant-oat01-…(hidden)')

/** How the child ended: its code, or that there is no `claude` to run. Chunks go to `onChunk` as they arrive. */
export type SetupTokenRun = { code: number | null } | { missing: true }

export interface ClaudeTokenWorld extends Pick<QuestionWorld, 'ask' | 'log'> {
  /** Spawns `claude setup-token` with stdin and stderr inherited and stdout piped. */
  run: (onChunk: (chunk: string) => void) => Promise<SetupTokenRun>
  machine: MachineText
  /** `config.yml`'s path. */
  path: string
  /** This process's environment — where `LINGTAI_CLAUDE_OAUTH_TOKEN` would be. */
  env: NodeJS.ProcessEnv
  /** Whether there is a terminal to ask at. */
  interactive: boolean
}

/** `claude setup-token` over `node:child_process`; stdout is piped, which Claude Code 2.1.325 completes its sign-in with. */
export const liveSetupTokenRun = (): ClaudeTokenWorld['run'] => (onChunk) =>
  new Promise((resolve) => {
    const child = spawn('claude', ['setup-token'], { stdio: ['inherit', 'pipe', 'inherit'] })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => onChunk(chunk))
    child.on('error', (err: NodeJS.ErrnoException) =>
      resolve(err.code === 'ENOENT' ? { missing: true } : { code: null }),
    )
    child.on('close', (code) => resolve({ code }))
  })

/**
 * Runs the child; the token if it printed exactly one and exited 0, else
 * `fallback`, one line saying why. Stdout is echoed a whole line at a time,
 * masked, so a token split across two chunks is never printed half unmasked.
 */
export const takeFromSetupToken = (
  world: Pick<ClaudeTokenWorld, 'run' | 'log'>,
): Effect.Effect<{ token: Redacted.Redacted<string> } | { fallback: string }> =>
  Effect.promise(() => {
    const found: string[] = []
    let pending = ''
    const line = (text: string): void => {
      for (const m of text.matchAll(TOKEN_RUN)) found.push(m[0])
      world.log(maskTokens(text))
    }
    const onChunk = (chunk: string): void => {
      pending += chunk
      const parts = pending.split('\n')
      pending = parts.pop() ?? ''
      for (const part of parts) line(part)
    }
    return world.run(onChunk).then((ended): { token: Redacted.Redacted<string> } | { fallback: string } => {
      if (pending !== '') line(pending)
      if ('missing' in ended) return { fallback: '`claude` is not on PATH' }
      if (ended.code !== 0) return { fallback: '`claude setup-token` did not finish' }
      if (found.length === 0) return { fallback: 'no token was in what `claude setup-token` printed' }
      if (found.length > 1) return { fallback: 'more than one token was in what `claude setup-token` printed' }
      return { token: Redacted.make(found[0]!) }
    })
  })

/** The token from `claude setup-token`, else pasted at a hidden prompt; null is a skip (an empty answer). */
export const obtainClaudeToken = (world: ClaudeTokenWorld): Effect.Effect<Redacted.Redacted<string> | null, unknown> =>
  Effect.gen(function* () {
    // Before the browser sign-in starts, so deferring is a choice and not a Ctrl+C that abandons the command.
    const go = yield* Effect.tryPromise(() =>
      world.ask('', {
        message: 'run `claude setup-token` now, or skip and set the token later?',
        defaultValue: 'run',
        choices: ['run', 'skip'],
      }),
    )
    if (go === 'skip') return null
    world.log('running `claude setup-token` — finish the sign-in in the browser')
    const taken = yield* takeFromSetupToken(world)
    if ('token' in taken) return taken.token
    world.log(`${taken.fallback} — paste the token instead (run \`claude setup-token\` in another terminal)`)
    const pasted = yield* Effect.tryPromise(() =>
      world.ask('', {
        message: 'the token `claude setup-token` printed (leave empty to skip)',
        defaultValue: '',
        secret: true,
      }),
    )
    return pasted === null || pasted.trim() === '' ? null : Redacted.make(pasted)
  })

/** `claudeTokenState` over this world's file; a read that threw is `unreadable`, never *not set*. */
export const stateOf = (world: Pick<ClaudeTokenWorld, 'machine' | 'path' | 'env'>): ClaudeTokenSetAt => {
  try {
    return claudeTokenState(world.env, world.path, world.machine.read(world.path))
  } catch {
    return { unreadable: `${world.path} could not be read, so claude.oauth_token is unknown` }
  }
}

/** Writes a token and says so; the refusal's sentence otherwise. Returns whether it was saved. */
const save = (world: ClaudeTokenWorld, token: Redacted.Redacted<string>): Effect.Effect<boolean> =>
  setClaudeTokenEffect(world.machine, world.path, token, world.env).pipe(
    Effect.map((done) => {
      world.log(`saved claude.oauth_token in ${world.path}`)
      if (done.environmentWins) world.log(environmentWinsSentence("this process's"))
      return true
    }),
    Effect.catch((refused) => {
      world.log(`${refused.say}. ${CLAUDE_TOKEN_SKIPPED}`)
      return Effect.succeed(false)
    }),
  )

/**
 * `init` and `add`, once the recipe is final: asks only when the sandbox is on,
 * a step names `claude-code` and no token is set. Never refuses the add — the
 * token belongs to the machine, not the project — so every outcome is a line.
 */
export const askClaudeTokenForRecipe = (
  world: ClaudeTokenWorld,
  recipe: Parameters<typeof needsClaudeToken>[0],
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const state = stateOf(world)
    if ('unreadable' in state) {
      world.log(`${state.unreadable}. ${CLAUDE_TOKEN_SKIPPED}`)
      return
    }
    if (!needsClaudeToken(recipe, state)) return
    if (!world.interactive) {
      world.log(`no terminal to ask for the Claude Code token at — ${CLAUDE_TOKEN_SKIPPED}`)
      return
    }
    const token = yield* obtainClaudeToken(world)
    if (token === null) {
      world.log(CLAUDE_TOKEN_SKIPPED)
      return
    }
    yield* save(world, token)
  })

/** `lingtai token claude`: runs whenever asked. Exit code 0 saved or kept, 1 refused. */
export const claudeTokenCommand = (world: ClaudeTokenWorld): Effect.Effect<0 | 1, unknown> =>
  Effect.gen(function* () {
    const state = stateOf(world)
    if ('unreadable' in state) {
      world.log(`${state.unreadable} — fix it and run this again`)
      return 1 as const
    }
    if (!world.interactive) {
      world.log('this needs a terminal — or set claude.oauth_token in ~/.lingtai/config.yml by hand')
      return 1 as const
    }
    if (state.environment)
      world.log("a token is set in this process's environment (LINGTAI_CLAUDE_OAUTH_TOKEN), which a run reads first")
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
    const token = yield* obtainClaudeToken(world)
    if (token === null) {
      world.log('skipped — nothing was changed')
      return 0 as const
    }
    return (yield* save(world, token)) ? (0 as const) : (1 as const)
  })

/** The live world for `lingtai token claude` and the add flows. */
export const liveClaudeTokenWorld = (
  base: Pick<ClaudeTokenWorld, 'ask' | 'log' | 'machine' | 'interactive'>,
  env: NodeJS.ProcessEnv = process.env,
): ClaudeTokenWorld => ({ ...base, run: liveSetupTokenRun(), path: join(stateDir(env), 'config.yml'), env })
