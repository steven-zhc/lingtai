/**
 * The project list (ADR 0125 §9, `doc/design/1523.md` §4, `doc/design/1529.md` §2–§5, #1531): the 25 questions
 * `lingtai add` and `init` ask about one project, as descriptors on #1527's runner. Each says what is in force, what
 * the system's default is, when it applies, what it writes and what it records for the entries after it. A terminal or
 * a board supplies an asker per id (#1529); no command walks the list yet (#1525, #1526).
 *
 * **Nothing here applies a change.** Every `write` appends to `ctx.pending`, and the list's caller applies it once, at
 * its own end, so a refusal or a Ctrl+C anywhere in the walk leaves the recipe as it was. Reads of what the answers
 * so far would make go through `ctx.view`, which reads `ctx.pending` live: **`pending` is only ever pushed onto, never
 * reassigned**, or every later read goes blind to what was pushed. What is in force is read from `ctx.start`, the
 * recipe as the run began; the entries after the first never read it through the view, where an earlier answer has
 * already replaced it.
 *
 * **An answer equal to what is in force appends nothing**, so a rerun that takes every default has an empty
 * `pending`. On a first run nothing is in force, every system default is written, and the caller's seeds are
 * `pending`'s first entries.
 */
import { everyRuntime } from '@lingtai/agent'
import { RuntimeId } from '@lingtai/domain'
import { keyIn, projectView, type ProjectView, type RecipeDraft } from '@lingtai/project'
import {
  assigneeChanges,
  branchOf,
  budgetChange,
  ceilingOf,
  conflictResolutionsChange,
  followedJudgeIndex,
  followWriterJudgeChanges,
  holdRemovalChanges,
  kindsChanges,
  kindsOf,
  isBuiltInJudge,
  landingChanges,
  landOnBranchChanges,
  refusalFixesChange,
  SETUP_KINDS,
  ticketsChange,
  unboundedTurnsChange,
  wallChange,
  type RecipeChange,
  type ResolvedRecipe,
} from '@lingtai/recipe'
import { Effect } from 'effect'

import { type SetupReader, detectSetupEffect, type DetectedSetup } from './detect-setup.ts'
import { defaultPersonalBranch } from './personal-branch.ts'
import { portCause } from './port-cause.ts'
import {
  branchOnGithubRefusal,
  installRefusal,
  landingBranchRefusal,
  leftoverRefusal,
  loginRefusal,
  noRuntimesSignedInRefusal,
  parseBudget,
  personalBranchRefusal,
  ROUNDS_RETIRED,
  runtimeRefusal,
  sourceClashRefusal,
  wallRefusal,
  whyMissing,
  wholeNumberRefusal,
  DIFFERENT_SOURCE_CLASH,
} from './project-checks.ts'
import { defaultAgents, DEFAULT_LIMITS, offeredRuntimes, type Proposal } from './propose-setup.ts'
import type { RuntimeFound, RuntimeName } from './runtimes.ts'
import { hostsRefusal, parseHosts, SANDBOX_OFF_LINE, sandboxCannotSentence } from './sandbox-step.ts'
import { LINGTAI_BASE, parseKinds, sandboxChanges } from './setup-answers.ts'
import {
  mergeRunActions,
  namedFromTyped,
  NO_CHECKOUT_LINE,
  isRunAction,
  resolvedRunActions,
  type NamedRun,
} from './setup-build-actions.ts'
import type { InForce, SetupQuestion, WriteResult, Presentation, SetupRow } from './setup-list.ts'
import { summariseRecipe } from './summary.ts'
import { ticketSourceOf, type TicketSourceName } from './ticket-source.ts'

// ---------------------------------------------------------------------------------------------------------------
// The ids and their flags

/** The 25 entries, in the order the list asks them (design §4, with its item 21 as four). */
export const PROJECT_QUESTION_IDS = [
  'where',
  'mode',
  'login',
  'branch',
  'make-branch',
  'move-landing',
  'defaults',
  'writer',
  'writer-model',
  'reviewer',
  'reviewer-model',
  'sandbox',
  'sandbox-hosts',
  'install',
  'checks',
  'trial',
  'tickets',
  'kinds',
  'landing',
  'findings-judge',
  'refusal-fixes',
  'conflict-resolutions',
  'wall',
  'budget',
  'register',
] as const

export type ProjectQuestionId = (typeof PROJECT_QUESTION_IDS)[number]

/**
 * The flag keys each entry reads. A `Record`, so an id with no row fails `tsc`. `base` belongs to no entry: every
 * caller refuses it before the list runs. `defaults` is listed and read by nothing here: the walk's caller turns it
 * into `input.defaults`, and the runner answers the switch from that.
 */
const FLAGS_OF: Record<ProjectQuestionId, readonly string[]> = {
  where: [],
  mode: ['mode'],
  login: ['login'],
  branch: ['main', 'personal'],
  'make-branch': [],
  'move-landing': [],
  defaults: ['defaults'],
  writer: ['agent'],
  'writer-model': ['model'],
  reviewer: ['reviewer'],
  'reviewer-model': ['reviewer-model'],
  sandbox: ['sandbox'],
  'sandbox-hosts': ['sandbox-hosts'],
  install: ['install'],
  checks: ['build'],
  trial: ['check-build'],
  tickets: ['tickets'],
  kinds: ['kinds'],
  landing: ['land'],
  'findings-judge': [],
  'refusal-fixes': ['refusal-fixes', 'rounds'],
  'conflict-resolutions': ['conflict-resolutions'],
  wall: ['wall'],
  budget: ['budget'],
  register: [],
}

/** Every project flag key, from the entries' own `flags`; there when the module loads, with no ports. */
export const PROJECT_FLAGS: readonly string[] = PROJECT_QUESTION_IDS.flatMap((id) => FLAGS_OF[id])

// ---------------------------------------------------------------------------------------------------------------
// The context and the ports

export type Mode = 'team' | 'solo'

/** How the trial build went, for the card. `apps/cli`'s trial loop imports this one union. */
export type TrialOutcome =
  | { trial: 'passed'; ms: number }
  | { trial: 'failed-kept'; command: string; ms: number }
  | { trial: 'not-run'; because: 'declined' | 'no checkout' | 'no checks' }

/** What the trial port is given, and what it hands back. Its live body is `apps/cli`'s `liveTrialPort`. */
export interface ProjectTrialAt {
  /** The recipe as the answers so far would make it: `get` for what is written, `resolved` for what it would run. */
  view: ProjectView
  install: string | null
  checks: NamedRun[]
  given: { install: string | null; build: string[] | null; check: 'yes' | 'no' | null }
  /** The branch still to be made, once the person said yes: the trial cuts from `from`, which is where it is cut from. */
  make: { name: string; from: string } | null
  /** Whether the recipe file existed when the run began: *this list is not written yet* against *nothing is*. */
  recipeExisted: boolean
  kept: string
}

/** Every port is an Effect, so a test fakes each with `Effect.succeed` and nothing here runs a promise. */
export interface ProjectPorts {
  /** The project's name: the log's streams are `ticket-<project>-*`. */
  project: string
  /** A local directory has no owner: `where` is fixed to it, and no ticket is read from GitHub. */
  local: boolean
  /** The checkout this run is in, for *move the landing?*; null where there is none (GitHub). */
  checkout: string | null
  /** The login this machine's `gh` is signed in as; null is *ask*. */
  knownLogin: string | null
  hostname: string
  /** GitHub's default branch, or the checked-out one locally; null where there is none. A failure refuses with its words. */
  defaultBranch: Effect.Effect<string | null, unknown>
  /** Whether the exact ref exists; `'unreadable'` is the read failing, never *absent*. */
  branchExists: (name: string) => Effect.Effect<boolean | 'unreadable'>
  /**
   * The repository cannot be read from here yet: the machine reaches GitHub through an App that is created after the
   * list. A main the list was told is then not looked up — it stands as named, and the App's own reads check it — rather
   * than refusing the run before the App can be made.
   */
  notReadableYet?: boolean
  /** The commits (`<sha> <subject>`) `head` has that `base` does not; null where they could not be read. */
  commitsOnlyIn: (base: string, head: string) => Effect.Effect<string[] | null>
  reader: SetupReader
  /** Probed runtimes. Read in more than one entry; making it cheap is the caller's. */
  runtimes: Effect.Effect<readonly RuntimeFound[], unknown>
  /** `ticket-<project>-*` streams already in the log. */
  history: (project: string) => Effect.Effect<readonly string[], unknown>
  /** What `proposeSetup` read; absent, the sandbox is not asked and detection is read here. */
  proposal?: Proposal
  /** Whether a new recipe may name Codex as its discuss agent (#1476); a failure reads as false. */
  codexText: Effect.Effect<boolean, unknown>
  onPath: (tool: string) => Effect.Effect<boolean, unknown>
  /** The trial run; absent where there is no checkout to cut, and `checks` then says so. */
  trial?: (
    at: ProjectTrialAt,
  ) => Effect.Effect<{ install: string | null; checks: NamedRun[]; trial: TrialOutcome } | { refused: string }, unknown>
}

/** What later entries read of earlier answers. Unset means *not answered in this run*, never a value. */
export interface ProjectAnswers {
  mode?: Mode
  login?: string
  /** `name` is the working branch (the base in solo); `from` is what a missing one is cut from. */
  branch?: { name: string; exists: boolean; from: string | null; onlyIn: string[] | null; main: string | null }
  /** The branch to make, once the person said yes. */
  make?: { name: string; from: string }
  defaults?: 'yes' | 'no'
  /** The log's tickets for this project, read once at the first entry. */
  history?: readonly string[]
  writer?: string
  reviewer?: string
  sandbox?: 'on' | 'off'
  install?: string | null
  checks?: string[]
  trial?: TrialOutcome
  tickets?: TicketSourceName
}

export interface ProjectContext {
  /** The recipe as the run began; never applied. */
  start: RecipeDraft
  /** Every `--build`, in order: `flags['build']` is only the last. */
  buildFlags: readonly string[]
  /** The changes the answers make. Pushed onto, never reassigned. */
  pending: RecipeChange[]
  view: ProjectView
  answers: ProjectAnswers
  ports: ProjectPorts
  flags: Readonly<Record<string, string>>
  /** What a refusal says is already true. */
  kept: string
  /** Lines that print whether or not there is a terminal. */
  log: string[]
}

/** The one place `pending` and the view are made over the same array. */
export function projectContext(at: {
  start: RecipeDraft
  buildFlags: readonly string[]
  flags: Readonly<Record<string, string>>
  ports: ProjectPorts
  kept: string
  seeds: readonly RecipeChange[]
}): ProjectContext {
  const pending: RecipeChange[] = [...at.seeds]
  return {
    start: at.start,
    buildFlags: at.buildFlags,
    pending,
    view: projectView(at.start, pending),
    answers: {},
    ports: at.ports,
    flags: at.flags,
    kept: at.kept,
    log: [],
  }
}

export type ProjectQuestion = SetupQuestion<ProjectContext> & { id: ProjectQuestionId; flags: readonly string[] }

// ---------------------------------------------------------------------------------------------------------------
// Reads

const rerun = (ctx: ProjectContext): boolean => ctx.start.text() !== null
/** One key of the recipe as the run began. */
const atStart = (ctx: ProjectContext, path: readonly (string | number)[]): unknown => keyIn(ctx.start.text(), path)
const startResolved = (ctx: ProjectContext): ResolvedRecipe | null =>
  rerun(ctx) ? projectView(ctx.start, []).resolved() : null

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const valueOf = (i: InForce): string | null => (i === null ? null : (i.value ?? null))

const inForceOf = (value: string | null): Effect.Effect<InForce> =>
  Effect.succeed(value === null ? null : { value, from: 'file' })

/**
 * A change inside a value an earlier pending change wrote whole (an array or a map) is folded into that whole. The
 * overlay holds a value it was handed as plain data, and `setIn` cannot go through plain data: the view would turn
 * blind to the key, and so would the one write at the end.
 */
function foldIntoWhole(ctx: ProjectContext, change: RecipeChange): RecipeChange {
  for (let n = change.path.length - 1; n >= 1; n--) {
    const prefix = change.path.slice(0, n)
    const whole = ctx.pending.findLast(
      (c) =>
        c.path.length === n &&
        c.path.every((p, i) => p === prefix[i]) &&
        typeof c.value === 'object' &&
        c.value !== null,
    )
    if (whole === undefined) continue
    const next: unknown = JSON.parse(JSON.stringify(ctx.view.get(prefix)))
    let at = next as Record<string | number, unknown>
    for (const key of change.path.slice(n, -1)) at = (at[key] ??= {}) as Record<string | number, unknown>
    const last = change.path[change.path.length - 1]!
    if (change.value === undefined) {
      if (Array.isArray(at)) at.splice(Number(last), 1)
      else delete at[last]
    } else at[last] = change.value
    return { path: prefix, value: next }
  }
  return change
}

const append = (ctx: ProjectContext, changes: readonly RecipeChange[]): WriteResult => {
  for (const change of changes) ctx.pending.push(foldIntoWhole(ctx, change))
  return { wrote: changes.length > 0 }
}
const nothing = (): Effect.Effect<WriteResult> => Effect.succeed({ wrote: false })

const rowOf = (value: string, before: InForce): string =>
  before !== null && !('fault' in before) && before.value !== value ? `${value} (was ${before.value})` : value

function asRuntime(value: unknown): RuntimeName | null {
  if (typeof value !== 'string') return null
  const parsed = RuntimeId.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** The first list item that names an `agent:`, and where it stands, or null. */
function findAgentAction(list: unknown): { index: number; action: Record<string, unknown> } | null {
  if (!Array.isArray(list)) return null
  const index = list.findIndex((item) => item !== null && typeof item === 'object' && 'agent' in (item as object))
  return index === -1 ? null : { index, action: list[index] as Record<string, unknown> }
}

/** The recipe's own writer as the run began, signed in or not. */
function writerAtStart(ctx: ProjectContext): RuntimeName | null {
  const action = findAgentAction(atStart(ctx, ['steps', 'implement']))
  return asRuntime(
    action !== null && typeof action.action['agent'] === 'string'
      ? action.action['agent']
      : atStart(ctx, ['runtime', 'agent']),
  )
}

/** The recipe's own reviewer as the run began: `none` where `steps.review` is `[]`. */
function reviewerAtStart(ctx: ProjectContext): string | null {
  const list = atStart(ctx, ['steps', 'review'])
  const action = findAgentAction(list)
  const raw = action !== null && typeof action.action['agent'] === 'string' ? action.action['agent'] : null
  return raw !== null ? asRuntime(raw) : Array.isArray(list) && list.length === 0 ? 'none' : null
}

/** What the recipe resolves to in the middle of a run: the starting text with every pending change laid over it. */
const resolvedNow = (ctx: ProjectContext): ResolvedRecipe | null => ctx.view.resolved()

/** What detection read of the project: the proposal's where it holds one, else read from the project's own reader. */
export const detectedOf = (ctx: ProjectContext): Effect.Effect<DetectedSetup, unknown> =>
  ctx.ports.proposal?.detected.known === true
    ? Effect.succeed(ctx.ports.proposal.detected.value)
    : detectSetupEffect(ctx.ports.reader)

/** The `run:` actions already at `path` in `value`, in file order. */
function runActionsIn(value: unknown): NamedRun[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRunAction).map((a) => ({ name: String(a.name ?? ''), run: a.run }))
}

// ---------------------------------------------------------------------------------------------------------------
// The branch question's reads

/** The default branch port, a failure turned into the refusal that carries its words and names the flag to pass. */
const readDefaultBranch = (
  ctx: ProjectContext,
  pass = '--main <branch>',
): Effect.Effect<{ branch: string | null } | { refused: string }> =>
  portCause(() => ctx.ports.defaultBranch).pipe(
    Effect.match({
      onSuccess: (branch) => ({ branch }),
      onFailure: (error) => ({
        refused: `could not read the repository's default branch — ${errorText(error)}. Pass ${pass}`,
      }),
    }),
  )

/** The main branch the answers name: a seed or the recipe's, else the repository's default; a failed read refuses. */
const mainRead = (ctx: ProjectContext): Effect.Effect<{ branch: string | null } | { refused: string }> => {
  const named = text(ctx.view.get(['branch', 'main']))
  return named !== null ? Effect.succeed({ branch: named }) : readDefaultBranch(ctx)
}

/** The main a team's branch is cut from: a typed `--main` first, since that is what is written, then `mainRead`. */
const teamMainRead = (ctx: ProjectContext): Effect.Effect<{ branch: string | null } | { refused: string }> => {
  const typed = ctx.flags['main']
  if (typed !== undefined && typed !== '') return Effect.succeed({ branch: typed })
  // A solo local recipe's main is its working branch, not the team's trunk (0130 §2).
  if (ctx.ports.local && rerun(ctx) && atStart(ctx, ['mode']) !== 'team') return readDefaultBranch(ctx)
  return mainRead(ctx)
}

/** The probed runtimes, a failure turned into the refusal that carries the port's words. */
const readRuntimes = (
  ctx: ProjectContext,
): Effect.Effect<{ runtimes: readonly RuntimeFound[] } | { refused: string }> =>
  portCause(() => ctx.ports.runtimes).pipe(
    Effect.match({
      onSuccess: (runtimes) => ({ runtimes }),
      onFailure: (error) => ({
        refused: `could not read which agents are signed in — ${errorText(error)}. ${ctx.kept}`,
      }),
    }),
  )

/** What detection read of the project, a failure turned into the refusal that carries the reader's words. */
const readDetected = (ctx: ProjectContext): Effect.Effect<{ detected: DetectedSetup } | { refused: string }> =>
  portCause(() => detectedOf(ctx)).pipe(
    Effect.match({
      onSuccess: (detected) => ({ detected }),
      onFailure: (error) => ({
        refused: `could not read what this project builds with — ${errorText(error)}. ${ctx.kept}`,
      }),
    }),
  )

export const personalFallback = (ctx: ProjectContext): string =>
  ctx.ports.local ? LINGTAI_BASE : defaultPersonalBranch(ctx.answers.login ?? '', ctx.ports.hostname)

/** The login the recipe's queue takes by, on a rerun: the `claim` entry's own `queue:`, else `source.assignee`. */
function currentLoginOf(ctx: ProjectContext): string | null {
  const claim = atStart(ctx, ['steps', 'claim'])
  const queued = (Array.isArray(claim) ? claim : []).find(
    (entry): entry is { queue: { assignee?: unknown } } =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { queue?: unknown }).queue === 'object' &&
      (entry as { queue?: unknown }).queue !== null,
  )?.queue.assignee
  const queuedLogin = typeof queued === 'object' && queued !== null ? (queued as { login?: unknown }).login : queued
  return text(queuedLogin ?? atStart(ctx, ['source', 'assignee', 'login']) ?? atStart(ctx, ['source', 'assignee']))
}

// ---------------------------------------------------------------------------------------------------------------
// Model entries: the writer's and the reviewer's, one rule

/** Where the model of `step`'s first `agent:` action stands in the view, and its current value. */
function modelAt(ctx: ProjectContext, step: 'implement' | 'review'): { index: number; model: string | null } | null {
  const found = findAgentAction(ctx.view.get(['steps', step]))
  if (found === null) return null
  const model = found.action['model']
  return { index: found.index, model: typeof model === 'string' ? model : null }
}

/** `''` is the runtime's own default, written as no `model:`; an answer that is what stands writes nothing. */
function modelChanges(ctx: ProjectContext, step: 'implement' | 'review', answer: string): RecipeChange[] {
  const at = modelAt(ctx, step)
  if (at === null) return []
  const wanted = answer === '' ? null : answer
  if (wanted === at.model) return []
  return [{ path: ['steps', step, at.index, 'model'], value: wanted === null ? undefined : wanted }]
}

// ---------------------------------------------------------------------------------------------------------------
// Install and checks: the changes, one place for the questions and the trial

function installChanges(ctx: ProjectContext, install: string | null): RecipeChange[] {
  const effective = resolvedRunActions(resolvedNow(ctx)?.recipe ?? null, 'prepared')
  if (effective !== null && install === (effective[0]?.run ?? null)) return []
  const original = ctx.view.get(['steps', 'prepared'])
  const wanted = install === null ? [] : [{ name: 'install', run: install }]
  return [{ path: ['steps', 'prepared'], value: mergeRunActions(Array.isArray(original) ? original : [], wanted) }]
}

function checkChanges(ctx: ProjectContext, build: NamedRun[]): RecipeChange[] {
  const effective = resolvedRunActions(resolvedNow(ctx)?.recipe ?? null, 'build')
  const same =
    effective !== null && effective.length === build.length && effective.every((a, i) => a.run === build[i]!.run)
  if (same) return []
  const original = ctx.view.get(['steps', 'build'])
  return [{ path: ['steps', 'build'], value: mergeRunActions(Array.isArray(original) ? original : [], build) }]
}

/** A `--build` answer is a JSON array of commands, so a command that holds a comma survives. */
function parseChecks(answer: string): string[] | string {
  try {
    const parsed: unknown = JSON.parse(answer)
    if (Array.isArray(parsed) && parsed.every((c) => typeof c === 'string' && c !== '')) return parsed as string[]
  } catch {
    // falls through to the refusal
  }
  return 'the build list is a JSON array of commands'
}

// ---------------------------------------------------------------------------------------------------------------
// Landing

/** The two ways the landing is asked at a terminal; a flag answers `hold` or a branch instead. */
export const LANDING_WAIT = 'wait for me to approve'
export const LANDING_LAND = 'land it without asking'

/** The recipe's `runtime.limits.run.usd` is written, but only claude-code enforces it. */
function dollarCeilingNote(named: unknown): string {
  return typeof named === 'string'
    ? `${named} cannot hold a dollar ceiling on one run — runtime.limits.run.usd is written, and reported absent at that runtime`
    : 'only claude-code holds a dollar ceiling on one run, and this recipe names no runtime.agent — runtime.limits.run.usd is written, and holds only where claude-code is the runtime that runs'
}

/** Presentation reads settled state, never computes an offered default or runs a port. */
function presentation<T>(
  label: string,
  group: SetupRow['group'],
  read: (view: ProjectView, ctx: ProjectContext) => T,
  format: (value: T, ctx: ProjectContext) => string = (v) => String(v ?? 'none'),
  order?: number,
): Presentation<ProjectContext> {
  return {
    label,
    group,
    order,
    before: (ctx) => (rerun(ctx) ? read(projectView(ctx.start, []), ctx) : undefined),
    value: (ctx) => read(ctx.view, ctx),
    format: (value, ctx) => format(value as T, ctx),
  }
}

const actionIn = (view: ProjectView, step: string) => findAgentAction(view.get(['steps', step]))?.action
const agentPresentation = (step: string) => (view: ProjectView) => {
  const action = actionIn(view, step)
  return {
    agent: action?.['agent'] ?? (step === 'implement' ? view.get(['runtime', 'agent']) : 'none'),
    model: action?.['model'] ?? null,
  }
}
const agentText = (a: ReturnType<ReturnType<typeof agentPresentation>>) =>
  a.model === null ? String(a.agent ?? 'none') : `${a.agent}, ${a.model}`
const limitPresentation = (label: string, read: (view: ProjectView) => unknown) => presentation(label, 'attempt', read)

// ---------------------------------------------------------------------------------------------------------------
// The list

const entry = (
  id: ProjectQuestionId,
  d: Omit<ProjectQuestion, 'id' | 'flags' | 'row'> & { row?: ProjectQuestion['row'] },
): ProjectQuestion => ({ id, flags: FLAGS_OF[id], row: rowOf, ...d })

/**
 * The project list: 25 descriptors in design order. What the ports say about the run's shape (local or GitHub, a
 * checkout, a trial, a proposal) is read from `ports` here; what they do is called through `ctx.ports`, the same
 * object, so an asker sees it too. Nothing is read until the runner walks the list.
 */
export function projectList(ports: ProjectPorts): readonly ProjectQuestion[] {
  const choice =
    (...allowed: string[]) =>
    (answer: string): Effect.Effect<string | null> =>
      Effect.succeed(allowed.includes(answer) ? null : `${answer} is not one of ${allowed.join(', ')}`)

  const where = entry('where', {
    presentation: presentation(
      'code',
      'project',
      (v, ctx) => ({
        where: v.get(['repo', 'owner']) === null ? 'local' : 'github',
        code: v.get(['repo', 'remote']) ?? `${v.get(['repo', 'owner'])}/${ctx.ports.project}`,
      }),
      (v) => `${v.code}  ${v.where}`,
    ),
    name: 'where the project is',
    flag: '--project github, or --project local',
    // Always fixed: the ports exist only once it is answered, and it takes no flag and has no asker.
    fixed: () => ({ answer: ports.local ? 'local' : 'github' }),
    // The one read the entries after it need and cannot make from `fixed`: what the log already holds.
    write: (_answer, _inForce, ctx) =>
      portCause(() => ctx.ports.history(ctx.ports.project)).pipe(
        Effect.match({
          onSuccess: (history): WriteResult | { refused: string } => {
            ctx.answers.history = history
            return { wrote: false }
          },
          onFailure: (error): WriteResult | { refused: string } => ({
            refused: `could not read the tickets already in the log for ${ctx.ports.project} — ${errorText(error)}. ${ctx.kept}`,
          }),
        }),
      ),
  })

  const mode = entry('mode', {
    presentation: presentation('mode', 'project', (v) => v.resolved()?.recipe.mode ?? v.get(['mode']) ?? 'solo'),
    name: 'the mode',
    flag: '--mode team|solo',
    fromFlags: (flags) => flags['mode'] ?? null,
    inForce: (ctx) => inForceOf(rerun(ctx) ? (atStart(ctx, ['mode']) === 'team' ? 'team' : 'solo') : null),
    systemDefault: () => Effect.succeed('team'),
    validate: choice('team', 'solo'),
    write: (answer, inForce, ctx) =>
      Effect.sync(() => {
        const next = answer as Mode
        ctx.answers.mode = next
        // The schema's mode is solo: a first run that answers solo has nothing to write.
        const before = valueOf(inForce) ?? 'solo'
        if (before === next) return append(ctx, [])
        const changes: RecipeChange[] = [{ path: ['mode'], value: next }]
        if (next === 'solo' && before === 'team') {
          // `branch.personal` and `pr:` are read only in team mode: a recipe that keeps either does not resolve.
          changes.push({ path: ['branch', 'personal'], value: undefined })
          if (atStart(ctx, ['pr']) !== null) changes.push({ path: ['pr'], value: undefined })
        }
        return append(ctx, changes)
      }),
  })

  const login = entry('login', {
    presentation: presentation(
      'takes',
      'project',
      (v) => {
        const claim = v.resolved()?.recipe
        return claim === undefined ? null : claim.source.assignee
      },
      (v) =>
        v === null
          ? 'every ticket — local tickets are yours'
          : typeof v === 'string'
            ? `issues assigned to ${v}`
            : JSON.stringify(v),
    ),
    name: 'your GitHub login',
    flag: '--login <login>',
    applies: (ctx) => ctx.answers.mode === 'team' && !ports.local,
    fromFlags: (flags) => flags['login'] ?? null,
    // A discovered login stands in for the question where it is the recipe's own or the recipe has none; a flag speaks
    // for itself, so nothing is fixed then.
    fixed: (ctx, flag) => {
      if (flag !== null) return null
      const known = ctx.ports.knownLogin
      if (known === null || known === '') return null
      const current = currentLoginOf(ctx)
      return current === null || known === current ? { answer: known } : null
    },
    inForce: (ctx) => inForceOf(rerun(ctx) ? currentLoginOf(ctx) : null),
    validate: (answer) => Effect.succeed(loginRefusal(answer)),
    write: (answer, _inForce, ctx) =>
      Effect.sync(() => {
        ctx.answers.login = answer
        if (currentLoginOf(ctx) === answer) return append(ctx, [])
        const claim = ctx.view.get(['steps', 'claim'])
        return append(ctx, assigneeChanges({ login: answer, take: 'mine' }, Array.isArray(claim) ? claim : null))
      }),
  })

  // The branch the recipe lands on now, when a local solo rerun may cut `answer` from it: the recipe names it and it
  // is there. Null where none is; `unreadable` where the checkout could not say.
  const rerunBaseSource = (ctx: ProjectContext, answer: string) =>
    Effect.gen(function* () {
      if (!ports.local || !rerun(ctx)) return null
      // The branch the recipe works on in the mode it started in: a team recipe's is `branch.personal`.
      const old = text(atStart(ctx, ['branch', atStart(ctx, ['mode']) === 'team' ? 'personal' : 'main']))
      if (old === null || old === answer) return null
      const found = yield* ctx.ports.branchExists(old)
      return found === 'unreadable' ? found : found ? old : null
    })

  const branch = entry('branch', {
    presentation: presentation(
      'works on',
      'project',
      (v) => {
        const r = v.resolved()
        return r === null
          ? { branch: v.get(['branch']), remote: v.get(['repo', 'remote']) }
          : { branch: branchOf(r.recipe), main: r.recipe.branch.main, remote: v.get(['repo', 'remote']) }
      },
      (v) => JSON.stringify(v),
    ),
    name: 'the branch',
    flag: '--main <branch> (solo), or --personal <branch> (team)',
    fromFlags: (flags, ctx) => (ctx.answers.mode === 'team' ? flags['personal'] : flags['main']) ?? null,
    inForce: (ctx) =>
      inForceOf(
        rerun(ctx)
          ? text(
              atStart(
                ctx,
                ctx.answers.mode === 'team' && (!ports.local || atStart(ctx, ['mode']) === 'team')
                  ? ['branch', 'personal']
                  : ['branch', 'main'],
              ),
            )
          : null,
      ),
    systemDefault: (ctx) =>
      Effect.gen(function* () {
        if (ctx.answers.mode === 'team') {
          if (ctx.ports.local) return LINGTAI_BASE
          return ctx.answers.login === undefined ? null : defaultPersonalBranch(ctx.answers.login, ctx.ports.hostname)
        }
        // A seed, or what the recipe names: the question then only confirms it.
        const named = text(ctx.view.get(['branch', 'main']))
        if (named !== null) return named
        // A directory's solo project lands on its own branch, never on the checked-out one.
        if (ctx.ports.local) return LINGTAI_BASE
        const read = yield* readDefaultBranch(ctx)
        if ('refused' in read) return read
        return (
          read.branch ?? { refused: 'the repository has no default branch to take as its base. Pass --main <branch>' }
        )
      }),
    validate: (answer, ctx) =>
      Effect.gen(function* () {
        if (ctx.answers.mode === 'team') {
          // The main the write will use, so a typed `--main` is what the personal branch is compared with.
          const read = yield* teamMainRead(ctx)
          if ('refused' in read) return read.refused
          return personalBranchRefusal(answer, read.branch ?? '', personalFallback(ctx))
        }
        // Locally the base Lingtai makes is made after the list; any other name has to be there already.
        if (ctx.ports.local) {
          if (answer === LINGTAI_BASE) return null
          const found = yield* ctx.ports.branchExists(answer)
          if (found === 'unreadable') return `could not read whether ${answer} exists in this checkout`
          if (found) return null
          // A rerun cuts a new base from the one the recipe names, where that exists.
          const source = yield* rerunBaseSource(ctx, answer)
          if (source === 'unreadable') return `could not read whether the current base exists in this checkout`
          return source === null ? `${answer} is not a branch in this checkout` : null
        }
        if (ctx.ports.notReadableYet === true) return null
        return yield* branchOnGithubRefusal(answer, null, ctx.ports.branchExists)
      }),
    write: (answer, inForce, ctx) =>
      Effect.gen(function* () {
        if (ctx.answers.mode !== 'team') {
          const where = ctx.ports.local ? 'in this checkout' : 'on GitHub'
          const found = ctx.ports.notReadableYet === true ? true : yield* ctx.ports.branchExists(answer)
          if (found === 'unreadable')
            return { refused: `could not read whether ${answer} exists ${where}. ${ctx.kept}` }
          // The base a directory's project lands on is made after the list; a rerun's new base is cut from the old
          // one; no other name is made.
          let from: string | null = null
          if (!found && !(ctx.ports.local && answer === LINGTAI_BASE)) {
            const source = yield* rerunBaseSource(ctx, answer)
            if (source === 'unreadable') {
              return { refused: `could not read whether the current base exists in this checkout. ${ctx.kept}` }
            }
            if (source === null) return { refused: `${answer} is not a branch ${where}. ${ctx.kept}` }
            from = source
          }
          if (!found && ctx.ports.local && answer === LINGTAI_BASE) {
            const old = yield* rerunBaseSource(ctx, answer)
            if (old === 'unreadable')
              return { refused: `could not read whether the current base exists in this checkout. ${ctx.kept}` }
            const read = old === null ? yield* readDefaultBranch(ctx) : { branch: old }
            if ('refused' in read) return read
            if (read.branch === null)
              return {
                refused: `${ctx.ports.checkout} has no branch checked out, and ${LINGTAI_BASE} is made from the one that is. Check out a branch, or pass --main <branch>`,
              }
            from = read.branch
            ctx.answers.make = { name: answer, from }
          }
          ctx.answers.branch = { name: answer, exists: found, from, onlyIn: null, main: answer }
          return append(ctx, valueOf(inForce) === answer ? [] : [{ path: ['branch', 'main'], value: answer }])
        }
        const kept = ctx.kept
        const typedMain = ctx.flags['main']
        const read = yield* teamMainRead(ctx)
        if ('refused' in read) return { refused: `${read.refused}. ${kept}` }
        // A team recipe asks no base question, so a typed `--main` is the answer, checked here.
        const main = read.branch
        if (main === null || main === '') {
          return {
            refused: `no main branch to cut ${ctx.answers.login ?? 'your'}'s branch from — pass --main <branch>. ${kept}`,
          }
        }
        const changes: RecipeChange[] = []
        // A main the port read from GitHub's own default is not looked up again; every other one is.
        const named = text(ctx.view.get(['branch', 'main']))
        if ((typedMain !== undefined && typedMain !== '') || named !== null || ctx.ports.local) {
          const found = ctx.ports.notReadableYet === true ? true : yield* ctx.ports.branchExists(main)
          if (found === 'unreadable') return { refused: `could not read whether ${main} exists. ${kept}` }
          if (!found) {
            return { refused: `${main} is not a branch ${ctx.ports.local ? 'in this checkout' : 'on GitHub'}. ${kept}` }
          }
        }
        // What the recipe names is what stands, so a detected main is written too, not only a typed one.
        if (named !== main) changes.push({ path: ['branch', 'main'], value: main })

        const exists = yield* ctx.ports.branchExists(answer)
        if (exists === 'unreadable') {
          return { refused: `could not read whether ${answer} exists on GitHub — nothing was made. ${kept}` }
        }
        const old = rerun(ctx)
          ? text(atStart(ctx, ['branch', ports.local && atStart(ctx, ['mode']) !== 'team' ? 'main' : 'personal']))
          : null
        let from: string | null = null
        let onlyIn: string[] | null = null
        if (exists) {
          if (!ctx.ports.local) {
            ctx.log.push(
              `${answer} exists already — Lingtai will use it as it is; main is brought into it at your first submit`,
            )
          }
          if (old !== null && old !== answer) onlyIn = yield* ctx.ports.commitsOnlyIn(answer, old)
        } else {
          // A new working branch is cut from the old one where that exists: what landed on it and has not reached
          // main would otherwise be missing from the new one (#1474).
          from = main
          if (old !== null && old !== answer) {
            const oldExists = yield* ctx.ports.branchExists(old)
            if (oldExists === 'unreadable') {
              return { refused: `could not read whether ${old} exists on GitHub — nothing was made. ${kept}` }
            }
            if (oldExists) from = old
          }
        }
        ctx.answers.branch = { name: answer, exists, from, onlyIn, main }
        if (text(atStart(ctx, ['branch', 'personal'])) !== answer)
          changes.push({ path: ['branch', 'personal'], value: answer })
        return append(ctx, changes)
      }),
  })

  const makeBranch = entry('make-branch', {
    name: 'making the personal branch',
    flag: '--defaults, or make the branch yourself',
    applies: (ctx) =>
      ctx.answers.branch !== undefined &&
      !ctx.answers.branch.exists &&
      (ctx.answers.mode === 'team' ||
        (ports.local && ctx.answers.branch.from !== null && ctx.answers.branch.name !== LINGTAI_BASE)),
    confirm: {
      declined: (ctx) => {
        const at = ctx.answers.branch
        const name = at?.name ?? 'the branch'
        const from = at?.from ?? at?.main ?? 'main'
        return ctx.ports.local
          ? `${name} was not made — nothing was written and nothing was registered. Make it yourself with: git branch ${name} ${from}, then run this again. ${ctx.kept}`
          : `${name} was not made — nothing was written and nothing was registered. Make it yourself with: git push origin origin/${from}:refs/heads/${name}, then run this again`
      },
    },
    write: (_answer, _inForce, ctx) =>
      Effect.sync(() => {
        const at = ctx.answers.branch
        if (at !== undefined && at.from !== null) ctx.answers.make = { name: at.name, from: at.from }
        return { wrote: false }
      }),
  })

  const moveLanding = entry('move-landing', {
    name: 'moving the landing',
    flag: '--defaults',
    // A local rerun from another checkout: the recipe lands on one remote, and this checkout is another.
    applies: (ctx) => {
      const remote = text(atStart(ctx, ['repo', 'remote']))
      return ports.local && ports.checkout !== null && remote !== null && remote !== ports.checkout
    },
    confirm: { declined: (ctx) => `${ctx.ports.project}'s landing was not moved. ${ctx.kept}` },
    write: nothing,
  })

  const defaults = entry('defaults', {
    name: 'this setup',
    flag: '--defaults',
    defaultsSwitch: true,
    write: (answer, _inForce, ctx) =>
      Effect.sync(() => {
        ctx.answers.defaults = answer === 'yes' ? 'yes' : 'no'
        return { wrote: false }
      }),
  })

  // ---- the writer and the reviewer: four entries, one action each ---------------------------------------------

  const writer = entry('writer', {
    presentation: presentation('writes', 'attempt', agentPresentation('implement'), agentText, 8),
    name: 'which agent writes the change',
    flag: `--agent <${RuntimeId.options.join('|')}>`,
    fromFlags: (flags) => flags['agent'] ?? null,
    inForce: (ctx) =>
      Effect.gen(function* () {
        const read = yield* readRuntimes(ctx)
        // A probe that failed cannot be asked past: refused with the port's words.
        if ('refused' in read) return { fault: read.refused, from: 'file', fatal: true } satisfies InForce
        const runtimes = read.runtimes
        // Every runtime that is missing is said, with why, before the first agent question, flag or not.
        for (const r of runtimes) if (!r.signedIn) ctx.log.push(whyMissing(r))
        if (offeredRuntimes(runtimes).length === 0) {
          return { fault: noRuntimesSignedInRefusal(runtimes), from: 'file', fatal: true } satisfies InForce
        }
        return writerAtStart(ctx) === null ? null : ({ value: writerAtStart(ctx)!, from: 'file' } satisfies InForce)
      }),
    systemDefault: (ctx) =>
      Effect.gen(function* () {
        const read = yield* readRuntimes(ctx)
        if ('refused' in read) return read
        return defaultAgents(offeredRuntimes(read.runtimes)).writer
      }),
    validate: (answer, ctx) =>
      Effect.gen(function* () {
        const read = yield* readRuntimes(ctx)
        if ('refused' in read) return read.refused
        const runtimes = read.runtimes
        // The recipe's own writer is accepted signed in or not: a rerun that takes every default keeps it (#1473).
        return runtimeRefusal(answer, { signedIn: offeredRuntimes(runtimes), runtimes, kept: writerAtStart(ctx) })
      }),
    write: (answer, _inForce, ctx) =>
      Effect.gen(function* () {
        ctx.answers.writer = answer
        const before = writerAtStart(ctx)
        const changes: RecipeChange[] = []
        // `runtime.agent` is resolved unconditionally, even where every step names its own agent, so it is written
        // whenever the writer changes and whenever it is absent. A hand-set one beside an unchanged writer is kept.
        if (answer !== before || atStart(ctx, ['runtime', 'agent']) === null) {
          changes.push({ path: ['runtime', 'agent'], value: answer })
        }
        // A runtime that cannot hold a turn count is not asked to promise one (#547), and only where the file does
        // not already declare `turns`; on a rerun only a writer that changed adds it.
        const capabilities = everyRuntime().find((r) => r.capabilities.id === answer)?.capabilities
        if (
          capabilities !== undefined &&
          !capabilities.enforces.includes('turns') &&
          atStart(ctx, ['runtime', 'limits', 'run', 'turns']) === null &&
          answer !== before
        ) {
          changes.push(unboundedTurnsChange())
        }
        const action = findAgentAction(atStart(ctx, ['steps', 'implement']))
        if (action !== null) {
          if (action.action['agent'] !== answer) {
            changes.push({ path: ['steps', 'implement', action.index, 'agent'], value: answer })
          }
        } else {
          changes.push({
            path: ['steps', 'implement'],
            value: [{ name: 'write the change', agent: answer, prompt: '' }],
          })
        }
        // The schema's discuss agent is claude-code. Where that cannot run and the model-only Codex route is
        // configured, a new recipe names Codex instead; never `discuss.model`.
        if (!rerun(ctx)) {
          const read = yield* readRuntimes(ctx)
          if ('refused' in read) return read
          if (read.runtimes.find((r) => r.id === 'claude-code')?.signedIn !== true) {
            const codex = yield* portCause(() => ctx.ports.codexText).pipe(Effect.catch(() => Effect.succeed(false)))
            if (codex) changes.push({ path: ['discuss', 'agent'], value: 'codex' })
          }
        }
        return append(ctx, changes)
      }),
  })

  const writerModel = entry('writer-model', {
    name: 'which model the writer runs on',
    flag: "--model <name>, or --model ''",
    fromFlags: (flags) => flags['model'] ?? null,
    // A model belongs to the agent it was written beside: offered back only where the writer kept that agent.
    inForce: (ctx) => {
      const action = findAgentAction(atStart(ctx, ['steps', 'implement']))
      const model = action !== null ? action.action['model'] : null
      return inForceOf(
        action !== null && ctx.answers.writer === writerAtStart(ctx) && typeof model === 'string' ? model : null,
      )
    },
    systemDefault: () => Effect.succeed(''),
    write: (answer, _inForce, ctx) => Effect.sync(() => append(ctx, modelChanges(ctx, 'implement', answer))),
    row: (value, before) => (value === '' ? "the runtime's own default" : rowOf(value, before)),
  })

  const reviewer = entry('reviewer', {
    presentation: presentation('reviews', 'attempt', agentPresentation('review'), agentText, 10),
    name: 'a cold reviewer',
    flag: '--reviewer <runtime|none>',
    fromFlags: (flags) => flags['reviewer'] ?? null,
    inForce: (ctx) => inForceOf(reviewerAtStart(ctx)),
    // A different model means a different runtime: the other one signed in, else the writer's own.
    systemDefault: (ctx) =>
      Effect.gen(function* () {
        const read = yield* readRuntimes(ctx)
        if ('refused' in read) return read
        const offered = offeredRuntimes(read.runtimes)
        return offered.find((id) => id !== ctx.answers.writer) ?? ctx.answers.writer ?? null
      }),
    validate: (answer, ctx) =>
      Effect.gen(function* () {
        const read = yield* readRuntimes(ctx)
        if ('refused' in read) return read.refused
        const runtimes = read.runtimes
        return runtimeRefusal(answer, {
          signedIn: offeredRuntimes(runtimes),
          runtimes,
          kept: reviewerAtStart(ctx),
          orNone: true,
        })
      }),
    write: (answer, _inForce, ctx) =>
      Effect.gen(function* () {
        const read = yield* readRuntimes(ctx)
        if ('refused' in read) return read
        const runtimes = read.runtimes
        const signedIn: string[] = offeredRuntimes(runtimes)
        const writerNow = ctx.answers.writer ?? null
        const writerBefore = writerAtStart(ctx)
        const reviewerBefore = reviewerAtStart(ctx)

        // Only the first `agent:` entry of `implement` and of `review` is rewritten here, and the findings judge the
        // writer entry's neighbour edits; every other action stays as written, and `leftoverRefusal` says whether
        // that is still safe.
        const implement = findAgentAction(atStart(ctx, ['steps', 'implement']))
        const review = findAgentAction(atStart(ctx, ['steps', 'review']))
        const editedInPlace: { step: string; index: number }[] = []
        const fullyReplaced = new Set<string>()
        if (implement !== null) editedInPlace.push({ step: 'implement', index: implement.index })
        else fullyReplaced.add('implement')
        if (answer === 'none') fullyReplaced.add('review')
        else if (review !== null) editedInPlace.push({ step: 'review', index: review.index })
        else fullyReplaced.add('review')
        // The findings judge follows the writer (#1523): the first one, naming the starting writer, is edited or
        // removed by `findings-judge` and so is not a leftover.
        if (rerun(ctx)) {
          const proposed = atStart(ctx, ['steps', 'proposed'])
          const followed = followedJudgeIndex(Array.isArray(proposed) ? proposed : null, writerBefore)
          if (followed !== null) editedInPlace.push({ step: 'proposed', index: followed })
        }
        const keptRuntimes = new Set<string>()
        if (writerBefore !== null && writerNow === writerBefore) keptRuntimes.add(writerBefore)
        if (reviewerBefore !== null && reviewerBefore !== 'none' && answer === reviewerBefore) {
          keptRuntimes.add(reviewerBefore)
        }
        const leftover = leftoverRefusal(atStart(ctx, ['steps']), signedIn, editedInPlace, fullyReplaced, keptRuntimes)
        ctx.log.push(...leftover.log)
        if (leftover.refused !== null) return { refused: leftover.refused }

        ctx.answers.reviewer = answer
        // Kept before the reviewer's model question, where it was said before (`init-golden` pins the place).
        if (answer !== 'none' && signedIn.filter((id) => id !== writerNow).length === 0) {
          ctx.log.push("the reviewer runs the writer's runtime, on its own default model, unless a model is named here")
        }

        const changes: RecipeChange[] = []
        if (answer === 'none') {
          if (reviewerBefore !== 'none') changes.push({ path: ['steps', 'review'], value: [] })
        } else if (review !== null) {
          if (review.action['agent'] !== answer) {
            changes.push({ path: ['steps', 'review', review.index, 'agent'], value: answer })
          }
        } else {
          changes.push({ path: ['steps', 'review'], value: [{ name: 'review', agent: answer, prompt: '' }] })
        }
        return append(ctx, changes)
      }),
  })

  const reviewerModel = entry('reviewer-model', {
    name: "the reviewer's model",
    flag: "--reviewer-model <name>, or --reviewer-model ''",
    applies: (ctx) => ctx.answers.reviewer !== undefined && ctx.answers.reviewer !== 'none',
    // The question asks nothing when no reviewer is chosen, but a flag beside `none` is never silently ignored (#391).
    fromFlags: (flags, ctx) =>
      flags['reviewer-model'] !== undefined && ctx.answers.reviewer === 'none'
        ? {
            refused:
              "--reviewer-model names a model for a reviewer --reviewer none says there isn't one. Nothing was written",
          }
        : (flags['reviewer-model'] ?? null),
    inForce: (ctx) => {
      const action = findAgentAction(atStart(ctx, ['steps', 'review']))
      const model = action !== null ? action.action['model'] : null
      return inForceOf(
        action !== null && ctx.answers.reviewer === reviewerAtStart(ctx) && typeof model === 'string' ? model : null,
      )
    },
    systemDefault: () => Effect.succeed(''),
    write: (answer, _inForce, ctx) => Effect.sync(() => append(ctx, modelChanges(ctx, 'review', answer))),
    row: (value, before) => (value === '' ? "the runtime's own default" : rowOf(value, before)),
  })

  // ---- the sandbox ----------------------------------------------------------------------------------------------

  const sandbox = entry('sandbox', {
    presentation: presentation(
      'sandbox',
      'project',
      (v) => {
        const s = v.resolved()?.recipe.sandbox
        return { on: s?.enabled === true, hosts: s?.network.allow ?? [] }
      },
      (v, ctx) =>
        `${v.on ? `on · ${v.hosts.length === 0 ? 'no extra hosts' : v.hosts.join(', ')}` : 'off'}${
          ctx.ports.proposal?.sandbox == null
            ? ''
            : (() => {
                const why = sandboxCannotSentence(ctx.ports.proposal.sandbox)
                return why === null ? '' : ` — ${why}`
              })()
        }`,
    ),
    name: 'the sandbox',
    flag: '--sandbox on|off',
    applies: () => ports.proposal?.sandbox != null,
    fromFlags: (flags) => flags['sandbox'] ?? null,
    inForce: (ctx) => {
      const cannot = ctx.ports.proposal?.sandbox == null ? null : sandboxCannotSentence(ctx.ports.proposal.sandbox)
      // Said where it is drawn, never when a flag answers it.
      if (cannot !== null && ctx.flags['sandbox'] === undefined) ctx.log.push(cannot)
      // An absent block is off.
      return inForceOf(rerun(ctx) ? (startResolved(ctx)?.recipe.sandbox?.enabled === true ? 'on' : 'off') : null)
    },
    systemDefault: () => Effect.succeed('on'),
    validate: choice('on', 'off'),
    write: (answer, inForce, ctx) =>
      Effect.sync(() => {
        const on = answer === 'on'
        ctx.answers.sandbox = on ? 'on' : 'off'
        if (!on) ctx.log.push(SANDBOX_OFF_LINE)
        if (!rerun(ctx)) {
          // `sandboxChanges` replaces the block whole; the hosts entry adds its own key when there are any.
          return append(
            ctx,
            on ? [{ path: ['sandbox'], value: { enabled: true } }] : sandboxChanges({ enabled: false, allow: [] }),
          )
        }
        if (valueOf(inForce) === answer) return append(ctx, [])
        return append(ctx, [
          { path: ['sandbox', 'enabled'], value: on },
          // `required` beside `enabled: false` does not resolve: off takes the requirement with it.
          ...(!on && startResolved(ctx)?.recipe.sandbox?.required === true
            ? [{ path: ['sandbox', 'required'], value: false }]
            : []),
        ])
      }),
  })

  const hostsAtStart = (ctx: ProjectContext): string[] => startResolved(ctx)?.recipe.sandbox?.network.allow ?? []

  const sandboxHosts = entry('sandbox-hosts', {
    name: 'the extra sandbox hosts',
    flag: '--sandbox-hosts <a.example,b.example>|none',
    applies: (ctx) => ctx.answers.sandbox === 'on',
    fromFlags: (flags) => flags['sandbox-hosts'] ?? null,
    inForce: (ctx) => {
      if (!rerun(ctx)) return inForceOf(null)
      const allow = hostsAtStart(ctx)
      return inForceOf(allow.length === 0 ? 'none' : allow.join(','))
    },
    systemDefault: () => Effect.succeed('none'),
    validate: (answer) => Effect.succeed(answer === 'none' ? null : hostsRefusal(parseHosts(answer))),
    write: (answer, _inForce, ctx) =>
      Effect.sync(() => {
        const allow = answer === 'none' ? [] : parseHosts(answer)
        if (!rerun(ctx)) {
          return append(ctx, allow.length === 0 ? [] : [{ path: ['sandbox', 'network', 'allow'], value: allow }])
        }
        // Only what changed is written: a block written whole would take a hand-set `required` with it.
        const before = hostsAtStart(ctx)
        const same = allow.length === before.length && allow.every((h, i) => h === before[i])
        return append(ctx, same ? [] : [{ path: ['sandbox', 'network', 'allow'], value: allow }])
      }),
  })

  // ---- install, the checks and the trial ---------------------------------------------------------------------

  const install = entry('install', {
    presentation: presentation(
      'install',
      'attempt',
      (v) => runActionsIn(v.get(['steps', 'prepared'])).map((a) => a.run),
      (v) => (v.length === 0 ? 'none' : v.join(' · ')),
    ),
    name: 'the install command',
    flag: '--install <command>, or --install none',
    fromFlags: (flags) => flags['install'] ?? null,
    inForce: (ctx) =>
      Effect.gen(function* () {
        // Said before the install question, with a terminal or without one. A probe that throws says nothing.
        const read = yield* readDetected(ctx)
        if ('refused' in read) return { fault: read.refused, from: 'file', fatal: true } satisfies InForce
        const detected = read.detected
        const commands = [
          detected.install === null ? undefined : { tool: detected.install.tool, run: detected.install.run },
          ...detected.build,
        ]
        const tools = new Set(commands.flatMap((c) => (c === undefined ? [] : [c.tool ?? c.run.split(' ')[0]!])))
        for (const tool of tools) {
          const found = yield* portCause(() => ctx.ports.onPath(tool)).pipe(Effect.catch(() => Effect.succeed(true)))
          if (!found) ctx.log.push(`${tool} is not on this machine's PATH; the conductor runs these commands here`)
        }
        // A file that lists `prepared: []` has answered *no install*: that is its value, not a missing one (#1473).
        const prepared = atStart(ctx, ['steps', 'prepared'])
        const current = runActionsIn(prepared)[0]?.run ?? (rerun(ctx) && Array.isArray(prepared) ? 'none' : null)
        return current === null ? null : ({ value: current, from: 'file' } satisfies InForce)
      }),
    systemDefault: (ctx) =>
      readDetected(ctx).pipe(Effect.map((r) => ('refused' in r ? r : (r.detected.install?.run ?? 'none')))),
    validate: (answer) => Effect.succeed(installRefusal(answer)),
    write: (answer, _inForce, ctx) =>
      Effect.sync(() => {
        const run = answer === 'none' ? null : answer
        ctx.answers.install = run
        return append(ctx, installChanges(ctx, run))
      }),
  })

  const checks = entry('checks', {
    presentation: presentation(
      'checks',
      'attempt',
      (v) => runActionsIn(v.get(['steps', 'build'])).map((a) => a.run),
      (v) => (v.length === 0 ? 'none — nothing checks a diff before review' : v.join(' · ')),
    ),
    name: 'the build steps',
    flag: '--build <command> (repeatable), or --build none',
    // Every `--build`, in order, as a JSON array: `flags['build']` holds only the last.
    fromFlags: (_flags, ctx) => {
      if (ctx.buildFlags.length === 0) return null
      if (ctx.buildFlags.includes('none') && ctx.buildFlags.length > 1) {
        return { refused: '--build none cannot be combined with another --build value' }
      }
      // A `--build` with no value parses to `''`: refused by name rather than written as a `run: ""` that checks nothing.
      if (ctx.buildFlags.includes('')) return { refused: '--build takes a command, or none — not empty' }
      return JSON.stringify(ctx.buildFlags[0] === 'none' ? [] : ctx.buildFlags)
    },
    inForce: (ctx) => {
      const build = atStart(ctx, ['steps', 'build'])
      const runs = runActionsIn(build).map((a) => a.run)
      // A file that lists `build: []` has answered *no checks*: detection does not refill it (#1473).
      return inForceOf(runs.length > 0 || (rerun(ctx) && Array.isArray(build)) ? JSON.stringify(runs) : null)
    },
    systemDefault: (ctx) =>
      readDetected(ctx).pipe(
        Effect.map((r) => ('refused' in r ? r : JSON.stringify(r.detected.build.map((b) => b.run)))),
      ),
    validate: (answer) =>
      Effect.succeed(typeof parseChecks(answer) === 'string' ? (parseChecks(answer) as string) : null),
    write: (answer, inForce, ctx) =>
      Effect.sync(() => {
        const runs = parseChecks(answer) as string[]
        ctx.answers.checks = runs
        const original = ctx.view.get(['steps', 'build'])
        const named = namedFromTyped(runs, Array.isArray(original) ? original : [])
        if (runs.length === 0) {
          if (valueOf(inForce) !== '[]') ctx.log.push('nothing will check a diff before review')
          ctx.answers.trial = { trial: 'not-run', because: 'no checks' }
        } else if (ctx.ports.trial === undefined) {
          ctx.log.push(NO_CHECKOUT_LINE)
          ctx.answers.trial = { trial: 'not-run', because: 'no checkout' }
        }
        return append(ctx, checkChanges(ctx, named))
      }),
    row: (value) => {
      const runs = parseChecks(value)
      return typeof runs === 'string' ? value : runs.length === 0 ? 'none' : runs.join(', ')
    },
  })

  const trial = entry('trial', {
    name: 'the trial run',
    flag: '--check-build yes, or --check-build no',
    applies: (ctx) => ports.trial !== undefined && (ctx.answers.checks?.length ?? 0) > 0,
    fromFlags: (flags) => flags['check-build'] ?? null,
    // The trial spends minutes of somebody's build: never a default, whether the defaults came from the flag or from a
    // typed yes (#436), and never without a terminal.
    systemDefault: (_ctx, mode) => Effect.succeed(mode.defaults || !mode.interactive ? 'no' : 'yes'),
    validate: choice('yes', 'no'),
    write: (answer, _inForce, ctx) =>
      Effect.gen(function* () {
        if (answer === 'no') {
          ctx.answers.trial = { trial: 'not-run', because: 'declined' }
          return { wrote: false }
        }
        const port = ctx.ports.trial
        if (port === undefined) return { wrote: false }
        const original = ctx.view.get(['steps', 'build'])
        const flag = ctx.flags['check-build']
        const ran = yield* portCause(() =>
          port({
            view: ctx.view,
            install: ctx.answers.install ?? null,
            checks: namedFromTyped(ctx.answers.checks ?? [], Array.isArray(original) ? original : []),
            given: {
              install: ctx.flags['install'] ?? null,
              build: ctx.buildFlags.length === 0 ? null : [...ctx.buildFlags],
              check: flag === 'yes' || flag === 'no' ? flag : null,
            },
            make: ctx.answers.make ?? null,
            recipeExisted: rerun(ctx),
            kept: ctx.kept,
          }),
        ).pipe(
          Effect.match({
            onSuccess: (done) => done,
            onFailure: (error) => ({ refused: `the trial build failed to run — ${errorText(error)}. ${ctx.kept}` }),
          }),
        )
        if ('refused' in ran) return ran
        const outcome = ran
        ctx.answers.install = outcome.install
        ctx.answers.checks = outcome.checks.map((c) => c.run)
        ctx.answers.trial = outcome.trial
        // What the loop returned replaces what the install and checks entries appended (later changes win).
        if (outcome.trial.trial === 'failed-kept') {
          ctx.log.push(
            `kept the list as tried — it goes into ${ctx.start.path} when the project is added; nothing is written yet`,
          )
        }
        return append(ctx, [...installChanges(ctx, outcome.install), ...checkChanges(ctx, outcome.checks)])
      }),
  })

  // ---- tickets and kinds ---------------------------------------------------------------------------------------

  const ticketsNow = (ctx: ProjectContext): TicketSourceName =>
    ticketSourceOf(atStart(ctx, ['source', 'tickets']), ctx.answers.history ?? [])

  const tickets = entry('tickets', {
    presentation: presentation(
      'tickets',
      'project',
      (v) => {
        const r = v.resolved()
        return {
          tickets: v.get(['source', 'tickets']),
          kinds: r === null ? v.get(['source', 'kinds']) : kindsOf(r.recipe),
        }
      },
      (v) =>
        `${v.tickets === 'db' ? 'Lingtai’s table' : 'GitHub issues'} · ${Array.isArray(v.kinds) ? v.kinds.join(' › ') : ''}`,
    ),
    name: 'the ticket source',
    flag: '--tickets <github|db>',
    fromFlags: (flags) => {
      const given = flags['tickets']
      if (given === undefined) return null
      return given === 'github' || given === 'db' ? given : { refused: `${given} is not one of github, db` }
    },
    // A project with tickets in the log keeps its source and is never switched: streams numbered under one source would
    // collide with another's (#381). A local project has one legal answer.
    fixed: (ctx, flag) => {
      const history = ctx.answers.history ?? []
      const current = ticketsNow(ctx)
      if (history.length > 0) {
        const clash = sourceClashRefusal({ given: flag, project: ctx.ports.project, history, current, kept: ctx.kept })
        return clash !== null ? { refused: clash } : { answer: current }
      }
      if (ctx.ports.local) {
        return flag === 'github'
          ? {
              refused:
                'a project with no owner cannot take its tickets from GitHub — there is no repository to read issues ' +
                `from. Pass --tickets db, or leave it out. ${ctx.kept}`,
            }
          : { answer: 'db' }
      }
      return null
    },
    inForce: (ctx) => inForceOf(rerun(ctx) ? text(atStart(ctx, ['source', 'tickets'])) : null),
    systemDefault: () => Effect.succeed('github'),
    validate: choice('github', 'db'),
    write: (answer, _inForce, ctx) =>
      Effect.sync(() => {
        const decided = answer as TicketSourceName
        ctx.answers.tickets = decided
        const history = ctx.answers.history ?? []
        if (history.length > 0) {
          ctx.log.push(
            `tickets       ${decided} — kept: the log already has tickets for this project (${history.join(', ')}), ` +
              `and ${DIFFERENT_SOURCE_CLASH}`,
          )
        }
        // `source.tickets` has no schema default, so a first run writes it even where the answer is the default.
        return append(ctx, atStart(ctx, ['source', 'tickets']) === decided ? [] : [ticketsChange(decided)])
      }),
  })

  const kindsAtStart = (ctx: ProjectContext): string[] | null => {
    const resolved = startResolved(ctx)
    if (resolved !== null) return kindsOf(resolved.recipe)
    // A file that does not resolve on its own still has a `source.kinds` worth reading.
    const raw = atStart(ctx, ['source', 'kinds'])
    return Array.isArray(raw) ? raw.map((k) => String(k)) : null
  }

  const kinds = entry('kinds', {
    name: 'the kinds',
    flag: '--kinds <a,b,c>',
    fromFlags: (flags) => flags['kinds'] ?? null,
    inForce: (ctx) => inForceOf(kindsAtStart(ctx)?.join(', ') ?? null),
    systemDefault: (ctx) =>
      Effect.succeed(
        (ctx.ports.proposal?.kinds.known === true ? ctx.ports.proposal.kinds.value : SETUP_KINDS).join(', '),
      ),
    validate: (answer) => {
      const parsed = parseKinds(answer)
      return Effect.succeed(typeof parsed === 'string' ? parsed : null)
    },
    write: (answer, _inForce, ctx) =>
      Effect.sync(() => {
        const parsed = parseKinds(answer)
        if (typeof parsed === 'string') return { refused: parsed }
        const before = kindsAtStart(ctx)
        if (before !== null && before.length === parsed.length && before.every((k, i) => k === parsed[i])) {
          return append(ctx, [])
        }
        const claim = ctx.view.get(['steps', 'claim'])
        return append(ctx, kindsChanges(parsed, Array.isArray(claim) ? claim : null))
      }),
  })

  // ---- the landing and the judge -------------------------------------------------------------------------------

  const landing = entry('landing', {
    presentation: presentation(
      'approve',
      'attempt',
      (v) => {
        const proposed = v.resolved()?.recipe.steps.proposed ?? []
        return proposed.some((a) => 'human' in a)
      },
      (v) => (v ? 'you approve every attempt before it lands' : 'an attempt lands with no one asking'),
    ),
    name: 'the landing',
    flag: '--land hold (wait for me to approve) or --land <branch> (land on that branch)',
    // A team project lands where its mode says (0130 §2), so neither half is asked; `--land hold` is still honoured.
    applies: (ctx) => ctx.answers.mode !== 'team' || ctx.flags['land'] === 'hold',
    fromFlags: (flags, ctx) => {
      const land = flags['land'] ?? null
      if (ctx.answers.mode === 'team' && land !== null && land !== 'hold') {
        return {
          refused: `a team project lands on branch.personal, not on ${land} — pass --personal <branch> to name it. ${ctx.kept}`,
        }
      }
      return land
    },
    // Schema-defaulted: nothing is in force, and the default is what the answers so far resolve to, so Enter writes nothing.
    systemDefault: (ctx) =>
      Effect.sync(() => {
        const resolved = resolvedNow(ctx)
        const proposed = resolved !== null ? resolved.recipe.steps.proposed : ctx.view.get(['steps', 'proposed'])
        const holds =
          Array.isArray(proposed) && proposed.some((a) => a !== null && typeof a === 'object' && 'human' in a)
        return holds ? LANDING_WAIT : LANDING_LAND
      }),
    validate: (answer) => Effect.succeed(landingBranchRefusal(answer)),
    write: (answer, _inForce, ctx) =>
      Effect.gen(function* () {
        const resolved = resolvedNow(ctx)
        // The list as the file writes it where it writes one, so an entry is carried back as written and not pinned
        // with every schema default; the resolved list stands in where the step is inherited whole from a preset.
        const raw = ctx.view.get(['steps', 'proposed'])
        const proposed: readonly unknown[] = Array.isArray(raw) ? raw : (resolved?.recipe.steps.proposed ?? [])
        let changes: RecipeChange[]
        if (answer === LANDING_WAIT) {
          changes = landingChanges({ land: 'hold' }, proposed)
        } else if (answer === LANDING_LAND) {
          const base = resolved !== null ? branchOf(resolved.recipe) : (text(ctx.view.get(['branch', 'main'])) ?? '')
          if (base !== '') {
            // Landing on the base the recipe resolves must not pin it: only the hold's removal is kept.
            changes = holdRemovalChanges(proposed)
          } else {
            const read = yield* readDefaultBranch(ctx, '--land <branch>')
            if ('refused' in read) return { refused: `${read.refused}. ${ctx.kept}` }
            if (read.branch === null)
              return { refused: `no base branch to land on — pass --land <branch>. ${ctx.kept}` }
            changes = landOnBranchChanges(read.branch, proposed)
          }
        } else {
          // A flag answers as it is: `hold`, or a branch, even one called `wait…`.
          changes = landingChanges({ land: answer }, proposed)
          const main = ctx.view.get(['branch', 'main'])
          changes = changes.filter((c) => !(c.path.join('.') === 'branch.main' && c.value === main))
        }
        if (changes.some((c) => c.path[0] === 'steps') && ctx.view.get(['steps']) === null) {
          ctx.log.push(
            `${ctx.start.path} had no steps: of its own — writing steps.proposed pins every other ` +
              'step this file was inheriting from its preset, in the file, alongside it',
          )
        }
        return append(ctx, changes)
      }),
    row: (value) => (value === LANDING_WAIT ? 'hold for a person' : value === LANDING_LAND ? 'land unattended' : value),
  })

  const findingsJudge = entry('findings-judge', {
    presentation: presentation(
      'findings',
      'attempt',
      (v) => {
        const r = v.resolved()
        const a = r?.recipe.steps.proposed.find(
          (a) => 'judge' in a && a.when === 'findings' && !isBuiltInJudge(String(a.judge)),
        )
        return {
          judge: a !== undefined && 'judge' in a ? String(a.judge) : null,
          rounds: r === null ? null : ceilingOf(r.recipe).attempt.refusalFixes,
        }
      },
      (v) =>
        v.judge === null
          ? 'no agent judge'
          : `go back to the writer (${v.judge}) up to ${v.rounds} times — each is a judge call and another writer run`,
      9,
    ),
    name: 'the findings judge',
    flag: '(derived from the writer)',
    // After the landing, so the hold stays first in `steps.proposed`. An entry with no question: it follows the writer.
    derive: (ctx) => ctx.answers.writer ?? '',
    write: (answer, _inForce, ctx) =>
      Effect.sync(() => {
        if (answer === '') return { wrote: false }
        const proposed = ctx.view.get(['steps', 'proposed'])
        // The starting recipe's writer, never the view's: by now the view already holds the new one.
        return append(
          ctx,
          followWriterJudgeChanges(writerAtStart(ctx), answer, Array.isArray(proposed) ? proposed : null),
        )
      }),
  })

  // ---- the limits ----------------------------------------------------------------------------------------------

  const limits = (ctx: ProjectContext) => {
    const resolved = resolvedNow(ctx)
    return resolved === null ? null : ceilingOf(resolved.recipe)
  }

  const refusalFixes = entry('refusal-fixes', {
    presentation: limitPresentation('refusal fixes', (v) => {
      const r = v.resolved()
      return r === null
        ? v.get(['runtime', 'limits', 'attempt', 'refusalFixes'])
        : ceilingOf(r.recipe).attempt.refusalFixes
    }),
    name: 'refusal fixes',
    flag: '--refusal-fixes <n>',
    fromFlags: (flags) =>
      flags['rounds'] !== undefined ? { refused: ROUNDS_RETIRED } : (flags['refusal-fixes'] ?? null),
    systemDefault: (ctx) => Effect.succeed(String(limits(ctx)?.attempt.refusalFixes ?? DEFAULT_LIMITS.refusalFixes)),
    validate: (answer) => Effect.succeed(wholeNumberRefusal(answer)),
    write: (answer, _inForce, ctx) =>
      Effect.sync(() =>
        append(ctx, limits(ctx)?.attempt.refusalFixes === Number(answer) ? [] : [refusalFixesChange(Number(answer))]),
      ),
  })

  const conflictResolutions = entry('conflict-resolutions', {
    presentation: limitPresentation('conflict resolutions', (v) => {
      const r = v.resolved()
      return r === null
        ? v.get(['runtime', 'limits', 'attempt', 'conflictResolutions'])
        : ceilingOf(r.recipe).attempt.conflictResolutions
    }),
    name: 'conflict resolutions',
    flag: '--conflict-resolutions <n>',
    fromFlags: (flags) => flags['conflict-resolutions'] ?? null,
    systemDefault: (ctx) =>
      Effect.succeed(String(limits(ctx)?.attempt.conflictResolutions ?? DEFAULT_LIMITS.conflictResolutions)),
    validate: (answer) => Effect.succeed(wholeNumberRefusal(answer)),
    write: (answer, _inForce, ctx) =>
      Effect.sync(() =>
        append(
          ctx,
          limits(ctx)?.attempt.conflictResolutions === Number(answer)
            ? []
            : [conflictResolutionsChange(Number(answer))],
        ),
      ),
  })

  const wall = entry('wall', {
    presentation: limitPresentation('wall', (v) => {
      const r = v.resolved()
      return r === null ? v.get(['runtime', 'limits', 'run', 'wall']) : ceilingOf(r.recipe).run.wall
    }),
    name: 'wall',
    flag: '--wall <duration>',
    fromFlags: (flags) => flags['wall'] ?? null,
    systemDefault: (ctx) => Effect.succeed(limits(ctx)?.run.wall ?? DEFAULT_LIMITS.wall),
    validate: (answer) => Effect.succeed(wallRefusal(answer)),
    write: (answer, _inForce, ctx) =>
      Effect.sync(() => append(ctx, limits(ctx)?.run.wall === answer ? [] : [wallChange(answer)])),
  })

  const budget = entry('budget', {
    presentation: presentation(
      'budget',
      'attempt',
      (v) => {
        const r = v.resolved()
        return r === null ? v.get(['runtime', 'limits', 'run', 'usd']) : (ceilingOf(r.recipe).run.usd ?? null)
      },
      (v) => (v === null ? 'no ceiling' : `$${v}`),
    ),
    name: 'the spend ceiling',
    flag: '--budget <dollars>|none',
    fromFlags: (flags) => flags['budget'] ?? null,
    systemDefault: (ctx) => {
      const usd = limits(ctx)?.run.usd
      return Effect.succeed(usd === undefined ? 'none' : String(usd))
    },
    validate: (answer) => {
      const parsed = parseBudget(answer)
      return Effect.succeed(typeof parsed === 'string' ? parsed : null)
    },
    show: (value) => (value === 'none' ? 'none' : `$${Number(value).toFixed(2)}`),
    write: (answer, _inForce, ctx) =>
      Effect.sync(() => {
        const parsed = parseBudget(answer)
        const usd = typeof parsed === 'number' ? parsed : null
        const before = limits(ctx)?.run.usd ?? null
        const changes = (usd ?? null) === before && limits(ctx) !== null ? [] : [budgetChange(usd)]
        const result = append(ctx, changes)
        // The runtime the file names, not the schema's default: a recipe naming none runs whichever runtime this
        // machine detects, which may not be claude-code.
        const named = ctx.view.get(['runtime', 'agent'])
        if (usd !== null && named !== 'claude-code') ctx.log.push(dollarCeilingNote(named))
        return result
      }),
    row: (value) => (value === 'none' ? 'no ceiling' : `$${Number(value).toFixed(2)}`),
  })

  // ---- the last confirmation -----------------------------------------------------------------------------------

  const register = entry('register', {
    name: 'registering with these defaults',
    flag: '--defaults, or --build <cmd>|none and --land <branch>|hold to choose explicitly',
    // Only the defaults can reach registration without anyone having looked: a person who typed an answer, or named
    // `--build none` or `--land <branch>`, chose it. Team lands on the person's own branch, so nothing is unattended.
    applies: (ctx) => {
      // `no` is somebody asked for the defaults who declined them. With no terminal the switch is never asked, so
      // `undefined` is nobody having looked either, and the confirmation stands: it refuses without --defaults.
      if (ctx.answers.defaults === 'no') return false
      const resolved = resolvedNow(ctx)
      if (resolved === null) return false
      const summary = summariseRecipe(resolved.recipe)
      const unseenEmptyBuild = summary.checks.length === 0 && ctx.buildFlags.length === 0
      const unseenUnattended = ctx.answers.mode !== 'team' && summary.landsUnattended && ctx.flags['land'] === undefined
      return unseenEmptyBuild || unseenUnattended
    },
    confirm: { declined: 'stopped before registering — nothing was written and nothing was registered' },
    write: nothing,
  })

  const list: ProjectQuestion[] = [
    where,
    mode,
    login,
    branch,
    makeBranch,
    moveLanding,
    defaults,
    writer,
    writerModel,
    reviewer,
    reviewerModel,
    sandbox,
    sandboxHosts,
    install,
    checks,
    trial,
    tickets,
    kinds,
    landing,
    findingsJudge,
    refusalFixes,
    conflictResolutions,
    wall,
    budget,
    register,
  ]
  return list
}
