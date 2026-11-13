import { Redacted } from 'effect'
import { describe, expect, it } from 'vitest'

import { claudeOauthToken, machineFileFrom } from '../src/index.ts'

const FAKE = 'sk-ant-oat01-FAKE-0000'
const file = (text: string | null) => machineFileFrom('/fake/config.yml', text)

describe('claudeOauthToken', () => {
  it('reads the environment first, then the file', () => {
    const t = claudeOauthToken({ LINGTAI_CLAUDE_OAUTH_TOKEN: FAKE }, file('claude:\n  oauth_token: other\n'))
    expect(Redacted.value(t!)).toBe(FAKE)
    const f = claudeOauthToken({}, file(`claude:\n  oauth_token: ${FAKE}\n`))
    expect(Redacted.value(f!)).toBe(FAKE)
  })

  it('answers absent for no file, empty, or whitespace inside', () => {
    expect(claudeOauthToken({}, file(null))).toBeUndefined()
    expect(claudeOauthToken({ LINGTAI_CLAUDE_OAUTH_TOKEN: '' }, file(null))).toBeUndefined()
    expect(claudeOauthToken({ LINGTAI_CLAUDE_OAUTH_TOKEN: 'a b' }, file(null))).toBeUndefined()
    expect(claudeOauthToken({ LINGTAI_CLAUDE_OAUTH_TOKEN: '   ' }, file(null))).toBeUndefined()
  })

  it('trims the outer whitespace', () => {
    expect(Redacted.value(claudeOauthToken({ LINGTAI_CLAUDE_OAUTH_TOKEN: `${FAKE}\n` }, file(null))!)).toBe(FAKE)
  })

  it('never prints the token, and an unreadable file quotes nothing', () => {
    const t = claudeOauthToken({ LINGTAI_CLAUDE_OAUTH_TOKEN: FAKE }, file(null))!
    expect(String(t)).not.toContain(FAKE)
    expect(JSON.stringify(t)).not.toContain(FAKE)
    const broken = file(`claude:\n  oauth_token: ${FAKE}: [\n`)
    expect(broken.unreadable).toBeDefined()
    let message = ''
    try {
      claudeOauthToken({}, broken)
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('/fake/config.yml')
    expect(message).not.toContain(FAKE)
  })
})
