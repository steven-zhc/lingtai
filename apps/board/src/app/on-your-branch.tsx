import { Effect } from 'effect'
import type { ReactNode } from 'react'

import { ticketsOnGitHub } from '@/lib/pr-page'
import { readOnBranch } from '@/lib/prs'
import { whereOnBranch, type OnBranchLanding, type WhereOnBranch } from '@/lib/task'

import { BranchSketch } from './branch-sketch.tsx'

/** The facts a person asks of a team's landed ticket: In, Merge commit, Closed when, A change to it (#1323). */
export function OnYourBranchView({ where }: { where: WhereOnBranch }) {
  const { change } = where
  return (
    <div className="obs" data-part="on-your-branch">
      <BranchSketch sketch={where.sketch} />
      <div className="obs-side">
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
    </div>
  )
}

/**
 * The one read behind the section (#1513): the heading's tag, the panel and the `who` sentence all decide from what it
 * returns, so it is started once by the page and awaited by each. `null` on a solo project and on a landing the personal
 * branch does not own.
 */
export async function whereItIs(
  project: string,
  ticket: string,
  landing: OnBranchLanding,
): Promise<WhereOnBranch | null> {
  const read = await Effect.runPromise(readOnBranch(project))
  if (read.kind === 'none') return null
  return whereOnBranch({
    ticket,
    landing,
    project,
    owner: read.owner,
    github: ticketsOnGitHub(read.recipe),
    branch: { main: read.recipe.branch.main, personal: read.recipe.branch.personal ?? read.recipe.branch.main },
    read: read.read,
  })
}

const HEADING = 'ssectiontitle sec-h'

/** What a section shows until the read is back, and when it came back empty: the heading, with no tag. */
export function WhereHeading() {
  return <h2 className={HEADING}>Where it is</h2>
}

/** The heading with its tag, and the panel under it; the bare heading when the read found nothing. */
export async function OnYourBranch({ read }: { read: Promise<WhereOnBranch | null> }) {
  const where = await read
  if (where === null) return <WhereHeading />
  return (
    <>
      <h2 className={HEADING}>
        Where it is <span className={`obs-tag obs-tag--${where.tone}`}>{where.small}</span>
      </h2>
      <OnYourBranchView where={where} />
    </>
  )
}

/** The `who` sentence, only when there is no panel to say it (#1513). */
export async function SentenceUnlessPanel({
  read,
  children,
}: {
  read: Promise<WhereOnBranch | null>
  children: ReactNode
}) {
  return (await read) === null ? <>{children}</> : null
}
