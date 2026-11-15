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
import { declaredSandbox, isSandboxRequiredRefusal, type DeclaredSandbox } from '@lingtai/recipe'

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
  return refused === null ? state('sandboxed') : state('unknown')
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
