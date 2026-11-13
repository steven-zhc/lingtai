/**
 * One writer per projection (0100 §13): only the process holding the conductor
 * lock builds a projection runner. Two runners that read a stored state, reduce
 * it and write it back over one shared checkpoint race (#838, #834), so a
 * command that only appends builds none.
 *
 * The list below is every `src/` file that contains `createProjectionRunner(` or
 * `makeRunner(` (the daemon builds its runners as ports since #1071),
 * each with why it may. It is compared for **equality**, so a file that drops
 * off the list fails too and the list cannot go stale. Adding a line is a
 * decision a reviewer sees. `apps/board/unit/read-not-reduce.test.ts` holds the
 * board to none at all.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { expect, it } from 'vitest'

const root = join(import.meta.dirname, '../../..')

const MAY_BUILD_A_RUNNER: Readonly<Record<string, string>> = {
  'packages/projector/src/projection.ts': 'the definition of makeRunner',
  'packages/daemon/src/daemon.ts': 'the daemon, after acquireDaemonLock — held even under --no-conduct',
  'apps/cli/src/projector.ts': "`lingtai run`'s ProjectorLive, built after run takes the conductor lock",
  'apps/cli/src/rates.ts': "the price-triggered rebuild (#680), called only from a lock holder's own process",
  'apps/cli/src/cli.ts': '`lingtai projection rebuild`, which takes the conductor lock before it builds the runner',
}

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name === '.next') return []
    const path = join(dir, e.name)
    return e.isDirectory() ? sources(path) : /\.tsx?$/.test(e.name) ? [path] : []
  })

it('only the conductor lock holder builds a projection runner', () => {
  const srcDirs = ['apps', 'packages'].flatMap((top) =>
    readdirSync(join(root, top), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(root, top, e.name, 'src')),
  )
  const found = srcDirs
    .flatMap((dir) => {
      try {
        return sources(dir)
      } catch {
        return []
      }
    })
    .filter((f) => /\b(createProjectionRunner|makeRunner)\(/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(root, f))
    .sort()
  expect(found).toEqual(Object.keys(MAY_BUILD_A_RUNNER).sort())
})
