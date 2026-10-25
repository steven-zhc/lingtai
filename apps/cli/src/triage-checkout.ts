import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runnableEnv } from '@lingtai/agent-env'
import { stateDir } from '@lingtai/env'
import { git, mirrorPathFor } from '@lingtai/repo'

/**
 * The environment a triage run gets: the filtered one, a private `HOME`, and
 * the user's real `CODEX_HOME`.
 *
 * **`CODEX_HOME` is not private on purpose, and it is not a daemon credential.**
 * It holds the user's own Codex CLI login. Codex rotates its refresh token in
 * place, so a copy discarded at cleanup would leave `~/.codex/auth.json` holding
 * a token the server has already spent, and every Codex `review` step would
 * lose its sign-in with it. `codex.ts`'s pass runtime keeps the user's
 * `CODEX_HOME` for the same reason: *a per-run `CODEX_HOME` holding only our
 * hooks is a run that is not signed in*. Nothing copies `auth.json`. No
 * `LINGTAI_*` value (daemon config, GitHub token, database URL) survives
 * `runnableEnv`, and the real home is read from `processEnv`, never from here.
 */
export function triageCheckoutEnv(
  processEnv: Readonly<Record<string, string | undefined>>,
  privateHome: string,
): Record<string, string> {
  const realHome = processEnv['HOME']
  const codexHome = processEnv['CODEX_HOME'] ?? (realHome ? join(realHome, '.codex') : join(privateHome, '.codex'))
  return { ...runnableEnv({}), HOME: privateHome, CODEX_HOME: codexHome, GIT_CONFIG_NOSYSTEM: '1' }
}

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
  const cleanup = async () => {
    await rm(root, { recursive: true, force: true })
  }
  try {
    const cwd = join(root, 'checkout')
    const home = join(root, 'home')
    await mkdir(home, { recursive: true, mode: 0o700 })
    const env = triageCheckoutEnv(process.env, home)
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
