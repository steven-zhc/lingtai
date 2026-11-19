/**
 * **An `Unclear` implement's judge is shown the questions** (#1250): the evidence the dispatch
 * carried is prose, clipped wherever it was clipped, and the router renders the declared
 * questions itself — text, answers and the recommended one.
 */
import { offerFor } from '@lingtai/domain'
import type { Proposal } from '@lingtai/domain'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import type { Judging } from '../src/attempt-steps.ts'
import { judgePrompt } from '../src/judge-agent.ts'
import { replyFor } from '../src/proposed-route.ts'

const policy = { refusalFixes: 2, newAttempts: 1, conflictResolutions: 2 }
const proposal: Proposal = {
  _tag: 'InputNeeded',
  from: 'implement',
  questions: [
    {
      id: 'q1',
      text: 'Which retention policy should be implemented?',
      answers: [
        { id: 'a', text: 'Keep thirty days' },
        { id: 'b', text: 'Keep forever' },
      ],
      recommended: 'a',
    },
  ],
}

describe('replyFor at needs-input from implement', () => {
  it('hands the judge every question and answer, however long the prose in front of them was', async () => {
    const seen: Judging[] = []
    const prose = 'I changed the store and wrote the tests. '.repeat(40)
    await Effect.runPromise(
      replyFor(
        offerFor(proposal, policy, { rounds: 0, newAttempts: 0 }),
        { findings: [], evidence: prose.slice(0, 500) },
        (on) => {
          seen.push(on)
          return Effect.succeed({ noJudge: true })
        },
      ),
    )
    expect(seen).toHaveLength(1)
    const prompt = judgePrompt(seen[0]!)
    expect(prompt).toContain('Which retention policy should be implemented?')
    expect(prompt).toContain('Keep thirty days (recommended)')
    expect(prompt).toContain('Keep forever')
  })
})
