/**
 * One PR's page, drawn (#1320): `prPage`'s view as the mock's panels — header, where it is, what Lingtai did, its tickets,
 * the summary, Do, Facts, CI and History. Markup over the view and nothing else, so a unit test renders it; the code
 * host's one word arrives as `host`, a slot the page streams in.
 */
import Link from 'next/link'
import type { ReactNode } from 'react'

import type { PrPageView } from '@/lib/pr-page.ts'

import { PrButtons } from './pr-buttons.tsx'
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

function Drawing({ view }: { view: PrPageView }) {
  const d = view.drawing
  const dots = d.dots
  return (
    <svg
      className="prp-drawing"
      viewBox="0 0 600 120"
      role="img"
      aria-label="the PR branch between main and the personal branch"
    >
      <text x="8" y="16" className="prp-svg-t">
        {d.main}
      </text>
      <line x1="8" y1="24" x2="592" y2="24" className="prp-line main" />
      <text x="8" y="112" className="prp-svg-t">
        {d.personal}
      </text>
      <line x1="8" y1="104" x2="592" y2="104" className="prp-line personal" />
      {d.prBranch === null ? null : (
        <>
          <line x1="60" y1="64" x2="540" y2="64" className="prp-line pr" />
          {dots.map((t, i) => (
            <circle
              key={`${t.fix ? 'fix' : 't'}${t.ticket}`}
              cx={120 + i * 110}
              cy="64"
              r="7"
              className={t.fix ? 'prp-dot fix' : 'prp-dot'}
            >
              <title>{`#${t.ticket} ${t.title}${t.fix ? ' · pr-fix' : ''}`}</title>
            </circle>
          ))}
          {d.more === 0 ? null : <text x="470" y="68" className="prp-svg-t">{`+ ${d.more} more`}</text>}
          <text x="60" y="52" className="prp-svg-t">{`this PR · ${d.prBranch}`}</text>
          <line x1="540" y1="64" x2="540" y2="104" className="prp-line tie" strokeDasharray="4 3" />
          <text x="380" y="92" className="prp-svg-t">
            merged back after each fix
          </text>
        </>
      )}
    </svg>
  )
}

export function PrDetail({
  project,
  view,
  host,
}: {
  project: string
  view: PrPageView
  /** The code host's one word, streamed; absent where nothing is asked. */
  host: ReactNode
}) {
  return (
    <div className="prp">
      <header className="prp-head">
        <span className="prp-chip">
          <Mark />
          {view.header.name}
        </span>
        <h1 className="prp-title">{view.header.title}</h1>
        {view.header.host === null ? null : (
          <a className="prp-host-link" href={view.header.host.href} target="_blank" rel="noreferrer">
            {view.header.host.label}
          </a>
        )}
        <p className="prp-sub">{view.sub}</p>
      </header>
      <div className="prp-grid">
        <div className="prp-main">
          <section className="prp-panel" aria-label="Where it is">
            <h2>Where it is</h2>
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
            <Drawing view={view} />
          </section>

          {view.kind === 'draft' ? null : (
            <section className="prp-panel" aria-label="What Lingtai did">
              <h2>What Lingtai did — the last time through In progress</h2>
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
            <h2>{`Its tickets · ${view.tickets.length}${view.kind === 'pr' ? ', in the order they landed' : ''}`}</h2>
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
              <h2>Summary — the PR&apos;s description on GitHub</h2>
              <PrSummaryEditor project={project} n={view.n} summary={view.summary} />
            </section>
          )}
        </div>

        <aside className="prp-side">
          <section className="prp-panel" aria-label="Do">
            <h2>Do</h2>
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
            <h2>Facts</h2>
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
              <h2>{`CI · ${view.checks.head}`}</h2>
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
              <h2>History</h2>
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
