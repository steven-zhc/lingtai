/**
 * What a process opens once and closes once, when its command has finished (#725).
 *
 * A Postgres client left open holds the event loop until its idle connection
 * times out — about 30 s after the last line of output — so the entry closes
 * the process log after `runCli` settles. This is the seam: `choose.ts` hands it
 * the opener, and a test hands it a fake with a counted `close`.
 */

/** Raised by anything that asks for the process log after it was closed. */
export class ProcessLogClosedError extends Error {
  constructor() {
    super('the process log was closed when the command finished; nothing may read it after')
    this.name = 'ProcessLogClosedError'
  }
}

export interface Closable {
  close(): Promise<void>
}

export interface ClosableOnce<T extends Closable> {
  /** Open on first use, memoised on the promise so racing first callers open once. */
  get(): Promise<T>
  /** Close what was opened, once; with nothing opened, only refuse from now on. */
  close(): Promise<void>
}

export function closableOnce<T extends Closable>(open: () => Promise<T>): ClosableOnce<T> {
  let opening: Promise<T> | null = null
  let closing: Promise<void> | null = null
  let closed = false
  return {
    get() {
      if (closed) return Promise.reject(new ProcessLogClosedError())
      return (opening ??= open())
    },
    close() {
      closed = true
      return (closing ??= (async () => {
        if (!opening) return
        // An open that failed left nothing to close, and its error was already
        // reported by the command that asked.
        const opened = await opening.catch(() => null)
        await opened?.close()
      })())
    },
  }
}
