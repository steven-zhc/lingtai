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

type SandboxPolicy = Extract<NonNullable<SandboxInvocation['boundary']>, { kind: 'sandboxed' }>['policy']

/** The slice of an attempt this view reads. */
export type SandboxInput = Pick<AttemptState, 'lifecycle' | 'resolved' | 'steps'> & {
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
  | { readonly kind: 'none recorded' }
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
  /** The srt version that enforced this run's boundary; null where it was not sandboxed or not recorded. */
  readonly srtVersion: string | null
  /** The 1-based number of the `PolicyGroup` this invocation ran under; null where it was not sandboxed. */
  readonly policy: number | null
  readonly refusals: RefusalReading
}

/**
 * One recorded policy and the invocations that ran under it. Policies are never merged across invocations: a path one
 * run could write is not one another could, and a reader must be able to tell which.
 */
export interface PolicyGroup {
  /** The invocations, as `step · action · runtime`, that ran under exactly this policy. */
  readonly runs: readonly string[]
  readonly srtVersion: string
  readonly writable: readonly string[]
  readonly domains: readonly { readonly host: string; readonly source: 'recipe' | 'built in' }[]
  /** A root that cannot be read, with the paths inside it the policy allows reading again. */
  readonly denyRead: readonly { readonly path: string; readonly except: readonly string[] }[]
  readonly denyWrite: readonly string[]
  readonly weakerNetwork: boolean
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
  readonly policies: readonly PolicyGroup[]
  /** Claude Code's authentication sentence appears only where a Claude Code run is in the table. */
  readonly claudeCodeAuth: boolean
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
      ? { kind: 'none recorded' }
      : { kind: 'refused', count, incomplete: !i.refusals.complete }
  }
  // Nothing is appended when nothing was refused, and nothing either when the append failed (the conductor swallows
  // that), so even after the step ended absence is *none recorded* and never *none refused*.
  if (i.boundary === null || i.boundary.kind !== 'sandboxed') return { kind: 'not applicable' }
  if (i.ended) return { kind: 'none recorded' }
  return over ? { kind: 'lost' } : { kind: 'pending' }
}

const labelOf = (i: Pick<SandboxInvocation, 'step' | 'action' | 'runtime'>) =>
  `${i.step} · ${i.action}${i.runtime === undefined ? '' : ` · ${i.runtime}`}`

/**
 * The domain set is the recorded one; *built in* is classified against today's built-in list, because the recorded
 * policy carries no source. Everything else is the project's own additions, so *recipe* is the honest word.
 */
const sourceOf = (host: string): 'recipe' | 'built in' => (BUILT_IN_DOMAINS.includes(host) ? 'built in' : 'recipe')

const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)

function groupsOf(
  recorded: readonly SandboxInvocation[],
): { group: PolicyGroup; key: string; commandIds: Set<string> }[] {
  const byKey = new Map<string, { runs: Set<string>; commandIds: Set<string>; policy: SandboxPolicy }>()
  for (const i of recorded) {
    if (i.boundary?.kind !== 'sandboxed') continue
    const key = JSON.stringify(i.boundary.policy)
    const at = byKey.get(key) ?? { runs: new Set<string>(), commandIds: new Set<string>(), policy: i.boundary.policy }
    at.runs.add(labelOf(i))
    at.commandIds.add(i.commandId)
    byKey.set(key, at)
  }
  return [...byKey].map(([key, { runs, commandIds, policy: p }]) => ({
    key,
    commandIds,
    group: {
      runs: [...runs],
      srtVersion: p.srtVersion,
      writable: p.allowWrite,
      domains: p.allowedDomains.map((host) => ({ host, source: sourceOf(host) })),
      // `allowRead` re-allows paths inside a denied root: dropping it would call the whole root unreadable.
      denyRead: p.denyRead.map((path) => ({ path, except: p.allowRead.filter((a) => a !== path && within(a, path)) })),
      denyWrite: p.denyWrite,
      weakerNetwork: p.weakerNetworkIsolation,
    },
  }))
}

export function sandboxViewOf(input: SandboxInput, project: string): SandboxView {
  const over = isOver(input.lifecycle)
  const recorded = input.sandbox ?? []

  const groups = groupsOf(recorded)
  const policyOf = (id: string) => {
    const at = groups.findIndex((g) => g.commandIds.has(id))
    return at === -1 ? null : at + 1
  }
  const rows: RunRow[] = recorded.map((i) => ({
    key: i.commandId,
    step: i.step,
    action: i.action,
    runtime: i.runtime ?? null,
    mark: markOf(i.boundary),
    weakerNetwork: i.boundary?.kind === 'sandboxed' && i.boundary.policy.weakerNetworkIsolation,
    srtVersion: i.boundary?.kind === 'sandboxed' ? i.boundary.policy.srtVersion : null,
    policy: policyOf(i.commandId),
    refusals: readingOf(i, over),
  }))

  const caveats: string[] = []
  // An action the attempt reached with no record ran before S8, or lost its record: *not recorded*. A planned action
  // that never ran is not a gap, and the merge is Lingtai's own and runs outside the sandbox.
  for (const s of input.resolved?.steps ?? []) {
    if (s.step === 'merge') continue
    for (const action of s.actions) {
      // Only `run:` and `agent:` launch a wrapped process; a human approval or a watch reached with no record is no gap.
      const plugin = input.steps[`${s.step}:${action}`]?.plugin
      if (plugin !== 'run' && plugin !== 'agent') continue
      if (recorded.some((i) => i.step === s.step && i.action === action)) continue
      rows.push({
        key: `unrecorded:${s.step}:${action}`,
        step: s.step,
        action,
        runtime: null,
        mark: markOf(null),
        weakerNetwork: false,
        srtVersion: null,
        policy: null,
        refusals: { kind: 'not applicable' },
      })
      caveats.push(`${s.step} · ${action}: no sandbox record, so what it was refused is unknown.`)
    }
  }
  if (recorded.length === 0 && caveats.length === 0)
    caveats.push('No sandbox record exists for this attempt, so what it was refused is unknown.')
  if (rows.some((r) => r.refusals.kind === 'none recorded'))
    caveats.push(
      'Where no refusal is listed, none was recorded; a refusal whose record failed to append would not show here.',
    )

  const byHost = new Map<string, { count: number; firstAt: string; host: string | null; from: Set<string> }>()
  for (const i of recorded) {
    const reading = readingOf(i, over)
    const who = labelOf(i)
    if (reading.kind === 'unreadable') caveats.push(`${who}: the refusals could not be read (${reading.reason}).`)
    if (reading.kind === 'refused' && reading.incomplete)
      caveats.push(`${who}: srt's store evicted entries, so this list is a lower bound.`)
    if (reading.kind === 'lost') caveats.push(`${who}: refusals were not read — the run ended inside this step.`)
    if (reading.kind === 'pending') caveats.push(`${who}: refusals are read when the run ends, so none are listed yet.`)
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
    policies: groups.map((g) => g.group),
    claudeCodeAuth: recorded.some((i) => i.runtime === 'claude-code'),
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
