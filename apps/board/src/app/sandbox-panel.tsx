/**
 * The Sandbox tab's parts and the small state mark (#1161). Shared with the recipe page's sandbox section (S9b) and
 * the marks elsewhere (S9c), so it takes `SandboxView` as props and imports nothing of the task page's loader.
 * A server component: nothing here is interactive, and the view module reaches `node:path`.
 */
import Link from 'next/link'

import type {
  Chip,
  Mark,
  PathRoots,
  PolicyDiffers,
  ReachSet,
  RefusalReading,
  RunRow,
  SandboxView,
  Summary,
  Tone,
} from '@/lib/sandbox-view'
import {
  CLAUDE_CODE_AUTH,
  chipsOf,
  clockOf,
  foldChips,
  legendOf,
  NOT_COVERED,
  policyLetter,
  reachOf,
  summaryOf,
  TOKEN_MEANING,
  vendorGroupsOf,
} from '@/lib/sandbox-view'

import { SandboxShield } from './sandbox-shield.tsx'

const TONE_CLASS: Record<Tone, string> = { ok: 'pass', muted: 'empty', signal: 'hold', fail: 'fail' }

/** The state mark. Its name is the state word and never *safe*. */
export function SandboxMark({ mark }: { mark: Mark }) {
  return (
    <span className={`sbmark ${TONE_CLASS[mark.tone]}`} title={mark.why ?? undefined}>
      {mark.state}
    </span>
  )
}

function Refusals({ reading }: { reading: RefusalReading }) {
  switch (reading.kind) {
    case 'refused':
      return (
        <span className={reading.incomplete ? 'fail' : undefined}>
          {reading.count} refused{reading.incomplete ? ' or more (the list is incomplete)' : ''}
        </span>
      )
    case 'none refused':
      return <span>none refused</span>
    case 'none recorded':
      return <span>none recorded</span>
    case 'pending':
      return <span className="empty">refusals are read when the run ends</span>
    case 'lost':
      return <span className="fail">refusals were not read: the run ended inside this step</span>
    case 'unreadable':
      return <span className="fail">refusals could not be read ({reading.reason})</span>
    case 'not applicable':
      return <span className="empty">—</span>
  }
}

const TONE_SHIELD = { ok: 'sandboxed', muted: 'off', signal: 'degraded', fail: 'stopped' } as const

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** The sentence the summary opens with. `attempt` is null where the caller does not know it. */
function headlineOf(s: Summary, attempt: number | null): string {
  const of = attempt === null ? 'this attempt' : `attempt ${attempt}`
  switch (s.state) {
    case 'none':
      return 'No wrapped run was recorded for this attempt.'
    case 'off':
      return 'This attempt ran without the sandbox: the recipe turns it off'
    case 'all':
      return `Every run of ${of} ran inside the sandbox`
    case 'some':
      return `${s.sandboxed} of ${s.total} runs of ${of} ran inside the sandbox`
  }
}

/** **An unknown is never a number**: where any run's refusals are unknown the figure says *or more*, or says nothing countable. */
function refusedFigure(r: Summary['refused']): string {
  if (r.count === 0 && r.unknownRuns > 0) return `refusals unknown for ${plural(r.unknownRuns, 'run', 'runs')}`
  // `none recorded` is also what a failed append leaves, so a total with such a run in it is what was recorded.
  if (!r.orMore && r.unrecordedRuns > 0) return r.count === 0 ? 'no refusal recorded' : `${r.count} recorded as refused`
  const n = `${r.count}${r.orMore ? ' or more' : ''}`
  return `${n} ${r.count === 1 && !r.orMore ? 'connection' : 'connections'} refused`
}

function SummaryBar({ summary, attempt }: { summary: Summary; attempt: number | null }) {
  const s = summary
  const unknown = s.refused.orMore || s.refused.unrecordedRuns > 0
  const line =
    s.state === 'none'
      ? null
      : s.state === 'all'
        ? [
            plural(s.total, 'run', 'runs'),
            s.srt === null ? null : s.srt === 'differs' ? 'srt differs per run' : `srt ${s.srt}`,
            "the merge is Lingtai's own and runs outside the sandbox",
          ]
            .filter((x) => x !== null)
            .join(' · ')
        : [
            s.why,
            s.srt === 'differs' ? 'srt differs per run' : s.srt === null ? null : `srt ${s.srt}`,
            "the merge is Lingtai's own and runs outside the sandbox",
          ]
            .filter((x) => x !== null)
            .join(' · ')
  return (
    <div className={`sbsummary sbx-${TONE_SHIELD[s.state === 'none' ? 'muted' : s.tone]}`}>
      <SandboxShield state={s.state === 'none' ? 'unknown' : TONE_SHIELD[s.tone]} />
      <div className="sbsummary-text">
        <p className="sbsummary-head">{headlineOf(s, attempt)}</p>
        {line === null ? null : <p className="mono empty">{line}</p>}
      </div>
      {s.state === 'none' ? null : (
        <div className="sbsummary-figs">
          <span className="sbfig">
            <b>
              {s.sandboxed}/{s.total}
            </b>
            <span>runs sandboxed</span>
          </span>
          <span className={`sbfig${s.refused.count > 0 || unknown ? ' hold' : ''}`}>
            <b>{refusedFigure(s.refused)}</b>
          </span>
        </div>
      )}
    </div>
  )
}

function KindCell({ row }: { row: RunRow }) {
  if (row.mark.state === 'not recorded') return <span className="empty">—</span>
  return row.runtime === null ? (
    <span className="sbtag">command</span>
  ) : (
    <span className="sbtag agent">
      <span aria-hidden="true">★ </span>agent · {row.runtime}
    </span>
  )
}

function RunTable({ rows, srtPerRun }: { rows: readonly RunRow[]; srtPerRun: boolean }) {
  return (
    <table className="sbrows">
      <thead>
        <tr>
          <th>step</th>
          <th>kind</th>
          <th>boundary</th>
          <th>policy</th>
          <th className="r">refused</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td className="mono">
              {r.step} · {r.action}
              {r.ordinal === null ? '' : ` #${r.ordinal}`}
            </td>
            <td>
              <KindCell row={r} />
            </td>
            <td>
              <SandboxMark mark={r.mark} />
              {r.mark.why === null ? null : <span className={TONE_CLASS[r.mark.tone]}> {r.mark.why}</span>}
              {srtPerRun && r.srtVersion !== null ? <span className="empty"> srt {r.srtVersion}</span> : null}
              {r.weakerNetwork ? <span className="hold"> weaker network isolation</span> : null}
            </td>
            <td>
              {r.policy === null ? (
                <span className="empty">—</span>
              ) : (
                <span className="sbletter" title={`policy ${r.policy}`}>
                  {policyLetter(r.policy)}
                </span>
              )}
            </td>
            <td className="r">
              <Refusals reading={r.refusals} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function stamped(href: string, stamp: number | undefined): string {
  if (stamp === undefined) return href
  const at = href.indexOf('#')
  const [path, hash] = at === -1 ? [href, ''] : [href.slice(0, at), href.slice(at)]
  return `${path}${path.includes('?') ? '&' : '?'}r=${stamp}${hash}`
}

/**
 * The refused connections and the sentences about the ones unknown, with no heading of its own: the task page's
 * *Blocked* section and the recipe page's *recently blocked* both draw it (S9b), the second from every task.
 */
export function BlockedList({
  blocked,
  stamp,
  empty = 'No refused connection was recorded.',
  time = 'iso',
}: {
  blocked: SandboxView['blocked']
  /** Added to each Allow link as `?r=` (before any `#`), so a click on the recipe page is a new command. */
  stamp?: number
  empty?: string
  /** `clock` is the task tab's `HH:MM:SS UTC` with the ISO time in `title`; the recipe page spans days and keeps the ISO time. */
  time?: 'iso' | 'clock'
}) {
  return (
    <>
      {blocked.caveats.map((c) => (
        <p key={c} className="fail">
          {c}
        </p>
      ))}
      {blocked.hosts.length === 0 ? (
        blocked.caveats.length === 0 ? (
          <p className="empty">{empty}</p>
        ) : null
      ) : (
        <div className="sbblocked">
          <table className="sbrows">
            <thead>
              <tr>
                <th>Host</th>
                <th>Refused</th>
                <th>By</th>
                <th>First</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {blocked.hosts.map((h) => (
                <tr key={h.label}>
                  <td className="mono">{h.label}</td>
                  <td>{h.count}×</td>
                  <td>{h.from.join(', ')}</td>
                  <td>
                    <time dateTime={h.firstAt} title={time === 'clock' ? h.firstAt : undefined}>
                      {time === 'clock' ? clockOf(h.firstAt) : h.firstAt}
                    </time>
                  </td>
                  <td>
                    {h.allowHref === null ? null : (
                      <Link
                        href={stamped(h.allowHref, stamp)}
                        prefetch={false}
                        className={time === 'clock' ? 'sbbtn' : undefined}
                      >
                        Allow on this project
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function ChipList({ chips }: { chips: readonly Chip[] }) {
  return (
    <>
      {chips.map((c) => (
        <code
          key={c.fulls[0]}
          className={`sbchip${c.token !== null && c.label === c.token ? ' short' : ''}`}
          title={c.members === undefined ? c.fulls.join(' = ') : c.members.map((m) => m.fulls.join(' = ')).join('\n')}
        >
          {c.label}
        </code>
      ))}
    </>
  )
}

function HostChips({ hosts }: { hosts: readonly string[] }) {
  return (
    <>
      {hosts.map((h) => (
        <code key={h} className="sbchip" title={h}>
          {h}
        </code>
      ))}
    </>
  )
}

function DenyChips({ entries }: { entries: readonly { chip: Chip; except: readonly Chip[] }[] }) {
  return (
    <>
      {entries.map((d) => (
        <span key={d.chip.fulls[0]}>
          <ChipList chips={[d.chip]} />
          {d.except.length === 0 ? null : (
            <span className="empty"> except {d.except.map((e) => e.label).join(', ')}, which can be read </span>
          )}
        </span>
      ))}
    </>
  )
}

function ReachBox({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div className="sbbox">
      <p className="sbbox-title">
        <span>{title}</span>
        <span className="empty">{count}</span>
      </p>
      {count === 0 ? <p className="empty">none recorded</p> : children}
    </div>
  )
}

/** A reach set's entries, each path as the chips `chipsOf` made for it, so the legend can be drawn from what was drawn. */
interface Named {
  domains: ReachSet['domains']
  writable: Chip[]
  denyRead: { chip: Chip; except: Chip[] }[]
  denyWrite: Chip[]
}

function PolicyDifference({
  d,
  named,
  lacks,
  exceptions,
  roots,
}: {
  roots: PathRoots
  d: PolicyDiffers
  named: Named
  lacks: Named
  exceptions: Named['denyRead']
}) {
  const parts: React.ReactNode[] = []
  const fold = (chips: readonly Chip[]) => foldChips(chips, roots)
  const push = (verb: string, chips: React.ReactNode, n: number) => {
    if (n > 0)
      parts.push(
        <span key={`${verb}`}>
          {verb} {chips}{' '}
        </span>,
      )
  }
  push('also reaches', <HostChips hosts={named.domains.map((x) => x.host)} />, named.domains.length)
  push('also writes', <ChipList chips={fold(named.writable)} />, named.writable.length)
  push('also cannot read', <DenyChips entries={named.denyRead} />, named.denyRead.length)
  push('also cannot write', <ChipList chips={fold(named.denyWrite)} />, named.denyWrite.length)
  push('does not reach', <HostChips hosts={lacks.domains.map((x) => x.host)} />, lacks.domains.length)
  push('does not write', <ChipList chips={fold(lacks.writable)} />, lacks.writable.length)
  // Not listing a denial is not holding a permission: another entry may cover the path, so these say only that.
  push('does not deny reading', <ChipList chips={fold(lacks.denyRead.map((x) => x.chip))} />, lacks.denyRead.length)
  push('does not deny writing', <ChipList chips={fold(lacks.denyWrite)} />, lacks.denyWrite.length)
  // Only the re-allowed paths are permitted; the root around them stays denied, so it is named as context and never as a permission.
  push(
    'also re-allows reading',
    <>
      {exceptions.map((x) => (
        <span key={x.chip.fulls[0]}>
          <ChipList chips={fold(x.except)} />
          <span className="empty"> inside {x.chip.label}, which stays denied </span>
        </span>
      ))}
    </>,
    exceptions.length,
  )
  return (
    <li>
      <span className="sbletter">{d.letter}</span> <span className="mono">{d.runs.join(', ')}</span>{' '}
      {parts.length === 0 ? <span className="empty">the set above, nothing more</span> : parts}
    </li>
  )
}

/** The attempt's recorded boundary, in the order the tab is read: what it was, what was blocked, the runs, what they could reach. */
export function SandboxPanel({
  view,
  roots = { home: '', lingtaiHome: '', project: '' },
  attempt = null,
}: {
  view: SandboxView
  /** What the short names of paths stand for; with none, every path is drawn as it was recorded. */
  roots?: PathRoots
  attempt?: number | null
}) {
  const { policies, blocked, rows } = view
  const summary = summaryOf(rows)
  const reach = summary.state === 'off' || policies.length === 0 ? null : reachOf(policies)

  const drawn: Chip[] = []
  const name = (paths: readonly string[]) => {
    const chips = chipsOf(paths, roots)
    drawn.push(...chips)
    return chips
  }
  const nameSet = (r: ReachSet): Named => ({
    domains: r.domains,
    writable: name(r.writable),
    denyRead: r.denyRead.map((d) => ({ chip: name([d.path])[0]!, except: name(d.except) })),
    denyWrite: name(r.denyWrite),
  })
  const common = reach === null ? null : nameSet(reach.common)
  const differs =
    reach === null
      ? []
      : reach.differs.map((d) => ({
          d,
          extra: nameSet(d.extra),
          lacks: nameSet(d.lacks),
          exceptions: nameSet({ domains: [], writable: [], denyRead: d.exceptions, denyWrite: [] }).denyRead,
        }))
  const legend = legendOf(drawn)
  const groups = common === null ? null : vendorGroupsOf(common.domains)

  return (
    <div className="sandbox">
      <section aria-label="Summary">
        <SummaryBar summary={summary} attempt={attempt} />
      </section>

      <section aria-label="Blocked">
        <h3 className="sbh sec-h">Blocked</h3>
        <BlockedList blocked={blocked} time="clock" />
        <p className="empty">
          Telemetry hosts are not counted. A refused file read is not listed: srt does not report one.
        </p>
      </section>

      <section aria-label="Runs">
        <h3 className="sbh sec-h">Runs</h3>
        {rows.length === 0 ? (
          <p className="empty">No wrapped run was recorded for this attempt.</p>
        ) : (
          <RunTable rows={rows} srtPerRun={summary.srt === 'differs'} />
        )}
      </section>

      {common === null || groups === null || reach === null ? null : (
        <section aria-label="What the runs could reach">
          <h3 className="sbh sec-h">What the runs could reach</h3>
          {policies.length > 1 ? <p className="empty">What every policy has, listed once.</p> : null}
          <div className="sbboxes">
            <ReachBox title="Reachable" count={common.domains.length}>
              {groups.vendors.map((v) => (
                <p key={v.vendor} className="sbgroup">
                  <span className="empty">{v.vendor}</span> <HostChips hosts={v.hosts} />
                </p>
              ))}
              <p className="sbgroup">
                <span className="empty">This recipe</span>{' '}
                {groups.recipe.length === 0 ? (
                  <span className="empty">none added</span>
                ) : (
                  <HostChips hosts={groups.recipe} />
                )}
              </p>
            </ReachBox>
            <ReachBox title="Writable" count={common.writable.length}>
              <ChipList chips={common.writable} />
            </ReachBox>
            <ReachBox title="Cannot be read" count={common.denyRead.length}>
              <ChipList chips={common.denyRead.map((d) => d.chip)} />
              {common.denyRead
                .filter((d) => d.except.length > 0)
                .map((d) => (
                  <p key={d.chip.fulls[0]} className="empty">
                    {d.chip.label} except {d.except.map((e) => e.label).join(', ')}, which can be read
                  </p>
                ))}
            </ReachBox>
            <ReachBox title="Cannot be written" count={common.denyWrite.length}>
              <ChipList chips={common.denyWrite} />
            </ReachBox>
          </div>
          {differs.length === 0 ? null : (
            <>
              <p className="sbh sec-h">Where the policies differ</p>
              <ul className="sbdiffers">
                {differs.map(({ d, extra, lacks, exceptions }) => (
                  <PolicyDifference
                    key={d.letter}
                    roots={roots}
                    d={d}
                    named={extra}
                    lacks={lacks}
                    exceptions={exceptions}
                  />
                ))}
              </ul>
            </>
          )}
          {legend.length === 0 ? null : (
            <div className="sblegend empty" aria-label="Short names">
              {legend.map((l) => (
                <p key={l.token}>
                  <code>{l.token}</code> {TOKEN_MEANING[l.token] ?? ''}{' '}
                  {l.paths.map((p, n) => (
                    <code key={p}>
                      {n === 0 ? '' : ', '}
                      {p}
                    </code>
                  ))}
                </p>
              ))}
            </div>
          )}
        </section>
      )}

      <div className="sbnotes">
        {view.claudeCodeAuth ? (
          <div className="sbbox empty">
            <p className="sbbox-title">How Claude Code signs in here</p>
            <p>{CLAUDE_CODE_AUTH}</p>
          </div>
        ) : null}
        <div className="sbbox empty">
          <p className="sbbox-title">Not covered</p>
          <ul>
            {NOT_COVERED.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
