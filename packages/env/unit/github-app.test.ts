import { describe, expect, it } from 'vitest'

import { electGithubApp, environmentProvider, githubSection, yamlProvider } from '../src/index.ts'

/**
 * The App's credentials come from one source, and that source answers every
 * name (#320). Pure: the sources are handed in already read, so nothing here
 * touches a file or the real environment.
 */
const HOME = '/home/op/.lingtai'
const FILE = `${HOME}/config.yml`

function machine(section: Record<string, unknown>) {
  return { path: FILE, section: githubSection(yamlProvider({ github: section })) }
}

describe('the two sources name the same things', () => {
  it('reads LINGTAI_GITHUB_* from the environment as the github: section', () => {
    expect(
      githubSection(
        environmentProvider({
          LINGTAI_GITHUB_APP_ID: '222',
          LINGTAI_GITHUB_APP_PRIVATE_KEY_PATH: '/k.pem',
          LINGTAI_GITHUB_APP_PRIVATE_KEY: 'inline',
          LINGTAI_GITHUB_WEBHOOK_SECRET: 's',
        }),
      ),
    ).toEqual({ appId: '222', privateKeyPath: '/k.pem', privateKey: 'inline', webhookSecret: 's' })
  })

  it('reads a numeric app_id from the file as a string', () => {
    expect(githubSection(yamlProvider({ github: { app_id: 1850235 } }))).toEqual({ appId: '1850235' })
  })

  it('treats an empty value as no value', () => {
    expect(githubSection(environmentProvider({ LINGTAI_GITHUB_APP_ID: '' }))).toEqual({})
  })

  it('never reads an unprefixed name', () => {
    expect(githubSection(environmentProvider({ GITHUB_APP_ID: '1' }))).toEqual({})
  })
})

describe('electGithubApp', () => {
  it('lets the environment override the file when it names the id', () => {
    const elected = electGithubApp(
      { appId: '222', privateKeyPath: '/env.pem' },
      machine({ app_id: '111', app_private_key_path: '/machine.pem', webhook_secret: 'machine-secret' }),
      HOME,
    )
    expect(elected.source).toBe('environment')
    expect(elected.values).toEqual({ appId: '222', privateKeyPath: '/env.pem' })
  })

  it("never pairs the environment's App with the file's secret", () => {
    // The cold review's reproduction of #320's watch-out: App 222 from one
    // source, App 111's secret from the other.
    const elected = electGithubApp(
      { appId: '222', privateKeyPath: '/env.pem' },
      machine({ app_id: '111', webhook_secret: 'machine-secret' }),
      HOME,
    )
    expect(elected.values.webhookSecret).toBeUndefined()
  })

  it('takes every name from the file when the environment names no id', () => {
    // A stale key path exported on its own belongs to no App.
    const elected = electGithubApp(
      { privateKeyPath: '/stale.pem', webhookSecret: 'stale' },
      machine({ app_id: '111', app_private_key_path: '/machine.pem' }),
      HOME,
    )
    expect(elected.source).toBe(FILE)
    expect(elected.values).toEqual({ appId: '111', privateKeyPath: '/machine.pem' })
  })

  it("resolves the file's relative key path against the state directory", () => {
    const elected = electGithubApp({}, machine({ app_id: '111', app_private_key_path: 'keys/app.pem' }), HOME)
    expect(elected.values.privateKeyPath).toBe(`${HOME}/keys/app.pem`)
  })

  it('answers nothing, and carries why, where neither names an id', () => {
    const elected = electGithubApp(
      {},
      { path: FILE, section: {}, unreadable: `${FILE} could not be read: EACCES` },
      HOME,
    )
    expect(elected).toEqual({ source: null, values: {}, unreadable: `${FILE} could not be read: EACCES` })
  })

  it('reads no file where this environment has none', () => {
    expect(electGithubApp({}, { path: null, section: { appId: '1' } }, HOME).source).toBeNull()
  })
})
