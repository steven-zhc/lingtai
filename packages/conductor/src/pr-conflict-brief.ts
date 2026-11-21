/**
 * What the conflict agent of a PR is told, and what its reviewer is (#1313, 0130 §6). Pure: every read is the caller's,
 * and **a read that failed arrives as `{ failed }` and is said as *could not be read*, never as *nothing*** — an empty
 * section would tell the agent that nobody touched the path.
 *
 * The brief is the PR's counterpart of `fixBriefParts`, which is briefed on one ticket; a PR's conflict is between
 * several tickets and the commits `main` brought.
 */

/** A ticket the PR holds (or, for a merge back, one landed since the freeze) whose merge touched a conflicted path. */
export interface OursTicket {
  readonly number: string
  readonly title: string
  readonly mergeCommit: string
  /** The body as it was claimed; `{ failed }` says why it could not be read. */
  readonly body: string | { readonly failed: string }
  /** The conflicted paths this ticket's own merge touched. */
  readonly touched: readonly string[]
}

/** A commit on the other side that touched a conflicted path. */
export interface TheirsCommit {
  readonly sha: string
  readonly author: string
  readonly subject: string
}

export type Read<T> = readonly T[] | { readonly failed: string }

export interface ConflictBrief {
  readonly merging: 'main' | 'back'
  /** The branch merged into: the PR branch for a sync, `branch.personal` for the merge back. */
  readonly into: string
  /** What is merged in: `main` for a sync, the PR branch for the merge back. */
  readonly from: string
  readonly commit: string
  readonly paths: readonly string[]
  readonly ours: Read<OursTicket>
  readonly theirs: Read<TheirsCommit>
  readonly round: number
  readonly bound: number
  /** The refusal that bought this round: the build's output, or the review's blocking findings, verbatim (0108 §5). */
  readonly refusal: { readonly step: 'build' | 'review' | 'answer'; readonly said: string } | null
}

const short = (sha: string): string => sha.slice(0, 7)

const failed = <T>(read: Read<T>): read is { readonly failed: string } => !Array.isArray(read)

/** The two sides, as lines: the same text the resolver and its reviewer are both given. */
export function sidesOf(brief: ConflictBrief): string {
  const ours = failed(brief.ours)
    ? [`(could not be read: ${brief.ours.failed})`]
    : brief.ours.length === 0
      ? ['(no ticket the branch holds touched these paths)']
      : brief.ours.map((t) => {
          const body = typeof t.body === 'string' ? t.body.trim() : `(body could not be read: ${t.body.failed})`
          return [
            `- #${t.number} ${t.title} (merged as ${short(t.mergeCommit)}; touched ${t.touched.join(', ')})`,
            ...(body === '' ? [] : [body.replace(/^/gm, '    ')]),
          ].join('\n')
        })
  const theirs = failed(brief.theirs)
    ? [`(could not be read: ${brief.theirs.failed})`]
    : brief.theirs.length === 0
      ? ['(no commit touched these paths)']
      : brief.theirs.map((c) => `- ${short(c.sha)} ${c.subject} (${c.author})`)
  return [
    `## What ${brief.into} meant — the tickets whose code conflicts`,
    ...ours,
    '',
    `## What ${brief.from} meant — the commits that brought the other side`,
    ...theirs,
  ].join('\n')
}

/** The prompt of one round of the conflict agent, as parts a `recordPrompt` takes. */
export function prConflictBrief(brief: ConflictBrief): string[] {
  const merge = `${brief.from} at ${short(brief.commit)} into ${brief.into}`
  return [
    `You are resolving a merge conflict: ${merge}. This is round ${brief.round} of ${brief.bound}.`,
    '\n\n',
    `The merge is already stood up in this directory (\`git merge --no-commit --no-ff ${brief.commit}\`), with its ` +
      'conflict markers in the files. Resolve every marker so that **both** sides keep what they meant, then finish ' +
      'the merge with `git commit --no-edit`. Do not reset, rebase or change the merge’s parents: the commit you leave ' +
      `must have exactly two parents, ${brief.into} and ${short(brief.commit)}, and no merge may be left in progress.`,
    '\n\n',
    `Conflicted paths:\n${brief.paths.map((p) => `- ${p}`).join('\n')}`,
    '\n\n',
    sidesOf(brief),
    ...(brief.refusal === null
      ? []
      : [
          '\n\n',
          `## Why the last resolution was refused (${brief.refusal.step})\n${brief.refusal.said}\n\n` +
            'Fix what it names, in the resolution this directory stands in.',
        ]),
  ]
}

/** The prompt of the reviewer of a resolution: its remerge diff, and the two sides it had to keep. */
export function prReviewBrief(brief: ConflictBrief, diff: string, clipped: boolean): string[] {
  return [
    `You are reviewing the resolution of a merge conflict: ${brief.from} at ${short(brief.commit)} into ${brief.into}.`,
    '\n\n',
    'Below is what the resolver changed **beyond** git’s own merge (`git show --remerge-diff`). Judge whether it ' +
      'keeps what both sides meant, builds, and invents nothing. Answer with JSON only: ' +
      '`{"findings":[{"severity":"blocker"|"major"|"minor","file":string,"line":number|null,"claim":string,' +
      '"failureScenario":string}]}` — an empty list passes; a blocker or a major refuses it.',
    '\n\n',
    `Conflicted paths:\n${brief.paths.map((p) => `- ${p}`).join('\n')}`,
    '\n\n',
    sidesOf(brief),
    '\n\n',
    `## The resolution${clipped ? ' (clipped: it is longer than the reviewer reads whole)' : ''}\n`,
    diff,
  ]
}
