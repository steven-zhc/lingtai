import { describe, expect, it } from 'vitest'

import {
  AgentUnresolvedError,
  MachineConfigInvalidError,
  RecipeFailed,
  RecipeInvalidError,
  RecipeMissingError,
  isMissing,
  resolveLocalRecipe,
  resolveRecipe,
  setRecipe,
} from '../src/index.ts'

const HOME = '/nowhere'
const files = (map: Record<string, string>) => async (p: string) => map[p] ?? null
const at = (project: string) => `${HOME}/${project}/recipe.yml`
const none = async () => []

describe('the faces reject with the package errors, not wrappers', () => {
  it('RecipeMissingError for an absent recipe', async () => {
    await expect(resolveLocalRecipe('p', { home: HOME, signedIn: none, read: files({}) })).rejects.toBeInstanceOf(
      RecipeMissingError,
    )
  })
  it('RecipeInvalidError for a recipe that is not valid', async () => {
    await expect(
      resolveLocalRecipe('p', { home: HOME, signedIn: none, read: files({ [at('p')]: 'version: 99\n' }) }),
    ).rejects.toBeInstanceOf(RecipeInvalidError)
  })
  it('MachineConfigInvalidError for a machine file that holds steps', async () => {
    await expect(
      resolveLocalRecipe('p', {
        home: HOME,
        signedIn: none,
        read: files({ [at('p')]: 'version: 2\n', [`${HOME}/config.yml`]: 'steps:\n  build: []\n' }),
      }),
    ).rejects.toBeInstanceOf(MachineConfigInvalidError)
  })
  it('AgentUnresolvedError when no runtime is signed in and the recipe names none', async () => {
    const text = 'version: 2\nextends: pnpm-workspace\n'
    await expect(
      resolveLocalRecipe('p', { home: HOME, signedIn: none, read: files({ [at('p')]: text }) }),
    ).rejects.toSatisfy((e) => e instanceof AgentUnresolvedError || e instanceof RecipeInvalidError)
  })
})

describe('a port that rejects makes the face reject with RecipeFailed', () => {
  it('RecipeFiles.read', async () => {
    const err = await setRecipe('p', [], {
      home: HOME,
      files: { read: async () => Promise.reject(new Error('EACCES: denied')), replace: async () => {} },
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RecipeFailed)
    expect(err).toMatchObject({ _tag: 'RecipeFailed', operation: 'read', message: 'EACCES: denied' })
  })
  it('ReadAtRef', async () => {
    const err = await resolveRecipe(async () => Promise.reject(new Error('fetch failed')), 'main').catch(
      (e: unknown) => e,
    )
    expect(err).toMatchObject({ _tag: 'RecipeFailed', operation: 'read-at-ref', message: 'fetch failed' })
  })
  it('SignedIn', async () => {
    const err = await resolveLocalRecipe('p', {
      home: HOME,
      signedIn: async () => Promise.reject(new Error('probe broke')),
      read: files({ [at('p')]: 'version: 2\nextends: pnpm-workspace\n' }),
    }).catch((e: unknown) => e)
    expect(err).toMatchObject({ _tag: 'RecipeFailed', operation: 'signed-in', message: 'probe broke' })
  })
})

describe('isMissing', () => {
  it('maps ENOENT to a missing file and EACCES to a failure', () => {
    expect(isMissing(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(true)
    expect(isMissing(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe(false)
  })
})
