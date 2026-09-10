import { elapsed, money, stamp, type Snapshot, type SnapshotCard, type SnapshotLane } from "@/lib/snapshot";

/**
 * Lingtai's own board, on the front page.
 *
 * **All four lanes, including the one that is stuck.** A board showing only
 * wins is the one nobody believes, and "one ticket is blocked on you, 20 hours,
 * $13.04" is a more persuasive claim about a harness than any adjective is.
 * The lane a visitor is most likely to be sceptical about is the lane that
 * makes the rest credible.
 *
 * The markup is the board's — `.cols`, `.col`, `.card`, `.pill`. Nothing here
 * invents a card style, so the picture on this page cannot drift from the
 * product it is a picture of.
 */
export function SnapshotBoard({ snapshot }: { snapshot: Snapshot }) {
  // The lane's own count and not the cards drawn in it: a lane publishes a
  // handful, and "3 waiting on people" has to mean three tickets rather than
  // three pictures of tickets.
  const waiting = snapshot.lanes.find((l) => l.id === "waiting")?.count ?? 0;
  return (
    <>
      <div className="snap">
        <div className="snap-head">
          <b>Lingtai&rsquo;s own board</b>
          <span className="when">
            {stamp(snapshot.capturedAt)}
            {snapshot.commit !== null && ` · ${snapshot.commit}`}
          </span>
          <span>
            {snapshot.totals.cards} work items · {snapshot.totals.turns} agent turns ·{" "}
            {money(snapshot.totals.costUsd)} spent
          </span>
          {waiting > 0 && (
            <span className="chip sig">
              {waiting} waiting on {waiting === 1 ? "a person" : "people"}
            </span>
          )}
        </div>
        <div className="cols">
          {snapshot.lanes.map((lane) => (
            <Lane key={lane.id} lane={lane} />
          ))}
        </div>
      </div>
      <p className="snap-note">
        Not live. Read from the event log when this page was built, on{" "}
        {stamp(snapshot.capturedAt)}, and stamped with that date — a page holding a connection to
        the log would be a coupling and, since not every repository on this board is public, an
        exposure. Each lane draws a few of its cards and counts all of them: the number beside a
        lane&rsquo;s name is the whole lane, and the totals above are the whole board.
        {snapshot.withheld > 0 && (
          <>
            {" "}
            {snapshot.withheld} of the cards on this board{" "}
            {snapshot.withheld === 1 ? "is" : "are"} from a private repository and{" "}
            {snapshot.withheld === 1 ? "keeps" : "keep"} everything except
            what names it: the lane, the age and the money are real, the title is withheld. Nothing
            is dropped, because a board that quietly omits some of its work is the board nobody
            should believe.
          </>
        )}
      </p>
    </>
  );
}

/** How many landed items stay open before the rest are counted rather than listed. */
const LANDED_OPEN = 3;

/**
 * One lane: the count is the lane, the cards are a sample of it.
 *
 * `lane.count` is what the header prints and `lane.cards` is what the snapshot
 * published (`LANE_CARDS`), so on a busy board those two disagree — and the
 * difference is drawn as a line rather than left for a reader to notice that
 * the header says twelve and there are five cards. A lane that showed
 * `cards.length` would be reporting the size of its own excerpt, which is the
 * kind of figure this page exists to not print.
 */
function Lane({ lane }: { lane: SnapshotLane }) {
  const hot = lane.id === "waiting" && lane.count > 0;
  const quiet = lane.id === "landed";
  return (
    <div className={`col${hot ? " hot" : ""}${quiet ? " quiet" : ""}`}>
      <div className="col-h">
        <span>{lane.label}</span>
        <span className="ct">{lane.count}</span>
      </div>
      {lane.cards.length === 0 ? (
        <p className="empty">
          {lane.id === "waiting" ? "Nothing is waiting on you." : "Nothing here."}
        </p>
      ) : quiet ? (
        <Landed lane={lane} />
      ) : (
        <>
          <div className="cards">
            {lane.cards.map((card, i) => (
              <Card key={i} card={card} />
            ))}
          </div>
          <Rest more={lane.count - lane.cards.length} />
        </>
      )}
    </div>
  );
}

/**
 * The lane that needs the least attention, at the weight it deserves: one line
 * each, and everything past the most recent few counted rather than drawn. The
 * board made the same decision for the same reason (#81).
 *
 * It counts against the lane and not against the handful it was given, so a
 * lane holding forty and publishing five says "and 37 more" rather than "and 2
 * more" — the same figure it would have said before the snapshot was capped.
 */
function Landed({ lane }: { lane: SnapshotLane }) {
  const shown = lane.cards.slice(0, LANDED_OPEN);
  return (
    <>
      <ul className="landed">
        {shown.map((card, i) => (
          <li key={i} className="lrow">
            <span className={card.ref === null ? "withheld" : undefined}>{ref(card)}</span>
            <span className="proj">{card.project ?? ""}</span>
            <span>{money(card.costUsd) ?? ""}</span>
          </li>
        ))}
      </ul>
      <Rest more={lane.count - shown.length} />
    </>
  );
}

/** What is in the lane and not on the page. Says where to find it. */
function Rest({ more }: { more: number }) {
  if (more <= 0) return null;
  return <p className="empty">and {more} more, all of them in the log.</p>;
}

function Card({ card }: { card: SnapshotCard }) {
  const age = elapsed(card.hoursSinceUpdate);
  const cost = money(card.costUsd);
  return (
    <article className={`card ${accent(card)}`}>
      <div className="id">
        {/* A published card's reference goes to the issue it names — in *its
            own* repository, which is not necessarily this one: the board is
            one board over every project Lingtai runs. A withheld card links
            nowhere, because the link would name what the card does not. */}
        {card.ref !== null && card.project !== null ? (
          <a className="iss" href={`https://github.com/${card.project}/issues/${card.ref.replace("#", "")}`}>
            {card.ref}
          </a>
        ) : (
          <span className="withheld">{ref(card)}</span>
        )}{" "}
        <span className="proj">{card.project ?? "a private repository"}</span> · {card.kind}
      </div>
      <div className="ti">
        {card.title ?? <span className="withheld">title withheld</span>}
      </div>
      <ul className="meta">
        {age !== null && <li className={`pill${card.blocked ? " sig" : ""}`}>{age}</li>}
        {card.turns !== null && <li className="pill">{card.turns} turns</li>}
        {cost !== null && <li className="pill">{cost}</li>}
        {card.attempts > 1 && <li className="pill hold">attempt {card.attempts}</li>}
        {card.blocked && <li className="pill sig">blocked on you</li>}
      </ul>
      {card.note !== null && <div style={{ color: "var(--ink-2)", fontSize: 11.5 }}>{card.note}</div>}
    </article>
  );
}

/**
 * What stands where the ticket number goes on a card that has none to show.
 *
 * The word, and not a dash or a blank: a card reading `#—` looks like a card
 * whose number failed to load, and this one has a number that was deliberately
 * not published. Absent and withheld are different facts, which is the same
 * distinction the gates draw between a check that was omitted and one that was
 * configured and did not run.
 */
function ref(card: SnapshotCard): string {
  return card.ref ?? "withheld";
}

/**
 * The stripe down the card's left edge, which is the board's one use of colour
 * on a card. Amber only when a person is the thing being waited on — the rule
 * the product's palette is built around, and the site does not get its own
 * version of it.
 */
function accent(card: SnapshotCard): string {
  if (card.blocked) return "a-sig";
  if (card.lane === "running") return "a-run";
  if (card.lane === "landed") return "a-pass";
  if (card.attempts > 1) return "a-hold";
  return "";
}

/**
 * What the hero says when no snapshot was taken.
 *
 * `lingtai doctor` prints an unimplemented check as `skip` rather than omitting
 * it, because a check you cannot see is a check you will forget you never had.
 * A missing board says it is missing for the same reason — and because the only
 * alternative, a plausible board with invented figures on it, would make every
 * other sentence on this page worth nothing.
 */
export function NoSnapshot() {
  return (
    <div className="no-snapshot">
      <b>No board snapshot was taken for this build.</b> The figures on this page come from the
      event log of the machine that built it, and that machine had no{" "}
      <code>LINGTAI_DATABASE_URL</code> — so there is nothing here rather than something plausible.
      Run <code>pnpm --filter @lingtai/site snapshot</code> beside a log and build again.
    </div>
  );
}
