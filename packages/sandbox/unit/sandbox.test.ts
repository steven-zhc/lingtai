import { SandboxBoundaryRecorded, SandboxConnectionsRefused, SandboxPolicyValue } from '@lingtai/domain'
/** #1146. Every test hands in a fake `Srt`, a fake `SandboxFs` and a `HostFacts` of strings: no srt, no process, no disk. */
import { Deferred, Effect, Exit, Fiber, Layer, type Scope } from 'effect'
import { TestClock } from 'effect/testing'
import { describe, expect, it } from 'vitest'

import pkg from '../package.json' with { type: 'json' }
import {
  BUILT_IN_DOMAINS,
  Host,
  Sandbox,
  SandboxFs,
  SandboxLayer,
  SandboxPolicyRefused,
  SandboxUnavailable,
  SandboxWrapFailed,
  Srt,
  SRT_VERSION,
  parseViolationLine,
  isTelemetryHost,
  resolvedPolicy,
  worthRecording,
  customConfigFor,
  quoteArgv,
  refuseProtected,
  type HostFacts,
  type SrtPort,
  type WrapInput,
} from '../src/index.ts'

const hostFor = (platform: string, root = '/t/root'): HostFacts => ({
  platform,
  home: `${root}/home`,
  tmpdir: platform === 'darwin' ? `${root}/var/folders/x/T` : `${root}/tmp-x`,
  tmpdirReal: platform === 'darwin' ? `${root}/private/var/folders/x/T` : undefined,
  stateDir: `${root}/home/.lingtai`,
  pnpmHome: `${root}/home/pnpm`,
  path: [`${root}/usr/bin`, `${root}/opt/node/bin`],
})

interface Fake {
  readonly srt: SrtPort
  readonly calls: string[]
  readonly init: unknown[]
  readonly wraps: { command: string; config: any; commandId: string }[]
  readonly registered: { id: string; lists: any }[]
  readonly dirs: string[]
  checkResult: { warnings: string[]; errors: string[] }
  failInit: boolean
  failWrap: boolean
  violations: Record<string, { line: string; timestamp: Date }[]>
  total: number[]
  failViolations: boolean
  release?: Deferred.Deferred<void>
}

const fake = (): Fake => {
  const f: Fake = {
    calls: [],
    init: [],
    wraps: [],
    registered: [],
    dirs: [],
    checkResult: { warnings: [], errors: [] },
    failInit: false,
    failWrap: false,
    violations: {},
    total: [0],
    failViolations: false,
    srt: undefined as never,
  }
  const log = <A>(name: string, a: A) => Effect.sync(() => (f.calls.push(name), a))
  ;(f as { srt: SrtPort }).srt = {
    initialize: (config) =>
      Effect.gen(function* () {
        f.calls.push('initialize')
        f.init.push(config)
        if (f.release) yield* Deferred.await(f.release)
        if (f.failInit) return yield* Effect.fail(new Error('init boom'))
      }),
    isSupportedPlatform: log('isSupportedPlatform', true),
    checkDependencies: Effect.sync(() => (f.calls.push('checkDependencies'), f.checkResult)),
    registerCommandNetworkLists: (id, lists) =>
      Effect.sync(() => (f.calls.push('register'), f.registered.push({ id, lists }))),
    unregisterCommandNetworkLists: (id) => Effect.sync(() => f.calls.push(`unregister:${id}`)).pipe(Effect.asVoid),
    wrapWithSandboxArgv: (command, config, options) =>
      Effect.gen(function* () {
        f.calls.push('wrap')
        if (f.failWrap) return yield* Effect.fail(new Error('wrap boom'))
        f.wraps.push({ command, config, commandId: options.commandId })
        // What the real srt would hand back as `env`: never surfaced by the port, asserted absent below.
        return { argv: ['/bin/bash', '-c', `WRAPPED(${command})`], env: { LINGTAI_DATABASE_URL: 'x' } }
      }),
    violationsFor: (id) =>
      f.failViolations ? Effect.fail(new Error('/tmp/secret boom')) : Effect.sync(() => f.violations[id] ?? []),
    violationTotal: Effect.sync(() => (f.total.length > 1 ? f.total.shift()! : f.total[0]!)),
    cleanupAfterCommand: log('cleanup', undefined).pipe(Effect.asVoid),
    reset: log('reset', undefined).pipe(Effect.asVoid),
  }
  return f
}

const layerFor = (f: Fake, host: HostFacts) =>
  SandboxLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Srt, f.srt),
        Layer.succeed(Host, host),
        Layer.succeed(SandboxFs, {
          ensureDir: (p: string) => Effect.sync(() => (f.calls.push('mkdir'), f.dirs.push(p))),
        }),
      ),
    ),
  )

const inputFor = (host: HostFacts, over: Partial<WrapInput> = {}): WrapInput => ({
  project: 'proj',
  worktree: `${host.stateDir}/worktrees/proj/r1`,
  mirror: `${host.stateDir}/repos/proj.git`,
  command: ['echo', 'hi'],
  env: { PATH: '/bin', HOME: '/h' },
  ...over,
})

const run = <A, E>(f: Fake, host: HostFacts, body: (s: typeof Sandbox.Service) => Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        return yield* body(yield* Sandbox)
      }),
    ).pipe(Effect.provide(layerFor(f, host))),
  )

describe.each(['linux', 'darwin'])('policy on %s', (platform) => {
  const host = hostFor(platform)

  it('hands the port the whole customConfig', async () => {
    const f = fake()
    const input = inputFor(host)
    await run(f, host, (s) => s.wrap(input))
    const fs = f.wraps[0]!.config.filesystem
    const h = host.home
    const deny = [
      `${h}/.ssh`,
      `${h}/.aws`,
      `${h}/.config/gh`,
      `${h}/.gnupg`,
      `${h}/.netrc`,
      `${h}/.docker/config.json`,
      `${h}/.kube`,
      `${h}/.npmrc`,
      host.stateDir,
      `${h}/.claude/.credentials.json`,
    ]
    expect(fs.denyRead).toEqual([
      ...deny,
      ...(platform === 'darwin' ? [`${h}/Library/Keychains`] : ['/var/run/docker.sock']),
    ])
    const cache = `${host.stateDir}/cache/proj`
    expect(fs.allowRead).toEqual([input.worktree, input.mirror, cache])
    expect(fs.allowWrite).toEqual(expect.arrayContaining([input.worktree, input.mirror, cache, '/tmp', host.tmpdir]))
    if (platform === 'darwin') expect(fs.allowWrite).toEqual(expect.arrayContaining(['/private/tmp', host.tmpdirReal]))
    expect(fs.denyWrite).toEqual(
      expect.arrayContaining([
        `${input.mirror}/config`,
        `${input.mirror}/hooks`,
        `${input.mirror}/info`,
        `${host.tmpdir}/lingtai`,
      ]),
    )
    if (platform === 'darwin') expect(fs.denyWrite).toContain(`${host.tmpdirReal}/lingtai`)
    // Instance-only settings are never in a command's customConfig.
    expect(JSON.stringify(f.wraps[0]!.config)).not.toMatch(
      /allowUnixSockets|allowAllUnixSockets|enableWeakerNetworkIsolation/,
    )
  })

  it('initialises once across concurrent first wraps, with only the built-ins', async () => {
    const f = fake()
    f.release = Effect.runSync(Deferred.make<void>())
    const release = f.release
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const s = yield* Sandbox
          const all = yield* Effect.all(
            [1, 2, 3].map((n) =>
              s.wrap(inputFor(host, { project: `p${n}`, project_additions: { network: [`p${n}.example.com`] } })),
            ),
            { concurrency: 'unbounded' },
          ).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(all)
        }),
      ).pipe(Effect.provide(layerFor(f, host))),
    )
    expect(f.init).toHaveLength(1)
    const cfg = f.init[0] as any
    expect(cfg.network.allowedDomains).toEqual([...BUILT_IN_DOMAINS])
    expect(cfg.network.allowedDomains.join()).not.toMatch(/sentry|example\.com/)
    expect(cfg.network.strictAllowlist).toBeUndefined()
    if (platform === 'linux') {
      expect(cfg.network.allowAllUnixSockets).toBe(true)
      expect(cfg.enableWeakerNetworkIsolation).toBeUndefined()
    } else {
      expect(cfg.network.allowUnixSockets).toEqual([`${host.tmpdir}/lingtai`])
      expect(cfg.enableWeakerNetworkIsolation).toBe(true)
    }
    expect(f.registered.map((r) => r.lists.allowedDomains)).toHaveLength(3)
  })
})

describe('wrap', () => {
  const host = hostFor('linux')

  it('creates the cache before the port wraps, and resets on close', async () => {
    const f = fake()
    await run(f, host, (s) => s.wrap(inputFor(host)))
    expect(f.dirs).toEqual([`${host.stateDir}/cache/proj`])
    expect(f.calls.indexOf('mkdir')).toBeLessThan(f.calls.indexOf('wrap'))
    expect(f.calls.at(-1)).toBe('reset')
  })

  it('registers under a fresh 22+ char id before the wrap and unregisters on close', async () => {
    const f = fake()
    const ids: string[] = []
    for (let i = 0; i < 2; i++) {
      const w = await run(f, host, (s) => s.wrap(inputFor(host, { project_additions: { network: ['x.example.com'] } })))
      ids.push(w.commandId)
    }
    expect(ids[0]).not.toBe(ids[1])
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{22,}$/)
      expect(f.calls).toContain(`unregister:${id}`)
    }
    expect(f.registered[0]!.lists).toEqual({ allowedDomains: ['x.example.com'] })
    expect(f.calls.indexOf('register')).toBeLessThan(f.calls.indexOf('wrap'))
    expect(f.wraps[0]!.commandId).toBe(ids[0])
  })

  it('unregisters when the wrap fails, and owes no cleanup', async () => {
    const f = fake()
    f.failWrap = true
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          return yield* (yield* Sandbox).wrap(inputFor(host))
        }),
      ).pipe(Effect.provide(layerFor(f, host))),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain('SandboxWrapFailed')
    expect(f.calls.some((c) => c.startsWith('unregister:'))).toBe(true)
    expect(f.calls).not.toContain('cleanup')
    expect(f.registered).toHaveLength(1)
  })

  it('calls cleanupAfterCommand once per successful wrap, at scope close', async () => {
    const f = fake()
    await run(f, host, (s) =>
      Effect.gen(function* () {
        yield* s.wrap(inputFor(host))
        expect(f.calls).not.toContain('cleanup')
      }),
    )
    expect(f.calls.filter((c) => c === 'cleanup')).toHaveLength(1)
  })

  it('returns the caller env plus policy variables and never srt’s env', async () => {
    const f = fake()
    const w = await run(f, host, (s) => s.wrap(inputFor(host)))
    const cache = `${host.stateDir}/cache/proj`
    expect(w.env).toEqual({
      PATH: '/bin',
      HOME: '/h',
      XDG_CACHE_HOME: `${cache}/xdg-cache`,
      XDG_DATA_HOME: `${cache}/xdg-data`,
      npm_config_store_dir: `${cache}/pnpm-store`,
      npm_config_cache: `${cache}/npm`,
      PIP_CACHE_DIR: `${cache}/pip`,
      DO_NOT_TRACK: '1',
      NEXT_TELEMETRY_DISABLED: '1',
    })
    expect(w.env).not.toHaveProperty('LINGTAI_DATABASE_URL')
    expect(w.argv[0]).toBe('/bin/bash')
  })

  it('accepts a caller addition under stateDir or ~/.codex and refuses the same as a project write', async () => {
    const f = fake()
    const paths = [`${host.stateDir}/runs/r1/claude`, `${host.home}/.codex`]
    const w = await run(f, host, (s) => s.wrap(inputFor(host, { caller_additions: { write: paths } })))
    expect(w.argv).toBeDefined()
    expect(f.wraps[0]!.config.filesystem.allowWrite).toEqual(expect.arrayContaining(paths))
    expect(f.wraps[0]!.config.filesystem.allowRead).toEqual(expect.arrayContaining(paths))
    for (const p of paths) {
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            return yield* (yield* Sandbox).wrap(inputFor(host, { project_additions: { write: [p] } }))
          }),
        ).pipe(Effect.provide(layerFor(fake(), host))),
      )
      expect(JSON.stringify(exit)).toContain('SandboxPolicyRefused')
    }
  })

  it('hands the port one string that bash -c splits back into the same argv', async () => {
    const f = fake()
    const command = ['/bin/echo', 'a b', "it's", '"q"', '$HOME `x`', '', 'back\\slash', "'"]
    await run(f, host, (s) => s.wrap(inputFor(host, { command })))
    expect(f.wraps[0]!.command).toBe(quoteArgv(command))
    expect(splitPosix(f.wraps[0]!.command)).toEqual(command)
  })
})

/** Just enough of sh's word splitting to read what `quoteArgv` writes: single quotes and backslash-escapes. */
const splitPosix = (s: string): string[] => {
  const out: string[] = []
  let cur: string | undefined
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (c === "'") {
      const end = s.indexOf("'", i + 1)
      cur = (cur ?? '') + s.slice(i + 1, end)
      i = end
    } else if (c === '\\') {
      cur = (cur ?? '') + s[++i]
    } else if (c === ' ') {
      if (cur !== undefined) out.push(cur)
      cur = undefined
    } else cur = (cur ?? '') + c
  }
  if (cur !== undefined) out.push(cur)
  return out
}

describe('hostCanSandbox and the failures', () => {
  const host = hostFor('linux')

  it('asks the port once within a minute and again after it', async () => {
    const f = fake()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const s = yield* Sandbox
          yield* s.hostCanSandbox
          yield* s.hostCanSandbox
          expect(f.calls.filter((c) => c === 'checkDependencies')).toHaveLength(1)
          yield* TestClock.adjust('61 seconds')
          yield* s.hostCanSandbox
          expect(f.calls.filter((c) => c === 'checkDependencies')).toHaveLength(2)
        }),
      ).pipe(Effect.provide(layerFor(f, host)), Effect.provide(TestClock.layer())),
    )
  })

  const failure = async (f: Fake, h: HostFacts) => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          return yield* (yield* Sandbox).wrap(inputFor(h))
        }),
      ).pipe(Effect.provide(layerFor(f, h))),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    return JSON.stringify(exit)
  }

  it('checkDependencies errors fail with srt’s own sentence and no argv', async () => {
    const f = fake()
    f.checkResult = { warnings: [], errors: ['bubblewrap (bwrap) not installed'] }
    const out = await failure(f, host)
    expect(out).toContain('SandboxUnavailable')
    expect(out).toContain('bubblewrap (bwrap) not installed')
    expect(f.calls).not.toContain('wrap')
  })

  it('a throwing initialize is SandboxUnavailable', async () => {
    const f = fake()
    f.failInit = true
    const out = await failure(f, host)
    expect(out).toContain('SandboxUnavailable')
    expect(out).toContain('init boom')
    expect(f.calls).not.toContain('wrap')
  })

  it('an unsupported platform is SandboxUnavailable even though srt says supported', async () => {
    const f = fake()
    const out = await failure(f, hostFor('win32'))
    expect(out).toContain('SandboxUnavailable')
    expect(f.calls).not.toContain('wrap')
  })

  it('a relative HOME is refused by name', async () => {
    const f = fake()
    const out = await failure(f, { ...host, home: 'home' })
    expect(out).toContain('HOME')
    expect(f.calls).not.toContain('wrap')
  })
})

describe('refuseProtected', () => {
  const host = hostFor('darwin')
  const mirror = `${host.stateDir}/repos/proj.git`
  const h = host.home
  const cases: [string, string][] = [
    ['deny-list', `${h}/.ssh`],
    ['deny-list', `${h}/.ssh/keys`],
    ['deny-list', `${h}/.docker`],
    ['deny-list', `${h}/Library/Keychains`],
    ['state-dir', host.stateDir],
    ['state-dir', `${host.stateDir}/config.yml`],
    ['mirror', `${mirror}/refs`],
    ['runtime-config', `${h}/.claude`],
    ['runtime-config', `${h}/.claude.json`],
    ['runtime-config', `${h}/.codex/auth.json`],
    ['host-tool', `${h}/.cache`],
    ['host-tool', `${h}/.local/bin`],
    ['host-tool', `${h}/pnpm`],
    ['host-tool', `${h}/Library/Caches`],
    ['path', `${host.path[0]}`],
    ['path', `${host.path[1]}/node`],
    ['home', h],
    ['home', '/'],
    ['home', '/t'],
  ]
  it.each(cases)('refuses %s: %s', (kind, path) => {
    expect(refuseProtected([path], host, { mirror }).map((r) => r.kind)).toContain(kind)
  })

  it('names the relation, matches by segment, and lets a write inside $HOME through', () => {
    expect(refuseProtected([`${h}/.sshx`], host, { mirror })).toEqual([])
    expect(refuseProtected([`${h}/work/out`], host, { mirror })).toEqual([])
    expect(refuseProtected([`${h}/.ssh/../.ssh`], host, { mirror })[0]?.relation).toBe('is')
    expect(refuseProtected(['/t'], host, { mirror }).every((r) => r.relation === 'contains')).toBe(true)
    // srt reads a path as a glob: `/**` and friends reach everything under the static prefix.
    for (const g of [`${h}/**`, `${h}/*`, `${h}/.l*`, `${h}/{a,.local}/x`, `${h}/.local/**`, '/**'])
      expect(refuseProtected([g], host, { mirror }).length).toBeGreaterThan(0)
    expect(refuseProtected([`${h}/work/**`], host, { mirror })).toEqual([])
    expect(refuseProtected(['rel/path'], host, { mirror })[0]?.relation).toBe('relative')
  })

  it('is raised by wrap as SandboxPolicyRefused for deny too', async () => {
    const f = fake()
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          return yield* (yield* Sandbox).wrap(inputFor(host, { project_additions: { deny: ['/'] } }))
        }),
      ).pipe(Effect.provide(layerFor(f, host))),
    )
    expect(JSON.stringify(exit)).toContain('SandboxPolicyRefused')
    expect(f.calls).not.toContain('wrap')
  })
})

void SandboxPolicyRefused
void SandboxUnavailable
void SandboxWrapFailed

describe('caller read and denyWrite (#1150)', () => {
  const host: HostFacts = {
    platform: 'darwin',
    home: '/Users/me',
    tmpdir: '/var/folders/x/T',
    stateDir: '/Users/me/.lingtai',
    path: [],
  }
  const input = {
    project: 'p',
    worktree: '/work/p',
    mirror: '/Users/me/.lingtai/repos/p.git',
    caller_additions: {
      write: ['/Users/me/.lingtai/runs/r/claude'],
      read: ['/Users/me/.lingtai/runs/r/claude/CLAUDE.md', '/bundle/lingtai-hook'],
      denyWrite: ['/only/not/writable'],
    },
  }

  it('read is readable and not writable, even inside a write path', () => {
    const fs = customConfigFor(host, input).filesystem
    expect(fs.allowRead).toContain('/Users/me/.lingtai/runs/r/claude/CLAUDE.md')
    expect(fs.allowRead).toContain('/bundle/lingtai-hook')
    expect(fs.allowWrite).toContain('/Users/me/.lingtai/runs/r/claude')
    expect(fs.allowWrite).not.toContain('/Users/me/.lingtai/runs/r/claude/CLAUDE.md')
    expect(fs.denyWrite).toContain('/Users/me/.lingtai/runs/r/claude/CLAUDE.md')
    expect(fs.denyWrite).toContain('/bundle/lingtai-hook')
  })

  it('denyWrite goes on denyWrite only', () => {
    const fs = customConfigFor(host, input).filesystem
    expect(fs.denyWrite).toContain('/only/not/writable')
    expect(fs.allowRead).not.toContain('/only/not/writable')
    expect(fs.denyRead).not.toContain('/only/not/writable')
  })

  it('platform.claude.com is not on the built-in allowlist', () => {
    expect(BUILT_IN_DOMAINS).not.toContain('platform.claude.com')
  })
})

const v = (line: string, iso = '2026-11-13T10:00:00.000Z') => ({ line, timestamp: new Date(iso) })

describe('refused connections (#1156)', () => {
  const host = hostFor('linux')
  const refusedOnce = 'deny network-outbound example.com:443 (host is not on the allow list)'

  const read = async (f: Fake) =>
    run(f, host, (s) =>
      Effect.gen(function* () {
        const w = yield* s.wrap(inputFor(host))
        f.violations[w.commandId] = f.violations.__next ?? []
        return yield* s.refusedConnections(w)
      }),
    )

  it("returns one invocation's violations grouped by host, counted and marked telemetry", async () => {
    const f = fake()
    f.violations.__next = [
      v(refusedOnce),
      v(refusedOnce, '2026-11-13T09:00:00.000Z'),
      v('deny network-outbound o1.ingest.sentry.io:443 (host is not on the allow list)'),
      v('something srt invented'),
    ]
    f.total = [5, 9]
    const r = await read(f)
    expect(r).toEqual({
      kind: 'entries',
      complete: true,
      entries: [
        { host: 'example.com', port: 443, count: 2, firstAt: '2026-11-13T09:00:00.000Z', telemetry: false },
        { host: 'o1.ingest.sentry.io', port: 443, count: 1, firstAt: '2026-11-13T10:00:00.000Z', telemetry: true },
        {
          host: null,
          port: null,
          line: 'something srt invented',
          count: 1,
          firstAt: '2026-11-13T10:00:00.000Z',
          telemetry: false,
        },
      ],
    })
  })

  it("returns nothing for another invocation's id", async () => {
    const f = fake()
    f.violations.other = [v(refusedOnce)]
    const r = await read(f)
    expect(r).toEqual({ kind: 'entries', entries: [], complete: true })
    expect(worthRecording(r)).toBe(false)
  })

  it('says incomplete when the count moved by more than the store holds', async () => {
    const f = fake()
    f.violations.__next = [v(refusedOnce)]
    f.total = [0, 160]
    const r = await read(f)
    expect(r).toMatchObject({ kind: 'entries', complete: false })
    expect(worthRecording(r)).toBe(true)
  })

  it('says incomplete when the count went backwards, and complete at exactly 100', async () => {
    const f = fake()
    f.total = [50, 3]
    expect(await read(f)).toMatchObject({ complete: false })
    const g = fake()
    g.total = [10, 110]
    expect(await read(g)).toMatchObject({ complete: true })
  })

  it('is unreadable, never empty, when the port throws, and does not carry the message', async () => {
    const f = fake()
    f.failViolations = true
    const r = await read(f)
    expect(r).toEqual({ kind: 'unreadable', reason: 'srt violations could not be read' })
    expect(worthRecording(r)).toBe(true)
  })

  it('is unreadable when the count could not be read at wrap, and wrap still succeeds', async () => {
    const f = fake()
    ;(f.srt as { violationTotal: SrtPort['violationTotal'] }).violationTotal = Effect.fail(new Error('no'))
    const r = await read(f)
    expect(r).toMatchObject({ kind: 'unreadable' })
  })

  it('parses a violation line per shape srt 0.0.83 writes, and keeps the rest whole', () => {
    expect(parseViolationLine(refusedOnce)).toEqual({ host: 'example.com', port: 443 })
    expect(parseViolationLine('deny socks-tunnel host.test:8080 (refuseOpaqueTunnels)')).toEqual({
      host: 'host.test',
      port: 8080,
    })
    expect(parseViolationLine('deny http-request GET https://a.test/x?y=1 (blocked)')).toEqual({
      host: 'a.test',
      port: 443,
    })
    expect(parseViolationLine('deny http-request CONNECT a.test:443 (blocked)')).toEqual({ host: null, port: null })
    expect(parseViolationLine('deny network-outbound [::1]:80 (host is not on the allow list)')).toEqual({
      host: '::1',
      port: 80,
    })
    expect(parseViolationLine('deny file-read-data /etc/passwd')).toEqual({ host: null, port: null })
    expect(parseViolationLine('')).toEqual({ host: null, port: null })
  })

  it('matches telemetry hosts as allowedDomains entries are', () => {
    expect(isTelemetryHost('sentry.io')).toBe(true)
    expect(isTelemetryHost('o1.ingest.sentry.io')).toBe(true)
    expect(isTelemetryHost('sentry.io.')).toBe(true)
    expect(isTelemetryHost('o1.ingest.sentry.io.')).toBe(true)
    expect(isTelemetryHost('notsentry.io')).toBe(false)
    expect(isTelemetryHost('sentry.io.evil.test')).toBe(false)
  })

  it('gives the resolved policy from the same functions wrap uses, and parses through the domain schemas', async () => {
    const f = fake()
    const input = inputFor(host, { project_additions: { network: ['x.test'], write: ['/p/w'] } })
    const policy = await run(f, host, (s) => Effect.succeed(s.policyOf(input)))
    expect(policy).toEqual(resolvedPolicy(host, input))
    expect(policy.allowedDomains).toEqual([...BUILT_IN_DOMAINS, 'x.test'])
    expect(policy.allowWrite).toContain('/p/w')
    expect(policy.weakerNetworkIsolation).toBe(false)
    expect(resolvedPolicy(hostFor('darwin'), input).weakerNetworkIsolation).toBe(true)
    expect(SandboxPolicyValue.parse(policy)).toEqual(policy)
    expect(
      SandboxBoundaryRecorded.parse({
        step: 'implement',
        action: 'a',
        runId: null,
        commandId: 'c',
        boundary: { kind: 'sandboxed', srtVersion: SRT_VERSION, policy },
      }),
    ).toBeTruthy()
    const r = await read(Object.assign(fake(), { total: [0, 1] }))
    expect(
      SandboxConnectionsRefused.parse({ step: 'build', action: 'a', runId: null, commandId: 'c', read: r }),
    ).toBeTruthy()
  })

  it('keeps a caller read apart from a denyWrite in the resolved policy', () => {
    const at = (c: object) => resolvedPolicy(host, inputFor(host, { caller_additions: c }))
    const r = at({ read: ['/state/tool'] })
    const d = at({ denyWrite: ['/state/tool'] })
    expect(r.allowRead).toContain('/state/tool')
    expect(d.allowRead).not.toContain('/state/tool')
    expect(r).not.toEqual(d)
  })

  it('pins the srt version package.json pins', () => {
    expect(pkg.dependencies['@anthropic-ai/sandbox-runtime']).toBe(SRT_VERSION)
  })
})
