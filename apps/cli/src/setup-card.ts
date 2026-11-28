/**
 * The summary card `init` and `add` end on (0121 §1), as a pure function of
 * facts. It reads no file and runs no doctor: everything arrives on `facts`.
 * `setup-end.ts` prints it.
 */
import { paint } from '@lingtai/env/colour'
import {
  type Recipe,
  assigneeOf,
  ceilingOf,
  branchOf,
  isBuiltInJudge,
  kindsOf,
  modeOf,
  remoteOf,
  ticketSourceOf,
} from '@lingtai/recipe'
import type { RuntimeFound, SetupRow } from '@lingtai/setup'

import type { DoctorReport } from './doctor.ts'
import type { IssueTakes } from './next-steps.ts'
import { heading, symbol, width } from './output.ts'
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
  /** The `judge:` declared for `findings` and how many times findings go back to it, from the recipe as written; `null` where none is declared. */
  findingsJudge: { judge: string; rounds: number } | null
  /** Set only for a team project, read from the recipe as written: who it takes issues for, and the branch it works on. */
  team?: { login: string | null; personal: string }
  /** Who the queue takes issues for, whatever the mode: what the first-ticket step assigns. */
  takes: IssueTakes
}

/** The rule `assigneeSkip` applies (`discover.ts`): team mode is always `mine`, solo is the recipe's `take`. */
export function issueTakeOf(recipe: Recipe): IssueTakes {
  const rule = assigneeOf(recipe)
  return { take: modeOf(recipe) === 'team' ? 'mine' : (rule?.take ?? 'all'), login: rule?.login ?? null }
}

export interface SetupCardFacts {
  command: 'init' | 'add'
  /** Absent where there is no project yet (`init --project github`). */
  project?: string
  /** The project was already registered. */
  updated: boolean
  home: string
  /** This run created `config.yml`. */
  homeIsNew: boolean
  /** For the `~` substitution — passed in, so a test never depends on the real `$HOME`. */
  userHome: string
  runtimes: readonly RuntimeFound[]
  machine: readonly SetupRow[]
  rows?: readonly SetupRow[]
  next?: string
  /** The labels the queue reads, made at `add` (#1486); absent on `init`, whose card is unchanged. */
  labels?: {
    slug: string
    created: readonly string[]
    missing: readonly { name: string; why: 'denied' | 'unchecked' }[]
  }
  trial?: TrialOutcome
  recipePath?: string
  /**
   * What a change in this run left where it was, and what the person does about it (#1474): each is a sentence
   * and, where there is one, the command. A change never touches the person's commits to make itself fit.
   */
  leftBehind?: readonly LeftBehind[]
}

export interface LeftBehind {
  what: string
  command?: string
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

function findingsJudgeOf(
  proposed: readonly Record<string, unknown>[] | undefined,
  rounds: number,
): { judge: string; rounds: number } | null {
  const entry = (proposed ?? []).find(
    (a) => a['when'] === 'findings' && typeof a['judge'] === 'string' && !isBuiltInJudge(a['judge']),
  )
  return entry === undefined ? null : { judge: String(entry['judge']), rounds }
}

/** A recipe already resolved, read the way `summariseRecipe` reads it. */
export function cardRecipe(recipe: Recipe, code: string): CardRecipe {
  const steps = recipe.steps as unknown as Record<string, readonly Record<string, unknown>[] | undefined>
  return {
    code,
    base: branchOf(recipe),
    remote: remoteOf(recipe),
    tickets: ticketSourceOf(recipe),
    kinds: kindsOf(recipe),
    takes: issueTakeOf(recipe),
    writer: agentOf(steps['implement']),
    reviewer: agentOf(steps['review']),
    checks: (steps['build'] ?? []).filter((a) => typeof a['run'] === 'string').map((a) => String(a['run'])),
    findingsJudge: findingsJudgeOf(steps['proposed'], ceilingOf(recipe).attempt.refusalFixes),
    approves: (steps['proposed'] ?? []).some((a) => 'human' in a),
    ...(modeOf(recipe) === 'team'
      ? { team: { login: assigneeOf(recipe)?.login ?? null, personal: branchOf(recipe) } }
      : {}),
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

function agentsRow(runtimes: readonly RuntimeFound[]): string {
  const mark = (r: RuntimeFound): string =>
    r.state === 'signed-in' ? symbol.pass() : r.state === 'did-not-start' ? '?' : symbol.fail()
  return runtimes.map((r) => `${r.id} ${mark(r)}`).join('  ')
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

/** A word safe to paste into a shell: bare when it needs no quoting, else single-quoted. */
function shellQuote(word: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

/** The card: a heading, three groups a blank line apart, one fact a row. No closing line — that is `renderReadyLine`. */
export function renderSetupCard(facts: SetupCardFacts): string {
  const { trial, userHome } = facts
  const home = `${tilde(facts.home, userHome)}${facts.homeIsNew ? '  new' : ''}`
  const groups: { title: string; rows: Row[] }[] = [
    {
      title: 'this machine',
      rows: [
        ['home', home],
        ['agents', agentsRow(facts.runtimes)],
        ...facts.machine.map((r): Row => [r.label, r.text]),
      ],
    },
  ]
  if (facts.rows !== undefined && trial !== undefined) {
    groups.push(
      { title: 'this project', rows: facts.rows.filter((r) => r.group === 'project').map((r) => [r.label, r.text]) },
      {
        title: 'each attempt',
        rows: [
          ...facts.rows.filter((r) => r.group === 'attempt').map((r): Row => [r.label, r.text]),
          ['trial', trialRow(trial)],
          ...(facts.next === undefined ? [] : [['next', facts.next] as const]),
        ],
      },
    )
  }
  const labels = facts.labels
  if (labels !== undefined && facts.rows !== undefined && trial !== undefined) {
    const rows: Row[] = []
    if (labels.created.length > 0) rows.push(['labels', `made ${labels.created.join(', ')}`])
    for (const m of labels.missing) {
      rows.push([
        'labels',
        `${m.name} could not be ${m.why === 'denied' ? 'made' : 'checked'} — gh label create ${shellQuote(m.name)} --repo ${shellQuote(labels.slug)}`,
      ])
    }
    if (rows.length > 0) groups[1]!.rows.push(...rows)
  }
  if (facts.leftBehind !== undefined && facts.leftBehind.length > 0) {
    const rows: Row[] = facts.leftBehind.flatMap((l): Row[] => [
      ['left', l.what],
      ...(l.command === undefined ? [] : [['run', l.command] as const]),
    ])
    groups.splice(Math.min(2, groups.length), 0, { title: 'left behind', rows })
  }
  const column = Math.max(...groups.flatMap((g) => g.rows.map(([label]) => width(label)))) + 2
  const unchanged = facts.updated && ![...facts.machine, ...(facts.rows ?? [])].some((r) => r.changed)
  const firstTeam =
    !facts.updated && facts.rows?.some((r) => r.id === 'mode' && r.text === 'team') && facts.project !== undefined
  const top = firstTeam
    ? `${symbol.pass()} ${facts.project} added — team`
    : `${heading(facts.command)}${facts.project === undefined ? '' : `  ${facts.project}`}${unchanged ? `  ${paint.muted('unchanged')}` : ''}`
  const body = groups.map((g) => [
    g.title,
    ...g.rows.map(([label, value]) => `  ${paint.muted(label)}${' '.repeat(column - width(label))}${value}`),
  ])
  return [top, ...body.flatMap((lines) => ['', ...lines])].join('\n')
}

/** The line the card closes on: ready, ready with things to fix, or not ready — never `✓ ready` for a failure or a doctor that threw. */
export function renderReadyLine(input: ReadyInput, recipePath?: string): string {
  const tail = recipePath === undefined ? null : `recipe: ${recipePath}`
  const end = tail === null ? '' : ` · ${tail}`
  if ('threw' in input) return `${symbol.fail()} not ready — doctor did not finish (${input.threw})${end}`
  const { count, failed } = input.toFix
  if (failed) return `${symbol.fail()} not ready${end}`
  if (count > 0) return `${symbol.pass()} ready · ${count} to fix${end}`
  const { notChecked, deferred } = input.report
  return `${symbol.pass()} ready — doctor: all ${input.report.ok} passed · ${notChecked} not checked here · ${deferred} not implemented yet${end}`
}
