import { Suspense, use, type ReactNode } from 'react'

/**
 * A value that is here, or one that will be (0118 §2).
 *
 * The task page is sent before GitHub has answered, and what only the answer
 * knows arrives after it. Each place that reads it is a **synchronous component
 * given a resolved value**, and `Deferred` is the one seam that hands it one: a
 * test passes the value itself and sees what the page sees once it has arrived.
 */
export type Answered<T> = T | Promise<T>

const isThenable = <T,>(value: Answered<T>): value is Promise<T> =>
  typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'

function Read<T>({ value, children }: { value: Promise<T>; children: (value: T) => ReactNode }) {
  // `use`, and not an async component: it suspends the same way in a server
  // component and under `react-dom/server`, so a promise that never resolves
  // renders the fallback in a unit test.
  return <>{children(use(value))}</>
}

/**
 * Draws `children(value)` — at once for a value, and once it arrives for a
 * promise, with `fallback` until then. The promise must never reject: a
 * rejection goes to the error boundary and replaces the page (`loadTaskAnswer`).
 */
export function Deferred<T>({
  value,
  fallback,
  children,
}: {
  value: Answered<T>
  fallback: ReactNode
  children: (value: T) => ReactNode
}) {
  if (!isThenable(value)) return <>{children(value)}</>
  return (
    <Suspense fallback={fallback}>
      <Read value={value}>{children}</Read>
    </Suspense>
  )
}
