import type { ProjectState } from '@lingtai/domain'
/**
 * What a project's sandbox is doing, as one of four states (#1163), drawn as the icon beside Report.
 *
 * **Pure**: it reads nothing and asks no host. The three facts are two fields of one reduce of `prj-<project>`
 * (0128 §5): the standing refusal, the declared recipe's `sandbox:` block, and the sandbox its runs last met.
 * No attempt stream, no `rcp-`, no walk. It imports no store, so `Bar`, the filter and the cards (#1166, #1167)
 * can all import it, as `lock-marks.ts` is split from `locks.ts`.
 *
 * The four are states and not levels: *off* is grey and never an alarm. `unknown` and `unreadable` are what
 * cannot be said, and are never drawn as *sandboxed*.
 */
import { declaredSandbox, isSandboxRequiredRefusal, sandboxRequiredReason, type DeclaredSandbox } from '@lingtai/recipe'

export type SandboxStateName = 'stopped' | 'degraded' | 'unreadable' | 'unknown' | 'off' | 'sandboxed'

export interface SandboxFacts {
  /** `ProjectState.refused?.detail`: null when nothing refuses. */
  refused: string | null
  /** The recorded recipe's `sandbox:` block; `'none'` when no recipe is recorded yet. */
  declared: 'none' | DeclaredSandbox
  /** `ProjectState.sandboxObserved?.kind`: null when no run has met a sandbox. */
  observed: 'sandboxed' | 'degraded' | 'off by choice' | null
}

export interface SandboxState {
  state: SandboxStateName
  /** The tooltip and accessible name, one sentence. */
  sentence: string
}

export const SENTENCES: Record<SandboxStateName, string> = {
  stopped: 'stopped: the recipe requires a sandbox and this machine cannot provide one',
  degraded: 'degraded: the last run went without a sandbox because none was available',
  unreadable: 'the sandbox state could not be read',
  unknown: 'not yet known: no recipe has been recorded for this project',
  off: 'off by choice: the recipe asks for no sandbox',
  sandboxed: 'sandboxed',
}

/** Unknown with a recipe recorded: another refusal stands and no run has met a sandbox. */
export const UNKNOWN_WHILE_REFUSED =
  'not yet known: the project is refused for another reason, and no run has met a sandbox'

const state = (name: SandboxStateName): SandboxState => ({ state: name, sentence: SENTENCES[name] })

/** The facts a `ProjectState` holds, with nothing read beyond it. */
export const sandboxFactsOf = (p: ProjectState): SandboxFacts => ({
  refused: p.refused?.detail ?? null,
  declared: p.recipe === null ? 'none' : declaredSandbox(p.recipe.source),
  observed: p.sandboxObserved?.kind ?? null,
})

/** The table of #1163, top to bottom: the first row that matches. */
export function sandboxState(facts: SandboxFacts): SandboxState {
  const { refused, declared, observed } = facts
  if (refused !== null && isSandboxRequiredRefusal(refused)) return state('stopped')
  if (declared === 'none') return state('unknown')
  if (declared.kind === 'unreadable') return state('unreadable')
  // The recipe as it stands beats an older run's record: turned off after a degraded run reads off.
  if (declared.block === undefined || !declared.block.enabled) return state('off')
  if (observed === 'degraded') return state('degraded')
  if (observed === 'sandboxed') return state('sandboxed')
  // No record, or an `off by choice` run from before the block was enabled: sandboxed while nothing refuses, and
  // not known while some other refusal (a broken recipe, not a host) stands.
  if (refused === null) return state('sandboxed')
  // A recipe is recorded: the cause is the other refusal, never a missing recipe.
  return { state: 'unknown', sentence: UNKNOWN_WHILE_REFUSED }
}

/** A shape per state, so colour is never the only difference: tick, exclamation, cross, question; off is an empty outline. Stroked path data in the shield's 16×16 box (#1183). */
export const GLYPH: Record<SandboxStateName, string> = {
  sandboxed: 'M5.5 7.9 7.3 9.7 10.6 6.2',
  degraded: 'M8 5.1V8.3M8 10.5V10.6',
  stopped: 'M6.1 6.1 9.9 9.9M9.9 6.1 6.1 9.9',
  off: '',
  unknown: 'M6.4 6.2A1.65 1.65 0 1 1 8.9 7.6C8.3 8 8 8.3 8 8.9M8 10.6V10.7',
  unreadable: 'M6.4 6.2A1.65 1.65 0 1 1 8.9 7.6C8.3 8 8 8.3 8 8.9M8 10.6V10.7',
}

/** Each named project's state, from the register a page already holds (#1166). Unnamed projects are skipped. */
export function sandboxStates(projects: readonly ProjectState[]): ReadonlyMap<string, SandboxState> {
  const states = new Map<string, SandboxState>()
  for (const p of projects) {
    if (p.project === null) continue
    states.set(p.project, sandboxState(sandboxFactsOf(p)))
  }
  return states
}

/** How much each state needs a person, worst first. `unreadable` is not ranked: it is counted beside the rest. */
const RANK: readonly SandboxStateName[] = ['stopped', 'degraded', 'unknown', 'off', 'sandboxed']

export interface SandboxMark {
  state: SandboxStateName
  /** Every project holding the worst state, with its own sentence, ordered by name. */
  projects: readonly { project: string; sentence: string }[]
  /** Projects whose state could not be read, ordered by name. */
  unreadable: readonly string[]
  /** The icon's tooltip and accessible name. */
  sentence: string
}

/** The worst state across `states`, and the projects that hold it. Undefined when there are none. */
export function worstOf(states: ReadonlyMap<string, SandboxState>): SandboxMark | undefined {
  const entries = [...states].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const unreadable = entries.filter(([, s]) => s.state === 'unreadable').map(([project]) => project)
  const worst =
    RANK.find((name) => entries.some(([, s]) => s.state === name)) ?? (unreadable.length > 0 ? 'unreadable' : undefined)
  if (worst === undefined) return undefined
  const projects = entries
    .filter(([, s]) => s.state === worst)
    .map(([project, s]) => ({ project, sentence: s.sentence }))
  let sentence =
    projects.length === 1 ? `sandbox ${projects[0]!.sentence}` : `sandbox ${worst}: ${projects.length} projects`
  if (worst !== 'unreadable' && unreadable.length > 0) sentence += `; ${unreadable.length} could not be read`
  return { state: worst, projects, unreadable: worst === 'unreadable' ? [] : unreadable, sentence }
}

/**
 * One row under the bar (#1167). `stopped` and `degraded` only: *off by choice* is a decision and never a banner,
 * and `unknown` / `unreadable` are what cannot be said, which the icon says.
 */
export interface SandboxBannerRow {
  kind: 'stopped' | 'degraded'
  project: string
  /** Stopped: the host's own reason, or the fixed sentence when the refusal's shape is not the known one. Degraded: the fixed sentence (the observation carries no *why*). */
  reason: string
}

/** The banner rows for the projects in `scope`, in the order given. Pure. */
export function sandboxBannerRows(
  projects: readonly { project: string; facts: SandboxFacts }[],
  scope: string | undefined,
): SandboxBannerRow[] {
  const rows: SandboxBannerRow[] = []
  for (const { project, facts } of projects) {
    if (scope !== undefined && project !== scope) continue
    const { state: name } = sandboxState(facts)
    if (name === 'stopped') {
      rows.push({
        kind: 'stopped',
        project,
        reason: (facts.refused === null ? undefined : sandboxRequiredReason(facts.refused)) ?? SENTENCES.stopped,
      })
    } else if (name === 'degraded') {
      rows.push({ kind: 'degraded', project, reason: SENTENCES.degraded })
    }
  }
  return rows
}

/** What a health sentence says about stopped projects, or null when none stands (#1167). */
export function stoppedProjects(
  projects: readonly { project: string; facts: SandboxFacts }[],
  scope: string | undefined,
): string[] {
  return sandboxBannerRows(projects, scope)
    .filter((r) => r.kind === 'stopped')
    .map((r) => r.project)
}

/**
 * How many sandbox rows each scope drew at its last render (`''` is *all projects*), so the slot's skeleton can be
 * as many as will replace it. Per process, like `lastOffered`. **Before any answer it is 0, not a guess**: these
 * rows are absent in the ordinary case, and a placeholder would move the page there.
 */
const lastRows = new Map<string, number>()

export const lastSandboxRows = (scope: string | undefined): number => lastRows.get(scope ?? '') ?? 0
export const rememberSandboxRows = (scope: string | undefined, n: number): void => void lastRows.set(scope ?? '', n)
export const forgetSandboxRows = (): void => lastRows.clear()
