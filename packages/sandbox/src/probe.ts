/**
 * A host answer that needs no srt: are the programs srt runs on installed (#1152)? For a process that must never
 * load srt — the board — so setup still warns on a host that cannot sandbox. The pass decides again with srt's own
 * answer before it claims anything; this one only has to be right about what is plainly missing.
 */
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

import { Effect } from 'effect'

import { installFor } from './install.ts'
import { SandboxUnavailable } from './port.ts'

const onPath = (program: string, path: string): boolean =>
  path.split(delimiter).some((dir) => {
    if (dir === '') return false
    try {
      accessSync(join(dir, program), constants.X_OK)
      return true
    } catch {
      return false
    }
  })

export const hostProgramsPresent = (
  platform: string = process.platform,
  path: string = process.env['PATH'] ?? '',
): Effect.Effect<void, SandboxUnavailable> =>
  Effect.suspend(() => {
    const advice = installFor(platform)
    if (advice === undefined) {
      return Effect.fail(new SandboxUnavailable({ reason: 'this platform cannot be sandboxed', sentences: [] }))
    }
    const missing = advice.missing.filter((program) => !onPath(program, path))
    return missing.length === 0
      ? Effect.void
      : Effect.fail(
          new SandboxUnavailable({
            reason: 'host dependencies are missing',
            sentences: missing.map((m) => `${m} not installed`),
          }),
        )
  })
