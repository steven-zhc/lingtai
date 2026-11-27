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

// ------------------------------------------------------------ the descriptor --

/** What is in force for one question: the value and whose it is, a fault in it, or nothing. */
export type InForce =
  | { value: string; from: 'environment' | 'file' }
  | {
      /** What is wrong with it, said before asking. */
      fault: string
      from: 'environment' | 'file'
      /** The answer that keeps what is there, where the fault is not the value's own (a database that is down). */
      value?: string
      /** A fault the run cannot repair (an exported variable): refused by name rather than asked. */
      fatal?: boolean
    }
  | null

export interface WriteResult {
  wrote: boolean
  /** The answer needs a step this list does not run (an App that does not exist yet); nothing was written. */
  pending?: true
}

export interface RunContext {
  /** The recipe being set up, once a project path has made it; null before. */
  draft: Recipe | null
}

export interface SetupQuestion {
  id: string
  /** The subject of a refusal — "the daily spend ceiling". */
  name: string
  /** The text after "pass" in a refusal. */
  flag: string
  /** The answer a flag names, null where none does; a refusal where the flag is not one this question takes. */
  fromFlags: (flags: Readonly<Record<string, string>>) => string | null | { refused: string }
  /** What a flag value is compared with what is in force as, and what is written. */
  normalize?: (answer: string) => string
  inForce: Effect.Effect<InForce, unknown>
  /** The default where nothing is in force; null where the question has none (0121 §9). */
  systemDefault: Effect.Effect<string | null, unknown>
  /** The answer that is equal to what is in force, where that is not its value (a token that is set is `keep`). */
  answerOf?: (inForce: NonNullable<InForce>) => string | null
  /** Null accepts; a string is why not. */
  validate: (answer: string) => Effect.Effect<string | null, unknown>
  /** Absent for every question but the token: whether this run applies to it. */
  needed?: (ctx: RunContext) => Effect.Effect<boolean, unknown>
  write: (answer: string, inForce: InForce) => Effect.Effect<WriteResult, unknown>
  /** The card row: the value, and what it was. */
  row: (value: string, before: InForce) => string
  /** Words for `why`, drawn where the question is asked. */
  why?: readonly string[]
  /** What the environment's value is shown as. */
  show?: (value: string) => string
}

/** What an asker is handed: the question, the default already decided, and what is kept if it is abandoned. */
export interface Decided {
  question: SetupQuestion
  default: string | null
  inForce: InForce
  /** True where `default` is a value in force, false where it is the system's. */
  kept: string
  startOver?: string
  why: readonly string[]
}

export type AskerAnswer = { answer: string } | { refused: string }
export type Asker = (decided: Decided) => Effect.Effect<AskerAnswer, unknown>

export interface SetupInput {
  /** False where there is no terminal. Never inferred from an asker answering nothing. */
  interactive: boolean
  /** `--defaults`. */
  defaults: boolean
  flags: Readonly<Record<string, string>>
  askers: Readonly<Record<string, Asker>>
  /** Said by the runner: a fault in what is in force, before it asks again. */
  log: (line: string) => void
  /** What is still true if the next question is abandoned, given what this run has written. */
  kept?: (written: readonly Entry[]) => { kept: string; startOver?: string }
}

export interface Entry {
  id: string
  before: InForce
  /** The answer, or null where an environment value decided and nothing was asked. */
  after: string | null
  wrote: boolean
  pending: boolean
  asked: boolean
}

export type ListResult =
  | { refused: string; entries: Entry[]; deferred: SetupQuestion[] }
  | { refused?: undefined; entries: Entry[]; deferred: SetupQuestion[] }

const normalized = (q: SetupQuestion, answer: string): string =>
  q.normalize === undefined ? answer : q.normalize(answer)

const defaultKept = (written: readonly Entry[]): { kept: string; startOver?: string } => ({
  kept:
    written.filter((e) => e.wrote).length === 0
      ? 'Nothing was written'
      : `what was answered above is kept (${written
          .filter((e) => e.wrote)
          .map((e) => e.id)
          .join(', ')})`,
})

/**
 * Walks `list` in order. A question whose `needed` says no is not asked and not skipped: it is returned in
 * `deferred`, for the project path to run once its recipe is final (`runSetupList(result.deferred, …, { draft })`).
 * A refusal stops the walk; what was already written stays, and `entries` says so.
 */
export function runSetupList(
  list: readonly SetupQuestion[],
  input: SetupInput,
  ctx: RunContext = { draft: null },
): Effect.Effect<ListResult, unknown> {
  return Effect.gen(function* () {
    const entries: Entry[] = []
    const deferred: SetupQuestion[] = []
    const refuse = (refused: string): ListResult => ({ refused, entries, deferred })

    for (const q of list) {
      if (q.needed !== undefined && !(yield* q.needed(ctx))) {
        deferred.push(q)
        continue
      }
      const inForce = yield* q.inForce

      // The environment decides: not asked, not written; a flag that differs is refused by name.
      const flag = q.fromFlags(input.flags)
      if (flag !== null && typeof flag === 'object') return refuse(flag.refused)
      // A fault the run cannot repair (an exported variable, an App that does not answer) is refused by name.
      if (inForce !== null && 'fault' in inForce && inForce.fatal === true) return refuse(inForce.fault)
      if (inForce !== null && inForce.from === 'environment') {
        if ('fault' in inForce) return refuse(`${q.name}: ${inForce.fault}`)
        if (flag !== null && normalized(q, flag) !== normalized(q, inForce.value)) {
          return refuse(
            `${q.flag.split(',')[0]} ${flag}, but the environment names ${q.show?.(inForce.value) ?? inForce.value} ` +
              `for ${q.name}, and an exported value wins over the file. Unset it, or leave out the flag. Nothing was written`,
          )
        }
        entries.push({ id: q.id, before: inForce, after: null, wrote: false, pending: false, asked: false })
        continue
      }

      if (inForce !== null && 'fault' in inForce) input.log(inForce.fault)

      const system = yield* q.systemDefault
      const inForceAnswer =
        inForce === null
          ? null
          : 'fault' in inForce
            ? (inForce.value ?? null)
            : (q.answerOf?.(inForce) ?? inForce.value)
      const fallback = inForceAnswer ?? system

      const written = entries.filter((e) => e.wrote)
      const keptSaid = (input.kept ?? defaultKept)(written)
      let answer: string
      let asked = false
      if (flag !== null) {
        answer = normalized(q, flag)
        const why = yield* q.validate(answer)
        if (why !== null) return refuse(why)
      } else if (input.defaults || !input.interactive) {
        if (fallback === null) {
          return refuse(`${q.name} needs an answer: pass ${q.flag}. ${keptSaid.kept}`)
        }
        answer = fallback
        const why = yield* q.validate(answer)
        if (why !== null) return refuse(why)
      } else {
        const asker = input.askers[q.id]
        if (asker === undefined) return refuse(`${q.name} has no asker here. ${keptSaid.kept}`)
        const got = yield* asker({
          question: q,
          default: fallback,
          inForce,
          kept: keptSaid.kept,
          ...(keptSaid.startOver === undefined ? {} : { startOver: keptSaid.startOver }),
          why: q.why ?? [],
        })
        if ('refused' in got) return refuse(got.refused)
        answer = normalized(q, got.answer)
        asked = true
      }

      const done = yield* q.write(answer, inForce)
      entries.push({
        id: q.id,
        before: inForce,
        after: answer,
        wrote: done.wrote,
        pending: done.pending === true,
        asked,
      })
    }
    return { entries, deferred }
  })
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
  | { store: 'sqlite' }
  | { store: 'postgres'; url: string; environment: boolean }

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
export function machineQuestions(ports: MachinePorts, opts: { githubRequired: boolean }): readonly SetupQuestion[] {
  const store: SetupQuestion = {
    id: 'store',
    name: 'the store',
    flag: '--store sqlite, or --store postgres --database-url <url>',
    fromFlags: (flags) => {
      const url = flags['database-url']
      if (url !== undefined) return url
      return flags['store'] === 'sqlite' ? '' : null
    },
    normalize: (a) => (a === 'sqlite' ? '' : a),
    inForce: Effect.gen(function* () {
      const read = ports.store()
      if (read.store === null) return read.fault === undefined ? null : ({ fault: read.fault, from: 'file' } as const)
      if (read.store === 'sqlite') return { value: '', from: 'file' } as const
      const check = yield* ports.database(read.url)
      const from = read.environment ? ('environment' as const) : ('file' as const)
      if (check.ok) return { value: read.url, from } as const
      return {
        fault: `the database ${read.environment ? 'the environment' : 'config.yml'} names does not answer — ${check.why}`,
        from,
        value: read.url,
        ...(read.environment ? { fatal: true } : {}),
      } as const
    }),
    systemDefault: Effect.succeed(''),
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
    row: (value) => (value === '' ? 'SQLite' : 'Postgres'),
  }

  const github: SetupQuestion = {
    id: 'github',
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
    inForce: Effect.gen(function* () {
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
    systemDefault: Effect.gen(function* () {
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
    row: (value) => (value === 'none' ? 'no GitHub' : value),
  }

  const ceiling: SetupQuestion = {
    id: 'ceiling',
    name: 'the daily spend ceiling',
    flag: '--day-usd <dollars>, or --day-usd none',
    fromFlags: (flags) => flags['day-usd'] ?? null,
    normalize: (a) => {
      const parsed = parseCeiling(a)
      return 'bad' in parsed ? a : parsed.dollars === null ? 'none' : String(parsed.dollars)
    },
    inForce: Effect.sync((): InForce => {
      const read = ports.dayCeiling()
      const from = read.environment ? ('environment' as const) : ('file' as const)
      if ('fault' in read) return { fault: read.fault, from, ...(read.environment ? { fatal: true } : {}) }
      return read.value === null ? null : { value: String(read.value), from }
    }),
    systemDefault: Effect.succeed('100'),
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
          const now = inForce !== null && !('fault' in inForce) ? Number(inForce.value) : null
          if (parsed.dollars === now) return { wrote: false }
          writeDayCeiling(ports.machine, ports.path, parsed.dollars)
          return { wrote: true }
        },
        catch: (e) => e,
      }),
    row: (value, before) =>
      value === 'none'
        ? 'no ceiling'
        : before !== null && !('fault' in before) && before.value !== value
          ? `${dollarsText(Number(value))} a day (was ${dollarsText(Number(before.value))})`
          : `${dollarsText(Number(value))} a day`,
  }

  const claudeToken: SetupQuestion = {
    id: 'claude-token',
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
          if (ctx.draft !== null) ports.say(`${state.unreadable}. ${CLAUDE_TOKEN_SKIPPED}`)
          return false
        }
        const recipes = yield* ports.recipes()
        const all = ctx.draft === null ? recipes : [...recipes, ctx.draft]
        return all.some((r) => needsClaudeToken(r, { environment: false, file: false, usable: false }))
      }),
    inForce: Effect.sync((): InForce => {
      const state = ports.tokenState()
      if ('unreadable' in state || !state.usable) return null
      return { value: 'set', from: state.environment ? 'environment' : 'file' }
    }),
    answerOf: () => 'keep',
    systemDefault: Effect.succeed('skip'),
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
