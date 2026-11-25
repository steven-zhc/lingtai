/**
 * `lingtai clean [<project>] [--yes]` (#1450): list the worktrees an attempt left
 * behind and the run logs no longer owed, and with `--yes` remove them.
 *
 * It runs beside a live daemon and takes no lock, so it never decides a claim is
 * dead (the rule `reconcile.ts` gives `doctor`) and every read that fails means
 * *keep*. It has its own classifier for that reason: `findOrphansEffect` reads a
 * failed ticket as backlog, which would make a live worktree an orphan.
 *
 * Every filesystem and git call goes through `CleanPort`, so the unit tests hand
 * in a fake and read back which removals were asked for.
 */
import { execFile as execFileCb } from 'node:child_process'
import { readdir, rm, stat, unlink } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'

import { reduceTicket, ticketReducer, type TicketLifecycle } from '@lingtai/domain'
import { type EventStore, eventStore, log as processLog, readThroughSnapshot } from '@lingtai/event-store'
import { taskStateOf } from '@lingtai/projector/task-view'
import { Effect } from 'effect'

import type { Outcome } from './project-pause.ts'

const execFile = promisify(execFileCb)

/** A worktree younger than this is never a candidate, whatever the log says. */
export const MIN_AGE_MS = 60 * 60 * 1000

/** A read that may have failed: a failure means keep, never remove. */
export type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false }

export type Verdict =
  | { readonly verdict: 'remove'; readonly reason: string }
  | { readonly verdict: 'keep'; readonly reason: string }
  | { readonly verdict: 'unchecked'; readonly reason: string }

/** What the run's stream and its ticket's fold say. */
export interface RunFacts {
  /** The ticket the run named; null when no stream names it. */
  readonly ticketId: string | null
  readonly lifecycle: TicketLifecycle | null
}

export interface WorktreeFacts {
  readonly pass: string
  /** Whether `git worktree list` on the mirror names the path. */
  readonly registered: Read<boolean>
  /** Milliseconds since the directory was modified. */
  readonly ageMs: Read<number>
  readonly run: Read<RunFacts>
  /** `git status --porcelain`; only asked of a registered worktree. */
  readonly status: Read<string>
}

/** The first guard that holds decides. */
export function classifyWorktree(f: WorktreeFacts): Verdict {
  if (!f.registered.ok) return { verdict: 'unchecked', reason: 'git worktree list failed' }
  if (!f.ageMs.ok) return { verdict: 'unchecked', reason: 'could not read the directory' }
  if (f.ageMs.value < MIN_AGE_MS) return { verdict: 'keep', reason: 'younger than an hour' }
  if (!f.run.ok) return { verdict: 'unchecked', reason: 'the log could not be read' }
  const { lifecycle } = f.run.value
  if (lifecycle !== null) {
    const state = taskStateOf(lifecycle)
    if ((state === 'running' || state === 'approved') && 'runId' in lifecycle && lifecycle.runId === f.pass) {
      return { verdict: 'keep', reason: 'running' }
    }
  }
  if (f.registered.value) {
    if (!f.status.ok) return { verdict: 'unchecked', reason: 'git status failed' }
    if (f.status.value.trim() !== '') return { verdict: 'keep', reason: 'uncommitted changes' }
  }
  const why = lifecycle === null ? 'no run in the log names it' : `its ticket is ${lifecycle.status}`
  return {
    verdict: 'remove',
    reason: f.registered.value ? `orphan worktree: ${why}` : `not a git worktree: ${why}`,
  }
}

export interface LogFacts {
  readonly run: Read<RunFacts>
}

export function classifyLog(f: LogFacts): Verdict {
  if (!f.run.ok) return { verdict: 'unchecked', reason: 'the log could not be read' }
  const { ticketId, lifecycle } = f.run.value
  if (ticketId === null || lifecycle === null) return { verdict: 'keep', reason: 'unknown: no ticket names this run' }
  const { status } = lifecycle
  if (status === 'landed' || status === 'closed' || status === 'satisfied') {
    return { verdict: 'remove', reason: `ticket ${ticketId} is ${status}` }
  }
  return { verdict: 'keep', reason: `still owed: ticket ${ticketId} is ${status}` }
}

/** Every filesystem and git call `clean` makes. */
export interface CleanPort {
  /** Names of the directories (`dirs`) or `.log` files (`logs`) directly under `path`. */
  list(path: string, kind: 'dirs' | 'logs'): Effect.Effect<readonly string[], unknown>
  ageMs(path: string, now: number): Effect.Effect<number, unknown>
  sizeKb(path: string): Effect.Effect<number, unknown>
  /** Paths `git worktree list --porcelain` names for the project's mirror. */
  registered(mirror: string): Effect.Effect<ReadonlySet<string>, unknown>
  status(path: string): Effect.Effect<string, unknown>
  removeWorktree(mirror: string, path: string): Effect.Effect<void, unknown>
  rmDir(path: string): Effect.Effect<void, unknown>
  prune(mirror: string): Effect.Effect<void, unknown>
  removeFile(path: string): Effect.Effect<void, unknown>
}

const attempt = <A>(f: () => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: () => f(), catch: (e) => e })

const isEnoent = (err: unknown): boolean => (err as { code?: unknown } | null)?.code === 'ENOENT'
const missingIsFine = <A>(e: Effect.Effect<A, unknown>, ok: A): Effect.Effect<A, unknown> =>
  e.pipe(Effect.catch((err) => (isEnoent(err) ? Effect.succeed(ok) : Effect.fail(err))))

export const realPort: CleanPort = {
  list: (path, kind) =>
    attempt(() => readdir(path, { withFileTypes: true })).pipe(
      Effect.map((entries) =>
        entries
          .filter((e) => (kind === 'dirs' ? e.isDirectory() : e.isFile() && e.name.endsWith('.log')))
          .map((e) => e.name),
      ),
    ),
  ageMs: (path, now) => attempt(() => stat(path)).pipe(Effect.map((s) => now - s.mtimeMs)),
  sizeKb: (path) =>
    attempt(() => execFile('du', ['-sk', path])).pipe(Effect.map(({ stdout }) => Number.parseInt(stdout, 10))),
  registered: (mirror) =>
    attempt(() => execFile('git', ['-C', mirror, 'worktree', 'list', '--porcelain'])).pipe(
      Effect.map(
        ({ stdout }) =>
          new Set(
            stdout
              .split('\n')
              .filter((l) => l.startsWith('worktree '))
              .map((l) => l.slice('worktree '.length)),
          ),
      ),
    ),
  status: (path) =>
    attempt(() => execFile('git', ['-C', path, 'status', '--porcelain'])).pipe(Effect.map(({ stdout }) => stdout)),
  removeWorktree: (mirror, path) =>
    attempt(() => execFile('git', ['-C', mirror, 'worktree', 'remove', '--force', path])).pipe(
      Effect.asVoid,
      // Already gone is not an error.
      Effect.catch((err) => (/is not a working tree|No such file/i.test(String(err)) ? Effect.void : Effect.fail(err))),
    ),
  rmDir: (path) => attempt(() => rm(path, { recursive: true, force: true })),
  prune: (mirror) => attempt(() => execFile('git', ['-C', mirror, 'worktree', 'prune'])).pipe(Effect.asVoid),
  removeFile: (path) => missingIsFine(attempt(() => unlink(path)).pipe(Effect.asVoid), undefined),
}

export interface CleanOptions {
  readonly home: string
  readonly project?: string | undefined
  readonly yes: boolean
  readonly now?: number
  readonly store?: EventStore
  readonly port?: CleanPort
  readonly log?: (line: string) => void
}

interface Item {
  readonly kind: 'worktree' | 'log'
  readonly project: string
  readonly name: string
  readonly path: string
  verdict: Verdict
  sizeKb: number | null
}

const passOf = (name: string): string => name.split(':')[0] ?? name

const mirrorOf = (home: string, project: string): string => join(home, 'repos', `${project}.git`)

const readRun = (store: EventStore, own: boolean, id: string): Effect.Effect<Read<RunFacts>> =>
  Effect.gen(function* () {
    const events = yield* attempt(() => store.read(id))
    const ticketId =
      events
        .map((e) => (e.data as { ticketId?: string } | undefined)?.ticketId)
        .find((t): t is string => typeof t === 'string') ?? null
    if (ticketId === null) return { ok: true, value: { ticketId: null, lifecycle: null } } as const
    const state = yield* readThroughSnapshot(store, ticketReducer, ticketId, 'all', {
      snapshots: own ? processLog.snapshots : undefined,
      writer: undefined,
    })
    return { ok: true, value: { ticketId, lifecycle: (state ?? reduceTicket([])).lifecycle } } as const
  }).pipe(Effect.catch(() => Effect.succeed({ ok: false } as Read<RunFacts>)))

const readOf = <A>(e: Effect.Effect<A, unknown>): Effect.Effect<Read<A>> =>
  e.pipe(
    Effect.map((value) => ({ ok: true, value }) as Read<A>),
    Effect.catch(() => Effect.succeed({ ok: false } as Read<A>)),
  )

/** Gather the facts for one worktree and classify it. */
const judgeWorktree = (
  o: { home: string; now: number; port: CleanPort; store: EventStore; own: boolean },
  project: string,
  name: string,
  registeredSet: Read<ReadonlySet<string>>,
) =>
  Effect.gen(function* () {
    const path = join(o.home, 'worktrees', project, name)
    const registered: Read<boolean> = registeredSet.ok
      ? { ok: true, value: registeredSet.value.has(path) }
      : { ok: false }
    const ageMs = yield* readOf(o.port.ageMs(path, o.now))
    const run = yield* readRun(o.store, o.own, passOf(name))
    const status =
      registered.ok && registered.value ? yield* readOf(o.port.status(path)) : ({ ok: true, value: '' } as Read<string>)
    return classifyWorktree({ pass: passOf(name), registered, ageMs, run, status })
  })

const judgeLog = (o: { store: EventStore; own: boolean }, name: string) =>
  readRun(o.store, o.own, name.slice(0, -'.log'.length)).pipe(Effect.map((run) => classifyLog({ run })))

/** Run the command; the exit code is 1 when anything could not be checked or removed. */
export const cleanEffect = (options: CleanOptions) =>
  Effect.gen(function* () {
    const log = options.log ?? console.log
    const port = options.port ?? realPort
    const now = options.now ?? Date.now()
    const own = options.store === undefined
    const store = options.store ?? eventStore
    const { home } = options
    const ctx = { home, now, port, store, own }

    const projectNames = (kind: 'worktrees' | 'runs') =>
      port.list(join(home, kind), 'dirs').pipe(Effect.catch(() => Effect.succeed([] as readonly string[])))
    const projects =
      options.project !== undefined
        ? [options.project]
        : [...new Set([...(yield* projectNames('worktrees')), ...(yield* projectNames('runs'))])].sort()

    const items: Item[] = []
    const registeredBy = new Map<string, Read<ReadonlySet<string>>>()
    let failed = false

    for (const project of projects) {
      const registeredSet = yield* readOf(port.registered(mirrorOf(home, project)))
      registeredBy.set(project, registeredSet)
      const dirs = yield* port
        .list(join(home, 'worktrees', project), 'dirs')
        .pipe(Effect.catch(() => Effect.succeed([] as readonly string[])))
      for (const name of [...dirs].sort()) {
        const verdict = yield* judgeWorktree(ctx, project, name, registeredSet)
        items.push({
          kind: 'worktree',
          project,
          name,
          path: join(home, 'worktrees', project, name),
          verdict,
          sizeKb: null,
        })
      }
      const logs = yield* port
        .list(join(home, 'runs', project), 'logs')
        .pipe(Effect.catch(() => Effect.succeed([] as readonly string[])))
      for (const name of [...logs].sort()) {
        const verdict = yield* judgeLog(ctx, name)
        items.push({ kind: 'log', project, name, path: join(home, 'runs', project, name), verdict, sizeKb: null })
      }
    }

    for (const item of items) {
      if (item.verdict.verdict === 'keep' && !LISTED_KEEPS.has(item.verdict.reason)) continue
      item.sizeKb = yield* port.sizeKb(item.path).pipe(Effect.catch(() => Effect.succeed(null)))
    }

    const sizeWord = (kb: number | null): string =>
      kb === null ? '?' : kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`
    const line = (tag: string, item: Item, reason: string) =>
      log(`${tag.padEnd(9)} ${relative(home, item.path)}  ${sizeWord(item.sizeKb)}  ${reason}`)

    // Re-judged immediately before each removal: the verdict may have moved.
    const removed: Item[] = []
    const pruneProjects = new Set<string>()
    for (const item of items) {
      const v = item.verdict
      if (v.verdict === 'unchecked') {
        failed = true
        line('unchecked', item, `could not be checked: ${v.reason}`)
      } else if (v.verdict === 'keep') {
        if (LISTED_KEEPS.has(v.reason)) line('keep', item, v.reason)
      } else if (!options.yes) {
        line('remove', item, v.reason)
        removed.push(item)
      } else {
        const again =
          item.kind === 'worktree'
            ? yield* judgeWorktree(ctx, item.project, item.name, registeredBy.get(item.project)!)
            : yield* judgeLog(ctx, item.name)
        if (again.verdict !== 'remove') {
          line(again.verdict === 'unchecked' ? 'unchecked' : 'keep', item, `${again.reason} (changed since listed)`)
          if (again.verdict === 'unchecked') failed = true
          continue
        }
        const done = yield* removeItem(port, home, item, registeredBy.get(item.project)!).pipe(
          Effect.map(() => ({ ok: true }) as const),
          Effect.catch((err) => Effect.succeed({ ok: false, err: String(err) } as const)),
        )
        if (done.ok) {
          line('removed', item, v.reason)
          removed.push(item)
          if (item.kind === 'worktree') pruneProjects.add(item.project)
        } else if (/locked/i.test(done.err)) {
          line('keep', item, 'locked')
        } else {
          failed = true
          line('failed', item, done.err.split('\n')[0] ?? 'removal failed')
        }
      }
    }
    for (const project of pruneProjects) {
      yield* port.prune(mirrorOf(home, project)).pipe(Effect.ignore)
    }

    const total = removed.reduce((n, i) => n + (i.sizeKb ?? 0), 0)
    log(
      `${options.yes ? 'removed' : 'removable'}: ${removed.length} item${removed.length === 1 ? '' : 's'}, ${sizeWord(total)}`,
    )
    if (!options.yes && removed.length > 0) log('run `lingtai clean --yes` to remove them')
    return (failed ? 1 : 0) as Outcome
  })

/** The reasons worth a line even though they are kept: what a person may want to act on. */
const LISTED_KEEPS: ReadonlySet<string> = new Set(['uncommitted changes'])

const removeItem = (port: CleanPort, home: string, item: Item, registeredSet: Read<ReadonlySet<string>>) =>
  Effect.gen(function* () {
    if (item.kind === 'log') return yield* port.removeFile(item.path)
    const isRegistered = registeredSet.ok && registeredSet.value.has(item.path)
    if (isRegistered) yield* port.removeWorktree(mirrorOf(home, item.project), item.path)
    yield* port.rmDir(item.path)
  })
