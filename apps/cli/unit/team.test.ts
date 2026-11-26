/**
 * Team mode in `lingtai add` (#1324): the personal-branch question's refusals, the GitHub flow's
 * existence check and make-after-asking, the login, and the card. No filesystem, no network — the
 * file seam is a `Map` and the client is a fake (0060 §1).
 */
import { ProjectFiles } from '@lingtai/project'
import { type RecipeFiles } from '@lingtai/recipe'
import { EMPTY_SETUP_READER } from '@lingtai/setup'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { makePersonalBranch } from '../src/add-github.ts'
import type { QuestionWorld } from '../src/question.ts'
import { askRecipeEffect, ENV_PLANT_AT, type RecipeAt } from '../src/recipe-flow.ts'
import { renderSetupCard, type CardRecipe, type SetupCardFacts } from '../src/setup-card.ts'
import { askPersonal } from '../src/team.ts'

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

/** `no` to *use every default?*, `make` to the branch, and an Enter to everything else — a stray `yes` would loop a choice question. */
const answers =
  (make: 'yes' | 'no') =>
  (prompt: string): string =>
    /use every default/.test(prompt) ? 'no' : /Make it from origin/.test(prompt) ? make : ''

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

describe('askRecipe in team mode, on GitHub (#1324)', () => {
  const files = (): RecipeFiles => ({ read: async () => null, replace: async () => {} })
  const at = (
    over: Partial<RecipeAt> & { existing?: readonly string[]; login?: string | null; asked?: string[] },
  ): RecipeAt => {
    const existing = new Set(over.existing ?? [])
    return {
      project: 'foundry',
      local: false,
      runtimes: [{ id: 'claude-code', state: 'signed-in', signedIn: true, detail: 'signed in' }],
      reader: EMPTY_SETUP_READER,
      flags: { mode: 'team', install: 'none', personal: 'steven-zhc/foundry', ...over.flags },
      buildFlags: ['none'],
      defaultBranch: async () => 'main',
      history: async () => [],
      seeds: [
        { path: ['branch', 'main'], value: 'main' },
        { path: ['env', 'plantAt'], value: ENV_PLANT_AT },
      ],
      kept: 'kept',
      keptBeforeWrite: 'Nothing was written',
      again: 'lingtai add acme/foundry',
      home: '/home/me/.lingtai',
      // An exact ref: what `foundry-pr-7` being there says of `foundry` is nothing.
      team: {
        knownLogin: over.login === undefined ? 'steven-zhc' : over.login,
        hostname: () => 'Stevens-MacBook-Pro.local',
        branchExists: (name) => Effect.succeed(existing.has(name)),
      },
      ...(over.team === undefined ? {} : { team: over.team }),
    }
  }
  const run = (world: QuestionWorld, options: RecipeAt) =>
    Effect.runPromise(askRecipeEffect(world, options).pipe(Effect.provideService(ProjectFiles, files())))

  it('an absent branch is asked about, and made from main when the answer is yes', async () => {
    const w = world(answers('yes'))
    const result = await run(w, at({}))
    expect(result).toMatchObject({ ok: true, make: { name: 'steven-zhc/foundry', from: 'main' } })
    expect(w.asked.some((p) => /does not exist.*Make it from origin\/main/.test(p))).toBe(true)
    if (!('ok' in result)) throw new Error('refused')
    const changes = result.answers.changes.map((c) => `${c.path.join('.')}=${JSON.stringify(c.value)}`)
    expect(changes).toContain('mode="team"')
    expect(changes).toContain('branch.personal="steven-zhc/foundry"')
    expect(changes).toContain('source.assignee={"login":"steven-zhc","take":"mine"}')
  })

  it('no writes nothing and registers nothing, and says how to make it by hand', async () => {
    const result = await run(world(answers('no')), at({}))
    expect(result).toEqual({
      refused: expect.stringContaining('git push origin origin/main:refs/heads/steven-zhc/foundry'),
    })
    expect(result).not.toHaveProperty('answers')
  })

  it('an existing branch is used as it is, and steven-zhc/foundry-pr-7 existing does not count as it', async () => {
    const pr = world(answers('yes'))
    const withPr = await run(pr, at({ existing: ['steven-zhc/foundry-pr-7'] }))
    expect(withPr).toMatchObject({ ok: true, make: { name: 'steven-zhc/foundry' } })

    const exact = await run(world(answers('yes')), at({ existing: ['steven-zhc/foundry'] }))
    expect(exact).toMatchObject({ ok: true })
    expect(exact).not.toHaveProperty('make')
  })

  it('GitHub not answering is not read as absent', async () => {
    const result = await run(
      world(answers('yes')),
      at({
        team: {
          knownLogin: 'steven-zhc',
          hostname: () => 'studio',
          branchExists: () => Effect.succeed('unreadable' as const),
        },
      }),
    )
    expect(result).toEqual({ refused: expect.stringContaining('could not read whether steven-zhc/foundry exists') })
  })

  it('an App machine with no --login and no terminal is refused by --login', async () => {
    const result = await run(
      world(() => null),
      at({ login: null, flags: { defaults: '' } }),
    )
    expect(result).toEqual({ refused: expect.stringContaining('--login') })
  })

  it('a gh machine asks no login', async () => {
    const w = world(answers('yes'))
    await run(w, at({ login: 'sam' }))
    expect(w.asked.filter((p) => /GitHub login/.test(p))).toEqual([])
  })

  it('asks no landing question, and refuses --land <branch>', async () => {
    const w = world(answers('yes'))
    await run(w, at({}))
    expect(w.asked.filter((p) => /when an attempt is ready|land this on which branch/.test(p))).toEqual([])

    const refused = await run(world(answers('yes')), at({ flags: { land: 'develop' } }))
    expect(refused).toEqual({ refused: expect.stringContaining('a team project lands on branch.personal') })
  })
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

describe('the team card (#1324)', () => {
  const recipe: CardRecipe = {
    code: 'acme/foundry',
    base: 'steven-zhc/studio',
    remote: null,
    tickets: 'github',
    kinds: ['bug'],
    writer: { agent: 'claude-code', model: null },
    reviewer: null,
    checks: ['pnpm test'],
    approves: false,
    findingsJudge: null,
    team: { login: 'steven-zhc', personal: 'steven-zhc/studio' },
  }
  const facts: SetupCardFacts = {
    command: 'add',
    project: 'foundry',
    updated: false,
    home: '/h',
    homeIsNew: false,
    userHome: '/Users/me',
    store: { store: 'sqlite', path: '/h/l.db', where: 'config.yml', from: 'config.yml' },
    runtimes: [],
    where: 'github',
    recipe,
    trial: { trial: 'not-run', because: 'no checks' },
  }

  it('says what team means, and never that main is kept current', () => {
    const text = renderSetupCard(facts)
    expect(text).toContain('foundry added — team')
    expect(text).toContain('issues assigned to steven-zhc')
    expect(text).toContain('steven-zhc/studio; main is brought in when you submit a PR')
    expect(text).toContain('only through a PR you submit, one at a time · lingtai pr')
    expect(text).toContain('never pushes main')
    expect(text).toContain('assign yourself an issue, then lingtai start')
    expect(text).not.toMatch(/kept current/)
  })

  it('a local team project takes every ticket', () => {
    const text = renderSetupCard({ ...facts, recipe: { ...recipe, team: { login: null, personal: 'lingtai-base' } } })
    expect(text).toContain('every ticket — local tickets are yours')
    expect(text).toContain('open a ticket with lingtai ticket new, then lingtai start')
    expect(text).not.toContain('assign yourself an issue')
  })
})
