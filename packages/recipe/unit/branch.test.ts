import { describe, expect, it } from 'vitest'

import { editRecipe } from '../src/emit.ts'
import { RecipeInvalidError, RecipeRefusedError, resolveSource } from '../src/resolve.ts'
import { branchOf, modeOf } from '../src/settings.ts'

const TAIL = `
source:
  kinds: [bug]
env:
  plantAt: .env.local
runtime:
  agent: claude-code
`

const resolve = (head: string) => resolveSource(`version: 2\n${head}${TAIL}`, 'main', 'recipe.yml')

const refusal = (head: string): RecipeRefusedError => {
  try {
    resolve(head)
  } catch (err) {
    expect(err).toBeInstanceOf(RecipeRefusedError)
    expect(err).toBeInstanceOf(RecipeInvalidError)
    return err as RecipeRefusedError
  }
  throw new Error('resolved')
}

describe('mode, branch and pr', () => {
  it('resolves a team recipe, and answers solo for one that names no mode', () => {
    const team = resolve('mode: team\nbranch: { main: main, personal: steven/box }\npr: {}\n').recipe
    expect(modeOf(team)).toBe('team')
    expect(branchOf(team)).toBe('steven/box')
    expect(team.pr).toEqual({ limits: { turns: 20, wall: '5m' } })

    const solo = resolve('branch: { main: develop }\n').recipe
    expect(modeOf(solo)).toBe('solo')
    expect(solo.mode).toBeUndefined()
    expect(solo.pr).toBeUndefined()
    expect(branchOf(solo)).toBe('develop')
  })

  it('refuses each meaning by the key, as a RecipeRefusedError', () => {
    const cases: [string, string][] = [
      ['mode: team\nbranch: { main: main }\n', 'branch.personal'],
      ['branch: { main: main, personal: me/box }\n', 'branch.personal'],
      ['mode: team\nbranch: { main: main, personal: "Steven\'s MacBook" }\n', 'branch.personal'],
      ['mode: team\nbranch: { main: main, personal: Main }\n', 'branch.personal'],
      ['branch: { main: main }\npr: {}\n', 'pr:'],
    ]
    for (const [head, key] of cases) {
      const text = `version: 2\n${head}${TAIL}`
      let thrown: unknown
      try {
        resolveSource(text, 'main', 'recipe.yml')
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(RecipeRefusedError)
      expect((thrown as RecipeRefusedError)._tag).toBe('RecipeRefused')
      expect((thrown as RecipeRefusedError).message).toContain(key)
    }
  })

  it('refuses a pr: that spends, or names an agent that cannot run with no tools', () => {
    expect(() => resolve('mode: team\nbranch: { main: main, personal: me/box }\npr: { limits: { usd: 1 } }\n')).toThrow(
      RecipeInvalidError,
    )
    expect(() => resolve('mode: team\nbranch: { main: main, personal: me/box }\npr: { agent: gemini }\n')).toThrow(
      RecipeInvalidError,
    )
  })

  it('leaves YAML that does not parse a plain RecipeInvalidError', () => {
    try {
      resolveSource('version: [', 'main', 'recipe.yml')
    } catch (err) {
      expect(err).toBeInstanceOf(RecipeInvalidError)
      expect(err).not.toBeInstanceOf(RecipeRefusedError)
      return
    }
    throw new Error('resolved')
  })
})

describe('the old spellings', () => {
  const NEW = resolve('branch: { main: develop }\nrepo: { submodules: true }\n')

  it('reads repo.base as branch.main, to the same recipe and hash as its rewritten twin', () => {
    const old = resolve('repo: { base: develop, submodules: true }\n')
    expect(old.recipe).toEqual(NEW.recipe)
    expect(old.configHash).toBe(NEW.configHash)
    expect(old.oldSpellings).toEqual(['repo.base'])
    expect(NEW.oldSpellings).toEqual([])
  })

  it('reads a repo whose base was its only key as no repo at all', () => {
    const old = resolve('repo: { base: develop }\n')
    const twin = resolve('branch: { main: develop }\n')
    expect(old.configHash).toBe(twin.configHash)
    expect(old.recipe.repo).toBeUndefined()
  })

  it("reads admit's worktree.base, which wins over repo.base", () => {
    const old = resolve(
      'repo: { base: other, submodules: true }\nsteps:\n  admit:\n    - name: cut\n      worktree: { base: develop, submodules: true }\n',
    )
    const twin = resolve(
      'branch: { main: develop }\nrepo: { submodules: true }\nsteps:\n  admit:\n    - name: cut\n      worktree: { submodules: true }\n',
    )
    expect(old.recipe).toEqual(twin.recipe)
    expect(old.configHash).toBe(twin.configHash)
    expect(old.oldSpellings).toEqual(['steps.admit[0].worktree.base', 'repo.base'])
  })

  it('reads take: both as take: all, at runtime and at claim', () => {
    const old = resolveSource(
      'version: 2\nbranch: { main: develop }\nsource: { kinds: [bug] }\nenv: { plantAt: .env.local }\n' +
        'runtime:\n  agent: claude-code\n  assignee: { take: both }\n' +
        'steps:\n  claim:\n    - name: take\n      queue: { kinds: [bug], exclude: [], backoff: 1h, assignee: { take: both } }\n',
      'main',
      'recipe.yml',
    )
    expect(old.recipe.runtime.assignee?.take).toBe('all')
    expect(old.oldSpellings).toEqual(['runtime.assignee.take: both', 'steps.claim[0].queue.assignee.take: both'])
  })

  it('refuses a file that writes branch and an old base', () => {
    const err = refusal('branch: { main: develop }\nrepo: { base: develop }\n')
    expect(err.message).toContain('two homes')
  })
})

describe('writing branch.main into a file in the old spelling', () => {
  it('takes the old base out in the same edit, so the file never holds two homes', () => {
    const before = `version: 2
repo:
  base: main
  submodules: true
source:
  kinds: [bug]
env:
  plantAt: .env.local
runtime:
  agent: claude-code
`
    const after = editRecipe(before, [{ path: ['branch', 'main'], value: 'develop' }])
    expect(after).not.toContain('base:')
    const resolved = resolveSource(after, 'develop', 'recipe.yml')
    expect(resolved.oldSpellings).toEqual([])
    expect(branchOf(resolved.recipe)).toBe('develop')
    expect(resolved.recipe.repo?.submodules).toBe(true)
  })
})
