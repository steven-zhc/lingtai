/**
 * What the Sandbox tab draws (#1161), as data: no React and no reads.
 *
 * **The input is what the attempt's stream recorded, folded by `reduceAttempt` — never today's recipe.** A run from
 * before a recipe change shows the rules it ran under, so nothing here may reach for `recipe.yml`; the only thing
 * taken from `@lingtai/recipe` is the predicate that says whether a host is one the editor would accept.
 *
 * A row is one wrapped invocation (`commandId`), never one `runId`: `runId` is minted once per claim and every
 * implement, fix, review and `run:` of the attempt shares it.
 */
import type { AttemptState, SandboxInvocation } from '@lingtai/domain'
import { isNetworkEntry } from '@lingtai/recipe'
import { BUILT_IN_DOMAINS } from '@lingtai/sandbox/policy'

/** The slice of an attempt this view reads. */
export type SandboxInput = Pick<AttemptState, 'lifecycle' | 'resolved'> & {
  readonly sandbox?: readonly SandboxInvocation[] | undefined
}

/** `fail` is the fail colour, `signal` the warning one, `muted` is what a person chose, `ok` is sandboxed. */
export type Tone = 'ok' | 'muted' | 'signal' | 'fail'

export type MarkState = 'sandboxed' | 'off by choice' | 'degraded' | 'stopped' | 'not recorded'

/** The small state mark. It says *sandboxed*, never *safe*. */
export interface Mark {
  readonly state: MarkState
  readonly tone: Tone
  /** srt's own sentence, or why the run was stopped: shown beside an unsandboxed or stopped run. */
  readonly why: string | null
}

/**
 * What the row says about the refusals of one invocation. Zero is only ever drawn for `none`; the others are
 * *unknown*, and say why.
 */
export type RefusalReading =
  | { readonly kind: 'refused'; readonly count: number; readonly incomplete: boolean }
  | { readonly kind: 'none' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'lost' }
  | { readonly kind: 'unreadable'; readonly reason: string }
  | { readonly kind: 'not applicable' }

export interface RunRow {
  readonly key: string
  readonly step: string
  readonly action: string
  readonly runtime: string | null
  readonly mark: Mark
  /** *weaker network isolation*, in words, where the recorded policy says so. */
  readonly weakerNetwork: boolean
  readonly refusals: RefusalReading
}

export interface BlockedHost {
  /** The host, or srt's raw line where it had none. */
  readonly label: string
  readonly count: number
  readonly firstAt: string
  /** The invocations it came from, as `step · action`. */
  readonly from: readonly string[]
  /** `/recipe/<project>?edit=1&allow=<host>#sandbox`, or null where the recipe would not accept the host. */
  readonly allowHref: string | null
}

export interface SandboxView {
  readonly rows: readonly RunRow[]
  readonly allowed: {
    readonly writable: readonly string[]
    readonly domains: readonly { readonly host: string; readonly source: 'recipe' | 'built in' }[]
  }
  readonly limited: {
    readonly denyRead: readonly string[]
    readonly denyWrite: readonly string[]
    /** Claude Code's authentication sentence appears only where a Claude Code run is in the table. */
    readonly claudeCodeAuth: boolean
  }
  readonly blocked: {
    readonly hosts: readonly BlockedHost[]
    /** Sentences, in the fail colour, about invocations whose refusals are unknown or short. */
    readonly caveats: readonly string[]
  }
}

/** Fixed text: the three things 0.14 does not cover. */
export const NOT_COVERED: readonly string[] = [
  "Codex's login stays readable to a Codex run.",
  'srt does not report refused file access, so a refused read or write is not listed.',
  'srt is a research preview, pinned per run.',
]

export const CLAUDE_CODE_AUTH =
  'A Claude Code run is authenticated by a long-lived token of its own (decision 8); it does not read the login.'

/** The cloud-metadata addresses: never offered as an *Allow on this project*. */
export const METADATA_HOSTS: ReadonlySet<string> = new Set([
  '169.254.169.254',
  'fd00:ec2::254',
  'metadata.google.internal',
])

/** The recipe editor, opened with a host to allow. A link only: the tab never writes. */
export function allowHrefOf(project: string, host: string | null): string | null {
  if (host === null || project === '') return null
  if (METADATA_HOSTS.has(host.toLowerCase()) || !isNetworkEntry(host)) return null
  return `/recipe/${encodeURIComponent(project)}?edit=1&allow=${encodeURIComponent(host)}#sandbox`
}

export function markOf(boundary: SandboxInvocation['boundary']): Mark {
  if (boundary === null) return { state: 'not recorded', tone: 'muted', why: null }
  switch (boundary.kind) {
    case 'sandboxed':
      return { state: 'sandboxed', tone: 'ok', why: null }
    case 'refused':
      return { state: 'stopped', tone: 'fail', why: boundary.why }
    case 'unsandboxed':
      return boundary.reason === 'off by choice'
        ? { state: 'off by choice', tone: 'muted', why: null }
        : { state: 'degraded', tone: 'signal', why: boundary.why ?? null }
  }
}

const isOver = (lifecycle: AttemptState['lifecycle']) =>
  lifecycle.status === 'finished' || lifecycle.status === 'failed'

function readingOf(i: SandboxInvocation, over: boolean): RefusalReading {
  if (i.refusals !== null) {
    if (i.refusals.kind === 'unreadable') return { kind: 'unreadable', reason: i.refusals.reason }
    // Telemetry is recorded and not counted: *Blocked* would never be empty otherwise.
    const count = i.refusals.entries.filter((e) => !e.telemetry).reduce((n, e) => n + e.count, 0)
    return count === 0 && i.refusals.complete
      ? { kind: 'none' }
      : { kind: 'refused', count, incomplete: !i.refusals.complete }
  }
  // Nothing is appended when nothing was refused, so absence means *none* only once the read has happened.
  if (i.boundary === null || i.boundary.kind !== 'sandboxed') return { kind: 'not applicable' }
  if (i.ended) return { kind: 'none' }
  return over ? { kind: 'lost' } : { kind: 'pending' }
}

const labelOf = (i: Pick<SandboxInvocation, 'step' | 'action'>) => `${i.step} · ${i.action}`

/**
 * The domain set is the recorded one; *built in* is classified against today's built-in list, because the recorded
 * policy carries no source. Everything else is the project's own additions, so *recipe* is the honest word.
 */
const sourceOf = (host: string): 'recipe' | 'built in' => (BUILT_IN_DOMAINS.includes(host) ? 'built in' : 'recipe')

const union = (lists: readonly (readonly string[])[]): string[] => [...new Set(lists.flat())]

export function sandboxViewOf(input: SandboxInput, project: string): SandboxView {
  const over = isOver(input.lifecycle)
  const recorded = input.sandbox ?? []

  const rows: RunRow[] = recorded.map((i) => ({
    key: i.commandId,
    step: i.step,
    action: i.action,
    runtime: i.runtime ?? null,
    mark: markOf(i.boundary),
    weakerNetwork: i.boundary?.kind === 'sandboxed' && i.boundary.policy.weakerNetworkIsolation,
    refusals: readingOf(i, over),
  }))

  // A planned action of a finished attempt with no record ran before S8, or lost its record: *not recorded*. The
  // merge is Lingtai's own and runs outside the sandbox, so it is not a gap.
  if (over) {
    for (const s of input.resolved?.steps ?? []) {
      if (s.step === 'merge') continue
      for (const action of s.actions) {
        if (recorded.some((i) => i.step === s.step && i.action === action)) continue
        rows.push({
          key: `unrecorded:${s.step}:${action}`,
          step: s.step,
          action,
          runtime: null,
          mark: markOf(null),
          weakerNetwork: false,
          refusals: { kind: 'not applicable' },
        })
      }
    }
  }

  const policies = recorded.flatMap((i) => (i.boundary?.kind === 'sandboxed' ? [i.boundary.policy] : []))
  const domains = union(policies.map((p) => p.allowedDomains)).map((host) => ({ host, source: sourceOf(host) }))

  const byHost = new Map<string, { count: number; firstAt: string; host: string | null; from: Set<string> }>()
  const caveats: string[] = []
  for (const i of recorded) {
    const reading = readingOf(i, over)
    const who = labelOf(i)
    if (reading.kind === 'unreadable') caveats.push(`${who}: the refusals could not be read (${reading.reason}).`)
    if (reading.kind === 'refused' && reading.incomplete)
      caveats.push(`${who}: srt's store evicted entries, so this list is a lower bound.`)
    if (reading.kind === 'lost') caveats.push(`${who}: refusals were not read — the run ended inside this step.`)
    if (i.refusals === null || i.refusals.kind !== 'entries') continue
    for (const e of i.refusals.entries) {
      if (e.telemetry) continue
      const key = e.host ?? e.line ?? 'unknown address'
      const at = byHost.get(key) ?? { count: 0, firstAt: e.firstAt, host: e.host, from: new Set<string>() }
      at.count += e.count
      if (Date.parse(e.firstAt) < Date.parse(at.firstAt)) at.firstAt = e.firstAt
      at.from.add(who)
      byHost.set(key, at)
    }
  }
  const hosts: BlockedHost[] = [...byHost].map(([label, h]) => ({
    label,
    count: h.count,
    firstAt: h.firstAt,
    from: [...h.from],
    allowHref: allowHrefOf(project, h.host),
  }))

  return {
    rows,
    allowed: { writable: union(policies.map((p) => p.allowWrite)), domains },
    limited: {
      denyRead: union(policies.map((p) => p.denyRead)),
      denyWrite: union(policies.map((p) => p.denyWrite)),
      claudeCodeAuth: recorded.some((i) => i.runtime === 'claude-code'),
    },
    blocked: { hosts, caveats },
  }
}

/** The state mark of the latest recorded invocation of `step:action`, for the attempt tab's `.acts` list; null where none. */
export function markOfAction(
  sandbox: readonly SandboxInvocation[] | undefined,
  step: string,
  action: string,
): Mark | null {
  const latest = (sandbox ?? []).filter((i) => i.step === step && i.action === action).at(-1)
  return latest === undefined ? null : markOf(latest.boundary)
}
