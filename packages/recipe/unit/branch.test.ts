import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

import { editRecipe } from '../src/emit.ts'
import {
  OldSpellingRefusedError,
  RecipeInvalidError,
  RecipeRefusedError,
  oldSpellingsIn,
  resolveSource,
} from '../src/resolve.ts'
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

const refusedOld = (head: string): OldSpellingRefusedError => {
  try {
    resolve(head)
  } catch (err) {
    expect(err).toBeInstanceOf(OldSpellingRefusedError)
    expect(err).toBeInstanceOf(RecipeRefusedError)
    expect((err as OldSpellingRefusedError)._tag).toBe('RecipeRefused')
    return err as OldSpellingRefusedError
  }
  throw new Error('resolved')
}

describe('the old spellings are refused by name', () => {
  it('refuses repo.base, naming branch.main and lingtai doctor --fix', () => {
    const err = refusedOld('repo: { base: develop, submodules: true }\n')
    expect(err.problems).toEqual([
      'repo.base: write `branch: { main: <value> }` (0130 §2), or run `lingtai doctor --fix`',
    ])
    expect(err.spellings.map((s) => s.at)).toEqual(['repo.base'])
  })

  it("refuses admit's worktree.base, which wins over repo.base in the fix", () => {
    const err = refusedOld(
      'repo: { base: other, submodules: true }\nsteps:\n  admit:\n    - name: cut\n      worktree: { base: develop, submodules: true }\n',
    )
    expect(err.spellings.map((s) => s.at)).toEqual(['steps.admit[0].worktree.base', 'repo.base'])
    expect(err.problems[0]).toBe(
      'steps.admit[0].worktree.base: move the branch to `branch.main`; `worktree:` carries `submodules` only (0104 §5), or run `lingtai doctor --fix`',
    )
    for (const s of err.spellings) expect(s.changes).toEqual([{ path: ['branch', 'main'], value: 'develop' }])
  })

  it('refuses take: both at runtime and at claim', () => {
    const text =
      'version: 2\nbranch: { main: develop }\nsource: { kinds: [bug] }\nenv: { plantAt: .env.local }\n' +
      'runtime:\n  agent: claude-code\n  assignee: { take: both }\n' +
      'steps:\n  claim:\n    - name: take\n      queue: { kinds: [bug], exclude: [], backoff: 1h, assignee: { take: both } }\n'
    const err = (() => {
      try {
        resolveSource(text, 'main', 'recipe.yml')
      } catch (e) {
        return e as OldSpellingRefusedError
      }
      throw new Error('resolved')
    })()
    expect(err).toBeInstanceOf(OldSpellingRefusedError)
    expect(err.spellings.map((s) => s.at)).toEqual([
      'runtime.assignee.take: both',
      'steps.claim[0].queue.assignee.take: both',
    ])
    expect(err.problems[0]).toBe(
      'runtime.assignee.take: both: write `take: all` (0130 §3), or run `lingtai doctor --fix`',
    )
  })

  it("refuses a file that writes branch and an old base, and its fix keeps the file's own branch.main", () => {
    const err = refusedOld('branch: { main: develop }\nrepo: { base: other }\n')
    expect(err.spellings.map((s) => s.at)).toEqual(['repo.base'])
    expect(err.spellings[0]!.changes).toEqual([{ path: ['branch', 'main'], value: 'develop' }])
  })

  it('is no refusal for a recipe with no repo block, or a repo block without a base', () => {
    expect(oldSpellingsIn(null)).toEqual([])
    expect(oldSpellingsIn({ branch: { main: 'x' }, repo: { submodules: true } })).toEqual([])
    expect(() => resolve('branch: { main: develop }\nrepo: { submodules: true }\n')).not.toThrow()
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
    expect(branchOf(resolved.recipe)).toBe('develop')
    expect(resolved.recipe.repo?.submodules).toBe(true)
  })
})

describe('the changes an old spelling carries', () => {
  const FILES = [
    '# the base\nrepo:\n  base: develop # where it lands\n  submodules: true\n',
    '# comment\nrepo:\n  base: other\n  submodules: true\nsteps:\n  admit:\n    - name: cut\n      worktree:\n        base: develop\n        submodules: true\n',
    '# runtime\nbranch:\n  main: develop\nruntime:\n  agent: claude-code\n  assignee:\n    take: both\nsteps:\n  claim:\n    - name: take\n      queue:\n        kinds: [bug]\n        exclude: []\n        backoff: 1h\n        assignee:\n          take: both\n',
  ]
  for (const [i, head] of FILES.entries()) {
    it(`rewrite fixture ${i} to a file that resolves`, () => {
      const source = head.includes('agent: claude-code')
        ? `version: 2\n${head}source: { kinds: [bug] }\nenv: { plantAt: .env.local }\n`
        : `version: 2\n${head}${TAIL}`
      const found = oldSpellingsIn(parseYaml(source))
      expect(found.length).toBeGreaterThan(0)
      const after = resolveSource(
        editRecipe(
          source,
          found.flatMap((s) => s.changes),
        ),
        'main',
        'recipe.yml',
      )
      expect(
        oldSpellingsIn(
          parseYaml(
            editRecipe(
              source,
              found.flatMap((s) => s.changes),
            ),
          ),
        ),
      ).toEqual([])
      expect(after.recipe.branch.main).toBe('develop')
    })
  }

  it('keeps a comment that was not on a removed key', () => {
    const source = `version: 2\n# keep me\nrepo:\n  base: develop # goes\n  submodules: true # stays\n${TAIL}`
    const out = editRecipe(
      source,
      oldSpellingsIn(parseYaml(source)).flatMap((s) => s.changes),
    )
    expect(out).toContain('# keep me')
    expect(out).toContain('# stays')
    expect(out).not.toContain('# goes')
  })
})
