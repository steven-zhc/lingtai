/**
 * `ReviewAnswer` and the schema generated from it (`#369`).
 *
 * The invariants pinned here are the ones both runtime flags need to be true
 * of the generated JSON: `codex exec --output-schema`'s strict mode refuses
 * an optional property and refuses a schema without `additionalProperties:
 * false` at every object level, so a change to `ReviewAnswer` that loses
 * either is a schema that fails at request time rather than at `pnpm test`.
 */
import { describe, expect, it } from 'vitest'

import { REVIEW_ANSWER_JSON_SCHEMA, SEVERITIES, REFUSED_ABOUT, ReviewAnswer } from '../src/index.ts'

describe('REVIEW_ANSWER_JSON_SCHEMA', () => {
  it('parses as an object schema with no generator statement left in it', () => {
    expect(REVIEW_ANSWER_JSON_SCHEMA.type).toBe('object')
    // Stripped, because it is a statement about the generator and not about
    // the answer, and a binary that balks at an unknown top-level key would
    // refuse the whole schema over it.
    expect(REVIEW_ANSWER_JSON_SCHEMA).not.toHaveProperty('$schema')
  })

  it('requires every key at the top level — findings and about, both', () => {
    expect(REVIEW_ANSWER_JSON_SCHEMA.required).toEqual(expect.arrayContaining(['findings', 'about']))
    expect(REVIEW_ANSWER_JSON_SCHEMA.required).toHaveLength(2)
  })

  it('refuses an unknown key at the top level', () => {
    expect(REVIEW_ANSWER_JSON_SCHEMA.additionalProperties).toBe(false)
  })

  const findingSchema = () => {
    const findings = REVIEW_ANSWER_JSON_SCHEMA.properties as Record<string, unknown>
    const array = findings.findings as Record<string, unknown>
    return array.items as Record<string, unknown>
  }

  it('requires every key on a finding — none of the five is optional', () => {
    const finding = findingSchema()
    expect(finding.required).toEqual(expect.arrayContaining(['file', 'line', 'claim', 'failureScenario', 'severity']))
    expect(finding.required).toHaveLength(5)
  })

  it('refuses an unknown key on a finding', () => {
    expect(findingSchema().additionalProperties).toBe(false)
  })

  it("admits null on a finding's line, rather than refusing it", () => {
    const line = (findingSchema().properties as Record<string, unknown>).line as Record<string, unknown>
    const branches = line.anyOf as Record<string, unknown>[]
    expect(branches.some((b) => b.type === 'null')).toBe(true)
  })

  it("carries severity's own ladder, rather than a copy of it", () => {
    const severity = (findingSchema().properties as Record<string, unknown>).severity as { enum: string[] }
    expect(severity.enum).toEqual(SEVERITIES)
  })

  it("carries about's two words and admits null, rather than making it optional", () => {
    const about = (REVIEW_ANSWER_JSON_SCHEMA.properties as Record<string, unknown>).about as Record<string, unknown>
    const branches = about.anyOf as Record<string, unknown>[]
    const words = branches.find((b) => Array.isArray(b.enum)) as { enum: string[] }
    expect(words.enum).toEqual(REFUSED_ABOUT)
    expect(branches.some((b) => b.type === 'null')).toBe(true)
  })
})

describe('ReviewAnswer', () => {
  it('parses a schema-shaped answer, about included as null', () => {
    const parsed = ReviewAnswer.parse({ findings: [], about: null })
    expect(parsed).toEqual({ findings: [], about: null })
  })

  it('refuses a finding with an extra key, which the strict mode forbids', () => {
    expect(() =>
      ReviewAnswer.parse({
        findings: [{ file: 'x.ts', line: null, claim: 'c', failureScenario: 'f', severity: 'minor', extra: true }],
        about: null,
      }),
    ).toThrow()
  })
})
