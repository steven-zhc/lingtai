import Link from "next/link";
import { FRONT_PAGE_DOCS } from "@/lib/docs";
import { readSnapshot, stamp } from "@/lib/snapshot";
import { Bar, Foot, REPO } from "./chrome";
import { NoSnapshot, SnapshotBoard } from "./snapshot-board";

export default async function Home() {
  const snapshot = await readSnapshot();

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
                Lingtai picks up labeled GitHub issues, lets an agent work on them one at a time,
                runs your repository&rsquo;s checks, and lands passing work. If a run needs you, it
                stops with a reason.
              </p>
              <div className="hero-actions">
                <Link className="way-in" href="/docs/tutorial/">
                  Get started <span aria-hidden="true">↗</span>
                </Link>
                <a className="second" href="#how-it-works">
                  See how it works <span aria-hidden="true">↓</span>
                </a>
              </div>
              <p className="hero-note">Runs on your machine · Uses your issues and checks · No signup</p>
            </div>
            <RunDiagram />
          </section>

          <section className="benefits" id="how-it-works" aria-labelledby="benefits-title">
            <div className="section-intro">
              <div>
                <p className="kicker">What changes for you</p>
                <h2 id="benefits-title">Less assigning. Less watching. Fewer mysteries.</h2>
              </div>
              <p>Your existing workflow stays in GitHub. Lingtai does the repeatable work between an issue and a decision.</p>
            </div>
            <div className="benefit-grid">
              <article className="benefit-card">
                <div className="mini-queue" aria-hidden="true">
                  <div className="mini-title">YOUR ISSUES <span>→ NEXT UP</span></div>
                  <div className="mini-row chosen"><span className="mini-dot" /> Fix failing test <i>bug</i></div>
                  <div className="mini-row"><span className="mini-dot" /> Update API docs <i>feature</i></div>
                  <div className="mini-row muted"><span className="mini-dot" /> On hold <i>blocked</i></div>
                </div>
                <h3>The queue is already yours</h3>
                <p>Label an issue. Your recipe decides what is eligible; there is no second backlog to maintain.</p>
              </article>
              <article className="benefit-card">
                <div className="mini-checks" aria-hidden="true">
                  <div className="mini-title">YOUR RULES <span>→ VERDICT</span></div>
                  <div className="mini-check"><span>01</span> Isolated worktree <b>✓</b></div>
                  <div className="mini-check"><span>02</span> Your test command <b>✓</b></div>
                  <div className="mini-check final"><span>03</span> Merge if allowed <b>→</b></div>
                </div>
                <h3>You set the boundaries</h3>
                <p>The agent writes code. Your committed recipe determines the checks and whether a person must approve.</p>
              </article>
              <article className="benefit-card">
                <div className="mini-board" aria-hidden="true">
                  <div className="mini-title">ONE VIEW <span>→ WHAT NEEDS YOU</span></div>
                  <div className="mini-lanes">
                    <div><small>QUEUED</small><span className="mini-block" /></div>
                    <div><small>RUNNING</small><span className="mini-block active" /></div>
                    <div className="attention"><small>WAITING ON YOU</small><span className="mini-block">Review needed</span></div>
                    <div><small>LANDED</small><span className="mini-block done" /></div>
                  </div>
                </div>
                <h3>Only step in when needed</h3>
                <p>See what is moving, what landed, and why something stopped—without chasing an agent&rsquo;s transcript.</p>
              </article>
            </div>
          </section>

          <section className="difference" aria-labelledby="difference-title">
            <div className="difference-copy">
              <p className="kicker">Why Lingtai</p>
              <h2 id="difference-title">An agent can make a patch. Who runs the rest of the loop?</h2>
              <p>Giving an agent a task is one thing. Keeping a queue moving safely, especially when you are away, needs a way to choose work, check it, and hand failures back.</p>
              <Link className="link" href="/docs/guide/">Learn what makes a good issue →</Link>
            </div>
            <div className="comparison" aria-label="What Lingtai adds around a coding agent">
              <div className="comparison-head"><span>THE QUESTION</span><span>LINGTAI&rsquo;S ANSWER</span></div>
              <div><span>What should it work on?</span><strong>Your labeled issues</strong></div>
              <div><span>Where can it work?</span><strong>One disposable worktree</strong></div>
              <div><span>Can the change land?</span><strong>Your checks and approval rule</strong></div>
              <div><span>What happened when it stopped?</span><strong>A visible reason on the board</strong></div>
            </div>
          </section>

          <section className="setup" aria-labelledby="setup-title">
            <div className="setup-lead">
              <p className="kicker">How you use it</p>
              <h2 id="setup-title">Start with one repository.</h2>
              <p>Set it up on your machine, tell it which issues count, then let the daemon run.</p>
              <Link className="link" href="/docs/tutorial/">Follow the complete tutorial →</Link>
            </div>
            <ol className="setup-steps">
              <li>
                <span className="step-number">01</span>
                <div>
                  <h3>Connect the essentials</h3>
                  <p>Bring Postgres, a GitHub App, and a signed-in agent runtime. Run <code>pnpm lingtai doctor</code> to check the setup.</p>
                </div>
              </li>
              <li>
                <span className="step-number">02</span>
                <div>
                  <h3>Commit your rules</h3>
                  <p>In <code>.lingtai/config.yaml</code>, choose issue labels, allowed environment variables, and the checks a change must pass.</p>
                </div>
              </li>
              <li>
                <span className="step-number">03</span>
                <div>
                  <h3>Give it a repo and go</h3>
                  <div className="command"><span>$</span> pnpm lingtai add owner/repo</div>
                  <div className="command"><span>$</span> pnpm lingtai daemon</div>
                  <p>Label an issue. Follow the run on the local board.</p>
                </div>
              </li>
            </ol>
          </section>

          <section className="evidence" aria-labelledby="evidence-title">
            <div className="section-intro">
              <div>
                <p className="kicker">The work, in the open</p>
                <h2 id="evidence-title">A board that shows the stops, too.</h2>
              </div>
              <p>The local board puts queued, running, waiting, and landed work together. When a publishable snapshot is available, this is Lingtai&rsquo;s own board—not a demo with invented results.</p>
            </div>
            {snapshot === null ? <NoSnapshot /> : <SnapshotBoard snapshot={snapshot} />}
          </section>

          <section className="limits" aria-labelledby="limits-title">
            <div className="section-intro">
              <div>
                <p className="kicker">Know the edges</p>
                <h2 id="limits-title">Useful today. Still unfinished.</h2>
              </div>
              <p>Self-hosted software you can inspect, pause, and improve—not a promise that every edge is solved.</p>
            </div>
            <ul className="limit-list">
              <li><b>Not a container sandbox.</b> Guarded runs use a worktree, filtered environment, and recording hook; <code>sandboxed</code> is not built.</li>
              <li><b>Two gate points are not active.</b> Configured <code>admit</code> and <code>merge</code> pipelines are shown but do not execute yet. <a className="link" href="https://github.com/steven-zhc/lingtai/issues/58">Track #58</a></li>
              <li><b>There are operational edges.</b> Sequence gaps, daemon code updates, and store-version compatibility still need work. <Link className="link" href="/docs/operating/">Read the operating guide</Link></li>
            </ul>
          </section>

          <section className="more" aria-labelledby="more-title">
            <div>
              <p className="kicker">Keep exploring</p>
              <h2 id="more-title">See the details when you need them.</h2>
              <p>Start with the tutorial, or go straight to the source and the operating notes.</p>
            </div>
            <div className="more-links">
              {FRONT_PAGE_DOCS.map((doc) => (
                <a key={doc.href} href={doc.href}>{doc.title}<span aria-hidden="true">↗</span></a>
              ))}
              <a href={REPO}>GitHub source<span aria-hidden="true">↗</span></a>
            </div>
          </section>
        </div>
      </main>
      <Foot />
    </>
  );
}

/** A labeled illustration of the product loop, not fabricated board data. */
function RunDiagram() {
  return (
    <div className="run-diagram" role="img" aria-label="Illustration: a labeled GitHub issue enters Lingtai, an agent works in an isolated worktree, your checks run, and the result either lands or waits for you.">
      <div className="diagram-bar">
        <span className="diagram-brand"><span className="diagram-mark" /> LINGTAI / THE LOOP</span>
        <span>ILLUSTRATION</span>
      </div>
      <div className="diagram-body">
        <div className="diagram-column">
          <div className="diagram-label"><span>01</span> YOUR GITHUB</div>
          <div className="diagram-card source-card">
            <small>ISSUE · bug</small>
            <strong>Fix a failing test</strong>
            <span className="diagram-tag">ready for work</span>
          </div>
          <div className="diagram-footnote">Your labels choose the work</div>
        </div>
        <div className="diagram-arrow" aria-hidden="true">→</div>
        <div className="diagram-column middle">
          <div className="diagram-label"><span>02</span> LINGTAI</div>
          <div className="diagram-card work-card">
            <div className="work-branch"><span className="branch-symbol">⑂</span> agent / issue</div>
            <div className="work-line"><span className="work-node" /> Isolated worktree</div>
            <div className="work-line"><span className="work-node" /> Agent makes a change</div>
            <div className="work-line"><span className="work-node check" /> Your checks run</div>
          </div>
          <div className="diagram-footnote">Your repository sets the rules</div>
        </div>
        <div className="diagram-arrow" aria-hidden="true">→</div>
        <div className="diagram-column result-column">
          <div className="diagram-label"><span>03</span> THE RESULT</div>
          <div className="diagram-card outcome-card landed-outcome"><span>✓</span><strong>It lands</strong><small>when allowed</small></div>
          <div className="diagram-or">OR</div>
          <div className="diagram-card outcome-card waiting-outcome"><span>!</span><strong>It waits on you</strong><small>with a reason</small></div>
        </div>
      </div>
      <div className="diagram-bottom">ONE ISSUE AT A TIME <span>·</span> NO SECOND BACKLOG <span>·</span> NO SIGNUP</div>
    </div>
  );
}
