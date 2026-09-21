/**
 * The left half of the bar: which repositories there are, and how to add one.
 *
 * **the-bar.md's rule governs `.rail`, and this is not on it.** *A chip is not
 * free, and the row is the unit* was written about the four objects right of
 * the second separator — the reading, the health dot, paused/draining, and the
 * headline — and it is stated in `page.tsx` at the end of `.bar`, where the
 * next chip would be added. What is here is the filter, which is a list of
 * projects and has been since #81. An action at the end of a list of things is
 * that list gaining the affordance a list of things has; it is not a fifth
 * object competing for the row, and nothing below may be cited to put one
 * there (#216).
 *
 * **Onboarding does not stop being a thing you do once you have onboarded
 * once.** #169 put the setup link in the slot and it was right, but only for
 * the board that has no projects: with one project the slot became a caption
 * and with two a filter, and in neither was there a route to the next
 * repository. The only ways left were `lingtai add <owner>/<repo>` and typing
 * `/setup/repository` from memory, on the page that exists to be the
 * operator's console. So the `+` is drawn in the two states that had nothing,
 * and the empty board keeps the sentence it already had — it is the same
 * object as the `+`, not a second one beside it.
 *
 * **Where it lands is whether the App exists, and not whether anything is
 * registered.** `filters.length === 0` was the proxy for that and they come
 * apart in both directions: a board with an App and no repository yet wants
 * the picker, and a board with neither wants step 0. `page.tsx` reads
 * `hasGitHubApp()` and hands the answer down, so this stays a fold over its
 * arguments and all three states are assertable without an `.env.local`.
 */
import Link from "next/link";

/**
 * The slot, in its three states.
 *
 * Exported and pure for #101's reason: what this claims — *every state can
 * reach the wizard*, *the target follows the App* — are claims about markup,
 * and a fold alone cannot catch a state that renders without the link.
 */
export function Projects({
  filters,
  only,
  app,
}: {
  filters: string[];
  only: string | undefined;
  app: boolean;
}) {
  // Step 0 is create the App, install it, add a repository; once the App
  // answers, the picker is the rest of it and the first step is done.
  const where = app ? "/setup/repository" : "/setup/github-app";
  const why = app ? "add a repository" : "create the GitHub App, then install it";

  // Nothing configured is the one board with somewhere to go, and it is the
  // same object rather than a fifth one: the slot already says *there is
  // nothing here yet*, so the sentence is the link (#169).
  if (filters.length === 0) {
    return (
      <Link className="tab" href={where} title={why}>
        no project configured
      </Link>
    );
  }

  // A filter, not a caption. With one project there is nothing to choose
  // between, so it stays the sentence it was — but the list is a list either
  // way, and the `+` belongs to the list and not to the number of tabs in it.
  return (
    <span className="filter">
      {filters.length === 1 ? (
        <span>{filters[0]}</span>
      ) : (
        <>
          <Link className={`tab${only === undefined ? " on" : ""}`} href="/">
            all
          </Link>
          {filters.map((p) => (
            <Link
              key={p}
              className={`tab${only === p ? " on" : ""}`}
              href={`/?project=${encodeURIComponent(p)}`}
            >
              {p}
            </Link>
          ))}
        </>
      )}
      {/* A `.tab`, because it is one of this list's controls. Not `.reading`,
          which is styled as text precisely so that the rail's one link does
          not read as a button — this is the opposite case. */}
      <Link className="tab add" href={where} title={why} aria-label="add a repository">
        +
      </Link>
    </span>
  );
}
