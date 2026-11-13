/**
 * `question` as the tests wrote it before `validate` returned an Effect: a promise `validate`, a promise result.
 * The lift keeps a rejection as the error it threw, so a `validate` that throws still propagates.
 */
import { Effect } from 'effect'

import { type Answered, type Question, type QuestionWorld, questionEffect } from '../src/question.ts'
import { liftPort } from './first-project-world.ts'

export type PromiseValidated = Omit<Question, 'validate'> & {
  validate?: (answer: string) => Promise<string | null>
}

export function question(world: QuestionWorld, q: PromiseValidated): Promise<Answered> {
  const { validate, ...rest } = q
  return Effect.runPromise(
    questionEffect(world, validate === undefined ? rest : { ...rest, validate: liftPort(validate) }),
  )
}
