import { Redacted } from 'effect'
import { describe, expect, it } from 'vitest'

import { copilotGithubToken, copilotTokenState, machineFileFrom } from '../src/index.ts'

const FAKE = 'github_pat_FAKE_0000'
const file = (text: string | null) => machineFileFrom('/fake/config.yml', text)

describe('copilotGithubToken', () => {
  it('reads the environment first, then the file', () => {
    const t = copilotGithubToken({ LINGTAI_COPILOT_GITHUB_TOKEN: FAKE }, file('copilot:\n  github_token: other\n'))
    expect(Redacted.value(t!)).toBe(FAKE)
    const f = copilotGithubToken({}, file(`copilot:\n  github_token: ${FAKE}\n`))
    expect(Redacted.value(f!)).toBe(FAKE)
  })

  it('answers absent for no file, empty, or whitespace inside', () => {
    expect(copilotGithubToken({}, file(null))).toBeUndefined()
    expect(copilotGithubToken({ LINGTAI_COPILOT_GITHUB_TOKEN: '' }, file(null))).toBeUndefined()
    expect(copilotGithubToken({ LINGTAI_COPILOT_GITHUB_TOKEN: 'a b' }, file(null))).toBeUndefined()
    expect(copilotGithubToken({ LINGTAI_COPILOT_GITHUB_TOKEN: '   ' }, file(null))).toBeUndefined()
  })

  it('trims the outer whitespace', () => {
    expect(Redacted.value(copilotGithubToken({ LINGTAI_COPILOT_GITHUB_TOKEN: `${FAKE}\n` }, file(null))!)).toBe(FAKE)
  })

  it('never prints the token, and an unreadable file quotes nothing', () => {
    const t = copilotGithubToken({ LINGTAI_COPILOT_GITHUB_TOKEN: FAKE }, file(null))!
    expect(String(t)).not.toContain(FAKE)
    expect(JSON.stringify(t)).not.toContain(FAKE)
    let message = ''
    try {
      copilotGithubToken({}, file(`copilot: [${FAKE}\n`))
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('/fake/config.yml')
    expect(message).toContain('copilot.github_token')
    expect(message).not.toContain(FAKE)
  })

  it('reports where it is set, never the value', () => {
    const state = copilotTokenState({}, '/fake/config.yml', `copilot:\n  github_token: ${FAKE}\n`)
    expect(state).toEqual({ environment: false, file: true, usable: true })
    expect(JSON.stringify(state)).not.toContain(FAKE)
  })
})
