import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
  preset?: { url: string; from: string } | null;
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
      env: { LINGTAI_HOME: home },
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
      presetDatabase: () => script.preset ?? null,
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

    expect(config(home)).toBe(`database:\n  url: ${URL_}\n`);
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

        expect(config(home)).toBe(`database:\n  url: ${URL_}\n`);
        expect(second.seen.opened).toEqual(["http://127.0.0.1:3200/setup/github-app"]);

        // Machine choices survive. Project agent choices are never written here.
        const settledDatabase = STEPS.indexOf(at) > STEPS.indexOf("database");
        expect(second.seen.asked.includes("ask:database")).toBe(!settledDatabase);
        expect(second.seen.asked.includes("ask:agent")).toBe(true);
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
    expect(config(home)).toBe(`database:\n  url: ${URL_}\n`);
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

    it("an empty answer is SQLite, which is not built — said by number, and asked again", async () => {
      const home = freshHome();
      const { world: w, seen } = world(home, { answers: ["", URL_] });
      expect(await initCommand([], w)).toBe(0);
      expect(seen.lines.join("\n")).toContain("#179");
      expect(config(home)).toContain(URL_);
    });

    it("a written URL that stopped answering asks again rather than going on", async () => {
      const home = freshHome();
      mkdirSync(home, { recursive: true });
      const gone = "postgresql://me@gone.example/lingtai";
      writeFileSync(configPath({ LINGTAI_HOME: home }), `# mine\ndatabase:\n  url: ${gone}\n`);
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
      expect(config(home)).toContain("agent: codex"); // Legacy source is retained until explicit migration.
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
    expect(config(home)).not.toContain("agent");
    expect(flagged.seen.lines.join("\n")).toContain("save the project choice in its recipe");
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
    const { world: w, seen } = world(home, { preset: { url: URL_, from: "LINGTAI_DATABASE_URL" } });
    expect(await initCommand([], w)).toBe(0);
    expect(seen.asked).toEqual([]);
    expect(seen.connected).toEqual([URL_]);
    expect(config(home)).toBeNull();
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
    expect(said).toContain("claude-code · detected");
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
