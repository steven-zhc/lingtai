import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { copilotTokenRow, readCopilotToken } from '../src/doctor.ts'

describe('copilotTokenRow', () => {
  it('says set', async () => {
    expect(await Effect.runPromise(copilotTokenRow(() => Effect.succeed('set')))).toMatchObject({
      name: 'copilot: token',
      status: 'ok',
      detail: 'set',
    })
  })

  it('fails on a classic token, naming it and never a value', async () => {
    const row = await Effect.runPromise(copilotTokenRow(() => Effect.succeed('classic')))
    expect(row.status).toBe('fail')
    expect(row.detail).toContain('classic')
    expect(row.detail).toContain('ghp_')
    expect(row.detail).toContain('Copilot ignores')
  })

  it('unset is ok with how to make one when no sandboxed project names copilot, a fail when one does', async () => {
    const quiet = await Effect.runPromise(
      copilotTokenRow(
        () => Effect.succeed('unset'),
        () => Effect.succeed(false),
      ),
    )
    expect(quiet.status).toBe('ok')
    expect(quiet.detail).toContain('copilot.github_token')
    const named = await Effect.runPromise(
      copilotTokenRow(
        () => Effect.succeed('unset'),
        () => Effect.succeed(true),
      ),
    )
    expect(named.status).toBe('fail')
    expect(named.detail).toContain('LINGTAI_COPILOT_GITHUB_TOKEN')
  })

  it('classifies without leaving the value, and keeps the reader sentence for an unreadable file', async () => {
    expect(
      await Effect.runPromise(
        readCopilotToken({ LINGTAI_COPILOT_GITHUB_TOKEN: 'ghp_x', LINGTAI_HOME: '/nonexistent' }),
      ),
    ).toBe('classic')
    expect(
      await Effect.runPromise(
        readCopilotToken({ LINGTAI_COPILOT_GITHUB_TOKEN: 'github_pat_x', LINGTAI_HOME: '/nonexistent' }),
      ),
    ).toBe('set')
    const home = mkdtempSync(join(tmpdir(), 'copilot-token-'))
    try {
      mkdirSync(join(home, 'config.yml'))
      const row = await Effect.runPromise(copilotTokenRow(() => readCopilotToken({ LINGTAI_HOME: home })))
      expect(row.status).toBe('fail')
      expect(row.detail).toContain('so copilot.github_token is unknown')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
