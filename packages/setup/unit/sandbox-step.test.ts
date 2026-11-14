/** The sandbox step's proposal and answers (#1160) — a fake host throughout, never the real check (0060 §1). */
import { LIMIT_DEFAULTS, recipePath, resolveSource } from '@lingtai/recipe'
import { SandboxUnavailable } from '@lingtai/sandbox'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { applySetup } from '../src/apply-setup.ts'
import { needsClaudeToken } from '../src/claude-token.ts'
import { type ProposalReaders, proposeSetup } from '../src/propose-setup.ts'
import { SANDBOX_OFF_LINE, hostsRefusal, parseHosts, sandboxCannotSentence } from '../src/sandbox-step.ts'
import { type SetupForm, refusalOf, setupAnswers, setupChanges } from '../src/setup-answers.ts'

const readers = (host?: ProposalReaders['host']): ProposalReaders => ({
  setupReader: { has: () => Effect.succeed(false), read: () => Effect.succeed(null) },
  defaultBranch: () => Effect.succeed('main'),
  runtimes: () => Effect.succeed([]),
  history: () => Effect.succeed([]),
  origin: () => Effect.succeed(null),
  ...(host === undefined ? {} : { host }),
})
const TARGET = { kind: 'github', owner: 'acme', repo: 'widget' } as const
const INSTALL = { missing: ['bwrap'], command: 'sudo apt install bubblewrap' }
const propose = (host?: ProposalReaders['host']) => Effect.runPromise(proposeSetup(TARGET, readers(host)))

describe('the proposal carries the host', () => {
  it('a host that can: can', async () => {
    const p = await propose({ answer: Effect.void, install: INSTALL, builtIns: ['api.example.com'] })
    expect(p.sandbox).toMatchObject({ verdict: { can: true }, builtIns: ['api.example.com'] })
    expect(sandboxCannotSentence(p.sandbox!)).toBeNull()
  })

  it('a host that cannot: srt’s sentences as srt wrote them, and the install command', async () => {
    const answer = Effect.fail(new SandboxUnavailable({ reason: 'bwrap is missing', sentences: ['no bwrap on PATH'] }))
    const p = await propose({ answer, install: INSTALL, builtIns: [] })
    expect(p.sandbox!.verdict).toEqual({ can: false, reason: 'bwrap is missing', sentences: ['no bwrap on PATH'] })
    const say = sandboxCannotSentence(p.sandbox!)!
    expect(say).toContain('This machine cannot run the sandbox yet: bwrap is missing; no bwrap on PATH')
    expect(say).toContain('Install: sudo apt install bubblewrap')
    expect(say).toContain('The project will run without one until you do.')
  })

  it('a check that dies reads as cannot, and the step is still offered', async () => {
    const p = await propose({ answer: Effect.die(new Error('boom')), install: null, builtIns: [] })
    expect(p.sandbox!.verdict).toMatchObject({ can: false, reason: 'the host check could not be read' })
    expect(sandboxCannotSentence(p.sandbox!)).toContain('This platform cannot run the sandbox')
  })

  it('no host reader: the step is not asked', async () => {
    expect((await propose()).sandbox).toBeNull()
  })
})

describe('the answers write the block', () => {
  const form = (sandbox: SetupForm['sandbox']): SetupForm => ({
    project: 'widget',
    target: TARGET,
    base: 'main',
    remote: null,
    install: '',
    checks: [],
    writer: 'claude-code',
    reviewer: 'none',
    tickets: 'github',
    kinds: ['bug'],
    heldBy: '',
    closeOnEnd: false,
    personApprovesMerge: false,
    limits: { ...LIMIT_DEFAULTS, turns: 300 },
    turnsUnbounded: false,
    sandbox,
  })
  const HOME = '/h/.lingtai'
  const written = async (sandbox: SetupForm['sandbox']) => {
    const store = new Map<string, string>()
    const files = {
      read: async (p: string) => store.get(p) ?? null,
      replace: async (p: string, t: string) => void store.set(p, t),
    }
    await Effect.runPromise(applySetup({ home: HOME, files }, setupAnswers(form(sandbox)), Effect.void))
    const text = store.get(recipePath('widget', HOME))!
    const path = recipePath('widget', HOME)
    const recipe = { recipe: resolveSource(text, path, path).recipe }
    return { text, recipe }
  }

  it('on, no extra hosts: { enabled: true } and no network key', () => {
    const c = setupChanges(form({ enabled: true, allow: [] })).find((x) => x.path[0] === 'sandbox')
    expect(c?.value).toEqual({ enabled: true })
  })

  it('on with hosts: network.allow, and never required', () => {
    const c = setupChanges(form({ enabled: true, allow: ['a.example.com'] })).find((x) => x.path[0] === 'sandbox')
    expect(c?.value).toEqual({ enabled: true, network: { allow: ['a.example.com'] } })
  })

  it('off: { enabled: false }', () => {
    const c = setupChanges(form({ enabled: false, allow: ['ignored.example.com'] })).find(
      (x) => x.path[0] === 'sandbox',
    )
    expect(c?.value).toEqual({ enabled: false })
  })

  it('a recipe already on disk (rewrite) or no answer: no sandbox change', () => {
    expect(setupChanges(form({ enabled: true, allow: [] }), true).some((x) => x.path[0] === 'sandbox')).toBe(false)
    expect(setupChanges(form(null)).some((x) => x.path[0] === 'sandbox')).toBe(false)
  })

  it('reads back through the resolver', async () => {
    const on = await written({ enabled: true, allow: ['a.example.com'] })
    expect(on.text).toContain('sandbox:')
    expect(on.recipe?.recipe.sandbox).toMatchObject({
      enabled: true,
      required: false,
      network: { allow: ['a.example.com'] },
    })
    const off = await written({ enabled: false, allow: [] })
    expect(off.recipe?.recipe.sandbox).toMatchObject({ enabled: false })
  })

  it('refuses a host the block would refuse, by name', () => {
    expect(refusalOf(form({ enabled: true, allow: ['https://x.com'] }))).toContain('https://x.com')
    expect(refusalOf(form({ enabled: false, allow: ['https://x.com'] }))).toBeNull()
    expect(hostsRefusal(['ok.example.com', '*.example.com'])).toBeNull()
  })

  it('parses hosts one per line or comma-separated, once each', () => {
    expect(parseHosts('a.example.com\n b.example.com,a.example.com,')).toEqual(['a.example.com', 'b.example.com'])
    expect(SANDBOX_OFF_LINE).toContain('your credentials')
  })

  it('a new claude-code project with the sandbox on meets the token step by itself, and off does not', async () => {
    const on = (await written({ enabled: true, allow: [] })).recipe.recipe
    const off = (await written({ enabled: false, allow: [] })).recipe.recipe
    const none = { usable: false } as never
    expect(needsClaudeToken(on, none)).toBe(true)
    expect(needsClaudeToken(off, none)).toBe(false)
  })
})
