import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { nothingSetUp, shownHome, stateDir, type StoreChoice } from '@lingtai/env'

/**
 * The home this board serves, as `Home`'s props (#767). The board runs in the
 * CLI's own process, so these read the environment the CLI read.
 */
export function theHome(): { path: string; shown: string } {
  return { path: stateDir(), shown: shownHome() }
}

/** Whether `choice` is a home with nothing set up — the CLI's `notSetUp`, over the same two facts. */
export function homeNotSetUp(choice: StoreChoice): boolean {
  return nothingSetUp(choice, existsSync(join(stateDir(), 'config.yml')))
}
