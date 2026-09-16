/**
 * Step 0, after the App exists: which repository (#168).
 *
 * **Picked from a list, not typed.** The list is what the App can see —
 * `GET /installation/repositories` for each of its installations — and a
 * repository already on the log is shown as such rather than offered again. A
 * pasted link is accepted in every shape a clipboard has, and checked against
 * the same list; one that is not on it says why and links to the page that
 * fixes it.
 *
 * **No installation is a screen, not an error**: the install link, and what
 * installing grants.
 *
 * **Nothing is written.** Choosing is a `GET` of this page with `?repo=`, and
 * every call to GitHub goes through a reader whose only method is `GET`. What
 * comes after a slug is known is not this page's — `lingtai add` today, the
 * wizard (#164) when it lands.
 */
import Link from "next/link";
import { offerCreation } from "@lingtai/conductor/create-app";
import { type Choice, type Picker, choose, listRepositories, taken, unrecorded } from "@lingtai/conductor/pick-repository";
import { loadAllProjects } from "@lingtai/conductor/projects";
import type { ProjectState } from "@lingtai/domain";
import { githubApp, hasGitHubApp } from "@lingtai/env";
import { REQUIRED_PERMISSIONS, createAppReader } from "@lingtai/github";

export const dynamic = "force-dynamic";

export type Loaded =
  | { state: "no-app" }
  | { state: "unreadable"; why: string }
  | { state: "listed"; picker: Picker; logUnanswered: string | null };

export default async function PickRepository({
  searchParams,
}: {
  searchParams: Promise<{ repo?: string; installed?: string; requested?: string }>;
}) {
  const params = await searchParams;
  const loaded = await load();
  const choice = loaded.state === "listed" && params.repo ? choose(loaded.picker, params.repo) : null;
  return (
    <RepositoryScreen
      loaded={loaded}
      input={params.repo ?? ""}
      choice={loaded.state === "listed" && loaded.logUnanswered !== null ? null : choice}
      installed={params.installed === undefined ? null : Number(params.installed)}
      requested={params.requested === "1"}
    />
  );
}

async function load(): Promise<Loaded> {
  if (!hasGitHubApp()) return { state: "no-app" };
  let projects: ProjectState[] = [];
  let logUnanswered: string | null = null;
  try {
    projects = await loadAllProjects();
  } catch (err) {
    logUnanswered = (err as Error).message;
  }
  try {
    const offer = await offerCreation();
    const picker = await listRepositories({
      reader: createAppReader(githubApp()),
      projects,
      installUrl: offer.installUrl,
    });
    return { state: "listed", picker, logUnanswered };
  } catch (err) {
    return { state: "unreadable", why: (err as Error).message };
  }
}

/**
 * The screen, given the answer rather than fetching it — exported for the
 * reason `GitHubAppScreen` is: what it claims is a claim about the markup.
 */
export function RepositoryScreen({
  loaded,
  input,
  choice,
  installed,
  requested,
}: {
  loaded: Loaded;
  input: string;
  choice: Choice | null;
  installed: number | null;
  requested: boolean;
}) {
  return (
    <main className="detail">
      <div className="bar">
        <Link className="brand" href="/">
          ← Lingtai
        </Link>
        <span className="sep" />
        <span className="mono">repository</span>
      </div>

      <div className="detail-body">
        <section>
          <h2>
            <span className="hlab">Repository</span>
            <span className="hfact">step 0 — pick one the App can see</span>
          </h2>

          {requested ? (
            <p className="note">
              The install was requested, and an organisation owner has to approve it on GitHub. Nothing
              here has to be kept open: come back to this page once they have, and it will be listed.
            </p>
          ) : null}

          {loaded.state === "no-app" ? (
            <p className="note">
              There is no GitHub App configured yet. <Link href="/setup/github-app">Create it first</Link>.
            </p>
          ) : loaded.state === "unreadable" ? (
            <p className="refusal">GitHub would not say what the App can see — {loaded.why}. Reload to ask again.</p>
          ) : loaded.picker.installations.length === 0 ? (
            <NotInstalled installUrl={loaded.picker.installUrl} logUnanswered={loaded.logUnanswered} />
          ) : (
            <Listed
              picker={loaded.picker}
              input={input}
              choice={choice}
              installed={installed}
              logUnanswered={loaded.logUnanswered}
            />
          )}
        </section>
      </div>
    </main>
  );
}

function Grants() {
  return (
    <ul className="meta">
      {REQUIRED_PERMISSIONS.map((p) => (
        <li key={p.name}>
          <code>{p.name}</code>: {p.level} — {p.why}
        </li>
      ))}
    </ul>
  );
}

/** The first-class *not installed yet* screen. */
function NotInstalled({ installUrl, logUnanswered }: { installUrl: string | null; logUnanswered: string | null }) {
  return (
    <>
      <p className="note">
        The App is not installed anywhere yet, so there is nothing to pick from. Installing it is
        GitHub&rsquo;s screen: you choose the account and which of its repositories the App may see.
        On those repositories it may do this, and nothing else:
      </p>
      <Grants />
      {installUrl === null && logUnanswered !== null ? (
        <p className="refusal">
          The log could not be read — {logUnanswered} — so Lingtai cannot tell this App&rsquo;s name, which
          creating it recorded there. Install it from{" "}
          <a href="https://github.com/settings/apps">Settings → Developer settings → GitHub Apps</a>, or
          reload this page once the log answers.
        </p>
      ) : installUrl === null ? (
        <p className="note">
          Lingtai does not know this App&rsquo;s name, because it was configured by hand. Install it from{" "}
          <a href="https://github.com/settings/apps">Settings → Developer settings → GitHub Apps</a>, then
          reload this page.
        </p>
      ) : (
        <div className="btnrow">
          <a className="btn pri" href={installUrl}>
            Install the App on GitHub
          </a>
        </div>
      )}
    </>
  );
}

function Listed({
  picker,
  input,
  choice,
  installed,
  logUnanswered,
}: {
  picker: Picker;
  input: string;
  choice: Choice | null;
  installed: number | null;
  logUnanswered: string | null;
}) {
  const justInstalled = picker.installations.find((l) => l.installation.id === installed);
  return (
    <>
      {justInstalled === undefined ? null : (
        <p className="decided">Installed on {justInstalled.installation.account}.</p>
      )}
      {logUnanswered === null ? null : (
        <p className="refusal">
          The log could not be read — {logUnanswered} — so Lingtai cannot tell which of these are already
          onboarded, and none is offered until it can.
        </p>
      )}
      {choice === null ? null : <Chosen choice={choice} />}

      {picker.installations.map(({ installation, unanswered, gaps, repositories }) => (
        <div key={installation.id}>
          <h3>
            {installation.account}{" "}
            <small>
              {installation.repositorySelection === "all" ? "every repository" : "selected repositories"}
              {installation.htmlUrl === null ? null : (
                <>
                  {" · "}
                  <a href={installation.htmlUrl}>change</a>
                </>
              )}
            </small>
          </h3>
          {unanswered === null ? null : (
            <p className="refusal">
              GitHub would not say what the App can see on {installation.account} — {unanswered}. Reload to ask
              again.
            </p>
          )}
          {gaps.length === 0 ? null : <Gaps gaps={gaps} />}
          <ul className="meta">
            {repositories.map((r) => (
              <li key={r.slug}>
                {r.onboarded === "unrecorded" ? (
                  <>
                    <code>{r.slug}</code> — {unrecorded(r)}
                  </>
                ) : r.onboarded === "taken" ? (
                  <>
                    <code>{r.slug}</code> — {taken(r)}
                  </>
                ) : r.onboarded !== null ? (
                  <>
                    <code>{r.slug}</code> — {r.onboarded === "registered" ? "already onboarded" : "onboarding, recipe pending"}
                  </>
                ) : logUnanswered !== null || gaps.length > 0 ? (
                  <code>{r.slug}</code>
                ) : (
                  <Link href={`/setup/repository?repo=${encodeURIComponent(r.slug)}`}>{r.slug}</Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}

      <form className="setup" method="GET" action="/setup/repository">
        <label>
          <span>Or paste a link</span>
          <input name="repo" defaultValue={input} placeholder="https://github.com/owner/repo" />
          <small>
            Any shape: <code>owner/repo</code>, a GitHub link, <code>.git</code>, a <code>/tree/</code> page, or{" "}
            <code>git@github.com:owner/repo.git</code>.
          </small>
        </label>
        <div className="btnrow">
          <button className="btn" type="submit">
            Look it up
          </button>
        </div>
      </form>

      {picker.installUrl === null ? null : (
        <p className="note">
          Not here? <a href={picker.installUrl}>Install the App on another account</a>.
        </p>
      )}
    </>
  );
}

function Gaps({ gaps }: { gaps: { name: string; need: string; have: string; why: string }[] }) {
  return (
    <>
      <p className="refusal">This installation is missing permissions, so nothing on it is offered:</p>
      <ul className="meta">
        {gaps.map((g) => (
          <li key={g.name}>
            <code>{g.name}</code>: have {g.have}, need {g.need} — {g.why}
          </li>
        ))}
      </ul>
    </>
  );
}

function Chosen({ choice }: { choice: Choice }) {
  if (choice.ok) {
    return (
      <>
        <p className="decided">
          Chosen — {choice.slug}, on installation {choice.installation.id}.
        </p>
        <p className="note">
          Next: <code>pnpm lingtai add {choice.slug}</code>
        </p>
      </>
    );
  }
  return (
    <>
      <p className="refusal">{choice.why}</p>
      {choice.gaps.length === 0 ? null : <Gaps gaps={choice.gaps} />}
      {choice.fix === null ? null : (
        <p className="note">
          <a href={choice.fix.href}>{choice.fix.label}</a>, then reload this page.
        </p>
      )}
    </>
  );
}
