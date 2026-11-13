/**
 * Measures the wait for a connection apart from the query (#1144). **Nothing
 * installs it but the board**: with none, a read is `pool.query`, as it was.
 * Kept on `globalThis` for the reason `@lingtai/github`'s observer is.
 */
export type AcquireObserver = <T>(run: () => Promise<T>) => Promise<T>
const ACQUIRE = Symbol.for('lingtai.projector.acquireObserver')
type AcquireHolder = { [ACQUIRE]?: AcquireObserver | undefined }

export function setAcquireObserver(observer: AcquireObserver | undefined): void {
  ;(globalThis as AcquireHolder)[ACQUIRE] = observer
}

export const acquireObserver = (): AcquireObserver | undefined => (globalThis as AcquireHolder)[ACQUIRE]
