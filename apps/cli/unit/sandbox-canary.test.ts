import { resolvedPolicy, type HostFacts, type SandboxApi, type WrapInput } from '@lingtai/sandbox'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { CANARY_PROJECT, runCanary, type CanaryIo, type CanaryResult } from '../src/sandbox-canary.ts'

const facts: HostFacts = {
  platform: 'linux',
  home: '/home/u',
  tmpdir: '/tmp',
  tmpdirReal: undefined,
  stateDir: '/home/u/.lingtai',
  pnpmHome: undefined,
  path: ['/usr/bin'],
}

type Behaviour = {
  /** What each command does; absent means the answer a sound sandbox gives. */
  readPlanted?: 'refused' | 'readable' | 'readable-exit-1'
  readVisible?: 'ok' | 'fails'
  example?: 'refused' | 'reachable'
  github?: 'ok' | 'fails' | 'times-out'
  wrapFails?: boolean
}

const scenario = (b: Behaviour = {}) => {
  const files = new Map<string, string>()
  const dirs: string[] = []
  const removed: string[] = []
  const wraps: WrapInput[] = []
  let n = 0

  const sandbox: Pick<SandboxApi, 'wrap' | 'policyOf'> = {
    policyOf: (input) => resolvedPolicy(facts, input),
    wrap: (input) =>
      b.wrapFails
        ? Effect.die(new Error('srt threw'))
        : Effect.sync(() => {
            wraps.push(input)
            return { argv: ['wrapped', ...input.command], env: { ...input.env }, commandId: 'id' }
          }),
  }

  const io: CanaryIo = {
    makeDir: (parent, prefix) =>
      Effect.sync(() => {
        const dir = `${parent}/${prefix}${++n}`
        dirs.push(dir)
        return dir
      }),
    write: (path, content) => Effect.sync(() => void files.set(path, content)),
    remove: (path) => Effect.sync(() => void removed.push(path)),
    run: (argv) =>
      Effect.suspend(() => {
        const [, program, target] = argv
        if (program === '/bin/cat') {
          const content = files.get(target!) ?? ''
          const planted = target!.includes('doctor-canary-')
          if (planted) {
            const how = b.readPlanted ?? 'refused'
            if (how === 'readable') return Effect.succeed({ exit: 0, stdout: content })
            if (how === 'readable-exit-1') return Effect.succeed({ exit: 1, stdout: content })
            return Effect.succeed({ exit: 1, stdout: '' })
          }
          return Effect.succeed(b.readVisible === 'fails' ? { exit: 1, stdout: '' } : { exit: 0, stdout: content })
        }
        const url = argv[argv.length - 1]!
        if (url.includes('example.com')) {
          return Effect.succeed({ exit: b.example === 'reachable' ? 0 : 56, stdout: '' })
        }
        if (b.github === 'times-out') return Effect.fail(new Error('timed out'))
        return Effect.succeed({ exit: b.github === 'fails' ? 6 : 0, stdout: '' })
      }),
  }

  return {
    files,
    dirs,
    removed,
    wraps,
    run: (): Effect.Effect<CanaryResult> => runCanary(sandbox, io, Effect.succeed(facts)),
  }
}

const result = (b?: Behaviour) => Effect.runPromise(scenario(b).run())

describe('the sandbox canary judges by running, never by reading (#1159)', () => {
  it('holds only when both negatives are refused and both positives work', async () => {
    expect(await result()).toEqual({ kind: 'held' })
  })

  it('names which negative got through', async () => {
    expect(await result({ readPlanted: 'readable' })).toEqual({ kind: 'leaked', which: ['read'] })
    expect(await result({ example: 'reachable' })).toEqual({ kind: 'leaked', which: ['network'] })
    expect(await result({ readPlanted: 'readable', example: 'reachable' })).toEqual({
      kind: 'leaked',
      which: ['read', 'network'],
    })
  })

  it("counts the planted file's content on stdout as a leak whatever the exit status", async () => {
    expect(await result({ readPlanted: 'readable-exit-1' })).toEqual({ kind: 'leaked', which: ['read'] })
  })

  it('is could-not-run when a positive fails, even though both negatives were refused', async () => {
    for (const b of [{ readVisible: 'fails' }, { github: 'fails' }] as const) {
      const r = await result(b)
      expect(r.kind).toBe('could-not-run')
      expect(r).toMatchObject({ why: expect.stringContaining('could not run') })
    }
  })

  it('is could-not-run on a timeout, and when the wrap throws', async () => {
    expect((await result({ github: 'times-out' })).kind).toBe('could-not-run')
    expect((await result({ wrapFails: true })).kind).toBe('could-not-run')
  })

  it('is could-not-run when the host facts cannot be read', async () => {
    const s = scenario()
    const sandbox = {
      policyOf: () => resolvedPolicy(facts, { project: 'x', worktree: '/w', mirror: '/m' }),
      wrap: () => Effect.die('no'),
    }
    const r = await Effect.runPromise(
      runCanary(
        sandbox,
        {
          makeDir: () => Effect.fail('x'),
          write: () => Effect.void,
          remove: () => Effect.void,
          run: () => Effect.fail('x'),
        },
        Effect.fail('no HOME'),
      ),
    )
    expect(r.kind).toBe('could-not-run')
    expect(s.wraps).toHaveLength(0)
  })
})

describe('what the canary plants and what it removes', () => {
  it('plants the file outside the worktree, the mirror and the cache, under a denied path', async () => {
    const s = scenario()
    await Effect.runPromise(s.run())
    const planted = [...s.files.keys()].find((p) => p.includes('doctor-canary-'))!
    const [first] = s.wraps
    const policy = resolvedPolicy(facts, { project: CANARY_PROJECT, worktree: first!.worktree, mirror: first!.mirror })
    const cache = '/home/u/.lingtai/cache/lingtai-doctor-canary'
    for (const allowed of [first!.worktree, first!.mirror, cache]) {
      expect(planted.startsWith(`${allowed}/`)).toBe(false)
    }
    expect(policy.allowRead.some((a) => planted.startsWith(`${a}/`) || planted === a)).toBe(false)
    expect(planted.startsWith('/home/u/.lingtai/')).toBe(true)
    expect(policy.denyRead).toContain('/home/u/.lingtai')
  })

  it('removes the cache directory and every directory it made, on success and on failure', async () => {
    for (const b of [{}, { github: 'fails' }, { wrapFails: true }] as Behaviour[]) {
      const s = scenario(b)
      await Effect.runPromise(s.run())
      expect(s.removed).toContain('/home/u/.lingtai/cache/lingtai-doctor-canary')
      for (const dir of s.dirs) expect(s.removed).toContain(dir)
      // The cache is cleared before the first wrap, for one a killed doctor left, and again after.
      expect(s.removed.filter((p) => p.endsWith('lingtai-doctor-canary'))).toHaveLength(2)
    }
  })
})

describe('the canary measures the policy a run gets', () => {
  it('only calls wrap, four times, for its own project and with the built-in policy', async () => {
    const s = scenario()
    await Effect.runPromise(s.run())
    expect(s.wraps).toHaveLength(4)
    for (const w of s.wraps) {
      expect(w.project).toBe(CANARY_PROJECT)
      expect(w.project_additions).toBeUndefined()
      expect(w.caller_additions).toBeUndefined()
    }
    expect(s.wraps.map((w) => w.command[0])).toEqual(['/bin/cat', '/bin/cat', 'curl', 'curl'])
    expect(s.wraps[2]!.command.at(-1)).toContain('example.com')
    expect(s.wraps[3]!.command.at(-1)).toContain('github.com')
  })
})
