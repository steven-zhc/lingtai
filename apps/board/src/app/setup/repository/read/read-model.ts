/**
 * What step 2 hands the client (#971): plain data, no value imports — the form
 * is a client component, and a client graph must not reach `@lingtai/setup`
 * (`unit/client-graph.test.ts`).
 */
import type { SetupForm } from '@lingtai/setup'

/** One line of the proposal: what it reads, and why — or that it could not be read. */
export interface LineView<T> {
  value: T
  /** The sentence beside it: `because` where it was read, the failure where it was not. */
  note: string
  known: boolean
}

export interface CheckView {
  name: string
  run: string
  /** Detected as a check and ticked; a skipped script is offered unticked, with its reason. */
  ticked: boolean
  why: string
}

export interface RuntimeView {
  id: string
  signedIn: boolean
  remedy: string | null
  /** The runtime enforces no turn count, so the recipe promises none. */
  noTurnCeiling: boolean
}

/** The sandbox step (#1160): plain data, so the client never imports `@lingtai/sandbox`. */
export interface SandboxView {
  /** `BUILT_IN_DOMAINS`, read-only. */
  builtIns: string[]
  /** The sentence for a host that cannot provide the sandbox, srt's own words included; null where it can. */
  cannot: string | null
  /** What turning it off gives up. */
  offLine: string
}

/** Everything the form starts from. */
export interface ReadView {
  project: string
  target: SetupForm['target']
  remote: string | null
  base: LineView<string>
  install: LineView<string>
  stack: LineView<string[]>
  checks: LineView<CheckView[]>
  runtimes: RuntimeView[]
  writer: LineView<string>
  reviewer: LineView<string>
  tickets: LineView<SetupForm['tickets']>
  /** Why `github` cannot be chosen (a directory has no owner), or null. */
  githubOff: string | null
  /** The log already has tickets for this project, so the source is not a choice. */
  ticketsLocked: boolean
  kinds: LineView<string[]>
  heldBy: LineView<string>
  end: LineView<boolean>
  limits: SetupForm['limits']
  /** Null where the step is not asked: a recipe that already exists, or nothing could be read. */
  sandbox: SandboxView | null
}

export type Preview = { text: string; ceiling: string } | { refused: string }
export type AddResult = { ok: true; project: string } | { ok: false; say: string }

export const KIND_DEFAULTS_NOTE =
  'A filter: nothing is warned about or created if the repository lacks one of these labels.'
