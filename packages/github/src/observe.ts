/**
 * A seam for measuring one request to GitHub, and nothing else (#1144). **It
 * does nothing until a host installs it**: the board does, the daemon never
 * does, so the daemon's traces are what they were.
 *
 * What crosses it is the method, the page number and, when GitHub sent it,
 * `x-ratelimit-remaining`. **Never the path**: it carries an owner, a repo and
 * issue numbers, and a span carries no URL (0101 §6).
 *
 * The observer is kept on `globalThis` because a host may load this module
 * twice — Next bundles `instrumentation.ts` apart from the routes — and the one
 * that installs must be the one the requests read.
 */
export type RequestInfo = { readonly method: string; readonly page: number | undefined }

/** Runs `run`, which calls `report` with the remaining rate limit once the headers are in. */
export type RequestObserver = <T>(
  info: RequestInfo,
  run: (report: (remaining: number | undefined) => void) => Promise<T>,
) => Promise<T>

const KEY = Symbol.for('lingtai.github.requestObserver')
type Holder = { [KEY]?: RequestObserver | undefined }

export function setRequestObserver(observer: RequestObserver | undefined): void {
  ;(globalThis as Holder)[KEY] = observer
}

const noop = (): void => undefined

/** Carries a value `failed` judged a failure through the observer's rejection, so its span is marked. */
class Judged<T> {
  readonly value: T
  constructor(value: T) {
    this.value = value
  }
}

/**
 * `run`, as it is with no observer: the same promise, no hop. With one, `run`
 * includes the body, and a value `failed` calls a failure (a non-2xx the caller
 * turns into an error later) rejects inside the observer so its span ends
 * failed, then comes back out as the value.
 */
export function observedRequest<T>(
  method: string,
  path: string,
  run: (report: (remaining: number | undefined) => void) => Promise<T>,
  failed?: (value: T) => boolean,
): Promise<T> {
  const observer = (globalThis as Holder)[KEY]
  if (observer === undefined) return run(noop)
  const match = /[?&]page=(\d+)/.exec(path)
  const info = { method, page: match === null ? undefined : Number(match[1]) }
  if (failed === undefined) return observer(info, run)
  return observer(info, (report) =>
    run(report).then((value) => {
      if (failed(value)) throw new Judged(value)
      return value
    }),
  ).catch((err: unknown) => {
    if (err instanceof Judged) return err.value as T
    throw err
  })
}

/** The header as a number; missing or not a number is `undefined`, never `0`. */
export function remainingOf(response: { readonly headers: { get(name: string): string | null } }): number | undefined {
  const raw = response.headers.get('x-ratelimit-remaining')
  if (raw === null || !/^\d+$/.test(raw)) return undefined
  return Number(raw)
}
