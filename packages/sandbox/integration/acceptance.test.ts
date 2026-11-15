/**
 * 0.14.0's acceptance check: the real srt, the real filesystem and the real network, wrapped the way the conductor
 * wraps a run (`Sandbox.wrap`, then a spawn with the returned argv and env and `shell: false`).
 *
 * The secrets are planted under a **fake** HOME and state directory made for this file, so the check never reads
 * the machine's own keys: what it proves is that the policy built from a host's facts refuses those paths, whatever
 * HOME is. Network cases need the internet and are integration by 0060 §1 on two counts.
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

import { Host, isTelemetryHost, Sandbox, type HostFacts, type WrapInput } from '@lingtai/sandbox'
import { SandboxFsLive, SrtLive } from '@lingtai/sandbox/live'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { SandboxLayer } from '../src/sandbox.ts'

const SECRET = 'lingtai-acceptance-secret'
const supported = process.platform === 'darwin' || process.platform === 'linux'

interface Ran {
  readonly code: number | null
  readonly out: string
  readonly err: string
}

const run = (argv: readonly string[], env: Readonly<Record<string, string>>): Promise<Ran> =>
  new Promise((resolve, reject) => {
    const [cmd, ...args] = argv
    const child = spawn(cmd!, args, { env: { ...env }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, out, err }))
  })

describe.skipIf(!supported)('0.14.0 acceptance: a wrapped run', { timeout: 60_000 }, () => {
  let root: string
  let host: HostFacts
  let worktree: string
  let mirror: string
  let runtime: ManagedRuntime.ManagedRuntime<Sandbox, never>
  let sandbox: Sandbox['Service']

  const secrets: Record<string, string> = {}

  beforeAll(async () => {
    // Not under the temp directory: `/tmp` is writable to every run, so a fake HOME there would be too (Linux).
    root = await realpath(await mkdtemp(join(homedir(), '.lingtai-acceptance-')))
    const home = join(root, 'home')
    const state = join(home, '.lingtai')
    worktree = join(root, 'worktree')
    mirror = join(state, 'repos', 'acceptance.git')
    await mkdir(worktree, { recursive: true })
    await mkdir(join(mirror, 'objects'), { recursive: true })
    await mkdir(join(mirror, 'hooks'), { recursive: true })
    await writeFile(join(mirror, 'config'), '[core]\n')

    // One planted secret per built-in deny, each holding SECRET.
    const planted = {
      ssh: '.ssh/id_ed25519',
      aws: '.aws/credentials',
      gh: '.config/gh/hosts.yml',
      gnupg: '.gnupg/private-keys-v1.d/key',
      netrc: '.netrc',
      docker: '.docker/config.json',
      kube: '.kube/config',
      npmrc: '.npmrc',
      lingtaiConfig: '.lingtai/config.yml',
      lingtaiBackup: '.lingtai/config.yml.bak',
      claudeCredentials: '.claude/.credentials.json',
      ...(process.platform === 'darwin' ? { keychain: 'Library/Keychains/login.keychain-db' } : {}),
    }
    for (const [name, rel] of Object.entries(planted)) {
      const path = join(home, rel)
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, SECRET)
      secrets[name] = path
    }
    secrets['projectDeny'] = join(home, 'project-private', 'notes.txt')
    await mkdir(join(home, 'project-private'), { recursive: true })
    await writeFile(secrets['projectDeny'], SECRET)

    const tmp = await mkdtemp(join(root, 'tmp-'))
    const path = (process.env['PATH'] ?? '').split(delimiter).filter((p) => p.startsWith('/'))
    host = {
      platform: process.platform,
      home,
      tmpdir: tmp,
      tmpdirReal: undefined,
      stateDir: state,
      pnpmHome: undefined,
      pathRaw: path.join(delimiter),
      path,
    }

    runtime = ManagedRuntime.make(
      SandboxLayer.pipe(Layer.provide(Layer.mergeAll(SrtLive, SandboxFsLive, Layer.succeed(Host, host)))),
    )
    sandbox = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* Sandbox
      }),
    )
  })

  afterAll(async () => {
    if (runtime) await runtime.dispose()
    if (root) await rm(root, { recursive: true, force: true })
  })

  /** Wraps `sh -c script` as a run of project `acceptance`, runs it, and reads its refused connections. */
  const wrapped = (script: string, extra: Pick<WrapInput, 'project_additions' | 'caller_additions'> = {}) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const w = yield* sandbox.wrap({
            project: 'acceptance',
            worktree,
            mirror,
            command: ['/bin/sh', '-c', script],
            env: { PATH: host.path.join(delimiter), HOME: host.home, TMPDIR: host.tmpdir },
            ...extra,
          })
          const ran = yield* Effect.promise(() => run(w.argv, w.env))
          const refused = yield* sandbox.refusedConnections(w)
          return { ...ran, refused, env: w.env }
        }),
      ),
    )

  it('the host can sandbox', async () => {
    await expect(Effect.runPromise(sandbox.hostCanSandbox)).resolves.toBeUndefined()
  })

  describe('files', () => {
    it('control: the same reads succeed unwrapped, so a refusal below is the sandbox', async () => {
      for (const [name, path] of Object.entries(secrets)) {
        const r = await run(['/bin/sh', '-c', `cat '${path}'`], { PATH: host.path.join(delimiter) })
        expect(r.out, `${name} was not planted`).toContain(SECRET)
      }
    })

    it('cannot read any built-in secret', async () => {
      for (const [name, path] of Object.entries(secrets)) {
        if (name === 'projectDeny') continue
        const r = await wrapped(`cat '${path}'`)
        expect(r.out, `${name} (${path}) was readable`).not.toContain(SECRET)
        expect(r.code, `${name} exited 0`).not.toBe(0)
      }
    })

    it("cannot read a path the project's recipe denies", async () => {
      const r = await wrapped(`cat '${secrets['projectDeny']}'`, {
        project_additions: { deny: [join(host.home, 'project-private')] },
      })
      expect(r.out).not.toContain(SECRET)
      expect(r.code).not.toBe(0)
    })

    it('reads and writes its worktree and temp directory', async () => {
      const r = await wrapped(
        `echo ok > '${join(worktree, 'made.txt')}' && echo ok > '${join(host.tmpdir, 'made.txt')}' && cat '${join(worktree, 'made.txt')}'`,
      )
      expect(r.code, r.err).toBe(0)
      expect(await readFile(join(worktree, 'made.txt'), 'utf8')).toBe('ok\n')
    })

    it('cannot write outside the worktree, the mirror, temp and its cache', async () => {
      const outside = join(host.home, 'planted-by-run.txt')
      const r = await wrapped(`echo x > '${outside}'`)
      expect(r.code).not.toBe(0)
      await expect(readFile(outside, 'utf8')).rejects.toThrow()
    })

    it("cannot write the mirror's config or hooks, but can write its objects", async () => {
      const cfg = await wrapped(`echo '[core] hooksPath = /tmp/x' >> '${join(mirror, 'config')}'`)
      expect(cfg.code).not.toBe(0)
      expect(await readFile(join(mirror, 'config'), 'utf8')).toBe('[core]\n')
      const hook = await wrapped(`echo x > '${join(mirror, 'hooks', 'pre-commit')}'`)
      expect(hook.code).not.toBe(0)
      const obj = await wrapped(`echo x > '${join(mirror, 'objects', 'probe')}'`)
      expect(obj.code, obj.err).toBe(0)
    })
  })

  describe('a runtime home (decision 6)', () => {
    it('keeps a read-only file inside a writable home read-only', async () => {
      const codexHome = join(root, 'codex-home')
      await mkdir(codexHome, { recursive: true })
      await writeFile(join(codexHome, 'config.toml'), 'model = "x"\n')
      const r = await wrapped(
        `cat '${join(codexHome, 'config.toml')}' && echo s > '${join(codexHome, 'session.json')}' && echo y >> '${join(codexHome, 'config.toml')}'`,
        { caller_additions: { write: [codexHome], read: [join(codexHome, 'config.toml')] } },
      )
      expect(r.out).toContain('model = "x"')
      expect(await readFile(join(codexHome, 'session.json'), 'utf8')).toBe('s\n')
      expect(r.code).not.toBe(0)
      expect(await readFile(join(codexHome, 'config.toml'), 'utf8')).toBe('model = "x"\n')
    })
  })

  describe('environment', () => {
    it("carries the caller's env and the policy's variables, never the daemon's", async () => {
      const before = process.env['LINGTAI_DATABASE_URL']
      process.env['LINGTAI_DATABASE_URL'] = 'postgres://acceptance-must-not-leak'
      try {
        const r = await wrapped('env')
        expect(r.out).not.toContain('acceptance-must-not-leak')
        expect(r.out).toContain('DO_NOT_TRACK=1')
      } finally {
        if (before === undefined) delete process.env['LINGTAI_DATABASE_URL']
        else process.env['LINGTAI_DATABASE_URL'] = before
      }
    })
  })

  describe('network', () => {
    const curl = (url: string) => `curl -sS -o /dev/null -w '%{http_code}' --max-time 20 '${url}'`

    it('control: example.com is reachable unwrapped', async () => {
      const r = await run(['/bin/sh', '-c', curl('https://example.com/')], { PATH: host.path.join(delimiter) })
      expect(r.code, r.err).toBe(0)
    })

    it('reaches an allowlisted host', async () => {
      const r = await wrapped(curl('https://api.anthropic.com/'))
      expect(r.code, r.err).toBe(0)
      expect(r.out).toMatch(/^[1-5]\d\d$/)
    })

    it('is refused any other host, and the refusal is recorded for this run', async () => {
      const r = await wrapped(curl('https://example.com/'))
      expect(r.code).not.toBe(0)
      expect(r.refused.kind).toBe('entries')
      if (r.refused.kind === 'entries') {
        expect(JSON.stringify(r.refused.entries)).toContain('example.com')
      }
    })

    it('reaches a host the project adds', async () => {
      const r = await wrapped(curl('https://example.com/'), { project_additions: { network: ['example.com'] } })
      expect(r.code, r.err).toBe(0)
    })

    it('refuses telemetry, which the board leaves off its list', async () => {
      const r = await wrapped(curl('https://sentry.io/'))
      expect(r.code).not.toBe(0)
      expect(isTelemetryHost('sentry.io')).toBe(true)
    })
  })
})
