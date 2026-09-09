import { inWords } from "@lingtai/conductor/queue";
// The subpath, for the reason `board.ts` gives: the barrel pulls the gate
// pipeline in behind it. `describeHold` is pure and lives beside the field it
// reads, so this block, the card and `lingtai status` say the same thing about
// the same hold rather than keeping three copies of the words.
import { describeHold, type HoldLine } from "@lingtai/projector/task-view";
import type { StandingView } from "@/lib/task";
import { Decide, Requeue } from "./decide.tsx";

/**
 * Why this task is not moving, above everything else.
 *
 * **The page never stated it.** The commonest reason anybody opens this page is
 * that a card has stopped, and the state had to be inferred by reading to the
 * bottom of a 30–80 row history. On 2026-09-08 that produced a wrong reading
 * four times — #80, #87, #89, #94 — including one where the item was *not*
 * stuck at all and would have returned on its own. So `queued` and `running`
 * are stated here as loudly as `blocked` is: the absence of the word "blocked"
 * is not an answer anybody trusts at the top of a long page.
 *
 * **Two values, not a status line.** The state, and how long it has held. The
 * second is a fact of equal weight and not an annotation on the first —
 * *blocked* and *blocked for four days* are different situations and only one
 * of them is an emergency, which is #79's argument one page along and #77's
 * about the bar.
 *
 * **Two renderings, one component** (design §3). Today: the state, the age, the
 * question verbatim, the actions. Once `#83` fills `diagnosis`, its sentence
 * and its recommendation fill into the same block through `describeHold` — and
 * a block with no diagnosis renders exactly as it does today, because those
 * lines are simply absent. That degradation is #83's own requirement, not a
 * courtesy.
 *
 * **The evidence is a pointer** (design §2). One deciding line, naming the
 * attempt that holds the whole of it — with its gate output, its findings and
 * its diff — and linking to it. `diagnosis.raw` is deliberately not repeated
 * here: printing the failing gate twice, at the top and inside its attempt, is
 * how two copies of one fact come to disagree.
 *
 * **No frame.** One rule states the block's extent, and it is amber only when a
 * person is the thing being waited on, because that is the only thing amber
 * means in this palette (layout notes). Every divider inside is neutral.
 */
export function Standing({
  standing,
  project,
  issue,
}: {
  standing: StandingView;
  /** From the ticket, and null when the id is not a work item — nothing can be decided then. */
  project: string | null;
  issue: number | null;
}) {
  const held = describeHold(standing);
  const acting = project !== null && issue !== null;

  return (
    <section className={standing.onYou ? "standing onyou" : "standing"}>
      {/* The readout. Two values at one weight, and the age is `inWords` — the
          same arithmetic and the same words the card uses for the same
          question, so `4h 12m` means there as it does here. */}
      <p className="sread">
        <span className="sstate">{standing.state}</span>
        <span className="sage" title={standing.since}>
          {inWords(Date.now() - Date.parse(standing.since))}
        </span>
      </p>

      <p className="ssince">
        <span>
          {standing.who} · since {standing.since.slice(0, 10)} {standing.since.slice(11, 16)} UTC
        </span>
        {/* Which attempt produced it. `of N` because the number alone reads as
            the whole story on an item that has had three (#102). */}
        {standing.attempt !== null ? (
          <span className="sfrom" title={standing.runId ?? undefined}>
            from attempt {standing.attempt} of {standing.attempts}
            {standing.runId ? ` · ${standing.runId.slice(0, 12)}` : ""}
          </span>
        ) : null}
      </p>

      {/* The question, the diagnosis and the pointer sit under one neutral
          rule. Nothing below it is amber: the rule at the left already says a
          person is being waited on, and a second amber would dilute it. */}
      {standing.question !== null || held.length > 0 || standing.deciding !== null ? (
        <div className="sbody">
          {/* Verbatim. It is what the conductor wrote down, and a page that
              paraphrases it is a second version of the question. */}
          {standing.question !== null ? <p className="squestion">{standing.question}</p> : null}

          {/* Absent until #83 writes one, which is every block on the log
              today. The weights are the card's: what happened is ink, what was
              already done is muted, the recommendation carries the signal the
              primary button is the end of. */}
          {held.map((line) => (
            <p key={line.part} className={HELD_CLASS[line.part]}>
              {line.text}
            </p>
          ))}

          {standing.deciding !== null ? (
            <p className="sevidence">
              <span className="sgate">{standing.deciding.source}</span>
              <span className="sline">{standing.deciding.line}</span>
              {/* The whole of it is down there, marked and open. */}
              <a className="sptr" href={`#attempt-${standing.deciding.attempt}`}>
                in attempt {standing.deciding.attempt} ↓
              </a>
            </p>
          ) : null}
        </div>
      ) : null}

      {/* The move that will actually run, and only where it can run. The card's
          own reading (#84, #92): a question is open exactly when there is a sha
          it is about, and an item whose approved merge hit a conflict has none
          — Approve would refuse every click, so it gets the move it has. */}
      {acting && standing.state === "blocked" ? (
        standing.awaitingSha !== null ? (
          <Decide
            project={project}
            issue={issue}
            onSha={standing.awaitingSha}
            headSha={standing.headSha ?? ""}
            gates={standing.failed}
            recommended={standing.diagnosis?.recommendation?.action ?? null}
          />
        ) : (
          <Requeue
            project={project}
            issue={issue}
            recommended={standing.diagnosis?.recommendation?.action ?? null}
          />
        )
      ) : null}
    </section>
  );
}

/** The card's weights, said once there and read here. See `page.tsx`'s `HELD_CLASS`. */
const HELD_CLASS: Record<HoldLine["part"], string> = {
  needs: "needs",
  what: "diag",
  did: "did",
  rec: "rec",
};
