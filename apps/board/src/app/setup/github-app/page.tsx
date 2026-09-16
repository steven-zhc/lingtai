/**
 * Step 0: the GitHub App, created in one click (#169).
 *
 * The wizard's first screen. Everything a person used to do by hand —
 * `doc/operating.md`'s fourteen form fields, a downloaded `.pem` and two
 * environment variables — is one button and GitHub's own naming screen, because
 * GitHub's **App Manifest flow** hands the credentials back over the wire.
 *
 * **The permissions are not a question on this page**, and that is the whole
 * point of doing it this way. 0006 exists because of a day lost to a
 * fine-grained PAT that covered a submodule and not the repository, with
 * nothing anywhere saying so; the manifest carries 0006's table, so the person
 * never chooses permissions and cannot choose them wrong. They are *shown*
 * here, because a page that asks for an App without saying what it may do is a
 * page nobody should press.
 *
 * **It is a form and not a link.** Step 1 posts a manifest to GitHub, so there
 * is no URL a person can be sent to; `start/route.ts` is what serves the
 * self-submitting form, and `created/route.ts` is where GitHub comes back.
 *
 * **It ends on a restart.** The key hot-reloads and the App ID does not, so the
 * process that has just written one is still running without it — see
 * `create-app.ts`, and [0042](../../../../../../doc/decisions/0042-restart-is-a-command.md).
 */
import Link from "next/link";
import { type Offer, offerCreation } from "@lingtai/conductor/create-app";

export const dynamic = "force-dynamic";

export default async function GitHubApp() {
  return <GitHubAppScreen offer={await offerCreation()} />;
}

/**
 * The screen itself, given the answer rather than fetching it.
 *
 * Exported and separate for the reason `TaskBody` is: what this page claims —
 * *an App already configured is never offered a second one*, *the key is a path
 * and never bytes*, *the ending names a restart* — are claims about the markup,
 * and #101 is the ticket that settled that a fold alone cannot catch one.
 */
export function GitHubAppScreen({ offer }: { offer: Offer }) {
  const outcome = offer.outcome;

  return (
    <main className="detail">
      <div className="bar">
        <Link className="brand" href="/">
          ← Lingtai
        </Link>
        <span className="sep" />
        <span className="mono">github app</span>
      </div>

      <div className="detail-body">
        <section>
          <h2>
            <span className="hlab">GitHub App</span>
            <span className="hfact">
              {offer.offered ? "step 0 — Lingtai talks to GitHub as an App, not as a token" : "already configured"}
            </span>
          </h2>

          {outcome === null ? null : outcome.ok ? <Created outcome={outcome} /> : <Refused refusal={outcome.refusal} />}

          {offer.offered ? (
            <Create offer={offer} />
          ) : outcome?.ok ? null : (
            <Configured configured={offer.configured!} installUrl={offer.installUrl} />
          )}
        </section>
      </div>
    </main>
  );
}

/**
 * What the App may do, from the one list the installation is later checked
 * against — so what is asked for and what is verified cannot disagree.
 */
function Permissions({ permissions }: { permissions: { name: string; level: string; why: string }[] }) {
  return (
    <>
      <p className="note">
        Lingtai fills these in. You never choose them, so they cannot be chosen wrong — which is the
        failure ADR 0006 was written about.
      </p>
      <ul className="meta">
        {permissions.map((p) => (
          <li key={p.name}>
            <code>{p.name}</code>: {p.level} — {p.why}
          </li>
        ))}
        <li>
          <code>issues</code>, <code>push</code> — the events it subscribes to
        </li>
      </ul>
    </>
  );
}

/**
 * The button, and the two things beside it that are genuinely choices.
 *
 * A plain form posting to this app's own route: the next hop is a POST to
 * GitHub, and a server action cannot hand a browser one.
 */
function Create({ offer }: { offer: Offer }) {
  const waiting = offer.outstanding;
  return (
    <>
      {waiting === null ? null : (
        <p className={waiting.state === "waiting" ? "note" : "refusal"}>
          {waiting.state === "waiting"
            ? `A form for ${waiting.name} was posted at ${waiting.startedAt.toISOString()} and has not come back. ` +
              "Finish it on GitHub's screen, or post another one below — GitHub honours the first for an hour."
            : `The form for ${waiting.name} posted at ${waiting.startedAt.toISOString()} never came back, so nothing ` +
              "was created here. A name already taken on GitHub is the usual cause, and GitHub says so on its own " +
              "page where Lingtai cannot see it. Try another name."}
        </p>
      )}

      <Permissions permissions={offer.permissions} />

      <p className="note">
        The private key will be written to <code>{offer.keyPath}</code>, mode <code>0600</code>, and
        never shown here or written to the log.
      </p>

      <form className="setup" method="POST" action="/setup/github-app/start">
        <label>
          <span>App name</span>
          <input name="name" defaultValue={offer.suggestedName} required />
          <small>Unique across the whole of GitHub. You can change it on GitHub&rsquo;s screen.</small>
        </label>
        <label>
          <span>Organisation</span>
          <input name="org" placeholder="blank for your own account" />
          <small>
            An organisation App is created on that organisation&rsquo;s page, and GitHub refuses there
            if you are not an owner.
          </small>
        </label>
        <label>
          <span>Webhook URL</span>
          <input name="webhook" placeholder="blank — webhooks stay inactive" />
          <small>
            Blank declares the hook <strong>inactive</strong>, and nothing degrades: discovery runs on
            the daemon&rsquo;s sweep until this board has an address GitHub can reach. A{" "}
            <code>localhost</code> URL would be an App whose deliveries fail silently from the first
            minute, so it is not offered.
          </small>
        </label>
        <div className="btnrow">
          <button className="btn pri" type="submit">
            Create the App on GitHub
          </button>
        </div>
      </form>

      <p className="note">
        The next screen is GitHub&rsquo;s. A person has to press <strong>Create GitHub App</strong>{" "}
        there — that is by design, and there is no unattended path.
      </p>
    </>
  );
}

/** The ending, and it names a restart rather than claiming the daemon is ready. */
function Created({
  outcome,
}: {
  outcome: Extract<Offer["outcome"], { ok: true }>;
}) {
  return (
    <>
      <p className="decided">
        Created — {outcome.name}, app {outcome.appId}.
      </p>
      <ul className="meta">
        <li>
          private key: <code>{outcome.keyPath}</code>, mode <code>0600</code>
        </li>
        <li>
          <code>LINGTAI_GITHUB_APP_ID</code> and the webhook secret: <code>{outcome.envFile}</code>
        </li>
        <li>
          webhooks:{" "}
          {outcome.webhookActive
            ? "active, at the address you gave"
            : "declared inactive — discovery runs on the daemon's sweep until this board has an address GitHub can reach"}
        </li>
      </ul>
      {outcome.warning === null ? null : <p className="refusal">{outcome.warning}</p>}
      {/* The honest ending. `LINGTAI_GITHUB_APP_ID` is read from `process.env`
          and fixed at start, so every process now running — this board and the
          daemon both — still has the old answer. Saying "ready" here would be
          claiming a state only one process is in. */}
      <p className="note">
        Nothing running has this App yet: the private key is re-read on every call, but the App ID
        was fixed when each process started. Run{" "}
        <code>pnpm lingtai restart &quot;picking up the new App&quot;</code> to use it.
      </p>
      <p className="note">
        Then install it — <a href={`https://github.com/apps/${outcome.slug}/installations/new`}>
          github.com/apps/{outcome.slug}
        </a>{" "}
        — and pick the repositories it may see. Creating is not installing.
      </p>
    </>
  );
}

/** Already configured: the install link, and no offer to mint a second one. */
function Configured({
  configured,
  installUrl,
}: {
  configured: { appId: string | null; slug: string | null; from: "environment" | "log" };
  installUrl: string | null;
}) {
  return (
    <>
      <p className="note">
        {configured.from === "environment"
          ? `This Lingtai is configured with app ${configured.appId ?? "(unnamed)"}.`
          : `App ${configured.appId} was created here and is on the log, though this process started before it — ` +
            `run pnpm lingtai restart "picking up the new App" to use it.`}{" "}
        Creation is not offered again: a second App would be one nothing is installed on.
      </p>
      {installUrl === null ? (
        <p className="note">
          The App was configured by hand, so Lingtai does not know its name. Install it from{" "}
          <a href="https://github.com/settings/apps">Settings → Developer settings → GitHub Apps</a>,
          then run <code>pnpm lingtai add &lt;owner&gt;/&lt;repo&gt;</code>.
        </p>
      ) : (
        <p className="note">
          Install it on a repository — <a href={installUrl}>{installUrl}</a> — then{" "}
          <code>pnpm lingtai add &lt;owner&gt;/&lt;repo&gt;</code>.
        </p>
      )}
    </>
  );
}

function Refused({ refusal }: { refusal: string }) {
  return <p className="refusal">{refusal}</p>;
}
