import Link from "next/link";
import { FRONT_PAGE_DOCS } from "@/lib/docs";
import { money, readSnapshot, stamp } from "@/lib/snapshot";
import { ISSUES, TICKETS, type Ticket } from "@/lib/tickets";
import { Bar, Foot, REPO } from "./chrome";
import { NoSnapshot, SnapshotBoard } from "./snapshot-board";

/**
 * The front page, and the order it argues in.
 *
 * **The thesis is the outcome, not the mechanism**: point it at a repository
 * and your backlog starts moving. Lingtai is the harness you put around a
 * coding agent so you can leave it running — that sentence is the paragraph
 * under the headline, not the headline, because nobody arrives wanting a
 * harness.
 *
 * Then three ideas and no more (the loop), then the claim this project
 * under-uses (your repository sets the rules), then what it costs when it goes
 * wrong, then what is not built, then the docs.
 *
 * **The event log appears in "when it goes wrong" and nowhere above it.** It is
 * why the promise is credible, not the promise — a rule from
 * `doc/decisions/0035-the-site-is-a-projection.md`, and the reason the sections
 * are in this order rather than in the order the system was built in. The board
 * in the hero is a picture of the queue moving; it says where it came from,
 * which is disclosure, and it makes no argument out of the log's existence.
 */
export default async function Home() {
  const snapshot = await readSnapshot();

  return (
    <>
      <Bar note={snapshot === null ? undefined : `board · ${stamp(snapshot.capturedAt)}`} />

      <main>
        <div className="wrap">
          <section className="hero">
            <div>
              <h1>Point it at a repository, and your backlog starts moving.</h1>
              <p className="lede">
                Lingtai is the harness you put around a coding agent so you can leave it running. It
                takes issues one at a time, gives each a disposable worktree and a filtered
                environment, holds it at the gates your repository defines, and merges only what
                passes them.
              </p>
              <div className="row">
                {/* Coral, once. The other one is the claim in "your repository
                    sets the rules", and there is no third — see the rule at the
                    top of `site.css`. */}
                <Link className="way-in" href="/docs/tutorial/">
                  Start with the tutorial
                </Link>
                <a className="second" href={REPO}>
                  Read the source →
                </a>
              </div>
              <p className="hero-note">
                It runs on one machine of yours, next to a Postgres database and a clone of each
                repository it manages. There is no service here to sign up for.
              </p>
            </div>
            <div className="hero-board">
              {snapshot === null ? (
                <NoSnapshot />
              ) : (
                <>
                  {/* The lane that makes the other three believable is the third
                      one, so it is what the caption points at. */}
                  <p className="board-cap">
                    Every card is a real work item in a real repository, with what it actually cost
                    — including the lane holding work the machine took as far as it could and handed
                    back.
                  </p>
                  <SnapshotBoard snapshot={snapshot} />
                </>
              )}
            </div>
          </section>

          <section>
            <p className="kicker">The loop</p>
            <h2>It takes the next issue, gives it somewhere to fail, and lets the gates decide.</h2>
            <div className="grid">
              <div>
                <h3>It takes the next issue</h3>
                <p>
                  The queue is your issue tracker, asked on every pass. The labels you already use
                  decide what is eligible — your recipe names the kinds that qualify and the ones
                  that disqualify — and one item is in flight at a time. Nothing is copied out of
                  GitHub: an issue you close or hold is one the next pass does not offer.
                </p>
              </div>
              <div>
                <h3>The agent gets a blast radius</h3>
                <p>
                  One item, one branch, one worktree cut from the base and deleted when the run
                  ends. Its environment holds the variables your recipe names and no others, and a
                  hook refuses tool calls that reach outside the directory. What survives a run is
                  what the run committed.
                </p>
              </div>
              <div>
                <h3>Gates decide, not the agent</h3>
                <p>
                  An agent can commit; it cannot merge. Between its last commit and your base
                  branch are the checks your repository names — a build, a test suite, a reviewer, a
                  person — and a run that fails one stops there with a typed reason rather than a
                  guess about what to do next.
                </p>
              </div>
            </div>
          </section>

          <section>
            <p className="kicker">Your repository sets the rules</p>
            <h2>One committed file, and nothing else in your repository changes.</h2>
            <p>
              <code>.lingtai/config.yaml</code> says what work is eligible, what an agent may see,
              and what has to pass before anything merges. Lingtai reads it from{" "}
              <code>origin</code> at claim time, never from the branch the agent is working on — so
              an agent that edits it changes nothing about the run in flight.
            </p>
            <pre className="recipe">
              <code>{RECIPE}</code>
            </pre>
            <p className="recipe-note">
              Abbreviated from{" "}
              <a className="link" href={`${REPO}/blob/main/.lingtai/config.yaml`}>
                this repository&rsquo;s own file
              </a>
              , which is how Lingtai works on Lingtai.
            </p>
            {/* The second coral thing on this page, and the last. It is not an
                action and links nowhere: a reader is never made to choose which
                of two coral things is the way in. */}
            <div className="claim">
              <p>
                <b>No bot account, no label state machine, no CI job.</b> Lingtai authenticates as a
                GitHub App you install. It reads the labels you already use and writes one back only
                where your recipe says to, and the state it keeps is on its own machine rather than
                encoded in your issues.
              </p>
              <p>
                <b>Delete Lingtai tomorrow and the repository would not notice.</b> What is left is
                a branch, some merge commits, and issues closed the way any contributor closes them.
              </p>
            </div>
          </section>

          <section>
            <p className="kicker">When it goes wrong</p>
            <h2>Two tickets, and what they cost.</h2>
            <p>
              A harness is judged on the run that did not work. Both of these are issues in this
              repository, which is one of the repositories Lingtai runs: one stopped, one landed.
            </p>
            <div className="cases">
              {TICKETS.map((ticket) => (
                <Case key={ticket.ref} ticket={ticket} />
              ))}
            </div>
            <h3 style={{ marginTop: 34 }}>Why either of those is answerable at all</h3>
            <p>
              Three questions decide whether you can leave a coding agent running:{" "}
              <i>what state is this ticket in</i>, <i>why did this not merge</i>, and{" "}
              <i>what is waiting on me</i>. Scatter them — state in labels, history in comments,
              spend in a file nobody parses — and each one is answerable only by somebody who
              already knows where to look.
            </p>
            <p>
              So every component appends to one append-only table and keeps no state of its own.
              There is a single projection, and it is rebuilt by replaying the log rather than
              repaired by hand. Nothing decides in private, which is why the board and the command
              line cannot disagree about why something stopped — and why a claim about this system
              is settled by citing a sequence number rather than by arguing.
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
                  Two of the five gate points run nothing yet: <code>admit</code> and{" "}
                  <code>merge</code>.
                </b>{" "}
                <span>
                  Both are resolved into the run&rsquo;s plan and drawn on the board, and no
                  pipeline executes at either. A recipe that configures one is not refused — it is
                  simply not run, which is the failure this project names as its worst kind.{" "}
                  <a className="link" href={`${ISSUES}58`}>
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
                  restarts it, and whether it should is open.{" "}
                  <a className="link" href={`${ISSUES}98`}>
                    #98
                  </a>
                  .
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

          <section>
            <p className="kicker">Docs</p>
            <h2>Six places to start, all of them files in this repository.</h2>
            <ul className="doc-list">
              {FRONT_PAGE_DOCS.map((doc) => (
                <li key={doc.href}>
                  <a href={doc.href}>
                    <span className="t">{doc.title}</span>
                    {/* Which file it is. A page that hides where it came from
                        is indistinguishable from a copy of it. */}
                    <span className="s">doc/{doc.source}</span>
                    <span className="l">{doc.note}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </main>

      <Foot />
    </>
  );
}

/**
 * One ticket, with its figures as the board's own pills.
 *
 * The amount is rendered by `money()` from a number in `lib/tickets.ts`, which
 * a test checks against the document in `doc/` that records it. Nothing on this
 * page prints a figure that this repository does not already write down.
 */
function Case({ ticket }: { ticket: Ticket }) {
  return (
    <article className={`case ${ticket.landed ? "landed" : "stuck"}`}>
      <div className="id">
        <a className="iss" href={`${ISSUES}${ticket.ref}`}>
          #{ticket.ref}
        </a>{" "}
        <span>steven-zhc/lingtai</span> · {ticket.kind}
      </div>
      <h3>{ticket.what}</h3>
      <p>{ticket.story}</p>
      <ul className="meta">
        {/* `hold` and not `sig`: amber on the board means a person is being
            waited on *now*, and these two are history. The board's own colour
            for an attempt that ended without landing is the honest one. */}
        <li className={`pill ${ticket.landed ? "pass" : "hold"}`}>
          {ticket.landed ? "landed" : "did not land"}
        </li>
        <li className="pill">{money(ticket.costUsd)}</li>
        {ticket.attempts !== null && <li className="pill hold">{ticket.attempts} attempts</li>}
      </ul>
      <p className="src">
        Recorded in{" "}
        <a className="link" href={`${REPO}/blob/main/doc/${ticket.source}`}>
          doc/{ticket.source}
        </a>
      </p>
    </article>
  );
}

/**
 * The recipe, abbreviated from this repository's own.
 *
 * Shortened and never invented: every key here is in the real file, with the
 * comments and the options this page is not explaining taken out. It is on the
 * page because "your repository sets the rules" is a claim a reader should be
 * able to check the size of — the whole of what Lingtai asks a repository for
 * fits on a screen.
 */
const RECIPE = `repo:
  base: main

source:
  kinds: [bug, tech-debt, feature]
  exclude: [agent:hold]

env:
  required: [LINGTAI_TEST_DATABASE_URL]
  plantAt: .env.local

gates:
  prepared:
    - name: install
      run: pnpm install --frozen-lockfile
  proposed:
    - name: build
      run: pnpm typecheck && pnpm test
  end:
    - name: close the ticket
      when: landed
      close: true`;
