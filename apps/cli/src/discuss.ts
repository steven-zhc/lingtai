/**
 * The world a discussion happens in, assembled for the daemon to hold.
 *
 * The same split `conduct.ts` makes, and for the same reason: `@lingtai/daemon`
 * hosts a loop and knows nothing about GitHub clients, runtimes or mirrors, and
 * giving it those dependencies would make it the thing it is supposed to be
 * hosting. What `@lingtai/conductor/discuss` decides is what the assistant is
 * asked and what it may read; what this decides is where the answers come from.
 *
 * ## The containment, and what it rests on
 *
 * The assistant has no worktree, no hook and no gates
 * ([0033](../../../doc/decisions-archive/0033-the-third-kind-of-agent.md) §1), so it
 * must have no tools either. Three things stand behind that, and none of them
 * is a flag read off `--help`:
 *
 * 1. **The permission mode is `default`, not `bypassPermissions`.** Under `-p`
 *    there is nothing to grant a permission with — `claude-code.ts` records the
 *    measurement: every Write, Edit and most Bash calls come back as *"you
 *    haven't granted it yet"* and there is no prompt to answer. That behaviour
 *    is what makes a run agent useless and is exactly what contains a reader.
 * 2. **The settings file denies every tool**, and it lives outside anything the
 *    assistant can see, for the reason `hook-config.ts` puts the run's settings
 *    outside the worktree.
 * 3. **The working directory is an empty directory Lingtai owns**, holding
 *    nothing, in no repository. The code it reads is served to it from the bare
 *    mirror, where there is no working tree to run anything in.
 *
 * ## No spend limit
 *
 * 0033 §4: a run is unattended and needs a hard bound; a discussion is attended
 * and the person is the loop. What one `ask` call may spend — `turns` and
 * `wall`, reaching the binary as `--max-turns` and a wall clock (`#89`) — is
 * not that bound either: it is how long one round may hang before the person
 * is told it hung, which is a different question and has to be answerable or
 * the meter never updates. It is the recipe's `discuss.limits` now (`#243`),
 * not a constant here — see `@lingtai/recipe`'s `Discuss`.
 */
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  createRuntime,
  NO_RUN_LOG,
  openRunLogEffect,
  RUN_LOG_BEAT_MS,
  runtimeVersionOfEffect,
  type RunTrace,
  type Runtime,
} from '@lingtai/agent'
import { runnableEnv } from '@lingtai/agent-env'
import {
  FILE_BYTES,
  holdDiscussionEffect,
  LOG_LINES,
  readingFor,
  type DiscussionEvidence,
  type DiscussionPorts,
  type ReadableRef,
} from '@lingtai/conductor/discuss'
import { currentRecipe, loadProjectEffect } from '@lingtai/conductor/projects'
import { readProjectTicketEffect } from '@lingtai/conductor/read-ticket'
import { runLogPath } from '@lingtai/conductor/run-log'
import { DISCUSSION_EVENTS, readControlEffect } from '@lingtai/daemon'
import {
  chatStream,
  parseTicketStream,
  reduceChat,
  reduceAttempt,
  reduceTicket,
  triageFactsOf,
  type ChatState,
  type DiscussionRequest,
  type Envelope,
  type ProjectState,
} from '@lingtai/domain'
import { stateDir } from '@lingtai/env'
import { eventStore } from '@lingtai/event-store'
import { callFor, DISCUSS_DEFAULTS, type Discuss } from '@lingtai/recipe'
import { listAtEffect, readAtEffect, refShaEffect } from '@lingtai/repo'
import { Effect, Semaphore } from 'effect'

import { lift, recovering } from './exit.ts'

/**
 * Every tool, denied.
 *
 * A list of what is refused rather than an allowlist of what is permitted, and
 * that is the wrong way round on purpose *here*: the third layer is the empty
 * working directory, so a tool this list has fallen behind on has nothing to
 * act upon. Read is denied with the rest — the assistant does not read the
 * filesystem it is standing in, it names a path and Lingtai serves it from the
 * mirror.
 */
const DENIED = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Edit',
  'Write',
  'NotebookEdit',
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
]

/** Where a chat's settings and its empty working directory live. */
export function chatDir(chatId: string, home = stateDir()): string {
  return join(home, 'chats', chatId)
}

/**
 * An empty directory and a settings file that denies everything.
 *
 * Recreated per turn rather than reused, so a directory that somehow acquired
 * a file between two questions is not the directory the next turn runs in.
 *
 * Exported for `triage.ts` (`#428`), which contains a triage agent the same
 * way — no worktree, no tools — under its own id rather than a chat's.
 */
export const prepare = (
  chatId: string,
  home = stateDir(),
): Effect.Effect<{ cwd: string; settingsPath: string }, unknown> =>
  Effect.gen(function* () {
    const io = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: (e) => e })
    const cwd = chatDir(chatId, home)
    yield* io(() => rm(cwd, { recursive: true, force: true }))
    yield* io(() => mkdir(cwd, { recursive: true, mode: 0o700 }))
    const settingsPath = join(home, 'chats', `${chatId}.settings.json`)
    yield* io(() =>
      writeFile(
        settingsPath,
        `${JSON.stringify({ permissions: { defaultMode: 'default', deny: DENIED } }, null, 2)}\n`,
        { mode: 0o600 },
      ),
    )
    return { cwd, settingsPath }
  })

/**
 * One line per event, oldest first — the log as the assistant reads it.
 *
 * Terse on purpose: the whole payload of a 400-event history would be most of
 * the context and the assistant can ask for what it needs. What is never cut is
 * the *type* and the *actor*, because "what happened, in order, with who did
 * it" is the thing the log is for.
 */
export function logLines(events: readonly Envelope[], limit: number): string[] {
  const lines = events.map((e) => {
    const at = e.at.toISOString().slice(0, 19).replace('T', ' ')
    const body = JSON.stringify(e.data ?? {})
    return `${e.seq}  ${at}  ${e.streamId}  ${e.type}  ${e.actor}  ${
      body.length > 400 ? `${body.slice(0, 399)}…` : body
    }`
  })
  if (lines.length <= limit) return lines
  return [`[${lines.length - limit} earlier events elided]`, ...lines.slice(-limit)]
}

/**
 * The ticket the brief carries, or the reason it could not be read — a
 * sentence in the brief rather than an absence (#76). Read through the one
 * reader, so a `db` project's ticket comes from its table (#731).
 */
export const ticketEvidence = (
  state: ProjectState | null,
  project: string,
  issue: number,
  read: typeof readProjectTicketEffect = readProjectTicketEffect,
): Effect.Effect<{ ticket: DiscussionEvidence['ticket']; ticketProblem: string | null }> =>
  Effect.gen(function* () {
    if (state === null) return { ticket: null, ticketProblem: `${project} is not a registered project` }
    const answer = yield* read(state, issue)
    if (!answer.ok) return { ticket: null, ticketProblem: (answer.error as Error).message }
    const live = answer.ticket
    return { ticket: { ref: String(live.number), title: live.title, body: live.body }, ticketProblem: null }
  })

/**
 * Everything the assistant is given, gathered from the log, GitHub and the
 * mirror.
 *
 * GitHub is allowed to fail and its failure is a sentence in the brief rather
 * than an absence — the rule the detail page follows one level up (#76). The
 * mirror is allowed to be missing for the same reason: a project nothing has
 * cloned yet is a fact, and "no file can be read" is the honest brief for it.
 */
export const gatherEvidence = (request: DiscussionRequest): Effect.Effect<DiscussionEvidence, unknown> =>
  Effect.gen(function* () {
    const parsed = parseTicketStream(request.ticketId)
    const project = parsed?.project ?? ''
    const own = yield* lift(() => eventStore.read(request.ticketId))
    const item = reduceTicket(own)
    const triage = currentWaitTriage(own)

    const runIds = [...item.runs]
    const streams = yield* Effect.all(
      runIds.map((id) => lift(() => eventStore.read(id))),
      { concurrency: 'unbounded' },
    )

    // 1-based, in claim order — the same numbering the detail page shows, so a
    // question about "attempt 2" means the attempt the page called 2.
    const index = request.attempt === null ? -1 : request.attempt - 1
    // The commit an attempt produced, from that attempt's own stream.
    //
    // The log and not the branch ref, which is the whole of the second blind spot:
    // `worktree add -B` leaves `agent/<n>` pointing at the base after an attempt
    // that committed nothing, so the ref existing proves nothing about the attempt.
    // `RunProducedDiff` is the attempt saying it produced something.
    const head = index >= 0 ? reduceAttempt(streams[index] ?? []).headSha : null

    const state = yield* loadProjectEffect(project).pipe(recovering(() => Effect.succeed(null)))
    const base = state?.base ?? 'main'

    const { ticket, ticketProblem } = yield* ticketEvidence(state, project, Number(parsed?.issue))

    const baseSha = yield* refShaEffect({ project, ref: base })
    const refs: ReadableRef[] = []
    if (baseSha !== null) {
      const listed = yield* listAtEffect({ project, ref: base })
      refs.push({ ref: base, sha: baseSha, paths: listed.paths, truncated: listed.truncated })
    }
    if (head !== null && (yield* refShaEffect({ project, ref: head })) !== null) {
      const listed = yield* listAtEffect({ project, ref: head })
      refs.push({
        ref: `attempt-${request.attempt}`,
        sha: head,
        paths: listed.paths,
        truncated: listed.truncated,
      })
    }

    return {
      ticketId: request.ticketId,
      attempt: request.attempt,
      ticket,
      ticketProblem,
      triage,
      log: logLines([...own, ...streams.flat()].sort(bySeq), LOG_LINES),
      // The sentence about a branch that is not there, computed here and recorded
      // on `DiscussionAsked` — never left to the assistant to remember.
      reading: readingFor({ attempt: request.attempt, base, baseSha, head }),
      refs,
    }
  })

/** A completed, advised triage belongs in a brief only while its wait is current. */
export function currentWaitTriage(own: readonly Envelope[]): DiscussionEvidence['triage'] {
  const lifecycle = reduceTicket(own).lifecycle
  if (lifecycle.status !== 'blocked') return null
  const result = triageFactsOf(own, lifecycle.waitId).result
  return result?._tag === 'TriageAdvised' ? result : null
}

function bySeq(a: Envelope, b: Envelope): number {
  return a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0
}

/**
 * The `ask` port, closed over one turn's fixed pieces — the runtime, the
 * working directory, the settings and the trace — so what a round's `call`
 * becomes on `RunRequest` is checkable against a real `ask`, not only against
 * the schema that produced `call` (`#243`).
 *
 * `model` is spread in only when present: `RunRequest.model` is optional and
 * absent means the runtime's own default (0063 §2), which an explicit
 * `undefined` would not say the same way to every runtime adapter.
 */
export function discussionAsk(
  runtime: Runtime | (() => Runtime),
  fixed: { runId: (round: number) => Effect.Effect<string, unknown>; cwd: string; settingsPath: string; log: RunTrace },
): DiscussionPorts['ask'] {
  return (prompt, round, call) =>
    // Suspended, so a factory that throws is a defect inside the turn and not at the call site.
    Effect.suspend(() => {
      const selected = typeof runtime === 'function' ? runtime() : runtime
      return fixed.runId(round).pipe(
        Effect.flatMap((runId) =>
          selected.run({
            runId,
            cwd: fixed.cwd,
            prompt,
            ...(call.model === undefined ? {} : { model: call.model }),
            settingsPath: fixed.settingsPath,
            // Nothing but what the runtime needs to authenticate. No token, no
            // project values, no hook wiring — there is no hook.
            env: runnableEnv({}),
            limits: { turns: call.turns, wallMs: call.wallMs },
            // What the assistant says and thinks, as it says it. The adapter
            // writes its own stream here (`traceOf`), which is the whole of what
            // makes the box on the board move.
            log: fixed.log,
          }),
        ),
      )
    })
}

/**
 * The `version` port: the same runtime `discussionAsk` selects, asked in the
 * environment it runs with (#929). Resolved per call, like `ask`.
 */
export function discussionVersion(runtime: Runtime | (() => Runtime), cwd?: string): DiscussionPorts['version'] {
  // Suspended, so a factory that throws is a defect the caller records as null.
  return () =>
    Effect.suspend(() =>
      runtimeVersionOfEffect(typeof runtime === 'function' ? runtime() : runtime, runnableEnv({}), cwd),
    )
}

/**
 * Answer one question.
 *
 * Never throws: it is called from the daemon's subscription, and an exception
 * escaping there would stop the loop over a question somebody typed.
 */
export const answerDiscussion = (
  request: DiscussionRequest,
  log: (line: string) => void = () => {},
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const project = parseTicketStream(request.ticketId)?.project ?? ''
    const evidence = yield* gatherEvidence(request)
    const { cwd, settingsPath } = yield* prepare(request.chatId)
    /**
     * The recipe's own `discuss:`, **asked rather than assumed** (`#313`, `#243`).
     *
     * It was `runtime.agent` behind `createToollessRuntime`'s fallback — a field
     * that decides which runtime works a project's *tickets* and has nothing to
     * do with a discussion — so `#243` gives a discussion its own field instead.
     * `currentRecipe` is a file read and nothing else — its own docstring: *"No
     * request is made and nothing is read from the repository"* — so asking
     * costs one `readFile` on a path already loaded above.
     *
     * A project that is not registered, or whose recipe does not resolve, still
     * gets an answer — `DISCUSS_DEFAULTS` — because this function never throws:
     * it is called from the daemon's subscription, and an exception escaping
     * there would stop the loop over a question somebody typed.
     */
    const discuss: Discuss = yield* loadProjectEffect(project).pipe(
      Effect.flatMap((state) =>
        state === null
          ? Effect.succeed(DISCUSS_DEFAULTS)
          : lift(() => currentRecipe(state)).pipe(Effect.map((r) => r.recipe.discuss)),
      ),
      recovering(() => Effect.succeed(DISCUSS_DEFAULTS)),
    )
    /**
     * **Contained by construction, not by fallback** (`#243`).
     *
     * The three layers above are what a discussion has instead of a hook and the
     * steps a run passes, and the first two are a Claude Code settings file. So
     * `tools: "none"` is not a preference here, it is the containment: a runtime
     * that cannot be given it must not be handed this prompt. Construction
     * happens inside the async ask port so an unconfigured Codex route is
     * recorded as a failed answer instead of leaving this question outstanding.
     */
    const call = callFor(discuss)
    // Names to shas. The assistant reads `main` and `attempt-2`; the mirror is
    // asked for the commit, so what it was shown cannot drift under it mid-answer.
    const shas = new Map(evidence.refs.map((r) => [r.ref, r.sha]))

    /**
     * The conversation's trace, as it is produced.
     *
     * [0034](../../../doc/decisions-archive/0034-the-run-log.md) opens on *"the agent
     * produces nothing until it exits"*, and it solved that for runs and not for
     * discussions — so the box where **the person is the control loop** (0033 §4)
     * was the one place with no feedback in it, and an assistant thinking for
     * sixty seconds was indistinguishable from one that had died (#132). The
     * mechanism is 0034's, unchanged: one file, named by the conductor, followed
     * from byte zero by whoever is watching.
     *
     * **Named for the chat, and it is one turn long.** The name has to be the
     * chat's, because that is what makes the reaper right about the file: the id
     * is the chat's own stream, `DiscussionAsked` on it carries the work item, and
     * `findOrphanLogs` removes it when that item lands — the same rule and the
     * same code as a run's. But the *file* is one turn's, and the `finally` below
     * is why: what a follower asks for is the answer being produced right now, and
     * `followRunLogStream` reads from byte zero, so a file that outlived its turn would
     * show the second question the first question's trace and call it live.
     *
     * **Its ending is its deletion, and there is no `RUN_LOG_END`.** That line's
     * words are a run's — *the diff is on the branch* — and this is a
     * conversation. It does not need them: `holdDiscussion` appends
     * `DiscussionAnswered` on every path it has, including the crash and the
     * unreadable reply, so a turn that is over is a turn whose record has landed,
     * and 0034 §4's *landed → delete* is the whole of the rule. A follower sees
     * the file go and reports `removed`, which is an ending (`RunLogEnding`), so
     * the tail stops and the connection with it. What outlives a turn is exactly
     * the log of a daemon that died mid-answer — the one case still owed an
     * explanation, and the case §5's reaper is for. That residue is also the one
     * thing that could still be here when this opens, and `openRunLogEffect` appends on
     * purpose (a run's second attempt adds to the story rather than erasing it) —
     * so it goes first. This turn's trace is this turn's.
     */
    const path = runLogPath(stateDir(), project, request.chatId)
    yield* Effect.promise(() => rm(path, { force: true }).catch(() => {}))
    // Acquired uninterruptibly and released on every exit, so an interruption while the log is
    // opening cannot leave an open file the release never sees.
    const acquire = openRunLogEffect({ path }).pipe(
      Effect.catch(() => Effect.succeed(NO_RUN_LOG)),
      Effect.map((trace) => {
        // Still here, said on the file itself whether or not there is a line to write:
        // an agent thinking for a minute writes nothing, and neither does a daemon
        // that was killed. The board tells the two apart by this (`RUN_LOG_BEAT_MS`).
        const beat = setInterval(() => {
          const at = new Date()
          void utimes(path, at, at).catch(() => {})
        }, RUN_LOG_BEAT_MS)
        beat.unref?.()
        return { trace, beat }
      }),
    )

    yield* Effect.acquireUseRelease(
      acquire,
      ({ trace }) =>
        Effect.gen(function* () {
          /** Both places: the daemon's own output, and the file the board follows. */
          const say = (line: string) => {
            log(line)
            trace.note('chat', line)
          }
          say(`discussion ${request.chatId} on ${request.ticketId}: ${evidence.reading.join(' · ')}`)

          const held = yield* holdDiscussionEffect(
            {
              store: eventStore,
              log: say,
              serve: (ref, path) => {
                const sha = shas.get(ref)
                if (sha === undefined) return Effect.succeed(null)
                return readAtEffect({ project, ref: sha, path, limitBytes: FILE_BYTES })
              },
              ask: discussionAsk(() => createRuntime(discuss.agent, { tools: 'none' }), {
                // Its own id per round, so nothing resumes a session. `sessionIdFor`
                // is a function of the run id, and reusing one would make a second
                // question a continuation of the first one's transcript rather than a
                // fresh read of the brief this file just built.
                runId: (round) =>
                  lift(() => eventStore.read(chatStream(request.chatId))).pipe(
                    Effect.map((events) => `${request.chatId}:${events.length}:${round}`),
                  ),
                cwd,
                settingsPath,
                log: trace,
              }),
              version: discussionVersion(() => createRuntime(discuss.agent, { tools: 'none' }), cwd),
            },
            {
              chatId: request.chatId,
              evidence,
              question: request.question,
              by: request.by,
              call,
              runtime: discuss.agent,
              ...(discuss.prompt === undefined ? {} : { prompt: discuss.prompt }),
            },
          )

          say(
            `discussion ${request.chatId}: ${held.answered ? 'answered' : 'did not answer'}` +
              (held.costUsd === null ? '' : ` · $${held.costUsd.toFixed(2)}`),
          )
        }),
      // The turn is over, so the file is: see `trace` above. Its record is on the
      // chat's stream and this was only ever the trace beside it (0034 §8), and
      // leaving it would hand the *next* question this one's output as the answer
      // being written for it. On every exit, an interruption included.
      ({ trace, beat }) => Effect.sync(() => clearInterval(beat)).pipe(Effect.andThen(trace.close('delete'))),
    )
  }).pipe(
    // Said and never fatal; an interruption passes. The loop keeps going over a question somebody typed.
    recovering((err) => Effect.sync(() => log(`discussion ${request.chatId} failed: ${err.message}`))),
  )

/**
 * The oldest request not yet answered, or null when the chat has caught up.
 *
 * The nth request is outstanding exactly when fewer than n turns are answered.
 */
export function nextRequest(asks: readonly DiscussionRequest[], chat: ChatState): DiscussionRequest | null {
  return asks[chat.answered] ?? null
}

/**
 * Every question the log holds that nothing has answered, answered.
 *
 * Called at daemon startup, on a new request, and on a resume (#996): a turn
 * whose project is locked is not started and stays outstanding. Called at startup because a request made while the daemon was down is
 * waiting in the stream rather than lost — the property `pause` and `now`
 * already have and the reason control goes through the log at all (0013).
 *
 * Sequential, not parallel: three unanswered questions are three agents, and
 * starting them together is the one place this could surprise somebody with a
 * bill they did not watch accumulate.
 */
export interface AnswerPorts {
  log?: (line: string) => void
  /** Why a project may not start work, or null (#991's `locked`). Default: nothing is locked. */
  locked?: (project: string) => Effect.Effect<string | null>
  control?: typeof readControlEffect
  read?: (chatId: string) => Effect.Effect<readonly Envelope[], unknown>
  answer?: typeof answerDiscussion
}

export interface Outstanding {
  answered: number
  /** Chats with a turn held back by a lock; one per chat, not per turn. */
  heldBack: number
}

const readChat = (chatId: string) => lift(() => eventStore.read(chatStream(chatId)))
const notLocked = () => Effect.succeed(null)

export const answerOutstanding = (ports: AnswerPorts = {}): Effect.Effect<Outstanding, unknown> =>
  Effect.gen(function* () {
    const log = ports.log ?? (() => {})
    const locked = ports.locked ?? notLocked
    const answer = ports.answer ?? answerDiscussion
    const read = ports.read ?? readChat
    const control = yield* (ports.control ?? readControlEffect)()
    const byChat = new Map<string, DiscussionRequest[]>()
    for (const d of control.discussions) {
      byChat.set(d.chatId, [...(byChat.get(d.chatId) ?? []), d])
    }

    let answered = 0
    let heldBack = 0
    for (const [chatId, asks] of byChat) {
      // Until the chat has caught up, not once: two questions can land in one
      // burst, and answering only the first would leave the second waiting for
      // an event that has already been.
      for (;;) {
        const events = yield* read(chatId)
        // D14: requests are counted against answered *turns*, and an answer with
        // no open ask counts for nothing. Never "some turn has no answer": a
        // daemon that died between ask and answer leaves that turn unanswered for
        // ever, and the retry appends a second ask.
        const next = nextRequest(asks, reduceChat(events))
        if (next === null) break
        // A lock is asked per turn, before the agent starts (0126 §6). Held back
        // means nothing is appended: the request stays outstanding and a resume
        // brings it round again. `break`, never `continue` — nothing changes, so
        // the same request would come back as `next` for ever.
        const project = parseTicketStream(next.ticketId)?.project ?? ''
        if (project !== '') {
          const why = yield* locked(project).pipe(recovering((err) => Effect.succeed(err.message)))
          if (why !== null) {
            log(`discussion ${chatId} on ${next.ticketId}: not started — ${why}`)
            heldBack += 1
            break
          }
        }
        yield* answer(next, log).pipe(
          recovering((err) => Effect.sync(() => log(`discussion ${chatId} failed: ${err.message}`))),
        )
        // Progress is the chat's own count, not the answer returning: an answer that never
        // appended `DiscussionAnswered` leaves the same request next, and going round again
        // would buy the same agent again for ever. `break`, as a held-back turn does.
        const after = reduceChat(yield* read(chatId)).answered
        if (after <= reduceChat(events).answered) {
          log(`discussion ${chatId} on ${next.ticketId}: not answered — left outstanding`)
          break
        }
        answered += 1
      }
    }
    return { answered, heldBack }
  })

/**
 * One discussion at a time, whatever asks for one.
 *
 * The daemon's subscription hands events over as they arrive, so a burst of two
 * questions would otherwise start two of these concurrently — and both would
 * read the same chat stream, find the same request outstanding, and answer it
 * twice. Two agents for one question is the one way this feature could surprise
 * somebody with a bill, so the answers are serialised rather than raced.
 *
 * Made once per process, at module level, and unsafe because `Semaphore.make` is itself an Effect.
 * A permit is released on every exit, a failure and an interruption included.
 */
const discussing = Semaphore.makeUnsafe(1)

/**
 * `answerOutstanding`, behind the one queue. Every caller — a request, a resume
 * and daemon startup — goes through here, so two scans never answer the same
 * request at once (#996): a second scan would find the first one's request
 * still unanswered and start it again. The permit covers the scan as well as the
 * answer, because it is the scan that finds the request outstanding.
 * Never fails: a scan that does is said through `ports.log` and answers nothing.
 */
export const answerOutstandingQueued = (ports: AnswerPorts = {}): Effect.Effect<Outstanding> =>
  discussing.withPermits(1)(
    answerOutstanding(ports).pipe(
      recovering((err) =>
        Effect.sync((): Outstanding => {
          ports.log?.(`discussions: ${err.message}`)
          return { answered: 0, heldBack: 0 }
        }),
      ),
    ),
  )

/**
 * The daemon's handler for one `DiscussionRequested` as it arrives.
 *
 * It reads the *stream* rather than trusting the envelope's payload for
 * outstandingness: two requests can land in one burst, and answering the one in
 * hand while an earlier one is still unanswered would answer them out of order.
 */
export const onDiscussionRequested = (
  event: Envelope,
  log: (line: string) => void = () => {},
  locked?: AnswerPorts['locked'],
): Effect.Effect<void> =>
  (DISCUSSION_EVENTS as readonly string[]).includes(event.type)
    ? answerOutstandingQueued({ log, locked }).pipe(Effect.asVoid)
    : Effect.void
