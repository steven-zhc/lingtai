"use client";

/**
 * A repository that is on its way in, and the button that finishes it (#163).
 *
 * The wizard ends by writing the recipe on this machine,
 * `~/.lingtai/<project>/recipe.yml` (0046 §3, #180) — nothing is written to the
 * repository and there is nothing to merge. Until `Recheck` registers it the
 * repository is **recorded and not conducted** — `ProjectOnboardingStarted` is
 * on its stream, `loadProjects()` does not return it, and nothing in the system
 * will touch it. That is a real state and it had nowhere to be seen.
 *
 * **The card names what `Recheck` checks, and never a cause** (#182). The
 * wizard only records a repository the App is already installed on, so a card
 * that said *waiting for the App* would blame the one thing known to be there.
 * What can still refuse is `lingtai add`'s: the installation (it can have been
 * removed since), its permissions, the machine's recipe. Which it was is the
 * server's sentence after the press, not a guess printed before it.
 *
 * **Above the columns, and not a card in one.** The four columns are work, and
 * this is a repository with none — a fifth kind of card among them would make
 * the board's claim that every card is a real ticket false, the same argument
 * `QueueProblem` is not a card.
 *
 * **Recheck, and nothing watching.** The daemon does not know repositories it
 * has not onboarded, so nothing finishes this automatically. Pressing it asks
 * GitHub for the App's installation and its permissions and reads the recipe
 * from this machine: all there, and the project is live; anything refused, and
 * it says which and changes nothing, so it can be pressed again once fixed.
 *
 * It does not ask "sure?" the way Resume does. Resume moves the whole
 * installation; this either registers a repository the operator already asked
 * for or reports why it will not, having written nothing.
 */
import { useState, useTransition } from "react";
import { recheckProject } from "./actions.ts";
import type { PendingProject } from "@/lib/board";

export function Pending({ projects }: { projects: PendingProject[] }) {
  if (projects.length === 0) return null;
  return (
    <section className="pending">
      <header className="col-h">
        <span>On their way in</span>
        <span className="ct">{projects.length}</span>
      </header>
      <div className="cards">
        {projects.map((p) => (
          <PendingCard key={p.project} project={p} />
        ))}
      </div>
    </section>
  );
}

function PendingCard({ project }: { project: PendingProject }) {
  const [refusal, setRefusal] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  return (
    <article className="card">
      {/* The repository, on the line a card's ticket reference is on. The
          owner is part of the name here and not on a work card, because this
          card is *about* the repository and the slug is what identifies it. */}
      <span className="id">
        <span className="proj">{project.owner ? `${project.owner}/` : ""}</span>
        {project.project}
      </span>
      {/* Held, not failed. Nothing is broken: the project has been asked for
          and not yet registered, which is the ordinary shape of this state. */}
      <span>
        <span className="chip held" title="recorded, and not conducted — Recheck has not registered it yet">
          pending
        </span>
      </span>
      {/* What `Recheck` checks, said before it is pressed — and not a cause,
          which only the press can name. A button whose target is invisible is
          one nobody can tell has been pointed at the wrong place. */}
      <p className="note">
        checks the GitHub App&apos;s installation and permissions on this repository, and reads{" "}
        <code>~/.lingtai/{project.project}/recipe.yml</code> on this machine, for{" "}
        <strong>{project.base ?? "its base branch"}</strong>
      </p>
      {done ? (
        <p className="decided">{done}</p>
      ) : (
        <div className="btnrow">
          <button
            className="btn"
            disabled={busy}
            onClick={() => {
              setRefusal(null);
              startTransition(async () => {
                const result = await recheckProject({ project: project.project });
                // The server's own sentence either way. "the App is not
                // installed there" and "the installation is missing a scope"
                // send an operator to two different places, and only the
                // server knows which it was.
                if (result.ok) setDone(result.detail);
                else setRefusal(result.detail);
              });
            }}
          >
            {busy ? "…" : "Recheck"}
          </button>
        </div>
      )}
      {refusal ? <p className="refusal">{refusal}</p> : null}
    </article>
  );
}
