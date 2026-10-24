import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runnableEnv } from '@lingtai/agent-env'
import { stateDir } from '@lingtai/env'
import { git, mirrorPathFor } from '@lingtai/repo'

/** A private copy: Codex may commit here without writing to the managed mirror. */
export async function prepareTriageCheckout(
  project: string,
  sha: string,
  mirrorHome = stateDir(),
): Promise<{
  cwd: string
  settingsPath: string
  env: Record<string, string>
  cleanup(): Promise<void>
}> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`invalid triage commit SHA: ${sha}`)
  const root = await mkdtemp(join(tmpdir(), 'lingtai-triage-'))
  const cleanup = () => rm(root, { recursive: true, force: true })
  try {
    const cwd = join(root, 'checkout')
    const home = join(root, 'home')
    const codexHome = join(home, '.codex')
    await mkdir(codexHome, { recursive: true, mode: 0o700 })
    // Only Codex's login receipt crosses into this home. No daemon config,
    // GitHub token, remote, or user Git configuration is inherited.
    const originalHome = process.env['HOME']
    if (originalHome) {
      await copyFile(join(originalHome, '.codex', 'auth.json'), join(codexHome, 'auth.json')).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        },
      )
    }
    const env = { ...runnableEnv({}), HOME: home, CODEX_HOME: codexHome, GIT_CONFIG_NOSYSTEM: '1' }
    await git(['clone', '--no-hardlinks', '--no-checkout', mirrorPathFor(project, mirrorHome), cwd], { env })
    await git(['remote', 'remove', 'origin'], { cwd, env })
    await git(['config', 'core.hooksPath', '/dev/null'], { cwd, env })
    await git(['checkout', '--detach', sha], { cwd, env })
    const actual = await git(['rev-parse', 'HEAD'], { cwd, env })
    if (actual !== sha) throw new Error(`triage checkout resolved ${actual}, expected ${sha}`)
    const settingsPath = join(root, 'settings.json')
    await writeFile(settingsPath, '{}\n', { mode: 0o600 })
    return { cwd, settingsPath, env, cleanup }
  } catch (error) {
    try {
      await cleanup()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'triage checkout preparation and cleanup failed')
    }
    throw error
  }
}
