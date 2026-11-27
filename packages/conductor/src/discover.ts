/**
 * Discovery: GitHub becomes an *input source*, not a database.
 *
 * This is the one place in the system that reads a GitHub label — to learn that
 * an item exists, what kind of work it is, and whether something else already
 * owns it. Once a task is claimed the log is the authority and no label is
 * consulted for state again.
 *
 * It reads one thing that is not a label: what GitHub says **blocks** the issue
 * (#131). Same rule and same reason — a dependency is a fact the repository
 * holds, natively and in both directions, so it is asked for rather than
 * mirrored into a field of Lingtai's own, and it arrives on the issue the
 * listing already fetched.
 *
 * Since 0012 this appends nothing at all, and since 0022 it stores nothing
 * either: the runnable set is what GitHub currently says, minus what the log
 * says is claimed, computed at the moment somebody needs it. That inversion is
 * the whole of
 * doc/decisions-archive/0001-event-sourcing.md: #35 carried `agent:blocked` and
 * `agent:review` at the same time because `--add-label` is set union, not a
 * transition, and nothing could have noticed.
 *
 * Two exclusions, and the second is a Phase 1 safety rule rather than a
 * preference. `agent-loop.sh` is still working the same repository on an hourly
 * cycle, and the two systems must never both claim a ticket. An issue carrying
 * any `agent:*` label is one the old loop has touched, so Lingtai does not
 * discover it at all.
 */
import { PUBLISHING_LABEL } from '@lingtai/domain'
import type { EventStore } from '@lingtai/event-store/store'
import { readDraftedTickets } from '@lingtai/project'
import type { AssigneeRule, QueueSettings, Recipe, Selection } from '@lingtai/recipe'
import { branchOf, selectionOf } from '@lingtai/recipe/settings'
import { Effect } from 'effect'

// `ticketStream` and its inverse moved to `domain` (0022): the projector
// needs them and must not depend on this package.
import { LANDED_LABEL, PR_FIX_LABEL } from './labels.ts'
import type { Tickets } from './ticket-store.ts'

/**
 * What discovery needs of a ticket source — the fields it reads, and nothing
 * else (`#347`). `GitHubClient` satisfies this structurally, the same way
 * `IssueChannel` in `tell.ts` does for the write side: the caller names its own
 * requirement rather than importing the shape `@lingtai/github` happens to
 * have.
 */
export interface TicketListing {
  number: number
  title: string
  state: 'open' | 'closed'
  labels: readonly { name: string; color: string | null }[]
  assignees: readonly string[]
  /**
   * `dependencies: null` means *GitHub said nothing about dependencies*, not
   * *nothing blocks it* (CLAUDE.md, "Null is not zero"). A required, nullable
   * key rather than an optional one: an optional `dependencies?:` would let a
   * source leave it out, and `issue.dependencies === null` below would read
   * `undefined` the same way, so every ticket would go silently clear.
   */
  dependencies: { blockedBy: number } | null
  /**
   * The issue this is a sub-issue of; null when it has none or the source does
   * not say. Required for the same reason `dependencies` is (#957).
   */
  parent: { repository: string; number: number } | null
  /**
   * GitHub's sub-issue counts; null is *said nothing*, which is not an epic.
   * Required and nullable, like `dependencies`.
   */
  subIssues: { total: number; completed: number } | null
}

/**
 * An epic is a ticket with **open** sub-issues, whatever its labels (#957). Not
 * *any* sub-issue: a split parent has all of its children attached, and comes
 * back to be closed once they have closed (0118 §12.9). `{0,0}` and null are
 * not epics.
 */
export function isEpic(t: { subIssues: { total: number; completed: number } | null }): boolean {
  return t.subIssues !== null && t.subIssues.total > t.subIssues.completed
}

/**
 * `getIssue`'s answer carries the body too — fetched once, for the ticket a
 * pass is about to claim ([0109](../../../doc/decisions/0109-the-core-takes-a-ticket.md)
 * §1: the listing is cheap and holds no body, and the body is fetched once,
 * for the ticket that was claimed).
 */
export interface TicketDetail extends TicketListing {
  body: string
  /** Why a closed ticket closed; null or absent when the source does not say. */
  stateReason?: 'completed' | 'not_planned' | null
}

/**
 * The two calls discovery makes of a ticket source — a `Pick` of `Tickets`
 * (`ticket-store.ts`, `#377`) rather than a shape of its own, so the two
 * cannot drift apart. `GitHubClient` satisfies `Tickets` structurally, the
 * same way `IssueChannel` in `tell.ts` does for the write side, and so
 * satisfies this.
 */
export type TicketSource = Pick<Tickets, 'listOpenIssues' | 'getIssue'>

/**
 * Which kind of work an issue is, from its labels — **the recipe's labels**.
 *
 * `kinds` is passed in rather than read from a set this file keeps, because
 * one list has to be the vocabulary, the filter and the priority order at once
 * (#76). A global enum made them three lists that could disagree, and the way
 * they disagreed was fatal: a recipe naming a label the enum did not have
 * failed to resolve, so the project offered nothing at all instead of offering
 * the kinds it did name.
 *
 * Matched case-insensitively, with whitespace reduced to a hyphen, so a recipe
 * saying `tech-debt` takes an issue labelled `Tech Debt`. Earlier in `kinds`
 * wins when an issue carries two.
 *
 * Null when nothing says. That is not a defaulting opportunity: an issue this
 * recipe has no label for is not work the scheduler can prioritise, and
 * guessing the first kind would put unclassified issues at the front of the
 * queue.
 */
export function kindOf(issue: Pick<TicketListing, 'labels'>, kinds: readonly string[]): string | null {
  return kindLabelOf(issue, kinds)?.kind ?? null
}

/**
 * The same match, with the label it was read from.
 *
 * Separate from `kindOf` only because the label carries the repository's own
 * colour for that kind (#85) and the matching rule must not be written twice:
 * a second loop that reduced whitespace differently would colour a card by a
 * label the queue did not prioritise it by.
 */
export function kindLabelOf(
  issue: Pick<TicketListing, 'labels'>,
  kinds: readonly string[],
): { kind: string; label: TicketListing['labels'][number] } | null {
  const carried = new Map(issue.labels.map((l) => [normaliseLabel(l.name), l]))
  for (const kind of kinds) {
    const label = carried.get(normaliseLabel(kind))
    if (label) return { kind, label }
  }
  return null
}

/**
 * The kinds the queue matches and sorts by: in team mode `lingtai:pr-fix` first (0130 §5),
 * once even if the recipe names it; in solo mode the recipe's own list.
 */
export function rankedKinds(kinds: readonly string[], mode: Selection['mode']): readonly string[] {
  if (mode !== 'team') return kinds
  const own = normaliseLabel(PR_FIX_LABEL)
  return [PR_FIX_LABEL, ...kinds.filter((k) => normaliseLabel(k) !== own)]
}

function normaliseLabel(label: string): string {
  return label.toLowerCase().replace(/\s+/g, '-')
}

/**
 * `kind-not-wanted` is gone, and could not survive #76: it named the gap
 * between a global vocabulary and the recipe's subset of it, and there is no
 * global vocabulary any more. An issue labelled with something this recipe does
 * not list is `no-kind` — which is the honest reading, since the recipe is the
 * only thing that ever knew what a kind was.
 */
export type SkipReason =
  | 'closed'
  /**
   * A team machine landed it on its person's own branch and left it open for the PR (#1309). A solo
   * machine passes over `lingtai:landed` and no recipe can lift that (#1310).
   */
  | 'landed-elsewhere'
  | 'pr-fix-elsewhere'
  /** It has open sub-issues, so it is a container of work and never work itself (#957). */
  | 'epic'
  | 'no-kind'
  | 'excluded-label'
  | 'already-discovered'
  /**
   * Something this issue depends on is still open.
   *
   * The queue orders by kind and then by number and knows nothing about a
   * chain, so on 2026-09-10 it took `#123` — `tech-debt` — ahead of the two
   * `feature` tickets that had to land first, and an agent was dispatched
   * against groundwork that did not exist (`#131`). The chain *was* written
   * down, in `#126`'s body, as a table for people; the queue cannot read prose.
   *
   * A reason rather than a gate at `admit`, on two counts. The whole `admit`
   * row is unimplemented (`#61`), so configuring it would render `resolved` and
   * execute nothing — the shape of `#58`. And 0015 lets `admit` refuse but not
   * reorder: a refused item is still first in line next pass, refused again,
   * forever. `lingtai:hold` already works the way this does, one line above.
   */
  | 'blocked-by'
  /** A split's child still carries `lingtai:publishing`: the split has not read everything back yet (#1261). Comes back on its own. */
  | 'publishing'
  /**
   * The project's base is red and its head is still the commit that was recorded red (#1208, 0108 §13): a
   * fact about the project, so every offered ticket carries it. Never produced by `runnableNowEffect`, which
   * asks GitHub alone — `passOverBaseRed` adds it after the log and the mirror have been read.
   */
  | 'base-red'
  /**
   * Assigned to somebody other than this machine's login, under `take: mine`
   * or `take: unassigned` (0046 §2, #181).
   *
   * **Not a lock.** A person wrote the assignee when planning, so it never goes
   * stale and needs no expiry — the lease 0027 deleted does not come back.
   * `lingtai:working` is not read here and never decides this: a stale one
   * misinforms and blocks nobody.
   */
  | 'assigned-elsewhere'
  /** Assigned to nobody, under `take: mine`. */
  | 'unassigned'
  /** Assigned to this machine's own login, under `take: unassigned`. */
  | 'assigned-to-me'
  /**
   * Assigned to somebody, under `take: unassigned` with no login — so whether
   * it is this machine's own cannot be said, and is not guessed.
   */
  | 'assigned'

export interface Considered {
  issue: TicketListing
  /** Null when the issue should be discovered. */
  skip: SkipReason | null
  /**
   * The `source.exclude` entry that holds the issue, spelled as the recipe
   * spells it — the first in the recipe's order. Null for every other outcome.
   */
  label: string | null
}

/**
 * Whether an issue is eligible, and if not, why — without touching the log.
 *
 * Separated from the appending so `lingtai status` can explain a queue's *absences*,
 * which is the question the old loop's `pick_ticket` could never answer.
 */
export function considerIssue(issue: TicketListing, queue: QueueSettings, selection: Selection): Considered {
  if (issue.state === 'closed') return { issue, skip: 'closed', label: null }

  // Before any label is read: an epic is never work, which is more permanent
  // than a hold a person put on it.
  if (isEpic(issue)) return { issue, skip: 'epic', label: null }

  const labels = issue.labels.map((l) => l.name.toLowerCase())

  // The system's own label, not the recipe's: checked before `exclude` so no recipe can lift it.
  if (labels.includes(PUBLISHING_LABEL)) return { issue, skip: 'publishing', label: null }

  // Somebody's team machine has it on their own branch, waiting on their PR. Checked like `publishing`.
  if (selection.mode === 'solo' && labels.includes(LANDED_LABEL.toLowerCase())) {
    return { issue, skip: 'landed-elsewhere', label: null }
  }

  // A change asked for on somebody's PR, for their team machine. Checked like `publishing`.
  if (selection.mode === 'solo' && labels.includes(PR_FIX_LABEL.toLowerCase())) {
    return { issue, skip: 'pr-fix-elsewhere', label: null }
  }

  // Every reason an issue is not this agent's comes from the recipe. There used
  // to be one more, hardcoded here: any label starting `agent:` meant the issue
  // was owned by the old shell loop, and Lingtai skipped it. That was a guess
  // about a namespace, made in the core, about a repository it cannot see —
  // exactly the shape of thing 0016 §7 removed everywhere else.
  //
  // It was also wrong in the direction that costs the most. `lingtai:followup`
  // means "an agent opened this as out-of-scope work" — ready work, 24 issues
  // of it in `nextloom-ai-admin` — and it was skipped alongside `lingtai:hold`,
  // which means the opposite. A repository knows which of its labels are holds;
  // this file cannot.
  const held = queue.exclude.find((x) => labels.includes(x.toLowerCase()))
  if (held !== undefined) return { issue, skip: 'excluded-label', label: held }

  if (kindOf(issue, rankedKinds(queue.kinds, selection.mode)) === null) return { issue, skip: 'no-kind', label: null }

  // After the checks above, and deliberately the least permanent of them. A ticket carrying
  // `lingtai:hold` is one a person is holding and a ticket of no kind is one this
  // recipe never takes; a blocked one is ordinary work whose turn has not come,
  // and it comes back on its own.
  //
  // **Open, not total.** `blockedBy` counts the blockers GitHub still has open;
  // a chain whose groundwork has landed has `totalBlockedBy` of two and
  // `blockedBy` of zero, and holding it for history would hold it forever.
  //
  // Null is not zero. A repository whose GitHub said nothing about dependencies
  // is one this cannot answer for, and it degrades to the behaviour before this
  // existed rather than passing everything over — `runnableNow` is what says so.
  if ((issue.dependencies?.blockedBy ?? 0) > 0) return { issue, skip: 'blocked-by', label: null }

  // Last: whose work it is (#181). An issue both blocked and somebody else's
  // reports `blocked-by`, the reason that clears on its own.
  const assignee = assigneeSkip(issue, queue.assignee, selection)
  if (assignee) return { issue, skip: assignee, label: null }

  return { issue, skip: null, label: null }
}

/**
 * Whether this machine's assignee setting passes an issue over, and why.
 *
 * **The assignee, and never a label.** `lingtai:working` is still written and
 * still rendered, and it says *somebody's Lingtai is running this now* — which
 * is information, and nothing in selection reads it (0046 §2).
 *
 * Absent is `all`: every issue is offered whoever it is assigned to, which is
 * what the queue did before it read an assignee. Logins compare
 * case-insensitively, because GitHub's do.
 *
 * **On the local store every ticket is the person's** (0130 §3): it tracks no assignee, so every
 * listing row has none, and *mine* is everyone. **In team mode the rule is `mine`** whatever the parsed
 * `take` says: a written `all` or `unassigned` was refused when the recipe resolved, so the `all` that
 * arrives here can only be the schema's default (#1310).
 */
export function assigneeSkip(
  issue: TicketListing,
  rule: AssigneeRule | undefined,
  selection: Selection,
): SkipReason | null {
  if (selection.tickets === 'db') return null
  const take = selection.mode === 'team' ? 'mine' : (rule?.take ?? 'all')
  if (take === 'all') return null
  const me = rule?.login?.toLowerCase()
  const assignees = issue.assignees.map((a) => a.toLowerCase())
  const mine = me !== undefined && assignees.includes(me)
  if (take === 'mine') {
    if (mine) return null
    return assignees.length === 0 ? 'unassigned' : 'assigned-elsewhere'
  }
  if (assignees.length === 0) return null
  if (me === undefined) return 'assigned'
  return mine ? 'assigned-to-me' : 'assigned-elsewhere'
}

export interface Offered {
  /** Issues GitHub lists that the recipe will take. */
  runnable: {
    ref: string
    title: string
    kind: string
    parent: TicketListing['parent']
    subIssues: TicketListing['subIssues']
    /**
     * The open blockers GitHub still lists that this queue treated as landed on `branch.personal` (#1423); absent
     * for an issue GitHub's summary did not hold. `blockersLanded` is how it is said.
     */
    landedBlockers?: readonly number[]
  }[]
  /** Every issue that was not runnable, with the reason. */
  skipped: {
    ref: number
    reason: SkipReason
    /** The `source.exclude` label behind an `excluded-label` skip, as the recipe spells it; null otherwise. */
    label: string | null
    title: string
    /** The recipe's kind for the issue, or null when it carries none. */
    kind: string | null
    /** Open blockers, as GitHub counted them; null when GitHub said nothing. Never coerced to 0. */
    blockedBy: number | null
    parent: TicketListing['parent']
    subIssues: TicketListing['subIssues']
    /**
     * Why a `blocked-by` skip in a team project could not be released by what landed on `branch.personal` (#1423):
     * the blockers could not be read. Absent otherwise. `blockersUnread` is how it is said.
     */
    held?: string
    /**
     * The blockers discovery read for this skip (#1423), for the explanation to use as read: a list that was not
     * read whole (a full page) is said as a problem, never as a list.
     */
    blockersRead?: BlockersRead
  }[]
  /**
   * What colour this repository gives each kind, `#rrggbb`, keyed by the kind
   * as the recipe names it.
   *
   * A fact about the *repository* rather than about any one issue — a label has
   * one colour, and every issue carrying it carries the same one — so it is
   * returned once here instead of on each runnable item. It comes off the
   * issues this call already read, which is why asking for it costs nothing.
   *
   * Gathered from every issue that carries one of the recipe's labels, not only
   * the runnable ones: an issue held back by `lingtai:hold` still says what
   * colour `bug` is, and a board that only learned from runnable issues would
   * lose the colour of a kind the moment its last queued item was claimed.
   *
   * A kind nobody has an open issue for is simply absent. Nothing invents an
   * entry: no colour is what a renderer needs to hear to render none (#85).
   */
  kindColors: Record<string, string>
  /**
   * Which issues were not checked for a blocker, in words — and null when every
   * one was.
   *
   * **The degraded case has to say so.** GitHub sends dependencies with the
   * issue, but a plan that does not expose them sends nothing, and `blocked-by`
   * would then never appear — indistinguishable from a repository with no
   * chains in it. That is the silence 0016 §4 refuses and the shape `#58` is.
   *
   * **Said about the issues it is true of**, not asserted of the repository on
   * the strength of one. When GitHub sent no summary for any of them the
   * sentence is about the repository; when it sent one for most and not for
   * some, it names those, because *nothing is held by a blocker* beside a
   * `blocked-by 1` on the same line is a contradiction the operator cannot
   * resolve. Either way the unread ones are offered — today's behaviour — and
   * never passed over for want of an answer.
   *
   * One phrase rather than a flag, for the reason `backingOff` is one: the CLI,
   * the daemon's log and the board all say it, and the places an operator asks
   * *why is this not moving* must not come to word it differently (`#100`).
   */
  dependenciesUnread: string | null
}

/**
 * What a repository whose GitHub reports no dependencies at all is told, once.
 *
 * It names the consequence rather than the endpoint, because the consequence is
 * the thing to act on: nothing is being held, so a chain here is still ordered
 * by kind and number and still needs `lingtai:hold` by hand.
 */
export const DEPENDENCIES_UNREAD =
  'GitHub reported no issue dependencies for this repository — nothing is held by a blocker'

/**
 * The sentence for `Offered.dependenciesUnread`, from the issues GitHub sent no
 * summary for. Null when there are none.
 */
export function dependenciesUnread(unread: readonly number[], listed: number): string | null {
  if (unread.length === 0) return null
  if (unread.length === listed) return DEPENDENCIES_UNREAD
  const refs = unread.map((n) => `#${n}`).join(', ')
  return unread.length === 1
    ? `GitHub sent no dependency summary for ${refs} — it is not held by a blocker`
    : `GitHub sent no dependency summary for ${refs} — they are not held by a blocker`
}

/**
 * `12 passed over — excluded-label 9, no-kind 2, blocked-by 1`, or null when
 * nothing was.
 *
 * Here rather than in the CLI because the board's Queued column says the same
 * line (#131): a ticket nothing will take is a number on a line and not
 * silence (0016 §4), and two places counting it must not word it differently.
 * Most first, then by name, so the line does not reorder between passes.
 */
export function passedOver(skipped: Offered['skipped']): string | null {
  if (skipped.length === 0) return null
  const reasons = new Map<string, number>()
  for (const s of skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1)
  const counted = [...reasons]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, n]) => `${reason} ${n}`)
    .join(', ')
  return `${skipped.length} passed over — ${counted}`
}

/** A blocker as the queue reads it: the repository its number belongs to, and whether it is open. */
export interface BlockerRead {
  repository: string
  number: number
  title: string
  state: 'open' | 'closed'
}

/** What discovery read of a ticket's blockers, carried on its skip so the explanation does not read them again. */
export type BlockersRead = { ok: true; issues: readonly BlockerRead[] } | { ok: false; problem: string }

/**
 * What lets a team project's queue see that a blocker has landed on `branch.personal` (#1423).
 *
 * GitHub's summary counts a blocker open until the PR carrying it merges into `main`, and in a team project that
 * is long after its code is on the branch the next attempt starts from.
 */
export interface LandedOptions {
  /** What reads a ticket's blockers: all of them, open or closed, or a throw. */
  links: {
    repository: string
    /**
     * The first page of the blockers, one request: a list of `BLOCKERS_PAGE` may be the start of a longer one.
     * `blockedBy` is GitHub's open count the listing gave, which a caller that caches the read keys it by.
     */
    listBlockedBy(issue: number, blockedBy?: number): Promise<readonly BlockerRead[]>
  }
  /** The log and project whose PRs say which tickets joined a draft. */
  store: EventStore
  project: string
  /** `branch.personal`, for the sentence. */
  branch: string
}

/** The most blockers one page of the read carries; a list longer than this holds the ticket (#1423). */
export const BLOCKERS_PAGE = 100

/** How an offered ticket says its open blockers had landed. One phrase, as `dependenciesUnread` is. */
export function blockersLanded(landed: readonly number[], branch: string): string {
  return `its blockers ${landed.map((n) => `#${n}`).join(', ')} landed on ${branch}`
}

/** What an offered ticket says about blockers it was taken past, or null for one GitHub's summary did not hold (#1423). */
export function landedNote(
  offered: Pick<Offered, 'runnable'>,
  ref: string | number,
  branch: () => string,
): string | null {
  const landed = offered.runnable.find((r) => String(r.ref) === String(ref))?.landedBlockers
  return landed === undefined ? null : blockersLanded(landed, branch())
}

/** How a `blocked-by` skip says its blockers could not be read. */
export function blockersUnread(why: string): string {
  return `could not read its blockers: ${why}`
}

/**
 * The `landed` option for a caller, or undefined where the queue decides as it always did: a solo project, a project
 * whose tickets Lingtai keeps itself, and a source with no way to list blockers (#1423). Every caller of
 * `runnableNowEffect` asks this one function, so the pass, `take`, `lingtai now`, status and the board agree.
 */
export function landedFor(input: {
  recipe: Recipe
  links: LandedOptions['links'] | null
  store: EventStore
  project: string
}): LandedOptions | undefined {
  const selection = selectionOf(input.recipe)
  if (selection.mode !== 'team' || selection.tickets === 'db' || input.links == null) return undefined
  return { links: input.links, store: input.store, project: input.project, branch: branchOf(input.recipe) }
}

/**
 * What lists the blockers of a ticket on a GitHub client, or null for a source that cannot (a test's memory store).
 * A getter, so building it reads nothing from the client.
 */
export function linksOfClient(client: unknown): LandedOptions['links'] | null {
  const c = client as { owner?: unknown; repo?: unknown; listBlockedBy?: unknown } | null
  if (c === null || typeof c !== 'object' || typeof c.listBlockedBy !== 'function') return null
  if (typeof c.owner !== 'string' || typeof c.repo !== 'string') return null
  const gh = c as {
    owner: string
    repo: string
    listBlockedBy(n: number, firstPageOnly?: boolean): Promise<readonly BlockerRead[]>
  }
  return {
    get repository() {
      return `${gh.owner}/${gh.repo}`
    },
    listBlockedBy: (n) => gh.listBlockedBy(n, true),
  }
}

const whyOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export interface RunnableNowOptions {
  client: TicketSource
  /**
   * The four values `queue:` carries — **the block and not a recipe** (`#269`).
   *
   * `queueOf(recipe)` in `@lingtai/recipe` is what a caller that has only a
   * recipe asks, and it is the one place the two spellings are known. A caller
   * running `claim`'s declared `queue:` action hands the block itself, so the
   * ticket a pass takes is the one the reading of that action says it took.
   */
  queue: QueueSettings
  /** The mode and ticket source (`selectionOf(recipe)`), which `queue:` does not carry (#1310). */
  selection: Selection
  /** Restricts the read to specific issue numbers. */
  only?: number[]
  /**
   * Given in a team project whose tickets are GitHub's: a `blocked-by` skip whose blockers all closed or landed on
   * `branch.personal` is offered (#1423). Absent is today's behaviour, and so is a solo project's.
   */
  landed?: LandedOptions
}

/**
 * Ask GitHub what it is offering, right now.
 *
 * **Nothing is appended and nothing is stored.** Which issues exist is
 * GitHub's state, not Lingtai's; mirroring it into an append-only log meant one
 * event per issue per pass to reproduce a fact GitHub answers correctly on
 * request ([0012](../../../doc/decisions-archive/0012-one-task-view.md)), and mirroring
 * it into a table meant two bugs that were both cache invalidation
 * ([0022](../../../doc/decisions-archive/0022-the-seams.md), #56 and #57). What Lingtai
 * *decides* — which one it claimed — is still an event, and still the whole of
 * the mutual exclusion.
 *
 * The answer is an argument, not a side effect: pass it to `selectRunnable`,
 * which subtracts what the log says is claimed.
 */
export function runnableNow(options: RunnableNowOptions): Promise<Offered> {
  return Effect.runPromise(runnableNowEffect(options))
}

/** How many held tickets' blocker lists are asked for at once. */
const BLOCKER_READS_IN_FLIGHT = 8

/** `runnableNow` as an Effect: a failed listing is the failure, with the client's own error, never an empty queue. */
export function runnableNowEffect(options: RunnableNowOptions): Effect.Effect<Offered, unknown> {
  return Effect.gen(function* () {
    const { client, queue, selection } = options
    const kinds = rankedKinds(queue.kinds, selection.mode)

    const issues = yield* Effect.tryPromise({
      try: () => (options.only ? Promise.all(options.only.map((n) => client.getIssue(n))) : client.listOpenIssues()),
      catch: (error) => error,
    })

    const result: Offered = { runnable: [], skipped: [], kindColors: {}, dependenciesUnread: null }

    const unread: number[] = []

    const landed = options.landed

    // Step 1, serial and in listing order: decide each issue, and note the ones that need a blocker read.
    const decided = issues.map((issue) => {
      if (issue.dependencies === null) unread.push(issue.number)

      const matched = kindLabelOf(issue, kinds)
      // Before the skip, deliberately: the colour of `bug` is the same whether or
      // not this particular bug can be run, and a held ticket is often the only
      // open issue a kind has.
      if (matched && matched.label.color && !(matched.kind in result.kindColors)) {
        result.kindColors[matched.kind] = matched.label.color
      }

      const { skip, label } = considerIssue(issue, queue, selection)
      // Only a ticket that GitHub's summary holds, and that nothing after `blocked-by` would pass over either: one
      // request for it, and none for a ticket `assigned-elsewhere` would refuse anyway.
      const needsRead =
        landed !== undefined &&
        skip === 'blocked-by' &&
        (issue.dependencies?.blockedBy ?? 0) > 0 &&
        considerIssue({ ...issue, dependencies: { ...issue.dependencies!, blockedBy: 0 } }, queue, selection).skip ===
          null
      return { issue, matched, skip, label, needsRead }
    })

    // Step 2: at most eight reads in flight. Every failure is a value before `forEach` sees it, so none interrupts
    // another.
    type BlockerList = { ok: true; blockers: readonly BlockerRead[] } | { ok: false; why: string }
    const reads = new Map<number, BlockerList>()
    if (landed !== undefined) {
      const pending = decided.filter((d) => d.needsRead)
      const results = yield* Effect.forEach(
        pending,
        ({ issue }) =>
          Effect.tryPromise({
            try: () => landed.links.listBlockedBy(issue.number, issue.dependencies!.blockedBy),
            catch: (error) => error,
          }).pipe(
            Effect.map((blockers): BlockerList => ({ ok: true, blockers })),
            Effect.catch((error: unknown) => Effect.succeed<BlockerList>({ ok: false, why: whyOf(error) })),
          ),
        { concurrency: BLOCKER_READS_IN_FLIGHT },
      )
      pending.forEach((d, i) => reads.set(d.issue.number, results[i]!))
    }

    // Step 3: the drafted tickets, read once and only when some read came back with a usable list.
    let drafted: { ok: true; tickets: ReadonlySet<string> } | { ok: false; why: string } | null = null
    if (
      landed !== undefined &&
      [...reads.values()].some((r) => r.ok && r.blockers.length > 0 && r.blockers.length < BLOCKERS_PAGE)
    ) {
      drafted = yield* readDraftedTickets(landed.project, landed.store).pipe(
        Effect.map((tickets) => ({ ok: true as const, tickets })),
        Effect.catch((error: unknown) =>
          Effect.succeed({ ok: false as const, why: `could not read the project's PRs: ${whyOf(error)}` }),
        ),
      )
    }

    // Step 4, serial and in listing order: assemble.
    for (const { issue, matched, skip, label } of decided) {
      let landedBlockers: readonly number[] | undefined
      let held: string | undefined
      let blockersRead: BlockersRead | undefined
      let released = false
      const read = reads.get(issue.number)
      if (landed !== undefined && read !== undefined) {
        if (!read.ok) {
          held = blockersUnread(read.why)
          blockersRead = { ok: false, problem: read.why }
        }
        // One page is all that was requested, so a full one may be the start of a longer list: it holds the issue.
        else if (read.blockers.length >= BLOCKERS_PAGE) {
          const why = `it has ${BLOCKERS_PAGE} blockers or more, which is more than one page reads`
          held = blockersUnread(why)
          blockersRead = { ok: false, problem: why }
        } else if (read.blockers.length === 0) {
          const why = 'GitHub listed none, though it counts some open'
          held = blockersUnread(why)
          blockersRead = { ok: false, problem: why }
        } else {
          blockersRead = { ok: true, issues: read.blockers }
          if (drafted === null || !drafted.ok) {
            if (drafted !== null) held = blockersUnread(drafted.why)
          } else {
            const repository = landed.links.repository.toLowerCase()
            const drafts = drafted.tickets
            // A blocker holds unless it is closed, or it is this repository's and joined a draft. **A blocker that
            // landed and was requeued is still in the draft, so it does not hold**: its dependent runs on what landed.
            const onBranch = (b: BlockerRead) =>
              b.repository.toLowerCase() === repository && drafts.has(String(b.number))
            if (read.blockers.every((b) => b.state === 'closed' || onBranch(b))) {
              released = true
              const landedOnes = read.blockers.filter((b) => b.state === 'open').map((b) => b.number)
              if (landedOnes.length > 0) landedBlockers = landedOnes
            }
          }
        }
      }
      if (skip && !released) {
        result.skipped.push({
          ref: issue.number,
          reason: skip,
          label,
          title: issue.title,
          kind: matched?.kind ?? null,
          blockedBy: issue.dependencies?.blockedBy ?? null,
          parent: issue.parent,
          subIssues: issue.subIssues,
          ...(held === undefined ? {} : { held }),
          ...(blockersRead === undefined ? {} : { blockersRead }),
        })
        continue
      }
      result.runnable.push({
        ref: String(issue.number),
        title: issue.title,
        // `considerIssue` already refused a null kind, so this is a string.
        kind: matched!.kind,
        parent: issue.parent,
        subIssues: issue.subIssues,
        ...(landedBlockers === undefined ? {} : { landedBlockers }),
      })
    }

    result.dependenciesUnread = dependenciesUnread(unread, issues.length)
    return result
  })
}
