import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { BOARD_PORT, RESERVED_PORT } from "@lingtai/env";
import { createFileLocker, type FileLocker } from "@lingtai/env/lock";
import { afterEach, describe, expect, it } from "vitest";
import {
  BOARD_LOCK,
  type BoardOptions,
  SERVER_KILL_MS,
  STOP_WAIT_MS,
  boardCommand,
  boardEntry,
  boardPlace,
  nextBin,
  serveBoard,
  stopServer,
} from "../src/board.ts";

/**
 * `serveBoard` against a stand-in `server.js` that does what Next's does: binds
 * `PORT` on `HOSTNAME` some time after it is loaded, and not before (#183).
 */
const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  const g = globalThis as { __boardTestServer?: Server; __boardLoaded?: boolean };
  if (g.__boardTestServer) await new Promise((resolve) => g.__boardTestServer!.close(resolve));
  delete g.__boardTestServer;
  delete g.__boardLoaded;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeBoard(delayMs: number): string {
  const dir = mkdtempSync(join(tmpdir(), "lingtai-board-"));
  dirs.push(dir);
  const entry = boardEntry(dir);
  mkdirSync(join(entry, ".."), { recursive: true });
  writeFileSync(
    entry,
    `const net = require("node:net");
globalThis.__boardLoaded = true;
setTimeout(() => {
  globalThis.__boardTestServer = net.createServer((s) => s.end()).listen(Number(process.env.PORT), process.env.HOSTNAME);
}, ${delayMs});
`,
  );
  return dir;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

describe("serveBoard", () => {
  it("resolves only once the server is listening, not when server.js has loaded", async () => {
    const port = await freePort();
    await serveBoard({ place: { built: fakeBoard(400) }, port, host: "127.0.0.1" });
    expect(await answers(port)).toBe(true);
  });

  it("refuses a port somebody else holds before it loads anything", async () => {
    const port = await freePort();
    const holder = createServer();
    servers.push(holder);
    await new Promise<void>((resolve) => holder.listen(port, "127.0.0.1", resolve));

    await expect(serveBoard({ place: { built: fakeBoard(0) }, port, host: "127.0.0.1" })).rejects.toThrow(
      `127.0.0.1:${port} is already in use`,
    );
    expect((globalThis as { __boardLoaded?: boolean }).__boardLoaded).toBeUndefined();
  });
});

/**
 * The `next dev` a checkout's board is served by, and how it is stopped (#187,
 * and the review of it).
 *
 * **macOS has no kill scope of systemd's kind**, so nothing but this process
 * will take that child: a CLI that waits for ever for a Turbopack wedged on
 * shutdown holds the board lock past `board stop`'s deadline, and `stop`'s own
 * advice is then `kill -9` at this pid — which runs no handler, leaves the
 * child on the port named by no lock, and is recovered by finding it by hand.
 */
describe("the development server a start spawned", () => {
  /** A checkout whose `next` binds the port and takes SIGTERM without going. */
  function deafNext(): string {
    const dir = mkdtempSync(join(tmpdir(), "lingtai-board-deaf-"));
    dirs.push(dir);
    const next = nextBin(dir);
    mkdirSync(join(next, ".."), { recursive: true });
    writeFileSync(
      next,
      `const net = require("node:net");
process.on("SIGTERM", () => {});
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
net.createServer((s) => s.end()).listen(port, "127.0.0.1");
`,
    );
    return dir;
  }

  it("is SIGKILLed when it will not go, so the port is free and no orphan is left on it", async () => {
    const port = await freePort();
    const exits: number[] = [];
    await serveBoard({ place: { source: deafNext() }, port, host: "127.0.0.1", onServerExit: (c) => exits.push(c) });
    expect(await answers(port)).toBe(true);

    // What `board stop`'s SIGTERM reaches: the handler this process registered.
    stopServer(50);
    for (let i = 0; i < 200 && exits.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    // 1, because it went on a signal and not on its own.
    expect(exits).toEqual([1]);
    expect(await answers(port)).toBe(false);
  }, 15_000);

  it("gets its deadline inside board stop's, so stop never has to advise that kill -9", () => {
    expect(SERVER_KILL_MS).toBeLessThan(STOP_WAIT_MS);
  });
});

/**
 * Which board there is to serve (#187).
 *
 * The one that sank the first attempt at this ticket: `service install` wrote a
 * job running `lingtai board start`, and on a from-source install `dist/board`
 * has never existed, so the job exited 1 and launchd respawned it every thirty
 * seconds under an `install` that had reported success. The checkout is the
 * second place, and it is the one this repository is.
 */
describe("boardPlace", () => {
  /** A checkout: `apps/board/node_modules/next/dist/bin/next` and nothing else. */
  function checkout(): string {
    const root = mkdtempSync(join(tmpdir(), "lingtai-board-root-"));
    dirs.push(root);
    const next = nextBin(join(root, "apps", "board"));
    mkdirSync(join(next, ".."), { recursive: true });
    writeFileSync(next, "");
    return root;
  }

  it("takes the built board beside the CLI where there is one", () => {
    const built = fakeBoard(0);
    expect(boardPlace({ built, root: checkout() })).toEqual({ built });
  });

  it("takes the checkout's own board where nothing is built — which is this repository", () => {
    const root = checkout();
    expect(boardPlace({ built: join(root, "nothing-built"), root })).toEqual({
      source: join(root, "apps", "board"),
    });
  });

  it("names both when there is neither, rather than leaving a job to crash-loop", () => {
    const empty = mkdtempSync(join(tmpdir(), "lingtai-board-none-"));
    dirs.push(empty);
    const place = boardPlace({ built: join(empty, "dist"), root: empty });
    expect("missing" in place && place.missing).toContain("pnpm build");
    expect("missing" in place && place.missing).toContain("pnpm install");
  });

  it("--dir names one board and never falls back to the checkout", () => {
    const root = checkout();
    const place = boardPlace({ dir: join(root, "elsewhere"), root });
    expect("missing" in place && place.missing).toContain("--dir");
    expect(place).not.toHaveProperty("source");
  });

  it("is what this checkout answers with no arguments at all", () => {
    // Run unbuilt (0010), so this is the `source` branch — the branch the
    // supervised job takes here, and the reason it is not a crash-loop.
    expect(boardPlace()).toEqual({ source: join(import.meta.dirname, "../../board") });
  });
});

/**
 * `lingtai board start|stop|restart|status` (#187).
 *
 * The locker is a stand-in for all but the last test here: the real one writes
 * `pid ${process.pid}`, and every guard `stop` has is about a pid that is not
 * this one. The last test takes the real lock and is what says the stand-in is
 * shaped like it.
 */
describe("the board's lifecycle", () => {
  const HOST = "127.0.0.1";

  /** A locker holding `who`, or nobody. Records what it was asked to take. */
  function locking(who: string | null, unread?: string) {
    const took: string[] = [];
    let held = who;
    const locker: FileLocker = {
      holder: async () => {
        if (unread) throw new Error(unread);
        return held;
      },
      tryLock: async (_key, name) => {
        took.push(name);
        held = `${name} pid ${process.pid} on ${hostname()}`;
        return { ok: true, lock: { release: async () => void (held = null) } };
      },
      queue: async () => {
        throw new Error("the board never queues for the lock");
      },
    };
    return {
      locker,
      took,
      free: () => void (held = null),
      /** Somebody else takes it — a supervisor respawning the job it keeps. */
      replace: (who: string) => void (held = who),
    };
  }

  function run(args: string[], world: Parameters<typeof boardCommand>[1] = {}) {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      go: () =>
        boardCommand(args, {
          env: { LINGTAI_HOME: "/tmp/lingtai-board-test" },
          host: HOST,
          place: { built: "/built/board" },
          answers: async () => false,
          // No supervisor unless a test says so: the live one shells out to
          // launchctl, and this suite is on neither platform.
          keptBySupervisor: () => ({ kept: false }),
          serve: async () => {},
          open: async () => true,
          onInterrupt: () => {},
          sleep: async () => {},
          log: (l) => out.push(l),
          error: (l) => err.push(l),
          ...world,
        }),
    };
  }

  it("serves on 17820 with no configuration, prints the URL and opens a browser", async () => {
    const served: BoardOptions[] = [];
    const opened: string[] = [];
    const { go, out } = run(["start"], {
      locker: locking(null).locker,
      serve: async (o) => void served.push(o),
      open: async (url) => (opened.push(url), true),
    });
    expect(await go()).toBe(0);
    expect(served).toEqual([{ place: { built: "/built/board" }, port: 17820, host: HOST }]);
    expect(opened).toEqual([`http://${HOST}:17820`]);
    expect(out).toContain(`board on http://${HOST}:17820`);
    expect(out.join("\n")).toContain("ctrl-c stops it");
  });

  it("takes the port from the machine file and not from apps/board/package.json", async () => {
    const home = mkdtempSync(join(tmpdir(), "lingtai-board-home-"));
    dirs.push(home);
    writeFileSync(join(home, "config.yml"), "board:\n  port: 19999\n");
    const served: BoardOptions[] = [];
    const { go } = run(["start"], {
      env: { LINGTAI_HOME: home },
      locker: locking(null).locker,
      serve: async (o) => void served.push(o),
    });
    expect(await go()).toBe(0);
    expect(served[0]!.port).toBe(19999);
  });

  it("--no-open opens nothing, which is what the supervisor's job carries", async () => {
    const opened: string[] = [];
    const { go, out } = run(["start", "--no-open"], {
      locker: locking(null).locker,
      open: async (url) => (opened.push(url), true),
    });
    expect(await go()).toBe(0);
    expect(opened).toEqual([]);
    expect(out.join("\n")).toContain("--no-open");
  });

  it("says a board is already there in words, and where the port is set — never EADDRINUSE", async () => {
    const l = locking(`board on 17820 pid 4242 on ${hostname()}`);
    const served: BoardOptions[] = [];
    const { go, err } = run(["start"], { locker: l.locker, serve: async (o) => void served.push(o) });
    expect(await go()).toBe(1);
    expect(err[0]).toBe(`a board is already on 17820 — http://${HOST}:17820`);
    expect(err.join("\n")).toContain("board.port in /tmp/lingtai-board-test/config.yml");
    expect(err.join("\n")).not.toContain("EADDRINUSE");
    expect(served).toEqual([]);
  });

  it("names a port somebody else holds as that, rather than as a board", async () => {
    const served: BoardOptions[] = [];
    const { go, err } = run(["start"], {
      locker: locking(null).locker,
      answers: async () => true,
      serve: async (o) => void served.push(o),
    });
    expect(await go()).toBe(1);
    const said = err.join("\n");
    expect(said).toContain(`${HOST}:17820 is held by something that is not a board`);
    expect(said).toContain("board.port in /tmp/lingtai-board-test/config.yml");
    expect(said).not.toContain("a board is already on");
    expect(served).toEqual([]);
  });

  it("refuses a machine with no board to serve, and takes no lock doing it", async () => {
    const l = locking(null);
    const { go, err } = run(["start"], {
      locker: l.locker,
      place: { missing: "no board to serve: nothing built at /dist/board/apps/board/server.js" },
    });
    expect(await go()).toBe(1);
    expect(err.join("\n")).toContain("no board to serve");
    // Nothing was taken, so a `board status` in the same instant does not say
    // somebody is serving one.
    expect(l.took).toEqual([]);
  });

  /**
   * A start that failed after `serveFromSource` spawned one — `listening`
   * gives the bind sixty seconds, and a cold machine with no `.next` cache can
   * take longer. The child binds the port a moment later, and without this it
   * is a board holding no lock: `status` says nobody is serving beside a port
   * that answers, `stop` refuses to signal it, and every `board start` — each
   * 30s supervisor respawn included — is refused as *something that is not a
   * board of this machine's*. The CLI would not exit either: the ref'd child
   * handle keeps the loop alive while `main` only sets `process.exitCode`.
   */
  it("takes the development server with it when the serve it spawned one for fails", async () => {
    const l = locking(null);
    const stopped: string[] = [];
    const { go, err } = run(["start"], {
      locker: l.locker,
      serve: async () => {
        throw new Error("the board never listened on 127.0.0.1:17820");
      },
      stopServing: () => stopped.push("SIGTERM"),
    });
    expect(await go()).toBe(1);
    expect(err.join("\n")).toContain("the board never listened on 127.0.0.1:17820");
    expect(stopped).toEqual(["SIGTERM"]);
    // And the lock, as before — the two go together, or the next start is
    // refused by a board that is not there.
    expect(await l.locker.holder(BOARD_LOCK)).toBe(null);
  });

  it("stop signals the pid the lock names, and waits for the lock to go", async () => {
    const l = locking(`board on 17820 pid 4242 on ${hostname()}`);
    const signalled: [number, string | 0][] = [];
    const { go, out } = run(["stop"], {
      locker: l.locker,
      signal: (pid, sig) => {
        signalled.push([pid, sig]);
        l.free();
      },
    });
    expect(await go()).toBe(0);
    // SIGTERM, not the drain the conductor gets: a board has no pass to finish.
    expect(signalled).toEqual([[4242, "SIGTERM"]]);
    expect(out.join("\n")).toContain("stopped the board on 17820 — pid 4242");
  });

  it("stop signals nothing for a lock another machine holds", async () => {
    const signalled: number[] = [];
    const { go, err } = run(["stop"], {
      locker: locking("board on 17820 pid 4242 on somebody-elses-mac").locker,
      signal: (pid) => void signalled.push(pid),
    });
    expect(await go()).toBe(1);
    expect(signalled).toEqual([]);
    expect(err.join("\n")).toContain("not this machine");
  });

  it("stop says nothing is running rather than that it stopped something", async () => {
    const { go, out } = run(["stop"], { locker: locking(null).locker });
    expect(await go()).toBe(0);
    expect(out).toEqual(["no board is running"]);
  });

  it("status answers who is serving and whether the port answers, and never folds one into the other", async () => {
    const { go, out } = run(["status"], {
      locker: locking(`board on 17820 pid 4242 on ${hostname()}`).locker,
      answers: async () => false,
    });
    expect(await go()).toBe(0);
    expect(out.join("\n")).toContain(`board on 17820 pid 4242 on ${hostname()}`);
    expect(out.join("\n")).toContain("nothing answers");
  });

  it("says a lock it could not read as unread, never as nobody serving", async () => {
    const { go, err } = run(["stop"], { locker: locking(null, "no such file or directory").locker });
    expect(await go()).toBe(1);
    expect(err.join("\n")).toContain("could not read who is serving the board — no such file or directory");
  });

  it("is really the file lock underneath: a board that holds it refuses the next start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lingtai-board-lock-"));
    dirs.push(dir);
    const locker = createFileLocker({ dir });
    const taken = await locker.tryLock(BOARD_LOCK, "board on 17820");
    expect(taken.ok).toBe(true);
    const { go, err } = run(["start"], { locker });
    expect(await go()).toBe(1);
    expect(err[0]).toBe(`a board is already on 17820 — http://${HOST}:17820`);
    if (taken.ok) await taken.lock.release();
  });

  /**
   * **`restart` must not race the supervisor for the lock it just freed**, and
   * on a supervised machine it wins: `holding` is a few milliseconds of SQLite
   * and `serve` a spawn, all well inside launchd's respawn. What it wins is the
   * job exiting 1 on a lock it cannot take, respawned every thirty seconds
   * behind a board that goes when this terminal closes — the state
   * `confirmBoard` refuses to call a start, reached through the restart verb
   * and reported as success. Found cold by the review of #187.
   */
  describe("restart, and whose board it is", () => {
    const JOB = "ai.nextloom.lingtai.board";

    it("stops the supervisor's board and starts none itself, taking no lock at all", async () => {
      const l = locking(`board on 17820 pid 500 on ${hostname()}`);
      const served: BoardOptions[] = [];
      const { go, out } = run(["restart"], {
        locker: l.locker,
        keptBySupervisor: () => ({ kept: true, job: JOB }),
        signal: () => l.free(),
        serve: async (o) => void served.push(o),
      });
      expect(await go()).toBe(0);
      // The whole finding: nothing was served here and nothing was taken, so
      // the respawn has the lock it needs and there is no crash-loop behind it.
      expect(served).toEqual([]);
      expect(l.took).toEqual([]);
      expect(out.join("\n")).toContain(`${JOB} keeps this board, so none was started here`);
      expect(out.join("\n")).toContain("pnpm lingtai service restart");
    });

    it("is stop and then start where no supervisor keeps one, which is the terminal case", async () => {
      const l = locking(`board on 17820 pid 4242 on ${hostname()}`);
      const served: BoardOptions[] = [];
      const { go } = run(["restart"], {
        locker: l.locker,
        keptBySupervisor: () => ({ kept: false }),
        signal: () => l.free(),
        serve: async (o) => void served.push(o),
      });
      expect(await go()).toBe(0);
      expect(served).toHaveLength(1);
      expect(l.took).toEqual(["board on 17820"]);
    });

    it("stops nothing when it could not be told — a restart that cannot tell would race", async () => {
      const signalled: number[] = [];
      const { go, err } = run(["restart"], {
        locker: locking(`board on 17820 pid 500 on ${hostname()}`).locker,
        keptBySupervisor: () => ({ unread: "launchctl print exited 112: Could not find domain" }),
        signal: (pid) => void signalled.push(pid),
      });
      expect(await go()).toBe(1);
      expect(signalled).toEqual([]);
      expect(err.join("\n")).toContain("nothing was stopped");
    });

    /**
     * The other half of the same fact: a supervisor takes the lock back in the
     * instant it is freed, so `stop`'s poll often never sees it empty. Reading
     * that as *the pid I signalled will not go* would fail a stop that worked,
     * and send somebody to `kill -9` a pid that is already gone.
     */
    it("stop says the board came back, and never that the pid it signalled held on", async () => {
      const l = locking(`board on 17820 pid 500 on ${hostname()}`);
      const { go, out, err } = run(["stop"], {
        locker: l.locker,
        signal: () => l.replace(`board on 17820 pid 502 on ${hostname()}`),
      });
      expect(await go()).toBe(0);
      expect(out.join("\n")).toContain("stopped the board on 17820 — pid 500");
      expect(out.join("\n")).toContain("pid 502");
      expect(err).toEqual([]);
    });
  });
});

/**
 * `RESERVED_PORT` is reserved and **bound by nothing** (#187). The number lives
 * in one declaration with a comment on it; anything that started listening on
 * it would have to name it somewhere, and this is what notices. Written through
 * the constant and never as the literal, so this file is not its own second
 * occurrence.
 */
describe("the reserved port", () => {
  /**
   * Tracked files matching `pattern`, everywhere this machine's own code lives
   * — `scripts/` included, since a generated unit file or a one-off server
   * there binds a port exactly as `apps/` does. `doc/` is left out on purpose:
   * it says the number, and saying it is what documentation is for.
   */
  const mentioning = (pattern: string): string[] =>
    execFileSync("git", ["grep", "-l", pattern, "--", "apps", "packages", "scripts"], {
      cwd: join(import.meta.dirname, "../../.."),
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);

  it("is named in exactly one place, and nothing binds it", () => {
    expect(mentioning(String(RESERVED_PORT))).toEqual(["packages/env/src/index.ts"]);
    expect(RESERVED_PORT).toBe(BOARD_PORT + 1);
  });

  /**
   * **The literal is not how a bind would be written.** `server.listen(RESERVED_PORT,
   * "127.0.0.1")` in `daemon.ts` names the number nowhere, and the grep above
   * would pass over it while `doc/operating.md`'s *a test fails if anything
   * starts using it* went on saying otherwise. So the constant's own uses are
   * the list, and it is these three: the declaration and the two tests that
   * assert it is unused. A fourth is a listener to explain — moving the webhook
   * receiver off the board is the candidate #187 names — and the change that
   * adds one edits this line, and this comment, deliberately.
   */
  it("is not used through the constant either, which is how a bind would be written", () => {
    expect(mentioning("RESERVED_PORT")).toEqual([
      "apps/cli/pure/board.test.ts",
      "packages/env/src/index.ts",
      "packages/env/test/env.test.ts",
    ]);
  });
});
