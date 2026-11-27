/**
 * The terminal's asker for the machine list's GitHub entry (#1522, 0125 §9): what `askGithubAuthEffect`'s tests
 * held before the question moved out of the project path. The entry always asks, defaulting to what is in force.
 */
import type { GhRun, GhStatus } from '@lingtai/github'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'

import { githubEntryFor } from '../src/machine-askers.ts'

const READY: GhStatus = { ok: true, login: 'steven', scopes: ['repo', 'workflow', 'read:org'] }
const SIGNED_OUT: GhStatus = {
  ok: false,
  reason: 'signed-out',
  detail: 'gh is signed out of github.com — run `gh auth login`',
}

function setup(o: {
  answers?: (string | null)[]
  ghStatus: () => Promise<GhStatus>
  gh?: GhRun
  file?: string | null
  interactive?: boolean
  app?: { configured: false } | { configured: true; ok: true; slug: string; owner: string }
  /** `lingtai add`'s: `none` is refused as an answer. */
  required?: boolean
}) {
  const answers = [...(o.answers ?? [])]
  const asked: string[] = []
  const logged: string[] = []
  const written: string[] = []
  let file = o.file ?? null
  const run = (flags: Record<string, string> = {}) =>
    Effect.runPromise(
      githubEntryFor(
        {
          ask: async (prompt, shape) => {
            asked.push(shape?.message ?? prompt)
            return answers.length > 0 ? answers.shift()! : null
          },
          log: (line) => logged.push(line),
          env: {},
          machine: {
            read: () => file,
            write: (_p, text) => {
              file = text
              written.push(String(parseDocument(text).getIn(['github', 'auth'])))
            },
          },
          path: '/h/.lingtai/config.yml',
          interactive: o.interactive ?? true,
          app: () => Effect.succeed(o.app ?? { configured: false }),
          ghStatus: () => Effect.promise(o.ghStatus),
          ...(o.gh === undefined ? {} : { gh: o.gh }),
          recipes: () => Effect.succeed([]),
          run: () => Promise.resolve({ code: 0 }),
        } as never,
        flags,
        'Nothing was written',
        o.required ?? false,
      ),
    )
  return { run, asked, logged, written }
}

describe('the GitHub entry, asked at a terminal', () => {
  it('signed in with both scopes, the default is gh: written, and the prompt says whose name appears', async () => {
    const h = setup({ answers: [''], ghStatus: async () => READY })
    expect(await h.run()).toEqual({ auth: 'gh', pending: false })
    expect(h.written).toEqual(['gh'])
    expect(h.asked).toHaveLength(1)
    expect(h.asked[0]).toContain('signed in as steven')
    expect(h.asked[0]).toContain('labels, comments, pull requests and pushes will appear as that account')
  })

  it('a machine that has github.auth set is asked as well, with it as the default, and the same answer writes nothing', async () => {
    const h = setup({ answers: [''], ghStatus: async () => READY, file: 'github:\n  auth: gh\n' })
    expect(await h.run()).toEqual({ auth: 'gh', pending: false })
    expect(h.asked).toHaveLength(1)
    expect(h.written).toEqual([])
  })

  it('signed out, the default is none, and nothing is written for gh', async () => {
    const h = setup({ answers: [''], ghStatus: async () => SIGNED_OUT })
    expect(await h.run()).toEqual({ auth: 'none', pending: false })
    expect(h.logged.join('\n')).toContain('gh cannot be used yet')
    expect(h.written).toEqual(['none'])
  })

  it('app with no App is pending: it is not written', async () => {
    const h = setup({ answers: ['app'], ghStatus: async () => SIGNED_OUT })
    expect(await h.run()).toEqual({ auth: 'app', pending: true })
    expect(h.written).toEqual([])
  })

  it('signed out, answering gh is refused with the command that fixes it, and nothing is written', async () => {
    const h = setup({ answers: ['gh'], ghStatus: async () => SIGNED_OUT })
    const result = await h.run()
    expect(result).toHaveProperty('refused')
    expect(h.logged.join('\n')).toContain('gh auth login')
    expect(h.written).toEqual([])
  })

  describe('signing gh in from inside the question (#712)', () => {
    const LOGIN_ARGS = ['auth', 'login', '--hostname', 'github.com', '--web', '--scopes', 'workflow']

    function signingIn(before: GhStatus, after: GhStatus, code = 0) {
      const calls: { args: readonly string[]; stdio: string | undefined }[] = []
      let ran = false
      const gh: GhRun = async (args, options) => {
        calls.push({ args, stdio: options?.stdio })
        ran = true
        return { code, stdout: '', stderr: '' }
      }
      return { gh, calls, ghStatus: async () => (ran ? after : before) }
    }

    it('signed out: sign-in runs gh auth login inherited, re-checks, and continues as gh', async () => {
      const s = signingIn(SIGNED_OUT, READY)
      const h = setup({ answers: ['sign-in'], ghStatus: s.ghStatus, gh: s.gh })
      expect(await h.run()).toEqual({ auth: 'gh', pending: false })
      expect(s.calls).toEqual([{ args: LOGIN_ARGS, stdio: 'inherit' }])
      expect(h.written).toEqual(['gh'])
    })

    it('missing a scope: sign-in runs gh auth refresh', async () => {
      const s = signingIn({ ok: true, login: 'steven', scopes: ['repo'] }, READY)
      const h = setup({ answers: ['sign-in'], ghStatus: s.ghStatus, gh: s.gh })
      await h.run()
      expect(s.calls.map((c) => c.args)).toEqual([
        ['auth', 'refresh', '--hostname', 'github.com', '--scopes', 'repo,workflow'],
      ])
      expect(h.written).toEqual(['gh'])
    })

    it('a non-zero exit returns to the choice and writes nothing', async () => {
      const s = signingIn(SIGNED_OUT, SIGNED_OUT, 1)
      const h = setup({ answers: ['sign-in', 'app'], ghStatus: s.ghStatus, gh: s.gh })
      expect(await h.run()).toEqual({ auth: 'app', pending: true })
      expect(s.calls).toHaveLength(1)
      expect(h.logged.join('\n')).toContain('exited 1')
      expect(h.asked).toHaveLength(2)
      expect(h.written).toEqual([])
    })

    it('ignores SIGINT while gh runs and restores the listeners after', async () => {
      const sentinel = () => {}
      process.on('SIGINT', sentinel)
      try {
        const before = process.listeners('SIGINT')
        const seen: number[] = []
        let ran = false
        const gh: GhRun = async () => {
          seen.push(process.listenerCount('SIGINT'))
          ran = true
          return { code: 0, stdout: '', stderr: '' }
        }
        const h = setup({ answers: ['sign-in'], ghStatus: async () => (ran ? READY : SIGNED_OUT), gh })
        await h.run()
        expect(seen).toEqual([before.length + 1])
        expect(process.listeners('SIGINT')).toEqual(before)
      } finally {
        process.off('SIGINT', sentinel)
      }
    })
  })
})

describe('the GitHub entry, answered by a flag or by no terminal', () => {
  it('--github-auth gh is checked: signed out refuses by name and writes nothing', async () => {
    const h = setup({ ghStatus: async () => SIGNED_OUT })
    const result = await h.run({ 'github-auth': 'gh' })
    expect(result).toMatchObject({ refused: expect.stringContaining('gh auth login') })
    expect(h.written).toEqual([])
    expect(h.asked).toEqual([])
  })

  it('--github-auth gh without the workflow scope names the refresh command', async () => {
    const h = setup({ ghStatus: async () => ({ ok: true, login: 'steven', scopes: ['repo'] }) })
    const result = await h.run({ 'github-auth': 'gh' })
    expect(result).toMatchObject({ refused: expect.stringContaining('gh auth refresh') })
  })

  it('--github-auth gh is checked even where github.auth is already gh', async () => {
    const h = setup({ ghStatus: async () => SIGNED_OUT, file: 'github:\n  auth: gh\n' })
    expect(await h.run({ 'github-auth': 'gh' })).toHaveProperty('refused')
  })

  it('--github-auth app is not refused where a gh machine has no App: it is pending, and asks nothing', async () => {
    const h = setup({ ghStatus: async () => READY, file: 'github:\n  auth: gh\n' })
    expect(await h.run({ 'github-auth': 'app' })).toEqual({ auth: 'app', pending: true })
    expect(h.written).toEqual([])
    expect(h.asked).toEqual([])
  })

  it('--github-auth none is refused for a GitHub project, by name, and writes nothing', async () => {
    const h = setup({ ghStatus: async () => READY, required: true })
    expect(await h.run({ 'github-auth': 'none' })).toMatchObject({ refused: expect.stringContaining('none') })
    expect(h.written).toEqual([])
  })

  it('no terminal and no flag takes gh where the login is ready, and refuses none naming --github-auth', async () => {
    const ready = setup({ ghStatus: async () => READY, interactive: false, required: true })
    expect(await ready.run()).toEqual({ auth: 'gh', pending: false })
    const out = setup({ ghStatus: async () => SIGNED_OUT, interactive: false, required: true })
    expect(await out.run()).toMatchObject({ refused: expect.stringContaining('--github-auth') })
    expect(out.asked).toEqual([])
    expect(out.written).toEqual([])
  })
})
