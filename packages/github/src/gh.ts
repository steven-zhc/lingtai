/**
 * The saved `gh` login as a way to reach GitHub (0114 §1, §8).
 *
 * `gh` reads `GH_TOKEN`, then `GITHUB_TOKEN`, ahead of its saved login, so the
 * child is never handed the parent's environment: `scrubbedEnv` is what the
 * live runner passes as `env`. Everything here goes through one port, `GhRun`,
 * so a unit test fakes the spawn and still tests the code that decides what to
 * do with the answer.
 *
 * **The token is held for one call.** It is never cached, never logged and
 * never in an error: `execFile`'s rejection carries `stdout`, which is the
 * token, so `liveGh` catches it and no rejection object leaves this module.
 */
import { execFile, spawn } from 'node:child_process'

/** The variables `gh` prefers to its saved login. */
const TOKEN_VARIABLES = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'] as const

/** The oldest `gh` whose `auth status` takes `--json`. */
export const GH_MIN_VERSION = '2.81.0'

const HOST = 'github.com'
const TIMEOUT_MS = 15_000

/** A copy of `parent` without the variables that would override the saved login. */
export function scrubbedEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...parent }
  for (const name of TOKEN_VARIABLES) delete env[name]
  return env
}

export type GhRunResult = { code: number; stdout: string; stderr: string } | { missing: true }

export interface GhRunOptions {
  /** `inherit` hands the terminal over (an interactive login); the output is then empty. */
  stdio?: 'pipe' | 'inherit'
  signal?: AbortSignal
}

/** The port: run `gh` with these arguments. It resolves on every outcome and never rejects with output attached. */
export type GhRun = (args: readonly string[], options?: GhRunOptions) => Promise<GhRunResult>

/** The options `liveGh` gives `execFile`, with the environment always scrubbed. */
export function ghExecOptions(parent: NodeJS.ProcessEnv, signal?: AbortSignal) {
  return { env: scrubbedEnv(parent), signal, timeout: TIMEOUT_MS, encoding: 'utf8' as const }
}

/** The options `liveGh` gives `spawn` when it hands the terminal over, with the environment always scrubbed. */
export function ghSpawnOptions(parent: NodeJS.ProcessEnv, signal?: AbortSignal) {
  return { env: scrubbedEnv(parent), stdio: 'inherit' as const, signal }
}

export const liveGh: GhRun = (args, options = {}) => {
  if (options.stdio === 'inherit') {
    return new Promise((resolve) => {
      const child = spawn('gh', [...args], ghSpawnOptions(process.env, options.signal))
      child.on('error', (error: NodeJS.ErrnoException) =>
        resolve(error.code === 'ENOENT' ? { missing: true } : { code: 1, stdout: '', stderr: error.message }),
      )
      child.on('close', (code) => resolve({ code: code ?? 1, stdout: '', stderr: '' }))
    })
  }
  return new Promise((resolve) => {
    execFile('gh', [...args], ghExecOptions(process.env, options.signal), (error, stdout, stderr) => {
      if (error === null) return resolve({ code: 0, stdout, stderr })
      const failure = error as NodeJS.ErrnoException & { killed?: boolean }
      if (failure.code === 'ENOENT') return resolve({ missing: true })
      if (failure.killed) return resolve({ code: 1, stdout: '', stderr: `gh did not answer in ${TIMEOUT_MS / 1000}s` })
      resolve({ code: typeof failure.code === 'number' ? failure.code : 1, stdout, stderr })
    })
  })
}

/** Drops anything shaped like a GitHub token from text that is about to go into a message. */
function withoutTokens(text: string): string {
  return text.replace(/\b(gh[opsu]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)/g, '[token]').trim()
}

/** `gh auth token`: one call's token, or a named error built from the exit code and stderr only. */
export async function ghToken(run: GhRun = liveGh, signal?: AbortSignal): Promise<string> {
  const result = await run(['auth', 'token', '--hostname', HOST], { signal })
  if ('missing' in result) throw new Error('gh is not installed — install the GitHub CLI and run `gh auth login`')
  if (result.code !== 0) {
    throw new Error(`gh auth token exited ${result.code}: ${withoutTokens(result.stderr) || 'no output'}`)
  }
  const token = result.stdout.trim()
  if (token === '') throw new Error('gh answered no token — run `gh auth login`')
  return token
}

export type GhStatus =
  | { ok: true; login: string; scopes: string[] }
  | { ok: false; reason: 'missing' | 'signed-out' | 'no-account' | 'too-old' | 'unparsed'; detail: string }

interface HostEntry {
  state?: string
  active?: boolean
  login?: string
  scopes?: string
}

/** `gh auth status --json hosts`, as a value rather than a throw: a caller renders the reason. */
export async function ghStatus(run: GhRun = liveGh, signal?: AbortSignal): Promise<GhStatus> {
  const result = await run(['auth', 'status', '--hostname', HOST, '--json', 'hosts'], { signal })
  if ('missing' in result) return { ok: false, reason: 'missing', detail: 'gh is not installed' }
  // A signed-out host may exit non-zero and still print JSON, so the code is not read first.
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    const stderr = withoutTokens(result.stderr)
    if (/unknown flag/i.test(stderr)) {
      return {
        ok: false,
        reason: 'too-old',
        detail: `gh is too old for \`auth status --json\`; ${GH_MIN_VERSION} or later is needed`,
      }
    }
    return {
      ok: false,
      reason: 'unparsed',
      detail: `gh auth status gave no JSON (exit ${result.code})${stderr === '' ? '' : `: ${stderr}`}`,
    }
  }
  const hosts = (parsed as { hosts?: Record<string, HostEntry[]> } | null)?.hosts?.[HOST]
  const entries = Array.isArray(hosts) ? hosts : []
  const active = entries.find((entry) => entry.active === true)
  if (active === undefined) {
    return { ok: false, reason: 'no-account', detail: `gh has no ${HOST} account — run \`gh auth login\`` }
  }
  if (active.state !== 'success' || typeof active.login !== 'string') {
    return { ok: false, reason: 'signed-out', detail: `gh is signed out of ${HOST} — run \`gh auth login\`` }
  }
  const scopes = (active.scopes ?? '')
    .split(',')
    .map((scope) => scope.trim())
    .filter((scope) => scope !== '')
  return { ok: true, login: active.login, scopes }
}

/**
 * The sentence for a signed-in login that lacks `repo` or `workflow`, or null when it has both.
 * Shared by `lingtai doctor` and `lingtai add`, so the fix is worded once.
 */
export function ghScopeGap(status: Extract<GhStatus, { ok: true }>): string | null {
  const missing = ['repo', 'workflow'].filter((scope) => !status.scopes.includes(scope))
  if (missing.length === 0) return null
  return (
    `gh is signed in as ${status.login} without ${missing.join(' and ')} — run ` +
    `\`gh auth refresh --hostname github.com --scopes ${missing.join(',')}\``
  )
}
