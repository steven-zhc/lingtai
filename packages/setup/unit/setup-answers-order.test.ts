import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { previewSetup } from '../src/apply-setup.ts'
import { type SetupForm, setupAnswers } from '../src/setup-answers.ts'

/** #978: the preview a person reads lists the steps in the order the loop reaches them. */
describe('the preview of a new GitHub recipe', () => {
  it('lists prepared, implement, build, review, proposed, end in that order', async () => {
    const form: SetupForm = {
      project: 'repo',
      target: { kind: 'github', owner: 'o', repo: 'r' } as SetupForm['target'],
      base: 'main',
      remote: null,
      install: 'pnpm install',
      checks: [{ name: 'test', run: 'pnpm test' }],
      writer: 'claude-code',
      reviewer: 'claude-code',
      tickets: 'github',
      kinds: ['bug'],
      heldBy: '',
      closeOnEnd: true,
      personApprovesMerge: true,
      limits: { turns: 50, wall: '1h', rounds: 3, restarts: 2 },
      turnsUnbounded: false,
    }
    const files = { read: () => Promise.resolve(null), replace: () => Promise.resolve() }
    const text = await Effect.runPromise(previewSetup({ home: '/h/.lingtai', files }, setupAnswers(form)))
    const at = ['prepared', 'implement', 'build', 'review', 'proposed', 'end'].map((k) => text.indexOf(`\n  ${k}:`))
    expect(at.every((i) => i > 0)).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
  })
})
