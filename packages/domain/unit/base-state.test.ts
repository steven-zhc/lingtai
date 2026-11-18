import { describe, expect, it } from 'vitest'

import type { Envelope } from '../src/envelope.ts'
import { baseStateOf } from '../src/integration.ts'

const builds = () => [
  { name: 'tests', run: 'pnpm test' },
  { name: 'types', run: 'pnpm typecheck' },
]

const checked = (command: string, ok: boolean, extra: Record<string, unknown> = {}): Envelope =>
  ({
    type: 'BaseChecked',
    data: {
      base: 'main',
      baseSha: 'a'.repeat(40),
      command,
      ok,
      exitCode: ok ? 0 : 1,
      durationMs: 1,
      evidence: ok ? '' : 'boom',
      runId: 'r1',
      ...extra,
    },
  }) as unknown as Envelope

describe('baseStateOf (#1208)', () => {
  it('is not red with nothing recorded', () => {
    expect(baseStateOf([], builds)).toEqual({ notRed: 'none' })
  })

  it('is not red when the newest record is green', () => {
    expect(baseStateOf([checked('pnpm test', true)], builds)).toEqual({ notRed: 'green' })
  })

  it('is red at the record, naming the action, command, commit and boundary', () => {
    expect(baseStateOf([checked('pnpm test', false, { boundary: 'sb-1' })], builds)).toMatchObject({
      red: {
        action: 'tests',
        command: 'pnpm test',
        base: 'main',
        baseSha: 'a'.repeat(40),
        boundary: 'sb-1',
        runId: 'r1',
        firstRedSha: 'a'.repeat(40),
        key: `base-red:main:${'a'.repeat(40)}`,
        fix: null,
      },
    })
  })

  it('reads a record with no boundary as unsandboxed', () => {
    const state = baseStateOf([checked('pnpm typecheck', false)], builds)
    expect(state).toMatchObject({ red: { action: 'types', boundary: 'unsandboxed' } })
  })

  it('is green again when a later record is green: the newest decides', () => {
    expect(baseStateOf([checked('pnpm test', false), checked('pnpm test', true)], builds)).toEqual({ notRed: 'green' })
  })

  it('is not red when the red command is no longer a run: action the recipe builds', () => {
    expect(baseStateOf([checked('pnpm old', false)], builds)).toEqual({ notRed: 'not-built' })
  })
})
