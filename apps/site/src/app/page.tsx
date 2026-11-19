import type { Metadata } from 'next'

import { readBooks, type Books } from '@/lib/books'

import { BooksSection } from './books-section'
import { Bar, Foot, INSTALL_URL } from './chrome'
import { CopyCommand } from './copy-command'
import { FailurePaths, FailurePathsTable } from './failure-paths'
import { Film } from './film'
import { ReplayReceipt } from './replay-receipt'
import { RouteArrow } from './route-arrow'
import { SandboxShield } from './sandbox-shield'
import { Shots } from './shots'

type LedgerRow = {
  key: string
  alone: string
  lingtai: string
  /** A link that ends the row; the route arrow starts from it (#1291). */
  see?: { href: string; label: string }
}

/** The agent alone against Lingtai: the left column says who decides, never that an agent fails. */
const LEDGER: LedgerRow[] = [
  {
    key: "Who says it's done",
    alone: 'The agent, running its own checks',
    lingtai: 'Your checks, run apart from the agent, a second AI review — your OK only if you turn it on',
  },
  {
    key: 'The workflow',
    alone: 'Skills and prompts you write, and keep working',
    lingtai: 'Built in: steps you set once in a recipe. Your skills still work — for the task, not the process.',
  },
  {
    key: 'When something breaks',
    alone: 'It stops and asks you what to do — even for things it could fix itself.',
    lingtai: 'A router picks the fix: a rule for most, one quick AI look for some, you only when it must.',
    see: { href: '#when-it-fails', label: 'See how ↓' },
  },
  { key: 'Rules', alone: 'Usually in the repo it can edit', lingtai: 'Outside anything it can edit' },
  {
    key: 'Sandbox',
    alone: 'Can read your keys and logins',
    lingtai: 'Sandboxed: keys unreadable, network allowlisted',
  },
  { key: 'After a crash', alone: 'Depends on your session', lingtai: 'Saved; it carries on after a restart' },
  { key: 'Cost', alone: "Your provider's dashboard", lingtai: 'Per ticket, with a daily limit' },
  { key: 'Record', alone: 'The chat transcript', lingtai: 'Every step recorded, and a receipt' },
]

const PROMPTS: [string, string][] = [
  ['Read issue #1 with gh, make a branch, and implement it.', 'Done — I added a ReadingTime component.'],
  ['Run the tests and fix anything that fails.', 'One failed; fixed. 42 passed.'],
  ['Review your change for bugs and edge cases.', 'Found one: it rounds down. Fixed.'],
  ['main moved. Rebase and fix the conflicts.', 'Rebased; one conflict in ChapterMeta, resolved.'],
  ['Run the tests again, then open a PR.', 'Tests pass. PR opened.'],
]

export const metadata: Metadata = { alternates: { canonical: '/' } }

export function HomePage({ books }: { books: Books | null }) {
  return (
    <>
      <Bar />
      <main className="home">
        <div className="wrap">
          <div className="hero-row">
            <section className="hero" aria-labelledby="hero-title">
              <div className="hero-copy">
                <p className="kicker">For Claude Code and Codex</p>
                <h1 id="hero-title">Agents do the work. Lingtai keeps the books.</h1>
                <p className="lede">
                  The agent writes the change. Your checks and an AI review decide whether it lands &mdash; and every
                  ticket ends in a receipt you can check.
                </p>
                <div className="install">
                  <CopyCommand command={`curl -fsSL ${INSTALL_URL} | sh`} />
                  <p className="install-note">macOS and Linux &middot; runs on your machine &middot; no signup</p>
                </div>
                <div className="hero-actions">
                  <a className="way-in" href="#setup">
                    Set up Lingtai <span aria-hidden="true">↓</span>
                  </a>
                  <a className="watch" href="#replay">
                    Watch an example <span aria-hidden="true">↓</span>
                  </a>
                  <a className="watch" href="#film">
                    ▶ The film, 2:11 <span aria-hidden="true">↓</span>
                  </a>
                </div>
              </div>
            </section>
            <Shots />
          </div>

          <section className="film" id="film" aria-labelledby="film-title">
            <p className="kicker">Film &middot; 2:11 &middot; narrated</p>
            <h2 id="film-title">One ticket, filed to landed.</h2>
            <Film />
          </section>

          <div className="tale">
            <div className="tale-main">
              <section className="replay" id="replay" aria-labelledby="replay-title">
                <p className="kicker">
                  Replay <span className="tag ill">ILLUSTRATION</span>
                </p>
                <h2 id="replay-title">You slept. It shipped.</h2>
                <p className="sub">
                  Three things went wrong overnight. Lingtai handled every one. Scroll down; the receipt beside it fills
                  in one step at a time.
                </p>
                <div className="rp-scenes">
                  <div className="rp-scene" data-step="1" id="s1">
                    <div className="time">22:40 · YOU</div>
                    <h3>You file a ticket and go to bed. The agent starts in a sandbox.</h3>
                    <pre className="term">
                      <span className="p">$</span> lingtai start{'   '}taking #1 · sandboxed · 3 files changed
                    </pre>
                  </div>
                  <div className="rp-scene" data-step="2" id="s2">
                    <div className="time">22:58 · LINGTAI</div>
                    <h3>Tests broke → auto-fixed.</h3>
                    <pre className="term">
                      <span className="bad">✗</span> expected &quot;6 min read&quot;{'   '}
                      <span className="dim">rule</span> · fix round 1 <span className="ok">✓</span>
                    </pre>
                  </div>
                  <div className="rp-scene" data-step="3" id="s3">
                    <div className="time">23:20 · LINGTAI</div>
                    <h3>AI review found a bug → auto-fixed.</h3>
                    <pre className="term">
                      <span className="bad">✗</span> rounds 5.4 minutes up to 6{'   '}
                      <span className="dim">one look</span> · fix round 2 <span className="ok">✓</span>
                    </pre>
                  </div>
                  <div className="rp-scene" data-step="4" id="s4">
                    <div className="time">03:12 · LINGTAI</div>
                    <h3>Someone else changed main → auto-combined.</h3>
                    <pre className="term">
                      <span className="bad">✗</span> conflict in ChapterMeta.tsx{'   '}
                      <span className="dim">one look</span> · combined <span className="ok">✓</span> tests{' '}
                      <span className="ok">✓</span> review <span className="ok">✓</span>
                    </pre>
                  </div>
                  <div className="rp-scene" data-step="5" id="s5">
                    <div className="time">07:31 · YOU</div>
                    <h3>You wake up to a receipt. It landed at 03:20, on its own.</h3>
                    <pre className="term">
                      <span className="ok">✓</span> merged agent/1 → main 03:20{'   '}
                      <span className="dim">handled for you</span> · 3 problems · 0 needed you
                    </pre>
                  </div>
                </div>
              </section>
            </div>
            <ReplayReceipt />
          </div>

          <section className="sandbox-pitch" aria-labelledby="sandbox-title">
            <div className="sandbox-inner">
              <div className="sandbox-copy">
                <p className="kicker">Security &middot; from v0.14.0</p>
                <svg
                  className="sandbox-shield"
                  viewBox="0 0 24 24"
                  width="36"
                  height="36"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 3 5 6v5.5c0 4.2 2.9 7.9 7 9.5 4.1-1.6 7-5.3 7-9.5V6l-7-3Z" />
                  <path d="m9 12 2.2 2.2L15.2 10" />
                </svg>
                <h2 id="sandbox-title">
                  Every run is sandboxed. <span className="accent">Your keys stay yours.</span>
                </h2>
                <p className="sandbox-sub">
                  Claude Code, Codex and your checks run in one sandbox, so you can leave it overnight.
                </p>
                <ul className="sandbox-labels">
                  <li>No keys</li>
                  <li>Allowlisted network</li>
                  <li>Refusals on the ticket</li>
                </ul>
                <p className="sandbox-small">
                  On for new projects &middot; one <code>sandbox</code> block in the recipe.
                </p>
                <a className="link" href="/docs/safety/">
                  What an agent can touch →
                </a>
              </div>
              <div className="sandbox-side">
                <SandboxShield />
                <p className="sandbox-small">
                  Telemetry hosts such as <code>sentry.io</code> are refused but not listed.
                </p>
              </div>
            </div>
          </section>

          <div className="route">
            <section className="why" aria-labelledby="why-title">
              <div className="why-head">
                <p className="kicker">The first question</p>
                <h2 id="why-title">Why not just give the agent the issue?</h2>
                <p className="sub">
                  You can — then you drive it, <b>prompt after prompt</b>, and check its work yourself. With Lingtai you{' '}
                  <b>file the ticket</b>; it runs the rest and hands you a receipt.
                </p>
              </div>
              <div className="why-pair">
                <figure className="why-card">
                  <figcaption className="why-cap">
                    <span className="why-alone">THE AGENT ALONE</span>
                    <span className="why-chip">Claude Code</span>
                    <span className="why-chip">Codex</span>
                  </figcaption>
                  <div className="vsm">
                    <p className="vsm-k">You file a ticket…</p>
                    <div className="vsm-issue">
                      <div className="vsm-ihead">
                        <span className="vsm-open">● Open</span>
                        <b>#1 · Add a reading-time badge</b>
                      </div>
                    </div>
                    <p className="vsm-k">…then type prompt after prompt</p>
                    <div className="vsm-term">
                      <div className="vsm-bar">
                        <i />
                        <i />
                        <i />
                        <span>claude · chapter-garden</span>
                      </div>
                      <div className="vsm-prompts">
                        {PROMPTS.map(([ask, reply], i) => (
                          <div key={ask}>
                            <p className="vsm-in">
                              <span className="vsm-ps">{i + 1}</span> {ask}
                            </p>
                            <p className="vsm-out">{reply}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                    <p className="vsm-then">
                      You wait for each answer, decide what to ask next, and type it — five times for one small change.
                    </p>
                  </div>
                </figure>
                <span className="why-vs" aria-hidden="true">
                  vs
                </span>
                <figure className="why-card why-card-with">
                  <figcaption className="why-cap">
                    <span className="why-with">WITH LINGTAI</span>
                    <span className="why-chip">Claude Code</span>
                    <span className="why-chip">Codex</span>
                    <span className="why-chip">+ your rules</span>
                  </figcaption>
                  <div className="vsm">
                    <p className="vsm-k">You file one ticket</p>
                    <div className="vsm-issue">
                      <div className="vsm-ihead">
                        <span className="vsm-open">● Open</span>
                        <b>#1 · Add a reading-time badge</b>
                      </div>
                    </div>
                    <p className="vsm-then">
                      Lingtai builds it, tests it, has an AI review it, and fixes problems on its own.{' '}
                      <a href="#replay">See it above ↑</a>
                    </p>
                    <p className="vsm-then">
                      <b>You: nothing, until it needs a decision.</b>
                    </p>
                  </div>
                </figure>
              </div>
              <div className="ledger">
                <div className="ledger-top">
                  <span>LINGTAI / THE DIFFERENCE</span>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
                    <path d="M9 8h6M9 12h6" />
                  </svg>
                </div>
                <table data-route-table>
                  <caption className="sr-only">The agent alone, and with Lingtai</caption>
                  <colgroup>
                    <col className="lg-key" />
                    <col />
                    <col />
                  </colgroup>
                  <thead>
                    <tr>
                      <td />
                      <th scope="col">Claude Code · Codex alone</th>
                      <th scope="col">With Lingtai</th>
                    </tr>
                  </thead>
                  <tbody>
                    {LEDGER.map((row) => (
                      <tr key={row.key} className={row.see ? 'lg-new' : undefined}>
                        <th scope="row">{row.key}</th>
                        <td className="lg-a">{row.alone}</td>
                        <td className="lg-b">
                          {row.lingtai}
                          {row.see ? (
                            <>
                              {' '}
                              <a className="lg-see" href={row.see.href} data-route-from>
                                {row.see.label}
                              </a>
                            </>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <FailurePaths />
            <RouteArrow />
          </div>

          <section className="why-faq">
            <div className="faq">
              <h3 className="faq-title">Common questions</h3>
              <div className="faq-list">
                <details className="faq-item">
                  <summary>Can I approve before it merges?</summary>
                  <p>
                    Yes. Turn on approval in the recipe and it waits for one click before it lands. It is off by
                    default: your tests and the AI review decide.
                  </p>
                </details>
                <details className="faq-item faq-wide">
                  <summary>What does it do in each case?</summary>
                  <FailurePathsTable />
                </details>
                <details className="faq-item">
                  <summary>Will it break main?</summary>
                  <p>
                    Nothing lands until your checks and the AI review pass. If main is already broken, it stops and
                    tells you, instead of spending money on a bug that isn&apos;t its own.
                  </p>
                </details>
                <details className="faq-item">
                  <summary>Will it run up a bill?</summary>
                  <p>
                    Every paid call is recorded. Set a daily limit and it pauses when the limit is reached, until
                    midnight or until you resume it.
                  </p>
                </details>
                <details className="faq-item">
                  <summary>What if my laptop restarts at 3am?</summary>
                  <p>Nothing is lost. Its commits are saved on a branch, and the next run carries on from there.</p>
                </details>
                <details className="faq-item">
                  <summary>Can it weaken its own checks?</summary>
                  <p>No. Your rules live outside the repository the agent edits, so it can&apos;t change them.</p>
                </details>
              </div>
            </div>
          </section>

          {books ? <BooksSection books={books} /> : null}

          <section className="home-setup" id="setup" aria-labelledby="setup-title">
            <div className="setup-lead">
              <p className="kicker">Start</p>
              <h2 id="setup-title">Three steps to your first receipt.</h2>
              <p>
                <a className="link" href="/docs/tutorial/">
                  The tutorial →
                </a>
              </p>
            </div>
            <ol className="setup-steps">
              <li>
                <span className="step-number">01</span>
                <div>
                  <h3>Install and init</h3>
                  <div className="command">
                    <span>$</span> lingtai init
                  </div>
                </div>
              </li>
              <li>
                <span className="step-number">02</span>
                <div>
                  <h3>Write one ticket</h3>
                  <p>
                    A GitHub issue with a kind label, or <code>lingtai ticket new</code> on a local project.
                  </p>
                </div>
              </li>
              <li>
                <span className="step-number">03</span>
                <div>
                  <h3>Start</h3>
                  <div className="command">
                    <span>$</span> lingtai start
                  </div>
                </div>
              </li>
            </ol>
          </section>

          <p className="home-edges">
            Runs on one machine &middot; not yet 1.0 &mdash;{' '}
            <a className="link" href="/docs/requirements/">
              what it needs, and what it doesn&apos;t do yet →
            </a>
          </p>
        </div>
      </main>
      <Foot />
    </>
  )
}

export default async function Home() {
  return <HomePage books={await readBooks()} />
}
