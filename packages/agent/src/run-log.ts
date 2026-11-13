/**
 * A run's log file: what the agent is doing, while it is doing it.
 *
 * [0034](../../../doc/decisions-archive/0034-the-run-log.md). Before this the only
 * observable of a running agent was `ps` — `#105` ran for four minutes and the
 * whole of what could be known about it was a pid and a truncated command line.
 * The live picture already existed: the hook socket sees every tool call and
 * every lifecycle hook as it happens and calls `onDecision` / `onLifecycle`
 * with it, and nothing consumed either. This is where it goes.
 *
 * **It is a trace, not a record** (0034 §8). Decisions live on the event log
 * and only there; this file explains and never settles. The distinction has a
 * test: if some behaviour would change depending on this file's contents, the
 * design is wrong. So `reconcile` looks at whether one exists, never at what is
 * in it, and `followRunLogStream` below — the reading half, `#110` — takes exactly one
 * thing from the contents and it is not about the run: `RUN_LOG_END` says the
 * writer has let go, so a tail may stop waiting. Everything else it does is
 * hand a line to a person unread.
 *
 * **The path is chosen by the conductor and handed here** (0034 §1). This
 * module knows how to write a log; it does not know where `~/.lingtai` is, and
 * a runtime adapter that learned the home layout would have crossed the seam
 * 0022 drew.
 *
 * **Writing never gates a tool call.** `note` returns immediately and the write
 * happens on a queue behind it, which is the same rule `hook-socket.ts` states
 * for persistence: the verdict is synchronous, everything else is not. A slow
 * or full disk must not stall an agent, and a log that cannot be written must
 * not be able to fail a run — every failure in here is swallowed on purpose.
 */
import type { FileHandle } from 'node:fs/promises'
import { mkdir, open, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { Data, Effect, Option, Stream } from 'effect'

import { AgentHostFailed } from './hook-config.ts'
import {
  LABEL_AT,
  LABEL_WIDTH,
  RUN_LOG_END,
  runLogEnd,
  runLogEnded,
  runLogLine,
  type RunLogEnding,
} from './run-log-format.ts'

// The format lives in `run-log-format.ts`, which imports nothing, so a board client
// component can read it. Re-exported so no call site changes.
export { LABEL_AT, LABEL_WIDTH, RUN_LOG_END, runLogEnd, runLogEnded, runLogLine, type RunLogEnding }

/**
 * The mode the file is created with, and then asserted.
 *
 * It holds **whatever the agent printed** — values it read from its filtered
 * environment, contents of files it opened, the commands it ran. That output
 * was parsed and discarded until `#109`, so persisting it is a *new* exposure
 * and not a wider view of one that already existed. `agent-env`'s
 * `ENV_FILE_MODE` set
 * the standard for a file of Lingtai's that holds somebody's secrets, and this
 * is the same instinct applied to the same class of content.
 *
 * Unlike `ENV_FILE_MODE` this *is* enforced on an existing file, because there
 * is no case where the file is the operator's: it is named for a run id, it is
 * written by one process, and it is deleted when that run lands.
 */
export const RUN_LOG_MODE = 0o600

/** `~/.lingtai/runs/<project>/`, created with the same instinct as the files in it. */
export const RUN_LOG_DIR_MODE = 0o700

/**
 * Where one run's log stops.
 *
 * A trace line is about sixty bytes, so eight megabytes is something like
 * 130,000 tool calls — far past any run that has ever happened. The cap is not
 * for the trace: `#109` put the agent's own stream in the same file, and a
 * single run can produce tens of megabytes of that. What the number has to
 * protect is the disk and the person: this is a file somebody opens to find out
 * why a run failed, and past this it stops being one.
 *
 * The file says where it truncated, in itself, so a short answer read out of a
 * capped log cannot be mistaken for the whole of one. Written down in
 * `doc/reference.md`'s policy section, which is what `#96` exists to make
 * unskippable.
 */
export const RUN_LOG_MAX_BYTES = 8_000_000

/**
 * The half of a run log a *writer* gets: a line, and no say in when it ends.
 *
 * `RunRequest.log` is this rather than `RunLog` because the two halves belong to
 * different people. The adapter has the agent's stream and nothing else; the
 * keep-or-delete is the conductor's, taken where the worktree is removed and
 * only knowable there (0034 §4). Handing over the narrower type is what makes
 * that structural rather than a rule somebody remembers.
 *
 * **One writer, not two.** 0034 §1 says the conductor names the file and the
 * adapter is handed it, and `#108` landed that as a path. `#109` hands the
 * writer instead, for two reasons the path could not give: §7's cap is then one
 * number about one file rather than one per open handle — and the agent's
 * stream is what makes the file large, so a second handle would have doubled
 * exactly the thing the cap is for — and a multi-megabyte line and a trace line
 * arriving from two descriptors can interleave *within* a line, which is the
 * one thing `runLogLine` exists to prevent. The seam 0022 drew is unmoved and
 * is drawn tighter: the adapter now does not learn the path either.
 */
export type RunTrace = Pick<RunLog, 'note'>

/**
 * What a run's log is, to the conductor holding one.
 *
 * `close` takes the decision rather than making it: **landed → delete, did not
 * land → keep** (0034 §4) is the caller's to know, and the caller is the scoped
 * release in `conduct.ts` that already runs on every outcome. What survives is
 * then exactly the investigable set, with no timer, no sweeper and no retention
 * period.
 */
export interface RunLog {
  /** Empty for `NO_RUN_LOG`, so a caller can tell there is nothing to hand on. */
  readonly path: string
  /** One timestamped line. Returns immediately; the write is behind it. */
  note(label: string, detail?: string): void
  close(fate: 'keep' | 'delete'): Effect.Effect<void>
}

/**
 * A log that is not there.
 *
 * Handed back when the file could not be opened, so the run continues and the
 * call sites stay free of `?.`. A run without its log is worse observed and is
 * not worse off — the events are unaffected, and that is the half that settles
 * anything.
 */
export const NO_RUN_LOG: RunLog = {
  path: '',
  note: () => {},
  close: () => Effect.void,
}

/**
 * The same log, with every line it is handed filed under one tag.
 *
 * **For an agent that is not the implementer** (#153). The reviewer at a gate and
 * the agent a refusal bought run inside the pass, cost the pass, and are read by
 * the person following the pass — so they write to the pass's one file rather
 * than a second one, and the tag is what tells their lines apart from the
 * implementer's: `proposed:review  Read  src/x.ts`, not `Read  src/x.ts`.
 *
 * The adapter's own label moves into the detail, so nothing it writes can land
 * in the label column — and `RUN_LOG_END`, the one label a reader acts on, can
 * therefore never be written by an agent's trace, whatever the adapter labels.
 */
export function taggedTrace(log: RunTrace, tag: string): RunTrace {
  return {
    note: (label, detail = '') => log.note(tag, detail === '' ? label : `${label.padEnd(6)}  ${detail}`),
  }
}

export interface OpenRunLogOptions {
  /** Absolute, and chosen by the conductor. See the module header. */
  path: string
  /** Overridable so a test can fix the header. */
  started?: Date
}

export const openRunLogEffect = Effect.fn('agent.runLog')(function* (options: OpenRunLogOptions) {
  const path = options.path
  const started = options.started ?? new Date()

  const fail = (err: unknown) => new AgentHostFailed({ operation: 'runLog', detail: (err as Error).message })
  yield* Effect.tryPromise({
    try: () => mkdir(dirname(path), { recursive: true, mode: RUN_LOG_DIR_MODE }),
    catch: fail,
  })
  // Append, because a second attempt at the same run id is a thing that should
  // add to the story rather than erase it. The mode argument only applies at
  // creation and umask can only narrow it further, so the `chmod` below is what
  // actually makes 0600 a claim rather than a hope.
  const handle: FileHandle = yield* Effect.tryPromise({ try: () => open(path, 'a', RUN_LOG_MODE), catch: fail })
  yield* Effect.promise(() => handle.chmod(RUN_LOG_MODE).catch(() => {}))

  let bytes = 0
  let truncated = false
  /** Writes in order, one at a time, with nobody waiting for them. */
  let tail: Promise<unknown> = Promise.resolve()

  // The `catch` is what keeps the queue alive: a line that could not be written
  // must not take every line after it with it.
  const push = (text: string) => {
    tail = tail.then(() => handle.write(text)).catch(() => {})
  }

  const header =
    `lingtai run log · started ${started.toISOString()} · times below are local, HH:MM:SS · ` +
    `capped at ${RUN_LOG_MAX_BYTES} bytes\n`
  bytes += Buffer.byteLength(header)
  push(header)

  const log: RunLog = {
    path,

    note(label, detail = '') {
      // The line that says the file is over is written past the cap, exactly
      // as the notice that says where the cap was is. A follower has nothing
      // else that tells *the writer has finished* from *the writer is thinking*
      // (`#110`), so leaving it out would hang a reader for ever on precisely
      // the runs that produced the most to read.
      if (label === RUN_LOG_END) {
        push(runLogLine(new Date(), label, detail))
        return
      }
      if (truncated) return
      const line = runLogLine(new Date(), label, detail)
      const size = Buffer.byteLength(line)
      if (bytes + size > RUN_LOG_MAX_BYTES) {
        truncated = true
        // Deliberately written past the cap. A file that stopped silently at a
        // round number is a file whose last line is a lie by omission, and the
        // whole reason for a cap that is written down is that somebody reading
        // a short log should be able to tell which kind of short it is.
        push(
          runLogLine(
            new Date(),
            '——',
            `truncated: this log reached RUN_LOG_MAX_BYTES (${RUN_LOG_MAX_BYTES} bytes) and stops here`,
          ),
        )
        return
      }
      bytes += size
      push(line)
    },

    // `tail` is read when the Effect runs, never when `close` is called.
    close: (fate) => Effect.suspend(() => closeRunLogEffect(handle, tail, path, fate)),
  }
  return log
})

/**
 * Closing a log: wait for the write queue, close the handle, and remove the
 * file on `delete`. Every step swallows its error — a run log is a trace and
 * never a record (0034) — so it cannot fail.
 */
export const closeRunLogEffect = (
  handle: FileHandle,
  tail: Promise<unknown>,
  path: string,
  fate: 'keep' | 'delete',
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Effect.promise(() => tail.catch(() => {}))
    yield* Effect.promise(() => handle.close().catch(() => {}))
    if (fate === 'delete') yield* Effect.promise(() => rm(path, { force: true }).catch(() => {}))
  })

/**
 * How often a follower looks for more.
 *
 * There is no notification to wait on: the writer is a queue behind a file
 * handle in another process, and 0034 chose a file over a socket precisely so
 * that reading one needs nothing from the process that wrote it. `tail -f`
 * polls for the same reason. A quarter of a second is under the threshold at
 * which a person reading a scrolling log perceives a delay, and costs one
 * `read` returning zero bytes when nothing happened.
 *
 * In `doc/reference.md`'s policy section, which 0034 §7 makes unskippable.
 */
export const RUN_LOG_POLL_MS = 250

/**
 * How often a writer that is still there says so, by touching the file.
 *
 * **A trace that nobody writes opens exactly like one somebody does** (#132).
 * A daemon killed mid-answer leaves its file, and a follower reads it from byte
 * zero and then waits — and an agent thinking for a minute writes nothing
 * either. The file's *contents* may not say which (0034 §8), so its mtime does:
 * the writer that is holding it bumps it on this beat whether or not it has a
 * line to write, and a follower asks how old it is (`runLogQuiet`).
 *
 * Not the daemon's beacon, on purpose. A beacon beating says a process is up,
 * not that it is writing *this* file — a `--no-conduct` daemon beats and answers
 * nothing — and a page reads the beacon once per render, so a daemon that dies
 * under an open page is still up on it.
 */
export const RUN_LOG_BEAT_MS = 5_000

/** Quiet past this, the writer has let go without saying so. Three missed beats. */
export const RUN_LOG_QUIET_MS = RUN_LOG_BEAT_MS * 3

/** Whether a file last touched at `mtimeMs` has a writer holding it. See `RUN_LOG_BEAT_MS`. */
export function runLogQuiet(mtimeMs: number, now: number = Date.now()): boolean {
  return now - mtimeMs > RUN_LOG_QUIET_MS
}

/** A line of the file, or the writer letting go of it. */
export type RunLogFollowed = { readonly line: string } | { readonly ended: RunLogEnding }

export interface FollowRunLogOptions {
  /** Absolute. The caller resolved a run id to it; this module knows no layout. */
  path: string
  /** Overridable so a test does not wait a quarter of a second per line. */
  pollMs?: number
  /** The reader went away. Ends the follow without an ending, which is the truth. */
  signal?: AbortSignal
}

/** A read on a file that opened failed. Not `removed`: that claims the run landed. */
export class RunLogFollowFailed extends Data.TaggedError('RunLogFollowFailed')<{
  readonly path: string
  readonly cause: unknown
}> {}

/**
 * Whole lines out of what has been read so far, up to and including the first
 * that ends the log. Pure, so the split-line and split-character claims can be
 * held without a file. `pending` is what is left: an unfinished line.
 */
export function wholeLines(pending: string): {
  readonly items: ReadonlyArray<RunLogFollowed>
  readonly pending: string
  readonly ended: boolean
} {
  const items: RunLogFollowed[] = []
  let rest = pending
  for (let nl = rest.indexOf('\n'); nl >= 0; nl = rest.indexOf('\n')) {
    const line = rest.slice(0, nl)
    rest = rest.slice(nl + 1)
    items.push({ line })
    const ended = runLogEnded(line)
    if (ended) {
      items.push({ ended })
      return { items, pending: rest, ended: true }
    }
  }
  return { items, pending: rest, ended: false }
}

/**
 * The file, from the beginning, and then as it grows.
 *
 * **From byte zero, always** — that is the whole of why 0034 chose a file over
 * a socket. Somebody who attaches four minutes into a run wants the four
 * minutes, and a stream that started when they did would have thrown away the
 * part that explains the part they can see.
 *
 * It reads a file and nothing else, so it works while the daemon is down and on
 * a run that ended weeks ago. The writer is not consulted, does not know it is
 * being read, and cannot be blocked by a reader.
 *
 * **Whole lines only.** A `read` lands wherever the disk left it, so both a
 * partial line and a partial UTF-8 character are ordinary, and half a line
 * emitted as a line is a fragment of a fact read as the whole one —
 * `lineReader` in `claude-code.ts` states the same rule for the same reason.
 *
 * The handle lives as long as the stream: it is closed on an ending, on
 * interruption and when a consumer stops early. A signal that aborts ends the
 * stream with no ending element. A failed open is an ending (`removed`); a
 * failed read is a `RunLogFollowFailed`.
 */
export const followRunLogStream = (options: FollowRunLogOptions): Stream.Stream<RunLogFollowed, RunLogFollowFailed> => {
  const pollMs = options.pollMs ?? RUN_LOG_POLL_MS
  const path = options.path
  const failed = (cause: unknown) => new RunLogFollowFailed({ path, cause })

  const followHandle = (handle: FileHandle): Stream.Stream<RunLogFollowed, RunLogFollowFailed> => {
    const decoder = new StringDecoder('utf8')
    const buffer = Buffer.alloc(64 * 1024)
    return Stream.unwrap(
      Effect.gen(function* () {
        // Which file this handle is, so a *new* file at the same path is seen as
        // this one ending. `answerDiscussion` removes a dead daemon's leftover and
        // opens its own a few milliseconds later, well inside one poll: `stat` on
        // the path then succeeds, and a follower that asked only whether the path
        // exists tails the unlinked leftover for the whole of the new answer (#132).
        // The inode cannot be reused while this handle holds it open.
        const own = yield* Effect.tryPromise({ try: () => handle.stat(), catch: failed })

        // The wait belongs before a read, not after one: a pass that found lines
        // hands them on at once and sleeps on the next pull.
        const step = ([pending, first]: readonly [string, boolean]) =>
          Effect.gen(function* () {
            if (!first) yield* Effect.sleep(pollMs)
            // Everything since the last pass. `position: null` advances the handle's
            // own cursor, which is what makes this a tail and not a re-read.
            let text = pending
            for (;;) {
              const { bytesRead } = yield* Effect.tryPromise({
                try: () => handle.read(buffer, 0, buffer.length, null),
                catch: failed,
              })
              if (bytesRead === 0) break
              text += decoder.write(buffer.subarray(0, bytesRead))
            }
            const split = wholeLines(text)
            if (split.ended) return [split.items, Option.none<readonly [string, boolean]>()] as const

            // Read first, then ask. A run that landed writes its last line and then
            // deletes the file, and in that order the last line is never lost — the
            // handle above outlives the unlink, so the drain just above has already
            // taken everything the writer wrote.
            // Gone, or a different file where it was — both are this one ending.
            const now = yield* Effect.promise(() => stat(path).catch(() => null))
            if (now === null || now.ino !== own.ino || now.dev !== own.dev) {
              return [
                [...split.items, { ended: 'removed' } as const],
                Option.none<readonly [string, boolean]>(),
              ] as const
            }
            return [split.items, Option.some([split.pending, false] as const)] as const
          })
        return Stream.paginate(['', true] as const, step)
      }),
    )
  }

  const followed = Stream.unwrap(
    Effect.tryPromise({ try: () => open(path, 'r'), catch: failed }).pipe(
      // Not there to begin with. `findRunLog` is how a caller tells this apart
      // from a run id nobody has heard of; here it is simply an ending.
      Effect.map((handle): Stream.Stream<RunLogFollowed, RunLogFollowFailed> => {
        return Stream.unwrap(
          Effect.acquireRelease(Effect.succeed(handle), (h) => Effect.promise(() => h.close().catch(() => {}))).pipe(
            Effect.map(followHandle),
          ),
        )
      }),
      Effect.catch(() => Effect.succeed(Stream.make<RunLogFollowed[]>({ ended: 'removed' }))),
    ),
  )

  const signal = options.signal
  if (!signal) return followed
  // The reader went away: ends the follow with no ending, and a sleep in
  // progress is cut short with it.
  return followed.pipe(
    Stream.interruptWhen(
      Effect.callback<void>((resume) => {
        if (signal.aborted) return resume(Effect.void)
        const onAbort = () => resume(Effect.void)
        signal.addEventListener('abort', onAbort, { once: true })
        return Effect.sync(() => signal.removeEventListener('abort', onAbort))
      }),
    ),
  )
}
