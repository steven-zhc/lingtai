/**
 * What will happen if you press the button.
 *
 * **The only question a queued page really has.** Everything else on this page
 * is about what a run did; an item that has never run has nothing of that, and
 * the thing somebody is actually deciding is whether to spend an agent on it.
 * Every field here already existed — the gate plan `projectFilter` lifts out of
 * the recipe, and the limits beside it — and none of them was on any page
 * (#113).
 *
 * **All five points, including the ones nothing is configured at.** ADR 0016
 * §4's rule holds before a run exactly as it holds after one: a point that is
 * merely left out looks identical to a point that was configured and silently
 * did not run, and only the second is Lingtai's bug. The attempt's own ledger
 * says `skipped` for the same reason and in the same word.
 *
 * A box, because it sits beside `WILL BE SENT` and the layout notes allow the
 * decision column two of them. Neutral, like that one: the amber on this page
 * is the rule at the left and the one primary button, and a third use would
 * dilute both.
 *
 * No state, no click. It is the one thing in this column you only read — which
 * is why it is a server component and why nothing here is a control.
 */
import type { PlanView } from "@/lib/queued";

/**
 * The bounds, on the box's own footer.
 *
 * `runtime.limits` in the recipe's own words rather than in milliseconds, so
 * the line reads back against the file it came from. `rounds` is stated whether
 * it buys anything or not (0025 §2): a default that spends money and only
 * appears when it is doing something is a default nobody can audit.
 *
 * The four that bound a ticket sit together here because they do in the recipe
 * (0039 §3, [0040](../../../../doc/decisions/0040-rounds-bound-depth-restarts-bound-breadth.md) §5)
 * — what this footer says and what the file says are the same block.
 *
 * **Two cells for the two ceilings, and `straight to you` is the second one's**
 * (0040 §5). It used to be what `rounds: 0` rendered, which was true while
 * depth was the whole policy and is false beside a non-zero `restarts`: the
 * configuration 0040 calls *never patch, start over twice* buys no round and
 * three agent runs, and this footer would have promised the operator standing
 * over the button that the first refusal was theirs. Depth says how many
 * rounds a pass buys; breadth says whether a spent pass is yours.
 */
function limits(plan: PlanView): string {
  return [
    `${plan.turns} turns`,
    plan.wall,
    plan.tier,
    plan.rounds === 0 ? "no rounds" : `${plan.rounds} round(s) back`,
    plan.restarts === 0 ? "then straight to you" : `${plan.restarts} restart(s)`,
  ].join(" · ");
}

export function Plan({ plan }: { plan: PlanView | null }) {
  return (
    <div className="plan">
      <p className="planhead">
        <span className="outname">what will happen</span>
        {plan ? <span className="outfact">{limits(plan)}</span> : null}
      </p>

      {plan === null ? (
        // Never merely absent (#76). An unregistered project, a recipe that
        // will not parse and a GitHub that would not answer all look like "no
        // plan", and the reason is one line up — the block that could not ask
        // says why. What must not happen is a guessed plan: a page that
        // invented five points would be inviting somebody to press a button on
        // a description of something else.
        <p className="empty">
          The recipe could not be read, so what a run would do here is not known.
        </p>
      ) : (
        <ol className="points">
          {plan.points.map((p) => (
            <li key={p.point} className={p.skipped ? "point skipped" : "point"}>
              <span className="mono name">{p.point}</span>
              {p.skipped ? (
                <span className="pill">skipped</span>
              ) : (
                <span className="actions">{p.actions.join(", ")}</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
