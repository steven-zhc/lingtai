/**
 * The machine's questions as one ordered list (0125 §9, #1522): the store, how this machine reaches
 * GitHub, the daily spend ceiling, the sandboxed Claude Code token. Defined here, once — a terminal
 * and a board each supply an `Asker` per question id and no list of their own.
 *
 * **A descriptor decides; an asker only asks.** `runSetupList` reads what is in force (the
 * environment, then `config.yml`), decides the default (what is in force, else the system's), gets
 * an answer — a flag, the default where there is no terminal or `--defaults`, or the asker — and
 * writes it. An answer equal to what is in force writes nothing.
 *
 * **Every write re-reads the file** (`MachineText`), so no write goes through a document read at the
 * start of a run and made stale by the one before it.
 *
 * Nothing here reaches the environment, `gh` or a database directly: each is a port the input
 * supplies (`MachinePorts`), so the list is the same in a test, the terminal and the board.
 */
import { ghScopeGap, type GhStatus } from '@lingtai/github'
import type { Recipe } from '@lingtai/recipe'
import { Effect, Redacted } from 'effect'
import { isMap, parseDocument } from 'yaml'

import {
  CLAUDE_TOKEN_SKIPPED,
  type ClaudeTokenSetAt,
  environmentWinsSentence,
  type MachineText,
  needsClaudeToken,
  setClaudeTokenEffect,
} from './claude-token.ts'
import type { Entry, InForce, SetupQuestion, SetupRow } from './setup-list.ts'

// ------------------------------------------------------------ the descriptor --

export interface RunContext {
  /** The recipe being set up, once a project path has made it; absent or null before. */
  draft?: Recipe | null
}

// ------------------------------------------------------------ the file writers --

/** The document of `path`, refused where it does not parse or is not a mapping — re-read at every write. */
function readDoc(file: MachineText, path: string) {
  const text = file.read(path)
  const doc = parseDocument(text ?? '')
  if (doc.errors.length > 0) {
    throw new Error(`${path} does not parse as YAML (${doc.errors[0]!.message}) — fix it and run this again`)
  }
  if (doc.contents !== null && !isMap(doc.contents)) {
    throw new Error(`${path} is not a mapping — fix it and run this again`)
  }
  return doc
}

/** Sets `github.auth` in the file, through a document edit so nothing else in it moves. */
export function writeGithubAuth(file: MachineText, path: string, kind: 'gh' | 'app' | 'none'): void {
  const doc = readDoc(file, path)
  doc.setIn(['github', 'auth'], kind)
  file.write(path, doc.toString())
}

/**
 * Sets `limits.day_usd` to a positive number, or removes it (and `limits`, if that leaves it empty).
 * **A figure that `machineDayCeiling` would throw on is never written** — it reads every look the daemon takes.
 */
export function writeDayCeiling(file: MachineText, path: string, dollars: number | null): void {
  if (dollars !== null && !(Number.isFinite(dollars) && dollars > 0)) {
    throw new Error(`limits.day_usd ${dollars} is not a positive number of dollars — nothing was written`)
  }
  const doc = readDoc(file, path)
  if (dollars === null) {
    if (!doc.hasIn(['limits', 'day_usd'])) return
    doc.deleteIn(['limits', 'day_usd'])
    const limits = doc.get('limits')
    if (isMap(limits) && limits.items.length === 0) doc.delete('limits')
  } else {
    doc.setIn(['limits', 'day_usd'], dollars)
  }
  file.write(path, doc.toString())
}

/** Sets the store: SQLite removes `database.url`, so the other store's value is not left behind (#215). */
export function writeStore(file: MachineText, path: string, store: { sqlite: true } | { url: string }): void {
  const doc = readDoc(file, path)
  if ('sqlite' in store) {
    doc.setIn(['database', 'store'], 'sqlite')
    doc.deleteIn(['database', 'url'])
  } else {
    doc.setIn(['database', 'store'], 'postgres')
    doc.setIn(['database', 'url'], store.url)
  }
  file.write(path, doc.toString())
}

// ------------------------------------------------------------ the ports --

export type StoreReading =
  | { store: null; fault?: string }
  | { store: 'sqlite'; environment?: boolean; variable?: string }
  | { store: 'postgres'; url: string; environment: boolean; variable?: string }

export type AuthReading =
  | { kind: 'gh' | 'app' | 'none' | null; environment: boolean; written: boolean }
  | { refused: string; environment: boolean }

export type CeilingReading = { value: number | null; environment: boolean } | { fault: string; environment: boolean }

export type DatabaseCheck = { ok: true } | { ok: false; why: string }

export type AppReading =
  | { configured: false }
  | { configured: true; ok: true }
  | { configured: true; ok: false; why: string }

export interface MachinePorts {
  path: string
  machine: MachineText
  store: () => StoreReading
  githubAuth: () => AuthReading
  dayCeiling: () => CeilingReading
  tokenState: () => ClaudeTokenSetAt
  database: (url: string) => Effect.Effect<DatabaseCheck, unknown>
  ghStatus: () => Effect.Effect<GhStatus, unknown>
  app: () => Effect.Effect<AppReading, unknown>
  /** Every registered project's resolved recipe; one that cannot be read is left out. */
  recipes: () => Effect.Effect<readonly Recipe[], unknown>
  /** `claude setup-token`, or a paste; null is a skip. */
  obtainToken: () => Effect.Effect<Redacted.Redacted<string> | null, unknown>
  env: NodeJS.ProcessEnv
  say: (line: string) => void
}

export const MACHINE_QUESTION_IDS = ['store', 'github', 'ceiling', 'claude-token'] as const
export type MachineQuestionId = (typeof MACHINE_QUESTION_IDS)[number]

const LOGIN = 'gh auth login --hostname github.com --scopes repo,workflow'

/** Why a `gh` login cannot be used, ending in what to do — or null when it can. */
export function ghNotReady(status: GhStatus): string | null {
  if (!status.ok) {
    return status.reason === 'missing'
      ? `gh is not installed — install it (https://cli.github.com), run \`${LOGIN}\`, and run this again`
      : `${status.detail}, and run this again`
  }
  const gap = ghScopeGap(status)
  return gap === null ? null : `${gap}, and run this again`
}

/** What a typed ceiling is, or why not: a positive number with or without `$`, or `none`. */
export function parseCeiling(answer: string): { dollars: number | null } | { bad: string } {
  const text = answer.trim()
  if (text === 'none') return { dollars: null }
  if (!/^\$?\d+(\.\d+)?$/.test(text)) {
    return { bad: `${answer} is not a number of dollars — a positive number, with or without a leading $, or none` }
  }
  const n = Number(text.replace(/^\$/, ''))
  if (!(Number.isFinite(n) && n > 0)) {
    return {
      bad: `${answer} is not a positive number of dollars — 0 would stop the conductor; use none for no ceiling`,
    }
  }
  return { dollars: n }
}

/** A URL fit to print: the password is never shown. */
const redactedUrl = (url: string): string => url.replace(/(\/\/[^:/@]*:)[^@]*@/, '$1***@')

const dollarsText = (n: number): string => `$${n}`

// ------------------------------------------------------------ the list --

/**
 * The machine list, in order. `githubRequired` is `lingtai add`'s: a GitHub project needs a way to reach
 * GitHub, so `none` is refused as an answer and the entry runs only where nothing (or `none`) is in force.
 */
export function machineQuestions(
  ports: MachinePorts,
  opts: { githubRequired: boolean },
): readonly SetupQuestion<RunContext>[] {
  const store: SetupQuestion<RunContext> = {
    id: 'store',
    card: { label: 'log', environment: 'LINGTAI_DATABASE_URL' },
    name: 'the store',
    flag: '--store sqlite, or --store postgres --database-url <url>',
    fromFlags: (flags) => {
      const url = flags['database-url']
      if (url !== undefined) return url
      return flags['store'] === 'sqlite' ? '' : null
    },
    normalize: (a) => (a === 'sqlite' ? '' : a),
    inForce: () =>
      Effect.gen(function* () {
        const read = ports.store()
        if (read.store === null) return read.fault === undefined ? null : ({ fault: read.fault, from: 'file' } as const)
        if (read.store === 'sqlite')
          return { value: '', from: read.environment ? 'environment' : 'file', variable: read.variable } as const
        const check = yield* ports.database(read.url)
        const from = read.environment ? ('environment' as const) : ('file' as const)
        if (check.ok) return { value: read.url, from, variable: read.variable } as const
        return {
          fault: `the database ${read.environment ? 'the environment' : 'config.yml'} names does not answer — ${check.why}`,
          from,
          value: read.url,
          ...(read.environment ? { fatal: true } : {}),
        } as const
      }),
    systemDefault: () => Effect.succeed(''),
    validate: (answer) =>
      Effect.gen(function* () {
        if (answer === '' || answer === 'sqlite') return null
        if (!/^postgres(ql)?:\/\//.test(answer)) {
          return 'that is not a Postgres URL — it begins postgres:// or postgresql://. Nothing was written'
        }
        const check = yield* ports.database(answer)
        return check.ok ? null : `${redactedUrl(answer)} does not answer — ${check.why}. Nothing was written`
      }),
    write: (answer, inForce) =>
      Effect.try({
        try: () => {
          if (inForce !== null && !('fault' in inForce) && inForce.value === answer) return { wrote: false }
          writeStore(ports.machine, ports.path, answer === '' ? { sqlite: true } : { url: answer })
          return { wrote: true }
        },
        catch: (e) => e,
      }),
    row: (value) => {
      if (value === '') return 'SQLite'
      try {
        return `Postgres · ${new URL(value).hostname}`
      } catch {
        return 'Postgres · (a URL that does not parse)'
      }
    },
  }

  const github: SetupQuestion<RunContext> = {
    id: 'github',
    card: { label: 'github', environment: 'LINGTAI_GITHUB_AUTH' },
    name: 'how this machine reaches GitHub',
    flag: '--github-auth gh, --github-auth app, or --github-auth none',
    fromFlags: (flags) => {
      const given = flags['github-auth']
      if (given === undefined) return null
      if (given !== 'gh' && given !== 'app' && given !== 'none') {
        return { refused: `--github-auth ${given} is not one of gh, app, none` }
      }
      return given
    },
    inForce: () =>
      Effect.gen(function* () {
        const read = ports.githubAuth()
        if ('refused' in read) {
          return {
            fault: read.refused,
            from: read.environment ? 'environment' : 'file',
            ...(read.environment ? { fatal: true } : {}),
          } as const
        }
        // A configured App that does not answer is not replaced beside it; `gh` never consults one (0114 §1).
        if (read.kind !== 'gh') {
          const app = yield* ports.app()
          if (app.configured && !app.ok) {
            return {
              fault:
                `the GitHub App configured here does not answer — ${app.why}. A second App is not created beside it: ` +
                'fix its credentials, or remove them, and run lingtai init again',
              from: 'file',
              fatal: true,
            } as const
          }
        }
        if (read.kind === null) return null
        return { value: read.kind, from: read.environment ? 'environment' : 'file' } as const
      }),
    systemDefault: () =>
      Effect.gen(function* () {
        const status = yield* ports.ghStatus()
        return ghNotReady(status) === null ? 'gh' : 'none'
      }),
    validate: (answer) =>
      Effect.gen(function* () {
        if (answer !== 'gh' && answer !== 'app' && answer !== 'none') {
          return `${answer} is not one of gh, app, none`
        }
        if (answer === 'none' && opts.githubRequired) {
          return 'a GitHub project needs a way to reach GitHub, and none is not one — pass --github-auth gh or --github-auth app'
        }
        if (answer === 'gh') {
          const why = ghNotReady(yield* ports.ghStatus())
          if (why !== null) return `gh was chosen, but ${why}`
        }
        return null
      }),
    write: (answer, inForce) =>
      Effect.gen(function* () {
        if (inForce !== null && !('fault' in inForce) && inForce.value === answer) return { wrote: false }
        if (answer === 'app') {
          // `app` is written only once the App exists: ahead of one, `add` would take an App check that throws.
          const app = yield* ports.app()
          if (!(app.configured && app.ok)) return { wrote: false, pending: true as const }
        }
        yield* Effect.try({
          try: () => writeGithubAuth(ports.machine, ports.path, answer as 'gh' | 'app' | 'none'),
          catch: (e) => e,
        })
        return { wrote: true }
      }),
    refusesEnvironment: (value) =>
      value === 'none' && opts.githubRequired
        ? 'LINGTAI_GITHUB_AUTH names none, and a GitHub project needs a way to reach GitHub — unset it or export gh or app. Nothing was written'
        : null,
    row: (value, _before, description) =>
      description ?? (value === 'none' ? 'no GitHub' : value === 'app' ? 'the App' : value),
  }

  const ceiling: SetupQuestion<RunContext> = {
    id: 'ceiling',
    card: { label: 'spend', environment: 'LINGTAI_LIMITS_DAY_USD' },
    name: 'the daily spend ceiling',
    flag: '--day-usd <dollars>, or --day-usd none',
    fromFlags: (flags) => flags['day-usd'] ?? null,
    normalize: (a) => {
      const parsed = parseCeiling(a)
      return 'bad' in parsed ? a : parsed.dollars === null ? 'none' : String(parsed.dollars)
    },
    inForce: () =>
      Effect.sync((): InForce => {
        const read = ports.dayCeiling()
        const from = read.environment ? ('environment' as const) : ('file' as const)
        if ('fault' in read) return { fault: read.fault, from, ...(read.environment ? { fatal: true } : {}) }
        return read.value === null ? null : { value: String(read.value), from }
      }),
    systemDefault: () => Effect.succeed('100'),
    validate: (answer) =>
      Effect.sync(() => {
        const parsed = parseCeiling(answer)
        return 'bad' in parsed ? `${parsed.bad}. Nothing was written` : null
      }),
    why: [
      'without a ceiling the conductor runs one attempt at a time; none removes the line, so the next run offers 100 again',
    ],
    show: (v) => dollarsText(Number(v)),
    write: (answer, inForce) =>
      Effect.try({
        try: () => {
          const parsed = parseCeiling(answer)
          if ('bad' in parsed) throw new Error(`${parsed.bad}. Nothing was written`)
          // A value that could not be read is not an absent one: it stays in the file until it is replaced or removed.
          if (inForce === null || !('fault' in inForce)) {
            const now = inForce === null ? null : Number(inForce.value)
            if (parsed.dollars === now) return { wrote: false }
          }
          writeDayCeiling(ports.machine, ports.path, parsed.dollars)
          return { wrote: true }
        },
        catch: (e) => e,
      }),
    row: (value) => (value === 'none' ? 'no ceiling' : `up to ${dollarsText(Number(value))} a day`),
  }

  const claudeToken: SetupQuestion<RunContext> = {
    id: 'claude-token',
    card: { label: 'claude token', environment: 'LINGTAI_CLAUDE_OAUTH_TOKEN' },
    name: 'the sandboxed Claude Code token',
    flag: '--claude-token keep, or --claude-token skip',
    fromFlags: (flags) => {
      const given = flags['claude-token']
      if (given === undefined) return null
      if (given !== 'keep' && given !== 'skip') {
        return { refused: `--claude-token ${given} is not keep or skip — the token itself is never a flag` }
      }
      // `skip` beside a token that is set is `keep`: nothing is written and nothing is said.
      return given
    },
    needed: (ctx) =>
      Effect.gen(function* () {
        const state = ports.tokenState()
        if ('unreadable' in state) {
          // Said once the recipe is final, where the add goes on past it; before that it would be said twice.
          if ((ctx.draft ?? null) !== null) ports.say(`${state.unreadable}. ${CLAUDE_TOKEN_SKIPPED}`)
          return false
        }
        const recipes = yield* ports.recipes()
        const all = ctx.draft == null ? recipes : [...recipes, ctx.draft]
        return all.some((r) => needsClaudeToken(r, { environment: false, file: false, usable: false }))
      }),
    inForce: () =>
      Effect.sync((): InForce => {
        const state = ports.tokenState()
        if ('unreadable' in state || !state.usable) return null
        return { value: 'set', from: state.environment ? 'environment' : 'file' }
      }),
    answerOf: () => 'keep',
    // `skip` beside a token that is set is `keep`: nothing is written either way.
    sameAsEnvironment: (answer) => answer === 'keep' || answer === 'skip',
    systemDefault: () => Effect.succeed('skip'),
    validate: (answer) =>
      Effect.sync(() => {
        const set = (() => {
          const s = ports.tokenState()
          return !('unreadable' in s) && s.usable
        })()
        if (answer === 'keep' && !set)
          return '--claude-token keep, but no token is set — pass --claude-token skip, or run lingtai token claude'
        return answer === 'keep' || answer === 'skip' || answer === 'run'
          ? null
          : `${answer} is not one of keep, run, skip`
      }),
    write: (answer, inForce) =>
      Effect.gen(function* () {
        if (answer === 'keep') return { wrote: false }
        if (answer === 'skip') {
          if (inForce === null) ports.say(CLAUDE_TOKEN_SKIPPED)
          return { wrote: false }
        }
        const token = yield* ports.obtainToken()
        if (token === null) {
          ports.say(CLAUDE_TOKEN_SKIPPED)
          return { wrote: false }
        }
        const saved = yield* setClaudeTokenEffect(ports.machine, ports.path, token, ports.env).pipe(
          Effect.map((done) => ({ done }) as const),
          Effect.catch(
            (refused: { say: string }) => Effect.succeed({ refused }) as Effect.Effect<{ refused: { say: string } }>,
          ),
        )
        if ('refused' in saved) {
          ports.say(`${saved.refused.say}. ${CLAUDE_TOKEN_SKIPPED}`)
          return { wrote: false }
        }
        ports.say(`saved claude.oauth_token in ${ports.path}`)
        if (saved.done.environmentWins) ports.say(environmentWinsSentence("this process's"))
        return { wrote: true }
      }),
    row: (value) => (value === 'run' ? 'set' : value === 'keep' ? 'set' : 'skipped'),
  }

  return [store, github, ceiling, claudeToken]
}

/** Rows from the same machine descriptors and answer records, with no credential snapshots. */
export function machineRows(
  list: readonly SetupQuestion<RunContext>[],
  entries: readonly Entry[],
  descriptions: Readonly<Record<string, string>> = {},
): SetupRow[] {
  return entries
    .filter((e) => e.applies)
    .flatMap((e) => {
      const q = list.find((q) => q.id === e.id)
      const value = e.after ?? e.before?.value
      if (q === undefined || value === undefined) return []
      const before = e.before
      const changed = before !== null && !('fault' in before) && before.value !== value
      const text = q.row(value, null, descriptions[e.id])
      return [
        {
          id: e.id,
          group: 'machine' as const,
          label: q.card?.label ?? e.id,
          changed,
          text:
            (changed ? `${q.row(before!.value!, null)} → ${text}` : text) +
            (before?.from === 'environment' ? ` — from ${before.variable ?? q.card?.environment}` : ''),
        },
      ]
    })
}

/** Observes the machine list without answering or writing any question (the `add` card). */
export function machineSnapshotRows(ports: MachinePorts): Effect.Effect<SetupRow[], unknown> {
  const list = machineQuestions(ports, { githubRequired: false })
  return Effect.gen(function* () {
    const entries: Entry[] = []
    for (const q of list) {
      const before = q.inForce === undefined ? null : yield* q.inForce({})
      entries.push({
        id: q.id,
        before,
        after: before === null && q.id === 'ceiling' ? 'none' : null,
        wrote: false,
        pending: false,
        asked: false,
        applies: true,
      })
    }
    return machineRows(list, entries)
  })
}
