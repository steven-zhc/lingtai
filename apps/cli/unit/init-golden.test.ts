/**
 * `lingtai init --local <dir>` with Enter at each question (#1061's tutorial), held to a golden (#1114).
 *
 * `acceptingDefaults` answers every question with its default — an Enter — over a fake world with no TTY, a
 * fixed home and a fixed directory, so the log is the same on every machine. The fixture was captured from
 * `initCommand` on `main` before the conversion, and the run since goes through `initCommandEffect`: same lines,
 * in the same order, and the same exit code. `· <label>` is the fake `spin`, so a step moved out from under its
 * spinner moves a line.
 *
 * It is imported rather than read, because a filesystem read would make this an integration test (0060 §1), and
 * it is a module rather than a file snapshot because `vitest -u` would rewrite the reference this test holds. A
 * ticket that changes `init`'s words on purpose regenerates it, and says so in its diff.
 */
import type { RecipeFiles } from '@lingtai/recipe'
import { Effect } from 'effect'
import { expect, it } from 'vitest'

import type { GitResult } from '../src/first-project.ts'
import { initCommandEffect } from '../src/init.ts'
import { acceptingDefaults } from '../src/question.ts'
import { flagsFromArgv } from '../test/flags.ts'
import { type PromiseInitWorld, liftInitWorld } from '../test/init-world.ts'
import golden from './init-golden.fixture.json'

const ENV = { VITEST: '1', HOME: '/nonexistent', LINGTAI_TEST_SQLITE_PATH: '/nonexistent/log.sqlite' }

const GIT_PLAN: Record<string, GitResult> = {
  '/repo::rev-parse --show-toplevel': { ok: true, stdout: '/repo\n', stderr: '' },
  '/repo::rev-parse --verify refs/heads/lingtai-base^{commit}': { ok: true, stdout: 'abc123f\n', stderr: '' },
  '/repo::rev-parse --verify refs/heads/main^{commit}': { ok: true, stdout: 'abc123f\n', stderr: '' },
}

async function run(): Promise<{ code: number; lines: string[] }> {
  const logged: string[] = []
  const log = (line: string) => logged.push(line)
  const machineFiles = new Map<string, string>()
  const files = new Map<string, string>()
  const answering = acceptingDefaults({
    ask: async () => null,
    log,
    spin: async (label, fn) => {
      log(`· ${label}`)
      return fn()
    },
  })
  const world: PromiseInitWorld = {
    env: ENV,
    machine: {
      read: (path) => machineFiles.get(path) ?? null,
      write: (path, text) => {
        machineFiles.set(path, text)
      },
      describeHome: () => 'nothing yet',
    },
    log,
    ask: answering.ask,
    ...(answering.spin === undefined ? {} : { spin: answering.spin }),
    git: async () => 'git version 2.50.0',
    runtimes: async () => [{ id: 'claude-code', state: 'signed-in', signedIn: true, detail: 'signed in' }],
    // A lockfile at the root, so `detectSetup` suggests an install command: `askInstall` refuses an empty answer
    // outright, and under `acceptingDefaults` a repeated prompt answers null.
    exists: async () => true,
    setupReader: () => ({ has: (path) => Effect.succeed(path === 'pnpm-lock.yaml'), read: () => Effect.succeed(null) }),
    database: async () => ({ ok: true, schema: { created: false, repaired: [] } }),
    ghStatus: async () => ({ ok: false, reason: 'missing', detail: 'gh is not installed' }),
    app: async () => ({ configured: false }),
    appeared: async () => ({ slug: 'lingtai-me', owner: 'me' }),
    pressed: (signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
    boardAt: async () => null,
    board: async () => ({ url: 'http://127.0.0.1:17820' }),
    open: async () => true,
    runGit: async (dir, args) => {
      const found = GIT_PLAN[`${dir}::${args.join(' ')}`]
      if (found === undefined) throw new Error(`unplanned git call: ${dir}::${args.join(' ')}`)
      return found
    },
    projects: async () => [],
    locker: { tryLock: async () => ({ ok: true as const, lock: { release: async () => {} } }) },
    cwd: '/elsewhere',
    files: {
      read: async (p) => files.get(p) ?? null,
      replace: async (p, text) => {
        files.set(p, text)
      },
    } as RecipeFiles,
    signedIn: async () => ['claude-code'] as never[],
    registerLocal: async (payload) => ({ line: `added ${payload.project}`, updated: false }),
    history: async () => [],
    doctor: async () => ({
      report: { ok: 3, notChecked: 0, deferred: 0 },
      toFix: { count: 0, failed: false },
      blocks: 'doctor: 3 ok, 0 not checked here, 0 not implemented yet, 0 failed',
    }),
  }
  const code = await Effect.runPromise(initCommandEffect(flagsFromArgv(['--local', '/repo']), liftInitWorld(world)))
  return { code, lines: logged }
}

it('init --local with Enter at each question prints what it printed before it was an Effect', async () => {
  const { code, lines } = await run()
  expect({ code, lines }).toEqual(golden)
})
