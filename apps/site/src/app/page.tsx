import { landedCount, readSnapshot, stamp } from '@/lib/snapshot'

import { BuildsItself } from './builds-itself'
import { Bar, Foot, INSTALL_URL } from './chrome'
import { CopyCommand } from './copy-command'
import {
  EnvironmentMini,
  LandedMini,
  LanesMini,
  QueuedMini,
  SpendMini,
  StepsMini,
  WaitingMini,
  WorktreeMini,
} from './home-minis'
import { NoSnapshot, SnapshotBoard } from './snapshot-board'

const ISSUES = 'https://github.com/steven-zhc/lingtai/issues'

export default async function Home() {
  const snapshot = await readSnapshot()

  return (
    <>
      <Bar note={snapshot === null ? undefined : `board · ${stamp(snapshot.capturedAt)}`} />
      <main className="home">
        <div className="wrap">
          <section className="hero" aria-labelledby="hero-title">
            <div className="hero-copy">
              <p className="kicker">A working loop for coding agents</p>
              <h1 id="hero-title">Let your backlog move. Keep control of what lands.</h1>
              <p className="lede">
                Lingtai picks up your GitHub issues, or tickets kept on your machine, and lets an agent work on them. It
                runs your repository&rsquo;s checks and lands passing work. If a run needs you, it stops and says why.
              </p>
              <div className="install">
                <CopyCommand command={`curl -fsSL ${INSTALL_URL} | sh`} />
                <p className="install-note">
                  macOS and Linux, arm64 or x64. It checks a SHA256 before it unpacks a byte. Then run{' '}
                  <code>lingtai init</code> to set up your project. Read{' '}
                  <a className="link" href={INSTALL_URL}>
                    the script
                  </a>{' '}
                  first if you like.
                </p>
              </div>
              <div className="hero-actions">
                <a className="way-in" href="#setup">
                  Set up Lingtai <span aria-hidden="true">↓</span>
                </a>
                <a className="second" href="#loop">
                  See the loop <span aria-hidden="true">↓</span>
                </a>
              </div>
              <p className="hero-note">Runs on your machine · Uses your issues and checks · No signup</p>
            </div>
            <RunDiagram />
          </section>

          <section id="loop" aria-labelledby="loop-title">
            <div className="section-intro">
              <div>
                <p className="kicker">The loop, one stop at a time</p>
                <h2 id="loop-title">What you see at each stop, and what you can do there.</h2>
              </div>
              <p>Four stops from a ticket to a decision.</p>
            </div>
            <ol className="home-stops">
              <li id="stop-ticket">
                <span className="home-pin">01</span>
                <div className="home-stop-grid">
                  <div>
                    <h3>A ticket</h3>
                    <p className="home-what">
                      A GitHub issue with one of your recipe&rsquo;s kind labels, or a ticket kept on this machine with{' '}
                      <code>lingtai ticket new</code> (local projects only). The queue passes over anything with an open
                      blocker.
                    </p>
                    <div className="home-seedo">
                      <div>
                        <h4>You see</h4>
                        <ul>
                          <li>The ticket in the Queued column, in the order your kinds set</li>
                          <li>A blocked ticket counted as blocked, not lost</li>
                        </ul>
                      </div>
                      <div>
                        <h4>You can</h4>
                        <ul>
                          <li>
                            Add <code>agent:hold</code> to keep it out of the queue
                          </li>
                          <li>
                            Chain tickets with GitHub&rsquo;s <em>blocked by</em>
                          </li>
                        </ul>
                      </div>
                    </div>
                  </div>
                  <QueuedMini />
                </div>
              </li>
              <li id="stop-worktree">
                <span className="home-pin">02</span>
                <div className="home-stop-grid">
                  <div>
                    <h3>A worktree</h3>
                    <p className="home-what">
                      The agent works in its own worktree, with an environment filtered to what the recipe allows. Each
                      attempt&rsquo;s commits are kept, and the next attempt starts from them.
                    </p>
                    <div className="home-seedo">
                      <div>
                        <h4>You see</h4>
                        <ul>
                          <li>
                            The run as it happens (<code>lingtai attach</code>)
                          </li>
                          <li>
                            One line per ticket from <code>lingtai start</code>: steps, cost, where it stopped, and the
                            command when it waits
                          </li>
                        </ul>
                      </div>
                      <div>
                        <h4>You can</h4>
                        <ul>
                          <li>Let it run; nothing here needs you</li>
                          <li>
                            Choose the agent. Codex adds a filesystem boundary; Claude Code runs <code>guarded</code>.
                            No container per run
                          </li>
                        </ul>
                      </div>
                    </div>
                  </div>
                  <WorktreeMini />
                </div>
              </li>
              <li id="stop-checks">
                <span className="home-pin">03</span>
                <div className="home-stop-grid">
                  <div>
                    <h3>Your checks</h3>
                    <p className="home-what">
                      Your test command runs, then a second reviewer reads the diff cold. A failure goes back to the
                      agent for a fix round. Turns, wall time and rounds are bounded.
                    </p>
                    <div className="home-seedo">
                      <div>
                        <h4>You see</h4>
                        <ul>
                          <li>A verdict per step on the board</li>
                          <li>
                            The ticket&rsquo;s cost so far, in dollars, on <code>/spend</code>
                          </li>
                        </ul>
                      </div>
                      <div>
                        <h4>You can</h4>
                        <ul>
                          <li>Choose the checks in your recipe</li>
                          <li>
                            Leave a red check to buy a fix round. A check already red on the base buys none and holds as{' '}
                            <em>base is red</em>
                          </li>
                        </ul>
                      </div>
                    </div>
                  </div>
                  <StepsMini />
                </div>
              </li>
              <li id="stop-result">
                <span className="home-pin">04</span>
                <div className="home-stop-grid">
                  <div>
                    <h3>Wait, or land</h3>
                    <p className="home-what">
                      Passing work lands if your recipe says so. Otherwise, or when something goes wrong, the ticket
                      stops and says why.
                    </p>
                    <div className="home-fork">
                      <div className="home-branch home-land">
                        <header>✓ It lands</header>
                        <div className="home-seedo single">
                          <div>
                            <h4>You see</h4>
                            <ul>
                              <li>
                                The ticket in Landed, its cost on <code>/report</code>
                              </li>
                              <li>
                                The issue closed, in a project <code>lingtai add</code> set up
                              </li>
                            </ul>
                          </div>
                        </div>
                      </div>
                      <div className="home-branch home-wait">
                        <header>! It waits on you</header>
                        <div className="home-seedo">
                          <div>
                            <h4>You see</h4>
                            <ul>
                              <li>Triage&rsquo;s reading of the cause</li>
                              <li>The answers it allows, the recommended one first, and what each does</li>
                            </ul>
                          </div>
                          <div>
                            <h4>You can</h4>
                            <ul>
                              <li>Continue the saved work, or start again from base, in one click</li>
                              <li>Choose in the recipe whether to wait for your approval or land without asking</li>
                            </ul>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="home-pair">
                    <WaitingMini />
                    <LandedMini />
                  </div>
                </div>
              </li>
            </ol>
          </section>

          <section aria-labelledby="beside-title">
            <div className="section-intro">
              <div>
                <p className="kicker">Beside the loop</p>
                <h2 id="beside-title">Money, parallel work, and what the agent can see.</h2>
              </div>
              <p>These apply to every stop above, not to one of them.</p>
            </div>
            <div className="home-beside">
              <article className="home-card home-hl">
                <SpendMini />
                <h3>Money in dollars, with a ceiling you set</h3>
                <p>
                  Spend per run and per ticket on <code>/spend</code>; what a day landed on <code>/report</code>. A cost
                  Lingtai cannot know shows as unknown, never as zero.
                </p>
                <p>
                  A daily ceiling stops <em>new</em> work once it is reached. It is not a cap on the day&rsquo;s total:
                  a pass already running finishes.
                </p>
              </article>
              <article className="home-card home-hl">
                <LanesMini />
                <h3>Several tickets at once</h3>
                <p>
                  Set how many each project runs. Lingtai never starts two on one blocked-by chain, or two whose Fix
                  rows name the same file, and lands them one at a time.
                </p>
                <p>
                  More than one needs a daily dollar ceiling, so parallel work can&rsquo;t run up a bill unattended.
                </p>
              </article>
              <article className="home-card home-hl">
                <EnvironmentMini />
                <h3>The agent sees what you declared</h3>
                <p>
                  A filtered environment, a worktree of its own, and no Lingtai setting. Your own Claude Code or Codex
                  restrictions still hold.
                </p>
                <p>
                  This is not a container: Codex runs add a filesystem boundary, Claude Code runs are{' '}
                  <code>guarded</code>.
                </p>
              </article>
            </div>
          </section>

          <section aria-labelledby="six-title">
            <div className="section-intro">
              <div>
                <p className="kicker">Six more things</p>
                <h2 id="six-title">What this adds up to.</h2>
              </div>
              <p>Short versions of what the sections above and the docs say at length.</p>
            </div>
            <div className="home-six">
              <BuildsItself landed={landedCount(snapshot)} />
              <article className="home-card home-six-card">
                <span className="home-ico" aria-hidden="true">
                  ?
                </span>
                <h3>Stops explain themselves</h3>
                <p>
                  A waiting ticket shows what is asked, the answers it allows with the recommended one first, and what
                  each one does.
                </p>
              </article>
              <article className="home-card home-six-card">
                <span className="home-ico" aria-hidden="true">
                  ⑂
                </span>
                <h3>Work is not lost</h3>
                <p>
                  Each attempt&rsquo;s commits are pushed to <code>agent/&lt;n&gt;-attempt-&lt;k&gt;</code>. An unpushed
                  head is kept, and the page shows the rescue command.
                </p>
              </article>
              <article className="home-card home-six-card">
                <span className="home-ico" aria-hidden="true">
                  $
                </span>
                <h3>Money you can see and limit</h3>
                <p>
                  <code>/spend</code> and <code>/report</code> in dollars, and a daily ceiling that stops new work. It
                  is not a cap on the day&rsquo;s total.
                </p>
              </article>
              <article className="home-card home-six-card">
                <span className="home-ico" aria-hidden="true">
                  ≠
                </span>
                <h3>Review that does not waste money</h3>
                <p>
                  A fix round reviews what the fix changed. Findings already on the base buy no round. A base that moved
                  is merged and reviewed again.
                </p>
              </article>
              <article className="home-card home-six-card">
                <span className="home-ico" aria-hidden="true">
                  ⊘
                </span>
                <h3>Your own restrictions still hold</h3>
                <p>
                  What you deny in your own Claude Code or Codex settings still applies to an agent Lingtai launches;
                  Lingtai only narrows it, never widens it.
                </p>
              </article>
            </div>
            <div className="home-also" aria-label="Also">
              <h3>Also</h3>
              <ul>
                <li>
                  Connect GitHub with <code>gh auth login</code> &mdash; a GitHub App only when a team needs one.{' '}
                  <a className="link" href={`${ISSUES}/706`}>
                    #706&ndash;#713
                  </a>
                </li>
                <li>
                  Every release lists the tickets it landed and the decisions it changed.{' '}
                  <a className="link" href={`${ISSUES}/776`}>
                    #776
                  </a>
                </li>
                <li>
                  Each pass is an OpenTelemetry trace when you give it a collector.{' '}
                  <a className="link" href={`${ISSUES}/791`}>
                    #791
                  </a>
                </li>
              </ul>
            </div>
          </section>

          <section className="home-setup" id="setup" aria-labelledby="setup-title">
            <div className="setup-lead">
              <p className="kicker">How you use it</p>
              <h2 id="setup-title">Start with one repository.</h2>
              <p>Set it up on your machine, tell it where tickets live, then let it run.</p>
            </div>
            <ol className="setup-steps">
              <li>
                <span className="step-number">01</span>
                <div>
                  <h3>One command, from a bare machine</h3>
                  <div className="command">
                    <span>$</span> lingtai init
                  </div>
                  <p>It looks before it asks. The first question is where tickets live:</p>
                  <ul>
                    <li>
                      <b>a GitHub project</b>: it then asks how this machine reaches GitHub, through a signed-in{' '}
                      <code>gh</code> (the default; it can sign you in from the question), or a GitHub App, which is for
                      a team;
                    </li>
                    <li>
                      <b>a repository on this machine only</b>: tickets are kept in Lingtai&rsquo;s own database.
                    </li>
                  </ul>
                  <p>
                    Then your agent, your checks, and whether a person approves: &ldquo;wait for me to approve&rdquo; or
                    &ldquo;land it without asking&rdquo;. It ends on a summary of what it set up and what to do next.
                  </p>
                </div>
              </li>
              <li>
                <span className="step-number">02</span>
                <div>
                  <h3>Open one ticket</h3>
                  <p>
                    On a GitHub project, a labeled issue, with one of your recipe&rsquo;s kinds. On a local project:
                  </p>
                  <div className="command">
                    <span>$</span> lingtai ticket new
                  </div>
                  <p>
                    A short form: a title, a <code>labels:</code> line carrying one of your recipe&rsquo;s kinds, then
                    the body. On a GitHub project it will tell you to use <code>gh issue</code> instead.
                  </p>
                </div>
              </li>
              <li>
                <span className="step-number">03</span>
                <div>
                  <h3>Check it, then start</h3>
                  <div className="command">
                    <span>$</span> lingtai doctor
                  </div>
                  <div className="command">
                    <span>$</span> lingtai start
                  </div>
                  <p>
                    Follow the run on the board or with <code>lingtai status</code>. <code>start</code> prints one line
                    per ticket: steps, cost, where it stopped, and the command when it waits.
                  </p>
                </div>
              </li>
            </ol>
          </section>

          <section className="home-evidence" aria-labelledby="evidence-title">
            <div className="section-intro">
              <div>
                <p className="kicker">The work, in the open</p>
                <h2 id="evidence-title">A board that shows the stops, too.</h2>
              </div>
              <p>
                The local board puts queued, running, waiting and landed work together. When a publishable snapshot is
                available, this is Lingtai&rsquo;s own board&mdash;not a demo with invented results.
              </p>
            </div>
            {snapshot === null ? <NoSnapshot /> : <SnapshotBoard snapshot={snapshot} />}
          </section>

          <p className="home-edges">
            <b>Know the edges:</b> Not a container sandbox · one machine, macOS or Linux · pre-1.0 &mdash;{' '}
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

/** A labeled illustration of the product loop, not fabricated board data. */
function RunDiagram() {
  return (
    <div
      className="pass-diagram"
      role="img"
      aria-label="Illustration: a GitHub issue or a ticket on this machine enters Lingtai, an agent works in its own worktree with a filtered environment, your checks run, and the result either lands or waits for you."
    >
      <div className="diagram-bar">
        <span className="diagram-brand">
          <span className="diagram-mark" /> LINGTAI / THE LOOP
        </span>
        <span>ILLUSTRATION</span>
      </div>
      <div className="diagram-body">
        <div className="diagram-column">
          <div className="diagram-label">
            <span>01</span> YOUR TICKETS
          </div>
          <div className="diagram-card source-card">
            <small>GITHUB ISSUE · bug</small>
            <strong>Fix a failing test</strong>
          </div>
          <div className="diagram-card source-card alt">
            <small>OR ON THIS MACHINE</small>
            <strong>lingtai ticket new</strong>
          </div>
          <div className="diagram-footnote">Labels choose the work</div>
        </div>
        <div className="diagram-arrow" aria-hidden="true" />
        <div className="diagram-column middle">
          <div className="diagram-label">
            <span>02</span> LINGTAI
          </div>
          <div className="diagram-card work-card">
            <div className="work-branch">
              <span className="branch-symbol">⑂</span> agent / ticket
            </div>
            <div className="work-line">
              <span className="work-node" /> Own worktree, filtered environment
            </div>
            <div className="work-line">
              <span className="work-node" /> Agent makes a change
            </div>
            <div className="work-line">
              <span className="work-node check" /> Your checks run
            </div>
          </div>
          <div className="diagram-footnote">Your recipe sets the rules</div>
        </div>
        <div className="diagram-arrow" aria-hidden="true" />
        <div className="diagram-column result-column">
          <div className="diagram-label">
            <span>03</span> THE RESULT
          </div>
          <div className="diagram-card outcome-card landed-outcome">
            <span>✓</span>
            <strong>It lands</strong>
            <small>when allowed</small>
          </div>
          <div className="diagram-or">OR</div>
          <div className="diagram-card outcome-card waiting-outcome">
            <span>!</span>
            <strong>It waits on you</strong>
            <small>with a reason</small>
          </div>
        </div>
      </div>
      <div className="diagram-bottom">
        NO SECOND BACKLOG <span>·</span> RUNS ON YOUR MACHINE <span>·</span> NO SIGNUP
      </div>
    </div>
  )
}
