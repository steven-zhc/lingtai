/**
 * Whether *this* Node build can `--build-sea`, measured rather than inferred
 * from a version (#212). 26.7.0 is higher than 26.5.0 and is the one that
 * cannot: Homebrew compiles single-executable support out, so a version
 * comparison passes a Node that then fails inside `node --build-sea` itself.
 *
 * Two layers, so the classification stays a unit test:
 * `classifySeaBuild` is pure — it takes a spawn result apart — and
 * `probeSeaBuild` is the one thing that actually spawns Node and is never
 * called from a unit test.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type SeaProbe = { can: true } | { can: false; why: 'disabled' | 'unsupported' | 'failed'; said: string }

/** The two strings measured against real Node builds (#212's ticket). */
export function classifySeaBuild(status: number | null, stderr: string, error?: Error): SeaProbe {
  if (status === 0 && !error) return { can: true }
  const said =
    stderr
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trim() ??
    error?.message ??
    `exited ${status}`
  if (/single executable application is disabled/i.test(stderr)) return { can: false, why: 'disabled', said }
  if (/bad option: --build-sea/.test(stderr)) return { can: false, why: 'unsupported', said }
  return { can: false, why: 'failed', said }
}

/**
 * Actually attempts the build, against a throwaway one-line script in a
 * temporary directory, and removes the directory before returning. That
 * directory briefly holds a full copy of the probed Node (`--build-sea`
 * copies the binary it runs under) — a few hundred milliseconds and roughly
 * 100MB, gone in the `finally`. Not a write `doctor.ts`'s own rule against
 * writing is about: that rule is about the event log, and this never touches
 * it.
 */
export function probeSeaBuild(node: string = process.execPath): SeaProbe {
  const scratch = mkdtempSync(join(tmpdir(), 'lingtai-sea-probe-'))
  try {
    const main = join(scratch, 'main.js')
    const config = join(scratch, 'sea-config.json')
    writeFileSync(main, 'process.exit(0)\n')
    writeFileSync(
      config,
      JSON.stringify({
        main,
        output: join(scratch, 'probe.blob'),
        disableExperimentalSEAWarning: true,
        useCodeCache: false,
        useSnapshot: false,
      }),
    )
    const result = spawnSync(node, ['--build-sea', config], { encoding: 'utf8', timeout: 30_000 })
    return classifySeaBuild(result.status, result.stderr ?? '', result.error)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
