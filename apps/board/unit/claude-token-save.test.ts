import { describe, expect, it } from 'vitest'

import { claudeTokenSetAt, saveClaudeToken } from '../src/app/setup/claude-token/save.ts'

const FAKE = 'sk-ant-oat01-FAKE_TOKEN_must_not_appear_0123456789'

const ports = (text: string | null, env = {} as NodeJS.ProcessEnv) => {
  const s = { text }
  return {
    s,
    p: {
      file: {
        read: () => s.text,
        write: (_p: string, t: string) => {
          s.text = t
        },
      },
      path: '/h/config.yml',
      env,
    },
  }
}

describe('the board saves the token through the one step', () => {
  it('saved: the file holds it, the answer does not', async () => {
    const { s, p } = ports(null)
    const answer = await saveClaudeToken(p, FAKE)
    expect(answer.ok).toBe(true)
    expect(s.text).toContain(FAKE)
    expect(JSON.stringify(answer)).not.toContain(FAKE)
  })

  it('refused: a bad prefix, by rule and never the value', async () => {
    const { s, p } = ports(null)
    const answer = await saveClaudeToken(p, 'wrong-token-value')
    expect(answer.ok).toBe(false)
    expect(s.text).toBeNull()
    expect(JSON.stringify(answer)).not.toContain('wrong-token-value')
  })

  it('names the board process when its environment wins', async () => {
    const { p } = ports(null, { LINGTAI_CLAUDE_OAUTH_TOKEN: 'x', NODE_ENV: 'test' })
    const answer = await saveClaudeToken(p, FAKE)
    expect(answer.say).toContain("the board process's")
    expect(JSON.stringify(answer)).not.toContain(FAKE)
  })

  it('reads whether one is set on every call', () => {
    const { s, p } = ports(null)
    expect(claudeTokenSetAt(p)).toEqual({ environment: false, file: false })
    s.text = `claude:\n  oauth_token: ${FAKE}\n`
    expect(claudeTokenSetAt(p)).toEqual({ environment: false, file: true })
  })
})
