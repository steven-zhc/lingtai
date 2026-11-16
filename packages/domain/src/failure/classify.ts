/**
 * What a platform's or a tool's words mean — the *classify* step of 0108 §19.
 *
 * The packages that meet a failure hand what they saw to `classify` and read the
 * kind; none keeps a pattern of its own. Nothing here does IO.
 *
 * **Row order is precedence.** `classify` answers the first row of the seen
 * platform that matches, and no row carries an exclusion for another: *a real
 * rejection wins over `unreachable` and `remote-error`* is the order of the git
 * rows, and *Codex's account wall is matched before Claude Code's looser one* is
 * the order of the runtime rows. A table that sorts its rows, or tries
 * `unreachable` first, turns a protected-branch refusal into three retries.
 *
 * Git's rows read English stderr, which `gitInvocation` forces with `LC_ALL=C`
 * (`packages/repo/src/git.ts`).
 */
import type { RuntimeId } from '../events.ts'

/** What was seen, and by whom. The caller hands over words; it never says what they mean. */
export type Seen =
  | { readonly platform: 'git'; readonly text: string }
  | { readonly platform: 'github'; readonly status: number; readonly text: string }
  /** A runtime's own words. Which runtime wrote them is the answer, not the question. */
  | { readonly platform: 'runtime'; readonly text: string }

export type Classified =
  | {
      readonly platform: 'git'
      readonly kind: 'base-protected' | 'push-rejected' | 'remote-error' | 'unreachable'
    }
  | { readonly platform: 'github'; readonly kind: 'rate-limited' }
  | { readonly platform: 'runtime'; readonly kind: 'account-limit'; readonly runtime: RuntimeId }

/** The waits between tries: three tries in all, so the count is never written apart from the list. */
export const UNREACHABLE_WAITS: readonly `${number} seconds`[] = ['10 seconds', '30 seconds']

interface RowBase {
  /** What the generated page says the row recognises. */
  readonly says: string
}

interface GitRow extends RowBase {
  readonly platform: 'git'
  readonly kind: 'base-protected' | 'push-rejected' | 'remote-error' | 'unreachable'
  readonly pattern: RegExp
  /** The waits a caller retries after, for the transient kinds. */
  readonly waits?: readonly `${number} seconds`[]
}

interface GitHubRow extends RowBase {
  readonly platform: 'github'
  readonly kind: 'rate-limited'
  readonly status: number
  /** Without one, the status alone matches. */
  readonly pattern?: RegExp
}

interface RuntimeRow extends RowBase {
  readonly platform: 'runtime'
  readonly kind: 'account-limit'
  readonly runtime: RuntimeId
  readonly pattern: RegExp
}

export type FailureRow = GitRow | GitHubRow | RuntimeRow

/**
 * The rows, in the order they are tried within a platform.
 *
 * The runtime rows match the runtimes' own account-limit sentences and nothing
 * looser: a word like *limit* turns up in a test's output and in an agent's
 * prose (#655). The sentence is looked for as a substring, because a fix round
 * and a drafting agent wrap it in their own.
 */
export const FAILURE_ROWS: readonly FailureRow[] = [
  {
    platform: 'git',
    kind: 'base-protected',
    // GitHub's words for *this branch is protected*: a classic rule and a ruleset. Never retried,
    // because nothing a later push does can lift a setting (#662).
    pattern: /protected branch hook declined|GH006|GH013|repository rule violations/i,
    says: '`GH006`, `GH013`, `protected branch hook declined` and `repository rule violations`: the base is protected, and nothing a later push does can lift a setting. Refused as `base-protected`, never retried.',
  },
  {
    platform: 'git',
    kind: 'push-rejected',
    // The bracketed reason differs — `fetch first`, `non-fast-forward` — and the wording has moved
    // between versions, so what is matched is the rejection itself rather than any one cause of it.
    pattern: /\[rejected\]|non-fast-forward|fetch first|updates were rejected/i,
    says: '`[rejected]`, `non-fast-forward`, `fetch first` and `updates were rejected`: somebody else got there first.',
  },
  {
    platform: 'git',
    kind: 'remote-error',
    // Git's own frame for *the server answered the ref with a 5xx* (#1125). Only RFC 9110's phrases
    // for 500, 502, 503 and 504 are read; `pre-receive hook declined` arrives on the same line and
    // is not transient. No `$` anchor: `retryUnreachable` appends ` (after N tries)` to the detail.
    pattern:
      /^\s*!\s+\[remote rejected\]\s+\S+\s+->\s+\S+\s+\((Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\)/im,
    waits: UNREACHABLE_WAITS,
    says: 'a `[remote rejected] … (Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)` line: the server answered a push with a 5xx. Retried after 10 s and 30 s, then refused as `remote-error`.',
  },
  {
    platform: 'git',
    kind: 'unreachable',
    // Git's English words for *origin did not answer* (#1029). Any wording not listed is not
    // transient, and reads as it always did.
    pattern:
      /unable to access '|Could not resolve host|Could not connect to server|Failed to connect to|Operation timed out|Connection timed out|Connection reset|Connection refused|Recv failure|Send failure|early EOF|RPC failed|The requested URL returned error: 5\d\d|remote end hung up unexpectedly|SSL_ERROR_SYSCALL|gnutls_handshake/i,
    waits: UNREACHABLE_WAITS,
    says: "git could not reach origin — `unable to access '`, `Could not resolve host`, `Connection timed out`, `early EOF`, `RPC failed`, `remote end hung up unexpectedly`, `The requested URL returned error: 5\\d\\d` and the other wordings listed in the table. Retried after 10 s and 30 s, then refused as `unreachable`.",
  },
  {
    platform: 'github',
    kind: 'rate-limited',
    status: 429,
    says: 'a status of 429.',
  },
  {
    platform: 'github',
    kind: 'rate-limited',
    status: 403,
    pattern: /rate limit/i,
    says: 'a status of 403 whose detail says `rate limit`: GitHub is throttling rather than refusing.',
  },
  {
    // Codex, first: it says `You've hit your usage limit` as well as `You have hit …`,
    // and Claude Code's looser pattern below would claim the first form.
    platform: 'runtime',
    kind: 'account-limit',
    runtime: 'codex',
    pattern: /\bYou(?:(?:'|’)ve| have) hit your usage limit\b/i,
    says: "`You've hit your usage limit` and `You have hit your usage limit`.",
  },
  {
    // Claude Code: `You've hit your monthly spend limit`, `…session limit`, `…weekly limit`.
    platform: 'runtime',
    kind: 'account-limit',
    runtime: 'claude-code',
    pattern: /\bYou(?:'|’)ve hit your (?!usage limit)[a-z ]{0,30}limit\b/i,
    says: "`You've hit your … limit`, other than the usage limit Codex says.",
  },
  {
    platform: 'runtime',
    kind: 'account-limit',
    runtime: 'claude-code',
    pattern: /\byour session limit resets\b/i,
    says: '`your session limit resets`.',
  },
]

/**
 * What `seen` means, or null when no row reads it. Null is never read as
 * transient: the caller does what it did before there was a row.
 */
export function classify(seen: Seen): Classified | null {
  if (seen.text === '') return null
  for (const row of FAILURE_ROWS) {
    if (row.platform !== seen.platform) continue
    if (row.platform === 'github') {
      if (seen.platform !== 'github' || seen.status !== row.status) continue
      if (row.pattern !== undefined && !row.pattern.test(seen.text)) continue
      return { platform: 'github', kind: row.kind }
    }
    if (!row.pattern.test(seen.text)) continue
    if (row.platform === 'git') return { platform: 'git', kind: row.kind }
    return { platform: 'runtime', kind: row.kind, runtime: row.runtime }
  }
  return null
}

/** The ref a `[remote rejected]` line names, or null when the text has no such frame. */
export function remoteErrorRef(text: string): string | null {
  const m = /^\s*!\s+\[remote rejected\]\s+\S+\s+->\s+(\S+)/im.exec(text)
  return m?.[1]?.replace(/^refs\/heads\//, '') ?? null
}
