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
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
 * Appends the finder cannot see, one row per site. A row finds its line by
 * `anchor`, a piece of one line of `file` that occurs exactly once in it, and
 * that line must hold the event's name as a quoted string — never by a line
 * number, which every unrelated edit above it would move (#651). If the line
 * names the event only as part of something not unique, put a trailing comment
 * on it and anchor on that. `packages/domain/unit/events-json.test.ts` checks
 * both, and `generate` refuses an anchor that does not occur exactly once. A
 * row whose event the finder now finds fails the test, so this table cannot go
 * stale in that direction.
 */
export const ELSEWHERE: readonly { event: EventType; why: string; file: string; anchor: string }[] = [
  {
    event: 'ConductorShutdownRequested',
    why: "type is the call's first argument, a string",
    file: 'packages/daemon/src/control.ts',
    anchor: "return append('ConductorShutdownRequested', { by, reason, timeoutMs, force }, store)",
  },
  {
    event: 'ConductorShutdownRequested',
    why: "type is the call's first argument, a string",
    file: 'packages/daemon/src/control.ts',
    anchor:
      "const version = await append('ConductorShutdownRequested', { by, reason, timeoutMs, force }, store, events.length)",
  },
  {
    event: 'ConductorShutdownWithdrawn',
    why: "type is the call's first argument, a string",
    file: 'packages/daemon/src/control.ts',
    anchor: "'ConductorShutdownWithdrawn',",
  },
  {
    event: 'ConductorStarted',
    why: "type is the call's first argument, a string",
    file: 'packages/daemon/src/control.ts',
    anchor: "'ConductorStarted',",
  },
  {
    event: 'RunRequested',
    why: "type is the call's first argument, a string",
    file: 'packages/daemon/src/control.ts',
    anchor: "await append('RunRequested', { project, issue, by }, store)",
  },
  {
    event: 'DiscussionAsked',
    why: "type is a string argument of the module's own `append`",
    file: 'packages/conductor/src/discuss.ts',
    anchor: "await append(ports.store, stream, before.length, options.by, 'DiscussionAsked', {",
  },
  {
    event: 'DiscussionAnswered',
    why: "type is a string argument of the module's own `append`",
    file: 'packages/conductor/src/discuss.ts',
    anchor: "append(ports.store, stream, -1, `agent:${options.chatId}`, 'DiscussionAnswered', {",
  },
  {
    event: 'EndActionsResolved',
    why: 'the event is built, then handed on',
    file: 'packages/conductor/src/end-step.ts',
    anchor: "type: 'EndActionsResolved',",
  },
  {
    event: 'IntegrationAttempted',
    why: "type is a string argument of the module's own `append`",
    file: 'packages/repo/src/integrate.ts',
    anchor: "append('IntegrationAttempted', {",
  },
  {
    event: 'IntegrationRefused',
    why: "type is a string argument of the module's own `append`",
    file: 'packages/repo/src/integrate.ts',
    anchor: "await append('IntegrationRefused', {",
  },
  {
    event: 'IntegrationSucceeded',
    why: "type is a string argument of the module's own `append`",
    file: 'packages/repo/src/integrate.ts',
    anchor: "await append('IntegrationSucceeded', {",
  },
  {
    event: 'IssueUpdated',
    why: 'type is a string argument of `record`',
    file: 'packages/conductor/src/edit-body.ts',
    anchor: "await record(store, ticketId, 'IssueUpdated', {",
  },
  {
    event: 'IssueUpdateFailed',
    why: 'type is a string argument of `record`',
    file: 'packages/conductor/src/tell.ts',
    anchor: "'IssueUpdateFailed', // the update threw",
  },
  {
    event: 'PassRouted',
    why: 'the event is built, then handed on',
    file: 'packages/conductor/src/conduct.ts',
    anchor: "type: 'PassRouted' as const,",
  },
  {
    event: 'ProjectRecovered',
    why: 'returned from a function; the caller appends it',
    file: 'packages/domain/src/project.ts',
    anchor:
      "return { type: 'ProjectRecovered', actor: 'conductor', data: { project, ref: seen.ref, codeSha: seen.codeSha } }",
  },
  {
    event: 'ProjectRefused',
    why: 'returned from a function; the caller appends it',
    file: 'packages/domain/src/project.ts',
    anchor: "type: 'ProjectRefused',",
  },
  {
    event: 'RunAwaitingInput',
    why: 'type is a string argument of the hook socket’s `append`',
    file: 'packages/agent/src/hook-socket.ts',
    anchor: "await append(run, 'RunAwaitingInput', { prompt: prompt.slice(0, 2_000) }).catch(() => {})",
  },
  {
    event: 'RunContextExhausted',
    why: 'type is a string argument of the hook socket’s `append`',
    file: 'packages/agent/src/hook-socket.ts',
    anchor: "await append(run, 'RunContextExhausted', { turn: run.calls }).catch(() => {})",
  },
  {
    event: 'RunPrompted',
    why: 'type is a string argument of the hook socket’s `append`',
    file: 'packages/agent/src/hook-socket.ts',
    anchor: "await append(run, 'RunPrompted', { promptVersion: run.promptVersion, bytes, prompt }).catch(() => {",
  },
  {
    event: 'RunTouchedFile',
    why: 'type is a string argument of the hook socket’s `append`',
    file: 'packages/agent/src/hook-socket.ts',
    anchor: "await append(run, 'RunTouchedFile', t)",
  },
  {
    event: 'RunProducedDiff',
    why: 'the array is built before it is appended',
    file: 'packages/conductor/src/conduct.ts',
    anchor: "type: 'RunProducedDiff',",
  },
  {
    event: 'SplitStarted',
    why: 'type is a string argument of `note`',
    file: 'packages/conductor/src/split-ticket.ts',
    anchor: "await note('SplitStarted', {",
  },
  {
    event: 'SplitFailed',
    why: 'type is a string argument of `note`',
    file: 'packages/conductor/src/split-ticket.ts',
    anchor: "await note('SplitFailed', { waitId, step, detail })",
  },
  {
    event: 'SplitChildWritten',
    why: 'type is a string argument of `note`',
    file: 'packages/conductor/src/split-ticket.ts',
    anchor: "await note('SplitChildWritten', { waitId, key: child.key, number: sub.number, id: sub.id })",
  },
  {
    event: 'SplitLinkWritten',
    why: 'type is a string argument of `note`',
    file: 'packages/conductor/src/split-ticket.ts',
    anchor: "await note('SplitLinkWritten', { waitId, ticket: d.ticket, blockedBy: d.blockedBy })",
  },
  {
    event: 'StepStarted',
    why: 'handed to `options.emit`, which appends',
    file: 'packages/conductor/src/pass.ts',
    anchor: "type: 'StepStarted',",
  },
  {
    event: 'TicketClosed',
    why: 'the event is built, then handed on',
    file: 'packages/conductor/src/close.ts',
    anchor: "type: 'TicketClosed',",
  },
  {
    event: 'TicketSplit',
    why: 'the array is chosen by a conditional first',
    file: 'packages/conductor/src/resolve-wait.ts',
    anchor: "? [{ type: 'TicketSplit', actor: options.by, data: parsePayload('TicketSplit', options.split) }]",
  },
  {
    event: 'TicketDiscovered',
    why: 'the only append left is the probe event the bootstrap script writes (0012 took the queue off the log)',
    file: 'packages/event-store/scripts/bootstrap.mjs',
    anchor:
      'const ev = (v) => [`ticket-probe-1`, v, "TicketDiscovered", JSON.stringify({ probe: true }), "conductor"];',
  },
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
  TicketContinued: ['ticket-'],
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
  BaseChecked: ['int-'],
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
      // Only a comment touching the statement is its doc: one with a blank line
      // between is the file's own prose (the note above `TicketDiscovered`).
      const doc = (ts.getLeadingCommentRanges(text, stmt.getFullStart()) ?? [])
        .filter((r) => text.startsWith('/**', r.pos) && !/\n\s*\n/.test(text.slice(r.end, stmt.getStart(sf))))
        .map((r) => text.slice(r.pos, r.end))
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

/** The 1-based line of every occurrence of `anchor` in `text`; an anchor is part of one line. */
export function anchorLines(text: string, anchor: string): number[] {
  return text.split('\n').flatMap((line, i) => {
    const hits: number[] = []
    for (let at = line.indexOf(anchor); at !== -1; at = line.indexOf(anchor, at + 1)) hits.push(i + 1)
    return hits
  })
}

export function permalink(sha: string, file: string, line: number): string {
  return `${REPOSITORY}/blob/${sha}/${file}#L${line}`
}

/**
 * `ref` is the name the links carry (a release tag); `sha` stays the commit the
 * lines were read at. The caller guarantees `ref` resolves to `sha`.
 */
export function generate({ root, sha, ref }: { root: string; sha: string; ref?: string }): EventsDoc {
  const named = ref ?? sha
  const defs = definitions(root)
  const found = findAppendSites(root)
  const elsewhere = ELSEWHERE.map((row) => {
    const lines = anchorLines(readFileSync(join(root, row.file), 'utf8'), row.anchor)
    if (lines.length !== 1) {
      throw new Error(
        `${row.event} in ${row.file}: anchor ${JSON.stringify(row.anchor)} occurs ${lines.length} times, not once`,
      )
    }
    return { event: row.event, file: row.file, line: lines[0]! }
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
      definition: permalink(named, EVENTS_FILE, def.line),
      sites: sites
        .filter((s) => s.event === name)
        .sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
        .map((s) => permalink(named, s.file, s.line)),
      subscribers: `on: [${name}]`,
    }
  })
  return { sha, events }
}

if (import.meta.main) {
  const here = dirname(fileURLToPath(import.meta.url))
  const root = join(here, '..', '..', '..')
  if (process.argv[2] === '--emit') {
    // The child: this file is the snapshot's own copy, so `ELSEWHERE`, `STREAMS`
    // and everything imported from `src/` are the ones at the commit.
    const [, , , sha, out, ref] = process.argv
    writeFileSync(out!, JSON.stringify(generate({ root, sha: sha!, ref: ref || undefined }), null, 2) + '\n')
  } else {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
    const sha = git('rev-parse', 'HEAD')
    const at = process.argv.indexOf('--ref')
    const ref = at === -1 ? undefined : process.argv[at + 1]
    if (at !== -1 && !ref) {
      console.error('--ref needs a value')
      process.exit(1)
    }
    // The links would name `ref` while the lines are read from HEAD: refuse a
    // ref that is not HEAD rather than publish links to the wrong lines.
    if (ref !== undefined && git('rev-parse', `${ref}^{commit}`) !== sha) {
      console.error(`refusing to generate: ${ref} is not HEAD (${sha}), so its links would point at the wrong lines`)
      process.exit(1)
    }
    // A permalink's line numbers must be the lines of the commit it names, so
    // everything is read from that commit's own objects, and the generator that
    // reads them is that commit's copy of this file, run as a child: an edit
    // saved, undone or redone while this runs cannot reach the output through
    // the sources or through this module's tables.
    const dirty = git('status', '--porcelain', '--', 'apps', 'packages')
    if (dirty !== '') {
      console.error(
        `refusing to generate: uncommitted changes would make the links point at the wrong lines of ${sha}\n${dirty}\ncommit them first, then run pnpm events:generate`,
      )
      process.exit(1)
    }
    const snapshot = mkdtempSync(join(tmpdir(), 'events-json-'))
    try {
      const tar = execFileSync('git', ['archive', '--format=tar', sha, 'apps', 'packages'], {
        cwd: root,
        maxBuffer: 1 << 30,
      })
      execFileSync('tar', ['-x', '-C', snapshot], { input: tar })
      symlinkSync(
        join(root, 'packages', 'domain', 'node_modules'),
        join(snapshot, 'packages', 'domain', 'node_modules'),
      )
      const out = join(snapshot, 'events.json')
      execFileSync(
        process.execPath,
        [join(snapshot, 'packages', 'domain', 'scripts', 'events.ts'), '--emit', sha, out, ref ?? ''],
        { cwd: snapshot, stdio: 'inherit' },
      )
      writeFileSync(join(root, 'doc', 'events.json'), readFileSync(out))
    } finally {
      rmSync(snapshot, { recursive: true, force: true })
    }
  }
}
