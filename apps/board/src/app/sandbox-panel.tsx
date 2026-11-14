/**
 * The Sandbox tab's parts and the small state mark (#1161). Shared with the recipe page's sandbox section (S9b) and
 * the marks elsewhere (S9c), so it takes `SandboxView` as props and imports nothing of the task page's loader.
 * A server component: nothing here is interactive, and the view module reaches `node:path`.
 */
import Link from 'next/link'

import type { Mark, PolicyGroup, RefusalReading, RunRow, SandboxView, Tone } from '@/lib/sandbox-view'
import { CLAUDE_CODE_AUTH, NOT_COVERED } from '@/lib/sandbox-view'

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

const policyKey = (g: PolicyGroup) =>
  `${g.runs.join('|')}:${g.srtVersion}:${g.writable.join(',')}:${g.denyRead.map((d) => d.path).join(',')}`

function RunTable({ rows }: { rows: readonly RunRow[] }) {
  return (
    <table className="sbrows">
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td className="mono">
              {r.step} · {r.action}
              {r.runtime === null ? '' : ` · ${r.runtime}`}
            </td>
            <td>
              <SandboxMark mark={r.mark} />
              {r.mark.why === null ? null : <span className={TONE_CLASS[r.mark.tone]}> {r.mark.why}</span>}
              {r.srtVersion === null ? null : <span className="empty"> srt {r.srtVersion}</span>}
              {r.policy === null ? null : <span className="empty"> policy {r.policy}</span>}
              {r.weakerNetwork ? <span className="hold"> weaker network isolation</span> : null}
            </td>
            <td>
              <Refusals reading={r.refusals} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** The three parts and the run rows for one attempt. */
export function SandboxPanel({ view }: { view: SandboxView }) {
  const { policies, blocked, rows } = view
  return (
    <div className="sandbox">
      <section aria-label="Allowed">
        <h3>Allowed</h3>
        {policies.length === 0 ? <p className="empty">none recorded</p> : null}
        {policies.map((g, n) => (
          <div key={policyKey(g)}>
            <p className="sbhead">
              Policy {n + 1}: {g.runs.join(', ')} <span className="empty">srt {g.srtVersion}</span>
            </p>
            <p className="sbhead">Writable</p>
            {g.writable.length === 0 ? (
              <p className="empty">none recorded</p>
            ) : (
              <ul className="mono">
                {g.writable.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            <p className="sbhead">Reachable</p>
            {g.domains.length === 0 ? (
              <p className="empty">none recorded</p>
            ) : (
              <ul className="mono">
                {g.domains.map((d) => (
                  <li key={d.host}>
                    {d.host} <span className="empty">{d.source}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </section>

      <section aria-label="Limited">
        <h3>Limited</h3>
        {policies.map((g, n) => (
          <div key={policyKey(g)}>
            <p className="sbhead">
              Policy {n + 1}: {g.runs.join(', ')}
            </p>
            <p className="sbhead">Cannot be read</p>
            <ul className="mono">
              {g.denyRead.length === 0 ? <li className="empty">none recorded</li> : null}
              {g.denyRead.map((p) => (
                <li key={p.path}>
                  {p.path}
                  {p.except.length === 0 ? null : (
                    <span className="empty"> except {p.except.join(', ')}, which can be read</span>
                  )}
                </li>
              ))}
            </ul>
            <p className="sbhead">Cannot be written</p>
            <ul className="mono">
              {g.denyWrite.length === 0 ? <li className="empty">none recorded</li> : null}
              {g.denyWrite.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ))}
        {view.claudeCodeAuth ? <p>{CLAUDE_CODE_AUTH}</p> : null}
        <p className="sbhead">Not covered</p>
        <ul>
          {NOT_COVERED.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </section>

      <section aria-label="Blocked">
        <h3>Blocked</h3>
        {blocked.caveats.map((c) => (
          <p key={c} className="fail">
            {c}
          </p>
        ))}
        {blocked.hosts.length === 0 ? (
          blocked.caveats.length === 0 ? (
            <p className="empty">No refused connection was recorded.</p>
          ) : null
        ) : (
          <table className="sbrows">
            <tbody>
              {blocked.hosts.map((h) => (
                <tr key={h.label}>
                  <td className="mono">{h.label}</td>
                  <td>{h.count}×</td>
                  <td>{h.from.join(', ')}</td>
                  <td>
                    <time dateTime={h.firstAt}>{h.firstAt}</time>
                  </td>
                  <td>
                    {h.allowHref === null ? null : (
                      <Link href={h.allowHref} prefetch={false}>
                        Allow on this project
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-label="Runs">
        <h3>Runs</h3>
        {rows.length === 0 ? (
          <p className="empty">No wrapped run was recorded for this attempt.</p>
        ) : (
          <RunTable rows={rows} />
        )}
        <p className="empty">The merge is Lingtai&apos;s own and runs outside the sandbox.</p>
      </section>
    </div>
  )
}
