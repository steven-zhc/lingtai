import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boardEntry, boardPortOrWhy, builtBoardDir, serveBoard } from "../src/board.ts";

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
    await serveBoard({ dir: fakeBoard(400), port, host: "127.0.0.1" });
    expect(await answers(port)).toBe(true);
  });

  it("refuses a port somebody else holds before it loads anything", async () => {
    const port = await freePort();
    const holder = createServer();
    servers.push(holder);
    await new Promise<void>((resolve) => holder.listen(port, "127.0.0.1", resolve));

    await expect(serveBoard({ dir: fakeBoard(0), port, host: "127.0.0.1" })).rejects.toThrow(
      `127.0.0.1:${port} is already in use`,
    );
    expect((globalThis as { __boardLoaded?: boolean }).__boardLoaded).toBeUndefined();
  });
});

/**
 * Where the built board is found (#187).
 *
 * The one that matters is the second: `lingtai service`'s board job runs
 * `<root>/apps/cli/src/lingtai.ts board start` — from the source, which is the
 * only kind of install `service install` supports — so a `builtBoardDir` that
 * looked only beside itself gave that job nothing to serve, and launchd
 * respawned the corpse every thirty seconds.
 */
describe("builtBoardDir", () => {
  function tree(...entries: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "lingtai-built-"));
    dirs.push(dir);
    for (const entry of entries) {
      const at = boardEntry(join(dir, entry));
      mkdirSync(join(at, ".."), { recursive: true });
      writeFileSync(at, "");
    }
    return dir;
  }

  it("is the board beside the running file, which is where a shipped build puts it", () => {
    const dir = tree("board");
    expect(builtBoardDir(join(dir, "lingtai.cjs"), "/nowhere")).toBe(join(dir, "board"));
  });

  it("is <root>/dist/board from the source, where pnpm build writes it and nothing is beside apps/cli/src", () => {
    const root = tree(join("dist", "board"));
    expect(builtBoardDir(join(root, "apps/cli/src/lingtai.ts"), root)).toBe(join(root, "dist", "board"));
  });

  it("prefers the one beside it, so a checkout's stale dist never shadows a shipped build", () => {
    const root = tree("board", join("dist", "board"));
    expect(builtBoardDir(join(root, "lingtai.cjs"), root)).toBe(join(root, "board"));
  });

  it("names the one beside it where neither holds a board, which is what serveBoard then refuses by", () => {
    const root = tree();
    expect(builtBoardDir(join(root, "apps/cli/src/lingtai.ts"), root)).toBe(join(root, "apps/cli/src/board"));
  });
});

/**
 * `lingtai board start|stop|restart|status` (#187) — the verbs, against a world
 * that holds no lock, signals nothing and starts no server. What these pin is
 * what each verb *says* and *whom it signals*: a board the supervisor keeps is
 * respawned in thirty seconds, so a signal sent to it here is a second board
 * racing the first for the port.
 */
import {
  boardCommand,
  boardLock,
  holdingProcess,
  parseBoardArgs,
  type BoardCommand,
  type BoardWorld,
} from "../src/board.ts";
import { BOARD_WAIT_MS, type Keeper } from "../src/service.ts";

const PORT = 17820;
const URL = `http://127.0.0.1:${PORT}`;

function world(over: Partial<BoardWorld> & { holder?: string | null } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[] = [];
  const signalled: number[] = [];
  let holder: string | null = over.holder ?? null;
  const w: BoardWorld = {
    host: "127.0.0.1",
    hostname: "mac",
    answering: async () => null,
    bound: async () => false,
    locker: {
      tryLock: async (_key, name) => {
        if (holder !== null) return { ok: false, holder };
        holder = `${name} pid 500 on mac`;
        return { ok: true, lock: { release: async () => void (holder = null) } };
      },
      holder: async () => holder,
    },
    keeper: () => ({ kept: false }) as Keeper,
    exec: (call) => (calls.push(call.join(" ")), { status: 0, out: "" }),
    serve: async () => {},
    open: async () => true,
    signal: (pid) => {
      signalled.push(pid);
      holder = null;
      return true;
    },
    sleep: async () => {},
    now: () => Date.now(),
    whereThePortIsSet: "board.port in ~/.lingtai/config.yml, or --port for this one run",
    log: (l) => out.push(l),
    error: (l) => err.push(l),
    ...over,
  };
  const go = (verb: BoardCommand["verb"], extra: Partial<BoardCommand> = {}) =>
    boardCommand({ verb, port: PORT, dir: "/dist/board", open: false, ...extra }, w);
  return { go, out, err, calls, signalled, held: () => holder };
}

const KEPT: Keeper = { kept: true, platform: "launchd", path: "/Users/x/Library/LaunchAgents/ai.nextloom.lingtai.board.plist", uid: 501 };

describe("lingtai board, the arguments", () => {
  it("is start when no verb is named, as it was before it had verbs", () => {
    expect(parseBoardArgs([])).toEqual({ verb: "start", port: null, dir: null, open: true });
    expect(parseBoardArgs(["--port", "18080"])).toEqual({ verb: "start", port: 18080, dir: null, open: true });
  });

  it("answers `shutdown` by name with the verb that is not it, and why", () => {
    const refused = parseBoardArgs(["shutdown"]);
    expect(refused).toEqual({ refused: expect.stringContaining("lingtai board stop") });
    expect((refused as { refused: string }).refused).toContain("no pass to finish");
  });

  it("takes --no-open, which is what the supervisor's job passes", () => {
    expect(parseBoardArgs(["start", "--no-open"])).toEqual({ verb: "start", port: null, dir: null, open: false });
  });

  it("refuses a port that is not one rather than serving somewhere nobody meant", () => {
    expect(parseBoardArgs(["start", "--port", "no"])).toEqual({ refused: expect.stringContaining("--port takes a port number") });
    expect(parseBoardArgs(["start", "--port", "99999"])).toEqual({ refused: expect.stringContaining("--port takes a port number") });
  });
});

describe("lingtai board start", () => {
  it("serves, prints the URL and says what stops it", async () => {
    const w = world();
    expect(await w.go("start")).toBe(0);
    expect(w.out.join("\n")).toContain(`board on ${URL}`);
    expect(w.out.join("\n")).toContain("ctrl-c stops it");
    expect(w.held()).toBe(`board on ${PORT} pid 500 on mac`);
  });

  it("opens a browser, and says where to look when it could not", async () => {
    const opened: string[] = [];
    const w = world({ open: async (url) => (opened.push(url), true) });
    expect(await w.go("start", { open: true })).toBe(0);
    expect(opened).toEqual([URL]);

    const none = world({ open: async () => false });
    expect(await none.go("start", { open: true })).toBe(0);
    expect(none.out.join("\n")).toContain(`no browser could be opened here — open ${URL}`);
  });

  it("says a board is already on the port in words, and where the port is set — never a bare EADDRINUSE", async () => {
    const w = world({ holder: `board on ${PORT} pid 41 on mac` });
    expect(await w.go("start")).toBe(1);
    expect(w.err[0]).toBe(`a board is already on ${PORT} — ${URL}`);
    expect(w.err.join("\n")).toContain(`held by board on ${PORT} pid 41 on mac`);
    expect(w.err.join("\n")).toContain("board.port in ~/.lingtai/config.yml");
    expect(w.err.join("\n")).not.toMatch(/EADDRINUSE/);
  });

  it("names a port something that is not a board holds, and serves nothing on it", async () => {
    let served = false;
    const w = world({ bound: async () => true, serve: async () => void (served = true) });
    expect(await w.go("start")).toBe(1);
    expect(served).toBe(false);
    expect(w.err.join("\n")).toContain("is held by something that is not a Lingtai board");
    expect(w.err.join("\n")).toContain("board.port in ~/.lingtai/config.yml");
    // The lock is not left behind for a board that never started.
    expect(w.held()).toBeNull();
  });

  it("lets the lock go when the server refuses, so the next start is not refused over it", async () => {
    const w = world({
      serve: async () => {
        throw new Error("no built board at /dist/board/apps/board/server.js");
      },
    });
    expect(await w.go("start")).toBe(1);
    expect(w.held()).toBeNull();
    expect(w.err.join("\n")).toContain("no built board");
  });
});

describe("lingtai board stop", () => {
  it("signals the pid the lock names, and says which it was", async () => {
    const w = world({ holder: `board on ${PORT} pid 500 on mac` });
    expect(await w.go("stop")).toBe(0);
    expect(w.signalled).toEqual([500]);
    expect(w.out.join("\n")).toContain(`stopped the board on ${PORT} — pid 500`);
  });

  it("is the supervisor's call where a supervisor keeps the board, and signals nothing itself", async () => {
    // A signal here would be respawned thirty seconds later, behind whatever
    // took the port in the meantime.
    const w = world({ holder: `board on ${PORT} pid 500 on mac`, keeper: () => KEPT });
    expect(await w.go("stop")).toBe(0);
    expect(w.signalled).toEqual([]);
    expect(w.calls).toEqual(["launchctl bootout gui/501/ai.nextloom.lingtai.board"]);
    expect(w.out.join("\n")).toContain("pnpm lingtai service start");
  });

  it("stops nothing, and says so, when no board of this machine's is running", async () => {
    const w = world();
    expect(await w.go("stop")).toBe(0);
    expect(w.signalled).toEqual([]);
    expect(w.out.join("\n")).toContain("there was nothing to stop");
  });

  it("does not call something answering on the port a board of ours, when no lock names it", async () => {
    const w = world({ answering: async () => URL });
    expect(await w.go("stop")).toBe(0);
    expect(w.signalled).toEqual([]);
    expect(w.out.join("\n")).toContain("this signalled nothing, since no lock names it");
  });

  it("signals nothing for a holder on another machine", async () => {
    const w = world({ holder: `board on ${PORT} pid 500 on someone-else` });
    expect(await w.go("stop")).toBe(1);
    expect(w.signalled).toEqual([]);
    expect(w.err.join("\n")).toContain("on another machine");
  });

  it("signals nothing when it could not be told whether a supervisor keeps one", async () => {
    const w = world({ holder: `board on ${PORT} pid 500 on mac`, keeper: () => ({ unread: "launchctl print exited 112" }) });
    expect(await w.go("stop")).toBe(1);
    expect(w.signalled).toEqual([]);
    expect(w.err.join("\n")).toContain("launchctl print exited 112");
  });

  it("says a board that ignored SIGTERM still holds the lock, and the blunt way out", async () => {
    const w = world({
      holder: `board on ${PORT} pid 500 on mac`,
      // A signal that changes nothing: the holder stays.
      signal: () => true,
    });
    expect(await w.go("stop")).toBe(1);
    expect(w.err.join("\n")).toContain("kill -9 500");
  });
});

describe("lingtai board restart", () => {
  it("is one supervisor call where a supervisor keeps it, never stop-then-start in this terminal", async () => {
    // Stopping the job and starting a board here leaves launchd respawning its
    // own every thirty seconds against a port this terminal holds.
    let served = false;
    const w = world({
      holder: `board on ${PORT} pid 500 on mac`,
      keeper: () => KEPT,
      answering: async () => URL,
      serve: async () => void (served = true),
    });
    expect(await w.go("restart")).toBe(0);
    expect(w.calls).toEqual(["launchctl kickstart -k gui/501/ai.nextloom.lingtai.board"]);
    expect(served).toBe(false);
    expect(w.out.join("\n")).toContain(`the board answers on ${URL}`);
  });

  it("waits the seconds it says for an answer, though every ask costs its own timeout", async () => {
    // Something that accepts TCP and never replies holds the port: `answering`
    // burns its own five-second timeout every time. Counted in polls alone,
    // the asks a quarter-second apart were far longer than the sentence under
    // them promises.
    let clock = 0;
    let asks = 0;
    const w = world({
      holder: `board on ${PORT} pid 500 on mac`,
      keeper: () => KEPT,
      answering: async () => ((asks++, (clock += 5_000)), null),
      now: () => clock,
    });
    expect(await w.go("restart")).toBe(1);
    expect(asks).toBe(15);
    expect(clock).toBeLessThanOrEqual(80_000);
    expect(w.err.join("\n")).toContain("75s after the restart");
  });

  /**
   * And the seconds are `service`'s own (#187). A supervised `board restart` is
   * a `launchctl kickstart` of the job that runs `board start`, so what it is
   * waiting for is the Next standalone boot `service install` waits for — and
   * ten seconds of its own made a cold machine, or one with a `pnpm build`
   * running beside it, report failure and exit 1 for a board that bound two
   * seconds later.
   */
  it("gives the board the budget lingtai service gives the same boot, and not one of its own", async () => {
    const w = world({ holder: `board on ${PORT} pid 500 on mac`, keeper: () => KEPT });
    expect(await w.go("restart")).toBe(1);
    expect(w.err.join("\n")).toContain(`${BOARD_WAIT_MS / 1000}s after the restart`);
  });

  it("is stop then start where nothing keeps it", async () => {
    let served = 0;
    const w = world({ holder: `board on ${PORT} pid 500 on mac`, serve: async () => void served++ });
    expect(await w.go("restart")).toBe(0);
    expect(w.signalled).toEqual([500]);
    expect(served).toBe(1);
  });

  it("starts nothing when the stop failed, rather than a second board beside the first", async () => {
    let served = false;
    const w = world({
      holder: `board on ${PORT} pid 500 on someone-else`,
      serve: async () => void (served = true),
    });
    expect(await w.go("restart")).toBe(1);
    expect(served).toBe(false);
  });
});

describe("lingtai board status", () => {
  it("answers three questions and folds none of them into another", async () => {
    const w = world({ holder: `board on ${PORT} pid 500 on mac`, answering: async () => URL, keeper: () => KEPT });
    expect(await w.go("status")).toBe(0);
    const said = w.out.join("\n");
    expect(said).toContain(`serving     board on ${PORT} pid 500 on mac`);
    expect(said).toContain(`answering   answers on ${URL}`);
    expect(said).toContain("supervisor  launchd keeps it");
    expect(said).toContain(`port        ${PORT}, set in board.port`);
  });

  it("says a board nothing holds the lock for, and a lock that could not be read, apart", async () => {
    const w = world({ answering: async () => URL });
    expect(await w.go("status")).toBe(0);
    expect(w.out.join("\n")).toContain("serving     nobody");
    expect(w.out.join("\n")).toContain(`answering   answers on ${URL}`);

    const unread = world({
      locker: {
        tryLock: async () => ({ ok: false, holder: null }),
        holder: async () => {
          throw new Error("the lock needs node:sqlite");
        },
      },
    });
    expect(await unread.go("status")).toBe(0);
    expect(unread.out.join("\n")).toContain("serving     could not be read — the lock needs node:sqlite");
  });
});

describe("the board lock", () => {
  it("is named for the port, so two boards on two ports are not one lock", () => {
    expect(boardLock(17820)).toBe("board:17820");
    expect(boardLock(18080)).not.toBe(boardLock(17820));
  });

  it("is the key start takes and stop and status read — all three, the same port", async () => {
    const keys: string[] = [];
    const locker = {
      tryLock: async (key: string) => (keys.push(key), { ok: true as const, lock: { release: async () => {} } }),
      holder: async (key: string) => (keys.push(key), null),
    };
    const w = world({ locker });
    await w.go("start", { port: 18080 });
    await w.go("stop", { port: 18080 });
    await w.go("status", { port: 18080 });
    expect(keys).toEqual(["board:18080", "board:18080", "board:18080"]);
  });
});

/**
 * The port, asked for by something whose subject is not the board (#187).
 *
 * `lingtai service` builds a `ServiceOptions` for every verb it has, and
 * `lingtai restart` builds one to delegate through. A `board.port` read there
 * as `boardPort()` threw out of the literal, so `lingtai service shutdown
 * "moving the database"` never entered `serviceCommand`: nothing was drained,
 * nothing was unloaded, and the one thing said was about the board's port.
 */
describe("the board's port, where the board is not the subject", () => {
  function home(yaml: string): string {
    const dir = mkdtempSync(join(tmpdir(), "lingtai-port-"));
    dirs.push(dir);
    writeFileSync(join(dir, "config.yml"), yaml);
    return dir;
  }

  it("is the file's where the file names one, and the default where nothing does", () => {
    expect(boardPortOrWhy({ LINGTAI_HOME: home("board:\n  port: 18080\n") })).toEqual({ port: 18080 });
    expect(boardPortOrWhy({ LINGTAI_HOME: home("runtime:\n  agent: claude-code\n") })).toEqual({ port: 17820 });
  });

  it("is a reason and never a throw, so a typo in a UI setting does not hold up a drain", () => {
    const asked = boardPortOrWhy({ LINGTAI_HOME: home("board:\n  port: 8o80\n") });
    expect(asked).toEqual({ why: expect.stringContaining("is not a port number") });
    // And the reason does not read as though the default had been used, which
    // is what it would have to have been for the board to be anywhere at all.
    expect((asked as { why: string }).why).toContain("no port was read");
  });
});

describe("the lock holder's name", () => {
  it("carries the pid and the host, and nothing is read out of one that does not", () => {
    expect(holdingProcess("board on 17820 pid 500 on mac")).toEqual({ pid: 500, host: "mac" });
    expect(holdingProcess("a process waiting in line for it")).toBeNull();
  });
});
