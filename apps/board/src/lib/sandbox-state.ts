/**
 * What a project's sandbox is doing, as one of four states (#1163), drawn as the icon beside Report.
 *
 * **Pure**: it reads nothing and asks no host. The three facts come from the log — the project's standing
 * refusal (`ProjectState.refused`, already cleared by a later `ProjectRecovered`), the recipe it last recorded
 * (`rcp-<hash>`), and the latest `SandboxBoundaryRecorded` of its newest pass — and are handed in, so `Bar`,
 * the filter and the cards (#1166, #1167) can all import this without reaching the store, as `lock-marks.ts`
 * is split from `locks.ts`.
 *
 * The four are states and not levels: *off* is grey and never an alarm. `unknown` is the fifth value the code
 * needs for what cannot be said — a failed read, no pass yet — and is never drawn as *sandboxed*.
 */
import { isSandboxRequiredRefusal } from '@lingtai/recipe'

export type SandboxStateName = 'stopped' | 'degraded' | 'unknown' | 'off' | 'sandboxed'

/** The boundary of a pass's latest `SandboxBoundaryRecorded`, as far as this reads it. */
export type BoundaryFact =
  | { kind: 'sandboxed' }
  | { kind: 'unsandboxed'; reason: 'off by choice' | 'degraded' }
  | { kind: 'refused' }

export interface SandboxFacts {
  /** `ProjectState.refused?.detail`: null when nothing refuses. */
  refused: string | null
  /** The recorded recipe's `sandbox` block: `undefined` for no block, `null` when no recipe was recorded yet. */
  block: { enabled?: unknown } | undefined | null
  /** The newest pass's latest boundary record, `null` when there is none. */
  boundary: BoundaryFact | null
}

export interface SandboxState {
  state: SandboxStateName
  /** The tooltip and accessible name, one sentence. */
  sentence: string
}

const SENTENCES: Record<SandboxStateName, string> = {
  stopped: 'stopped: the recipe requires a sandbox and this machine cannot provide one',
  degraded: 'degraded: the last run went without a sandbox because none was available',
  unknown: 'not yet known: no run has recorded a sandbox boundary',
  off: 'off by choice: the recipe asks for no sandbox',
  sandboxed: 'sandboxed',
}

const state = (name: SandboxStateName): SandboxState => ({ state: name, sentence: SENTENCES[name] })

export function sandboxState(facts: SandboxFacts): SandboxState {
  if (facts.refused !== null && isSandboxRequiredRefusal(facts.refused)) return state('stopped')
  // The recipe as it stands beats an older run's record: turned off after a degraded run reads off.
  if (facts.block === undefined || (facts.block !== null && facts.block.enabled === false)) return state('off')
  const b = facts.boundary
  if (b?.kind === 'unsandboxed') return state(b.reason === 'degraded' ? 'degraded' : 'off')
  // A `refused` record with no standing refusal is an old one a recovery has since cleared: not *stopped*.
  if (b?.kind === 'sandboxed') return state('sandboxed')
  return state('unknown')
}

/** How much each state needs a person, worst first. Off ranks above sandboxed so *all* never claims sandboxed. */
const RANK: readonly SandboxStateName[] = ['stopped', 'degraded', 'unknown', 'off', 'sandboxed']

export interface SandboxMark {
  state: SandboxStateName
  /** Every project holding the worst state, with its own sentence, ordered by name. */
  projects: readonly { project: string; sentence: string }[]
  /** The icon's tooltip and accessible name. */
  sentence: string
}

/** The worst state across `states`, and the projects that hold it. Undefined when there are none. */
export function worstOf(states: ReadonlyMap<string, SandboxState>): SandboxMark | undefined {
  const entries = [...states].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const worst = RANK.find((name) => entries.some(([, s]) => s.state === name))
  if (worst === undefined) return undefined
  const projects = entries
    .filter(([, s]) => s.state === worst)
    .map(([project, s]) => ({ project, sentence: s.sentence }))
  const sentence =
    projects.length === 1 ? `sandbox ${projects[0]!.sentence}` : `sandbox ${worst}: ${projects.length} projects`
  return { state: worst, projects, sentence }
}
