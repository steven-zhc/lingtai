import Link from "next/link";
import type { TreeGroup } from "@/lib/docs";

/**
 * Every published page, beside the page — so that going from `agent:` to `run:`
 * is one click and not *back to the parent, then down again*.
 *
 * The group holding the current page is open and the others are collapsed: the
 * tree is for finding a neighbour, and on a site that may one day publish 75
 * decisions an open tree would be the page's longest scroll. `<details>` rather
 * than script, so it works in a static export with nothing loaded.
 */
export function DocTree({ groups, current }: { groups: TreeGroup[]; current: string }) {
  return (
    <nav className="doctree" aria-label="Documentation">
      {groups.map((group) => {
        const holdsCurrent = group.entries.some((entry) => entry.slug === current);
        return (
          <details key={group.id} open={holdsCurrent || groups.length === 1}>
            <summary>{group.label}</summary>
            <ul>
              {group.entries.map((entry) => (
                <li key={entry.slug}>
                  <Link
                    href={`/docs/${entry.slug}/`}
                    aria-current={entry.slug === current ? "page" : undefined}
                  >
                    {entry.title}
                  </Link>
                </li>
              ))}
            </ul>
          </details>
        );
      })}
    </nav>
  );
}
