import { readFileSync } from 'node:fs'

/**
 * A requeue's note is optional; an answer's is not (#424).
 *
 * `Requeue` serves three moves off one submit button — Answer, Withdraw and
 * Back to the queue — and only the first writes an `AnswerRecord` a later
 * attempt's prompt keeps (`attempts.ts:572`). Withdraw and Back to the queue
 * both go through `requeueCard` → `requeue()`, whose note the fold either
 * discards (`withdrawn`) or never reads as an answer, so a person who
 * answered through triage already is not asked to restate it. Asserted at the
 * source, the way `close.test.tsx` pins `Close`'s own disable rule: there is
 * no browser in the gate.
 */
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('Requeue', () => {
  it('disables its button for a blank note only while answering', () => {
    const source = read('../src/app/decide.tsx')
    const requeue = source.slice(source.indexOf('export function Requeue'), source.indexOf('export function Close'))

    expect(requeue).toMatch(/disabled=\{\(asked && !withdrawing && !note\.trim\(\)\) \|\| pending\}/)
  })

  it('says the box may be left empty, on Withdraw and Back to the queue', () => {
    const source = read('../src/app/decide.tsx')
    const requeue = source.slice(source.indexOf('export function Requeue'), source.indexOf('export function Close'))

    expect(requeue).toContain('Why withdraw it? (optional)')
    expect(requeue).toContain('Why? (optional)')
  })
})

describe('requeueCard', () => {
  it('carries no blank-note refusal', () => {
    const source = read('../src/app/actions.ts')
    const action = source.slice(
      source.indexOf('export async function requeueCard'),
      source.indexOf('export async function closeCard'),
    )

    expect(action).not.toContain('say why, so the log can')
    expect(action).not.toMatch(/if \(!input\.note\.trim\(\)\)/)
  })
})

describe('Close', () => {
  it('still refuses a blank reason and seeds from a prefill', () => {
    const source = read('../src/app/decide.tsx')
    const close = source.slice(source.indexOf('export function Close'))

    expect(close).toMatch(/disabled=\{!reason\.trim\(\) \|\| pending\}/)
    expect(close).toMatch(/useState\(prefill \?\? ''\)/)
  })
})
