/**
 * How this machine reaches GitHub, asked once (ADR 0114 §1, #710): the saved
 * `gh` login, or Lingtai's own App.
 *
 * Declares the slice of the world it needs rather than depending on
 * `InitWorld`, the way `github-app.ts` does, so `init` and `add` both reach it
 * through `runGithubBranch`.
 *
 * **Asked only when nothing has answered.** `github.auth`, an exported
 * `LINGTAI_GITHUB_AUTH` or a configured App each already say, and then one line
 * names which way is in use. **Never wrapped in `acceptingDefaults`**: it
 * decides whose name Lingtai acts under, so `--defaults` does not answer it
 * (0114 §1); with no terminal and no flag `question()` refuses naming the flag.
 *
 * **`gh` is checked, not trusted** — whether it came from the flag or from the
 * terminal: signed out, or without `repo` and `workflow`, it is refused with
 * the command that fixes it, and `github.auth: gh` is not written.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { paint } from '@lingtai/env/colour'
import { ghScopeGap, type GhStatus } from '@lingtai/github'
import { isMap, parseDocument } from 'yaml'

import { question, type QuestionWorld } from './question.ts'

export interface GithubAuthWorld extends QuestionWorld {
  github: {
    /** The machine's elected auth — null where nothing is configured. Throws where `github.auth` is refused. */
    auth?: () => 'app' | 'gh' | null
    /** `gh auth status`, as a value — asked only when the question is, or `--github-auth gh` is given. */
    ghStatus: () => Promise<GhStatus>
    /** Writes `github.auth`, keeping every other key and comment (0114 §6). */
    writeAuth: (kind: 'gh' | 'app') => Promise<void>
  }
}

/**
 * `pending`: `app` was chosen and is written only once the App exists — an
 * `app` written ahead of one would make `add` take an App check that throws
 * rather than answering "not installed".
 */
export type GithubAuthAnswer = { auth: 'gh' | 'app'; pending: boolean } | { refused: string }

/** `config.yml` as `{ read, write }` — `init`'s `world.machine`, or `node:fs` for `add`. */
export interface MachineText {
  read: (path: string) => string | null
  write: (path: string, text: string) => void
}

/**
 * `config.yml` over `node:fs`. Written beside, then renamed over: an
 * interruption mid-write leaves the old file or the new one, never half of
 * either. `0600`, because a database URL carries its password.
 */
export function liveMachineText(): MachineText {
  return {
    read: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
    write: (path, text) => {
      mkdirSync(dirname(path), { recursive: true })
      const partial = `${path}.${process.pid}.partial`
      writeFileSync(partial, text, { mode: 0o600 })
      chmodSync(partial, 0o600)
      renameSync(partial, path)
    },
  }
}

/** Sets `github.auth` in the file, through a document edit so nothing else in it moves. */
export function writeGithubAuth(file: MachineText, path: string, kind: 'gh' | 'app'): void {
  const text = file.read(path)
  const doc = parseDocument(text ?? '')
  if (doc.errors.length > 0) {
    throw new Error(`${path} does not parse as YAML (${doc.errors[0]!.message}) — fix it and run this again`)
  }
  if (doc.contents !== null && !isMap(doc.contents)) {
    throw new Error(`${path} is not a mapping — fix it and run this again`)
  }
  doc.setIn(['github', 'auth'], kind)
  file.write(path, doc.toString())
}

const LOGIN = 'gh auth login --hostname github.com --scopes repo,workflow'

/** Why a `gh` login cannot be used, ending in what to do — or null when it can. */
function notReady(status: GhStatus): string | null {
  if (!status.ok) {
    return status.reason === 'missing'
      ? `gh is not installed — install it (https://cli.github.com), run \`${LOGIN}\`, and run this again`
      : `${status.detail}, and run this again`
  }
  const gap = ghScopeGap(status)
  return gap === null ? null : `${gap}, and run this again`
}

export async function askGithubAuth(
  world: GithubAuthWorld,
  flags: Record<string, string>,
  appConfigured: boolean,
  kept: string,
): Promise<GithubAuthAnswer> {
  const given = flags['github-auth'] ?? null
  if (given !== null && given !== 'gh' && given !== 'app') {
    return { refused: `--github-auth ${given} is not one of gh, app. ${kept}` }
  }

  const set = world.github.auth?.() ?? null
  const elected = set ?? (appConfigured ? 'app' : null)
  if (elected !== null) {
    if (given !== null && given !== elected) {
      return {
        refused:
          `--github-auth ${given}, but ${elected} is already how this machine reaches GitHub. ` +
          `Leave out --github-auth, or pass --github-auth ${elected}. ${kept}`,
      }
    }
    // An explicit `--github-auth gh` is checked even where `gh` is already saved:
    // the login may have been signed out, or lost a scope, since it was written.
    if (given === 'gh') {
      const why = notReady(await world.github.ghStatus())
      if (why !== null) return { refused: `--github-auth gh, but ${why}. ${kept}` }
    }
    world.log(`github       ${elected} — ${set === null ? 'a GitHub App is configured here' : 'github.auth'}`)
    return { auth: elected, pending: false }
  }

  if (given === 'app') return { auth: 'app', pending: true }

  const status = await world.github.ghStatus()
  const why = notReady(status)

  const write = async (): Promise<GithubAuthAnswer> => {
    try {
      await world.github.writeAuth('gh')
    } catch (err) {
      return { refused: `${(err as Error).message}. ${kept}` }
    }
    return { auth: 'gh', pending: false }
  }

  if (given === 'gh') {
    return why === null ? write() : { refused: `--github-auth gh, but ${why}. ${kept}` }
  }

  if (why === null && status.ok) {
    const asked = await question(world, {
      name: 'how this machine reaches GitHub',
      flag: '--github-auth gh, or --github-auth app',
      given: null,
      prompt:
        `gh, signed in as ${status.login} — Lingtai's labels, comments, pull requests and pushes will appear as ` +
        'that account — or app, its own GitHub App',
      fallback: 'gh',
      choices: ['gh', 'app'],
      kept,
    })
    if ('refused' in asked) return { refused: asked.refused }
    return asked.answer === 'gh' ? write() : { auth: 'app', pending: true }
  }

  world.log(paint.signal(`github       gh cannot be used yet — ${why!.replace(/, and run this again$/, '')}`))
  const asked = await question(world, {
    name: 'how this machine reaches GitHub',
    flag: '--github-auth gh, or --github-auth app',
    given: null,
    prompt: 'app, a GitHub App of its own — or gh, once you have fixed the above and run this again',
    fallback: 'app',
    choices: ['app', 'gh'],
    kept,
  })
  if ('refused' in asked) return { refused: asked.refused }
  return asked.answer === 'gh' ? { refused: `gh was chosen, but ${why}. ${kept}` } : { auth: 'app', pending: true }
}
