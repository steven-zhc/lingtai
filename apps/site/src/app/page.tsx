import { readBooks, type Books } from '@/lib/books'

import { BooksSection } from './books-section'
import { Bar, Foot, INSTALL_URL } from './chrome'
import { CopyCommand } from './copy-command'
import { ReplayReceipt } from './replay-receipt'

/** The agent alone against Lingtai: the left column says who decides, never that an agent fails. */
const LEDGER = [
  {
    key: "Who says it's done",
    alone: 'The agent, or your own scripts',
    lingtai: 'Your checks, a cold review, and your OK',
  },
  {
    key: 'Checks',
    alone: 'Run by the agent as part of its work',
    lingtai: "Run separately; the agent can't skip them",
  },
  { key: 'Rules', alone: 'Usually in the repo it can edit', lingtai: 'Outside anything it can edit' },
  { key: 'After a crash', alone: 'Depends on your session', lingtai: 'Saved; it carries on after a restart' },
  { key: 'Cost', alone: "Your provider's dashboard", lingtai: 'Per ticket, with a daily limit' },
  { key: 'Record', alone: 'The chat transcript', lingtai: 'Every step recorded, and a receipt' },
]

export function HomePage({ books }: { books: Books | null }) {
  return (
    <>
      <Bar />
      <main className="home">
        <div className="wrap">
          <div className="tale">
            <div className="tale-main">
              <section className="hero" aria-labelledby="hero-title">
                <div className="hero-copy">
                  <p className="kicker">For Claude Code and Codex</p>
                  <h1 id="hero-title">Agents do the work. Lingtai keeps the books.</h1>
                  <p className="lede">
                    The agent writes the change. Your checks and a cold review decide whether it lands &mdash; and every
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
                  </div>
                </div>
              </section>

              <section className="replay" id="replay" aria-labelledby="replay-title">
                <p className="kicker">
                  Replay <span className="tag ill">ILLUSTRATION</span>
                </p>
                <h2 id="replay-title">The agent got it wrong. Twice.</h2>
                <p className="sub">Scroll down. The receipt beside it fills in one step at a time.</p>
                <div className="rp-scenes">
                  <div className="rp-scene" data-step="1" id="s1">
                    <div className="time">22:40 · YOU</div>
                    <h3>You write a ticket. That&apos;s the whole setup.</h3>
                    <p>One command starts the work.</p>
                    <pre className="term">
                      <span className="p">$</span> lingtai start{'\n'}
                      <span className="dim">chapter-garden</span>
                      {'  '}taking #1{'  '}Add a reading-time badge
                    </pre>
                  </div>
                  <div className="rp-scene" data-step="2" id="s2">
                    <div className="time">22:51 · THE AGENT</div>
                    <h3>The agent works in a separate copy of your repo.</h3>
                    <p>Your own files stay untouched. Every commit is saved.</p>
                    <pre className="term">
                      <span className="ok">committed</span> b72d0e3{'  '}add a reading-time badge{'\n'}
                      {'          '}3 files · +38 −2
                    </pre>
                  </div>
                  <div className="rp-scene" data-step="3" id="s3">
                    <div className="time">22:58 · YOUR CHECKS</div>
                    <h3>Your checks fail. The agent has to fix it.</h3>
                    <p>It gets the real output and tries again.</p>
                    <pre className="term">
                      <span className="bad">✗</span> reading-time.test.ts{'\n'}
                      {'  '}expected &quot;6 min read&quot;, received &quot;7 min read&quot;{'\n'}
                      <span className="dim">round 1</span>
                      {'  '}
                      <span className="ok">✓</span> check{'  '}
                      <span className="ok">✓</span> build
                    </pre>
                  </div>
                  <div className="rp-scene" data-step="4" id="s4">
                    <div className="time">23:20 · A COLD REVIEW</div>
                    <h3>The cold review finds another bug.</h3>
                    <p>One more fix, then the review passes.</p>
                    <pre className="term">
                      <span className="dim">review</span> <span className="bad">✗</span> rounds 5.4 minutes up to 6
                      {'\n'}
                      <span className="dim">round 2</span> <span className="ok">✓</span> review
                    </pre>
                  </div>
                  <div className="rp-scene" data-step="5" id="s5">
                    <div className="time">23:41 → 07:31 · YOU</div>
                    <h3>It stops and asks. You approve in the morning.</h3>
                    <p>You asked to approve first, so nothing lands until you do.</p>
                    <div className="frame">
                      <div className="wait">
                        <div className="cause">
                          <small>READY TO LAND · YOU ASKED TO APPROVE FIRST</small>
                        </div>
                        <div className="moves">
                          <span className="btn pri">
                            Approve<small>RECOMMENDED</small>
                          </span>
                          <span className="btn">Requeue</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  {/* Past the last scene: step 6, where the receipt is stamped. */}
                  <div className="rp-scene rp-end" data-step="6" aria-hidden="true" />
                </div>
              </section>
            </div>
            <ReplayReceipt />
          </div>

          <section className="why" aria-labelledby="why-title">
            <div className="why-head">
              <p className="kicker">The first question</p>
              <h2 id="why-title">Why not just give the agent the issue?</h2>
              <p className="sub">
                You can. Then the only proof it worked is <b>the agent saying so</b>. With Lingtai, you get{' '}
                <b>the receipt you just watched</b>.
              </p>
            </div>
            <div className="why-pair">
              <figure className="why-card">
                <figcaption className="why-cap">
                  <span className="why-alone">THE AGENT ALONE</span>
                  <span className="why-chip">Claude Code</span>
                  <span className="why-chip">Codex</span>
                </figcaption>
                <div className="why-top">
                  <span>session · chapter-garden</span>
                  <span>23:02</span>
                </div>
                <p className="why-msg">
                  I added a <code>ReadingTime</code> component and wired it into <code>ChapterMeta</code>. I ran{' '}
                  <code>npm test</code> — 42 passed. Ready for you to review.
                </p>
                <p className="why-note">Often right. But that&apos;s the agent grading its own work.</p>
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
                <a className="why-ref" href="#replay">
                  <span className="why-arrow" aria-hidden="true">
                    ↑
                  </span>
                  <span>
                    <b>The receipt above.</b>
                    <span className="why-ref-text">
                      Your checks ran it, not the agent. A cold review passed it. You approved it. Its cost is recorded.
                    </span>
                  </span>
                </a>
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
              <table>
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
                    <tr key={row.key}>
                      <th scope="row">{row.key}</th>
                      <td className="lg-a">{row.alone}</td>
                      <td className="lg-b">{row.lingtai}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="faq">
              <h3 className="faq-title">Common questions</h3>
              <div className="faq-list">
                <details className="faq-item">
                  <summary>Will it break main?</summary>
                  <p>
                    Nothing lands until your checks and the cold review pass. If main is already broken, it stops and
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
                  <summary>Will it loop forever?</summary>
                  <p>
                    No. Each ticket gets a fixed number of fix attempts. When they run out, it stops and asks you what
                    to do, with a suggested answer.
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
                <details className="faq-item honest">
                  <summary>
                    Can it read my <code>~/.ssh</code>?<span className="faq-tag">HONEST ANSWER</span>
                  </summary>
                  <p>
                    By default, yes. A Claude Code agent runs as your user, so it can read what you can. Lingtai keeps
                    its own secrets away from the agent, but it is not a sandbox. If you need one, run it inside yours.{' '}
                    <a className="link" href="/docs/safety/">
                      What an agent can touch →
                    </a>
                  </p>
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
            Not a sandbox &middot; runs on one machine &middot; not yet 1.0 &mdash;{' '}
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
