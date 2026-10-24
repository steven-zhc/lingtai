import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
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
  const originalAuth = originalHome ? join(originalHome, '.codex', 'auth.json') : null
  let copied: string | null = null
  const privateAuth = join(root, 'home', '.codex', 'auth.json')
  const cleanup = async () => {
    // Codex rotates its refresh token in place. If this run was the one to
    // refresh, the spent token is all the original still holds: hand the new
    // login back, unless somebody else has already replaced the original.
    try {
      if (originalAuth !== null && copied !== null) {
        const now = await readFile(privateAuth, 'utf8').catch(() => null)
        if (now !== null && now !== copied && (await readFile(originalAuth, 'utf8').catch(() => null)) === copied) {
          const staged = `${originalAuth}.${process.pid}.tmp`
          await writeFile(staged, now, { mode: 0o600 })
          await rename(staged, originalAuth)
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
  try {
    const cwd = join(root, 'checkout')
    const home = join(root, 'home')
    const codexHome = join(home, '.codex')
    await mkdir(codexHome, { recursive: true, mode: 0o700 })
    // Only Codex's login receipt crosses into this home. No daemon config,
    // GitHub token, remote, or user Git configuration is inherited.
    if (originalAuth !== null) {
      copied = await readFile(originalAuth, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return null
      })
      if (copied !== null) await writeFile(privateAuth, copied, { mode: 0o600 })
    }
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
