/**
 * `draftRecipe` (#1182): a recipe edited in memory. The port records every write, and none may happen.
 */
import { type RecipeChange, type RecipeFiles, RecipeInvalidError } from '@lingtai/recipe'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { draftRecipe, ProjectFiles, recipePath } from '../src/index.ts'

const HOME = '/home/me/.lingtai'
const PATH = recipePath('app', HOME)

const FIXTURE = `version: 2
branch:
  main: main
source:
  kinds: [bug]
env:
  plantAt: .env.local
`

function port(initial: Record<string, string> = {}): RecipeFiles & { replaced: string[]; reads: number } {
  const store = new Map(Object.entries(initial))
  const self = {
    replaced: [] as string[],
    reads: 0,
    read: async (p: string) => {
      self.reads++
      return store.get(p) ?? null
    },
    replace: async (p: string, text: string) => {
      self.replaced.push(p)
      store.set(p, text)
    },
  }
  return self
}

const open = (files: RecipeFiles, said?: Record<string, string>) =>
  Effect.runPromise(
    draftRecipe('app', { home: HOME, ...(said === undefined ? {} : { said }) }).pipe(
      Effect.provideService(ProjectFiles, files),
    ),
  )

const BASE: RecipeChange = { path: ['repo', 'base'], value: 'trunk' }

describe('draftRecipe', () => {
  it('reads the file once, and set edits in memory without writing', async () => {
    const files = port({ [PATH]: FIXTURE })
    const draft = await open(files)
    const result = await Effect.runPromise(draft.set([BASE]))
    await Effect.runPromise(draft.set([{ path: ['source', 'kinds'], value: ['bug', 'feature'] }]))

    expect(result).toMatchObject({ path: PATH, written: true })
    expect(draft.text()).toContain('base: trunk')
    expect(files.reads).toBe(1)
    expect(files.replaced).toEqual([])
  })

  it('get reads the draft, not the file, and an absent key is null', async () => {
    const files = port({ [PATH]: FIXTURE })
    const draft = await open(files)
    expect(draft.get(['repo', 'base'])).toBe('main')
    await Effect.runPromise(draft.set([BASE]))
    expect(draft.get(['repo', 'base'])).toBe('trunk')
    expect(draft.get(['runtime', 'agent'])).toBeNull()
    expect(await files.read(PATH)).toBe(FIXTURE)
  })

  it('a refused set leaves the draft as it was', async () => {
    const draft = await open(port({ [PATH]: FIXTURE }))
    await Effect.runPromise(draft.set([BASE]))
    const before = draft.text()
    const refused = await Effect.runPromise(Effect.flip(draft.set([{ path: ['steps', 'merg'], value: [] }])))
    expect(refused).toBeInstanceOf(RecipeInvalidError)
    expect(draft.text()).toBe(before)
    expect(draft.changes()).toEqual([BASE])
  })

  it('a set that changes nothing reports written: false and records nothing', async () => {
    const draft = await open(port({ [PATH]: FIXTURE }))
    const result = await Effect.runPromise(draft.set([{ path: ['repo', 'base'], value: 'main' }]))
    expect(result.written).toBe(false)
    expect(draft.text()).toBe(FIXTURE)
    expect(draft.changes()).toEqual([])
  })

  it('keeps every change set that changed the text, in order', async () => {
    const draft = await open(port({ [PATH]: FIXTURE }))
    const more: RecipeChange[] = [{ path: ['source', 'kinds'], value: ['bug', 'feature'] }]
    await Effect.runPromise(draft.set([BASE]))
    await Effect.runPromise(draft.set(more))
    expect(draft.changes()).toEqual([BASE, ...more])
  })

  it('an absent file starts an empty draft that the first set creates, with `said` once', async () => {
    const files = port()
    const said = { repo: 'the branch every pass cuts from' }
    const draft = await open(files, said)
    expect(draft.text()).toBeNull()
    expect(draft.get(['repo', 'base'])).toBeNull()

    await Effect.runPromise(
      draft.set([
        BASE,
        { path: ['source', 'kinds'], value: ['bug'] },
        { path: ['env', 'plantAt'], value: '.env.local' },
      ]),
    )
    expect(draft.text()).toContain('the branch every pass cuts from')
    const created = draft.text()

    await Effect.runPromise(draft.set([{ path: ['source', 'kinds'], value: ['bug', 'feature'] }]))
    expect(draft.text()!.match(/the branch every pass cuts from/g)).toHaveLength(1)
    expect(draft.text()).not.toBe(created)
    expect(files.replaced).toEqual([])
  })

  it('an existing file ignores `said`', async () => {
    const draft = await open(port({ [PATH]: FIXTURE }), { repo: 'the branch every pass cuts from' })
    await Effect.runPromise(draft.set([BASE]))
    expect(draft.text()).not.toContain('the branch every pass cuts from')
  })

  it('a read that fails fails draftRecipe', async () => {
    const files: RecipeFiles = {
      read: async () => {
        throw new Error('disk gone')
      },
      replace: async () => {},
    }
    await expect(open(files)).rejects.toThrow()
  })
})
