/**
 * `classify`'s table (0108 §19): each row reads its platform's own words, and
 * row order is the precedence the callers used to spread over `if`s.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { FAILURE_ROWS, classify, unreachableCause } from '../src/failure/classify.ts'
import { spliceRecognised } from '../src/failure/doc.ts'
import { rerunInPlace } from '../src/failure/respond.ts'

const git = (text: string) => classify({ platform: 'git', text })?.kind ?? null
const github = (
  status: number,
  text: string,
  limits: { ratelimitRemaining?: number | null; retryAfter?: number | null } = {},
) => classify({ platform: 'github', status, text, ...limits })?.kind ?? null
const runtime = (text: string) => {
  const said = classify({ platform: 'runtime', text })
  return said === null ? null : `${said.kind}:${said.platform === 'runtime' ? said.runtime : ''}`
}

describe('classify', () => {
  it.each([
    ['! [remote rejected] HEAD -> main (protected branch hook declined)', 'base-protected'],
    ['remote: error: GH013: Repository rule violations found', 'base-protected'],
    [' ! [rejected]        HEAD -> main (fetch first)', 'push-rejected'],
    [' ! [remote rejected]   HEAD -> agent/1 (Bad Gateway)', 'remote-error'],
    ["fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host", 'unreachable'],
  ])('reads git: %s', (text, kind) => expect(git(text)).toBe(kind))

  it('reads GitHub by status, and a 403 only with its words', () => {
    expect(github(429, 'x')).toBe('rate-limited')
    expect(github(403, 'API rate limit exceeded')).toBe('rate-limited')
    expect(github(403, 'Resource not accessible by integration')).toBeNull()
    expect(github(404, 'rate limit')).toBeNull()
    expect(github(403, 'Resource not accessible', { ratelimitRemaining: 0 })).toBe('rate-limited')
    expect(github(403, '', { ratelimitRemaining: 0 })).toBe('rate-limited')
    expect(github(403, 'Resource not accessible', { retryAfter: 60 })).toBe('rate-limited')
    expect(github(403, 'Resource not accessible', { ratelimitRemaining: 42 })).toBeNull()
    expect(github(403, 'secondary rate limit', { ratelimitRemaining: 42 })).toBe('rate-limited')
    expect(github(403, 'Resource not accessible', { ratelimitRemaining: null, retryAfter: null })).toBeNull()
  })

  it("reads each runtime's own sentence", () => {
    expect(runtime("You've hit your monthly spend limit")).toBe('account-limit:claude-code')
    expect(runtime('your session limit resets 11pm')).toBe('account-limit:claude-code')
    expect(runtime("You've hit your usage limit")).toBe('account-limit:codex')
  })

  it.each([
    'API Error: 500 {"type":"error"}',
    'API Error: 502 Bad Gateway',
    'API Error: 503 Service Unavailable',
    'API Error: 504 Gateway Timeout',
    'Repeated 529 Overloaded errors',
    'Request timed out',
    'No response from API',
    'Server is temporarily limiting requests',
    'Request rejected (429) · this is a temporary capacity limit',
    '<title>Attention Required! | Cloudflare</title>',
  ])('reads a transient sentence: %s', (text) => expect(runtime(text)).toBe('transient:claude-code'))

  it('does not read a bare 403 or a 4xx as transient', () => {
    expect(runtime('API Error: 403 Forbidden')).toBeNull()
    expect(runtime('API Error: 400 invalid_request_error')).toBeNull()
    expect(runtime('403')).toBeNull()
  })

  it('lets the account wall win over a transient number in the same detail', () => {
    expect(runtime("You've hit your monthly spend limit (API Error: 503)")).toBe('account-limit:claude-code')
  })

  it('answers null for empty text and for words no row reads', () => {
    expect(git('')).toBeNull()
    expect(git('fatal: something nobody listed')).toBeNull()
    expect(runtime('')).toBeNull()
  })

  it('lets a real rejection win over a transient reading', () => {
    // `[remote rejected] … (protected branch hook declined)` also satisfies a looser reading of the frame.
    expect(git('RPC failed\n ! [remote rejected] HEAD -> main (protected branch hook declined)')).toBe('base-protected')
    expect(git('early EOF\n ! [rejected] HEAD -> main (fetch first)')).toBe('push-rejected')
  })

  it("matches Codex's account wall before Claude Code's", () => {
    expect(runtime("You've hit your usage limit")).toBe('account-limit:codex')
  })

  it('keeps git rows in precedence order', () => {
    const order = FAILURE_ROWS.filter((r) => r.platform === 'git').map((r) => r.kind)
    expect(order).toEqual(['base-protected', 'push-rejected', 'remote-error', 'unreachable'])
  })

  it('keeps Codex ahead of Claude Code among runtime rows', () => {
    const order = FAILURE_ROWS.filter((r) => r.platform === 'runtime').map((r) =>
      r.platform === 'runtime' ? r.runtime : '',
    )
    expect(order[0]).toBe('codex')
  })
})

describe('doc/design/platform-errors.md', () => {
  it('commits the section it would write', () => {
    const doc = readFileSync(fileURLToPath(new URL('../../../doc/design/platform-errors.md', import.meta.url)), 'utf8')
    expect(
      doc === spliceRecognised(doc),
      'doc/design/platform-errors.md is stale — run `pnpm docs:errors` and commit it',
    ).toBe(true)
  })
})

describe('unreachableCause (#1131)', () => {
  const HUNG = 'fatal: the remote end hung up unexpectedly'
  it.each(['', ' (after 3 tries)'])('tells the causes apart%s', (tail) => {
    expect(unreachableCause(HUNG + tail)).toBe('origin-or-size')
    expect(unreachableCause(`${HUNG}\nConnection reset by peer${tail}`)).toBe('origin')
    expect(unreachableCause(`remote: fatal: pack exceeds maximum allowed size\n${HUNG}${tail}`)).toBe('size')
    expect(unreachableCause(`fatal: early EOF${tail}`)).toBe('origin')
  })
})

describe('rerunInPlace', () => {
  it('waits 1, 5 and 15 minutes, then stops at the limit', () => {
    const waits = [0, 1, 2, 3].map((spent) => rerunInPlace('crash', 'API Error: 503', spent)?.wait ?? null)
    expect(waits).toEqual(['1 minute', '5 minutes', '15 minutes', null])
  })

  it('is never for a timeout, an abort, or words no transient row reads', () => {
    expect(rerunInPlace('timeout', 'API Error: 503', 0)).toBeNull()
    expect(rerunInPlace('aborted', 'API Error: 503', 0)).toBeNull()
    expect(rerunInPlace('crash', 'something else', 0)).toBeNull()
  })
})
