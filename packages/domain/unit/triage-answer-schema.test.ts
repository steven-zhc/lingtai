/**
 * `TRIAGE_ANSWER_JSON_SCHEMA` (#582): the bounds a runtime enforces are the
 * zod ones, generated rather than written beside them.
 */
import { describe, expect, it } from 'vitest'

import { READS_PER_TURN, TRIAGE_TEXT_MAX } from '../src/triage.ts'
import { TRIAGE_ANSWER_JSON_SCHEMA, unwrapTriageEnvelope } from '../src/wait.ts'

type Node = Record<string, any>
const schema = TRIAGE_ANSWER_JSON_SCHEMA as Node
const answer: Node = schema.properties.answer.anyOf[0]
const causes: Node[] = answer.properties.cause.oneOf

describe('TRIAGE_ANSWER_JSON_SCHEMA', () => {
  it('is an object at the root with no generator statement, both keys required', () => {
    expect(schema.type).toBe('object')
    expect(schema).not.toHaveProperty('$schema')
    expect(schema.required).toEqual(expect.arrayContaining(['read', 'answer']))
    expect(schema.properties.read.anyOf[0].maxItems).toBe(READS_PER_TURN)
  })

  it('carries the six causes as a oneOf of _tag consts', () => {
    expect(causes.map((c) => c.properties._tag.const).sort()).toEqual(
      ['ConflictingHunks', 'FixableLines', 'SetupBroken', 'TicketTooBig', 'UndecidedQuestion', 'WrongApproach'].sort(),
    )
  })

  it('bounds fixes[].what at TRIAGE_TEXT_MAX', () => {
    const lines = causes.find((c) => c.properties._tag.const === 'FixableLines')!
    expect(lines.properties.fixes.items.properties.what.maxLength).toBe(TRIAGE_TEXT_MAX)
  })
})

describe('unwrapTriageEnvelope', () => {
  it('gives the read shape when read is filled, the answer otherwise', () => {
    expect(unwrapTriageEnvelope({ read: ['a:b'], answer: null })).toEqual({ read: ['a:b'] })
    expect(unwrapTriageEnvelope({ read: null, answer: { x: 1 } })).toEqual({ x: 1 })
  })
})
