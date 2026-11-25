/**
 * A seam for measuring one read of an event stream, and nothing else (#1375).
 * **It does nothing until a host installs it**: the board does, the daemon never
 * does, so the daemon's reads are what they were. The package starts no span of
 * its own (#1144): the daemon exports every span.
 *
 * What crosses it is the stream's **kind** — the id up to its first `-` — and
 * never the id, which carries a project, an issue number or a pass (0101 §6).
 *
 * The observer is kept on `globalThis` because a host may load this module
 * twice — Next bundles `instrumentation.ts` apart from the routes — and the one
 * that installs must be the one the reads use.
 */
export type ReadInfo = { readonly kind: string }

/** Runs `run`, which calls `report` with the number of events once the read has returned. */
export type ReadObserver = <T>(info: ReadInfo, run: (report: (events: number) => void) => Promise<T>) => Promise<T>

const KEY = Symbol.for('lingtai.event-store.readObserver')
type Holder = { [KEY]?: ReadObserver | undefined }

export function setReadObserver(observer: ReadObserver | undefined): void {
  ;(globalThis as Holder)[KEY] = observer
}

/** The stream id's prefix up to its first `-`; none, or an empty one, is `unknown` — never the id. */
export function kindOf(streamId: string): string {
  const at = streamId.indexOf('-')
  return at > 0 ? streamId.slice(0, at) : 'unknown'
}

/**
 * `run`, as it is with no observer: the same promise, no hop. With one, `report`
 * is called after the read resolves, so a rejection reaches the caller untouched
 * and `report` is never called for it.
 */
export function observedRead<T extends readonly unknown[]>(streamId: string, run: () => Promise<T>): Promise<T> {
  const observer = (globalThis as Holder)[KEY]
  if (observer === undefined) return run()
  return observer({ kind: kindOf(streamId) }, (report) =>
    run().then((events) => {
      report(events.length)
      return events
    }),
  )
}

/**
 * The twin of `ReadObserver` for `head` (#1441): one physical head read, by stream kind and never by id. It sits in
 * `promiseStore`, under `memoStore`, so a second waiter on a shared promise never reaches it.
 */
export type HeadInfo = { readonly kind: string }

/** Runs `run`, which calls `report` with the head once the read has returned. */
export type HeadObserver = <T>(info: HeadInfo, run: (report: (head: number) => void) => Promise<T>) => Promise<T>

const HEAD_KEY = Symbol.for('lingtai.event-store.headObserver')
type HeadHolder = { [HEAD_KEY]?: HeadObserver | undefined }

export function setHeadObserver(observer: HeadObserver | undefined): void {
  ;(globalThis as HeadHolder)[HEAD_KEY] = observer
}

/**
 * `run`, as it is with no observer: the same promise, no hop. With one, `report` is called after the read resolves, so a
 * rejection reaches the caller untouched and reports no count. A head of `0` is a successful read of an absent stream.
 */
export function observedHead(streamId: string, run: () => Promise<number>): Promise<number> {
  const observer = (globalThis as HeadHolder)[HEAD_KEY]
  if (observer === undefined) return run()
  return observer({ kind: kindOf(streamId) }, (report) =>
    run().then((head) => {
      report(head)
      return head
    }),
  )
}
