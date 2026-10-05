/**
 * Whether a runtime is signed in, asked of the runtime itself.
 *
 * Its own file, importing nothing but `node:child_process`, because
 * `lingtai init` asks before there is a log (#186): the package's barrel loads
 * `hook-socket.ts`, which loads `@lingtai/event-store`, whose client is built at
 * module scope and throws without a database URL. So a machine that has only
 * just installed could not ask which agent it has without first saying which
 * database it wants — the order the ticket forbids.
 */
import { spawn } from 'node:child_process'

import { RuntimeId } from '@lingtai/domain'

import type { AuthStatus } from './runtime.ts'

/**
 * `claude auth status`, in the environment a run would actually get.
 *
 * Free — it reads the credential and does not call the API. Verified
 * against both environments: without `USER` it answers
 * `{loggedIn: false, authMethod: "none"}`, with it
 * `{loggedIn: true, authMethod: "claude.ai"}`.
 *
 * **The exit code is 0 either way**, so the field is the answer and the
 * code is not. Reading the code would have made this check pass in exactly
 * the situation it exists to catch.
 */
export function claudeCodeAuth(binary: string, env: Record<string, string>): Promise<AuthStatus> {
  return new Promise<AuthStatus>((resolve) => {
    const child = spawn(binary, ['auth', 'status'], {
      // Cast for a compiler that widens `ProcessEnv` — Next's does, and the
      // board reaches this through `currentRecipe`'s sign-in detection.
      env: env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let out = ''
    let err = ''
    child.stdout.on('data', (c: Buffer) => (out += c.toString()))
    child.stderr.on('data', (c: Buffer) => (err += c.toString()))

    // A hung probe must not hang the doctor.
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ loggedIn: false, method: null, detail: 'claude auth status did not answer in 20s' })
    }, 20_000)

    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ loggedIn: false, method: null, detail: e.message })
    })

    child.on('close', () => {
      clearTimeout(timer)
      // Defensive for the same reason `parseResult` is: a wrapper or a
      // warning can put a line in front of the JSON.
      const brace = out.indexOf('{')
      if (brace < 0) {
        resolve({
          loggedIn: false,
          method: null,
          detail: (err.trim() || out.trim() || 'no output').slice(0, 300),
        })
        return
      }
      try {
        const parsed = JSON.parse(out.slice(brace)) as {
          loggedIn?: boolean
          authMethod?: string
        }
        resolve({
          loggedIn: parsed.loggedIn === true,
          method: parsed.authMethod ?? null,
          detail: parsed.loggedIn === true ? `signed in via ${parsed.authMethod}` : 'not signed in',
        })
      } catch {
        resolve({ loggedIn: false, method: null, detail: out.slice(0, 300) })
      }
    })
  })
}

/**
 * `codex login status`, in the environment a run would get.
 *
 * Real, though the adapter is not: which runtimes are signed in decides
 * whether `runtime.agent` may be detected at all (0046 §3), and a machine
 * signed in to both must be asked rather than handed the one that happened
 * to have a probe. The exit code is the answer — 0 `Logged in using …`,
 * 1 `Not logged in` — and a missing binary is not signed in.
 */
export function codexAuth(binary: string, env: Record<string, string>): Promise<AuthStatus> {
  return new Promise<AuthStatus>((resolve) => {
    const child = spawn(binary, ['login', 'status'], {
      env: env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let out = ''
    child.stdout.on('data', (c: Buffer) => (out += c.toString()))
    child.stderr.on('data', (c: Buffer) => (out += c.toString()))

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ loggedIn: false, method: null, detail: 'codex login status did not answer in 20s' })
    }, 20_000)

    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ loggedIn: false, method: null, detail: e.message })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      const detail = (out.trim() || 'no output').slice(0, 300)
      resolve({ loggedIn: code === 0, method: null, detail })
    })
  })
}

/**
 * Every runtime asked whether it is signed in, **before there is a log**.
 *
 * The second exhaustive table over `RuntimeId`, and the duplication is forced
 * rather than an oversight (`#313`). `RUNTIMES` in `runtimes.ts` is the one place
 * a runtime is *constructed*, and `RUNTIMES[id]().checkAuth` is this same probe —
 * but reaching it loads `claude-code.ts`, which loads `hook-socket.ts` for
 * `observedCall`, which loads `@lingtai/event-store`, whose client is built at
 * module scope and throws without a database URL. That is the whole reason this
 * file exists (see the header), and it is why `lingtai init` cannot ask which
 * agent a machine has by way of the factory table.
 *
 * What the duplication costs is bounded by the type: `Record<RuntimeId, …>` makes
 * a third runtime a `tsc` error **here as well as there**, so the two cannot
 * drift into disagreeing about which runtimes exist. `unit/runtimes.test.ts`
 * asserts both are exhaustive.
 *
 * **Keyed, not zipped.** It was `Promise.all([claudeCodeAuth(…), codexAuth(…)])`
 * indexed positionally against a written-out list of ids, which is one careless
 * insertion away from reporting Codex's answer under Claude Code's name.
 */
export const AUTH_PROBES: Record<RuntimeId, (env: Record<string, string>) => Promise<AuthStatus>> = {
  'claude-code': (env) => claudeCodeAuth('claude', env),
  codex: (env) => codexAuth('codex', env),
}

/** In the enum's own order, so a caller's list is never written by hand. */
export function askEveryRuntime(env: Record<string, string>): Promise<{ id: RuntimeId; status: AuthStatus }[]> {
  return Promise.all(RuntimeId.options.map(async (id) => ({ id, status: await AUTH_PROBES[id](env) })))
}
