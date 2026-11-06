'use client'

/**
 * One attempt's run log, on the board, when you ask for it.
 *
 * The other half of `#110`, and it sits inside the ledger row (`#102`) because
 * that is where the attempt is: a log belongs to a run, and a run is an
 * attempt. **Except while the item is running** (#152): then what the run is
 * doing is the whole of the page's answer, and the same log is rank 2 of the
 * task page, where a refusal would be on a blocked one.
 *
 * **Off until asked, which is the whole of the design here.** Nothing tails
 * anything on a page load: the `<details>` is closed, and the connection is
 * opened by the first toggle and never before. A task page with six attempts
 * would otherwise hold six file descriptors and six streams for a page nobody
 * scrolled down.
 *
 * **Except the one that is producing output right now** (`live`, #132). That
 * reason is about six attempts nobody asked to see, and it made *the run
 * happening this second* two disclosures deep with nothing on the page saying
 * it was there — `#110` built the stream and the page hid it. A running attempt
 * opens itself and its log opens with it; every finished attempt is closed and
 * reads nothing, which is the reason above, intact.
 *
 * **From the beginning, however late.** The route re-reads the file from byte
 * zero every time, so expanding a run that has been going for four minutes
 * shows the four minutes — the property 0034 chose a file over a socket for.
 * Nothing here is resumed and nothing is remembered between toggles.
 *
 * **It never says how the run went.** The row's own pill already carries that,
 * reduced from `events`; the log is a trace and not a record (0034 §8). What
 * `end` says is that there is no more to come.
 *
 * No colour, on purpose — `#107` owns the vocabulary for every surface, and the
 * ticket leaves this outside it rather than have the board invent a second one
 * for the same facts.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

import { openFor, saidLast, scannedAll, tailRule } from '@/lib/said'

import { useLatch } from './latch.tsx'

/**
 * How much of one log is held in the browser.
 *
 * The file is capped at `RUN_LOG_MAX_BYTES` — eight megabytes — and a `<pre>`
 * of eight megabytes is a tab that stops responding, which is a worse way to
 * fail than showing less. The head is what goes: a log is read forwards from
 * the start, and the interesting end of a run that is still going is the
 * bottom. `lingtai attach` has no such bound and neither does the file.
 */
export const KEEP_LINES = 2_000

/**
 * How long to wait before asking again for a log that is not there yet, the
 * first time.
 *
 * Only for a follower that has been told the file is coming — the discussion
 * box, whose question the board appended a moment ago and whose daemon has not
 * opened the file yet (#132). A run's log is never waited for like this: a
 * `<details>` somebody opened on a landed attempt is asking about a file that
 * has been deleted, and retrying that is a poll for something that will never
 * arrive.
 */
const AGAIN_MS = 1_500

/**
 * The longest wait between two asks, which the delay doubles towards.
 *
 * **The asking never stops while the turn is on screen**, and that is the
 * correction to a bound that did. `DiscussionAsked` is appended by the board and
 * answered by whatever daemon is running, and a question asked with none running
 * waits in the stream until one starts — which may be tomorrow
 * (`answerOutstanding`). A follower that gave up after thirty seconds told the
 * reader the turn was dead while it was queued, and a reader told that asks
 * again, which buys a second agent for the same question. Backing off keeps the
 * cost of an unwatched tab at one 404 every fifteen seconds and still catches
 * the trace the moment a daemon opens it.
 */
const AGAIN_MAX_MS = 15_000

/**
 * How many asks, before *not yet* is said as *nothing has started on it*.
 *
 * Not a limit on asking (see `AGAIN_MAX_MS`) — the point past which the box
 * stops implying a daemon is about to answer. Five asks is about twenty-two
 * seconds, far past the time a running daemon takes to open the file, so what
 * is left is a question waiting for a daemon, and the box says that instead.
 */
const AGAIN_PATIENCE = 5

/** The wait before ask `n + 1`, doubling from `AGAIN_MS` to `AGAIN_MAX_MS`. */
export function againAfter(n: number): number {
  return Math.min(AGAIN_MS * 2 ** n, AGAIN_MAX_MS)
}

type Ended = 'landed' | 'did not land' | 'removed'

/**
 * What the follower knows about the file. Never about the run (0034 §8).
 *
 * `waiting` and `queued` are both `gone` seen by a caller that was told the
 * file is coming (`awaited`): the first while a daemon could still be opening
 * it, the second once it has been long enough that the likelier reading is that
 * none is running (`AGAIN_PATIENCE`). Neither is *not coming*, and a box
 * waiting for an answer must never say that it is.
 */
export type TailState = 'off' | 'reading' | 'waiting' | 'queued' | 'gone' | 'trouble' | Ended

/**
 * The state a caller is handed, from the one the stream reported.
 *
 * Pure so the reading is testable without an `EventSource`: `gone` is only
 * `gone` to a follower that was not told the file is coming.
 */
export function reported(state: TailState, awaited: boolean, asks: number): TailState {
  if (state !== 'gone' || !awaited) return state
  return asks < AGAIN_PATIENCE ? 'waiting' : 'queued'
}

/**
 * Whether a follower in this state asks for the file again.
 *
 * **To an awaited follower an ending is not the end.** The file going away is
 * what a finished turn does, and it is also what the *start* of a turn does:
 * `answerDiscussion` removes whatever a daemon killed mid-answer left behind
 * before it opens its own. A follower that stopped at `removed` sat on that
 * leftover's deletion for the whole of the new answer and never saw its trace.
 * So it asks again — the turn being on screen at all means no answer has been
 * reduced, and when one is, the task page re-renders (`Follow`, in `live.tsx` —
 * not the board's `Live`, which only `/` mounts) and this follower is gone.
 */
export function asksAgain(state: TailState, awaited: boolean): boolean {
  if (!awaited) return false
  return state === 'gone' || state === 'removed' || state === 'landed' || state === 'did not land'
}

/**
 * Follow one log file over the route's SSE, for as long as `following`.
 *
 * The half of this file that is not chrome, extracted because `#132` gives it a
 * second reader: the discussion box tails a chat's log exactly as a ledger row
 * tails a run's, and two copies of an `EventSource` lifecycle is two places for
 * a connection to be left open.
 */
export function useLogTail(
  id: string,
  following: boolean,
  /** Whether a missing file is *not yet* rather than *never*. See `AGAIN_MS`. */
  awaited = false,
  /**
   * Ask again after the stream goes away, as an awaited follower does, without
   * `awaited`'s other readings (a run's log that is live must come back after a
   * board restart, and must not say `waiting`).
   */
  retry = false,
): { lines: readonly string[]; state: TailState; writing: boolean | null } {
  const [lines, setLines] = useState<readonly string[]>([])
  const [state, setState] = useState<TailState>('off')
  // Whether the route last saw the file being touched by a writer — null until
  // it has said. `reading` is about the connection and this is about the other
  // end of the file: a trace a killed daemon left behind opens exactly like one
  // being written (`RUN_LOG_BEAT_MS`, #132).
  const [writing, setWriting] = useState<boolean | null>(null)
  // Bumped to ask again for a file that has not been created yet, or that an
  // awaited follower saw end; nothing else restarts a stream, so a follow is one
  // connection per attempt at one.
  const [again, setAgain] = useState(0)
  // Asks since a stream last opened, which is what patience is counted in: a
  // trace that opened and then went away says a daemon was running a moment ago.
  const [misses, setMisses] = useState(0)
  const source = useRef<EventSource | null>(null)
  const asks = awaited || retry
  // Read by the error handler when it fires, and not a dependency of `start`:
  // `retry` goes false when the run lands, and that must not restart an open
  // tail and blank the log the reader is looking at.
  const asksNow = useRef(asks)
  useEffect(() => {
    asksNow.current = asks
  }, [asks])

  const stop = useCallback(() => {
    source.current?.close()
    source.current = null
  }, [])

  const start = useCallback(() => {
    if (source.current) return
    // An awaited follower keeps what it has until a new trace opens: asking
    // again after a removal must not blank the box for the length of a 404.
    if (!asksNow.current) setLines([])
    // `reading` when the stream opens and not before: a 404 never opens, and a
    // box that said *reading* for the length of one would claim, for a moment,
    // that a daemon had started on a question nothing has picked up.

    const es = new EventSource(`/api/run/${encodeURIComponent(id)}`)
    source.current = es
    es.onopen = () => {
      // From byte zero, so what it had is replaced rather than appended to.
      if (asksNow.current) setLines([])
      setMisses(0)
      setWriting(null)
      setState('reading')
    }

    es.addEventListener('writer', (event) => {
      setWriting((JSON.parse((event as MessageEvent<string>).data) as { writing: boolean }).writing)
    })

    es.addEventListener('line', (event) => {
      const line = JSON.parse((event as MessageEvent<string>).data) as string
      setLines((previous) => {
        const next = [...previous, line]
        return next.length > KEEP_LINES ? next.slice(next.length - KEEP_LINES) : next
      })
    })

    es.addEventListener('end', (event) => {
      const { ended } = JSON.parse((event as MessageEvent<string>).data) as { ended: Ended }
      setState(ended)
      setWriting(null)
      // The server closed its side; without this the browser reconnects on its
      // own and re-reads the whole file for ever.
      stop()
    })

    es.addEventListener('trouble', () => {
      setState('trouble')
      setWriting(null)
      stop()
    })

    // A 404 — a run that landed and took its log with it — arrives here, since
    // `EventSource` reports every failure the same way. Distinguishing them
    // would need a `fetch` first, and the two sentences are close enough that a
    // second round trip is not worth it.
    es.onerror = () => {
      setState((was) =>
        was === 'reading' || was === 'gone' || was === 'off' || asksAgain(was, awaited) ? 'gone' : was,
      )
      // Counted here and not when asking, so a second 404 in a row — the same
      // state, which React would not re-render for — still schedules the next.
      // A writer that cannot be heard is unknown, not the last thing it said.
      setWriting(null)
      if (asksNow.current) setMisses((n) => n + 1)
      stop()
    }
  }, [id, awaited, stop])

  // One connection for as long as it is followed, and none at all while it is
  // not. The cleanup is also what closing the tab or navigating away runs — the
  // route is following a file for as long as somebody is listening.
  useEffect(() => {
    if (!following) return
    // `again` is read for the dependency and for nothing else: changing it is
    // what re-runs this effect.
    void again
    start()
    return stop
  }, [following, again, start, stop])

  // The file that is coming rather than gone, asked for again for as long as
  // somebody is waiting for it, less often each time (`againAfter`) — and after
  // an ending too, for an awaited follower (`asksAgain`).
  // Never while a connection is open or opening: that one has not answered yet.
  useEffect(() => {
    // A live run's tail (`retry`) asks again only after its connection dropped
    // (`gone`), never after an ending: the file is deleted when the run lands,
    // and asking then would blank the lines the reader is looking at.
    if (!following || !(asksAgain(state, awaited) || (retry && state === 'gone')) || source.current !== null) return
    const timer = setTimeout(() => setAgain((n) => n + 1), againAfter(Math.max(misses - 1, 0)))
    return () => clearTimeout(timer)
  }, [following, awaited, retry, state, again, misses])

  return { lines, state: reported(state, awaited, misses), writing }
}

export function RunLog({
  runId,
  live = false,
  className = 'alog',
}: {
  runId: string
  /**
   * Whether this attempt is still going, in which case the log opens with it.
   *
   * Decided by the page from the reducer — `run.outcome.state` — and not asked of
   * this component, which knows about a file and never about a run (0034 §8).
   */
  live?: boolean
  /**
   * Where it sits, and nothing about what it does. The attempt row's `alog`,
   * or the task page's rank 2 for an item that is running (#152) — the same
   * follower in a different slot.
   */
  className?: string
}) {
  // Open is latched rather than a bare attribute because it is now two things:
  // a running attempt starts open, and a reader can close it. `useState(live)`
  // would read `live` once — so a log mounted before its run started would
  // never open — and a bare `open={live}` would shut it again when the run
  // ended. See `latch.tsx`.
  const [open, setOpen] = useLatch(live, live)
  const { lines, state } = useLogTail(runId, open)
  const tail = useRef<HTMLDivElement | null>(null)

  // Follow the bottom, which is where a running log is.
  useEffect(() => {
    tail.current?.scrollTo({ top: tail.current.scrollHeight })
  }, [lines])

  return (
    <details className={className} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="hdocname">run log</span>
        <span className="hdocsize">{say(state, lines.length)}</span>
      </summary>
      {state === 'gone' ? (
        <p className="empty">
          No run log for this attempt. A run log is deleted when the attempt lands or the ticket closes — what is kept
          is exactly what is still owed an explanation (0034).
        </p>
      ) : (
        <div className="alogbody" ref={tail}>
          <pre className="hdoctext">{lines.join('\n')}</pre>
        </div>
      )}
    </details>
  )
}

/**
 * The run rank 2 shows: the one running now, or the last one it showed.
 *
 * Kept rather than derived, because the page re-renders on every append and a
 * run that ends stops being `running` in the very render that carries its
 * refusal. Derived, the log would unmount under the person reading its last
 * lines — its open state and its scroll gone with it, and the only other copy
 * closed in the record — which is the close-under-the-reader `latch.tsx` exists
 * to prevent (#152). A different run starting replaces it; nothing else does.
 */
export function heldRun(held: string | null, running: string | null): string | null {
  return running ?? held
}

/**
 * Whether a held log goes under rank 2's other lines rather than above them.
 *
 * **Under, once its run has ended** (#152). The render that ends the run is the
 * one that carries the refusal, and the refusal is the page's answer from then
 * on: a finished log above it put the quote, the one sentence and the moves
 * below the first screen for the very person who was watching the item.
 */
export function logBelow(shown: string | null, running: string | null): boolean {
  return shown !== null && shown !== running
}

interface Followed {
  shown: string | null
  live: boolean
  below: boolean
  lines: readonly string[]
  state: TailState
  /** Whether a writer holds the run log (#132); null unless the run is live and the route has said. */
  writing: boolean | null
  open: boolean
  setOpen: (open: boolean) => void
  tags: readonly (string | null)[]
  /** The reader's place in the raw log: it outlives the element, which is replaced when the run ends. */
  place: { current: { run: string | null; top: number; pinned: boolean } }
}

const FollowedContext = createContext<Followed | null>(null)

/**
 * The one tail for a running ticket's page, and the state the views over it share
 * (#917). It is rendered in the same place whatever the ticket's state, so that
 * the views — `SaidLast` and `RawRunLog` — may mount and unmount inside it
 * without the tail, the lines or the reader's open log going with them. See
 * `heldRun`: the run that ends under a reader leaves their log where they left it.
 *
 * It follows while the run is live **or** the reader has opened the raw log
 * (`tailRule`), so the quoted lines fill in with the raw log closed. Open is the
 * reader's alone, and about one run (`openFor`).
 */
export function FollowedLog({
  running,
  tags = [],
  children,
}: {
  running: string | null
  /** The tags the agent's prose is filed under in the phase in flight. See `RunningPanelView.said`. */
  tags?: readonly (string | null)[]
  children?: ReactNode
}) {
  const [held, setHeld] = useState(running)
  useEffect(() => {
    setHeld((was) => heldRun(was, running))
  }, [running])
  const [opened, setOpened] = useState<string | null>(null)
  const place = useRef({ run: null as string | null, top: 0, pinned: true })
  const shown = heldRun(held, running)
  const below = logBelow(shown, running)
  const live = shown !== null && running === shown
  const open = openFor(opened, shown)
  const { lines, state, writing } = useLogTail(shown ?? '', shown !== null && tailRule(live, open), false, live)
  const setOpen = useCallback((next: boolean) => setOpened(next ? shown : null), [shown])
  return (
    <FollowedContext.Provider
      value={{ shown, live, below, lines, state, writing: live ? writing : null, open, setOpen, tags, place }}
    >
      {children}
    </FollowedContext.Provider>
  )
}

/** What the agent said last, from the run log: a trace, and nothing here is decided from it (0111 §13). */
export function SaidLast() {
  const f = useContext(FollowedContext)
  if (f === null || !f.live) return null
  const said = saidLast(f.lines, f.tags)
  return (
    <div className="saidlast" data-rank="said">
      <p className="triage-then">
        <b>What the agent said last</b> · from the run log, newest first
      </p>
      {f.state === 'gone' ? (
        <p className="empty">
          No run log for this attempt, so what the agent said cannot be shown; the steps above are from the log of
          events.
        </p>
      ) : (
        <>
          {f.state === 'trouble' ? <p className="empty">The run log could not be followed.</p> : null}
          {said.length === 0 ? (
            <p className="empty">
              {scannedAll(f.lines, KEEP_LINES)
                ? `Nothing said in the last ${KEEP_LINES.toLocaleString('en-US')} lines.`
                : 'Nothing said yet in this round.'}
            </p>
          ) : (
            <ul className="saidlines">
              {said.map((l, i) => (
                <li key={`${l.at}-${i}`}>
                  <span className="mono">{l.at}</span>{' '}
                  <span
                    title={l.text}
                    style={{
                      display: '-webkit-box',
                      WebkitLineClamp: 3,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}
                  >
                    {l.text}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

/**
 * The raw run log, closed until the reader opens it. `running` draws it in the
 * running panel; `ended` draws the same state where `logBelow` puts it once the
 * run has ended — so the log they opened stays open (#152).
 */
export function RawRunLog({ where }: { where: 'running' | 'ended' }) {
  const f = useContext(FollowedContext)
  const tail = useRef<HTMLDivElement | null>(null)
  const lines = f?.lines
  const open = f?.open
  const place = f?.place
  const shown = f?.shown ?? null
  // Follow the bottom while the reader is at it. A reader who scrolled back keeps
  // their place, including across the remount when the run ends and the log moves
  // from the panel: the element is new, so the place is restored from the provider.
  useEffect(() => {
    const el = tail.current
    if (el === null || !place) return
    // A place is about one run: another run's log starts pinned to its bottom.
    const mine = place.current.run === shown ? place.current : null
    el.scrollTo({ top: mine === null || mine.pinned ? el.scrollHeight : mine.top })
  }, [lines, open, place, shown])
  if (f === null || f.shown === null) return null
  if (where === 'running' ? !f.live : !f.below) return null
  const count = f.lines.length
  return (
    <details
      className={where === 'running' ? 'alog slog' : 'alog slog ended'}
      open={f.open}
      onToggle={(event) => f.setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="hdocname">The run log</span>
        <span className="hdocsize">
          {f.open || !f.live ? say(f.state, count) : `${count} lines · follows live when open`}
        </span>
      </summary>
      {f.state === 'gone' ? (
        <p className="empty">
          No run log for this attempt. A run log is deleted when the attempt lands or the ticket closes — what is kept
          is exactly what is still owed an explanation (0034).
        </p>
      ) : (
        <div
          className="alogbody"
          ref={tail}
          onScroll={(event) => {
            const el = event.currentTarget
            if (place)
              place.current = {
                run: f.shown,
                top: el.scrollTop,
                pinned: el.scrollHeight - el.scrollTop - el.clientHeight < 8,
              }
          }}
        >
          <pre className="hdoctext">{f.lines.join('\n')}</pre>
        </div>
      )}
    </details>
  )
}

/** What the right of the summary says, and it is about the file, never the run. */
function say(state: TailState, count: number): string {
  if (state === 'off') return 'not reading'
  // A run's log is never `awaited`, so this is the discussion box's state and
  // not one a ledger row can reach. Said anyway, rather than falling through to
  // `ends here` on a file that has not started.
  if (state === 'waiting' || state === 'queued') return 'no log yet'
  if (state === 'gone') return 'no log'
  if (state === 'trouble') return 'the connection to the run log failed'
  if (state === 'reading') return `${count} lines · following`
  if (state === 'removed') return `${count} lines · the log has been deleted`
  return `${count} lines · ends here`
}

/** The `writing` bit of the shared tail; null outside a followed, live run. */
export function useWriting(): boolean | null {
  return useContext(FollowedContext)?.writing ?? null
}
