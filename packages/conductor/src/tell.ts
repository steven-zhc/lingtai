import { inSpan } from '@lingtai/actions/spans'
/**
 * Telling GitHub what the log now says about one issue.
 *
 * This is what replaced the outbox ([0022](../../../doc/decisions-archive/0022-the-seams.md)).
 * The outbox was a table, a projection, a worker, a backoff and a dead-letter
 * standing behind three calls — a comment, the label set, and closing — and the
 * failure all of that retried had never once been observed. What it bought that
 * is worth keeping is the *record*: the old loop called `gh` inline and a failed
 * call left nothing at all, so afterwards nobody could tell "we never
 * commented" from "we commented and it did not help".
 *
 * So the record stays and the machine goes. Every attempt appends its outcome —
 * `IssueUpdated` or `IssueUpdateFailed` — and **nothing here ever throws**. A
 * label that did not land must not turn a merge that did into a failed run:
 * the work happened, and saying otherwise would be the more expensive lie.
 * What did not land is converged later by `reconcile`, which compares what the
 * log says an issue should look like against what GitHub says it does.
 *
 * ## The port, declared here
 *
 * `IssueChannel` is the shape this needs, not the shape `@lingtai/github`
 * happens to have. It is `Tickets` (`ticket-store.ts`, `#377`) narrowed on one
 * verb: `getIssue` here answers labels only, because what Lingtai writes back
 * is a set of names and a repository's colour is a fact for the board to read
 * (#85), not one a write has any business carrying. `GitHubClient` satisfies
 * it structurally, and a test satisfies it with four functions and no
 * network — which is the whole point of a caller naming its own requirement.
 */
import { landingCommentTriedOf, parseTicketStream, ticketReducer } from '@lingtai/domain'
import { type PayloadOf, type ToAppend, parsePayload } from '@lingtai/domain'
import type { EventStore, SnapshotReadOptions } from '@lingtai/event-store'

import { agentBranch, armPrefix } from './branches.ts'
import { foreignLabels } from './labels.ts'
import { readState } from './snapshot-state.ts'
import type { Tickets } from './ticket-store.ts'

/** What this needs of GitHub, and nothing more. */
export type IssueChannel = Pick<Tickets, 'comment' | 'editComment' | 'setLabels' | 'closeIssue' | 'updateBody'> & {
  /**
   * The labels as GitHub holds them — names, and the colours it sends beside
   * them. Only the names matter here: what Lingtai writes back is a set of
   * names, and a repository's colour is a fact for the board to read (#85), not
   * one a write has any business carrying. `body` is read by `edit-body.ts`'s
   * `writeSection` (#422), which needs the body itself to find a section and
   * compose its replacement.
   */
  getIssue(number: number): Promise<{ labels: readonly { name: string }[]; body: string }>
}

/**
 * **The refs half, declared apart from the issue half** (`#240`).
 *
 * `end`'s third effect deletes branches rather than writing to an issue, so it
 * needs two calls `IssueChannel` has no business carrying — and everything that
 * only comments, labels or closes (`discuss.ts`, the board's own ticket path)
 * would have had to grow them for nothing. `GitHubClient` satisfies both, and
 * `tellGitHubAbout` asks for both because it is the one function that carries
 * out an `EndActionsResolved` and may meet any of the three.
 */
export interface RefChannel {
  /**
   * Every ref beginning `refs/<prefix>`, named **without** the leading `refs/`
   * — `heads/agent/240-attempt-1`. GitHub matches this as a plain string
   * prefix, so `heads/agent/24` answers `heads/agent/240`'s refs too and the
   * caller filters.
   */
  matchingRefs(prefix: string): Promise<readonly string[]>
  /** Deletes one, named as `matchingRefs` names it. */
  deleteRef(ref: string): Promise<void>
}

/**
 * The five things Lingtai ever does to an issue and the refs that belong to it.
 *
 * A field rather than an event type each, because with the failures that would
 * have been ten, and all five are handled identically.
 *
 * **`refs` is the one that is not a write to the issue** (`#240`): it deletes
 * the `agent/<n>-attempt-<k>` refs a landed ticket's abandoned approaches left
 * on `origin`. It is here rather than in a module of its own because it is one
 * of `end`'s effects, and `tellGitHubAbout` is the single place those are
 * carried out — a second carrier is a path that forgets one, which is the
 * failure `end-step.ts`'s header is about. It names no refs: the branch is
 * derived from the work item, and which arms exist is asked of GitHub at the
 * moment of deleting rather than carried from a resolution minutes earlier.
 *
 * `body` is the one that changes what a *later run* reads
 * ([0032](../../../doc/decisions-archive/0032-the-page-is-organised-by-attempt.md) §6):
 * the prompt is filled from the issue body, so an instruction meant to outlive
 * one attempt goes there and nowhere else. It carries the whole new body,
 * because that is what GitHub takes — composing it is the caller's job, and
 * doing it here would put "what the sentence should look like" inside the
 * function that only knows how to send one.
 *
 * `body`'s `ifUnchanged`, when given, is passed straight through to
 * `IssueChannel.updateBody` — `writeSection` (`edit-body.ts`, #422) is what
 * sets it, so a body edited since it was read is refused with `BodyChanged`
 * rather than overwritten.
 */
export type IssueChange =
  | { kind: 'comment'; body: string; waitId?: string; question?: string }
  | { kind: 'comment-edited'; waitId: string; commentId: number; body: string }
  | { kind: 'labels'; labels: readonly string[] }
  | { kind: 'closed' }
  | { kind: 'body'; body: string; ifUnchanged?: string }
  | { kind: 'refs'; andTheBranch: boolean }

/**
 * The four of them `tellGitHub` takes — every change that is a write to the
 * issue, and so every change an `IssueChannel` can carry out.
 *
 * `refs` is the fifth and is `sweepRefs`'s, because it needs a `RefChannel`
 * instead. Split by *what port it needs* rather than kept as one function with
 * a wider one: `discuss.ts` and the board's ticket path hand `tellGitHub` an
 * object with four methods on it, and widening the parameter would make them
 * supply two they never call.
 */
export type IssueWrite = Exclude<IssueChange, { kind: 'refs' }>

export interface TellOptions {
  store: EventStore
  github: IssueChannel
  /** `ticket-<project>-<issue>`. */
  ticketId: string
  change: IssueWrite
}

/**
 * `ticket-project-155` → project and issue. Split at the *last* hyphen: a
 * project name may contain one. Exported for `writeSection` (`edit-body.ts`,
 * #422), which needs the issue number for `github.getIssue` itself.
 */
export function split(ticketId: string): { project: string; issue: number } | null {
  const parsed = parseTicketStream(ticketId)
  if (!parsed) return null
  // This path nominates issues by number; a non-numeric ref is not one it can
  // tell GitHub about.
  const issue = Number(parsed.issue)
  return Number.isInteger(issue) ? { project: parsed.project, issue } : null
}

/**
 * What `tellGitHub` recorded — the error itself, not just which event landed,
 * because `writeSection` (`edit-body.ts`, #422) has to tell a `BodyChanged`
 * (retry against the new body) from any other failure (stop) and the error is
 * otherwise kept only as `.message`, inside `IssueUpdateFailed.error`.
 *
 * `recorded: null` is `split(ticketId)` failing — the ticketId did not parse,
 * so nothing was tried and nothing was appended either.
 */
export type Told = { recorded: 'IssueUpdated' } | { recorded: 'IssueUpdateFailed'; error: unknown } | { recorded: null }

/**
 * Do it, and append what happened. Never throws.
 *
 * The labels case is read-modify-write and has to be: `setLabels` replaces the
 * whole set — deliberately, because `--add-label` is set union rather than a
 * transition, which is how #35 came to carry two contradictory labels at once —
 * and a replace given only Lingtai's labels deletes everybody else's. It did:
 * the first outbox drain stripped `enhancement` off three admin issues, which
 * is the label their recipe selects on, so Lingtai deleted its own queue's
 * selection criteria. A label somebody adds inside the round trip is lost, and
 * that is a far smaller wrong than deleting all of them.
 */
export async function tellGitHub(options: TellOptions): Promise<Told> {
  const { store, github, ticketId, change } = options
  const target = split(ticketId)
  if (target === null) return { recorded: null }
  const { project, issue } = target

  let detail = ''
  try {
    switch (change.kind) {
      case 'comment': {
        const { id } = await github.comment(issue, change.body)
        detail = String(id)
        break
      }
      case 'comment-edited':
        await github.editComment(issue, change.commentId, change.body)
        detail = String(change.commentId)
        break
      case 'labels': {
        const current = await github.getIssue(issue)
        const carried = current.labels.map((l) => l.name)
        const whole = [...new Set([...foreignLabels(carried), ...change.labels])]
        await github.setLabels(issue, whole)
        detail = change.labels.join(',')
        break
      }
      case 'closed':
        await github.closeIssue(issue)
        break
      case 'body':
        await github.updateBody(
          issue,
          change.body,
          change.ifUnchanged !== undefined ? { ifUnchanged: change.ifUnchanged } : undefined,
        )
        // The size, not the text. The body is on GitHub and the sentence that
        // was added is on the log already — `PromptEdited` or the discussion
        // that proposed it — and a third copy here is one that can disagree.
        detail = `${change.body.length} bytes`
        break
    }
  } catch (err) {
    await record(
      store,
      ticketId,
      'IssueUpdateFailed', // the update threw
      {
        project,
        issue: String(issue),
        change: change.kind,
        error: (err as Error).message,
        ...(change.kind === 'comment-edited' || (change.kind === 'comment' && change.waitId !== undefined)
          ? { waitId: change.waitId! }
          : {}),
      },
    )
    return { recorded: 'IssueUpdateFailed', error: err }
  }
  await record(store, ticketId, 'IssueUpdated', {
    project,
    issue: String(issue),
    change: change.kind,
    detail,
    ...(change.kind === 'comment' || change.kind === 'comment-edited'
      ? {
          ...(change.waitId !== undefined ? { waitId: change.waitId } : {}),
          ...(change.kind === 'comment' && change.question !== undefined ? { question: change.question } : {}),
        }
      : {}),
  })
  return { recorded: 'IssueUpdated' }
}

/**
 * **`end`'s third effect: the history refs a landed ticket left on `origin`,
 * deleted** (`#240`).
 *
 * `agent/<n>-attempt-<k>` is published by every claim that produced commits
 * ([0062](../../../doc/decisions-archive/0062-what-a-claim-leaves-behind.md) §2), one
 * per approach the item tried, and nothing has ever deleted one — so the count
 * of `agent/*` on a remote is monotone in how many issues the repository has
 * had, and every clone, `ls-remote` and fetch pays for all of them. After a
 * landing those arms name approaches that were abandoned or superseded and
 * their commits are unreachable from `main`.
 *
 * **Which refs is asked of GitHub here, not carried from the resolution.**
 * `EndActionsResolved` says *sweep this item's arms*, and minutes may pass
 * before this runs; a list resolved then is a list that can disagree with what
 * is on the remote now.
 *
 * **It asks under `agent/<n>` and then filters by hand, and that is not
 * belt-and-braces.** GitHub's matching-refs is a plain string prefix, so
 * `heads/agent/24` answers `heads/agent/240-attempt-1` as well —
 * `startsWith(armPrefix)` is what keeps a two-digit ticket from deleting a
 * three-digit one's work, and `=== branch` is what keeps `agent/240` from
 * going when nobody asked for it.
 *
 * **A ref that is already gone is not an error**, which the shape gives for
 * free: only what was listed is deleted. Nothing here throws either — `end`
 * cannot refuse, so a delete GitHub declined is an `IssueUpdateFailed` and a
 * run that still landed.
 *
 * **A sweep can stop half way, and the failure row names what already went.**
 * The deletes are one call each, so a four-arm item whose third delete is
 * refused has two arms gone for good — and the names are the one fact a reader
 * coming back to the row cannot get from the remote any more, which is what
 * `sweepFailure` puts in the `error`. Without it *we swept nothing* and *we
 * swept half of it* are one row.
 *
 * **What is left is converged, not forgotten.** `findIssueDrift` re-asks GitHub
 * which arms are still there and `convergeIssues` deletes those
 * (`packages/daemon/src/converge.ts`), so the refusal is a job with an owner
 * rather than a permanent warning — the resolution is deduped per outcome
 * (`end-step.ts`) and nothing ever runs this function again for the same item.
 */
export function sweepRefs(options: Parameters<typeof sweepRefsHeld>[0]): Promise<void> {
  // A chain and not `async`: 0101 §6's ratchet (#792) counts the keyword.
  return sweepRefsHeld(options).then(() => undefined)
}

/** `sweepRefs`, saying whether the sweep finished — for the span that measures it (#791). */
async function sweepRefsHeld(options: {
  store: EventStore
  github: RefChannel
  /** `ticket-<project>-<issue>`. */
  ticketId: string
  /** `agent/<n>` itself, on top of its arms. */
  andTheBranch: boolean
}): Promise<boolean> {
  const { store, github, ticketId } = options
  const target = split(ticketId)
  if (target === null) return true
  const { project, issue } = target

  const branch = agentBranch(issue)
  const arms = armPrefix(branch)
  // Appended to as each delete comes back, so both endings can name it: the
  // row is written *after* the loop either way, and a `doomed` the loop did not
  // finish would describe refs that are still on `origin`.
  const gone: string[] = []
  try {
    const found = await github.matchingRefs(`heads/${branch}`)
    const doomed = found.filter(
      (ref) => ref.startsWith(`heads/${arms}`) || (options.andTheBranch && ref === `heads/${branch}`),
    )
    for (const ref of doomed) {
      await github.deleteRef(ref)
      gone.push(ref)
    }
  } catch (err) {
    await record(store, ticketId, 'IssueUpdateFailed', {
      project,
      issue: String(issue),
      change: 'refs',
      error: sweepFailure(err, gone),
    })
    return false
  }
  await record(store, ticketId, 'IssueUpdated', {
    project,
    issue: String(issue),
    change: 'refs',
    // The names and not the count, because *which* arms went is the only thing
    // a reader coming back to this row can no longer get from the remote.
    detail: gone.length === 0 ? 'none' : gone.join(','),
  })
  return true
}

/**
 * **A refused sweep, and what it had already deleted when it was refused**
 * (`#240`).
 *
 * `IssueUpdateFailed` carries an `error` and no `detail`, so the names go in the
 * message rather than in a second row: an `IssueUpdated` for `refs` then means
 * the sweep finished, and a reader never has to look at the row after this one
 * to find out whether it did. `convergeIssues` says it the same way for the
 * same reason.
 */
export function sweepFailure(err: unknown, gone: readonly string[]): string {
  const why = (err as Error).message
  return gone.length === 0 ? why : `${why} — after deleting ${gone.join(',')}`
}

/**
 * Appending the outcome must not be able to fail the caller either.
 *
 * A run that merged, told GitHub, and then could not write down that it had
 * told GitHub is still a run that merged. The log loses one fact, and losing it
 * costs exactly what 0022 kept this event for: afterwards nobody can tell "we
 * never commented" from "we commented and it did not help".
 *
 * **That cost is unpaid, not avoided.** `reconcile` is meant to find the
 * divergence by comparing against GitHub rather than against this row, and it
 * does not yet — it converges worktrees and nothing else (`#69`). Until it
 * does, a swallowed append here is a fact nothing recovers. Swallowing is still
 * right: failing the caller would turn a lost record into a lost merge.
 *
 * Exported for `writeSection` (`edit-body.ts`, #422) alone, which appends a
 * second `IssueUpdated` when a write `tellGitHub` recorded as failed is found
 * on the read-back anyway — the call threw, but it had already landed.
 */
export async function record(
  store: EventStore,
  ticketId: string,
  type: 'IssueUpdated' | 'IssueUpdateFailed',
  data: Record<string, string>,
): Promise<void> {
  try {
    const at = (await store.read(ticketId)).length
    await store.append(ticketId, at, [{ type, actor: 'conductor', data: parsePayload(type, data) }])
  } catch {
    // Deliberately silent: see above.
  }
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? ''
  )
}

/** The actor as the log has it (`human:steven`), without the `human:` prefix. */
function who(by: string): string {
  return by.replace(/^human:/, '')
}

/** `Approved by steven.` — or `Approved.` when the log names nobody. */
function sentence(what: string, by: string): string {
  const name = who(by)
  return name === '' ? `${what}.` : `${what} by ${name}.`
}

/**
 * What a resolution became, as one sentence. A `switch` with no `default`, so
 * a resolution added to `Resolution` is a type error here rather than a
 * comment that silently keeps saying *waiting on you*.
 */
function resolutionWords(resolution: PayloadOf<'WaitResolved'>['resolution'], by: string): string {
  switch (resolution._tag) {
    case 'Approve':
      return sentence('Approved', by)
    case 'GrantFixRound': {
      const name = who(by)
      return name === '' ? 'One more fix round, granted.' : `One more fix round, granted by ${name}.`
    }
    case 'Requeue':
    case 'EditBodyAndRequeue':
      return `${sentence('Requeued', by).replace(/\.$/, '')} — a new attempt started.`
    case 'AnswerQuestion': {
      const name = who(by)
      return `${name === '' ? 'Answered' : `Answered by ${name}`}: \`${resolution.choice}\``
    }
    case 'Close':
      return sentence('Closed', by)
    case 'Split':
      return sentence('Split', by)
  }
}

/**
 * **The waiting comment, rewritten into its outcome once the wait is over**
 * (#750).
 *
 * Reads the stream once, the comments and their edits off the ticket's
 * `github` ledger. A `comment` whose `IssueUpdated` carries a `waitId`
 * is edited when the reduce (`TicketState.waits`) shows that wait over — a `TicketLanded` or
 * `TicketClosed` after its `WaitStarted`, or a `WaitResolved` for it — and no
 * `comment-edited` for the same wait was recorded yet. An attempt is recorded
 * whether it worked or not, so a failed edit is skipped from then on and
 * **never answered with a second comment**: one comment per wait is the
 * decision, and `converge.ts` deliberately never re-posts one.
 *
 * **A comment posted and not recorded** (a restart between the two) has no id
 * on the log, so it is never edited and stays *waiting on you*. That is the
 * cost of `record` being best-effort; GitHub is not searched for it. A comment
 * posted before this existed carries no `waitId` and is left alone on purpose.
 *
 * Never throws, like everything here: a stream that cannot be read edits
 * nothing and records nothing, and the next call tries again.
 */
export async function editEndedWaits(
  options: {
    store: EventStore
    github: IssueChannel
    ticketId: string
  } & SnapshotReadOptions,
): Promise<void> {
  const { store, github, ticketId } = options
  try {
    const state = await readState(store, ticketReducer, ticketId, 'all', options)
    const ledger = state.github
    const edited = new Set<string>(ledger.edited)
    const posted = ledger.comments

    for (const p of posted) {
      if (edited.has(p.waitId)) continue
      // The latest wait with this id, the one `triageFactsOf` reads. An ending belongs
      // to a wait only while it is the latest: a first wait that was approved and held
      // again was approved, not landed (`reduceWaits`).
      const wait = state.waits.findLast((w) => w.waitId === p.waitId)
      if (wait === undefined) continue
      let outcome: string
      if (wait.landed !== null) {
        const sha = wait.landed.mergeCommit.slice(0, 7)
        outcome = `Landed on \`${wait.landed.base}\`${sha === '' ? '' : ` in \`${sha}\``}.`
      } else if (wait.resolution !== null) outcome = resolutionWords(wait.resolution.resolution, wait.resolution.by)
      else if (wait.closed !== null) outcome = sentence('Closed', wait.closed.by)
      else continue
      const body = `**${outcome}**${p.question === '' ? '' : `\n\n> ${p.question}`}`
      await tellGitHub({
        store,
        github,
        ticketId,
        change: { kind: 'comment-edited', waitId: p.waitId, commentId: p.commentId, body },
      })
    }
  } catch {
    // Deliberately silent: see above.
  }
}

/**
 * Markdown with every word-initial `@` outside code made harmless: `@` then a
 * zero-width joiner, so GitHub does not notify the person it names. Fenced
 * blocks and inline code spans are left as written (`@types/node` in a span is
 * not a mention).
 */
export function unmention(markdown: string): string {
  const defuse = (text: string) => text.replace(/(^|[^\w])@(?=[\w-])/g, '$1@‍')
  // Prose between fences: a backslash escapes the next character (so an escaped backtick opens
  // nothing), and a code span runs to the next backtick run of its width within the same
  // paragraph, across line breaks but not across a blank line.
  const prose = (text: string): string => {
    let out = ''
    let plain = ''
    let at = 0
    while (at < text.length) {
      const ch = text[at]!
      if (ch === '\\') {
        plain += text.slice(at, at + 2)
        at += 2
        continue
      }
      if (ch !== '`') {
        plain += ch
        at++
        continue
      }
      let end = at
      while (text[end] === '`') end++
      const width = end - at
      // A span cannot cross a block boundary: a blank line, or a line (indented at most three spaces)
      // that opens a heading, quote, list item that may interrupt a paragraph (a bullet, or `1.`),
      // thematic break or setext underline. An ATX heading's own line is the whole of its content.
      const lineStart = text.lastIndexOf('\n', at - 1) + 1
      const lineEndAt = text.indexOf('\n', end)
      const heading = / {0,3}#{1,6}(?:[ \t]|$)/y
      heading.lastIndex = lineStart
      const inHeading = heading.test(text.slice(0, lineEndAt === -1 ? text.length : lineEndAt))
      const brk = inHeading
        ? (lineEndAt === -1 ? text.length : lineEndAt) - end
        : text
            .slice(end)
            .search(
              /\n(?:[ \t]*\n| {0,3}(?:#{1,6}(?:[ \t]|\n|$)|>|[-*+][ \t]+\S|1[.)][ \t]+\S|(?:[-*_][ \t]*){3,}(?:\n|$)|=+[ \t]*(?:\n|$)))/,
            )
      const limit = brk === -1 ? text.length : end + brk
      let search = end
      let found = -1
      while (search < limit) {
        const next = text.indexOf('`', search)
        if (next === -1 || next >= limit) break
        let stop = next
        while (text[stop] === '`') stop++
        if (stop - next === width) {
          found = stop
          break
        }
        search = stop
      }
      if (found === -1) {
        plain += text.slice(at, end)
        at = end
        continue
      }
      out += defuse(plain) + text.slice(at, found)
      plain = ''
      at = found
    }
    return out + defuse(plain)
  }
  let out = ''
  let buffer = ''
  let fence: string | null = null
  const lines = markdown.split('\n')
  lines.forEach((line, i) => {
    const nl = i < lines.length - 1 ? '\n' : ''
    // A backtick fence's info string holds no backtick (else it is a code span's opener), and a
    // closing fence is the fence and whitespace alone.
    const m = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/.exec(line)
    if (fence !== null) {
      out += line + nl
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
      if (close !== null && close[1]!.startsWith(fence[0]!) && close[1]!.length >= fence.length) fence = null
      return
    }
    if (m !== null) {
      out += prose(buffer)
      buffer = ''
      fence = m[1]!
      out += line + nl
      return
    }
    buffer += line + nl
  })
  return out + prose(buffer)
}

/**
 * The text with every local filesystem path replaced: an absolute path under a
 * home, temp or system directory, a `~/` path, or a Windows user path. The
 * reviewer writes about a diff in a worktree and may name where it lives; a
 * comment on a public issue must not (#896).
 */
export function withoutLocalPaths(text: string): string {
  // A home directory's name may hold spaces (`/Users/Alice Smith/`), so any run of characters up to the
  // next separator is read as the name; a `file:` prefix (`file:/`, `file://`) is part of the path.
  const name = '(?:[^\\n\\\\/`\'"()\\[\\]<>]+[\\\\/])?'
  const rest = '[^\\s`\'")\\],;]*'
  const unix = new RegExp(
    `(?<![\\w.:/-])(?:file:(?:///?(?:localhost)?)?)?(?:/(?:Users|home)/${name}|/(?:private|var|tmp|root|opt)/|~/|\\$HOME/)${rest}`,
    'g',
  )
  const windows = new RegExp(
    `(?<![\\w])(?:file:/{1,3})?[A-Za-z]:[\\\\/](?:Users|Documents and Settings)[\\\\/]${name}${rest}`,
    'g',
  )
  return text.replace(unix, '[local path]').replace(windows, '[local path]')
}

/** What a landing carries to its comment (#896). */
export interface Landed {
  mergeCommit: string
  base: string
  attempt: number
  /** The landing run's last review's summary, or `null` when it gave none. */
  summary: string | null
}

/** The comment a landing posts: where it landed, the reviewer's summary when there is one, and which attempt. */
export function landingComment(landed: Landed): string {
  const sha = landed.mergeCommit.slice(0, 7)
  const head = `**Landed on \`${landed.base}\`${sha === '' ? '' : ` in \`${sha}\``}.**`
  if (landed.summary === null) return head
  return [head, unmention(withoutLocalPaths(landed.summary)), `Attempt ${landed.attempt} · reviewed cold`].join('\n\n')
}

/**
 * **One comment per landing, never a second** (#896). Posts nothing when the
 * ticket's stream already holds, after its latest `TicketLanded`, a `comment`
 * attempt with no `waitId` — `IssueUpdated` or `IssueUpdateFailed` alike, so a
 * refused post is not retried. A post made and not recorded (a restart between
 * the two) is not searched for and not re-posted: the same accepted cost as the
 * waiting comment. A stream that cannot be read posts nothing.
 */
function postLanding(store: EventStore, github: IssueChannel, ticketId: string, landed: Landed): Promise<void> {
  return store
    .read(ticketId)
    .then((events) =>
      landingCommentTriedOf(events)
        ? undefined
        : tellGitHub({ store, github, ticketId, change: { kind: 'comment', body: landingComment(landed) } }).then(
            () => undefined,
          ),
    )
    .catch(() => undefined) // Deliberately silent: nothing here throws.
}

/**
 * Everything one state change implies for an issue, in the order the outbox
 * used to send it.
 *
 * The outbox reduced events in `seq` order, so a comment appended beside its
 * `EndActionsResolved` went out first and the end point's own labels went out
 * second. That order is kept: it is the difference between an issue that ends
 * up closed and one that ends up closed and then reopened by a label write.
 *
 * **A blocked item now says so on GitHub.** For the whole life of the outbox it
 * did not: the projection set labels on `TicketClaimed`, `TicketReleased`
 * and `TicketLanded` only, so an item waiting on a person kept
 * `lingtai:working` while the board showed it in *Waiting on you*, and
 * `lingtai:waiting` was never once written. `442f513` preserved that on purpose
 * — a replacement that also changes behaviour cannot be reviewed as one — and
 * `#71` is where it changed. The three callers that start a wait pass
 * `labelsFor("waiting")` alongside the question.
 *
 * The order below is why they pass it rather than this function inferring it:
 * the recipe's own `end` actions run last and may set labels of their own, and
 * a recipe must be able to overrule a default.
 */
export async function tellGitHubAbout(
  options: {
    store: EventStore
    /**
     * Both ports, because this is the one function that carries out an
     * `EndActionsResolved` and `refs:` is one of the three things it may hold
     * (`#240`). Required rather than optional: a channel that silently cannot
     * delete is a recipe that resolved an effect nothing ran, which is `#61`.
     */
    github: IssueChannel & RefChannel
    ticketId: string
    /** Lingtai's own labels for this state, or `null` to leave them alone. */
    labels?: readonly string[] | null
    /** The question, when a person is now the thing being waited on. */
    question?: string
    /** The wait `question` announces; recorded so the comment can be edited when the wait ends (#750). */
    waitId?: string
    /**
     * First rewrite the waiting comment of every wait the log shows is over (#750).
     * Passed by `conduct.ts` alone: the CLI and the board never edit, so that a
     * comment has one writer.
     */
    editEnded?: boolean
    /** The events just appended; any `EndActionsResolved` among them is carried out. */
    appended?: readonly ToAppend[]
    /** The landing, when this call tells of one: one comment, posted before `appended`'s close (#896). */
    landed?: Landed
  } & SnapshotReadOptions,
): Promise<void> {
  const { store, github, ticketId } = options
  // `IssueWrite` and not `IssueChange`: the `refs` member is `sweepRefs`'s, and
  // a helper that took the wider union would let one reach `tellGitHub`, whose
  // `switch` has a case for each of the four issue writes and no default — so a
  // `refs` change there falls straight through and records an `IssueUpdated`
  // for a sweep that never ran. That is `#61`'s failure inside one function.
  const tell = (change: IssueWrite) => tellGitHub({ store, github, ticketId, change })

  if (options.editEnded === true)
    await editEndedWaits({
      store,
      github,
      ticketId,
      ...(options.snapshots === undefined ? {} : { snapshots: options.snapshots }),
      ...(options.writer === undefined ? {} : { writer: options.writer }),
    })

  if (options.question !== undefined) {
    const first = firstLine(options.question)
    await tell({
      kind: 'comment',
      body: `**Lingtai is waiting on you.**\n\n${options.question}`,
      ...(options.waitId !== undefined ? { waitId: options.waitId } : {}),
      ...(options.waitId !== undefined && first !== '' ? { question: first } : {}),
    })
  }
  if (options.labels != null) await tell({ kind: 'labels', labels: options.labels })
  if (options.landed !== undefined) await postLanding(store, github, ticketId, options.landed)

  for (const e of options.appended ?? []) {
    if (e.type !== 'EndActionsResolved') continue
    const d = e.data as PayloadOf<'EndActionsResolved'>
    // **The sweep goes last within the item, and this line is what makes that
    // true** rather than what a recipe happened to declare. It is the only
    // irreversible effect, and a failure anywhere before it must not have
    // already deleted the branches somebody would use to work out what went
    // wrong — so `end: [{refs}, {labels}]` runs the label write first, as
    // `end: [{labels}, {refs}]` does. Order *among* the writes is still the
    // recipe's, because close-then-label and label-then-close differ: an issue
    // closed and then labelled can come back open.
    const writes = d.actions.filter((a) => !('refs' in a))
    const sweeps = d.actions.filter((a) => 'refs' in a)
    // The `end` step's work as it runs (#791): `runStep` only resolves these, so
    // the span that measures them is here, named by kind and never by content.
    const ordered = [...writes, ...sweeps]
    // A write GitHub refused is a *returned* `IssueUpdateFailed`, not a throw, so
    // each body says whether it held and the spans are told.
    const held = (told: Told) => told.recorded !== 'IssueUpdateFailed'
    await inSpan('step end', {}, () =>
      ordered.reduce<Promise<boolean>>(
        (before, action, index) =>
          before.then((all) =>
            inSpan(
              `action ${'close' in action ? 'close' : 'labels' in action ? 'labels' : 'refs'}`,
              { 'lingtai.index': index },
              () =>
                'close' in action
                  ? tell({ kind: 'closed' }).then(held)
                  : 'labels' in action
                    ? tell({ kind: 'labels', labels: action.labels }).then(held)
                    : sweepRefsHeld({ store, github, ticketId, andTheBranch: action.branch }),
              (ok) => !ok,
            ).then((ok) => all && ok),
          ),
        Promise.resolve(true),
      ),
    )
  }
}
