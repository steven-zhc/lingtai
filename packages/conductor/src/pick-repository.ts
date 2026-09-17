/**
 * Step 0 of onboarding: which repository (#168).
 *
 * [The design](../../../doc/design/the-onboarding-wizard.md) opens at *step one
 * reads the base branch*, by which point a slug is already in hand, and
 * `lingtai add` makes installation a precondition rather than a step. This is
 * the step before both: **the installation is the entry point, not the link.**
 *
 * ```
 * 1. no installation  → a link to https://github.com/apps/<slug>/installations/new?state=…
 * 2. GitHub returns   → setup URL ?installation_id=…&setup_action=install|update|request
 * 3. what the App can see: GET /app/installations, then GET /installation/repositories
 * 4. a person picks from the list, or pastes a link that is checked against it
 * ```
 *
 * **Nothing is written.** Every call here goes through `AppReader`, whose only
 * method is `GET`, and nothing touches the event store: the registered
 * projects are handed in, already folded, so that they can be *shown* as
 * registered rather than offered twice. Abandon this screen and there is
 * nothing to clean up, which is #160's rule.
 *
 * **Progress is read back from GitHub, never carried in the round trip.**
 * `state` survives only on `/installations/new`, and it does not survive an
 * organisation owner's approval — a member requests, an owner approves minutes
 * or days later, and that return has no `state`. So nothing here depends on it:
 * the screen after any return, with or without `state`, is `listRepositories`,
 * which asks the App what it can see now.
 */
import { randomBytes } from "node:crypto";
import { type ProjectState } from "@lingtai/domain";
import {
  type AppReader,
  GitHubError,
  type Installation,
  type PermissionGap,
  type VisibleRepository,
  appInstallations,
  installationRepositories,
  parseSlug,
  permissionGaps,
} from "@lingtai/github";

/** One repository on the list, and whether the log already has it. */
export interface ListedRepository extends VisibleRepository {
  slug: string;
  /**
   * `registered` has a recipe, `pending` is recorded and waiting for `Recheck` on
   * the board's pending card (#163, #182) — its recipe is already on this machine,
   * and nothing is written to the repository, so there is no pull request —
   * null is offered. A repository that is either of the first two is shown and
   * never offered — a second onboarding of it is a second stream's worth of
   * confusion about one repository.
   *
   * `unrecorded` is a project of this name registered before owners were, when
   * the App cannot vouch that this is the only account with that name — it can
   * see the name under more than one, or an installation would not answer: the
   * log cannot say which it is, so none is called onboarded, and none is offered
   * — a project is keyed by the name, so onboarding either writes to that one
   * stream.
   *
   * `taken` is a project of this name recorded under another owner, named in
   * `takenBy`. It is not this repository, and it is not offered either: `add`
   * would write this repository onto that project's stream.
   */
  onboarded: "registered" | "pending" | "unrecorded" | "taken" | null;
  /** The owner of the project that already has this name, when `onboarded` is `taken`. */
  takenBy?: string;
}

export interface ListedInstallation {
  installation: Installation;
  /**
   * Why GitHub would not list this installation's repositories — a suspended
   * installation refuses its token — or null. One installation that will not
   * answer is a sentence under its own account, never the whole picker.
   */
  unanswered: string | null;
  /** `permissionGaps`, named one by one — a gap here is a 403 in the middle of a merge. */
  gaps: PermissionGap[];
  repositories: ListedRepository[];
}

export interface Picker {
  /** Empty is the first-class *not installed yet* screen, not an error. */
  installations: ListedInstallation[];
  /** Where to install the App, with a `state` on it — null when the App's slug is not known. */
  installUrl: string | null;
}

/**
 * The install link, with an opaque `state`.
 *
 * `/installations/new` is the only App URL that carries `state` through; the
 * App's bare page drops it. It is sent and never required: the return is
 * resumable without it (see the module comment), so a `state` is a courtesy to
 * whoever reads the setup URL's query and not a check anything depends on.
 */
export function installLink(installUrl: string | null, state = randomBytes(16).toString("base64url")): string | null {
  if (installUrl === null) return null;
  const url = new URL(installUrl);
  url.searchParams.set("state", state);
  return url.toString();
}

const same = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase();

function onboardedAs(
  projects: readonly ProjectState[],
  repo: VisibleRepository,
  owners: ReadonlySet<string>,
  everyAnswered: boolean,
): Pick<ListedRepository, "onboarded" | "takenBy"> {
  // A project is keyed by the repository's name, whoever owns it — so the
  // match is on the name, and the owner only decides whether it is this one.
  const found = projects.find((p) => same(p.project, repo.repo));
  if (found === undefined) return { onboarded: null };
  if (found.owner !== null && !same(found.owner, repo.owner)) return { onboarded: "taken", takenBy: found.owner };
  // `owner` is null on one registered before it was recorded, and then it only
  // says which repository it is when every installation answered and one
  // account has that name.
  if (found.owner === null && (owners.size > 1 || !everyAnswered)) return { onboarded: "unrecorded" };
  return { onboarded: found.configHash !== null ? "registered" : "pending" };
}

/** Every repository the App can see, installation by installation. */
export async function listRepositories(options: {
  reader: AppReader;
  /** Every project stream folded — registered and pending alike (`loadAllProjects`). */
  projects: readonly ProjectState[];
  /** `offerCreation().installUrl` — the App's own install page, or null. */
  installUrl: string | null;
}): Promise<Picker> {
  const installations = await appInstallations(options.reader);
  const fetched = await Promise.all(
    installations.map(async (installation) => {
      try {
        return { installation, repositories: await installationRepositories(options.reader, installation.id), unanswered: null };
      } catch (err) {
        return { installation, repositories: [], unanswered: (err as Error).message };
      }
    }),
  );
  // Which accounts the App can see each repository name under.
  const owners = new Map<string, Set<string>>();
  for (const { repositories } of fetched) {
    for (const r of repositories) {
      const name = r.repo.toLowerCase();
      owners.set(name, (owners.get(name) ?? new Set()).add(r.owner.toLowerCase()));
    }
  }
  const everyAnswered = fetched.every((f) => f.unanswered === null);
  const listed = fetched.map(({ installation, repositories, unanswered }) => ({
    installation,
    unanswered,
    gaps: permissionGaps(installation),
    repositories: repositories.map((r) => ({
      ...r,
      slug: `${r.owner}/${r.repo}`,
      ...onboardedAs(options.projects, r, owners.get(r.repo.toLowerCase())!, everyAnswered),
    })),
  }));
  return { installations: listed, installUrl: installLink(options.installUrl) };
}

/** A link that fixes the thing, and what to call it. */
export interface Fix {
  href: string;
  label: string;
}

export type Choice =
  | { ok: true; owner: string; repo: string; slug: string; installation: Installation }
  | {
      ok: false;
      /** One sentence: why this repository cannot be taken from here. */
      why: string;
      /** The page that fixes it, when there is one. */
      fix: Fix | null;
      /** Missing scopes, one by one, when that is the reason. */
      gaps: PermissionGap[];
    };

/**
 * A repository, named by a click or by a pasted link, checked against the list.
 *
 * **The list decides, not the input.** A pasted slug is `parseSlug`'s — every
 * shape a clipboard has — and then it has to be something the App can see. A
 * repository that is not says why, and links to the page that fixes it:
 * `installation.htmlUrl` when the App is installed on that owner and not on
 * that repository, the install link when it is not installed there at all.
 * That is the deep link Vercel's knowledge-base page for *unable to find your
 * GitHub repository* does not give.
 */
export function choose(picker: Picker, input: string): Choice {
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = parseSlug(input));
  } catch (err) {
    return { ok: false, why: (err as Error).message, fix: null, gaps: [] };
  }
  const slug = `${owner}/${repo}`;

  for (const listed of picker.installations) {
    const found = listed.repositories.find((r) => same(r.owner, owner) && same(r.repo, repo));
    if (found === undefined) continue;
    if (found.onboarded !== null) {
      return {
        ok: false,
        why:
          found.onboarded === "registered"
            ? `${found.slug} is already onboarded.`
            : found.onboarded === "pending"
              ? `${found.slug} is already on its way in — its recipe is on this machine, and it is waiting for Recheck on the board's pending card to register it.`
              : found.onboarded === "taken"
                ? taken(found)
                : unrecorded(found),
        fix: null,
        gaps: [],
      };
    }
    if (listed.gaps.length > 0) {
      return {
        ok: false,
        why: `The App can see ${found.slug}, but its installation on ${listed.installation.account} is missing permissions.`,
        fix: settings(listed.installation, "Grant them on the installation's page"),
        gaps: listed.gaps,
      };
    }
    return { ok: true, owner: found.owner, repo: found.repo, slug: found.slug, installation: listed.installation };
  }

  const onOwner = picker.installations.find((l) => same(l.installation.account, owner));
  if (onOwner === undefined) {
    return {
      ok: false,
      why: `The App is not installed on ${owner}, so it cannot see ${slug}.`,
      fix: picker.installUrl === null ? null : { href: picker.installUrl, label: `Install it on ${owner}` },
      gaps: [],
    };
  }
  if (onOwner.unanswered !== null) {
    return {
      ok: false,
      why: `GitHub would not say what the App can see on ${onOwner.installation.account} — ${onOwner.unanswered}.`,
      fix: settings(onOwner.installation, `Check the installation on ${onOwner.installation.account}`),
      gaps: [],
    };
  }
  return {
    ok: false,
    why:
      onOwner.installation.repositorySelection === "selected"
        ? `The App is installed on ${onOwner.installation.account} for selected repositories, and ${slug} is not one of them.`
        : `The App can see every repository on ${onOwner.installation.account}, and ${slug} is not among them — ` +
          "check the name, or whether it has moved.",
    fix: settings(onOwner.installation, `Add ${repo} on the installation's page`),
    gaps: onOwner.gaps,
  };
}

/** What a name registered before owners were can and cannot say, and how to settle it. */
export function unrecorded(repo: { repo: string }): string {
  return (
    `A project called ${repo.repo} was registered before owners were recorded, and the App cannot see ${repo.repo} ` +
    `under exactly one account with every installation answering, so Lingtai cannot tell which it is. ` +
    `Run pnpm lingtai add <owner>/${repo.repo} for the one it is, and that owner is recorded.`
  );
}

/** Why a repository whose name another owner's project already has is not offered. */
export function taken(repo: { slug: string; repo: string; takenBy?: string }): string {
  return (
    `A project called ${repo.repo} is already ${repo.takenBy}/${repo.repo}, and a project is keyed by its name, ` +
    `so onboarding ${repo.slug} would write onto that project's stream.`
  );
}

function settings(installation: Installation, label: string): Fix | null {
  return installation.htmlUrl === null ? null : { href: installation.htmlUrl, label };
}

/**
 * The installation a setup-URL return names, **if it is this App's** — or null.
 *
 * **`installation_id` on the setup URL is not trusted.** GitHub's own
 * documentation: *"Bad actors can hit this URL with a spoofed
 * `installation_id`"*. Its remedy is a user access token proving the
 * installation belongs to the person, and Lingtai has none — no user OAuth,
 * which [0045](../../../doc/decisions/0045-one-team-one-conductor.md) names as
 * a separate epic. So it is checked against what the App itself reports:
 * `GET /app/installations/{id}` with the App's JWT answers 404 for any id that
 * is not one of this App's installations. Under one team and one conductor,
 * *an installation of our App* is the whole claim worth checking; and the id
 * is never acted on even then — it only says which installation to name first
 * on a screen that lists every one of them anyway.
 */
export async function verifiedInstallation(reader: AppReader, raw: string | null): Promise<number | null> {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  try {
    const installation = await reader.request<{ id: number }>("GET", `/app/installations/${raw}`, "app");
    return installation.id;
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Where a return from GitHub's install screen goes: always the picker.
 *
 * **Everything in the query is optional**, `state` included — an
 * owner-approved install arrives with none. What the query can add is a
 * sentence: `installed` names a verified installation, and `requested` says an
 * organisation owner has been asked, which GitHub reports as
 * `setup_action=request` with no installation to name.
 */
export async function setupReturn(reader: AppReader, query: URLSearchParams): Promise<string> {
  const target = new URLSearchParams();
  if (query.get("setup_action") === "request") {
    target.set("requested", "1");
  } else {
    let id: number | null = null;
    try {
      id = await verifiedInstallation(reader, query.get("installation_id"));
    } catch {
      // GitHub would not answer. The picker asks it again and says so there;
      // a hint is not worth failing the return for.
    }
    if (id !== null) target.set("installed", String(id));
  }
  const q = target.toString();
  return `/setup/repository${q === "" ? "" : `?${q}`}`;
}
