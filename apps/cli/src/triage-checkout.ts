import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  const originalHome = process.env['HOME']
  // Codex rotates its refresh token in place, so a run must refresh the login
  // where the daemon's next pass will read it: a copy discarded at cleanup
  // leaves the original holding a spent token. The login directory itself is
  // shared; everything else about the home is private.
  const sharedCodexHome = process.env['CODEX_HOME'] ?? (originalHome ? join(originalHome, '.codex') : null)
  const cleanup = async () => {
    await rm(root, { recursive: true, force: true })
  }
  try {
    const cwd = join(root, 'checkout')
    const home = join(root, 'home')
    await mkdir(home, { recursive: true, mode: 0o700 })
    const codexHome = sharedCodexHome ?? join(home, '.codex')
    if (sharedCodexHome === null) await mkdir(codexHome, { recursive: true, mode: 0o700 })
    // No daemon config, GitHub token, remote, or user Git configuration is
    // inherited; only Codex's own login directory is shared.
    const env = { ...runnableEnv({}), HOME: home, CODEX_HOME: codexHome, GIT_CONFIG_NOSYSTEM: '1' }
    await git(['clone', '--no-hardlinks', '--dissociate', '--no-checkout', mirrorPathFor(project, mirrorHome), cwd], {
      env,
    })
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
