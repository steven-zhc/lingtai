import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SQLITE_MACHINE, describeStore, storeChoice } from "@lingtai/env";
import { type AppCheck, type InitWorld, type RuntimeFound, configPath, initCommand, redact } from "../src/init.ts";

/**
 * `lingtai init` (#186), against a world with no database, GitHub, runtime or
 * browser in it — what each would have said is scripted, and what init asked
 * and wrote is recorded. `LINGTAI_HOME` is a directory of the test's own, so
 * `config.yml` is real and the resume is read back from a real file.
 */

const URL_ = "postgresql://me:secret@db.example:5432/lingtai";

/** A step a Ctrl+C can land in. Each is a call into the world that has not returned. */
const STEPS = ["git", "runtimes", "ask:database", "database", "ask:agent", "app", "board", "open", "appeared"] as const;
type Step = (typeof STEPS)[number];

class Interrupted extends Error {}

interface Script {
  runtimes?: RuntimeFound[];
  /** Answers, in order, to whichever questions are asked. */
  answers?: (string | null)[];
  /** URLs that connect. Anything else does not. */
  answering?: string[];
  /** Added to the environment init reads — a `LINGTAI_DATABASE_URL` is the exported one. */
  env?: NodeJS.ProcessEnv;
  app?: AppCheck;
  git?: string | null;
  board?: { url: string } | { refused: string };
  /** A board already up on the port. Its port is then taken, so starting another is refused. */
  running?: string;
  /** Throw from this step, once — the Ctrl+C. */
  interruptAt?: Step;
}

interface Recorded {
  lines: string[];
  asked: string[];
  connected: string[];
  opened: string[];
  boards: number;
  /** Calls made to ask the App whether it answers. */
  apps: number;
}

/** The database's state survives between runs, as a real one would: tables made once are there the next time. */
function database() {
  return { created: false };
}

function world(home: string, script: Script, db = database()): { world: InitWorld; seen: Recorded } {
  const seen: Recorded = { lines: [], asked: [], connected: [], opened: [], boards: 0, apps: 0 };
  const answers = [...(script.answers ?? [])];
  let interrupt = script.interruptAt;
  const step = (name: Step) => {
    if (interrupt === name) {
      interrupt = undefined;
      throw new Interrupted(`ctrl-c during ${name}`);
    }
  };
  return {
    seen,
    world: {
      env: { LINGTAI_HOME: home, ...script.env },
      log: (line) => seen.lines.push(line),
      ask: async (question) => {
        const which: Step = /Postgres/.test(question) ? "ask:database" : "ask:agent";
        seen.asked.push(which);
        step(which);
        return answers.length > 0 ? answers.shift()! : null;
      },
      git: async () => {
        step("git");
        return script.git === undefined ? "git version 2.50.0" : script.git;
      },
      runtimes: async () => {
        step("runtimes");
        return script.runtimes ?? [signedIn("claude-code"), notInstalled("codex")];
      },
      database: async (url) => {
        seen.connected.push(url);
        if (!(script.answering ?? [URL_]).includes(url)) return { ok: false, why: "connection refused" };
        step("database");
        if (db.created) return { ok: true, schema: { created: false, repaired: [] } };
        db.created = true;
        return { ok: true, schema: { created: true, applied: ["Create table \"events\""] } };
      },
      app: async () => {
        step("app");
        seen.apps++;
        return script.app ?? { configured: false };
      },
      appeared: async () => {
        step("appeared");
        return { slug: "lingtai-me", owner: "me" };
      },
      boardAt: async () => script.running ?? null,
      board: async () => {
        step("board");
        seen.boards++;
        if (script.running !== undefined) return { refused: "127.0.0.1:3200 is already in use" };
        return script.board ?? { url: "http://127.0.0.1:3200" };
      },
      open: async (url) => {
        step("open");
        seen.opened.push(url);
        return true;
      },
    },
  };
}

function signedIn(id: RuntimeFound["id"]): RuntimeFound {
  return { id, installed: true, signedIn: true, detail: "signed in via claude.ai" };
}
function signedOut(id: RuntimeFound["id"]): RuntimeFound {
  return { id, installed: true, signedIn: false, detail: "not signed in" };
}
function notInstalled(id: RuntimeFound["id"]): RuntimeFound {
  return { id, installed: false, signedIn: false, detail: `spawn ${id} ENOENT` };
}

function freshHome(): string {
  return join(mkdtempSync(join(tmpdir(), "lingtai-init-")), ".lingtai");
}

function config(home: string): string | null {
  const path = configPath({ LINGTAI_HOME: home });
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

describe("lingtai init (#186)", () => {
  it("on a machine with nothing, ends with a browser open on the wizard's first screen", async () => {
    const home = freshHome();
    const { world: w, seen } = world(home, { answers: [URL_] });

    expect(await initCommand([], w)).toBe(0);

    expect(config(home)).toBe(`database:\n  store: postgres\n  url: ${URL_}\nruntime:\n  agent: claude-code\n`);
    expect(statSync(configPath({ LINGTAI_HOME: home })).mode & 0o777).toBe(0o600);
    expect(seen.opened).toEqual(["http://127.0.0.1:3200/setup/github-app"]);
    expect(seen.lines.join("\n")).toContain("lingtai-me, owned by me — it answered");
    // The password is not printed anywhere.
    expect(seen.lines.join("\n")).not.toContain("secret");
  });

  it("opens the repository picker instead when the App already answers", async () => {
    const home = freshHome();
    const { world: w, seen } = world(home, {
      answers: [URL_],
      app: { configured: true, ok: true, slug: "lingtai-me", owner: "me" },
    });
    expect(await initCommand([], w)).toBe(0);
    expect(seen.opened).toEqual(["http://127.0.0.1:3200/setup/repository"]);
  });

  describe("Ctrl+C at each step, then again: it continues", () => {
    for (const at of STEPS) {
      it(`interrupted during ${at}`, async () => {
        const home = freshHome();
        const db = database();
        // Two signed in, so the agent is a question and has a step to be interrupted in.
        const runtimes = [signedIn("claude-code"), signedIn("codex")];

        const first = world(home, { runtimes, answers: [URL_, "codex"], interruptAt: at }, db);
        await expect(initCommand([], first.world)).rejects.toThrow(Interrupted);

        const second = world(home, { runtimes, answers: [URL_, "codex"] }, db);
        expect(await initCommand([], second.world)).toBe(0);

        expect(config(home)).toBe(`database:\n  store: postgres\n  url: ${URL_}\nruntime:\n  agent: codex\n`);
        expect(second.seen.opened).toEqual(["http://127.0.0.1:3200/setup/github-app"]);

        // What the first run settled, the second does not ask again.
        const settledDatabase = STEPS.indexOf(at) > STEPS.indexOf("database");
        const settledAgent = STEPS.indexOf(at) > STEPS.indexOf("ask:agent");
        expect(second.seen.asked.includes("ask:database")).toBe(!settledDatabase);
        expect(second.seen.asked.includes("ask:agent")).toBe(!settledAgent);
      });
    }
  });

  it("writes nothing before the choice it belongs to is made", async () => {
    const home = freshHome();
    const runtimes = [signedIn("claude-code"), signedIn("codex")];

    // Stopped at the database question: no file at all.
    await expect(initCommand([], world(home, { runtimes, interruptAt: "ask:database" }).world)).rejects.toThrow(Interrupted);
    expect(config(home)).toBeNull();

    // Stopped while connecting: the URL was given and not yet verified.
    await expect(
      initCommand([], world(home, { runtimes, answers: [URL_], interruptAt: "database" }).world),
    ).rejects.toThrow(Interrupted);
    expect(config(home)).toBeNull();

    // Stopped at the agent question: the database is written, no agent is.
    await expect(
      initCommand([], world(home, { runtimes, answers: [URL_], interruptAt: "ask:agent" }).world),
    ).rejects.toThrow(Interrupted);
    expect(config(home)).toBe(`database:\n  store: postgres\n  url: ${URL_}\n`);
  });

  it("verifies each detection rather than assuming it: the database by connecting, the App by a call", async () => {
    const home = freshHome();
    const { world: w, seen } = world(home, { answers: [URL_] });
    expect(await initCommand([], w)).toBe(0);
    const second = world(home, { app: { configured: true, ok: true, slug: "lingtai-me", owner: "me" } });
    expect(await initCommand([], second.world)).toBe(0);
    // Written by the first run, and still connected to by the second.
    expect(second.seen.connected).toEqual([URL_]);
    expect(seen.connected).toEqual([URL_]);
    // The App is asked on every run, and only what the call answered is reported.
    expect(seen.apps).toBe(1);
    expect(second.seen.apps).toBe(1);
    expect(seen.lines.join("\n")).toContain("app          none yet");
    expect(second.seen.lines.join("\n")).toContain("app          lingtai-me, owned by me — it answered");

    // A configured App that does not answer is not reported as answering.
    const failing = world(home, { app: { configured: true, ok: false, why: "401 Bad credentials" } });
    expect(await initCommand([], failing.world)).toBe(1);
    expect(failing.seen.apps).toBe(1);
    expect(failing.seen.lines.join("\n")).not.toContain("it answered");
  });

  describe("a failure returns to the choice", () => {
    it("a URL that does not connect is not written, and the question is asked again", async () => {
      const home = freshHome();
      const bad = "postgresql://me:wrong@db.example:5432/lingtai";
      const { world: w, seen } = world(home, { answers: [bad, URL_] });
      expect(await initCommand([], w)).toBe(0);
      expect(seen.connected).toEqual([bad, URL_]);
      expect(seen.asked.filter((q) => q === "ask:database")).toHaveLength(2);
      expect(config(home)).not.toContain("wrong");
    });

    it("a URL written before the store was (#186) is adopted: verified, and recorded as the choice", async () => {
      const home = freshHome();
      mkdirSync(home, { recursive: true });
      // No `store` key, which is every machine set up before this existed.
      writeFileSync(configPath({ LINGTAI_HOME: home }), `# mine\ndatabase:\n  url: ${URL_}\n`);
      const { world: w, seen } = world(home, { answers: [] });
      expect(await initCommand([], w)).toBe(0);
      // Asked nothing: the URL it already had is the choice nobody recorded.
      expect(seen.asked).toEqual([]);
      expect(seen.connected).toEqual([URL_]);
      expect(config(home)).toContain("# mine");
      expect(config(home)).toContain("store: postgres");
      expect(storeChoice({ LINGTAI_HOME: home })).toMatchObject({ store: "postgres", url: URL_ });
    });

    it("tries a URL it inherited once, then asks — never again, which would never reach the question", async () => {
      const home = freshHome();
      mkdirSync(home, { recursive: true });
      const gone = "postgresql://me@gone.example/lingtai";
      writeFileSync(configPath({ LINGTAI_HOME: home }), `database:\n  url: ${gone}\n`);
      const { world: w, seen } = world(home, { answers: [URL_] });
      expect(await initCommand([], w)).toBe(0);
      expect(seen.connected).toEqual([gone, URL_]);
      expect(seen.asked.filter((q) => q === "ask:database")).toHaveLength(1);
      expect(storeChoice({ LINGTAI_HOME: home })).toMatchObject({ store: "postgres", url: URL_ });
    });

    it("a written URL that stopped answering asks again rather than going on", async () => {
      const home = freshHome();
      mkdirSync(home, { recursive: true });
      const gone = "postgresql://me@gone.example/lingtai";
      writeFileSync(configPath({ LINGTAI_HOME: home }), `# mine\ndatabase:\n  store: postgres\n  url: ${gone}\n`);
      const { world: w, seen } = world(home, { answers: [URL_] });
      expect(await initCommand([], w)).toBe(0);
      expect(seen.connected).toEqual([gone, URL_]);
      expect(config(home)).toContain("# mine");
      expect(config(home)).toContain(URL_);
    });

    it("an agent written in the file and no longer signed in is asked about — never swapped for the one that is", async () => {
      const home = freshHome();
      mkdirSync(home, { recursive: true });
      writeFileSync(configPath({ LINGTAI_HOME: home }), `database:\n  url: ${URL_}\nruntime:\n  agent: codex\n`);
      const runtimes = [signedIn("claude-code"), signedOut("codex")];

      const nobody = world(home, { runtimes, answers: [] });
      expect(await initCommand([], nobody.world)).toBe(1);
      expect(nobody.seen.asked).toEqual(["ask:agent"]);
      expect(config(home)).toContain("agent: codex");

      const chosen = world(home, { runtimes, answers: ["1"] });
      expect(await initCommand([], chosen.world)).toBe(0);
      expect(config(home)).toContain("agent: claude-code");
    });
  });

  it("asks when more than one runtime is signed in, and refuses to pick with nobody to ask", async () => {
    const home = freshHome();
    const runtimes = [signedIn("claude-code"), signedIn("codex")];
    const { world: w, seen } = world(home, { runtimes, answers: [URL_, null] });
    expect(await initCommand([], w)).toBe(1);
    expect(seen.lines.at(-1)).toContain("does not pick one silently");
    expect(config(home)).not.toContain("agent");

    // --agent answers the question, where that one is signed in.
    const flagged = world(home, { runtimes });
    expect(await initCommand(["--agent", "codex"], flagged.world)).toBe(0);
    expect(flagged.seen.asked).toEqual([]);
    expect(config(home)).toContain("agent: codex");
  });

  it("refuses by name when no runtime is signed in, and writes no agent", async () => {
    const home = freshHome();
    const { world: w, seen } = world(home, {
      runtimes: [signedOut("claude-code"), notInstalled("codex")],
      answers: [URL_],
    });
    expect(await initCommand([], w)).toBe(1);
    const said = seen.lines.at(-1)!;
    expect(said).toContain("claude-code is installed and not signed in");
    expect(said).toContain("codex is not installed");
    expect(config(home)).not.toContain("agent");
    expect(seen.boards).toBe(0);
  });

  it("refuses without git, before asking anything", async () => {
    const home = freshHome();
    const { world: w, seen } = world(home, { git: null });
    expect(await initCommand([], w)).toBe(1);
    expect(seen.asked).toEqual([]);
    expect(config(home)).toBeNull();
  });

  it("does not create a second App beside one that does not answer", async () => {
    const home = freshHome();
    const { world: w, seen } = world(home, {
      answers: [URL_],
      app: { configured: true, ok: false, why: "401 A JSON web token could not be decoded" },
    });
    expect(await initCommand([], w)).toBe(1);
    expect(seen.boards).toBe(0);
    expect(seen.opened).toEqual([]);
  });

  it("uses a database already set in the environment, verifies it, and writes nothing for it", async () => {
    const home = freshHome();
    const { world: w, seen } = world(home, { env: { LINGTAI_DATABASE_URL: URL_ } });
    expect(await initCommand([], w)).toBe(0);
    expect(seen.asked).toEqual([]);
    expect(seen.connected).toEqual([URL_]);
    expect(config(home)).toBe("runtime:\n  agent: claude-code\n");
    // It is the process's answer and not the file's, so the file still says nothing.
    expect(seen.lines.join("\n")).toContain("exported into this process");
  });

  it("re-running a finished init reports the state and changes nothing", async () => {
    const home = freshHome();
    const db = database();
    expect(await initCommand([], world(home, { answers: [URL_] }, db).world)).toBe(0);
    const before = config(home);
    const mtime = statSync(configPath({ LINGTAI_HOME: home })).mtimeMs;

    // The board is up, as it is on a finished machine, so its port is taken.
    const again = world(
      home,
      { app: { configured: true, ok: true, slug: "lingtai-me", owner: "me" }, running: "http://127.0.0.1:3200" },
      db,
    );
    expect(await initCommand([], again.world)).toBe(0);
    expect(again.seen.boards).toBe(0);
    expect(again.seen.opened).toEqual(["http://127.0.0.1:3200/setup/repository"]);

    expect(again.seen.asked).toEqual([]);
    expect(config(home)).toBe(before);
    expect(statSync(configPath({ LINGTAI_HOME: home })).mtimeMs).toBe(mtime);
    const said = again.seen.lines.join("\n");
    expect(said).toContain("tables present");
    expect(said).toContain("claude-code ← ");
    expect(said).toContain("lingtai-me, owned by me");
  });

  it("refuses a config.yml that does not parse, rather than writing over it", async () => {
    const home = freshHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(configPath({ LINGTAI_HOME: home }), "database: [unclosed\n");
    const { world: w, seen } = world(home, { answers: [URL_] });
    expect(await initCommand([], w)).toBe(1);
    expect(seen.asked).toEqual([]);
    expect(config(home)).toBe("database: [unclosed\n");
  });

  it("never prints a password", () => {
    expect(redact(URL_)).toBe("postgresql://me:***@db.example:5432/lingtai");
    expect(redact("postgresql://db.example/lingtai")).toBe("postgresql://db.example/lingtai");
  });
});

/**
 * #215, [0056](../../../doc/decisions/0056-the-store-is-a-written-choice.md).
 * The store is a value this command writes; every assertion here reads it back
 * with `storeChoice`, which is the function a later command asks — a test that
 * only read the YAML would pass on exactly the file that made this ticket.
 */
describe("the store is written down, and the screen is a reading of it (#215)", () => {
  it("writes database.store beside the URL, at 0600", async () => {
    const home = freshHome();
    expect(await initCommand([], world(home, { answers: [URL_] }).world)).toBe(0);
    expect(config(home)).toContain("store: postgres");
    expect(statSync(configPath({ LINGTAI_HOME: home })).mode & 0o777).toBe(0o600);
    expect(storeChoice({ LINGTAI_HOME: home })).toMatchObject({ store: "postgres", url: URL_, where: "config.yml" });
  });

  it("makes the empty answer the SQLite choice, and removes the URL the other store was opened by", async () => {
    const home = freshHome();
    // A machine on Postgres, switched by the edit 0056 leaves to this ticket:
    // `store` is the key, and the `url` the old store left behind is what made
    // the reviewer's finding — the screen said SQLite and the file went on
    // selecting Postgres.
    expect(await initCommand([], world(home, { answers: [URL_] }).world)).toBe(0);
    writeFileSync(
      configPath({ LINGTAI_HOME: home }),
      config(home)!.replace("store: postgres", "store: sqlite"),
    );
    expect(storeChoice({ LINGTAI_HOME: home })).toMatchObject({ because: "two keys" });

    const { world: w, seen } = world(home, { answers: [""] });

    // The choice is recorded and **setup finishes on it**: since #179 a written
    // `sqlite` opens a log, so there is a board to serve and no reason to exit
    // non-zero. Exiting 1 here told an operator whose machine was correctly set
    // up to go back and give a Postgres URL instead.
    expect(await initCommand([], w)).toBe(0);
    expect(seen.boards).toBe(1);

    expect(config(home)).toContain("store: sqlite");
    expect(config(home)).not.toContain("url:");
    // The assertion this ticket exists for: what is read afterwards is not Postgres.
    const read = storeChoice({ LINGTAI_HOME: home });
    expect(read).toMatchObject({ store: "sqlite", path: join(home, "lingtai.db") });
    expect(seen.lines.join("\n")).toContain(SQLITE_MACHINE);
    // And nothing offers Postgres as the store this version runs on.
    expect(seen.lines.join("\n")).not.toContain("--database-url");
  });

  it("confirms with the same function a later command asks, and never with the answer typed", async () => {
    const home = freshHome();
    const { world: w, seen } = world(home, { answers: [URL_] });
    expect(await initCommand([], w)).toBe(0);
    // Literally the later command's answer, rendered the one way.
    const line = seen.lines.find((l) => l.includes("store "))!;
    expect(line).toContain(describeStore(storeChoice({ LINGTAI_HOME: home })));
  });

  it("repairs the two refusals a file can be in, saying what was wrong with it first", async () => {
    const contradiction = `database:\n  store: sqlite\n  url: ${URL_}\n`;
    const noUrl = "database:\n  store: postgres\n";
    for (const [written, quoted] of [
      [contradiction, "two keys disagreeing"],
      [noUrl, "names no database.url"],
    ] as const) {
      const home = freshHome();
      mkdirSync(home, { recursive: true });
      writeFileSync(configPath({ LINGTAI_HOME: home }), written);
      const { world: w, seen } = world(home, { answers: [URL_] });

      expect(await initCommand([], w)).toBe(0);
      expect(seen.lines.join("\n")).toContain(quoted);
      expect(storeChoice({ LINGTAI_HOME: home })).toMatchObject({ store: "postgres", url: URL_ });
      expect(config(home)).toContain("store: postgres");
    }
  });

  it("leaves a machine a second run completes, whichever question an interruption landed in", async () => {
    const home = freshHome();
    const db = database();
    // Stopped while connecting: nothing is written, so nothing half-opens.
    await expect(initCommand([], world(home, { answers: [URL_], interruptAt: "database" }, db).world)).rejects.toThrow(
      Interrupted,
    );
    expect(storeChoice({ LINGTAI_HOME: home })).toMatchObject({ because: "nothing chosen" });

    // Stopped after it: the store is written, and the second run asks nothing about it.
    await expect(initCommand([], world(home, { answers: [URL_], interruptAt: "app" }, db).world)).rejects.toThrow(
      Interrupted,
    );
    expect(storeChoice({ LINGTAI_HOME: home })).toMatchObject({ store: "postgres", url: URL_ });
    // Beside, then renamed over: what `install.sh` runs this under can stop at
    // any point and leave a whole file or none, never half of one.
    expect(readdirSync(home).filter((name) => name.includes("partial"))).toEqual([]);

    const second = world(home, {}, db);
    expect(await initCommand([], second.world)).toBe(0);
    expect(second.seen.asked).toEqual([]);
  });

  it("is the exported variable that wins, and it says which it was", async () => {
    const home = freshHome();
    mkdirSync(home, { recursive: true });
    // The file says SQLite; the process was handed a URL, and 0056 §3 is that it wins.
    writeFileSync(configPath({ LINGTAI_HOME: home }), "database:\n  store: sqlite\n");
    const { world: w, seen } = world(home, { env: { LINGTAI_DATABASE_URL: URL_ } });
    expect(await initCommand([], w)).toBe(0);
    expect(seen.connected).toEqual([URL_]);
    expect(seen.lines.join("\n")).toContain("LINGTAI_DATABASE_URL, exported into this process");
    // And nothing was written over: the file's choice is still the file's.
    expect(config(home)).toContain("store: sqlite");
  });
});
