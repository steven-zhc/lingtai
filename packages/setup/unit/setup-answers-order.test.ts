import { ProjectFiles } from '@lingtai/project'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { previewSetup } from '../src/apply-setup.ts'
import { personalFix } from '../src/personal-branch.ts'
import { refusalOf, type SetupForm, setupAnswers, setupChanges } from '../src/setup-answers.ts'

/** #978: the preview a person reads lists the steps in the order the loop reaches them. */
describe('the preview of a new GitHub recipe', () => {
  it('lists prepared, implement, build, review, proposed, end in that order', async () => {
    const form: SetupForm = {
      project: 'repo',
      target: { kind: 'github', owner: 'o', repo: 'r' } as SetupForm['target'],
      base: 'main',
      remote: null,
      install: 'pnpm install',
      checks: [{ name: 'test', run: 'pnpm test' }],
      writer: 'claude-code',
      reviewer: 'claude-code',
      tickets: 'github',
      kinds: ['bug'],
      heldBy: '',
      closeOnEnd: true,
      personApprovesMerge: true,
      limits: { turns: 50, wall: '1h', refusalFixes: 3, conflictResolutions: 3, newAttempts: 2 },
      turnsUnbounded: false,
      mode: 'solo',
      personal: '',
      login: null,
      sandbox: null,
    }
    const files = { read: () => Promise.resolve(null), replace: () => Promise.resolve() }
    const text = await Effect.runPromise(
      previewSetup({ home: '/h/.lingtai' }, setupAnswers(form)).pipe(Effect.provideService(ProjectFiles, files)),
    )
    const at = ['prepared', 'implement', 'build', 'review', 'proposed', 'end'].map((k) => text.indexOf(`\n  ${k}:`))
    expect(at.every((i) => i > 0)).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
  })
})

describe('the team form (#1325)', () => {
  const base: SetupForm = {
    project: 'foundry',
    target: { kind: 'github', owner: 'steven-zhc', repo: 'foundry' },
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
    limits: { turns: 300, wall: '1h', refusalFixes: 3, conflictResolutions: 3, newAttempts: 1 },
    turnsUnbounded: false,
    sandbox: null,
    mode: 'team',
    personal: 'steven-zhc/foundry',
    login: 'steven-zhc',
  }

  it('accepts steven-zhc/foundry', () => {
    expect(refusalOf(base)).toBeNull()
  })

  it.each([
    ['Main', 'is the main branch'],
    ['steven/foundry..old', 'cannot contain ..'],
    ["Steven's MacBook Pro", 'cannot contain a space'],
  ])('refuses %s by name', (personal, why) => {
    expect(refusalOf({ ...base, personal })).toContain(why)
  })

  it('refuses no login on GitHub, by name, and asks none of a directory', () => {
    expect(refusalOf({ ...base, login: null })).toContain('GitHub login')
    expect(
      refusalOf({ ...base, target: { kind: 'local', path: '/x' }, base: 'main', login: null, tickets: 'db' }),
    ).toBeNull()
  })

  it('writes mode, the personal branch and the assignee', () => {
    const paths = setupChanges(base).map((c) => c.path.join('.'))
    expect(paths).toEqual(expect.arrayContaining(['mode', 'branch.personal', 'runtime.assignee']))
  })

  it('a retry as solo removes branch.personal rather than leaving it', () => {
    const solo = setupChanges({ ...base, mode: 'solo' }, true)
    expect(solo.find((c) => c.path.join('.') === 'branch.personal')).toEqual({
      path: ['branch', 'personal'],
      value: undefined,
    })
    expect(solo.find((c) => c.path.join('.') === 'mode')?.value).toBe('solo')
    // and Team's assignee filter goes with it: Solo takes every ticket
    expect(solo.find((c) => c.path.join('.') === 'runtime.assignee')?.value).toEqual({ take: 'all' })
  })

  it('suggests a fix for a name git refuses', () => {
    expect(personalFix("Steven's MacBook Pro")).toBe('steven-s-macbook-pro')
    expect(personalFix('steven-zhc/foundry')).toBeNull()
  })
})
