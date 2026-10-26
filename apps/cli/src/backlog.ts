import { userInfo } from 'node:os'

/**
 * `lingtai backlog` — the minor findings passing gates raised, and the two
 * decisions a person makes about each (`#137`,
 * [0038](../../../doc/decisions-archive/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md)
 * §5).
 *
 * The board has the same page. This exists because **#129** and **#130** are
 * one complaint — a decision that can only be made in a browser is half a
 * decision — and both doors call the same `acceptFinding` and `declineFinding`.
 *
 * **One key per command.** There is no `accept --all`, and no filter that
 * accepts what it matches: a batch accept that means *all of them* is the rule
 * 0038 refused to write, typed at a terminal instead.
 */
import { acceptFinding, declineFinding, githubTicketStore, loadProject } from '@lingtai/conductor'
import { projectClient } from '@lingtai/conductor/filter'
import { hasGitHubApp } from '@lingtai/env'
import {
  type BacklogEntry,
  backlogProjection,
  createProjectionRunner,
  readBacklog,
  readTasks,
} from '@lingtai/projector'
import { kindsOf } from '@lingtai/recipe/settings'

import { section } from './output.ts'
import { withProjector } from './projector.ts'

const USAGE = `lingtai backlog [project] [--all]
lingtai backlog accept <project> <key> --kind <kind> [--unheld]
lingtai backlog accept <project> <key>     open the issue of one already accepted
lingtai backlog decline <project> <key> --reason <why>`

/** The hold an accepted ticket carries unless the person says otherwise. */
const HOLD = 'agent:hold'

/**
 * Flags whose value is prose. `--reason style only` is one reason, not a reason
 * and a stray word — which would otherwise be refused as a list of keys.
 */
const PROSE = new Set(['reason'])

/** Exported for the test. */
export function split(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (!a.startsWith('--')) {
      positional.push(a)
      continue
    }
    if (PROSE.has(a.slice(2))) {
      const words: string[] = []
      while (i + 1 < args.length && !args[i + 1]!.startsWith('--')) words.push(args[++i]!)
      flags[a.slice(2)] = words.join(' ')
      continue
    }
    const next = args[i + 1]
    if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = ''
    else {
      flags[a.slice(2)] = next
      i++
    }
  }
  return { positional, flags }
}

function oneLine(text: string, n = 120): string {
  const said = text.replace(/\s+/g, ' ').trim()
  return said.length > n ? `${said.slice(0, n - 1)}…` : said
}

/**
 * One entry, as a listing shows it. Exported for the test.
 *
 * `title` is what the board calls the ticket this finding was raised against.
 * The backlog does not hold it — a `FindingRaised` names the issue by number —
 * so it is passed in from `task_view`, and `null` when no card answers for it.
 * A bare `#49` in a listing is a lookup and not a fact (#258), so without a
 * title the line says what the number *is* instead of standing it on its own.
 */
export function describeEntry(e: BacklogEntry, title: string | null = null): string[] {
  const where = e.line === null ? e.file : `${e.file}:${e.line}`
  const ticket = title === null ? `raised while working #${e.issue}` : `#${e.issue} ${oneLine(title, 60)}`
  const lines = [
    `${e.key}  ${ticket}  ${e.step}:${e.action}  ${where}`,
    `    ${oneLine(e.claim)}`,
    `    fails when: ${oneLine(e.failureScenario)}`,
    `    from ${e.runId} at seq ${e.raisedSeq}`,
  ]
  if (e.status === 'accepted' && e.proposedRef === null) {
    lines.push(
      `    accepted as ${e.kind} by ${e.decidedBy}, and no issue is recorded yet — ` +
        `lingtai backlog accept ${e.project} ${e.key} opens it, or finds the one already opened`,
    )
  }
  if (e.status === 'accepted' && e.proposedRef !== null) {
    lines.push(`    accepted by ${e.decidedBy} → ${e.proposedUrl ?? e.proposedRef}`)
  }
  if (e.status === 'declined') lines.push(`    declined by ${e.decidedBy}: ${oneLine(e.reason ?? '')}`)
  return lines
}

export interface BacklogListOptions {
  project?: string | undefined
  all?: boolean
}

/** One entry with the title of the ticket it names, which the backlog itself does not hold. */
export interface ListedEntry {
  entry: BacklogEntry
  title: string | null
}

export interface BacklogListing {
  project: string | null
  all: boolean
  entries: ListedEntry[]
  /** Present only when the catch-up threw: the listing may be older than the log. */
  behind?: string
}

/** Reads the listing; the rendering and the document below are pure over it. */
export async function readBacklogListing(options: BacklogListOptions = {}): Promise<BacklogListing> {
  const { project } = options
  const all = options.all === true
  let behind: string | undefined
  // Folded to the head before it is read, so the listing is current whether or
  // not a daemon is running. Reading and not appending, so there is nothing to
  // follow afterwards.
  const runner = createProjectionRunner({ projection: backlogProjection })
  try {
    await runner.start()
  } catch (err) {
    behind = (err as Error).message
  } finally {
    await runner.close().catch(() => {})
  }

  // An accepted entry whose issue is not recorded is listed with the open ones:
  // something is still owed on it.
  const entries = (await readBacklog({ project })).filter(
    (e) => all || e.status === 'open' || (e.status === 'accepted' && e.proposedRef === null),
  )
  const base = { project: project ?? null, all, ...(behind === undefined ? {} : { behind }) }
  if (entries.length === 0) return { ...base, entries: [] }

  // The one column the backlog does not hold: what each ticket it names is
  // called. Over the whole history rather than the board's retention window,
  // because a finding outlives the run that raised it; and caught rather than
  // thrown, because a listing without titles is still a listing.
  const titles = new Map(
    (await readTasks({ retentionDays: 36_500, ...(project === undefined ? {} : { project }) }).catch(() => [])).map(
      (t) => [`${t.project}#${t.issue}`, t.title] as const,
    ),
  )
  return {
    ...base,
    entries: entries.map((entry) => ({ entry, title: titles.get(`${entry.project}#${entry.issue}`) ?? null })),
  }
}

/** One section per project, `describeEntry`'s lines inside it. */
export function renderBacklog(listing: BacklogListing): string[] {
  const lines: string[] = []
  // A fact the old listing opened with; it stays a line of its own, ahead of the sections.
  if (listing.behind !== undefined) lines.push(`the backlog could not catch up, and may be behind: ${listing.behind}`)
  if (listing.entries.length === 0) {
    lines.push(listing.all ? 'the backlog is empty' : 'nothing open in the backlog')
    return lines
  }
  const byProject = new Map<string, ListedEntry[]>()
  for (const l of listing.entries) byProject.set(l.entry.project, [...(byProject.get(l.entry.project) ?? []), l])
  let first = true
  for (const [project, listed] of byProject) {
    if (!first) lines.push('')
    first = false
    lines.push(
      section(
        project,
        listed.flatMap((l) => describeEntry(l.entry, l.title)),
      ),
    )
  }
  if (!listing.all) lines.push('', 'next: lingtai backlog accept <project> <key> --kind <kind>')
  return lines
}

/** The `--json` body. `behind` is there only when the catch-up threw, never `null`. */
export function backlogJson(listing: BacklogListing): Record<string, unknown> {
  return {
    project: listing.project,
    all: listing.all,
    entries: listing.entries.map(({ entry, title }) => ({
      ...entry,
      raisedAt: entry.raisedAt.toISOString(),
      decidedAt: entry.decidedAt === null ? null : entry.decidedAt.toISOString(),
      title,
    })),
    ...(listing.behind === undefined ? {} : { behind: listing.behind }),
  }
}

async function list(project: string | undefined, all: boolean, log: (line: string) => void): Promise<number> {
  for (const line of renderBacklog(await readBacklogListing({ project, all }))) log(line)
  return 0
}

export interface BacklogDecision {
  verb: 'accept' | 'decline'
  project: string
  key: string
  /** Positionals after the key: any at all is refused, one key at a time. */
  extra?: readonly string[]
  kind?: string | undefined
  unheld?: boolean
  reason?: string | undefined
}

/** `accept` and `decline`, once they have been parsed — by `split` here or by `@effect/cli` in `cli.ts`. */
export async function decideFinding(decision: BacklogDecision, log = console.log): Promise<number> {
  const { verb, project, key } = decision
  if ((decision.extra ?? []).length > 0) {
    log('one key at a time — a backlog entry is decided by a person reading it, not by a list')
    return 2
  }
  const by = `human:${userInfo().username}`

  if (verb === 'decline') {
    const reason = decision.reason ?? ''
    if (!reason.trim()) {
      log('lingtai backlog decline needs --reason <why> — a decline nobody can explain gets asked again')
      return 2
    }
    return withProjector(log, async () => {
      const r = await declineFinding({ project, key, by, reason })
      log(r.detail)
      return r.ok ? 0 : 1
    })
  }

  // No --kind is refused by `acceptFinding` when the entry is open, and not
  // needed when it is already accepted: the log says what the issue carries.
  const kind = decision.kind
  if (!hasGitHubApp()) {
    log(
      'no GitHub App configured — write github: in ~/.lingtai/config.yml (the /setup/github-app page on the board writes it), see doc/decisions/0114-a-github-app-not-a-token.md',
    )
    return 1
  }
  const state = await loadProject(project)
  if (!state?.owner) {
    log(`no project named "${project}" — run lingtai add <owner>/<repo> first`)
    return 1
  }
  // The recipe on the base branch decides which kinds the queue sees, so it
  // is read here rather than trusted from the flag. `client` carries a `db`
  // project's own ticket verbs (`projectClient`, #383), so `githubTicketStore`
  // writes the finding wherever this project's tickets actually live.
  const { client, resolved } = await projectClient(state)
  return withProjector(log, async () => {
    const r = await acceptFinding({
      project,
      key,
      by,
      kind,
      kinds: kindsOf(resolved.recipe),
      labels: decision.unheld ? [] : [HOLD],
      tickets: githubTicketStore(client),
    })
    log(r.detail)
    return r.ok ? 0 : 1
  })
}

export const BACKLOG_USAGE = USAGE

export async function backlogCommand(args: string[], log = console.log): Promise<number> {
  const [sub, ...rest] = args

  if (sub === 'accept' || sub === 'decline') {
    const { positional, flags } = split(rest)
    const [project, key, ...extra] = positional
    if (!project || !key) {
      log(USAGE)
      return 2
    }
    return decideFinding(
      { verb: sub, project, key, extra, kind: flags['kind'], unheld: 'unheld' in flags, reason: flags['reason'] },
      log,
    )
  }

  if (sub === 'help' || sub === '--help') {
    log(USAGE)
    return 0
  }

  const { positional, flags } = split(sub === undefined ? [] : [sub, ...rest])
  if (positional.length > 1) {
    log(USAGE)
    return 2
  }
  return list(positional[0], 'all' in flags, log)
}
