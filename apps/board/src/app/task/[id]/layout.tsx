import type { AttemptRef } from '@lingtai/domain/wait'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'

import { Home } from '@/app/home.tsx'
import { theHome } from '@/lib/home'
import { billText, spendChip } from '@/lib/spend'
import { defaultTabOf } from '@/lib/tabs'
import { knowable, loadTask, loadTaskAnswer, type TaskAnswer, type TaskDetail } from '@/lib/task'
import { measure } from '@/lib/timing'
import { TimingMeta } from '@/lib/timing-meta'

import type { Answered } from '../../deferred.tsx'
import { FooterFetched } from '../../footer-fetched'
import { Follow, Following } from '../../live.tsx'
import { LegacyFragment, RecordTabRow } from '../../record-tab-row.tsx'
import { DeferredCoords, DeferredStanding, detailClass } from '../../standing.tsx'

/**
 * The top of the task page, and the frame the record's tabs sit in.
 *
 * Everything here is reduced from the event stream when the page is opened —
 * nothing on this page is maintained in a table ([0012]). That is the trade the
 * card makes: the list stays cheap and scannable, and the detail is as rich as
 * it needs to be because it costs a read that happens rarely.
 *
 * **It opens with the answer, and the rest is a record** (#152). The page is
 * opened because something stopped, and it has one job: say *what* stopped,
 * *why*, and *what you can do*. That is `standing.tsx`. Every identifier is in
 * the bar, once (`Coords`).
 *
 * **The record is a layout and its children** (#885, 0118 §2). This is the
 * layout: the bar, `Standing` and the tab row, and `loadTask` with all its
 * reads. The tab — the Ticket or one attempt — is a child page with a loader of
 * its own. Next does not re-render a layout on a navigation, so switching tabs
 * reads none of what is here: that is the whole point of the split, and the
 * child's loader must never call `loadTask`.
 */
export const dynamic = 'force-dynamic'

const shellArg = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** The current wait's failed publish, with a command only for the recorded commit. */
export function UnpushedBanner({
  unpushed,
  mirror,
}: {
  unpushed: AttemptRef['unpushed'] | null
  mirror: TaskDetail['unpushedMirror']
}) {
  if (!unpushed) return null
  const kept = unpushed.keptAt
  const command =
    kept?._tag === 'Mirror' && mirror?.sha === kept.sha
      ? `git -C ${shellArg(mirror.path)} push origin ${shellArg(`+${kept.ref}:${kept.arm}`)}`
      : null

  return (
    <aside className="unpushed" role="alert" data-rank="unpushed">
      <strong>Unpushed work</strong>
      <p>
        Git could not push <code>{unpushed.branch}</code>: {unpushed.said}
      </p>
      {kept?._tag === 'Mirror' ? (
        <>
          <p>
            {mirror === null || mirror.sha === null
              ? `The kept ref ${kept.ref} is no longer in the mirror.`
              : command === null
                ? `The kept ref ${kept.ref} no longer names the recorded commit in the mirror.`
                : `The commits are kept in the local mirror at ${kept.ref} (${kept.sha}).`}
          </p>
          {command === null ? null : (
            <>
              <pre>
                <code>{command}</code>
              </pre>
              <p>This command uses your own git credentials to push to origin.</p>
            </>
          )}
        </>
      ) : kept?._tag === 'Arm' ? (
        <p>The commits are on origin at {kept.ref}.</p>
      ) : (
        <p>The commits were not kept.</p>
      )}
    </aside>
  )
}

/**
 * The page, given what `loadTask` reduced. Apart from the route so a test can
 * render the whole arrangement without a database (#152).
 */
function WaitingNav({ waiting }: { waiting: TaskDetail['waiting'] }) {
  const link = (n: NonNullable<TaskDetail['waiting']['next']>, label: string, arrow: string) => (
    <Link
      href={`/task/${encodeURIComponent(n.taskId)}`}
      title={`${label}: #${n.issue} ${n.title}`}
      aria-label={`${label}: #${n.issue} ${n.title}`}
      style={{
        maxWidth: '24ch',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {arrow === '←' ? `← #${n.issue} ${n.title}` : `#${n.issue} ${n.title} →`}
    </Link>
  )
  return (
    <>
      {waiting.previous ? link(waiting.previous, 'previous waiting', '←') : null}
      {waiting.next ? link(waiting.next, 'next waiting', '→') : null}
    </>
  )
}

export function TaskBody({
  task,
  github,
  now,
  children,
}: {
  task: TaskDetail
  /**
   * What only the issue's answer knows — resolved, or the promise `loadTaskAnswer`
   * returned (0118 §2). Each place that reads it draws *asking GitHub…* until it
   * arrives; a test passes the resolved value and sees what the page sees then.
   */
  github: Answered<TaskAnswer>
  now?: number
  children?: ReactNode
}) {
  // The issue the controls would act on. `ref` is GitHub's own number, so
  // anything that does not parse is an id that was never one.
  const ref = Number(task.ticket?.ref)
  const issueNumber = Number.isSafeInteger(ref) && ref > 0 ? ref : null
  // Every attempt's `costUsd` and `totals` below are off `spend` — this page's
  // own reduce, not the board's. Silent while it reduced cleanly, the same `#498`
  // posture every other reading on this bar takes; the sentence only when it
  // did not, because `unknown (1 run)` otherwise reads exactly like a ticket
  // that predates `RunSpent` (`#498`'s review).
  const spendCurrency = spendChip(task.spendCurrency)

  return (
    <>
      <main className={detailClass(task.standing.state, Boolean(task.standing.afterMove))}>
        <div className="bar">
          <Link className="brand" href="/">
            ← Lingtai
            <Home {...theHome()} />
          </Link>
          <span className="sep" />
          {/* Rank 8: one muted line, each identifier once. */}
          <DeferredCoords standing={task.standing} taskId={task.taskId} answer={github} />
          <WaitingNav waiting={task.waiting} />
          {spendCurrency.current ? null : (
            <span className={`chip ${spendCurrency.tone}`} title={spendCurrency.title}>
              {spendCurrency.label}
            </span>
          )}
          {/* Nothing while the page follows the log; the sentence when it stopped. */}
          <Following />
        </div>

        {/* A link written before the record had tabs, `#attempt-N` or
          `#record-ticket`, is sent to the tab it meant. */}
        <LegacyFragment taskId={task.taskId} />

        <div className="detail-body">
          <UnpushedBanner unpushed={task.standing.unpushed} mirror={task.unpushedMirror} />
          {/* Ranks 1 to 6: the answer, and the moves, on the first screen. */}
          <DeferredStanding
            answer={github}
            untouched={task.events === 0}
            standing={task.standing}
            // What is being decided about, named where the decision is. The log
            // carries the ref and the title; GitHub carries the URL, and a null
            // one is a page that still says which ticket this is.
            subject={
              task.ticket
                ? {
                    ref: task.ticket.ref,
                    title: task.ticket.title,
                    url: task.ticket.url,
                    askedGitHub: false,
                  }
                : null
            }
            inFlight={task.inFlight}
            startEstimate={task.startEstimate}
            want={task.want}
            compareUrl={task.ticket?.compareUrl ?? null}
            taskId={task.taskId}
            discussions={task.discussions}
            discussionBill={task.totals.byPurpose.Discussion}
            project={task.ticket?.project ?? null}
            // The controls act on a GitHub issue. An id that is not `ticket-<p>-<n>`
            // has none, and the block states the state without offering a move.
            issue={issueNumber}
            // The attempt the state names, which for a running item is the run
            // in flight — the one `loadTask` reduced with the recipe's bounds.
            progress={task.runs.find((r) => r.runId === task.standing.runId)?.progress ?? null}
            // The same budget line the board's card draws under its own rail —
            // `loadTask`'s, so the two cannot word one ticket's hold two ways.
            held={task.held}
            now={now}
          />

          <section className="record" data-rank="record">
            <RecordTabRow
              taskId={task.taskId}
              attempts={task.runs.map((r) => ({
                attempt: r.attempt,
                outcome: r.outcome.state,
                cost: billText(r.costUsd),
              }))}
              deciding={task.standing.state === 'blocked' ? (task.standing.deciding?.attempt ?? null) : null}
              events={task.events}
              fallback={defaultTabOf(task.standing, task.runs)}
            />
            <div className="rbody">{children}</div>
          </section>
        </div>
      </main>
      <FooterFetched project={task.ticket?.project ?? undefined} />
    </>
  )
}

export default async function TaskLayout({
  params,
  children,
}: {
  params: Promise<{ id: string }>
  children: ReactNode
}) {
  const { id } = await params
  const taskId = decodeURIComponent(id)
  // **A 404 rests on what needs no GitHub** (0118 §2, #113): an id that is not
  // `ticket-<project>-<n>`, or a project Lingtai was never told about.
  if (!(await knowable(taskId))) notFound()
  // Started here, before `loadTask` is awaited, in a `measure` of its own: the
  // page is sent when the log and the database have answered, and what only the
  // issue's answer knows streams in after it. Started inside `loadTask` its reads
  // would be under `page /task`, which ends before they do. Never rejects.
  const github = measure(() => loadTaskAnswer(taskId), { label: '/task github' }).then(([answer]) => answer)
  const [task, timings] = await measure(() => loadTask(taskId), { label: '/task' })
  if (!task) notFound()
  return (
    <>
      <TimingMeta timings={timings} />
      {/* Subscribed to the log, so an append re-renders this page and not only
          the board. Without it a question, the trace's sentence and the answer
          each waited for a reload, and every comment that said *every append
          re-renders* was true of `/` alone (#172). Around the bar and the tab
          both, so `Following` in the bar reads its context and one append
          refreshes both segments. On the layout and not in `TaskBody`, which a
          test renders with no router to refresh. */}
      <Follow>
        <TaskBody task={task} github={github}>
          {children}
        </TaskBody>
      </Follow>
    </>
  )
}
