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
 * **It ends on a restart and not on "ready".** `githubApp()` re-reads the key
 * file on every call, so a PEM that lands at a configured path is picked up by
 * a running process — but `LINGTAI_GITHUB_APP_ID` is read from `process.env`,
 * which was fixed when that process started. The private key hot-reloads and
 * the App ID does not, so a credential minted at runtime works by half, and a
 * page that said *ready* would be claiming a state only the process that
 * received it is in. `lingtai restart`
 * ([0042](../../../doc/decisions/0042-restart-is-a-command.md)) exists to be
 * the honest ending.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { ENV_FILE_MODE, setEnvLine } from "@lingtai/agent-env";
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
  | { ok: false; refusal: string; at: Date };

export interface BeginOptions {
  /** Where the redirect comes back to, absolute — the board's own origin. */
  redirectUrl: string;
  /** What the App will be called. The person may change it on GitHub's screen. */
  name: string;
  /** An organisation's App, or null for the person's own account. */
  org?: string | null;
  /** A public address GitHub can reach, or null for an inactive hook. */
  webhookUrl?: string | null;
  now?: Date;
}

/** The auto-submitting form's three values, and nothing a caller has to compose. */
export interface Begun {
  /** Where the form posts — GitHub's personal or organisation page. */
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
}

export function createCreationSession(): CreationSession {
  /** Every state this process issued and has not seen back, by its value. */
  const issued = new Map<string, Attempt>();
  let latest: Attempt | null = null;
  let last: Outcome | null = null;

  const prune = (nowMs: number) => {
    for (const [state, attempt] of issued) {
      if (nowMs - attempt.startedAtMs > ATTEMPT_WINDOW_MS) issued.delete(state);
    }
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
        action: manifestFormAction(attempt.org),
        manifest: buildManifest({
          name: attempt.name,
          redirectUrl: options.redirectUrl,
          webhookUrl: attempt.webhookUrl,
        }),
        state,
      };
    },

    async finish(options) {
      const now = options.now ?? new Date();
      const outcome = await convertAndWrite(options, now, issued);
      // Either way this attempt is done with: a code is good for one exchange,
      // and a refused one is not worth a second press against the same state.
      if (options.state !== null) issued.delete(options.state);
      if (latest !== null && latest.state === options.state) latest = null;
      last = outcome;
      return outcome;
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
 * ever hand over — there is no *generate it again* on this path. After it, a
 * failure is reported with the path of whatever did land, so a half-written
 * credential is a sentence someone can act on rather than a lost key.
 */
async function convertAndWrite(
  options: FinishOptions,
  now: Date,
  issued: Map<string, Attempt>,
): Promise<Outcome> {
  const refuse = (refusal: string): Outcome => ({ ok: false, refusal, at: now });

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

  const env = options.env ?? process.env;
  const envFile = options.envFile ?? join(repoRoot(), ".env.local");
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
        "Apps → General → Private keys) and follow doc/operating.md from step 2.",
    );
  }

  try {
    await writeEnv(envFile, {
      [APP_ID_VAR]: String(created.id),
      [KEY_PATH_VAR]: keyPath,
      [WEBHOOK_SECRET_VAR]: created.webhookSecret,
    });
  } catch (err) {
    return refuse(
      `the App was created — ${created.name} (app ${created.id}) — and its key is at ${keyPath}, ` +
        `but ${envFile} could not be written: ${(err as Error).message}. Add these two lines to it ` +
        `by hand: ${APP_ID_VAR}=${created.id} and ${KEY_PATH_VAR}=${keyPath}.`,
    );
  }

  let warning: string | null = null;
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
    // Not a refusal: the credentials are on disk and they work. What is missing
    // is the record, and the record is what stops this page offering to mint a
    // second App before a restart — so it is said rather than swallowed.
    warning =
      `the log did not record it (${(err as Error).message}), so this page may offer to create ` +
      "another App until Lingtai is restarted. Do not — the App exists.";
  }

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
 */
async function writeEnv(file: string, values: Record<string, string>): Promise<void> {
  const before = await readOrNull(file);
  const created = before === null;
  let text = before ?? header();
  for (const [name, value] of Object.entries(values)) text = setEnvLine(text, name, value);

  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text, { mode: ENV_FILE_MODE });
  if (created) await chmod(file, ENV_FILE_MODE);
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
): Promise<{ appId: string; slug: string } | null> {
  const events = await store.read(GITHUB_APP_STREAM);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type === "GitHubAppCreated") {
      const data = event.data as { appId: string; slug: string };
      return { appId: data.appId, slug: data.slug };
    }
  }
  return null;
}

export interface Offer {
  /** Whether the page offers to create an App at all. */
  offered: boolean;
  /** Why not, when it is not: what is already configured, and how that is known. */
  configured: { appId: string | null; slug: string | null; from: "environment" | "log" } | null;
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
 * **Two ways of already having one, and the second is the one that matters.**
 * `hasGitHubApp()` reads `process.env`, which a board fixed at start — so the
 * process that has just written `LINGTAI_GITHUB_APP_ID` still answers *not
 * configured*, and a page reading only that would cheerfully offer to mint a
 * second App on the next render. The log is what closes it: `GitHubAppCreated`
 * is durable, and the App it names exists whatever this process's environment
 * says.
 */
export async function offerCreation(
  options: { env?: NodeJS.ProcessEnv; store?: EventStore; session?: CreationSession; now?: Date } = {},
): Promise<Offer> {
  const env = options.env ?? process.env;
  const session = options.session ?? creation;
  const recorded = await recordedApp(options.store ?? eventStore).catch(() => null);
  const configuredHere = hasGitHubApp(env);

  const outcome = session.outcome();
  const configured = configuredHere
    ? { appId: optional(APP_ID_VAR, env) ?? null, slug: recorded?.slug ?? null, from: "environment" as const }
    : recorded !== null
      ? { appId: recorded.appId, slug: recorded.slug, from: "log" as const }
      : null;

  return {
    // **Three ways of already having one**, and the third is the narrowest: an
    // App that was created a moment ago, whose record the log would not take
    // (`warning`). The files on disk are the credential either way, so offering
    // again would mint a second App over a working one.
    offered: configured === null && outcome?.ok !== true,
    configured,
    installUrl: configured?.slug ? `https://github.com/apps/${configured.slug}/installations/new` : null,
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
