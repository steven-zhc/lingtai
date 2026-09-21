import { inWords } from "@lingtai/conductor/queue";
import { elapsed, pointOf, type PointProgress, type PointState, type RunProgress } from "@/lib/progress";

/**
 * The five points as a sequence, on every surface that draws one.
 *
 * **Two surfaces, one file.** The board's running and waiting cards draw
 * `Rail`, its landed rows draw `Segs` bare, and the task page draws both: the
 * rail at rank 2 of a running item, and the segments under every attempt in
 * the record (#189). They were the board's alone, and the task page listed the
 * points off `task.ts`'s own fold — which had no `running` and no `never-ran`,
 * so it printed `N pending` for the two states `progress.ts` exists to tell
 * apart. Lifted rather than copied, because a copy is the second fold again.
 *
 * Both read `foldProgress` and nothing else ([the-card.md](../../../../doc/design/the-card.md)).
 */
/**
 * Where a point got to, as one class on one cell.
 *
 * **Not the card's pill vocabulary, and that is the point.** `pill pass` green
 * meant *a gate action passed* in the counters above and *this point passed* in
 * the row below, six tones doing two jobs, and a reader had to know which list
 * they were in before the colour meant anything
 * ([the-card.md](../../../../doc/design/the-card.md)). These are the sequence's
 * own, and nothing else on the card wears them.
 *
 * Three of the seven look empty and mean different things, so shape carries
 * what colour cannot: `pending` is a flat rule, `skipped` is a dashed outline
 * with no fill, and `never-ran` is hatched in the fail colour. A bar that drew
 * all five points with only "filled means done" would render the second of
 * those as the first, which is precisely the failure 0016 §4 names.
 */
const CELL_TONE: Record<PointState, string> = {
  passed: "t-pass",
  failed: "t-fail",
  running: "t-run",
  // A person's word standing in for a gate, and never the green one: an
  // override of a red build must not look like a build that went green.
  waived: "t-waived",
  // Hatched, in the fail colour and with no verdict behind it — the one mark
  // that breaks the rhythm, because it is the one state that is our bug.
  "never-ran": "t-never",
  // The same hatch, because it is the same thing to a reader of a bar: a point
  // that was configured, was reached, and judged nothing. What separates the
  // two is *whose* fault and *what to do*, which is a sentence and not a tone —
  // so it is on the segment's title and on the card, not in a sixth colour.
  "did-not-finish": "t-never",
  pending: "t-pending",
  skipped: "t-skipped",
};

/**
 * Which of the four weights a point's name carries.
 *
 * `off` is the one doing work no colour can. *Nothing configured* and *not
 * reached yet* are both grey, so the difference between them has to survive
 * being grey: it is italic.
 */
function labelTone(p: PointProgress, at: string | null): string {
  if (p.actions.length === 0) return "l-off";
  if (p.state === "failed" || p.state === "never-ran" || p.state === "did-not-finish") return "l-bad";
  if (p.state === "running" || p.point === at) return "l-at";
  return "l-done";
}

/** What a segment says on hover: what was configured there, and what came of it. */
function segTitle(p: PointProgress): string {
  if (p.actions.length === 0) return `${p.point}: nothing configured, so nothing runs`;
  if (p.state === "never-ran") {
    return `${p.point}: ${p.planned.join(", ")} — configured and did not run, which is Lingtai's bug (0016 §4)`;
  }
  if (p.state === "did-not-finish") {
    return `${p.point}: ${p.planned.join(", ")} — its agent started and produced no verdict, twice (0057)`;
  }
  return `${p.point}: ${p.actions.map((a) => `${a.name} ${a.state}`).join(", ")}`;
}

/**
 * The five points, in point order, as a bar.
 *
 * **All five, always.** A point that is merely omitted is indistinguishable
 * from one that was configured and silently did not run, and only the second of
 * those is Lingtai's bug (0016 §4).
 *
 * **One cell per action.** `prepared: [install]` draws one; `proposed` holds
 * `build` and `review` and draws two, each with its own verdict, so a point
 * that is half done looks half done. That is what let `N passed` go from the
 * counters above: a count of actions and a position in a sequence were the same
 * fact at two granularities, and only one of them has a shape. A point the
 * recipe left empty draws a single dashed cell — it keeps its place in the
 * sequence without claiming anything happened in it.
 */
export function Segs({
  points,
  at,
  labels,
}: {
  points: readonly PointProgress[];
  at: string | null;
  /**
   * Off on a landed row, which is one line by #81's decision and has no room
   * for five names. The row's rail is scanned for the one mark that is wrong —
   * the hatch — and the title on each segment says the rest.
   */
  labels: boolean;
}) {
  return (
    <ol className="segs">
      {points.map((p) => (
        <li key={p.point} className={`seg s-${p.state}`} title={segTitle(p)}>
          <span className="sbar">
            {(p.actions.length === 0 ? [{ name: p.point, state: p.state }] : p.actions).map((a) => (
              <span key={a.name} className={`scell ${CELL_TONE[a.state]}`} />
            ))}
          </span>
          {labels ? <span className={`slab ${labelTone(p, at)}`}>{p.point}</span> : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * What stopped this run, named as the action it was.
 *
 * A refusal clears the live phase, so a run with a red segment and nothing in
 * flight is stopped on it rather than *between* two points. In point order,
 * because the first refusal is the one that stopped it.
 *
 * **Only where nothing is in flight, and a bought round is in flight.** The
 * pipeline stops at the first refusal (0041 §4) and then, here, ordinarily buys
 * a round to answer it: `rounds: 3`, an agent patching the diff, and the card
 * still `running`. `foldProgress` names that phase for exactly this reason — a
 * refusal being answered is not a refusal waiting for a person, and this
 * function cannot tell them apart on its own.
 */
function refusedAt(points: readonly PointProgress[]): string | null {
  for (const p of points) {
    const bad = p.actions.find((a) => a.state === "failed");
    if (bad) return bad.name;
    if (p.state === "failed") return p.point;
  }
  return null;
}

/**
 * Where the run has got to, and what it is doing this second.
 *
 * **A sequence drawn as one, which it was not.** The five points were a wrapped
 * row of equal pills — a set — and a set loses the one thing a sequence has:
 * that it runs one way, and one of its members is *here*
 * ([the-card.md](../../../../doc/design/the-card.md), #170). Anything added to
 * this card that has an order gets a form that shows the order; anything that
 * does not stays a pill. `attempt` and `restart` are the other sequence, and
 * they are one object above for that reason.
 *
 * **The point name is said once.** The line used to read `proposed:build 42s /
 * 20m`; the highlighted label already says `proposed`, so the sentence is the
 * action and its bound and nothing else. A phase that names no point — the
 * agent, a bought round — is printed whole, which is `pointOf`'s whole job.
 *
 * **The sentence has four readings and the lane settles three of them.** What
 * is running, what refused, a run in flight between two points, and a run that
 * is not in flight at all. The last two look identical on this stream — no
 * phase, no refusal — and only one of them is *between* anything; the thing
 * holding the other is not on the run's stream to be found, because the merge
 * lane appends `IntegrationRefused` to its own and the card gets the note. And
 * the second is only ever true off the running lane: a refusal a pass is still
 * working through is not a refusal anybody has been handed.
 *
 * The clock is the server's, read at render. That is exactly as current as
 * everything else on the page: an append re-renders the route (`live.tsx`), and
 * a run appends steadily enough that this moves on its own.
 */
export function Rail({
  progress,
  live,
}: {
  progress: RunProgress;
  /**
   * Whether the run is in flight — the lane's word, as it is for the elapsed
   * pill above, and never the rail's. A fold cannot answer it: a pass stopped
   * by the merge lane's refusal has a run stream that simply ends, which is
   * indistinguishable here from one a second between two points.
   */
  live: boolean;
}) {
  const now = progress.now;
  // The point half of `proposed:build`, which is what the label highlights.
  // Null where the phase names no point — the agent, and a bought round.
  const at = now === null ? null : pointOf(now.label);
  // Only when nothing is in flight, **and** only off the running lane — the
  // sentence's own title says a person is being waited on, and that is a fact
  // about the lane rather than about the stream. A refusal from an earlier
  // round sits under a live gate on the same card, and between a refusal and
  // the round bought to answer it there is a moment with neither; both are a
  // pass still working, and neither is anybody's to act on.
  const refused = now === null && !live ? refusedAt(progress.points) : null;

  return (
    <div className="seq">
      <Segs points={progress.points} at={at} labels />
      {now ? (
        <p
          className="snow"
          title={
            now.budgetMs === null
              ? `${now.label} since ${now.since}; nothing puts a clock on it`
              : `${now.label} since ${now.since}, out of ${inWords(now.budgetMs)}`
          }
        >
          {/* The denominator is what separates *slow* from *about to be
              killed*, and it is absent rather than invented where nothing
              bounds the phase — an approval waits on a person, and a person has
              no timeout. */}
          {at === null ? now.label : now.label.slice(at.length + 1)}{" "}
          {elapsed(Date.now() - Date.parse(now.since))}
          {now.budgetMs === null ? "" : ` / ${inWords(now.budgetMs)}`}
        </p>
      ) : refused ? (
        /* The action and what came of it, the same shape as the line above —
           and never the neutral one, whose title says the agent has just
           finished and nothing has started. On a card in the Waiting lane that
           is the opposite of true: the rail's own segment is red, a person is
           being asked, and a sentence saying *between points* under a red
           segment contradicts the bar it is there to explain. */
        <p
          className="snow"
          title="the pipeline stops at the first refusal and waits for a person, so nothing is running (0041 §4)"
        >
          {refused} refused
        </p>
      ) : live ? (
        <p className="snow quiet" title="the agent has finished and no point has started yet">
          between points
        </p>
      ) : (
        /* The fourth reading, and the one the run's own stream cannot name.
           Nothing is in flight and nothing on this stream refused, and the pass
           is stopped anyway — so what stopped it happened somewhere this fold
           does not read. `IntegrationRefused` is the ordinary one: it goes to
           the merge lane's stream, `task_view` turns it into the note below,
           and the rail above it is five passed points. Saying *between points*
           here told an operator the agent had just finished and something was
           coming, about a card that had been still for hours. */
        <p
          className="snow quiet"
          title="nothing on this run's stream is running and nothing on it refused — what the pass is stopped on is not on it, and the note says what"
        >
          nothing running
        </p>
      )}
    </div>
  );
}
