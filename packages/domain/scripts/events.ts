/**
 * Writes `doc/events.json`: each event, where it is defined, and where it is
 * appended, as permalinks at the commit the file was generated from (#629).
 *
 * **The finder is deliberately incomplete.** An append site is exactly one
 * shape: an object literal whose `type:` is a string literal naming an event,
 * passed as an argument — or as an element of an array argument — to a call
 * whose callee name is in `APPEND_CALLEES`. Variables, spreads, helpers that
 * return events and computed `type`s are not followed, and widening the finder
 * to follow them is not the remedy for an event it misses: that event goes in
 * `ELSEWHERE`, by hand, with the line that appends it.
 *
 * `pnpm events:generate` runs this and formats the result.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

import { EVENT_AT, EVENTS, RETIRED, SCHEMA_VER, type EventType } from '../src/index.ts'

export const REPOSITORY = 'https://github.com/steven-zhc/lingtai'

/** The only callee names whose arguments are searched for an append site. */
export const APPEND_CALLEES: ReadonlySet<string> = new Set([
  'append',
  'appendNow',
  'appendAt',
  'appendTo',
  'appendFrom',
])

export type StreamPrefix = 'ticket-' | 'pass-' | 'int-' | 'prj-' | 'ctl-' | 'chat-' | 'ext-' | 'bkl-'

/**
 * Appends the finder cannot see, one row per site; `site` is `path.ts:line` and
 * that line must hold the event's name as a quoted string
 * (`packages/domain/unit/events-json.test.ts` checks it). A row whose event the
 * finder now finds fails the test, so this table cannot go stale in that
 * direction.
 */
export const ELSEWHERE: readonly { event: EventType; why: string; site: string }[] = [
  {
    event: 'ConductorResumed',
    why: "type is the call's first argument, a string",
    site: 'packages/daemon/src/control.ts:163',
  },
  {
    event: 'ConductorShutdownRequested',
    why: "type is the call's first argument, a string",
    site: 'packages/daemon/src/control.ts:183',
  },
  {
    event: 'ConductorShutdownRequested',
    why: "type is the call's first argument, a string",
    site: 'packages/daemon/src/control.ts:219',
  },
  {
    event: 'ConductorShutdownWithdrawn',
    why: "type is the call's first argument, a string",
    site: 'packages/daemon/src/control.ts:349',
  },
  {
    event: 'ConductorStarted',
    why: "type is the call's first argument, a string",
    site: 'packages/daemon/src/control.ts:258',
  },
  {
    event: 'RunRequested',
    why: "type is the call's first argument, a string",
    site: 'packages/daemon/src/control.ts:401',
  },
  {
    event: 'DiscussionAsked',
    why: "type is a string argument of the module's own `append`",
    site: 'packages/conductor/src/discuss.ts:503',
  },
  {
    event: 'DiscussionAnswered',
    why: "type is a string argument of the module's own `append`",
    site: 'packages/conductor/src/discuss.ts:533',
  },
  {
    event: 'EndActionsResolved',
    why: 'the event is built, then handed on',
    site: 'packages/conductor/src/end-step.ts:147',
  },
  {
    event: 'IntegrationAttempted',
    why: "type is a string argument of the module's own `append`",
    site: 'packages/repo/src/integrate.ts:655',
  },
  {
    event: 'IntegrationRefused',
    why: "type is a string argument of the module's own `append`",
    site: 'packages/repo/src/integrate.ts:272',
  },
  {
    event: 'IntegrationSucceeded',
    why: "type is a string argument of the module's own `append`",
    site: 'packages/repo/src/integrate.ts:290',
  },
  {
    event: 'IssueUpdated',
    why: 'type is a string argument of `record`',
    site: 'packages/conductor/src/edit-body.ts:114',
  },
  {
    event: 'IssueUpdateFailed',
    why: 'type is a string argument of `record`',
    site: 'packages/conductor/src/tell.ts:202',
  },
  { event: 'PassRouted', why: 'the event is built, then handed on', site: 'packages/conductor/src/conduct.ts:4048' },
  {
    event: 'ProjectRecovered',
    why: 'returned from a function; the caller appends it',
    site: 'packages/domain/src/project.ts:185',
  },
  {
    event: 'ProjectRefused',
    why: 'returned from a function; the caller appends it',
    site: 'packages/domain/src/project.ts:197',
  },
  {
    event: 'RunAwaitingInput',
    why: 'type is a string argument of the hook socket’s `append`',
    site: 'packages/agent/src/hook-socket.ts:249',
  },
  {
    event: 'RunContextExhausted',
    why: 'type is a string argument of the hook socket’s `append`',
    site: 'packages/agent/src/hook-socket.ts:241',
  },
  {
    event: 'RunPrompted',
    why: 'type is a string argument of the hook socket’s `append`',
    site: 'packages/agent/src/hook-socket.ts:230',
  },
  {
    event: 'RunTouchedFile',
    why: 'type is a string argument of the hook socket’s `append`',
    site: 'packages/agent/src/hook-socket.ts:326',
  },
  {
    event: 'RunProducedDiff',
    why: 'the array is built before it is appended',
    site: 'packages/conductor/src/conduct.ts:1790',
  },
  {
    event: 'SplitStarted',
    why: 'type is a string argument of `note`',
    site: 'packages/conductor/src/split-ticket.ts:183',
  },
  {
    event: 'SplitFailed',
    why: 'type is a string argument of `note`',
    site: 'packages/conductor/src/split-ticket.ts:189',
  },
  {
    event: 'SplitFailed',
    why: 'type is a string argument of `note`',
    site: 'packages/conductor/src/split-ticket.ts:447',
  },
  {
    event: 'SplitChildWritten',
    why: 'type is a string argument of `note`',
    site: 'packages/conductor/src/split-ticket.ts:332',
  },
  {
    event: 'SplitLinkWritten',
    why: 'type is a string argument of `note`',
    site: 'packages/conductor/src/split-ticket.ts:350',
  },
  { event: 'StepStarted', why: 'handed to `options.emit`, which appends', site: 'packages/conductor/src/pass.ts:1396' },
  { event: 'TicketClosed', why: 'the event is built, then handed on', site: 'packages/conductor/src/close.ts:191' },
  {
    event: 'TicketSplit',
    why: 'the array is chosen by a conditional first',
    site: 'packages/conductor/src/resolve-wait.ts:313',
  },
]

/**
 * Events that are not `RETIRED` and that no source file appends today. Neither
 * the finder nor `ELSEWHERE` can name a site for them, and inventing one would
 * be a false permalink, so the absence is stated here. A row whose event gains a
 * site fails the test.
 */
export const NOT_APPENDED: readonly { event: EventType; why: string }[] = [
  { event: 'TicketDiscovered', why: 'the queue left the log (0012); only the projector and the board read it' },
  { event: 'TicketLinked', why: 'nothing in `src/` writes it; only the projector and the board read it' },
]

/**
 * The stream prefixes each event is appended to, **filled in by hand** from the
 * append sites. Nothing in the code declares it, and only the log
 * (`events.stream_id` grouped by `type`) could say whether it is true; the
 * `satisfies` makes `tsc` refuse an event with no entry, which is all it checks.
 */
export const STREAMS = {
  TicketDiscovered: ['ticket-'],
  TicketClaimed: ['ticket-'],
  TicketReleased: ['ticket-'],
  WaitStarted: ['ticket-'],
  WaitResolved: ['ticket-'],
  TicketSplit: ['ticket-'],
  SplitStarted: ['ticket-'],
  SplitChildWritten: ['ticket-'],
  SplitLinkWritten: ['ticket-'],
  SplitFailed: ['ticket-'],
  TicketLinked: ['ticket-'],
  TicketLanded: ['ticket-'],
  TicketClosed: ['ticket-'],
  DispatchRefused: ['ticket-'],
  RunStarted: ['pass-'],
  RunPrompted: ['pass-'],
  RunTouchedFile: ['pass-'],
  RunContextExhausted: ['pass-'],
  RunAwaitingInput: ['pass-'],
  RunProducedDiff: ['pass-'],
  RunRefsPublished: ['pass-'],
  RunKeptUncommitted: ['pass-'],
  RunProposedCompletion: ['pass-'],
  RunFinished: ['pass-'],
  RunFailed: ['pass-'],
  RunSpent: ['pass-', 'chat-', 'ticket-'],
  StepsResolved: ['pass-'],
  EndActionsResolved: ['pass-'],
  StepStarted: ['pass-'],
  StepEnded: ['pass-'],
  FindingAccepted: ['bkl-'],
  FindingProposed: ['bkl-'],
  FindingDeclined: ['bkl-'],
  MergeLaneWaited: ['pass-'],
  IntegrationAttempted: ['int-'],
  IntegrationRefused: ['int-'],
  IntegrationSucceeded: ['int-'],
  PassRouted: ['pass-'],
  ConductorPaused: ['ctl-'],
  ConductorResumed: ['ctl-'],
  ConductorShutdownRequested: ['ctl-'],
  ConductorStarted: ['ctl-'],
  ConductorShutdownWithdrawn: ['ctl-'],
  OutboxDelivered: [],
  OutboxFailed: [],
  IssueUpdated: ['ticket-'],
  IssueUpdateFailed: ['ticket-'],
  QueueChanged: ['ctl-'],
  RunRequested: ['ctl-'],
  ContinueRequested: ['ctl-'],
  DiscussionRequested: ['ctl-'],
  DiscussionAsked: ['chat-'],
  DiscussionAnswered: ['chat-'],
  DiscussionHeld: ['ticket-'],
  PromptEdited: ['ticket-'],
  ProjectOnboardingStarted: ['prj-'],
  ProjectConfigured: ['prj-'],
  ProjectRefused: ['prj-'],
  ProjectRecovered: ['prj-'],
  Reconciled: ['ctl-'],
  GitHubAppCreated: ['ctl-'],
  TriageStarted: ['ticket-'],
  WaitTriaged: ['ticket-'],
  PluginFailed: ['ext-'],
} as const satisfies { readonly [T in EventType]: readonly StreamPrefix[] }

export type EventsDoc = {
  sha: string
  events: {
    name: string
    group: string
    stream: readonly StreamPrefix[]
    schemaVersion: number
    retired: boolean
    at: readonly string[]
    summary: string | null
    definition: string
    sites: string[]
    subscribers: string
  }[]
}

export type Site = { event: EventType; file: string; line: number }

const EVENTS_FILE = 'packages/domain/src/events.ts'

function isEventType(s: string): s is EventType {
  return Object.hasOwn(EVENTS, s)
}

function sourceFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules') continue
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(path)
    }
  }
  for (const top of ['apps', 'packages']) {
    for (const pkg of readdirSync(join(root, top))) {
      try {
        walk(join(root, top, pkg, 'src'))
      } catch {
        // a workspace with no `src/`
      }
    }
  }
  return out.sort()
}

/** Every append site of the one shape described at the top of this file. */
export function findAppendSites(root: string): Site[] {
  const sites: Site[] = []
  for (const path of sourceFiles(root)) {
    const sf = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    const file = relative(root, path)
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : null
        if (name !== null && APPEND_CALLEES.has(name)) {
          for (const arg of node.arguments) {
            const literals = ts.isObjectLiteralExpression(arg)
              ? [arg]
              : ts.isArrayLiteralExpression(arg)
                ? arg.elements.filter(ts.isObjectLiteralExpression)
                : []
            for (const literal of literals) {
              for (const prop of literal.properties) {
                if (
                  ts.isPropertyAssignment(prop) &&
                  ts.isIdentifier(prop.name) &&
                  prop.name.text === 'type' &&
                  ts.isStringLiteral(prop.initializer) &&
                  isEventType(prop.initializer.text)
                ) {
                  const line = sf.getLineAndCharacterOfPosition(prop.getStart(sf)).line + 1
                  sites.push({ event: prop.initializer.text, file, line })
                }
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return sites
}

type Definition = { line: number; group: string; summary: string | null }

/** Where each `export const Name =` is, under which banner, and its doc comment's first line. */
function definitions(root: string): Map<string, Definition> {
  const text = readFileSync(join(root, EVENTS_FILE), 'utf8')
  const sf = ts.createSourceFile(EVENTS_FILE, text, ts.ScriptTarget.Latest, true)
  const banners = [...text.matchAll(/^\/\/ -+ (.+?) -+$/gm)].map((m) => ({
    line: sf.getLineAndCharacterOfPosition(m.index).line + 1,
    name: m[1]!,
  }))
  const out = new Map<string, Definition>()
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !isEventType(decl.name.text)) continue
      const line = sf.getLineAndCharacterOfPosition(decl.name.getStart(sf)).line + 1
      const group = banners.filter((b) => b.line < line).at(-1)?.name ?? ''
      const doc = (ts.getLeadingCommentRanges(text, stmt.getFullStart()) ?? [])
        .map((r) => text.slice(r.pos, r.end))
        .filter((c) => c.startsWith('/**'))
        .at(-1)
      const first =
        doc
          ?.split('\n')
          .map((l) =>
            l
              .replace(/^\s*\/?\*+\/?/, '')
              .replace(/\*\/\s*$/, '')
              .trim(),
          )
          .find((l) => l !== '') ?? null
      out.set(decl.name.text, { line, group, summary: first })
    }
  }
  return out
}

export function permalink(sha: string, file: string, line: number): string {
  return `${REPOSITORY}/blob/${sha}/${file}#L${line}`
}

export function generate({ root, sha }: { root: string; sha: string }): EventsDoc {
  const defs = definitions(root)
  const found = findAppendSites(root)
  const elsewhere = ELSEWHERE.map((row) => {
    const at = row.site.lastIndexOf(':')
    return { event: row.event, file: row.site.slice(0, at), line: Number(row.site.slice(at + 1)) }
  })
  const sites = [...found, ...elsewhere]
  const events = (Object.keys(EVENTS) as EventType[]).map((name) => {
    const def = defs.get(name)
    if (def === undefined) throw new Error(`${name} is in EVENTS but has no \`export const ${name}\` in ${EVENTS_FILE}`)
    return {
      name,
      group: def.group,
      stream: STREAMS[name],
      schemaVersion: SCHEMA_VER[name],
      retired: RETIRED.has(name),
      at: EVENT_AT[name],
      summary: def.summary,
      definition: permalink(sha, EVENTS_FILE, def.line),
      sites: sites
        .filter((s) => s.event === name)
        .sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
        .map((s) => permalink(sha, s.file, s.line)),
      subscribers: `on: [${name}]`,
    }
  })
  return { sha, events }
}

if (import.meta.main) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  writeFileSync(join(root, 'doc', 'events.json'), JSON.stringify(generate({ root, sha }), null, 2) + '\n')
}
