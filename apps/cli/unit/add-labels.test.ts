import { resolveSource } from '@lingtai/recipe'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { ensureLabelsEffect, labelNames } from '../src/add-labels.ts'

const recipe = (mode: 'solo' | 'team', kinds: string) =>
  resolveSource(
    `
version: 2
${mode === 'team' ? 'mode: team\nbranch: { main: main, personal: lingtai-team }\npr: {}' : 'branch: { main: main }'}
repo: { submodules: false }
source: { kinds: ${kinds}, exclude: [], ${mode === 'team' ? 'assignee: { login: me }' : ''} }
env: { required: [], plantAt: .env.local }
steps: {}
runtime: { agent: claude-code, limits: { run: { turns: 10, wall: 2m }, attempt: { refusalFixes: 2, conflictResolutions: 2 }, ticket: { newAttempts: 0 } } }
`,
    'r.yml',
    'r.yml',
  ).recipe

describe('the labels add makes (#1486)', () => {
  it('a team recipe asks for its kinds, lingtai:hold and lingtai:pr-fix', () => {
    expect(labelNames(recipe('team', '[bug, feature]'))).toEqual(['bug', 'feature', 'lingtai:hold', 'lingtai:pr-fix'])
  })

  it('a solo recipe never asks for lingtai:pr-fix', () => {
    expect(labelNames(recipe('solo', '[bug, feature]'))).toEqual(['bug', 'feature', 'lingtai:hold'])
  })

  it('a name repeated in another case is asked once, in its first spelling', () => {
    expect(labelNames(recipe('solo', '[Bug, bug]'))).toEqual(['Bug', 'lingtai:hold'])
  })

  it('records created, existed and missing per name, and a 403 stops nothing', async () => {
    const asked: string[] = []
    const out = await Effect.runPromise(
      ensureLabelsEffect(
        Effect.succeed({
          createLabel: async (name: string) => {
            asked.push(name)
            if (name === 'feature') throw Object.assign(new Error('forbidden'), { status: 403 })
            if (name === 'net') throw new Error('socket hang up')
            return name === 'bug' ? ('exists' as const) : ('created' as const)
          },
        }),
        ['bug', 'feature', 'net', 'lingtai:hold'],
      ),
    )
    expect(asked).toEqual(['bug', 'feature', 'net', 'lingtai:hold'])
    expect(out).toEqual({
      created: ['lingtai:hold'],
      existed: ['bug'],
      missing: [
        { name: 'feature', why: 'denied' },
        { name: 'net', why: 'unchecked' },
      ],
    })
  })
})
