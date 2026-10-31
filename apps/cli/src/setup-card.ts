/**
 * The summary card `init` and `add` end on (0121 §1), as a pure function of
 * facts. It reads no file and runs no doctor: everything arrives on `facts`.
 * `setup-end.ts` prints it.
 */
import { basename } from 'node:path'

import { type StoreChoice, redactUrl } from '@lingtai/env'
import { paint } from '@lingtai/env/colour'
import { type Recipe, baseOf, kindsOf, remoteOf, ticketSourceOf } from '@lingtai/recipe'

import type { DoctorReport } from './doctor.ts'
import { heading, symbol, width } from './output.ts'
import type { RuntimeFound } from './runtimes.ts'
import type { TrialOutcome } from './setup-build.ts'

interface CardAgent {
  agent: string
  model: string | null
}

/** The half of the card the recipe answers, read back from the recipe as written. */
export interface CardRecipe {
  /** The checkout's top level. */
  code: string
  base: string
  remote: string | null
  tickets: 'db' | 'github'
  kinds: readonly string[]
  writer: CardAgent | null
  reviewer: CardAgent | null
  checks: readonly string[]
  approves: boolean
}

export interface SetupCardFacts {
  command: 'init' | 'add'
  project: string
  /** The project was already registered. */
  updated: boolean
  home: string
  /** This run created `config.yml`. */
  homeIsNew: boolean
  /** For the `~` substitution — passed in, so a test never depends on the real `$HOME`. */
  userHome: string
  store: StoreChoice
  runtimes: readonly RuntimeFound[]
  recipe: CardRecipe
  trial: TrialOutcome
  recipePath: string
}

/**
 * Types only from `doctor.ts`: `init.ts` must never reach it statically (an eager log read breaks a fresh machine).
 * `toFix` is `toFixSummary(report)`, taken by whoever has the real report.
 */
export type ReadyInput =
  | { report: Pick<DoctorReport, 'ok' | 'notChecked' | 'deferred'>; toFix: { count: number; failed: boolean } }
  | { threw: string }

function agentOf(actions: readonly Record<string, unknown>[] | undefined): CardAgent | null {
  const action = (actions ?? []).find((a) => typeof a['agent'] === 'string')
  if (action === undefined) return null
  const model = action['model']
  return { agent: String(action['agent']), model: typeof model === 'string' && model !== '' ? model : null }
}

/** A recipe already resolved, read the way `summariseRecipe` reads it. */
export function cardRecipe(recipe: Recipe, code: string): CardRecipe {
  const steps = recipe.steps as unknown as Record<string, readonly Record<string, unknown>[] | undefined>
  return {
    code,
    base: baseOf(recipe),
    remote: remoteOf(recipe),
    tickets: ticketSourceOf(recipe),
    kinds: kindsOf(recipe),
    writer: agentOf(steps['implement']),
    reviewer: agentOf(steps['review']),
    checks: (steps['build'] ?? []).filter((a) => typeof a['run'] === 'string').map((a) => String(a['run'])),
    approves: (steps['proposed'] ?? []).some((a) => 'human' in a),
  }
}

/** `41s`, `2m 05s`, and `<1s` rather than `0s`. */
export function formatTrialTime(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 1) return '<1s'
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

function tilde(path: string, userHome: string): string {
  if (userHome === '' || userHome === '/') return path
  if (path === userHome) return '~'
  return path.startsWith(`${userHome}/`) ? `~${path.slice(userHome.length)}` : path
}

function logRow(store: StoreChoice): string {
  if ('refused' in store) return paint.fail(store.refused)
  if (store.store === 'sqlite') return `SQLite · ${basename(store.path)}`
  try {
    return `Postgres · ${new URL(store.url).hostname}`
  } catch {
    return 'Postgres · (a URL that does not parse)'
  }
}

function agentsRow(runtimes: readonly RuntimeFound[]): string {
  const mark = (r: RuntimeFound): string =>
    r.state === 'signed-in' ? symbol.pass() : r.state === 'did-not-start' ? '?' : symbol.fail()
  return runtimes.map((r) => `${r.id} ${mark(r)}`).join('  ')
}

/** `git@host:o/r` — user without a password, then `host:path`; the only non-URL remote printed as written. */
const SCP_REMOTE = /^[^:@/\s]+@[^:/\s]+:(?!\/\/)\S*$/

function landsOnRow(recipe: CardRecipe, userHome: string): string {
  if (recipe.remote === null) return recipe.base
  const remote = recipe.remote
  // A remote that does not parse as a URL is printed only when it is plainly a path or scp-style;
  // anything else could carry `user:password@`, and redaction cannot vouch for it.
  const where = remote.startsWith('/')
    ? tilde(remote, userHome)
    : SCP_REMOTE.test(remote) || (!remote.includes('@') && !remote.includes('://'))
      ? remote
      : redactUrl(remote)
  return `${recipe.base}, in ${where}`
}

function agentRow(a: CardAgent | null): string {
  return a === null ? 'none' : a.model === null ? a.agent : `${a.agent}, ${a.model}`
}

function trialRow(trial: TrialOutcome): string {
  switch (trial.trial) {
    case 'passed':
      return `${symbol.pass()} ${formatTrialTime(trial.ms)}`
    case 'failed-kept':
      return `${symbol.fail()} ${trial.command} — kept as written`
    case 'not-run':
      return `not run — ${
        trial.because === 'declined'
          ? 'declined'
          : trial.because === 'no checks'
            ? 'no checks'
            : 'no checkout on this machine'
      }`
  }
}

type Row = readonly [label: string, value: string]

/** The card: a heading, three groups a blank line apart, one fact a row. No closing line — that is `renderReadyLine`. */
export function renderSetupCard(facts: SetupCardFacts): string {
  const { recipe, userHome } = facts
  const home = `${tilde(facts.home, userHome)}${facts.homeIsNew ? '  new' : ''}`
  const groups: { title: string; rows: Row[] }[] = [
    {
      title: 'this machine',
      rows: [
        ['home', home],
        ['log', logRow(facts.store)],
        ['agents', agentsRow(facts.runtimes)],
      ],
    },
    {
      title: 'this project',
      rows: [
        ['code', `${tilde(recipe.code, userHome)}  local`],
        ['lands on', landsOnRow(recipe, userHome)],
        ['tickets', `${recipe.tickets === 'db' ? 'Lingtai’s table' : 'GitHub issues'} · ${recipe.kinds.join(' › ')}`],
      ],
    },
    {
      title: 'each pass',
      rows: [
        ['writes', agentRow(recipe.writer)],
        ['reviews', agentRow(recipe.reviewer)],
        ['checks', recipe.checks.length > 0 ? recipe.checks.join(' · ') : 'none — nothing checks a diff before review'],
        ['trial', trialRow(facts.trial)],
        ['approve', recipe.approves ? 'you approve every pass before it lands' : 'a pass lands with no one asking'],
      ],
    },
  ]
  const column = Math.max(...groups.flatMap((g) => g.rows.map(([label]) => width(label)))) + 2
  const top = `${heading(facts.command)}  ${facts.project}${facts.updated ? `  ${paint.muted('updated')}` : ''}`
  const body = groups.map((g) => [
    g.title,
    ...g.rows.map(([label, value]) => `  ${paint.muted(label)}${' '.repeat(column - width(label))}${value}`),
  ])
  return [top, ...body.flatMap((lines) => ['', ...lines])].join('\n')
}

/** The line the card closes on: ready, ready with things to fix, or not ready — never `✓ ready` for a failure or a doctor that threw. */
export function renderReadyLine(input: ReadyInput, recipePath: string): string {
  const tail = `recipe: ${recipePath}`
  if ('threw' in input) return `${symbol.fail()} not ready — doctor did not finish (${input.threw}) · ${tail}`
  const { count, failed } = input.toFix
  if (failed) return `${symbol.fail()} not ready · ${tail}`
  if (count > 0) return `${symbol.pass()} ready · ${count} to fix · ${tail}`
  const { notChecked, deferred } = input.report
  return `${symbol.pass()} ready — doctor: all ${input.report.ok} passed · ${notChecked} not checked here · ${deferred} not implemented yet · ${tail}`
}
