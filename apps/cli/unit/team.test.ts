/**
 * Team mode in `lingtai add` (#1324): the personal-branch question's refusals, the GitHub flow's
 * existence check and make-after-asking, the login, and the card. No filesystem, no network — the
 * file seam is a `Map` and the client is a fake (0060 §1).
 */
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { makePersonalBranch } from '../src/add-github.ts'
import type { QuestionWorld } from '../src/question.ts'
import { askSandbox } from '../src/sandbox-step.ts'
import { askPersonal } from '../src/team.ts'
import { walkProject } from '../test/project-list.ts'

const world = (answer: (prompt: string) => string | null = () => null): QuestionWorld & { asked: string[] } => {
  const asked: string[] = []
  return {
    asked,
    ask: async (prompt) => {
      asked.push(prompt)
      return answer(prompt)
    },
    log: () => {},
  }
}

/** `no` to *use this setup?*, `make` to the branch, and an Enter to everything else — a stray `yes` would loop a choice question. */
const answers =
  (make: 'yes' | 'no') =>
  (prompt: string): string =>
    /use this setup/.test(prompt) ? 'no' : /Make it from origin/.test(prompt) ? make : ''

describe('the personal branch question (#1324)', () => {
  const ask = (given: string, main = 'main') =>
    Effect.runPromise(askPersonal(world(), { given, fallback: 'steven-zhc/studio', main, kept: 'Nothing was written' }))

  it.each([
    ["Steven's MacBook", 'space'],
    ['steven/foundry..old', '..'],
    ['@{-1}', '@{'],
  ])('refuses %s by name', async (name, why) => {
    const result = await ask(name)
    expect(result).toEqual({ refused: expect.stringContaining(why) })
  })

  it('offers the made-safe name as the fix for a space', async () => {
    expect(await ask("Steven's MacBook")).toEqual({ refused: expect.stringContaining('use Steven-s-MacBook?') })
  })

  it('refuses the main branch ignoring case', async () => {
    expect(await ask('Main')).toEqual({ refused: expect.stringContaining('same branch as main, ignoring case') })
  })

  it('accepts steven-zhc/foundry', async () => {
    expect(await ask('steven-zhc/foundry')).toEqual({ personal: 'steven-zhc/foundry' })
  })
})

describe('the project list in team mode on GitHub (#1324)', () => {
  const run = (w: QuestionWorld, over: Partial<Parameters<typeof walkProject>[1]> = {}) =>
    Effect.runPromise(
      walkProject(w, {
        ...over,
        flags: { mode: 'team', install: 'none', personal: 'steven-zhc/foundry', ...over.flags },
        ports: { branchExists: (name) => Effect.succeed(name === 'main'), ...over.ports },
        buildFlags: ['none'],
      }),
    )

  it('an absent branch is confirmed and planned after the branch answer', () =>
    run(world(answers('yes'))).then(({ result, ctx }) => {
      expect(result.refused).toBeUndefined()
      expect(ctx.answers.make).toEqual({ name: 'steven-zhc/foundry', from: 'main' })
      expect(result.entries.filter((e) => e.asked).map((e) => e.id)).toContain('make-branch')
      expect(ctx.pending).toContainEqual({ path: ['source', 'assignee'], value: { login: 'sam', take: 'mine' } })
    }))

  it('declining writes nothing and says how to make it by hand', () =>
    run(world(answers('no'))).then(({ result, ctx }) => {
      expect(result.refused).toContain('git push origin origin/main:refs/heads/steven-zhc/foundry')
      expect(ctx.answers.make).toBeUndefined()
    }))

  it('an exact existing branch needs no creation, while a PR branch does', () =>
    run(world(answers('yes')), {
      ports: { branchExists: (name) => Effect.succeed(name === 'main' || name === 'steven-zhc/foundry-pr-7') },
    })
      .then(({ ctx }) => {
        expect(ctx.answers.make?.name).toBe('steven-zhc/foundry')
        return run(world(answers('yes')), { ports: { branchExists: () => Effect.succeed(true) } })
      })
      .then(({ ctx }) => expect(ctx.answers.make).toBeUndefined()))

  it('a failed branch read is refused, never treated as absent', () =>
    run(world(answers('yes')), {
      ports: { branchExists: () => Effect.succeed('unreadable') },
    }).then(({ result }) => expect(result.refused).toContain('could not read whether')))

  it('an unknown login without a terminal refuses by name', () =>
    run(world(), {
      interactive: false,
      ports: { knownLogin: null },
    }).then(({ result }) => expect(result.refused).toContain('--login')))

  it('a discovered login is not asked and a team landing is not asked', () =>
    run(world(answers('yes'))).then(({ result }) => {
      for (const id of ['login', 'landing']) expect(result.entries.find((e) => e.id === id)?.asked).toBe(false)
    }))

  it('a team project refuses --land <branch>', () =>
    run(world(answers('yes')), {
      flags: { land: 'develop' },
    }).then(({ result }) => expect(result.refused).toContain('a team project lands on branch.personal')))
})

describe('making the branch (#1324)', () => {
  it('reads main’s sha and creates the ref at it', async () => {
    const calls: string[] = []
    await Effect.runPromise(
      makePersonalBranch(
        {
          refSha: async (ref) => (calls.push(`sha ${ref}`), 'abc123'),
          createBranch: async (name, sha) => void calls.push(`create ${name} ${sha}`),
        },
        'steven-zhc/foundry',
        'main',
      ),
    )
    expect(calls).toEqual(['sha main', 'create steven-zhc/foundry abc123'])
  })

  it('makes nothing when main cannot be read', async () => {
    const calls: string[] = []
    const out = await Effect.runPromise(
      makePersonalBranch(
        {
          refSha: async () => {
            throw new Error('404')
          },
          createBranch: async () => void calls.push('create'),
        },
        'x/y',
        'main',
      ).pipe(Effect.result),
    )
    expect(out._tag).toBe('Failure')
    expect(calls).toEqual([])
  })
})

describe('askSandbox over a recipe that already says (#1474)', () => {
  const proposal = { verdict: { can: true }, install: null, builtIns: ['api.example.com'] } as never
  const world = (answers: string[]): QuestionWorld => ({ ask: async () => answers.shift() ?? '', log: () => {} })
  const ask = (answers: string[], current: { enabled: boolean; allow: readonly string[]; required?: boolean }) =>
    Effect.runPromise(askSandbox(world(answers), { proposal, flags: {}, kept: 'kept', current }))

  it('an answer equal to the recipe writes nothing, so an absent block stays absent and a hand-set required stays', async () => {
    expect(await ask(['off'], { enabled: false, allow: [] })).toEqual({ changes: [] })
    expect(await ask(['on', 'none'], { enabled: true, allow: [] })).toEqual({ changes: [] })
    expect(await ask(['', ''], { enabled: true, allow: ['a.example'] })).toEqual({ changes: [] })
  })

  it('off over a required sandbox drops the requirement with it, or the recipe does not resolve', async () => {
    expect(await ask(['off'], { enabled: true, allow: [], required: true })).toEqual({
      changes: [
        { path: ['sandbox', 'enabled'], value: false },
        { path: ['sandbox', 'required'], value: false },
      ],
    })
  })

  it('a changed answer sets only what changed, never the whole block', async () => {
    expect(await ask(['off'], { enabled: true, allow: ['a.example'] })).toEqual({
      changes: [{ path: ['sandbox', 'enabled'], value: false }],
    })
    expect(await ask(['on', 'b.example'], { enabled: true, allow: ['a.example'] })).toEqual({
      changes: [{ path: ['sandbox', 'network', 'allow'], value: ['b.example'] }],
    })
    expect(await ask(['on', 'none'], { enabled: false, allow: [] })).toEqual({
      changes: [{ path: ['sandbox', 'enabled'], value: true }],
    })
  })
})
