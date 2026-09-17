"use client";

/**
 * A repository that is on its way in, and the button that finishes it (#163).
 *
 * The wizard ends by writing the recipe on this machine,
 * `~/.lingtai/<project>/recipe.yml` (0046 §3, #180) — nothing is written to the
 * repository and there is nothing to merge. What it can still be waiting for is
 * **the GitHub App, installed on that repository** (#182, #168): until `Recheck`
 * finds it and registers the project, the repository is **recorded and not
 * conducted** — `ProjectOnboardingStarted` is on its stream, `loadProjects()`
 * does not return it, and nothing in the system will touch it. That is a real
 * state, it ends when somebody installs the App, and it had nowhere to be seen.
 *
 * **Above the columns, and not a card in one.** The four columns are work, and
 * this is a repository with none — a fifth kind of card among them would make
 * the board's claim that every card is a real ticket false, the same argument
 * `QueueProblem` is not a card.
 *
 * **Recheck, and nothing watching.** The daemon does not know repositories it
 * has not onboarded, so nothing finishes this automatically. Pressing it asks
 * GitHub whether the App is installed there: not yet, and it says so and
 * changes nothing, so it can be pressed again once it is; installed, it reads
 * the recipe from this machine and the project is live.
 *
 * It does not ask "sure?" the way Resume does. Resume moves the whole
 * installation; this asks one question and either registers a repository the
 * operator already asked for or reports that the App is not there yet.
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
        <span className="chip held" title="recorded, and not conducted — waiting for the GitHub App to be installed on it">
          pending
        </span>
      </span>
      {/* What it is waiting for, and what `Recheck` reads once that is true,
          said before it is pressed. A button whose target is invisible is one
          nobody can tell has been pointed at the wrong place. */}
      <p className="note">
        waits for the GitHub App to be installed on this repository, then reads{" "}
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
