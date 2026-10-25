import { afterEach, describe, expect, it } from 'vitest'

import { triageCheckoutEnv } from '../src/triage-checkout.ts'

describe('the environment handed to a tool-enabled triage run', () => {
  afterEach(() => {
    delete process.env['LINGTAI_DATABASE_URL']
  })

  it('carries an explicit CODEX_HOME unchanged', () => {
    const env = triageCheckoutEnv({ HOME: '/home/u', CODEX_HOME: '/elsewhere/codex' }, '/tmp/private')
    expect(env['CODEX_HOME']).toBe('/elsewhere/codex')
    expect(env['HOME']).toBe('/tmp/private')
  })

  it('points at the real ~/.codex, never one under the private home, so a refreshed login is kept', () => {
    const env = triageCheckoutEnv({ HOME: '/home/u' }, '/tmp/private')
    expect(env['CODEX_HOME']).toBe('/home/u/.codex')
    expect(env['CODEX_HOME']).not.toContain('/tmp/private')
  })

  it('passes no LINGTAI_* value, the daemon credentials', () => {
    process.env['LINGTAI_DATABASE_URL'] = 'postgres://secret'
    const env = triageCheckoutEnv({ HOME: '/home/u' }, '/tmp/private')
    expect(Object.keys(env).filter((key) => key.startsWith('LINGTAI_'))).toEqual([])
  })
})
