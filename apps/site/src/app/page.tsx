import Link from "next/link";
import { readSnapshot, stamp } from "@/lib/snapshot";
import { Bar, Foot, REPO } from "./chrome";
import { NoSnapshot, SnapshotBoard } from "./snapshot-board";

/**
 * The front page.
 *
 * What Lingtai is, stated once: **the harness you put around a coding agent so
 * you can leave it running.** It takes issues one at a time, gives each a
 * disposable worktree and a filtered environment, holds it at the gates the
 * repository defines, and merges only what passes them.
 *
 * What it is *not* is a record-keeping product. The event log is why the
 * promise is credible, not the promise — so it is under "when it goes wrong",
 * a long way down, and never in the hero. Nobody arrives wanting a record.
 * They arrive wanting the queue to move without them watching it.
 */
export default async function Home() {
  const snapshot = await readSnapshot();

  return (
    <>
      <Bar note={snapshot === null ? undefined : `board · ${stamp(snapshot.capturedAt)}`} />

      <main>
        <div className="wrap">
          <section className="hero">
            <h1>The harness you put around a coding agent so you can leave it running.</h1>
            <p className="lede">
              Lingtai takes issues one at a time, gives each a disposable worktree and a filtered
              environment, holds it at the gates your repository defines, and merges only what
              passes them.
            </p>
            <div className="row">
              {/* The one coral thing on this page. Coral marks the way in and
                  nothing else — see the rule at the top of `site.css`. */}
              <Link className="way-in" href="/docs/tutorial/">
                Start with the tutorial
              </Link>
              <a className="second" href={REPO}>
                Read the source →
              </a>
            </div>
          </section>

          <section>
            <p className="kicker">Right now</p>
            <h2>This is the queue it is running, including the part that is stuck.</h2>
            <p style={{ margin: "0 0 20px", color: "var(--ink-2)" }}>
              Four lanes, and the third one is the reason the board exists: work the machine has
              taken as far as it can and handed back. Every card below is a real work item in a
              real repository, with what it actually cost.
            </p>
            {snapshot === null ? <NoSnapshot /> : <SnapshotBoard snapshot={snapshot} />}
          </section>

          <section>
            <p className="kicker">The loop</p>
            <h2>Five places it stops, and your repository says what happens at each.</h2>
            <p>
              The set is closed — no sixth point will ever be added. What runs <i>at</i> a point is
              open and comes from one committed file, <code>.lingtai/config.yaml</code>, in the
              repository being worked. Adding a security scan or a second reviewer is a line in that
              file, not a change to Lingtai.
            </p>
            <ol className="points">
              <li>
                <span className="pt">admit</span>
                <span>the queue offers an item, before it is claimed</span>
                <span className="may">may refuse — it stays queued</span>
              </li>
              <li>
                <span className="pt">prepared</span>
                <span>the worktree exists, before the agent starts</span>
                <span className="may">may refuse — before money is spent</span>
              </li>
              <li>
                <span className="pt">proposed</span>
                <span>the agent stopped and there are commits</span>
                <span className="may">may refuse</span>
              </li>
              <li>
                <span className="pt">merge</span>
                <span>after <code>proposed</code> passes, before the merge lane</span>
                <span className="may">may refuse</span>
              </li>
              <li>
                <span className="pt">end</span>
                <span>the item reached any terminal outcome</span>
                <span className="may no">cannot refuse — its actions are effects</span>
              </li>
            </ol>
          </section>

          <section>
            <p className="kicker">What the agent gets</p>
            <h2>A worktree of its own, and nothing it was not given.</h2>
            <div className="grid">
              <div>
                <h3>A disposable worktree</h3>
                <p>
                  One item, one branch, one directory, cut from the base and deleted when the run
                  ends. Uncommitted work goes with it, which is a property and not an accident: what
                  survives a run is what the run committed.
                </p>
              </div>
              <div>
                <h3>A filtered environment</h3>
                <p>
                  The recipe names the variables a project&rsquo;s agent may see, and it gets those
                  and no others. A missing value refuses the whole project before an issue is
                  claimed — no worktree, no agent, no money.
                </p>
              </div>
              <div>
                <h3>Gates it cannot skip</h3>
                <p>
                  A configured check that did not run is a bug, not a preference. An unconfigured
                  gate is shown as <code>skipped</code>, never omitted, because absent and
                  silently-not-run have to be distinguishable.
                </p>
              </div>
              <div>
                <h3>An ordinary repository</h3>
                <p>
                  One committed file. No bot account, no CI job, no label state machine. Delete
                  Lingtai tomorrow and the repository would not notice.
                </p>
              </div>
            </div>
          </section>

          <section>
            <p className="kicker">When it goes wrong</p>
            <h2>Every answer is one query against one log.</h2>
            <p>
              Three questions decide whether you can leave a coding agent running:{" "}
              <i>what state is this ticket in</i>, <i>why did this not merge</i>, and{" "}
              <i>what is waiting on me</i>. Scatter them — state in labels, history in comments,
              telemetry nobody parses — and each is answerable only by somebody who already knows
              where to look.
            </p>
            <p>
              So every component appends to one append-only table and keeps no state of its own.
              There is a single projection, and it is rebuilt by replaying the log rather than
              repaired by hand. Nothing decides in private, which is why the board and the
              command line cannot disagree about why something stopped — and why a claim about
              this system is settled by citing a sequence number rather than by arguing.
            </p>
            <p>
              <Link className="link" href="/docs/reference/">
                Every term, and everything currently in it
              </Link>{" "}
              ·{" "}
              <a className="link" href="/doc/architecture.html">
                Six diagrams: which process am I in
              </a>
            </p>
          </section>

          <section>
            <p className="kicker">Open</p>
            <h2>What does not work.</h2>
            <p>
              <code>lingtai doctor</code> prints a check it has not implemented as{" "}
              <code>skip</code> rather than leaving it out, because a check you cannot see is a
              check you will forget you never had. The same posture applies to this page: a system
              whose claim is that you can see what happened does not get to hide its own gaps.
            </p>
            <ul className="open">
              <li>
                <b>
                  Two of the five points run nothing yet: <code>admit</code> and <code>merge</code>.
                </b>{" "}
                <span>
                  Both are resolved into the run&rsquo;s plan and drawn on the board, and no
                  pipeline executes at either. A recipe that configures one is not refused — it is
                  simply not run, which is the failure this project names as its worst kind.{" "}
                  <a className="link" href={`${REPO}/issues/58`}>
                    #58
                  </a>
                  .
                </span>
              </li>
              <li>
                <b>
                  <code>seq</code> is not gapless.
                </b>{" "}
                <span>
                  A Postgres sequence claims a value when the insert runs and publishes it at
                  commit, so under concurrent writers a subscriber can see 6 while 5 is still in
                  flight and a checkpoint advanced past 5 skips it forever. It cannot bite while the
                  conductor is the single writer, and it has to be solved rather than assumed away.
                </span>
              </li>
              <li>
                <b>
                  <code>tier: sandboxed</code> is not built.
                </b>{" "}
                <span>
                  Containerising the whole toolchain is its own piece of work. What exists is{" "}
                  <code>guarded</code>: a worktree of its own, a filtered environment, and a guard
                  that refuses tool calls outside it.
                </span>
              </li>
              <li>
                <b>A running daemon holds the code it started with.</b>{" "}
                <span>
                  Node caches a module at import, so a merge into <code>main</code> reaches the next
                  process and not the one conducting. The beacon carries the commit the daemon
                  started at and <code>lingtai doctor</code> says how far behind that is; neither
                  restarts it, and whether it should is open.
                </span>
              </li>
              <li>
                <b>Forward compatibility stops at the store.</b>{" "}
                <span>
                  The reducers ignore an event type they do not know, so an older projection
                  survives a newer conductor. The store does not — it throws on read. Deliberate for
                  now, and it means the tolerance is only real once the two agree.
                </span>
              </li>
              <li>
                <b>Nothing has run unattended long enough to have earned trust.</b>{" "}
                <span>
                  <code>lingtai pause</code> exists because that is the honest state to be in. Watch
                  it.
                </span>
              </li>
            </ul>
          </section>
        </div>
      </main>

      <Foot />
    </>
  );
}
