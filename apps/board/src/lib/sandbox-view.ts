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
import { type AttemptState, type SandboxInvocation } from '@lingtai/domain'
import { isNetworkEntry } from '@lingtai/recipe'
import { BUILT_IN_DOMAIN_VENDORS } from '@lingtai/sandbox/policy'

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
  | { readonly kind: 'none refused' }
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
  /** Which of several invocations sharing this step, action and runtime this is (1-based); null where it is the only one. */
  readonly ordinal: number | null
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
  /** `source` is what the run recorded: `not recorded` for a policy from before the record carried it. */
  readonly domains: readonly { readonly host: string; readonly source: 'built in' | 'recipe' | 'not recorded' }[]
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
  /** The invocations it came from, as `step · action · runtime`, numbered where several share one. */
  readonly from: readonly string[]
  /** `/recipe/<project>?edit=1&allow=<host>#sandbox`, or null where the recipe would not accept the host. */
  readonly allowHref: string | null
}

export interface SandboxView {
  readonly rows: readonly RunRow[]
  readonly policies: readonly PolicyGroup[]
  /** Claude Code's authentication sentence appears only where a *sandboxed* Claude Code run is in the table. */
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
  'A sandboxed Claude Code run is authenticated by a long-lived token of its own (decision 8); it does not read the login. An unsandboxed Claude Code run is not covered by this.'

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

// `failed` is not here: an attempt may be continued after a RunFailed, so a failure is read per invocation (`lost`).
const isOver = (lifecycle: AttemptState['lifecycle']) => lifecycle.status === 'finished'

function readingOf(i: SandboxInvocation, over: boolean): RefusalReading {
  if (i.refusals !== null) {
    if (i.refusals.kind === 'unreadable') return { kind: 'unreadable', reason: i.refusals.reason }
    // Telemetry is recorded and not counted: *Blocked* would never be empty otherwise.
    const count = i.refusals.entries.filter((e) => !e.telemetry).reduce((n, e) => n + e.count, 0)
    // A complete read with nothing but telemetry is a confirmed empty result, not a missing record.
    return count === 0 && i.refusals.complete
      ? { kind: 'none refused' }
      : { kind: 'refused', count, incomplete: !i.refusals.complete }
  }
  // Nothing is appended when nothing was refused, and nothing either when the append failed (the conductor swallows
  // that), so even after the step ended absence is *none recorded* and never *none refused*.
  if (i.boundary === null || i.boundary.kind !== 'sandboxed') return { kind: 'not applicable' }
  if (i.ended) return { kind: 'none recorded' }
  // `i.lost`: a RunFailed arrived while it was open; a later invocation of a continued attempt is still running.
  return over || i.lost === true ? { kind: 'lost' } : { kind: 'pending' }
}

const labelOf = (i: Pick<SandboxInvocation, 'step' | 'action' | 'runtime'>) =>
  `${i.step} · ${i.action}${i.runtime === undefined ? '' : ` · ${i.runtime}`}`

/**
 * What names one invocation to a reader: its label, numbered where several share it. A label is never identity: the
 * implement round and a fix round invoke the same action and runtime.
 */
function refsOf(recorded: readonly SandboxInvocation[]): {
  ref: (i: SandboxInvocation) => string
  ordinal: (i: SandboxInvocation) => number | null
} {
  const sharing = new Map<string, string[]>()
  for (const i of recorded) sharing.set(labelOf(i), [...(sharing.get(labelOf(i)) ?? []), i.commandId])
  const ordinal = (i: SandboxInvocation) => {
    const ids = sharing.get(labelOf(i)) ?? []
    return ids.length < 2 ? null : ids.indexOf(i.commandId) + 1
  }
  return { ordinal, ref: (i) => (ordinal(i) === null ? labelOf(i) : `${labelOf(i)} #${ordinal(i)}`) }
}

/** Where the invocation's own record says a domain came from; never today's built-in list. */
const sourceOf = (policy: SandboxPolicy, host: string): 'built in' | 'recipe' | 'not recorded' =>
  policy.recipeDomains === undefined ? 'not recorded' : policy.recipeDomains.includes(host) ? 'recipe' : 'built in'

const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)

function groupsOf(
  recorded: readonly SandboxInvocation[],
  ref: (i: SandboxInvocation) => string,
): { group: PolicyGroup; key: string; commandIds: Set<string> }[] {
  const byKey = new Map<string, { runs: Set<string>; commandIds: Set<string>; policy: SandboxPolicy }>()
  for (const i of recorded) {
    if (i.boundary?.kind !== 'sandboxed') continue
    const key = JSON.stringify(i.boundary.policy)
    const at = byKey.get(key) ?? { runs: new Set<string>(), commandIds: new Set<string>(), policy: i.boundary.policy }
    at.runs.add(ref(i))
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
      domains: p.allowedDomains.map((host) => ({ host, source: sourceOf(p, host) })),
      // `allowRead` re-allows paths inside a denied root: dropping it would call the whole root unreadable.
      denyRead: p.denyRead.map((path) => ({ path, except: p.allowRead.filter((a) => a !== path && within(a, path)) })),
      denyWrite: p.denyWrite,
      weakerNetwork: p.weakerNetworkIsolation,
    },
  }))
}

/**
 * The plugins whose actions launch a wrapped process, so whose reached action must have a boundary record:
 * `run:` commands (`sandboxFor`/`recordUnwrapped`, conduct.ts) and `agent:` actions at implement and fix
 * rounds (conduct.ts). Judges record under `proposed` and appear as recorded rows, never as fallbacks.
 */
export const WRAPPING_PLUGINS: readonly string[] = ['run', 'agent']

/**
 * `superseded`: a later attempt exists, so this attempt's claim ended (a conductor killed mid-run is reconciled by a
 * release on the ticket, not by an event on this stream) and no invocation of it is still running.
 */
export function sandboxViewOf(input: SandboxInput, project: string, superseded = false): SandboxView {
  const over = isOver(input.lifecycle) || superseded
  const recorded = input.sandbox ?? []
  const { ref, ordinal } = refsOf(recorded)

  const groups = groupsOf(recorded, ref)
  const policyOf = (id: string) => {
    const at = groups.findIndex((g) => g.commandIds.has(id))
    return at === -1 ? null : at + 1
  }
  const rows: RunRow[] = recorded.map((i) => ({
    key: i.commandId,
    step: i.step,
    action: i.action,
    runtime: i.runtime ?? null,
    ordinal: ordinal(i),
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
      // A human approval or a watch reached with no record is no gap: it never launched a wrapped process.
      // (#1153's base check records its boundary on `BaseChecked` on the `int-` stream, not here; no row for it.)
      const plugin = input.steps[`${s.step}:${action}`]?.plugin
      if (plugin === undefined || !WRAPPING_PLUGINS.includes(plugin)) continue
      if (recorded.some((i) => i.step === s.step && i.action === action)) continue
      rows.push({
        key: `unrecorded:${s.step}:${action}`,
        step: s.step,
        action,
        runtime: null,
        ordinal: null,
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
    const who = ref(i)
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
    claudeCodeAuth: recorded.some((i) => i.runtime === 'claude-code' && i.boundary?.kind === 'sandboxed'),
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

// ---------------------------------------------------------------------------------------------------------------
// The redrawn tab (#1196): what is drawn above the policies, and the policies once. All pure.
// ---------------------------------------------------------------------------------------------------------------

/** `A` for the first policy, `B` for the second, … `Z`, then `AA`: a long attempt never runs out of letters. */
export function policyLetter(n: number): string {
  let out = ''
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) out = String.fromCharCode(65 + ((k - 1) % 26)) + out
  return out
}

/** `HH:MM:SS UTC` of an ISO time; the string as it came where it does not parse. */
export function clockOf(iso: string): string {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? iso : `${at.toISOString().slice(11, 19)} UTC`
}

export type SummaryState = 'none' | 'all' | 'some' | 'off'

export interface Summary {
  readonly state: SummaryState
  readonly sandboxed: number
  readonly total: number
  readonly tone: Tone
  /** The first reason a run was stopped or went unsandboxed, a stopped run's first. */
  readonly why: string | null
  /** The one srt version every sandboxed run shares, `'differs'` where they do not, null where none is recorded. */
  readonly srt: string | 'differs' | null
  /**
   * **An unknown is never a number.** `orMore` is set by an incomplete read or by a run whose refusals are pending,
   * lost or unreadable; `unknownRuns` counts the latter. `none recorded` is the ordinary state of a clean run, but it
   * is also what a failed append leaves, so it adds nothing to `count` and is counted in `unrecordedRuns`: a total is
   * confirmed only where that is zero.
   */
  readonly refused: {
    readonly count: number
    readonly orMore: boolean
    readonly unknownRuns: number
    readonly unrecordedRuns: number
  }
}

export function summaryOf(rows: readonly RunRow[]): Summary {
  const total = rows.length
  const sandboxed = rows.filter((r) => r.mark.state === 'sandboxed').length
  const stopped = rows.filter((r) => r.mark.state === 'stopped')
  const recorded = rows.filter((r) => r.mark.state !== 'not recorded')
  const state: SummaryState =
    total === 0
      ? 'none'
      : sandboxed === total
        ? 'all'
        : sandboxed === 0 && recorded.length > 0 && recorded.every((r) => r.mark.state === 'off by choice')
          ? 'off'
          : 'some'
  const tone: Tone = state === 'all' ? 'ok' : state === 'off' ? 'muted' : stopped.length > 0 ? 'fail' : 'signal'
  const why = [...stopped, ...rows].find((r) => r.mark.why !== null)?.mark.why ?? null
  const versions = new Set(rows.flatMap((r) => (r.srtVersion === null ? [] : [r.srtVersion])))
  let count = 0
  let orMore = false
  let unknownRuns = 0
  let unrecordedRuns = 0
  for (const { refusals: f } of rows) {
    if (f.kind === 'none recorded') unrecordedRuns += 1
    if (f.kind === 'refused') {
      count += f.count
      if (f.incomplete) orMore = true
    } else if (f.kind === 'pending' || f.kind === 'lost' || f.kind === 'unreadable') {
      orMore = true
      unknownRuns += 1
    }
  }
  return {
    state,
    sandboxed,
    total,
    tone,
    why,
    srt: versions.size === 0 ? null : versions.size === 1 ? [...versions][0]! : 'differs',
    refused: { count, orMore, unknownRuns, unrecordedRuns },
  }
}

/** The directories a short name stands for. Supplied by the loader: this module reads no environment. */
export interface PathRoots {
  readonly home: string
  readonly lingtaiHome: string
  readonly project: string
}

export interface Chip {
  readonly label: string
  /** Every full spelling, `/private` twin included. */
  readonly fulls: readonly string[]
  /** The short name's token and the directory it stood for here; null where the path is drawn as it is. */
  readonly token: string | null
  readonly prefix: string | null
  /** Set on a folded chip: how many paths it stands for, and the chips it replaced. */
  readonly folded?: number
  readonly members?: readonly Chip[]
}

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p)

/**
 * The short name of a path. Longest prefix wins; a prefix matches only at a `/`; a path equal to its prefix is the bare
 * token; a path matching none is itself, and so is a temp path (the board's `$TMPDIR` is not proven to be the daemon's).
 */
export function shortNameOf(path: string, roots: PathRoots): Pick<Chip, 'label' | 'token' | 'prefix'> {
  const lh = trimSlash(roots.lingtaiHome)
  const home = trimSlash(roots.home)
  const rest = (prefix: string) => path.slice(prefix.length)
  const worktrees = `${lh}/worktrees/${roots.project}/`
  if (lh !== '' && roots.project !== '' && path.startsWith(worktrees)) {
    const segment = path.slice(worktrees.length).split('/')[0]!
    if (segment !== '') {
      const prefix = `${worktrees}${segment}`
      return { label: `<worktree>${rest(prefix)}`, token: '<worktree>', prefix }
    }
  }
  const runs = `${lh}/runs/`
  if (lh !== '' && path.startsWith(runs)) {
    const segment = path.slice(runs.length).split('/')[0]!
    if (segment !== '') {
      const prefix = `${runs}${segment}`
      return { label: `<run dir>${rest(prefix)}`, token: '<run dir>', prefix }
    }
  }
  const candidates: [string, string][] = [
    ['<mirror>', `${lh}/repos/${roots.project}.git`],
    ['<cache>', `${lh}/cache/${roots.project}`],
    ['<lingtai home>', lh],
    ['~', home],
  ]
  for (const [token, prefix] of candidates) {
    if (prefix === '' || prefix === '/') continue
    if (roots.project === '' && (token === '<mirror>' || token === '<cache>')) continue
    if (within(path, prefix)) return { label: `${token}${rest(prefix)}`, token, prefix }
  }
  return { label: path, token: null, prefix: null }
}

/** One chip per path, a path and its `/private` twin (a trailing `/` aside) being one chip under the shorter spelling. */
export function chipsOf(paths: readonly string[], roots: PathRoots): Chip[] {
  const all = new Set(paths)
  const byStripped = new Map<string, string>()
  for (const p of all) if (!byStripped.has(trimSlash(p))) byStripped.set(trimSlash(p), p)
  const chips: Chip[] = []
  for (const p of all) {
    const s = trimSlash(p)
    if (s.startsWith('/private/') && byStripped.has(s.slice('/private'.length))) continue
    const twin = byStripped.get(`/private${s}`)
    chips.push(
      twin === undefined ? { ...shortNameOf(p, roots), fulls: [p] } : { ...shortNameOf(s, roots), fulls: [p, twin] },
    )
  }
  return chips
}

/** What a short name that needs saying stands for, drawn before its directory in the legend. */
export const TOKEN_MEANING: Readonly<Record<string, string>> = {
  '<run dir>': "the attempt's own run directory,",
}

/** Three or more paths under one parent directory are one chip, `<parent>/… (N)`; fewer are left as they are. */
export function foldChips(chips: readonly Chip[], roots: PathRoots): Chip[] {
  const parentOf = (c: Chip) => {
    const full = trimSlash(c.fulls[0]!)
    const at = full.lastIndexOf('/')
    return at <= 0 ? '/' : full.slice(0, at)
  }
  const groups = new Map<string, Chip[]>()
  for (const c of chips) groups.set(parentOf(c), [...(groups.get(parentOf(c)) ?? []), c])
  const out: Chip[] = []
  for (const c of chips) {
    const parent = parentOf(c)
    const group = groups.get(parent)!
    if (group.length < 3) {
      out.push(c)
      continue
    }
    if (group[0] !== c) continue
    const short = shortNameOf(parent, roots)
    out.push({
      label: `${short.label}/… (${group.length})`,
      fulls: group.flatMap((m) => m.fulls),
      token: short.token,
      prefix: short.prefix,
      folded: group.length,
      members: group,
    })
  }
  return out
}

/** Each short name the chips used and the directories it stood for. */
export function legendOf(chips: readonly Chip[]): { token: string; paths: string[] }[] {
  const byToken = new Map<string, Set<string>>()
  for (const c of chips) {
    if (c.token === null || c.prefix === null) continue
    byToken.set(c.token, (byToken.get(c.token) ?? new Set()).add(c.prefix))
  }
  return [...byToken].map(([token, paths]) => ({ token, paths: [...paths] }))
}

export interface ReachSet {
  readonly domains: readonly PolicyGroup['domains'][number][]
  readonly writable: readonly string[]
  readonly denyRead: readonly PolicyGroup['denyRead'][number][]
  readonly denyWrite: readonly string[]
}

export interface PolicyDiffers {
  readonly policy: number
  readonly letter: string
  readonly runs: readonly string[]
  /** What it has beyond the common set. */
  readonly extra: ReachSet
  /** What the others have that it lacks: entries it does not *list*, which is not what it permits. */
  readonly lacks: ReachSet
  /** Paths it re-allows inside a root every policy denies reading, beyond what every policy re-allows. */
  readonly exceptions: PolicyGroup['denyRead'][number][]
}

export const isEmptyReach = (r: ReachSet) =>
  r.domains.length + r.writable.length + r.denyRead.length + r.denyWrite.length === 0

/**
 * What every policy has, and per policy what it has beyond that or lacks. Entries are compared by their full recorded
 * form (a host, a path, a root with its re-allowed paths), never by their short names.
 */
export function reachOf(policies: readonly PolicyGroup[]): { common: ReachSet; differs: PolicyDiffers[] } {
  const keyed = (g: PolicyGroup) => ({
    domains: new Map(g.domains.map((d) => [d.host, d])),
    writable: new Map(g.writable.map((w) => [w, w])),
    denyRead: new Map(g.denyRead.map((d) => [d.path, d])),
    denyWrite: new Map(g.denyWrite.map((w) => [w, w])),
  })
  const k = policies.map(keyed)
  const fields = ['domains', 'writable', 'denyRead', 'denyWrite'] as const
  const everyHas = (f: (typeof fields)[number], key: string) => k.every((x) => x[f].has(key))
  const commonOf = <F extends (typeof fields)[number]>(f: F): ReachSet[F] => {
    const first = k[0]?.[f]
    if (first === undefined) return [] as unknown as ReachSet[F]
    return [...first]
      .filter(([key]) => everyHas(f, key))
      .map(([key, v]) => {
        if (f === 'denyRead') {
          // A root is denied for every policy; what is re-allowed in it is what every policy re-allows.
          const own = k.map((x) => x.denyRead.get(key)!.except)
          return { path: key, except: own[0]!.filter((e) => own.every((x) => x.includes(e))) }
        }
        if (f !== 'domains') return v
        // A host any policy recorded as the recipe's is the recipe's.
        const hit = k.map((x) => x.domains.get(key)!).find((d) => d.source === 'recipe')
        return hit ?? v
      }) as unknown as ReachSet[F]
  }
  const common: ReachSet = {
    domains: commonOf('domains'),
    writable: commonOf('writable'),
    denyRead: commonOf('denyRead'),
    denyWrite: commonOf('denyWrite'),
  }
  if (policies.length < 2) return { common, differs: [] }
  const differs = policies.map((g, n): PolicyDiffers => {
    const own = k[n]!
    const extraOf = <F extends (typeof fields)[number]>(f: F) =>
      [...own[f]].filter(([key]) => !everyHas(f, key)).map(([, v]) => v) as unknown as ReachSet[F]
    const lacksOf = <F extends (typeof fields)[number]>(f: F): ReachSet[F] => {
      const seen = new Map<string, unknown>()
      for (const x of k) for (const [key, v] of x[f]) if (!own[f].has(key) && !seen.has(key)) seen.set(key, v)
      return [...seen.values()] as unknown as ReachSet[F]
    }
    const exceptions = [...own.denyRead.values()].flatMap((d) => {
      const shared = common.denyRead.find((c) => c.path === d.path)
      const more = shared === undefined ? [] : d.except.filter((e) => !shared.except.includes(e))
      return more.length === 0 ? [] : [{ path: d.path, except: more }]
    })
    return {
      policy: n + 1,
      letter: policyLetter(n + 1),
      runs: g.runs,
      exceptions,
      extra: {
        domains: extraOf('domains'),
        writable: extraOf('writable'),
        denyRead: extraOf('denyRead'),
        denyWrite: extraOf('denyWrite'),
      },
      lacks: {
        domains: lacksOf('domains'),
        writable: lacksOf('writable'),
        denyRead: lacksOf('denyRead'),
        denyWrite: lacksOf('denyWrite'),
      },
    }
  })
  return { common, differs }
}

const VENDOR_ORDER = ['Anthropic', 'OpenAI', 'npm', 'GitHub', 'Other'] as const

/** *Reachable* by vendor, then the recipe's own hosts. A host recorded `not recorded` is under its vendor, never the recipe. */
export function vendorGroupsOf(domains: readonly PolicyGroup['domains'][number][]): {
  vendors: { vendor: string; hosts: string[] }[]
  recipe: string[]
} {
  const by = new Map<string, string[]>()
  const recipe: string[] = []
  for (const d of domains) {
    if (d.source === 'recipe') {
      recipe.push(d.host)
      continue
    }
    const vendor = BUILT_IN_DOMAIN_VENDORS[d.host] ?? 'Other'
    by.set(vendor, [...(by.get(vendor) ?? []), d.host])
  }
  return {
    vendors: VENDOR_ORDER.flatMap((vendor) => (by.has(vendor) ? [{ vendor, hosts: by.get(vendor)! }] : [])),
    recipe,
  }
}
