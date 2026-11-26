import type { AttemptRef } from '@lingtai/domain/wait'
import { hasGitHubAuth } from '@lingtai/env'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'

import { Bar, BarActions } from '@/app/bar.tsx'
import { LockBanner, pauseSlot } from '@/app/lock-banner.tsx'
import { filterOptions, onBoardProjects } from '@/lib/board'
import { lockMap, type LockMap } from '@/lib/lock-marks.ts'
import { readProjectLocks, readRegistered } from '@/lib/locks.ts'
import { ticketIdOf, ticketPath, ticketRefOf } from '@/lib/paths'
import { placeViewsOf } from '@/lib/prs.ts'
import { sandboxStates, type SandboxState } from '@/lib/sandbox-state.ts'
import { billText, spendChip } from '@/lib/spend'
import { defaultTabOf } from '@/lib/tabs'
import { knowable, loadTask, loadTaskAnswer, type TaskAnswer, type TaskDetail } from '@/lib/task'
import { measure } from '@/lib/timing'
import { TimingMeta } from '@/lib/timing-meta'

import { Deferred, type Answered } from '../../../../deferred.tsx'
import { FilterMenu } from '../../../../filter-menu.tsx'
import { FooterFetched } from '../../../../footer-fetched'
import { Follow, Following } from '../../../../live.tsx'
import { PlaceLine, viewsFor, type PlaceView } from '../../../../place-line.tsx'
import { filterSummary, filterTitle, ProjectRows } from '../../../../projects.tsx'
import { LegacyFragment, RecordTabRow } from '../../../../record-tab-row.tsx'
import { DeferredStanding, detailClass } from '../../../../standing.tsx'

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
 * *why*, and *what you can do*. That is `standing.tsx`. The bar ends in `#<n>`
 * and every identifier is in the facts line, once.
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
      href={ticketPath(n.taskId)}
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

/** What the project menu is drawn from: read for the page by the layout, never by `TaskBody`. */
export interface MenuInputs {
  filters: string[]
  registered: readonly string[]
  locks: LockMap
  sandbox: ReadonlyMap<string, SandboxState>
  app: boolean
  /** Why the project list could not be read, or null: the menu says so in place of its rows. */
  error: string | null
}

/**
 * The project menu: the summary (the project's name) is drawn at once, and its rows come through a `Deferred` of their
 * own, as `/` streams them. No inputs draws no menu, and the crumb is the name as text.
 */
function menuOf(project: string | undefined, menu: Answered<MenuInputs | null> | undefined) {
  if (project === undefined || menu === undefined || menu === null) return undefined
  return (
    <FilterMenu className="filter" summary={filterSummary(project)} title={filterTitle(project)}>
      <Deferred value={menu} fallback={null}>
        {(m) =>
          m === null ? null : m.error !== null ? (
            <p className="pr-refusal" role="alert">
              The list of projects could not be read: {m.error}
            </p>
          ) : (
            <ProjectRows
              filters={m.filters}
              only={project}
              app={m.app}
              registered={m.registered}
              locks={m.locks}
              sandbox={m.sandbox}
            />
          )
        }
      </Deferred>
    </FilterMenu>
  )
}

export function TaskBody({
  task,
  github,
  views,
  menu,
  now,
  registered = false,
  pause,
  banner,
  children,
}: {
  task: TaskDetail
  /** Whether the ticket's project is registered, so its `Recipe` has a page. */
  registered?: boolean
  /** The bar's Pause button and the row under it, built by the layout that read the locks (#994): this stays sync. */
  pause?: ReactNode
  banner?: ReactNode
  /**
   * What only the issue's answer knows — resolved, or the promise `loadTaskAnswer`
   * returned (0118 §2). Each place that reads it draws its shape until it
   * arrives (0111 §15); a test passes the resolved value and sees what the page sees then.
   */
  github: Answered<TaskAnswer>
  /** The place line's views: `PRs` only for a team project, and its count is a GitHub read, so it streams (#1500). */
  views?: Answered<PlaceView[]>
  /** What the project menu is built from; `null` (or absent) draws the project's name as text. */
  menu?: Answered<MenuInputs | null>
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
  // did not, because `unpriced (1 run)` otherwise reads exactly like a ticket
  // that predates `RunSpent` (`#498`'s review).
  const spendCurrency = spendChip(task.spendCurrency)
  const project = task.ticket?.project ?? undefined
  // The tail is the ticket's number; never `#NaN` or the internal id.
  const n = issueNumber ?? Number(ticketRefOf(task.taskId)?.issue)
  const tail = Number.isSafeInteger(n) && n > 0 ? `#${n}` : undefined

  return (
    <>
      <main className={detailClass(task.standing.state, Boolean(task.standing.afterMove))}>
        <Bar
          project={project}
          registered={registered}
          pause={pause}
          actions={
            project !== undefined && registered ? <BarActions project={project} pause={pause} recipe={false} /> : null
          }
        >
          <Deferred
            value={views ?? viewsFor(project)}
            fallback={
              <PlaceLine
                project={project}
                views={viewsFor(project)}
                here="tickets"
                tail={tail}
                menu={menuOf(project, menu)}
                pendingAfter="tickets"
              />
            }
          >
            {(v) => <PlaceLine project={project} views={v} here="tickets" tail={tail} menu={menuOf(project, menu)} />}
          </Deferred>
          <WaitingNav waiting={task.waiting} />
          {/* Nothing while the page follows the log; the sentence when it stopped. */}
          <Following />
        </Bar>
        {banner}

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
            totals={task.totals}
            firstClaimAt={task.runs[0]?.at ?? null}
            spend={spendCurrency}
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
      <FooterFetched />
    </>
  )
}

export default async function TaskLayout({
  params,
  children,
}: {
  params: Promise<{ project: string; n: string }>
  children: ReactNode
}) {
  const { project: projectSegment, n } = await params
  const taskId = ticketIdOf(projectSegment, n)
  if (taskId === null) notFound()
  // **A 404 rests on what needs no GitHub** (0118 §2, #113): an id that is not
  // `ticket-<project>-<n>`, or a project Lingtai was never told about.
  // Each stage is a `measure`, since only a `page ` span is re-parented onto the request (#1361);
  // the `notFound()` calls stay outside, so Next's throw is not a failed stage.
  const [known] = await measure(() => knowable(taskId), { label: '/task preflight' })
  if (!known) notFound()
  // Started here, before `loadTask` is awaited, in a `measure` of its own: the
  // page is sent when the log and the database have answered, and what only the
  // issue's answer knows streams in after it. Started inside `loadTask` its reads
  // would be under `page /task`, which ends before they do. Never rejects.
  const github = measure(() => loadTaskAnswer(taskId), { label: '/task github' }).then(([answer]) => answer)
  // The place line's reads start with the page's and are never awaited here: `PRs` asks GitHub on a team project, and
  // the first byte must not wait for it. Neither promise rejects (`Deferred`).
  const project0 = ticketRefOf(taskId)?.project
  const views = placeViewsOf(project0).catch(() => viewsFor(project0, { waiting: null }))
  const [[task, timings], listing] = await Promise.all([
    measure(() => loadTask(taskId), { label: '/task' }),
    measure(() => readRegistered(), { label: '/task projects' }).then(
      ([registered]) => ({ projects: registered, error: null as string | null }),
      (err: unknown) => ({
        projects: [] as Awaited<ReturnType<typeof readRegistered>>,
        error: err instanceof Error ? err.message : String(err),
      }),
    ),
  ])
  if (!task) notFound()
  const projects = listing.projects
  const project = task.ticket?.project ?? undefined
  const registered = project !== undefined && projects.some((p) => p.project === project)
  // The locks are read here, under their own stage, and the menu below reuses that read (`readProjectLocks` is cached).
  const [pause] = await measure(() => pauseSlot(project), { label: '/task locks' })
  // The menu's other reads start here, after the registered listing this page already awaited (not read twice), and
  // stream: a failure is said in the menu, in place of its rows, and never fails the page.
  const menu: Promise<MenuInputs | null> = Promise.all([onBoardProjects(), readProjectLocks()])
    .then(([onBoard, locks]) => {
      const names = projects.map((p) => p.project).filter((p): p is string => p !== null)
      return {
        filters: filterOptions(names, onBoard),
        registered: names,
        locks: lockMap(locks),
        sandbox: sandboxStates(projects),
        app: hasGitHubAuth(),
        error: listing.error,
      }
    })
    .catch((err: unknown): MenuInputs => ({
      filters: [],
      registered: [],
      locks: new Map(),
      sandbox: new Map(),
      app: false,
      error: err instanceof Error ? err.message : String(err),
    }))
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
        <TaskBody
          task={task}
          github={github}
          views={views}
          menu={menu}
          registered={registered}
          pause={pause}
          banner={<LockBanner project={project} />}
        >
          {children}
        </TaskBody>
      </Follow>
    </>
  )
}
