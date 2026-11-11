/**
 * A repository-scoped GitHub client.
 *
 * Everything here is a read or a write GitHub is the *display surface* for —
 * never the source of state. `github_mirror` is a projection that writes labels
 * out; nothing reads a label back to decide anything. That inversion is the one
 * the whole design rests on (doc/decisions-archive/0001-event-sourcing.md), so the
 * absence of a "read the agent:* labels" method here is deliberate.
 *
 * The one exception is discovery, which reads issues *once* to learn that a work
 * item exists. After that the log is the authority.
 */
import { Data, Effect } from 'effect'

import {
  type AppAuth,
  GitHubFailed,
  type Installation,
  NotInstalledError,
  githubJson,
  installationForRepoEffect,
  installationToken,
  runGitHub,
} from './app.ts'
import { type GhRun, ghTokenEffect, liveGh } from './gh.ts'

// The face lives in `app.ts`, which `client.ts` imports: a face here would make
// the two import each other, and `PermissionDenied` extends a class `app.ts`
// defines. It is exported from this file for the faces check, and not from `index.ts`.
export { runGitHub }

/**
 * `updateBody`'s `ifUnchanged` refused: the body read no longer matches what
 * is there now.
 *
 * **Best-effort on GitHub.** The issue PATCH takes no `If-Match`, so this is a
 * read and then a write, never a conditional write: an edit landing in the
 * instant between the two is still lost. 0118 §6 accepts that window; this
 * narrows it and does not close it. A `db` tracker's write is one conditional
 * `UPDATE`, with no window at all.
 */
export class BodyChanged extends Data.TaggedError('BodyChanged')<{ readonly issue: number }> {
  constructor(issue: number) {
    super({ issue })
  }

  override get message(): string {
    return `#${this.issue}'s body changed since it was read`
  }
}

/**
 * A sub-issue or dependency call was refused for want of a permission.
 *
 * A `GitHubFailed` still, so an `instanceof GitHubFailed` check keeps catching it.
 * Never an empty list: a caller reads *no links* as *nothing attached* and
 * writes one again.
 */
export class PermissionDenied extends GitHubFailed {
  readonly permission: string
  readonly level: 'read' | 'write'

  constructor(denied: GitHubFailed, permission: string, level: 'read' | 'write', kind: 'app' | 'gh' = 'app') {
    super(
      denied.status,
      denied.path,
      kind === 'gh'
        ? `the saved gh login lacks \`${permission}\` access at \`${level}\` for this endpoint — ` +
            `its account needs access to the repository, or \`gh auth refresh\` must grant the scope (${denied.message})`
        : `the App's \`${permission}\` permission at \`${level}\` is missing for this endpoint — ` +
            `the installation must grant it, or the owner must accept the App's updated permissions (${denied.message})`,
    )
    this.permission = permission
    this.level = level
  }
}

/**
 * An issue another issue is linked to, the repository it lives in (links may
 * cross repositories) and GitHub's REST `id` — a different integer from its
 * `number`. The id is here and not on `Issue` because only a link listing
 * needs it: the split writer records it on `TicketSplit`.
 */
export type LinkedIssue = Issue & { repository: string; id: number }

/**
 * A label as GitHub holds it: the name a recipe matches on, and the colour the
 * repository's own team chose for it in GitHub's UI.
 *
 * The colour is carried for the reason the name is — it is the repository's
 * fact and not Lingtai's. A board that wants to tell kinds apart has two
 * options, and inventing a hue per kind is the one that breaks: kinds are
 * unbounded since #76, so an invented hue has to be derived from the name, and
 * a hash eventually lands on the colour a palette has reserved for something
 * else. Reading the repository's choice is the rule
 * [0016 §7](../../../doc/decisions-archive/0016-the-settled-model.md) already states —
 * do not guess on behalf of a repository you cannot see.
 *
 * Nothing here decides that a colour is *usable*. Whether it can be rendered
 * against a particular background, and whether it collides with a hue that
 * already means something, are the renderer's questions, and the board answers
 * them where it draws (#85).
 */
export interface Label {
  name: string
  /**
   * `#rrggbb`, lower case. GitHub returns six hex digits with no `#`; the hash
   * is added here so nothing downstream has to know that.
   *
   * Null when GitHub gives none, or gives something that is not six hex digits.
   * That is an answer rather than a gap: a label nobody coloured has no colour,
   * and supplying one would be exactly the guess this field exists to avoid.
   */
  color: string | null
}

/**
 * What GitHub says has to happen before this issue can be worked.
 *
 * A dependency is a fact the *repository* holds, natively and in both
 * directions, and Lingtai does not decide which issues exist
 * ([0012](../../../doc/decisions-archive/0012-one-task-view.md)) — so it is read here
 * with the rest of the issue and never mirrored into a field of Lingtai's own.
 * That is the same argument #76 used to take `WorkKind` out of the core and
 * [0036](../../../doc/decisions-archive/0036-the-core-takes-a-ticket.md) §4 uses to
 * keep `agent:hold` a label the store never interprets.
 *
 * **Both counts, because they answer different questions.** A chain whose
 * groundwork has landed is finished with — every blocker closed — and a chain
 * that has never started looks identical if you only carry one number.
 */
export interface Dependencies {
  /**
   * How many issues block this one and are **still open**.
   *
   * The only one the queue acts on: a closed blocker is groundwork that exists
   * now, and holding a ticket for it would be holding it forever.
   */
  blockedBy: number
  /** How many block it at all, open and closed. */
  totalBlockedBy: number
}

export interface Issue {
  number: number
  title: string
  body: string
  labels: Label[]
  state: 'open' | 'closed'
  /** Why it closed, when GitHub says; null for an open issue or an older close. */
  stateReason?: 'completed' | 'not_planned' | null
  url: string
  /**
   * What blocks it, and **null when GitHub said nothing about dependencies** —
   * a plan that does not expose them, or an API version that predates them.
   *
   * Null is not "nothing blocks it". The two have to stay apart or a repository
   * whose GitHub will not answer would have every ticket silently treated as
   * clear, which is the failure `#58` is: a check present, reported, and not
   * looking at the thing you think it is. `runnableNow` says so once instead.
   */
  dependencies: Dependencies | null
  /**
   * Who the issue is assigned to, as GitHub logins — empty when nobody is.
   *
   * **Whose work a ticket is** ([0046](../../../doc/decisions-archive/0046-lingtai-is-personal.md) §2,
   * #181). A person writes it when planning, it never goes stale when a machine
   * dies, and a conflict over it is a reassignment GitHub already renders — so
   * it is read, rather than a claim label of Lingtai's own. On the object the
   * listing already fetched, as `dependencies` is.
   */
  assignees: string[]
  /**
   * The issue this one is a sub-issue of, off `parent_issue_url`, and null when
   * it has none or the URL is not one we can read. The repository is carried
   * because a parent may live elsewhere; readers decide what to do about that.
   */
  parent: { repository: string; number: number } | null
  /**
   * GitHub's `sub_issues_summary`, and **null when it said nothing** — not
   * `{ total: 0, completed: 0 }`. An epic is `total > completed` (#957).
   */
  subIssues: { total: number; completed: number } | null
}

/** Every call fails with a `GitHubFailed`, never a defect. */
type E<A> = Effect.Effect<A, GitHubFailed>

/**
 * The client, as Effects (#1025). Every member fails with `GitHubFailed`
 * (`updateBody` also with `BodyChanged`), and each is a span named
 * `github.<method>`. A value, as 0101 §5 has it: passed in, not provided.
 */
export interface GitHub {
  readonly owner: string
  readonly repo: string
  /** Null under `gh`, which has none. */
  readonly installation: Installation | null

  /** Raw REST, for the calls that do not have a method yet. */
  request<T>(method: string, path: string, body?: unknown): E<T>

  /** The repository's default branch, when the recipe does not name one. */
  defaultBranch(): E<string>

  /**
   * A file's contents at a ref, or null if it is not there.
   *
   * `ref` is a *server-side* ref. That is the whole governance rule in one
   * argument: the recipe a run obeys is read from `origin/<base>`, not from
   * whatever the agent's worktree happens to contain
   * (doc/decisions-archive/0005-config-in-target-repo.md).
   */
  fileAt(path: string, ref: string): E<string | null>

  /** The commit a ref points at right now, so a resolution can be replayed. */
  refSha(ref: string): E<string>

  /**
   * Every ref beginning `refs/<prefix>`, named without that `refs/` —
   * `heads/agent/240-attempt-1`.
   *
   * **GitHub matches this as a plain string and not as a path**, so
   * `heads/agent/24` answers `heads/agent/240`'s refs too. That is the API's
   * behaviour rather than a wrapper's, so it is said here: a caller deleting
   * what it gets back has to filter, and `sweepRefs` in
   * `packages/conductor/src/tell.ts` is the one that does.
   *
   * **Nothing matching is a 200 and an empty array**, which is the whole
   * difference between this endpoint and the single-reference one beside it. So
   * an error here is never an absence: a 404 is *this installation cannot read
   * this repository*, and a caller that turned it into `[]` would render a
   * repository it has lost access to as a remote with no refs on it — and a
   * sweep would then record a success saying there was nothing to delete.
   */
  matchingRefs(prefix: string): E<readonly string[]>

  /**
   * Deletes a ref, named as `matchingRefs` names it.
   *
   * A ref that is not there answers 422, which is a throw like any other: the
   * caller that must not fail on one deletes only what it has just listed.
   */
  deleteRef(ref: string): E<void>

  listOpenIssues(): E<Issue[]>

  /**
   * Every issue, open or closed, created at or after `since` — oldest first.
   *
   * The listing endpoint and not search: search is an index that lags the
   * write by seconds or more, and the one caller (the ticket store's
   * idempotent `propose`, `#137`) is asking whether an issue it may just have
   * opened exists.
   *
   * **Complete, or it throws.** The caller reads *not listed* as *does not
   * exist* and opens one, so a listing that silently stopped short would be a
   * duplicate. Paged newest first and stopped at the first issue created
   * before `since`, so the pages are the window's issues and not every issue
   * anybody commented on since.
   */
  listIssuesSince(since: Date): E<Issue[]>
  getIssue(number: number): E<Issue>

  /**
   * Posts a comment.
   *
   * The first write on this client, and it stays narrow on purpose: everything
   * that changes *code* still goes through git, so this is only for telling a
   * person something on the ticket they are already looking at.
   *
   * Called by `conductor`'s `tell.ts` as a run changes state, and the outcome
   * is appended. The old loop called `gh` inline too — the difference is the
   * record: a failed call there vanished, leaving nobody able to tell "we never
   * commented" from "we commented and it did not help".
   */
  comment(issue: number, body: string): E<{ id: number }>

  /**
   * Replaces the whole label set.
   *
   * Replace rather than add, because `--add-label` is set union and not a
   * transition — which is how #35 ended up carrying `agent:blocked` and
   * `agent:review` at the same time with nothing able to notice. A state that
   * is computed and then *set* cannot hold two contradictory values.
   */
  setLabels(issue: number, labels: readonly string[]): E<void>

  /**
   * Adds labels to what the issue already has, leaving the rest alone.
   *
   * For a caller that has not just read the set: `setLabels` from a snapshot
   * would drop a label somebody added since (an `agent:hold`, say).
   */
  addLabels(issue: number, labels: readonly string[]): E<void>

  /** Replaces one comment's whole body (#750). The response is read for its status only. */
  editComment(issue: number, commentId: number, body: string): E<void>

  /**
   * Closes an issue, as completed.
   *
   * The gap this fills: nothing closed a landed issue, and `labelsFor("landed")`
   * removes Lingtai's own label — so an issue Lingtai had merged was
   * indistinguishable on GitHub from one it had never touched. The old loop's
   * failure was state living in labels; the failure after it was state living
   * nowhere.
   */
  closeIssue(issue: number, reason?: 'completed' | 'not_planned'): E<void>

  /**
   * Replaces the issue body.
   *
   * The second write that changes what a *later run reads*, and the only one:
   * the prompt is filled from the issue body, so this is where an instruction
   * meant to outlive one attempt goes
   * ([0032](../../../doc/decisions-archive/0032-the-page-is-organised-by-attempt.md)
   * §6). A comment would not reach it — nothing renders comments into a prompt
   * — and a durable override kept inside Lingtai would be a shadow ticket body
   * nobody outside can see.
   *
   * It replaces, as `setLabels` does, because that is what GitHub offers. The
   * caller is therefore the one that has to have read the current body first;
   * `tell.ts` takes the whole new body and does not compose it.
   *
   * `ifUnchanged`, when given, must be the body exactly as `getIssue` last
   * answered it — never one this process composed — because GitHub may
   * normalise what it stores (line endings from the web editor, for one), and
   * comparing against a body this process sent would refuse on every call.
   * Refuses with `BodyChanged` when the issue's body is no longer that; see
   * the class's own comment for how far that check reaches.
   */
  updateBody(
    issue: number,
    body: string,
    opts?: { ifUnchanged?: string },
  ): Effect.Effect<void, GitHubFailed | BodyChanged>

  /**
   * Opens an issue.
   *
   * The one write that creates a ticket rather than changing one, and it has
   * exactly one caller: a person accepting a backlog entry (`#137`), through
   * the conductor's `TicketStore`. Nothing decides on its own that an issue
   * should exist — Lingtai proposes, a person decides.
   */
  createIssue(input: { title: string; body: string; labels: readonly string[] }): E<Issue>

  /**
   * Attaches `child` to `parent` as a sub-issue. Both are issue **numbers** in
   * this repository; the internal id GitHub wants is looked up here.
   *
   * Thin on purpose, as `deleteRef` is: a link that already exists is GitHub's
   * 422 and throws, and a caller that must be idempotent lists first. A child
   * with a different parent fails too — `replace_parent` is never sent.
   */
  addSubIssue(parent: number, child: number): E<void>

  /** Every sub-issue of `parent`, across all pages, or a throw — never a short list. */
  listSubIssues(parent: number): E<LinkedIssue[]>

  /** Records that `issue` is blocked by `blocker` (numbers). The same 422 rule as `addSubIssue`. */
  addBlockedBy(issue: number, blocker: number): E<void>

  /** Every issue blocking `issue`, open or closed, across all pages, or a throw. */
  listBlockedBy(issue: number): E<LinkedIssue[]>

  /**
   * The current installation token, refreshed if it is about to expire.
   *
   * Exposed because git needs it and this client is the only thing that has it.
   * Both managed repositories here are private, so without this every clone is
   * an anonymous one — which fails at the first fetch, before anything else in a
   * run has a chance to.
   *
   * An Effect rather than a value on purpose. An installation token lasts an
   * hour and a run's wall limit is two, so a snapshot taken at the start would
   * be expired by the time the integrator pushes. Callers hold *this*, and
   * run it per git invocation.
   */
  readonly token: E<string>
}

/**
 * The promise face over `GitHub`, kept for the callers #790 has not moved. Its
 * members are those of `GitHub` — read the contracts there — with a promise for
 * an `Effect`, a rejection that is the `GitHubFailed` itself, and `token` a
 * function, resolved per git invocation and never memoised.
 */
export interface GitHubClient {
  readonly owner: string
  readonly repo: string
  readonly installation: Installation | null
  request<T>(method: string, path: string, body?: unknown): Promise<T>
  defaultBranch(): Promise<string>
  fileAt(path: string, ref: string): Promise<string | null>
  refSha(ref: string): Promise<string>
  matchingRefs(prefix: string): Promise<readonly string[]>
  deleteRef(ref: string): Promise<void>
  listOpenIssues(): Promise<Issue[]>
  listIssuesSince(since: Date): Promise<Issue[]>
  getIssue(number: number, signal?: AbortSignal): Promise<Issue>
  comment(issue: number, body: string): Promise<{ id: number }>
  setLabels(issue: number, labels: readonly string[]): Promise<void>
  addLabels(issue: number, labels: readonly string[]): Promise<void>
  editComment(issue: number, commentId: number, body: string): Promise<void>
  closeIssue(issue: number, reason?: 'completed' | 'not_planned'): Promise<void>
  updateBody(issue: number, body: string, opts?: { ifUnchanged?: string }): Promise<void>
  createIssue(input: { title: string; body: string; labels: readonly string[] }): Promise<Issue>
  addSubIssue(parent: number, child: number): Promise<void>
  listSubIssues(parent: number): Promise<LinkedIssue[]>
  addBlockedBy(issue: number, blocker: number): Promise<void>
  listBlockedBy(issue: number): Promise<LinkedIssue[]>
  token(): Promise<string>
}

/** How far `listIssuesSince` pages before it refuses to answer rather than answer short. */
const LIST_SINCE_PAGES = 50

/** How far a sub-issue or blocked-by listing pages before it refuses to answer short. */
const LINK_PAGES = 20

export interface CreateClientOptions {
  /** The App, or the machine's saved `gh` login. */
  auth: AppAuth | { kind: 'gh' }
  owner: string
  repo: string
  /** The `gh` runner, read only under `{ kind: 'gh' }`. Defaults to the real one. */
  gh?: GhRun
  /** The App's only: skips the installation lookup when one has already been made. */
  installation?: Installation
  /** Stops the installation lookup when it aborts; later requests take their own. */
  signal?: AbortSignal
}

function isGh(auth: AppAuth | { kind: 'gh' }): auth is { kind: 'gh' } {
  return 'kind' in auth && auth.kind === 'gh'
}

/**
 * GitHub's `color` as a CSS colour, or null.
 *
 * Six hex digits, no `#`, is what the REST API documents and what it has
 * always sent. Anything else — an empty string, a name, a shorthand — is
 * refused rather than repaired: a renderer that is handed a colour it cannot
 * parse has to invent one, and not having a colour is a case it already
 * handles.
 */
function hexColour(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const hex = raw.startsWith('#') ? raw.slice(1) : raw
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : null
}

/**
 * GitHub's `issue_dependencies_summary`, or null when it did not send one.
 *
 * **It arrives with the issue.** The per-issue endpoints
 * (`/issues/{n}/dependencies/blocked_by`) answer the same question one
 * request at a time, and a pass considers every open issue — so reading them
 * would turn one listing into one call per candidate. This field is on the
 * object `listOpenIssues` and `getIssue` already fetch, which is why asking
 * costs nothing, exactly as the label colour does.
 *
 * Refused rather than repaired when it is not two numbers: a partial summary
 * would decide which tickets the queue passes over, and `null` is a case the
 * caller already handles by saying so and carrying on.
 */
function dependenciesOf(raw: {
  issue_dependencies_summary?: { blocked_by?: number; total_blocked_by?: number } | null
}): Dependencies | null {
  const summary = raw.issue_dependencies_summary
  if (!summary) return null
  const { blocked_by: open, total_blocked_by: total } = summary
  if (typeof open !== 'number' || typeof total !== 'number') return null
  return { blockedBy: open, totalBlockedBy: total }
}

/**
 * The parent named by `parent_issue_url`
 * (`https://api.github.com/repos/o/r/issues/n`). Refused rather than
 * repaired, as `dependenciesOf` is: anything else is null.
 */
function parentOf(url: string | null | undefined): Issue['parent'] {
  const m = typeof url === 'string' ? /^https?:\/\/[^/]+\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(url) : null
  if (!m) return null
  const number = Number(m[2])
  return Number.isSafeInteger(number) && number > 0 ? { repository: m[1]!, number } : null
}

/** `sub_issues_summary`, or null unless both counts are numbers. */
function subIssuesOf(summary: { total?: number; completed?: number } | null | undefined): Issue['subIssues'] {
  if (!summary) return null
  const { total, completed } = summary
  if (typeof total !== 'number' || typeof completed !== 'number') return null
  return { total, completed }
}

function toIssue(raw: {
  number: number
  title: string
  body: string | null
  labels: ({ name?: string; color?: string | null } | string)[]
  state: string
  state_reason?: string | null
  html_url: string
  issue_dependencies_summary?: { blocked_by?: number; total_blocked_by?: number } | null
  assignees?: ({ login?: string } | null)[] | null
  parent_issue_url?: string | null
  sub_issues_summary?: { total?: number; completed?: number } | null
}): Issue {
  return {
    dependencies: dependenciesOf(raw),
    parent: parentOf(raw.parent_issue_url),
    subIssues: subIssuesOf(raw.sub_issues_summary),
    // Off the listing, never `/issues/{n}/assignees`: a pass considers every
    // open issue, and one request each would be the cost `dependenciesOf`
    // refuses for the same reason.
    assignees: (raw.assignees ?? []).map((a) => a?.login ?? '').filter((login) => login !== ''),
    number: raw.number,
    title: raw.title,
    body: raw.body ?? '',
    labels: raw.labels
      .map((l) =>
        typeof l === 'string' ? { name: l, color: null } : { name: l.name ?? '', color: hexColour(l.color) },
      )
      .filter((l) => l.name !== ''),
    state: raw.state === 'closed' ? 'closed' : 'open',
    stateReason: raw.state_reason === 'completed' || raw.state_reason === 'not_planned' ? raw.state_reason : null,
    url: raw.html_url,
  }
}

/**
 * Builds the Effect-shaped client. The token cache is made here, once, inside
 * the Effect that makes the client — a cache made per call would pass every
 * test and ask GitHub for a token on every request.
 *
 * `signal` is not an option: interruption replaces it.
 */
export const makeGitHub = (
  options: Omit<CreateClientOptions, 'signal'>,
): Effect.Effect<GitHub, GitHubFailed | NotInstalledError> =>
  Effect.gen(function* () {
    const { auth, owner, repo } = options
    let installation: Installation | null = null
    let token: E<string>
    if (isGh(auth)) {
      // No installation: the saved login is a person's, and each call asks `gh` afresh.
      const run = options.gh ?? liveGh
      token = Effect.suspend(() => ghTokenEffect(run))
    } else {
      installation = options.installation ?? (yield* installationForRepoEffect(auth, owner, repo))
      token = yield* installationToken(auth, installation.id)
    }

    const send = <T>(method: string, path: string, body?: unknown): E<T> =>
      Effect.flatMap(token, (t) => githubJson<T>(method, path, t, body))

    const repoPath = `/repos/${owner}/${repo}`

    /** The internal id of an issue in this repository. A 404 fails: there is no such issue to link. */
    const idOf = (number: number): E<number> =>
      Effect.map(send<{ id: number }>('GET', `${repoPath}/issues/${number}`), (raw) => raw.id)

    /**
     * Runs a link call, turning a 403 that is a missing permission into
     * `PermissionDenied`. A secondary rate limit is also a 403 and is passed on
     * unchanged: calling it a permission would send a person to the wrong page.
     */
    const asLinkCall = <A>(level: 'read' | 'write', call: E<A>): E<A> =>
      Effect.catchIf(
        call,
        (err) => err.status === 403 && !err.rateLimited,
        (err) => Effect.fail(new PermissionDenied(err, 'issues', level, isGh(auth) ? 'gh' : 'app')),
      )

    const listLinked = (path: string): E<LinkedIssue[]> =>
      asLinkCall(
        'read',
        Effect.gen(function* () {
          const out: LinkedIssue[] = []
          for (let page = 1; ; page++) {
            if (page > LINK_PAGES) {
              return yield* new GitHubFailed(
                0,
                path,
                `more than ${LINK_PAGES * 100} issues are linked at ${path} — the listing is incomplete, ` +
                  `so it cannot say a link is not there`,
              )
            }
            // A 404 is not an empty list either: it is the issue or the repository.
            const raw = yield* send<(Parameters<typeof toIssue>[0] & { id: number; repository_url?: string })[]>(
              'GET',
              `${path}?per_page=100&page=${page}`,
            )
            for (const each of raw) {
              const repository = each.repository_url?.replace(/^.*\/repos\//, '') ?? `${owner}/${repo}`
              out.push({ ...toIssue(each), repository, id: each.id })
            }
            if (raw.length < 100) break
          }
          return out
        }),
      )

    const github: GitHub = {
      owner,
      repo,
      installation,
      // The same source `send` uses, handed out so git can authenticate too.
      token,
      request: <T>(method: string, path: string, body?: unknown) =>
        Effect.withSpan(send<T>(method, path, body), 'github.request'),

      comment: Effect.fn('github.comment')(function* (issue: number, body: string) {
        return yield* send<{ id: number }>('POST', `${repoPath}/issues/${issue}/comments`, { body })
      }),

      editComment: Effect.fn('github.editComment')(function* (_issue: number, commentId: number, body: string) {
        yield* send<unknown>('PATCH', `${repoPath}/issues/comments/${commentId}`, { body })
      }),

      closeIssue: Effect.fn('github.closeIssue')(function* (
        issue: number,
        reason: 'completed' | 'not_planned' = 'completed',
      ) {
        yield* send<unknown>('PATCH', `${repoPath}/issues/${issue}`, { state: 'closed', state_reason: reason })
      }),

      updateBody: Effect.fn('github.updateBody')(function* (
        issue: number,
        body: string,
        opts?: { ifUnchanged?: string },
      ) {
        if (opts?.ifUnchanged !== undefined) {
          const current = toIssue(yield* send<Parameters<typeof toIssue>[0]>('GET', `${repoPath}/issues/${issue}`))
          if (current.body !== opts.ifUnchanged) return yield* new BodyChanged(issue)
        }
        yield* send<unknown>('PATCH', `${repoPath}/issues/${issue}`, { body })
      }),

      setLabels: Effect.fn('github.setLabels')(function* (issue: number, labels: readonly string[]) {
        yield* send<unknown>('PUT', `${repoPath}/issues/${issue}/labels`, { labels: [...labels] })
      }),

      addLabels: Effect.fn('github.addLabels')(function* (issue: number, labels: readonly string[]) {
        yield* send<unknown>('POST', `${repoPath}/issues/${issue}/labels`, { labels: [...labels] })
      }),

      defaultBranch: Effect.fn('github.defaultBranch')(function* () {
        const raw = yield* send<{ default_branch: string }>('GET', repoPath)
        return raw.default_branch
      }),

      fileAt: Effect.fn('github.fileAt')(function* (path: string, ref: string) {
        // A missing file is an answer, not a failure — a repository with no
        // recipe is a repository that has not been onboarded yet.
        const raw = yield* send<{ content?: string; encoding?: string }>(
          'GET',
          `${repoPath}/contents/${path}?ref=${encodeURIComponent(ref)}`,
        ).pipe(
          Effect.catchIf(
            (err) => err.status === 404,
            () => Effect.succeed(null),
          ),
        )
        if (raw === null || !raw.content) return null
        return Buffer.from(raw.content, (raw.encoding as BufferEncoding) ?? 'base64').toString('utf8')
      }),

      refSha: Effect.fn('github.refSha')(function* (ref: string) {
        const raw = yield* send<{ sha: string }>('GET', `${repoPath}/commits/${encodeURIComponent(ref)}`)
        return raw.sha
      }),

      matchingRefs: Effect.fn('github.matchingRefs')(function* (prefix: string) {
        // **Nothing swallowed, and not even a 404.** This endpoint answers a 200
        // and `[]` when no ref shares the prefix, so unlike `fileAt` it has no
        // status that means *absence* — a 404 here is the repository, not the
        // refs, and reading it as an empty list would tell a sweep there was
        // nothing to delete on a remote it can no longer see.
        const raw = yield* send<{ ref: string }[]>('GET', `${repoPath}/git/matching-refs/${prefix}`)
        return raw.map((each) => each.ref.replace(/^refs\//, ''))
      }),

      deleteRef: Effect.fn('github.deleteRef')(function* (ref: string) {
        yield* send<unknown>('DELETE', `${repoPath}/git/refs/${ref}`)
      }),

      listOpenIssues: Effect.fn('github.listOpenIssues')(function* () {
        const out: Issue[] = []
        for (let page = 1; page <= 10; page++) {
          const raw = yield* send<Parameters<typeof toIssue>[0][]>(
            'GET',
            `${repoPath}/issues?state=open&per_page=100&page=${page}`,
          )
          // GitHub returns pull requests from the issues endpoint. A PR is not a
          // work item.
          const issues = raw.filter((r) => !('pull_request' in r))
          out.push(...issues.map(toIssue))
          if (raw.length < 100) break
        }
        return out
      }),

      createIssue: Effect.fn('github.createIssue')(function* (input: {
        title: string
        body: string
        labels: readonly string[]
      }) {
        return toIssue(
          yield* send<Parameters<typeof toIssue>[0]>('POST', `${repoPath}/issues`, {
            title: input.title,
            body: input.body,
            labels: [...input.labels],
          }),
        )
      }),

      addSubIssue: Effect.fn('github.addSubIssue')(function* (parent: number, child: number) {
        const path = `${repoPath}/issues/${parent}/sub_issues`
        yield* asLinkCall(
          'write',
          Effect.gen(function* () {
            yield* send<unknown>('POST', path, { sub_issue_id: yield* idOf(child) })
          }),
        )
      }),

      listSubIssues: Effect.fn('github.listSubIssues')(function* (parent: number) {
        return yield* listLinked(`${repoPath}/issues/${parent}/sub_issues`)
      }),

      addBlockedBy: Effect.fn('github.addBlockedBy')(function* (issue: number, blocker: number) {
        const path = `${repoPath}/issues/${issue}/dependencies/blocked_by`
        yield* asLinkCall(
          'write',
          Effect.gen(function* () {
            yield* send<unknown>('POST', path, { issue_id: yield* idOf(blocker) })
          }),
        )
      }),

      listBlockedBy: Effect.fn('github.listBlockedBy')(function* (issue: number) {
        return yield* listLinked(`${repoPath}/issues/${issue}/dependencies/blocked_by`)
      }),

      listIssuesSince: Effect.fn('github.listIssuesSince')(function* (since: Date) {
        const out: Issue[] = []
        for (let page = 1; ; page++) {
          if (page > LIST_SINCE_PAGES) {
            return yield* new GitHubFailed(
              0,
              `${repoPath}/issues`,
              `more than ${LIST_SINCE_PAGES * 100} issues in ${owner}/${repo} were created since ${since.toISOString()} — ` +
                `the listing is incomplete, so it cannot say an issue is not there`,
            )
          }
          // `since` filters on `updated_at`, which every issue created since also
          // passes; the order is by creation, so the window ends at the first
          // issue older than it.
          const raw = yield* send<(Parameters<typeof toIssue>[0] & { created_at: string })[]>(
            'GET',
            `${repoPath}/issues?state=all&since=${encodeURIComponent(since.toISOString())}` +
              `&sort=created&direction=desc&per_page=100&page=${page}`,
          )
          const inWindow = raw.filter((r) => Date.parse(r.created_at) >= since.getTime())
          out.push(...inWindow.filter((r) => !('pull_request' in r)).map(toIssue))
          if (raw.length < 100 || inWindow.length < raw.length) break
        }
        return out.reverse()
      }),

      getIssue: Effect.fn('github.getIssue')(function* (number: number) {
        return toIssue(yield* send<Parameters<typeof toIssue>[0]>('GET', `${repoPath}/issues/${number}`))
      }),
    }
    return github
  })

/** The promise object over a `GitHub`: every member an arrow into the one face. */
const makeGitHubClient = (
  options: CreateClientOptions,
): Effect.Effect<GitHubClient, GitHubFailed | NotInstalledError> =>
  Effect.map(makeGitHub(options), (github): GitHubClient => ({
    owner: github.owner,
    repo: github.repo,
    installation: github.installation,
    request: <T>(method: string, path: string, body?: unknown) => runGitHub(github.request<T>(method, path, body)),
    // A fresh run per call, never a memoised promise: an installation token
    // lasts an hour and git resolves this per invocation.
    token: () => runGitHub(github.token),
    defaultBranch: () => runGitHub(github.defaultBranch()),
    fileAt: (path, ref) => runGitHub(github.fileAt(path, ref)),
    refSha: (ref) => runGitHub(github.refSha(ref)),
    matchingRefs: (prefix) => runGitHub(github.matchingRefs(prefix)),
    deleteRef: (ref) => runGitHub(github.deleteRef(ref)),
    listOpenIssues: () => runGitHub(github.listOpenIssues()),
    listIssuesSince: (since) => runGitHub(github.listIssuesSince(since)),
    getIssue: (number, signal) => runGitHub(github.getIssue(number), signal),
    comment: (issue, body) => runGitHub(github.comment(issue, body)),
    setLabels: (issue, labels) => runGitHub(github.setLabels(issue, labels)),
    addLabels: (issue, labels) => runGitHub(github.addLabels(issue, labels)),
    editComment: (issue, commentId, body) => runGitHub(github.editComment(issue, commentId, body)),
    closeIssue: (issue, reason) => runGitHub(github.closeIssue(issue, reason)),
    updateBody: (issue, body, opts) => runGitHub(github.updateBody(issue, body, opts)),
    createIssue: (input) => runGitHub(github.createIssue(input)),
    addSubIssue: (parent, child) => runGitHub(github.addSubIssue(parent, child)),
    listSubIssues: (parent) => runGitHub(github.listSubIssues(parent)),
    addBlockedBy: (issue, blocker) => runGitHub(github.addBlockedBy(issue, blocker)),
    listBlockedBy: (issue) => runGitHub(github.listBlockedBy(issue)),
  }))

/** `options.signal` stops the installation lookup; later requests take their own. */
export function createGitHubClient(options: CreateClientOptions): Promise<GitHubClient> {
  return runGitHub(makeGitHubClient(options), options.signal)
}

/**
 * A repository as a person names it → its parts, or a message saying what was
 * wrong with it (#168).
 *
 * **Every shape that is on a clipboard**, because a link is what a person has
 * and `owner/repo` is what this code wanted:
 *
 * ```
 * steven-zhc/lingtai
 * steven-zhc/lingtai/                               trailing slash
 * https://github.com/steven-zhc/lingtai             and http://, www.
 * github.com/steven-zhc/lingtai                     no scheme
 * https://github.com/steven-zhc/lingtai.git
 * https://github.com/steven-zhc/lingtai/tree/main   any page inside the repository
 * git@github.com:steven-zhc/lingtai.git             and ssh://git@github.com/…
 * ```
 *
 * **`.git` is taken off, and that is a fix and not a convenience.** `.` is a
 * legal character in a repository name, so the old pattern parsed
 * `owner/repo.git` *successfully* into a repository called `repo.git` — GitHub
 * answered 404 and `lingtai add` said the App was not installed on a repository
 * nobody meant. GitHub does not allow a name ending in `.git`, so stripping it
 * never takes away a real one.
 *
 * Extra path segments are accepted only behind `github.com`: there they are a
 * page inside the repository, while a bare `a/b/c` is not a thing anybody
 * copies and is more likely a mistake than a link.
 */
export function parseSlug(slug: string): { owner: string; repo: string } {
  const refuse = (why?: string) => new Error(`"${slug}" is not owner/repo${why ? ` — ${why}` : ''}`)
  let rest = slug.trim()

  let linked = false
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(.*)$/.exec(rest)
  if (scp) {
    if (!isGitHubHost(scp[1]!)) throw refuse(`${scp[1]} is not github.com`)
    rest = scp[2]!
    linked = true
  } else {
    const url = /^(?:(?:https?|ssh|git):\/\/)?(?:[^@/]+@)?([A-Za-z0-9.-]+\.[A-Za-z]{2,})(?::\d+)?\/(.*)$/.exec(rest)
    if (url) {
      if (!isGitHubHost(url[1]!)) throw refuse(`${url[1]} is not github.com`)
      rest = url[2]!
      linked = true
    }
  }

  // A query or a fragment belongs to the page, not to the repository.
  const parts = rest
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .split('/')
  if (parts.length < 2 || parts.includes('') || (!linked && parts.length > 2)) throw refuse()

  const owner = parts[0]!
  const repo = parts[1]!.replace(/\.git$/i, '')
  const name = /^[A-Za-z0-9._-]+$/
  if (!name.test(owner) || !name.test(repo) || repo === '.' || repo === '..') throw refuse()
  return { owner, repo }
}

function isGitHubHost(host: string): boolean {
  const h = host.toLowerCase()
  return h === 'github.com' || h === 'www.github.com'
}
