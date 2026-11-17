/**
 * **A red then green that is not this diff's** (0108 §17, #1222) — the one rule that lets a refusing `run:` check
 * go on after its first run failed, and the claim vocabulary of the findings it files.
 *
 * `flakyVerdict` is pure: the conductor does the reads (the diff's paths, the base's records, the backlog) and
 * hands them over, a read that failed as `null`. **Null is never *not flaky*** — it is red, saying which read.
 *
 * **The claim is half of a backlog key** (`findingKey`: issue, step, action, file, claim), so it carries the test
 * and the command and never a sha or an attempt: the same flake on a later attempt must land on the same row.
 * The sha and the output are in `failureScenario`.
 */
import type { Finding } from '../vocabulary.ts'
import { failingTestsOf } from './tests.ts'

/** What every flaky finding's claim begins with. */
export const FLAKY_CLAIM_PREFIX = 'flaky: '
const CLAIM_MIDDLE = ' failed then passed on a rerun of `'

/** The claim for one flaky test: `flaky: <entry> failed then passed on a rerun of `<command>``. */
export const flakyClaim = (entry: string, command: string): string =>
  `${FLAKY_CLAIM_PREFIX}${entry}${CLAIM_MIDDLE}${command}\``

/** The test entry a flaky claim names, or null when the claim is not one. The last boundary wins: an entry may hold any text. */
export function flakyEntryOf(claim: string): string | null {
  if (!claim.startsWith(FLAKY_CLAIM_PREFIX) || !claim.endsWith('`')) return null
  const at = claim.lastIndexOf(CLAIM_MIDDLE)
  if (at < FLAKY_CLAIM_PREFIX.length) return null
  return claim.slice(FLAKY_CLAIM_PREFIX.length, at)
}

/** True of exactly the findings `flakyVerdict` makes. */
export const isFlakyFinding = (f: Pick<Finding, 'severity' | 'claim'>): boolean =>
  f.severity === 'minor' && flakyEntryOf(f.claim) !== null

/** A `BaseChecked` of the same command, on any commit: what condition 3 reads. */
export interface BaseRecord {
  readonly sha: string
  readonly ok: boolean
  readonly evidence: string
  readonly flaky?: readonly string[]
}

/** A backlog row, as far as condition 3 reads it. */
export interface BacklogRow {
  readonly file: string
  readonly claim: string
  readonly key?: string
  readonly status?: string
}

export interface FlakyInput {
  readonly command: string
  /** The first run's evidence: where the failing tests are named. */
  readonly first: string
  /** The paths this ticket's diff changes; null when it could not be read. */
  readonly diffPaths: readonly string[] | null
  /** Why the diff could not be read, when it could not. */
  readonly diffWhy?: string
  /** The base's records of this command; null when they could not be read. */
  readonly baseRecords: readonly BaseRecord[] | null
  /** Every backlog row of the project; null when they could not be read. */
  readonly backlog: readonly BacklogRow[] | null
  /** The head sha, for the findings' scenario. Absent when it could not be read; not a reason for red. */
  readonly head?: string
}

export type FlakyVerdict =
  | { readonly passed: true; readonly evidence: string; readonly findings: Finding[] }
  | { readonly passed: false; readonly evidence: string }

const fileOf = (entry: string): string => entry.split(' > ')[0] as string

/** A diff path names a test's file when it is that path, or that path under the directory the check ran in. */
const inDiff = (paths: readonly string[], file: string): boolean =>
  paths.some((p) => p === file || p.endsWith(`/${file}`))

export function flakyVerdict(input: FlakyInput): FlakyVerdict {
  const red = (why: string): FlakyVerdict => ({
    passed: false,
    evidence: `red then green; not let through because ${why}\n${input.first}`,
  })

  const names = failingTestsOf(input.first)
  if (names === null) return red('the failing tests could not be named')

  // Condition 2: no failing test's file is in this diff.
  if (input.diffPaths === null) return red(`the diff could not be read${input.diffWhy ? ` (${input.diffWhy})` : ''}`)
  for (const entry of names) {
    if (inDiff(input.diffPaths, fileOf(entry))) return red(`${fileOf(entry)} is in this diff`)
  }

  // Condition 3: every failing test has failed on the base before, or the backlog already names it.
  if (input.baseRecords === null) return red('the base check records could not be read')
  if (input.backlog === null) return red('the backlog could not be read')
  const proofs: string[] = []
  for (const entry of names) {
    let proof: string | null = null
    for (const r of input.baseRecords) {
      const seen = r.ok ? false : (failingTestsOf(r.evidence)?.includes(entry) ?? false)
      const flaky = r.flaky?.includes(entry) ?? false
      if (seen || flaky) {
        proof = `${entry}: ${flaky && !seen ? 'flaky' : 'failed'} in BaseChecked on ${r.sha.slice(0, 7)}`
        break
      }
    }
    if (proof === null) {
      const row = input.backlog.find((b) => flakyEntryOf(b.claim) === entry)
      if (row !== undefined) {
        proof = `${entry}: backlog row ${row.key ?? '(unkeyed)'}${row.status ? ` (${row.status})` : ''}`
      }
    }
    if (proof === null) return red(`${entry} has not failed on the base before`)
    proofs.push(proof)
  }

  const failLines = input.first.split('\n').filter((l) => /^\s*FAIL\s/.test(l))
  const findings: Finding[] = names.map((entry) => {
    const own = failLines.filter((l) => l.includes(entry)).map((l) => l.trim())
    return {
      file: fileOf(entry),
      line: null,
      claim: flakyClaim(entry, input.command),
      failureScenario: [input.head === undefined ? null : `head ${input.head}`, ...(own.length === 0 ? [entry] : own)]
        .filter((l): l is string => l !== null)
        .join('\n'),
      severity: 'minor',
    }
  })
  return {
    passed: true,
    evidence: ['red then green; let through as flaky:', ...proofs].join('\n'),
    findings,
  }
}
