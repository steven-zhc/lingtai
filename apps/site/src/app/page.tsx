import { Bar, Foot, INSTALL_URL } from './chrome'
import { CopyCommand } from './copy-command'
import { ReplayReceipt } from './replay-receipt'

/** The agent alone against Lingtai: the left column says who decides, never that an agent fails. */
const LEDGER = [
  {
    key: 'Completion',
    alone: 'The agent, or tooling around it',
    lingtai: 'Your recipe: checks, review, your approval',
  },
  { key: 'Checks', alone: "Inside the agent's own workflow", lingtai: "Separate steps the agent can't skip" },
  { key: 'Rules', alone: 'Usually in the repo it edits', lingtai: 'Outside its worktree' },
  { key: 'Recovery', alone: 'Depends on the session and setup', lingtai: 'Persisted; a restart picks it up' },
  { key: 'Cost', alone: 'Provider or tool tracking', lingtai: 'Per ticket, with a daily ceiling' },
  { key: 'Audit', alone: 'Session transcripts', lingtai: 'Structured events and a receipt' },
]

export default function Home() {
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
                      See a receipt fill in <span aria-hidden="true">↓</span>
                    </a>
                  </div>
                </div>
              </section>

              <section className="replay" id="replay" aria-labelledby="replay-title">
                <p className="kicker">
                  Replay <span className="tag ill">ILLUSTRATION</span>
                </p>
                <h2 id="replay-title">The agent got it wrong. Twice.</h2>
                <p className="sub">How each line of that receipt got there &mdash; from the record.</p>
                <div className="rp-scenes">
                  <div className="rp-scene" data-step="1" id="s1">
                    <div className="time">22:40 · YOU</div>
                    <h3>You write a ticket. That&apos;s the whole setup.</h3>
                    <p>One command starts the loop.</p>
                    <pre className="term">
                      <span className="p">$</span> lingtai start{'\n'}
                      <span className="dim">chapter-garden</span>
                      {'  '}taking #1{'  '}Add a reading-time badge
                    </pre>
                  </div>
                  <div className="rp-scene" data-step="2" id="s2">
                    <div className="time">22:51 · THE AGENT</div>
                    <h3>It works where it can&apos;t touch your checkout.</h3>
                    <p>Its own worktree. Every commit kept.</p>
                    <pre className="term">
                      <span className="ok">committed</span> b72d0e3{'  '}add a reading-time badge{'\n'}
                      {'          '}3 files · +38 −2
                    </pre>
                  </div>
                  <div className="rp-scene" data-step="3" id="s3">
                    <div className="time">22:58 · YOUR CHECKS</div>
                    <h3>Your checks say no. The agent can&apos;t argue.</h3>
                    <p>The real output is the reason &mdash; and the next round starts from it.</p>
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
                    <h3>A reviewer who didn&apos;t write it finds one more thing.</h3>
                    <p>Another counted round. Then it passes.</p>
                    <pre className="term">
                      <span className="dim">review</span> <span className="bad">✗</span> rounds 5.4 minutes up to 6
                      {'\n'}
                      <span className="dim">round 2</span> <span className="ok">✓</span> review
                    </pre>
                  </div>
                  <div className="rp-scene" data-step="5" id="s5">
                    <div className="time">23:41 → 07:31 · YOU</div>
                    <h3>It stops and asks. You approve in the morning.</h3>
                    <p>Nothing lands at night unless you said it may.</p>
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
                You can. At the end you get <b>its word</b> for it. With Lingtai, you get{' '}
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
                <p className="why-note">Often right. But it is the agent&apos;s own account of its own work.</p>
              </figure>
              <span className="why-vs" aria-hidden="true">
                vs
              </span>
              <figure className="why-card why-card-with">
                <figcaption className="why-cap">
                  <span className="why-with">WITH LINGTAI</span>
                  <span className="why-chip">Claude Code</span>
                  <span className="why-chip">Codex</span>
                  <span className="why-chip">+ a separate policy</span>
                </figcaption>
                <a className="why-point" href="#replay">
                  <span className="why-arrow" aria-hidden="true">
                    ↑
                  </span>
                  <span>
                    <b>The receipt above.</b>
                    <span className="why-point-text">
                      Checks it didn&apos;t run itself, a review by someone who didn&apos;t write it, your approval, the
                      cost — each a line you can open.
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
          </section>

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
            Not a container &middot; one machine &middot; pre-1.0 &mdash;{' '}
            <a className="link" href="/docs/requirements/">
              what it does not do yet →
            </a>
          </p>
        </div>
      </main>
      <Foot />
    </>
  )
}
