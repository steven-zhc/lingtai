import { describe, expect, it } from 'vitest'

import { electGithubAuth, environmentProvider, githubSection, yamlProvider } from '../src/index.ts'

const FILE = '/home/op/.lingtai/config.yml'
const machine = (section: Record<string, unknown>) => ({
  path: FILE,
  section: githubSection(yamlProvider({ github: section })),
})
const env = (vars: Record<string, string>) => githubSection(environmentProvider(vars))
const APP = { app_id: '1', app_private_key_path: '/k.pem' }

describe('electGithubAuth', () => {
  it('reads gh and app when written', () => {
    expect(electGithubAuth(env({}), machine({ auth: 'gh' }))).toMatchObject({ kind: 'gh' })
    expect(electGithubAuth(env({}), machine({ auth: 'app' }))).toMatchObject({ kind: 'app' })
  })

  it('is app when absent but an App is configured', () => {
    expect(electGithubAuth(env({}), machine(APP))).toMatchObject({ kind: 'app' })
    expect(
      electGithubAuth(env({ LINGTAI_GITHUB_APP_ID: '2', LINGTAI_GITHUB_APP_PRIVATE_KEY: 'k' }), machine({})),
    ).toMatchObject({
      kind: 'app',
    })
  })

  it('lets an explicit gh beat any app_id, from either source', () => {
    expect(electGithubAuth(env({}), machine({ ...APP, auth: 'gh' }))).toMatchObject({ kind: 'gh' })
    expect(
      electGithubAuth(
        env({ LINGTAI_GITHUB_APP_ID: '2', LINGTAI_GITHUB_APP_PRIVATE_KEY: 'k' }),
        machine({ auth: 'gh' }),
      ),
    ).toMatchObject({ kind: 'gh' })
  })

  it('lets the environment beat the file', () => {
    expect(electGithubAuth(env({ LINGTAI_GITHUB_AUTH: 'app' }), machine({ auth: 'gh' }))).toMatchObject({ kind: 'app' })
    expect(electGithubAuth(env({ LINGTAI_GITHUB_AUTH: 'gh' }), machine({ auth: 'app' }))).toMatchObject({ kind: 'gh' })
  })

  it('refuses foo by name and its source', () => {
    const elected = electGithubAuth(env({}), machine({ auth: 'foo' }))
    expect(elected).toMatchObject({ refused: expect.stringContaining('github.auth is "foo"') })
    expect(electGithubAuth(env({ LINGTAI_GITHUB_AUTH: 'foo' }), machine({}))).toMatchObject({
      refused: expect.stringContaining('LINGTAI_GITHUB_AUTH'),
    })
  })

  it('is nothing when nothing is configured, carrying why the file was unreadable', () => {
    expect(electGithubAuth(env({}), machine({}))).toEqual({ kind: null })
    expect(electGithubAuth(env({}), { ...machine({}), unreadable: 'bad yaml' })).toEqual({
      kind: null,
      unreadable: 'bad yaml',
    })
  })
})
