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
 * **It ends on the install link and names no restart.** `hasGitHubApp()` and
 * `githubApp()` read `.env.local` as it is on disk, per call, so the App is
 * usable the moment it is written — by this board's next Approve and by a daemon
 * that was already running. An ending that said *now run `lingtai restart`*
 * would name a command that restarts the daemon and not this board, beside a
 * claim that it fixes both: #167's defect, one surface along.
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
 * and never bytes*, *no screen names a restart* — are claims about the markup,
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
              {offer.offered
                ? "step 0 — Lingtai talks to GitHub as an App, not as a token"
                : offer.configured !== null
                  ? "already configured"
                  : offer.minted !== null
                    ? "created here, and not finished"
                    : "the log did not answer"}
            </span>
          </h2>

          {outcome === null ? null : outcome.ok ? <Created outcome={outcome} /> : <Refused refusal={outcome.refusal} />}

          {/* Four answers and four sentences, in the order they are true. The
              two in the middle are the ones that used to be one: *the
              credentials are here* and *an App of ours is on GitHub* coincide
              only on the path where nothing failed, and it is the other paths a
              screen is read on. */}
          {offer.offered ? (
            <Create offer={offer} />
          ) : outcome?.ok ? null : offer.configured !== null ? (
            <Configured configured={offer.configured} installUrl={offer.installUrl} />
          ) : offer.minted !== null ? (
            <Unfinished minted={offer.minted} keyPath={offer.keyPath} />
          ) : (
            <Unanswered why={offer.unanswered ?? ""} />
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
          <code>issues</code> — the one event it subscribes to, since a <code>push</code> delivery is one the receiver drops
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

/** The ending: the App is usable now, and installing it is the next step. */
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
      {/* No restart here. The App ID and the key path are read from the env
          file on every call, so this board and a running daemon both have the
          App from the moment it was written. */}
      <p className="note">
        This board and a daemon that is already running use it from now on — the env file is read
        on every call, so nothing has to be restarted.
      </p>
      <p className="note">
        Next, install it — <a href={`https://github.com/apps/${outcome.slug}/installations/new`}>
          github.com/apps/{outcome.slug}
        </a>{" "}
        — and pick the repositories it may see. Creating is not installing.
      </p>
    </>
  );
}

/**
 * Already configured: the install link, and no offer to mint a second one.
 *
 * `where` only says which source named it: both are read on every call, so
 * either way the App is usable by this board and the daemon as it stands.
 */
function Configured({
  configured,
  installUrl,
}: {
  configured: { appId: string; slug: string | null; where: "environment" | "file"; file: string | null };
  installUrl: string | null;
}) {
  return (
    <>
      <p className="note">
        {configured.where === "environment"
          ? `This Lingtai is configured with app ${configured.appId}.`
          : `This Lingtai is configured with app ${configured.appId}, in ${configured.file}.`}{" "}
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

/**
 * An App was minted here and its credentials never landed.
 *
 * **This is the screen that used to say "configured".** `GitHubAppCreated` is
 * appended the moment GitHub returns the conversion — before the key file and
 * before the env file, so that a write which fails still leaves a record of the
 * App it failed for. Read as a configuration, that record turned the one
 * outcome it exists to describe into *created here* — a claim with no key on
 * this machine behind it.
 *
 * So it says what is true: the App is on GitHub, its private key was handed
 * over once during an exchange that did not finish, and the way out is a new
 * key on the App's own page rather than a second App.
 */
function Unfinished({ minted, keyPath }: { minted: { appId: string; slug: string }; keyPath: string }) {
  return (
    <>
      <p className="refusal">
        App {minted.appId} ({minted.slug}) was created here, and this Lingtai is not configured with
        it — the credentials did not reach this machine, so <code>{keyPath}</code> and the env file
        do not name it. Creation is not offered again: the App exists, and a second one would be one
        nothing is installed on.
      </p>
      <p className="note">
        GitHub hands a private key over exactly once, so that one cannot be fetched again. Generate a
        new key on the App&rsquo;s own page — <a href={`https://github.com/settings/apps/${minted.slug}`}>
          Settings → Developer settings → GitHub Apps → General → Private keys
        </a>{" "}
        — and finish it by hand from step 2 of <code>doc/operating.md</code>. Deleting the App there
        and starting again is the other way.
      </p>
    </>
  );
}

/**
 * The log would not answer, so the page does not guess — and does not draw the
 * button.
 *
 * `GitHubAppCreated` is the only durable record that an App was minted here, and
 * the creations it is the *only* record of are the ones whose writes failed:
 * there is no key file and no env line for those, so nothing else on this
 * machine remembers them. A store unreachable for a few minutes must therefore
 * read as *unknown* and never as *nothing* — the button on an unanswered
 * question mints a second App while the first is still unfinished, and GitHub
 * hands a private key over exactly once.
 */
function Unanswered({ why }: { why: string }) {
  return (
    <>
      <p className="refusal">
        Lingtai cannot tell whether an App was already created here: the log could not be read
        {why === "" ? "" : ` — ${why}`}. Creation is not offered on an unanswered question, because a
        second App would be minted over the one this installation may already be using, and GitHub
        hands a private key over exactly once.
      </p>
      <p className="note">
        Run <code>pnpm lingtai doctor</code>, and reload this page once the log answers.
      </p>
    </>
  );
}

function Refused({ refusal }: { refusal: string }) {
  return <p className="refusal">{refusal}</p>;
}
