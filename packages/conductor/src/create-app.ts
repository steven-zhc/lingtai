/**
 * The wizard's first screen: mint the GitHub App from a manifest (`#169`,
 * [the design](../../../doc/design/creating-the-app.md)).
 *
 * [0006](../../../doc/decisions/0006-github-app.md) priced the App in its own
 * Consequences — *an App must be created, given a private key, and installed* —
 * and this pays the first two. `@lingtai/github`'s `manifest.ts` describes the
 * App and performs the conversion; what is here is everything that happens on
 * this machine: which attempts are this process's, where the key lands, what is
 * written down, and what is never written anywhere.
 *
 * **In the board, and the board writes the key.** The design first said the
 * CLI, on the grounds that the private key is the only long-lived secret in the
 * system and an HTTP route that can write it keeps that power. That argument
 * does not survive reading `apps/board/src/app/actions.ts`: `approveCard`
 * releases a merge hold, `editPrompt` rewrites the document an agent is handed,
 * `sendAttempt` dispatches it and `runNow` starts a pass — and those four
 * compose into *merge arbitrary code into `main`*, which includes code that
 * reads a key file and sends it elsewhere. Writing the file is strictly less
 * power than the board already holds, and the browser settles the rest: step 2
 * of the flow **is** a person on GitHub's own page, so the board is two hops
 * where a terminal is five. What survives from the rejected argument is the
 * care and not the location — the `0600` habit is `apps/cli/src/env.ts`'s and
 * the path is `.env.example`'s, rather than a second home for the same file.
 *
 * **Three secrets come back and this module is the only thing that sees them.**
 * The PEM is written to a `0600` file and its *path* is reported; the webhook
 * secret goes into the env file; the OAuth pair never reaches here at all,
 * because `CreatedApp` drops it at the seam. Nothing returned from this module
 * carries a key, so nothing a page renders or a log records can.
 *
 * **It ends on "usable now", and names no restart.** `githubApp()` always
 * re-read the key file per call, but read `LINGTAI_GITHUB_APP_ID` from
 * `process.env`, fixed when the process started — so a credential minted at
 * runtime worked by half, and the board that wrote it went on answering *no
 * GitHub App configured*. `@lingtai/env` now reads the id and the key path from
 * `.env.local` on disk when the environment does not set them, so the App is
 * usable the moment the file is written, in every process, including a daemon
 * that was already running. `lingtai restart` restarts the daemon and not the
 * board, and a page naming it would promise what it does not do.
 *
 * **And the guard reads the file too.** *Is an App already configured* decides
 * whether the button is drawn and whether a returning code is applied, and its
 * answer lives in `.env.local` — the file this writes — where `process.env`
 * only holds what was in it at start. `configuration()` is
 * that question, asked of the file, of the environment and of the log, each for
 * the one thing it knows.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { ENV_FILE_MODE, parseEnvFile, setEnvLine } from "@lingtai/agent-env";
import { GITHUB_APP_STREAM, parsePayload } from "@lingtai/domain";
import { PREFIX, hasGitHubApp, optional, repoRoot, resolvePath } from "@lingtai/env";
import { type EventStore, eventStore } from "@lingtai/event-store";
import {
  type AppManifest,
  GitHubError,
  REQUIRED_PERMISSIONS,
  buildManifest,
  convertManifest,
  manifestFormAction,
} from "@lingtai/github";

export const APP_ID_VAR = `${PREFIX}GITHUB_APP_ID`;
export const KEY_PATH_VAR = `${PREFIX}GITHUB_APP_PRIVATE_KEY_PATH`;
export const WEBHOOK_SECRET_VAR = `${PREFIX}GITHUB_WEBHOOK_SECRET`;

/**
 * Where the key goes by default — `.env.example`'s own line, not a new place.
 *
 * Outside the repository, which is the half of 0006's last consequence that a
 * `.gitignore` cannot be trusted with.
 */
export const KEY_PATH_DEFAULT = "~/.ssh/lingtai-agent.private-key.pem";

/** `~/.ssh`'s own mode, for a directory this may have to create. */
const KEY_DIR_MODE = 0o700;
/** The mode the key is written with, and asked for outright — see `writeKey`. */
const KEY_FILE_MODE = 0o600;

/**
 * How long an attempt is this process's.
 *
 * GitHub's own bound on the temporary code is one hour, and there is nothing to
 * be gained by expiring ours first: the state is issued *before* the person
 * reaches GitHub's screen, so a shorter window would refuse a `code` for an App
 * that really was created — and that code is the only copy of the key there
 * will ever be.
 */
export const ATTEMPT_WINDOW_MS = 60 * 60 * 1000;

/** One posted form, remembered only for as long as GitHub will honour its code. */
interface Attempt {
  state: string;
  name: string;
  org: string | null;
  webhookUrl: string | null;
  startedAtMs: number;
}

/** What the screen says about a form that was posted and has not come back. */
export interface Outstanding {
  name: string;
  org: string | null;
  startedAt: Date;
  /** `waiting` while GitHub may still honour the code; `lapsed` after. */
  state: "waiting" | "lapsed";
}

/** What happened when the person came back, in the words the screen shows. */
export type Outcome =
  | {
      ok: true;
      appId: string;
      slug: string;
      name: string;
      /** The file the PEM is in. **The path, never the key.** */
      keyPath: string;
      /** The file the three names were written to. */
      envFile: string;
      /** False when the hook was declared inactive, which is the ordinary case. */
      webhookActive: boolean;
      /** Something true that is not a failure — the log, when it would not take the record. */
      warning: string | null;
      at: Date;
    }
  | {
      ok: false;
      refusal: string;
      /**
       * The App this refusal left behind on GitHub, when there is one.
       *
       * **A refusal after the conversion is not a refusal to create.** GitHub
       * minted the App the moment the person pressed its button, so the half of
       * this flow that cannot be undone is already done — and every later
       * failure (the key file, the env file, the log) leaves it standing. This
       * is what lets the page name that App — its number and its settings link —
       * beside the offer to create another, rather than drawing the form as if
       * nothing had happened.
       *
       * It is **the App this process has minted and not finished**, and not
       * only this return's: a refusal before the conversion carries forward the
       * one an earlier return left behind, because the fact that outlives this
       * answer is *an App of ours exists*. Null only when there is no such
       * App — nothing was created, and starting again is exactly the right
       * advice.
       */
      minted: { appId: string; slug: string } | null;
      at: Date;
    };

export interface BeginOptions {
  /** Where the redirect comes back to, absolute — the board's own origin. */
  redirectUrl: string;
  /** What the App will be called. The person may change it on GitHub's screen. */
  name: string;
  /** An organisation's App, or null for the person's own account. */
  org?: string | null;
  /** A public address GitHub can reach, or null for an inactive hook. */
  webhookUrl?: string | null;
  /** Where GitHub returns a person who has installed the App — the picker (#168). */
  setupUrl?: string | null;
  now?: Date;
}

/** The auto-submitting form's three values, and nothing a caller has to compose. */
export interface Begun {
  /**
   * Where the form posts — GitHub's personal or organisation page, **carrying
   * `state` in its query string**, which is where GitHub takes it from.
   */
  action: string;
  manifest: AppManifest;
  /** The CSRF value, echoed back by GitHub and checked by `finish`. */
  state: string;
}

export interface FinishOptions {
  /** GitHub's temporary code. Good for one hour and one exchange. */
  code: string | null;
  /** The `state` GitHub echoed, which must be one this process issued. */
  state: string | null;
  /** Who pressed it — `human:<id>`. */
  by: string;
  now?: Date;
  store?: EventStore;
  /** The environment the App ID and the key path are read from and written for. */
  env?: NodeJS.ProcessEnv;
  /** Overridable for a test that must not write into a real `.env.local`. */
  envFile?: string;
  keyPath?: string;
  fetch?: typeof fetch;
}

/**
 * The whole of one board process's memory of the flow.
 *
 * **In memory on purpose.** The `state` is a claim that *this process issued
 * this form*, and a store outside the process would make it a claim about
 * something else. A board restarted mid-flow has genuinely forgotten, and
 * saying so is better than accepting a code it cannot vouch for.
 *
 * A factory rather than module-level variables so that a test gets its own, and
 * so that two tests cannot leave an attempt lying about for each other. The
 * board uses the one singleton below, which is what makes the `state` check
 * mean anything at all.
 */
export interface CreationSession {
  begin(options: BeginOptions): Begun;
  finish(options: FinishOptions): Promise<Outcome>;
  /** The posted form nobody has come back from, or null. */
  outstanding(now?: Date): Outstanding | null;
  /** What the last return from GitHub came to, or null. */
  outcome(): Outcome | null;
  /**
   * The App this process minted whose credentials did not all land, or null.
   *
   * **Not the last outcome**, because `begin` clears that: a person who reads
   * the stranded App's name and presses Create again has chosen to, and the
   * screen should still name the App they left behind.
   */
  unfinished(): { appId: string; slug: string } | null;
}

/**
 * The last App this process minted, when it minted it, and whether its
 * credentials landed. What the in-flight guard reads.
 */
interface Mint {
  appId: string;
  slug: string;
  atMs: number;
  finished: boolean;
}

export function createCreationSession(): CreationSession {
  /** Every state this process issued and has not seen back, by its value. */
  const issued = new Map<string, Attempt>();
  /**
   * Every state that has been returned, and the one answer it was given.
   *
   * **One state, one outcome.** The conversion is a round trip to
   * api.github.com and the page looks hung while it runs, so a reload lands a
   * second return carrying the same code — and GitHub honours a code once. The
   * second exchange is a 422, whose sentence is *nothing was written*, and
   * letting that become the screen's answer would report a failure for a
   * creation that wrote the key, the env file and the event. So a return whose
   * state is already being settled joins that settlement rather than starting a
   * second one, and is given its answer.
   */
  const answered = new Map<string, { startedAtMs: number; outcome: Promise<Outcome> }>();
  /**
   * The conversions, one at a time.
   *
   * `convertAndWrite` reads what is already configured and then writes it, so
   * two returns converting at once would both read *nothing is configured* and
   * both write — the two-tab failure below with twenty minutes replaced by
   * twenty milliseconds. Serialising them is what makes that re-read mean
   * something.
   */
  let converting: Promise<unknown> = Promise.resolve();
  let latest: Attempt | null = null;
  let last: Outcome | null = null;
  let mint: Mint | null = null;

  /**
   * Two, because `finish` may only forget one of them.
   *
   * Dropping a lapsed *issue* on the way in would turn *the hour lapsed — the
   * form was posted at …* into *that state is not one this page issued*, which
   * is a different thing and a worse sentence. `convertAndWrite` is what times
   * an attempt out, and it needs the attempt to do it.
   */
  const forgetLapsedAnswers = (nowMs: number) => {
    for (const [state, settled] of answered) {
      if (nowMs - settled.startedAtMs > ATTEMPT_WINDOW_MS) answered.delete(state);
    }
  };

  const prune = (nowMs: number) => {
    for (const [state, attempt] of issued) {
      if (nowMs - attempt.startedAtMs > ATTEMPT_WINDOW_MS) issued.delete(state);
    }
    forgetLapsedAnswers(nowMs);
  };

  return {
    begin(options) {
      const now = options.now ?? new Date();
      prune(now.getTime());
      const state = randomBytes(24).toString("base64url");
      const attempt: Attempt = {
        state,
        name: options.name,
        org: options.org ?? null,
        webhookUrl: options.webhookUrl ?? null,
        startedAtMs: now.getTime(),
      };
      issued.set(state, attempt);
      latest = attempt;
      last = null;
      return {
        // **The `state` is on the action URL**, because that is the one place
        // GitHub reads it from — the query string of `/settings/apps/new`, not
        // the body the manifest is posted in. A form that carries it only as a
        // hidden field is one GitHub has nothing to echo, so every return is a
        // `code` with no `state` and `finish` refuses it, an App already minted
        // and its key already gone.
        action: manifestFormAction(attempt.org, state),
        manifest: buildManifest({
          name: attempt.name,
          redirectUrl: options.redirectUrl,
          webhookUrl: attempt.webhookUrl,
          setupUrl: options.setupUrl ?? null,
        }),
        state,
      };
    },

    async finish(options) {
      const now = options.now ?? new Date();
      forgetLapsedAnswers(now.getTime());
      const state = options.state;

      // A return carrying a state that is already being settled — a reload, or
      // a browser retrying — is handed the first one's answer. It is the same
      // code, and there is one exchange in it.
      const settling = state === null ? undefined : answered.get(state);
      if (settling !== undefined) return await settling.outcome;

      const attempt = state === null ? undefined : issued.get(state);
      // Everything that reads or writes this session's memory happens inside
      // the queued section, so what `convertAndWrite` is told about the last
      // outcome is what is true when it runs rather than when it was queued.
      const outcome = converting.then(async () => {
        const settled = await convertAndWrite(options, now, issued, mint);
        // Either way this attempt is done with: a code is good for one
        // exchange, and a refused one is not worth a second press against the
        // same state.
        if (state !== null) issued.delete(state);
        if (latest !== null && latest.state === state) latest = null;
        last = settled;
        // A refusal before the conversion carries the earlier App forward in
        // `minted`; only a new id is a new mint, and only a new mint moves the
        // time a form has to postdate.
        if (settled.ok) {
          mint = { appId: settled.appId, slug: settled.slug, atMs: now.getTime(), finished: true };
        } else if (settled.minted !== null && settled.minted.appId !== mint?.appId) {
          mint = { ...settled.minted, atMs: now.getTime(), finished: false };
        }
        return settled;
      });
      converting = outcome.then(
        () => undefined,
        () => undefined,
      );
      if (state !== null && attempt !== undefined) {
        answered.set(state, { startedAtMs: attempt.startedAtMs, outcome });
      }
      return await outcome;
    },

    outstanding(now = new Date()) {
      if (latest === null) return null;
      return {
        name: latest.name,
        org: latest.org,
        startedAt: new Date(latest.startedAtMs),
        state: now.getTime() - latest.startedAtMs > ATTEMPT_WINDOW_MS ? "lapsed" : "waiting",
      };
    },

    outcome() {
      return last;
    },

    unfinished() {
      return mint === null || mint.finished ? null : { appId: mint.appId, slug: mint.slug };
    },
  };
}

/**
 * The board's own session — **one per process**, which is what `state` means.
 *
 * Hung off `globalThis` rather than held in this module's scope, because the
 * thing being asserted is *one per process* and a module is not that: Next
 * compiles the page and the two route handlers as separate entries, and a
 * bundler free to instantiate this module twice would give the page an empty
 * session and the redirect a `state` nobody issued. A symbol on the global is
 * the one name that is the process's.
 */
const SESSION = Symbol.for("lingtai.github-app-creation");

interface WithSession {
  [SESSION]?: CreationSession;
}

export const creation: CreationSession =
  ((globalThis as WithSession)[SESSION] ??= createCreationSession());

/**
 * Step 4 and everything after it, as one function that cannot lose the key.
 *
 * The order is the whole of it. Everything that can refuse refuses **before**
 * the conversion, because after it the PEM in hand is the only copy GitHub will
 * ever hand over — there is no *generate it again* on this path. After it, the
 * record goes down first and a failure is reported with the path of whatever
 * did land, so a half-written credential is a sentence someone can act on
 * rather than a lost key — and never a page offering to mint another.
 */
async function convertAndWrite(
  options: FinishOptions,
  now: Date,
  issued: Map<string, Attempt>,
  previous: Mint | null,
): Promise<Outcome> {
  const refuse = (refusal: string, minted: { appId: string; slug: string } | null = null): Outcome => ({
    ok: false,
    refusal,
    minted,
    at: now,
  });

  if (!options.code) {
    return refuse(
      "GitHub sent no code back, so there is nothing to exchange — the App was not created. " +
        "Start again.",
    );
  }
  if (!options.state) {
    return refuse("that link carries no state, so it did not come from this page. Start again.");
  }

  const attempt = issued.get(options.state);
  if (attempt === undefined) {
    // Deliberately one sentence for "never issued" and "issued by a board that
    // has since restarted": both mean this process cannot vouch for the code,
    // and neither is a thing to press through.
    return refuse(
      "that state is not one this page issued, so the code was not accepted. Nothing was " +
        "written. If GitHub did create an App, it is listed under Settings → Developer settings " +
        "→ GitHub Apps, and doc/operating.md finishes it by hand.",
    );
  }
  if (now.getTime() - attempt.startedAtMs > ATTEMPT_WINDOW_MS) {
    return refuse(
      `the hour lapsed — the form was posted at ${new Date(attempt.startedAtMs).toISOString()}, ` +
        "and GitHub's code is good for one hour. Nothing was written — start again.",
    );
  }

  const env = options.env ?? process.env;
  const envFile = options.envFile ?? join(repoRoot(), ".env.local");
  // **The question the page and `start/route.ts` asked, asked again where the
  // writing happens.** A `state` is good for a whole hour and neither of those
  // two checks is one this path makes, so a first tab left on GitHub's naming
  // screen is live for the rest of that hour: finish it after creating the App
  // from a second tab and `.env.local`, the key path and the install link are
  // all rewritten to an App no repository has installed, with the screen saying
  // *Created* and nothing saying what was replaced. Every GitHub call fails as
  // not-installed from the next call.
  //
  // It refuses **before** the conversion, which is the only place it can: the
  // App is on GitHub either way — a person minted it there before this redirect
  // was sent — and credentials for an App that cannot be configured here are
  // not worth fetching. The refusal says where it is and how to be rid of it.
  //
  // **What it asks is whether this process minted one, and never whether that
  // minting succeeded.** A previous return that converted and then failed every
  // write — the key, the env file, and the append that is the only durable
  // record — comes back `ok: false` with `minted` set and leaves nothing on the
  // log for `configuration()` to find: read for success alone, this guard waved
  // the second tab straight through, and a second App was minted beside an
  // unfinished first whose private key GitHub will never hand over again.
  //
  // **An unfinished App refuses only the forms that were issued before it.** A
  // form posted afterwards came from a page that named the stranded App and
  // offered creation anyway (#169: *a minted-but-unconfigured App must not
  // close the door*), so pressing it was a choice made knowing; a form posted
  // before it is a tab nobody has looked at since.
  if (previous !== null && (previous.finished || attempt.startedAtMs <= previous.atMs)) {
    const minted = { appId: previous.appId, slug: previous.slug };
    const at = new Date(previous.atMs).toISOString();
    return refuse(
      previous.finished
        ? `app ${previous.appId} was created here at ${at}, and is what this ` +
            "Lingtai is configured with. This return was not applied: nothing was written, and that " +
            "configuration is untouched. GitHub did create the App this tab named — it is under " +
            "Settings → Developer settings → GitHub Apps, and can be deleted there."
        : `app ${previous.appId} was created here at ${at} and its credentials ` +
            "did not all land — and this tab's form was posted before that, so it was never shown " +
            "that App. This return was not applied and nothing was written. GitHub did create the " +
            "App this tab named as well — it is under Settings → Developer settings → GitHub Apps, " +
            "and can be deleted there. The setup page names the unfinished App and how to finish it.",
      // Carried, not dropped: this refusal becomes the session's last outcome,
      // and the page reads `minted` off it to name the App.
      previous.finished ? null : minted,
    );
  }
  const already = await configuration({ env, envFile, store: options.store ?? eventStore });
  if (already.configured !== null) {
    return refuse(
      `a GitHub App is already configured here — app ${already.configured.appId}, ${
        already.configured.where === "environment" ? "in this process's environment" : `in ${already.configured.file}`
      }. This return was not applied: nothing was written, and that App's id, key path and webhook ` +
        "secret are untouched. GitHub did create the App this tab named — it is under Settings → " +
        "Developer settings → GitHub Apps, and can be deleted there. A second App is one nothing " +
        "is installed on.",
    );
  }
  if (already.minted !== null && attempt.startedAtMs <= already.minted.at.getTime()) {
    // The same rule on the log, for a board restarted between the two: an App
    // minted here after this form was posted is one this tab was never shown.
    // One minted *before* it was on the page that offered this form, by name.
    const { appId, slug } = already.minted;
    return refuse(
      `app ${appId} was created here at ${already.minted.at.toISOString()}, after this tab's form ` +
        `was posted, and this Lingtai is not configured with it — ${envFile} does not name it. This ` +
        "return was not applied and nothing was written. GitHub did create the App this tab named " +
        "as well — it is under Settings → Developer settings → GitHub Apps, and can be deleted there.",
      { appId, slug },
    );
  }
  if (already.unanswered !== null) {
    // **Unknown is not no, here as on the page and in `start`.** The log is what
    // remembers an App minted here whose writes did not land, so a read that
    // fails cannot be read as *nothing was created* — that is a second App
    // minted on a few minutes of unreachable Postgres.
    return refuse(
      "Lingtai cannot tell whether an App was already created here: the log could not be read " +
        `(${already.unanswered}). This return was not applied and nothing was written, because ` +
        "writing it over an App this process cannot see would leave .env.local naming an id no " +
        "repository has installed. GitHub did create the App this tab named — it is under Settings " +
        "→ Developer settings → GitHub Apps, where it can be deleted, or kept and finished by hand " +
        "once pnpm lingtai doctor passes (doc/operating.md from step 2, with a private key " +
        "generated on its own page — the one from this exchange was not fetched).",
    );
  }

  let created;
  try {
    created = await convertManifest(options.code, options.fetch ? { fetch: options.fetch } : {});
  } catch (err) {
    if (err instanceof GitHubError && (err.status === 404 || err.status === 422)) {
      return refuse(
        "GitHub would not exchange that code: it is good for one hour and for one exchange, and " +
          "this one is spent or lapsed. Nothing was written — start again.",
      );
    }
    return refuse(`GitHub would not exchange the code: ${(err as Error).message}. Nothing was written.`);
  }

  // **The record goes down the moment the App exists, and before either write
  // that can fail.** Appended after the writes instead, a `.env.local` that
  // would not take three lines returned a refusal with no record behind it: the
  // page drew the form again under it, and an operator who read *could not be
  // written* as a failure and pressed Create was given another App, another
  // orphan key, and the same refusal — every press. The App exists from here on
  // whatever else fails, so this is where the fact belongs.
  //
  // **What it records is that an App was minted, and never that one is
  // configured.** Those two are one fact only on the path where nothing went
  // wrong, and it is the other paths this record exists for: written first, it
  // is on the log *before* the key file and the env file are, so reading it as
  // *the credentials are there, this process is merely stale* would report a
  // creation whose key write failed as an App a restart will pick up. What is
  // configured is what `.env.local` and the environment say — `configuration()`
  // asks them and does not ask this — and this says an App of Lingtai's is out
  // there on GitHub, which is the fact that makes minting a second one wrong.
  let notRecorded: string | null = null;
  try {
    const store = options.store ?? eventStore;
    const existing = await store.read(GITHUB_APP_STREAM);
    await store.append(GITHUB_APP_STREAM, existing.length, [
      {
        type: "GitHubAppCreated",
        actor: options.by,
        // The id and the slug and nothing else. The log is permanent and
        // `projection rebuild` replays it, so a secret here would be read aloud
        // for ever — and two of the six values that arrived are secrets.
        data: parsePayload("GitHubAppCreated", { appId: String(created.id), slug: created.slug }),
      },
    ]);
  } catch (err) {
    // Not a refusal on its own: the App is real and the credentials may yet
    // land. What is missing is the record, and the record is what stops this
    // page offering to mint a second App before a restart — so every sentence
    // below says which of the two is true.
    notRecorded = (err as Error).message;
  }

  /** The App this exchange put on GitHub, carried by every refusal below. */
  const minted = { appId: String(created.id), slug: created.slug };

  /**
   * What a refusal after this point can promise about pressing Create again.
   *
   * Two guards and not one, because they fail at different times. This process
   * remembers `minted` for as long as it runs, whatever the log said; the log
   * is what survives a restart. So a record that would not go down is a true
   * thing to say — it is the difference between *this page* and *this
   * installation* not offering another.
   */
  const andTheLog =
    notRecorded === null
      ? " It is on Lingtai's log, so the setup page keeps naming it. Creating another is still offered, " +
        "and this App stays on GitHub either way until it is deleted there."
      : ` The log did not record it either (${notRecorded}), so the setup page names it only while ` +
        `this board keeps running — note app ${created.id} now: it exists on GitHub whatever this page says later.`;

  const wanted = options.keyPath ?? optional(KEY_PATH_VAR, env) ?? KEY_PATH_DEFAULT;

  let keyPath: string;
  try {
    keyPath = await writeKey(wanted, created.pem, String(created.id));
  } catch (err) {
    // The one failure with nothing to hand back: the key exists only in this
    // function's memory and is about to leave it.
    return refuse(
      `the App was created on GitHub — ${created.name} (app ${created.id}) — and its private key ` +
        `could not be written to ${wanted}: ${(err as Error).message}. The key cannot be fetched ` +
        "again; generate a new one on the App's own page (Settings → Developer settings → GitHub " +
        "Apps → General → Private keys) and follow doc/operating.md from step 2." +
        andTheLog,
      minted,
    );
  }

  try {
    await writeEnv(
      envFile,
      {
        [APP_ID_VAR]: String(created.id),
        [KEY_PATH_VAR]: keyPath,
        [WEBHOOK_SECRET_VAR]: created.webhookSecret,
      },
      APP_ID_VAR,
    );
  } catch (err) {
    // Two of the three values can be written by hand from this sentence. The
    // third cannot: GitHub generates the webhook secret during the conversion
    // and returns it exactly once, so it is in this frame and nowhere else, and
    // the frame is about to return. Naming only the two that survive would
    // leave an App whose deliveries are signed with a secret that no longer
    // exists anywhere — every POST to /api/webhook refused, and nothing saying
    // why. So the refusal names it and gives the one remedy there is.
    return refuse(
      `the App was created — ${created.name} (app ${created.id}) — and its key is at ${keyPath}, ` +
        `but ${envFile} could not be written: ${(err as Error).message}. Add these two lines to it ` +
        `by hand: ${APP_ID_VAR}=${created.id} and ${KEY_PATH_VAR}=${keyPath}. The third value is ` +
        `lost: ${WEBHOOK_SECRET_VAR} was generated by GitHub during this exchange and is handed ` +
        "back once, so it is not in that file and cannot be read off the App's page — and without " +
        "it every delivery to /api/webhook is refused. Set a new webhook secret on the App's own " +
        "page (Settings → Developer settings → GitHub Apps → General → Webhook secret), and write " +
        `that one here as ${WEBHOOK_SECRET_VAR}.` +
        andTheLog,
      minted,
    );
  }

  // The credentials are on disk and they work; if the log would not take the
  // record, that is a true thing which is not a failure — and it is the one
  // that lets this page offer a second App after a restart, so it is said
  // rather than swallowed.
  const warning =
    notRecorded === null
      ? null
      : `the log did not record it (${notRecorded}), so this page may offer to create ` +
        "another App once this board process stops. Do not — the App exists.";

  return {
    ok: true,
    appId: String(created.id),
    slug: created.slug,
    name: created.name,
    keyPath,
    envFile,
    webhookActive: attempt.webhookUrl !== null,
    warning,
    at: now,
  };
}

/**
 * The PEM at `0600`, and **never over a file that is already there**.
 *
 * A key file at the configured path belongs to an App somebody is using, or to
 * one they have not finished with; overwriting it would destroy the only copy
 * of a credential in order to store another. So the name is taken aside — the
 * App's id makes it unique — and the path that is *actually* written is what is
 * recorded in the env file and shown on the page.
 *
 * `mode` on `writeFile` applies only when the file is created and a umask can
 * narrow it on the way, so the mode is asked for outright afterwards: *the key
 * is 0600* is a fact here rather than a hope.
 */
async function writeKey(wanted: string, pem: string, distinguish: string): Promise<string> {
  const absolute = resolvePath(wanted);
  await mkdir(dirname(absolute), { recursive: true, mode: KEY_DIR_MODE });

  let path = wanted;
  let target = absolute;
  if (await exists(absolute)) {
    const ext = extname(absolute);
    const aside = `${basename(absolute, ext)}.${distinguish}${ext}`;
    path = `${wanted.slice(0, wanted.length - basename(wanted).length)}${aside}`;
    target = join(dirname(absolute), aside);
  }

  await writeFile(target, pem, { mode: KEY_FILE_MODE });
  await chmod(target, KEY_FILE_MODE);
  return path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Three lines into Lingtai's own env file, and every other line left alone.
 *
 * `setEnvLine` is `lingtai env set`'s, so a file with comments in it stays a
 * file with comments in it — and `client_id` and `client_secret` are not here
 * because they never reached this module: `CreatedApp` drops them.
 *
 * The file is created `0600` when it did not exist. Its mode is not changed
 * when it did: that mode is the operator's, and a command that widened a file
 * somebody had narrowed, while claiming to secure it, would be worse than one
 * that never touched it (`agent-env`'s own rule).
 *
 * **`keep` is the guard where the guard belongs.** `configuration()` asks this
 * same file whether an App is configured, and refuses the whole flow when it
 * says yes — but that read is minutes and a round trip to GitHub away from this
 * write, and what happens in between is somebody adding the two lines by hand
 * because the manifest flow would not work for them. So the line that must not
 * be replaced is named here and asked of the bytes this function itself read,
 * minutes later than the page's check and one statement before the write.
 *
 * **It is a read and a write, and those are two syscalls: this narrows the
 * race and does not close it.** There is no compare-and-swap for a file, and a
 * whole-file rewrite loses whatever was written between the two — so the bytes
 * are read once more as late as there is anywhere to put it, anything that
 * changed in between is refused rather than overwritten, and a file that was
 * absent is created exclusively (`wx`), which a second creator loses. A person
 * saving `.env.local` in an editor inside the remaining window gets a sentence
 * they can act on instead of a silent loss.
 *
 * **What makes two returns of this flow safe is not this guard.** It is the
 * `converting` serialisation in `createCreationSession`: one conversion writes
 * at a time, so the re-read above is never racing another return of Lingtai's
 * own. That serialisation is load-bearing and nothing here makes it redundant.
 */
async function writeEnv(file: string, values: Record<string, string>, keep: string): Promise<void> {
  const before = await readOrNull(file);
  const created = before === null;
  const refuseKept = (text: string) => {
    if (named(parseEnvFile(text).values, keep) !== null) {
      throw new Error(
        `${keep} is already set in ${file} — it was written between this page's check and this write, ` +
          "and replacing it would send Lingtai to a different App",
      );
    }
  };
  if (before !== null) refuseKept(before);

  let text = before ?? header();
  for (const [name, value] of Object.entries(values)) text = setEnvLine(text, name, value);

  await mkdir(dirname(file), { recursive: true });
  // As late as there is anywhere to put it. What arrived in between is
  // somebody else's line, and rewriting the whole file is how it is lost.
  const nowOnDisk = await readOrNull(file);
  if (nowOnDisk !== before) {
    if (nowOnDisk !== null) refuseKept(nowOnDisk);
    throw new Error(
      `${file} changed between this write's own read of it and the write itself — nothing was ` +
        "written, because rewriting the whole file would have lost that change",
    );
  }
  // `wx` on a file that was not there: two creators race and the second is
  // refused by the kernel rather than by a check it can outrun.
  await writeFile(file, text, created ? { mode: ENV_FILE_MODE, flag: "wx" } : { mode: ENV_FILE_MODE });
  if (created) await chmod(file, ENV_FILE_MODE);
}

/**
 * What an env file's own values say a name is, or null.
 *
 * `optional`'s rule — **an empty value is not a value** — applied to a parsed
 * file rather than to a process environment. It matters at exactly one line:
 * `.env.example` ships `LINGTAI_GITHUB_APP_ID=` blank, so a person who copied
 * the template has that name in their file and no App, and reading the name as
 * a configuration would refuse them the one screen they came for.
 */
function named(values: Record<string, string>, name: string): string | null {
  const value = values[name];
  return value === undefined || value === "" ? null : value;
}

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

function header(): string {
  return (
    "# Lingtai's own values. Copy .env.example beside it for everything else.\n" +
    "# The GitHub App lines below were written by the board's setup page (#169).\n"
  );
}

// ------------------------------------------------------- what to offer ----

/** The App this log knows about, or null. */
export async function recordedApp(
  store: EventStore = eventStore,
): Promise<{ appId: string; slug: string; at: Date } | null> {
  const events = await store.read(GITHUB_APP_STREAM);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type === "GitHubAppCreated") {
      const data = event.data as { appId: string; slug: string };
      return { appId: data.appId, slug: data.slug, at: event.at };
    }
  }
  return null;
}

/** An App this installation has the credentials of, and where they are. */
export interface Configured {
  /** Never null: an id is what *being* configured means, in both branches. */
  appId: string;
  /** The App's name on GitHub, when the log agrees this is that App. */
  slug: string | null;
  /**
   * Which source named it: the process environment, or an env file on disk.
   * Both are read per call by `githubApp()`, so either is usable as it stands.
   */
  where: "environment" | "file";
  /** The env file, when that is what says so — the page names it. */
  file: string | null;
}

/**
 * Three separate questions with one answer each, and the separation is the
 * point.
 *
 * - **`configured`** — are the credentials here? Asked of `process.env` and of
 *   the env files, which are where `githubApp()` can read them from, and of
 *   nothing else.
 * - **`minted`** — is there an App of Lingtai's on GitHub? Asked of the log,
 *   which is the only durable record of one.
 * - **`unanswered`** — the log would not say, so `minted` is unknown rather
 *   than no.
 *
 * **`minted` was `configured` once, and it was wrong.** `GitHubAppCreated` is
 * appended the moment the conversion returns — before the key file and before
 * the env file, deliberately, so that a write that fails leaves a record behind
 * it. Folding it into *configured* therefore reported exactly the creations
 * that did not finish as configured ones, with no key on this machine behind
 * them.
 *
 * **And `configured` reads the file, not only `process.env`.** The file is what
 * the write targets, and `@lingtai/env` parses it once at import — so a process
 * running since before somebody added the two lines by hand answers *not
 * configured* for as long as it runs, however long the App has worked. Asking
 * `process.env` alone is asking a snapshot whether the thing about to be
 * overwritten is there.
 *
 * **One function because it is one condition.** The page asks it to decide
 * whether to draw the button, `start/route.ts` asks it again where the form
 * arrives, and `convertAndWrite` asks it a third time where the credentials
 * would be written. A guard the last of those does not share is a guard a
 * `state` from a forgotten tab walks straight past an hour later.
 */
async function configuration(options: {
  env: NodeJS.ProcessEnv;
  envFile: string;
  store: EventStore;
}): Promise<{
  configured: Configured | null;
  minted: { appId: string; slug: string; at: Date } | null;
  unanswered: string | null;
}> {
  let minted: { appId: string; slug: string; at: Date } | null = null;
  let unanswered: string | null = null;
  try {
    minted = await recordedApp(options.store);
  } catch (err) {
    unanswered = (err as Error).message;
  }

  // **Both files `@lingtai/env` reads, and in its order.** It loads
  // `.env.local` and then `.env`, first to name a value winning — so an id
  // added by hand to `.env` after this process started is a real configuration
  // that this process's environment cannot see, and writing `.env.local` would
  // shadow it rather than replace it: the same accident with an extra file in
  // it. The write target is still only the first.
  const inTarget = await namedIn(options.envFile, APP_ID_VAR);
  const inFiles = inTarget ?? (await namedIn(join(dirname(options.envFile), ".env"), APP_ID_VAR));
  const envAppId = optional(APP_ID_VAR, options.env) ?? null;
  // **The environment alone**, with no files. Handed `process.env`,
  // `hasGitHubApp` reads the env files as well, so an App named only in
  // `.env.local` answered *the environment has one* while the environment's own
  // id was null — and the id, the slug and the install link all went with it.
  const inEnvironment = envAppId !== null && hasGitHubApp(options.env, []);

  const appId = inEnvironment ? envAppId : (inFiles?.value ?? null);
  // **The id is the configuration's and the slug is the log's**, so the slug
  // describes this App only when the log is about this App. An operator who
  // minted 111 here and then created 222 by hand, pointing `.env.local` at it,
  // would otherwise be shown 222's id beside 111's install link — they install
  // 111, and `lingtai add` answers *not installed* for 222 with nothing saying
  // the link was for a different App. A name Lingtai does not know is the
  // honest answer, and `Configured` already has that sentence.
  const slug = minted !== null && appId !== null && minted.appId === appId ? minted.slug : null;

  const configured: Configured | null =
    inEnvironment && envAppId !== null
      ? { appId: envAppId, slug, where: "environment", file: null }
      : inFiles !== null
        ? { appId: inFiles.value, slug, where: "file", file: inFiles.file }
        : null;
  return { configured, minted, unanswered };
}

/**
 * What one env file says a name is, with the file it said it in — or null.
 *
 * **A named id is enough here, where the environment needs both.**
 * `hasGitHubApp` asks for an id *and* a key because that is what it takes to
 * use one; this reads the file the flow *writes*, and a half-finished
 * configuration in it is still a line that would be replaced by a different
 * App's.
 */
async function namedIn(file: string, name: string): Promise<{ value: string; file: string } | null> {
  const text = await readOrNull(file);
  if (text === null) return null;
  const value = named(parseEnvFile(text).values, name);
  return value === null ? null : { value, file };
}

export interface Offer {
  /** Whether the page offers to create an App at all. */
  offered: boolean;
  /** The credentials this installation has, when it has them. */
  configured: Configured | null;
  /**
   * An App minted here that nothing is configured with — the creation that did
   * not finish. **Never rendered as "configured"**: it says the App is on
   * GitHub, not that its key reached this machine.
   */
  minted: { appId: string; slug: string } | null;
  /**
   * Why the question could not be answered, when it could not — the store's own
   * message. **Not the same as `minted: null`**, which says *no App was created
   * here*; this says *nobody knows*, and nothing is offered on it.
   */
  unanswered: string | null;
  /** #168's first screen, when there is a slug to build it from. */
  installUrl: string | null;
  /** Where the key would go, as it would be written into the env file. */
  keyPath: string;
  /** A name unlikely to collide. GitHub requires one unique across all of it. */
  suggestedName: string;
  /** 0006's table, to be shown rather than asked about. */
  permissions: typeof REQUIRED_PERMISSIONS;
  /** The posted form nobody has come back from. */
  outstanding: Outstanding | null;
  /** What the last return from GitHub came to. */
  outcome: Outcome | null;
}

/**
 * Whether to offer creation, and everything the screen needs to say why not.
 *
 * Two reasons not to, and each is a different sentence on the page:
 *
 * | | |
 * |---|---|
 * | `configured` | the credentials are here — offer the install link instead |
 * | `unanswered` | the log did not say, and a button on an unanswered question mints a second App |
 *
 * **And one reason that is not a reason: `minted`.** An App on GitHub whose
 * credentials never landed is named, with its settings link and the way to
 * finish it by hand, and creation stays offered beside it (#169). Closing the
 * door on it left a person with an App whose key cannot be fetched again and a
 * screen that would never let them make another. A tab posted *before* the
 * stranding is still refused where the writing happens, which is where a
 * forgotten tab can be told from a deliberate press.
 *
 * **A log that will not answer is not a log that said no.** The record is the
 * only thing that outlives a restart when the writes failed, so a read that
 * fails and is taken as *nothing was created* is a few minutes of unreachable
 * Postgres turning into a second App — and GitHub hands a private key over
 * exactly once. The failure is carried as `unanswered` and creation is withheld
 * on it.
 *
 * **And this process's own memory counts, whatever the log took.** A refusal
 * after the conversion carries `minted`: the App exists whether or not the
 * record went down, and the page names it either way.
 */
export async function offerCreation(
  options: {
    env?: NodeJS.ProcessEnv;
    /** The write target, which is also what `configured` is read from. */
    envFile?: string;
    store?: EventStore;
    session?: CreationSession;
    now?: Date;
  } = {},
): Promise<Offer> {
  const env = options.env ?? process.env;
  const envFile = options.envFile ?? join(repoRoot(), ".env.local");
  const session = options.session ?? creation;
  const { configured, minted, unanswered } = await configuration({
    env,
    envFile,
    store: options.store ?? eventStore,
  });
  const outcome = session.outcome();
  const mintedHere =
    session.unfinished() ?? (minted === null ? null : { appId: minted.appId, slug: minted.slug });

  return {
    offered: unanswered === null && configured === null && outcome?.ok !== true,
    configured,
    minted: mintedHere,
    unanswered,
    // The App the person is being sent to install is the one they are
    // configured with, and the slug is null unless the log agrees it is that
    // App — so an unfinished creation's slug is never offered as this one's.
    installUrl: configured?.slug
      ? `https://github.com/apps/${configured.slug}/installations/new`
      : null,
    keyPath: optional(KEY_PATH_VAR, env) ?? KEY_PATH_DEFAULT,
    suggestedName: suggestedName(),
    permissions: REQUIRED_PERMISSIONS,
    outstanding: session.outstanding(options.now),
    outcome,
  };
}

/**
 * A name unlikely to be taken, since a collision fails on GitHub's own screen
 * where Lingtai cannot see it — and reaches this system as a silence.
 */
export function suggestedName(who: string = safeUser()): string {
  return `lingtai-${who}`;
}

function safeUser(): string {
  try {
    const name = userInfo().username.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    return name === "" ? randomUUID().slice(0, 8) : name;
  } catch {
    return randomUUID().slice(0, 8);
  }
}
