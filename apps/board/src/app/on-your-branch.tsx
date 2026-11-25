import { Effect } from 'effect'

import { ticketsOnGitHub } from '@/lib/pr-page'
import { readOnBranch } from '@/lib/prs'
import { whereOnBranch, type OnBranchLanding, type WhereOnBranch } from '@/lib/task'

import { BranchSketch } from './branch-sketch.tsx'

/** The facts a person asks of a team's landed ticket: In, Merge commit, Closed when, A change to it (#1323). */
export function OnYourBranchView({ where }: { where: WhereOnBranch }) {
  const { change } = where
  return (
    <div className="obs" data-part="on-your-branch">
      <p className="obs-poster">
        <span className="prp-small">{where.small}</span>
      </p>
      <BranchSketch sketch={where.sketch} />
      <dl className="obs-facts">
        <dt>In</dt>
        <dd className={where.in.failed ? 'obs-fail' : undefined}>
          {where.in.text}
          {where.in.host === null ? null : (
            <>
              {' '}
              <a href={where.in.host} target="_blank" rel="noreferrer">
                ↗
              </a>
            </>
          )}
          {where.in.page === null ? null : (
            <>
              {' · '}
              <a href={where.in.page}>PR page →</a>
            </>
          )}
        </dd>
        <dt>Merge commit</dt>
        <dd>
          <code>{where.mergeCommit.sha}</code> on <code>{where.mergeCommit.on}</code>
          {where.mergeCommit.inBranch === null ? null : (
            <>
              {' · in '}
              <code>{where.mergeCommit.inBranch}</code>
            </>
          )}
        </dd>
        <dt>Closed when</dt>
        <dd>
          {where.closedWhen}
          {where.alsoCloses === null ? null : <> ({where.alsoCloses})</>}
        </dd>
        {change === null ? null : (
          <>
            <dt>A change to it</dt>
            <dd>
              is a new ticket ·{' '}
              {change.kind === 'link' ? (
                <a href={change.href} target="_blank" rel="noreferrer">
                  New pr-fix ticket ↗
                </a>
              ) : (
                <>
                  <code>{change.command}</code> — {change.note}
                </>
              )}
            </dd>
          </>
        )}
      </dl>
      {where.notes.map((n) => (
        <p key={n} className="obs-note">
          {n}
        </p>
      ))}
    </div>
  )
}

/**
 * The streamed part. `null` on a solo project and on a landing the personal branch does not own, so those pages are the
 * markup they were (the Suspense fallback is empty, so a solo page gains no visible region).
 */
export async function OnYourBranch({
  project,
  ticket,
  landing,
}: {
  project: string
  ticket: string
  landing: OnBranchLanding
}) {
  const read = await Effect.runPromise(readOnBranch(project))
  if (read.kind === 'none') return null
  const where = whereOnBranch({
    ticket,
    landing,
    project,
    owner: read.owner,
    github: ticketsOnGitHub(read.recipe),
    branch: { main: read.recipe.branch.main, personal: read.recipe.branch.personal ?? read.recipe.branch.main },
    read: read.read,
  })
  return where === null ? null : <OnYourBranchView where={where} />
}
