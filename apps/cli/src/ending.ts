/**
 * How a command ends (#725): `run` settles, the process's database connection is
 * closed, and only then is the code handed back — so node is not left waiting
 * for an idle connection to time out. Takes `close` as an argument so this file
 * imports nothing from the store and `entry.ts` stays lazy.
 */

/** A dead network must not hold a finished command: the close is given this long. */
export const CLOSE_BUDGET_MS = 2000

/** True when the close finished; false when it rejected or ran out of time. */
async function closeBounded(close: () => Promise<void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${CLOSE_BUDGET_MS} ms`)), CLOSE_BUDGET_MS)
    // An un-unref'd timer would itself hold the process open on the happy path.
    timer.unref?.()
  })
  try {
    await Promise.race([close(), timedOut])
    return true
  } catch (err) {
    console.error(
      `lingtai: the log's connection did not close (${err instanceof Error && err.message ? err.message : String(err)}); exiting anyway`,
    )
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Settle `run`, close, then return its code; a rejection is re-thrown after the
 * close. Giving up on a close does not stop its socket holding the event loop,
 * so when it did not finish `exit` is called with the code the process will end
 * on (1 for a rejection), and is the caller's to make survive a pending write.
 */
export async function finish(
  run: () => Promise<number>,
  close: () => Promise<void>,
  exit?: (code: number) => void,
): Promise<number> {
  let code: number
  try {
    code = await run()
  } catch (err) {
    if (!(await closeBounded(close))) exit?.(1)
    throw err
  }
  if (!(await closeBounded(close))) exit?.(code)
  return code
}
