/**
 * One PR's page, drawn (#1320): `prPage`'s view as the mock's panels — header, where it is, what Lingtai did, its tickets,
 * the summary, Do, Facts, CI and History. Markup over the view and nothing else, so a unit test renders it; the code
 * host's one word arrives as `host`, a slot the page streams in.
 */
import Link from 'next/link'
import type { ReactNode } from 'react'

import { shownLabel } from '@/lib/pr-branches.ts'
import type { PrPageView } from '@/lib/pr-page.ts'

import { ObjectTitle, joinMeta } from './object-title.tsx'
import { PrButtons } from './pr-buttons.tsx'
import { GeneratedBox } from './pr-generated-box.tsx'
import { PrSummaryEditor } from './pr-summary-editor.tsx'

/** A ticket's task page: the task id is `ticket-<project>-<issue>`, as the home page and the standing list link it. */
const taskHref = (project: string, ticket: string): string =>
  `/task/${encodeURIComponent(`ticket-${project}-${ticket}`)}`

const Mark = () => (
  <svg className="pr-mark" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <circle cx="4" cy="3" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="4" cy="13" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="12" cy="6" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="M4 5v6M12 8c0 2-4 2-8 3" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
)

const LEGEND: readonly { readonly cls: string; readonly text: string }[] = [
  { cls: 'done', text: 'happened' },
  { cls: 'todo', text: 'still to come' },
  { cls: 'running', text: 'running now' },
  { cls: 'waiting', text: 'waiting on you' },
  { cls: 'ticket', text: 'a ticket landed' },
]

/** The PR's three branches, drawn from `lib/pr-branches.ts`'s laid-out list: lanes, nodes, 45° connectors, *now*. */
function Branches({ view }: { view: PrPageView }) {
  const d = view.drawing
  if (d === null) return null
  const y = d.laneY
  return (
    <>
      <svg
        className="prp-drawing"
        viewBox={`0 0 ${d.width} ${d.height}`}
        role="img"
        aria-label="the PR branch between main and the personal branch"
      >
        <text x="8" y={y.main + 4} className="prp-lname">
          {d.lanes.main}
        </text>
        <line x1={d.gutter} y1={y.main} x2={d.width - 15} y2={y.main} className="prp-line main" />
        <text x="8" y={y.personal + 4} className="prp-lname">
          {d.lanes.personal}
        </text>
        <line x1={d.gutter} y1={y.personal} x2={d.width - 15} y2={y.personal} className="prp-line personal" />
        <text x="8" y={y.pr + 4} className={d.lanes.pr === null ? 'prp-lname idle' : 'prp-lname'}>
          {d.lanes.pr ?? 'no PR yet'}
        </text>
        {d.prSpan === null ? null : (
          <line
            x1={d.prSpan[0]}
            y1={y.pr}
            x2={d.prSpan[1]}
            y2={y.pr}
            className={d.lanes.gone ? 'prp-line pr gone' : 'prp-line pr'}
          />
        )}
        {d.nowX === null ? null : (
          <>
            <line x1={d.nowX} y1="18" x2={d.nowX} y2={d.height - 30} className="prp-now" />
            <text x={d.nowX + 4} y="22" className="prp-now-t">
              NOW
            </text>
          </>
        )}
        {d.edges.map((e) => (
          <path
            key={`${e.from}-${e.to}`}
            d={`M${e.x1} ${e.y1} L${e.x2} ${e.y2}`}
            className={`prp-edge ${e.kind} ${e.state}`}
          />
        ))}
        {d.brace === null ? null : (
          <>
            <path d={`M${d.brace.x1} ${y.personal + 40} v6 H${d.brace.x2} v-6`} className="prp-brace" />
            <text x={d.brace.x1} y={y.personal + 62} className="prp-svg-t">
              {d.brace.text}
            </text>
          </>
        )}
        {d.nodes.map((n) => (
          <g key={n.id} className="prp-node-g">
            {n.hidden ? null : (
              <circle cx={n.x} cy={n.y} r={n.kind === 'ticket' ? 4.5 : 7} className={`prp-nd ${n.kind}`}>
                <title>
                  {[n.title ?? (n.label === '' ? n.lane : n.label), n.sha].filter((t) => t !== null).join(' · ')}
                </title>
              </circle>
            )}
            {shownLabel(n) === '' ? null : (
              <text
                x={n.x - 6}
                y={n.above ? n.y - 13 : n.y + 21}
                textAnchor={n.anchor}
                className={`prp-svg-t ${n.tone ?? ''}`}
              >
                {shownLabel(n)}
              </text>
            )}
          </g>
        ))}
      </svg>
      <p className="prp-small prp-legend">
        {LEGEND.map((l) => (
          <span key={l.cls}>
            <svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
              <circle cx="7" cy="7" r="5" className={`prp-nd ${l.cls}`} />
            </svg>{' '}
            {l.text}{' '}
          </span>
        ))}
      </p>
      {d.words.length === 0 ? null : <p className="prp-small prp-words">{d.words.join(' · ')}</p>}
    </>
  )
}

export function PrDetail({
  project,
  view,
  host,
  generated,
}: {
  project: string
  view: PrPageView
  /** The code host's one word, streamed; absent where nothing is asked. */
  host: ReactNode
  /** The generated description, streamed; absent draws the view's own. */
  generated?: ReactNode
}) {
  return (
    <div className="prp">
      <ObjectTitle
        tag={view.poster.word.toLowerCase()}
        tone={view.poster.tone}
        title={view.header.title}
        meta={joinMeta([
          <>
            <Mark /> {view.header.name}
          </>,
          view.header.host === null ? null : (
            <a href={view.header.host.href} target="_blank" rel="noreferrer">
              {view.header.host.label}
            </a>
          ),
          view.sub,
        ])}
      />
      <div className="prp-grid">
        <div className="prp-main">
          <section className="prp-panel" aria-label="Where it is">
            <h2 className="sec-h">Where it is</h2>
            <p className="prp-poster">
              <b className={`prp-word ${view.poster.word.toLowerCase().replace(/ /g, '-')}`}>{view.poster.word}</b>{' '}
              <span className="prp-small">{view.poster.line}</span>
              {host === null ? null : <> · {host}</>}
            </p>
            <ol className="prp-life">
              {view.strip.map((s) => (
                <li key={s.id} className={`${s.id} ${s.mode}`}>
                  {s.label}
                </li>
              ))}
            </ol>
            <Branches view={view} />
          </section>

          {view.kind === 'draft' ? null : (
            <section className="prp-panel" aria-label="What Lingtai did">
              <h2 className="sec-h">What Lingtai did — the last time through In progress</h2>
              {view.stepsNote === null ? null : <p className="prp-small">{view.stepsNote}</p>}
              <ol className="prp-steps">
                {view.steps.map((s) => (
                  <li key={s.step} className={`prp-step ${s.status}`}>
                    <span className="prp-mark" aria-hidden="true">
                      {s.mark}
                    </span>
                    <b>{s.label}</b>
                    <span className="prp-step-text">{s.text}</span>
                    {s.duration === null ? null : <span className="prp-small">{s.duration}</span>}
                    {s.link === null ? null : (
                      <a href={s.link.href} target="_blank" rel="noreferrer">
                        {s.link.label}
                      </a>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          )}

          <section className="prp-panel" aria-label="Its tickets">
            <h2 className="sec-h">{`Its tickets · ${view.tickets.length}${view.kind === 'pr' ? ', in the order they landed' : ''}`}</h2>
            {view.tickets.length === 0 ? (
              <p className="prp-small">no tickets</p>
            ) : (
              <ol className="pr-rail prp-tickets">
                {view.tickets.map((t) => (
                  <li key={`${t.fix ? 'fix' : 't'}${t.ticket}`} className="pr-slip">
                    <span className="pr-dot" aria-hidden="true" />{' '}
                    <Link className="pr-slip-id" href={taskHref(project, t.ticket)}>
                      #{t.ticket}
                    </Link>{' '}
                    <Link className="pr-slip-title" href={taskHref(project, t.ticket)}>
                      {t.title}
                    </Link>
                    {t.fix ? <span className="pr-fix"> pr-fix</span> : null}
                  </li>
                ))}
              </ol>
            )}
          </section>

          {view.summary === null || view.n === null ? null : (
            <section className="prp-panel" aria-label="Summary">
              <h2 className="sec-h">Summary — the PR&apos;s description on GitHub</h2>
              <PrSummaryEditor
                project={project}
                n={view.n}
                summary={view.summary}
                generated={generated ?? <GeneratedBox value={view.summary.generated} />}
              />
            </section>
          )}
        </div>

        <aside className="prp-side">
          <section className="prp-panel" aria-label="Do">
            <h2 className="sec-h">Do</h2>
            {view.doNote === null ? null : <p className="prp-small">{view.doNote}</p>}
            {view.wait === null ? null : (
              <div className="prp-wait">
                <p>
                  <b>{view.wait.word}</b> — {view.wait.detail}
                </p>
                {view.wait.lines.map((l) => (
                  <p key={l} className="prp-small">
                    {l}
                  </p>
                ))}
                {view.wait.byHand.length === 0 ? null : (
                  <details className="pr-hand" open>
                    <summary>or resolve it by hand</summary>
                    <pre>{view.wait.byHand.join('\n')}</pre>
                  </details>
                )}
              </div>
            )}
            <PrButtons project={project} n={view.n} buttons={view.buttons} />
            {view.fixCommand === null ? null : (
              <p className="prp-small">
                New pr-fix ticket: <code>{view.fixCommand.command}</code> — {view.fixCommand.note}
              </p>
            )}
          </section>

          <section className="prp-panel" aria-label="Facts">
            <h2 className="sec-h">Facts</h2>
            <dl className="prp-facts">
              {view.facts.map((f) => (
                <div key={f.label}>
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
          </section>

          {view.kind === 'draft' ? null : (
            <section className="prp-panel" aria-label="CI">
              <h2 className="sec-h">{`CI · ${view.checks.head}`}</h2>
              <ul className="prp-checks">
                {view.checks.rows.map((c) => (
                  <li key={c.name} className={c.failing ? 'failing' : ''}>
                    <b>{c.name}</b> {c.result}{' '}
                    {c.url === null ? null : (
                      <a href={c.url} target="_blank" rel="noreferrer">
                        ↗
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {view.kind === 'draft' ? null : (
            <section className="prp-panel" aria-label="History">
              <h2 className="sec-h">History</h2>
              <ul className="prp-history">
                {view.history.map((h, i) => (
                  <li key={`${h.at}-${i}`}>
                    <time className="prp-small">{h.at.slice(5, 16).replace('T', ' ')}</time> {h.text}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </div>
  )
}
