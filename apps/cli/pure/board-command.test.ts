/**
 * `lingtai board start|stop|restart|status` (#187), with no port bound, no
 * process signalled and no supervisor asked: the world is a script, and what
 * these pin is what the command says and whom it stops.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BOARD_PORT, RESERVED_PORT, boardPort, type PortAnswer } from "../src/board.ts";
import { boardCommand, boardPidFile, type BoardJob, type BoardWorld } from "../src/board-command.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lingtai-board-command-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function world(script: { answers?: PortAnswer; job?: BoardJob; boards?: number[]; interactive?: boolean; supervised?: number } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const seen = { served: [] as number[], opened: [] as string[], signalled: [] as number[], supervisor: [] as string[], exits: [] as (() => void)[] };
  const live = new Set(script.boards ?? []);
  const w: BoardWorld = {
    env: { LINGTAI_HOME: home },
    log: (l) => out.push(l),
    error: (l) => err.push(l),
    answers: async () => script.answers ?? "nothing",
    serve: async (port) => void seen.served.push(port),
    open: async (url) => (seen.opened.push(url), true),
    interactive: script.interactive ?? true,
    pid: 4242,
    isBoard: (pid) => live.has(pid),
    signal: (pid) => (seen.signalled.push(pid), live.delete(pid)),
    onExit: (fn) => seen.exits.push(fn),
    job: () => script.job ?? { installed: false },
    supervisorStop: async () => (seen.supervisor.push("stop"), script.supervised !== undefined && live.delete(script.supervised), true),
    supervisorStart: async () => (seen.supervisor.push("start"), true),
    sleep: async () => {},
  };
  return { w, out, err, seen };
}

// Colour codes are the terminal's; the words are what is pinned.
const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

describe("the port", () => {
  it("is 17820 with no config.yml at all, and 17821 is reserved and bound by nothing", () => {
    expect(boardPort({ LINGTAI_HOME: home })).toEqual({ port: 17820, from: "the default" });
    expect(BOARD_PORT).toBe(17820);
    expect(RESERVED_PORT).toBe(17821);
    // Nothing that runs names the reserved port but the line that reserves it.
    const src = join(import.meta.dirname, "..", "src");
    const naming = readdirSync(src).filter((f) => /RESERVED_PORT|17821/.test(readFileSync(join(src, f), "utf8")));
    expect(naming).toEqual(["board.ts"]);
  });

  it("comes from board.port in config.yml, and --port over that — never from the board's package.json", () => {
    writeFileSync(join(home, "config.yml"), "database:\n  url: postgres://x\nboard:\n  port: 18000\n");
    expect(boardPort({ LINGTAI_HOME: home })).toEqual({ port: 18000, from: `board.port in ${join(home, "config.yml")}` });
    expect(boardPort({ LINGTAI_HOME: home }, "19000")).toEqual({ port: 19000, from: "--port" });
    const pkg = readFileSync(join(import.meta.dirname, "..", "..", "board", "package.json"), "utf8");
    expect(pkg).not.toMatch(/-p \d+|--port/);
  });

  it("refuses a board.port that is not a port by name, rather than reading it as the default", () => {
    writeFileSync(join(home, "config.yml"), "board:\n  port: lots\n");
    expect(boardPort({ LINGTAI_HOME: home })).toEqual({ refused: `board.port in ${join(home, "config.yml")} is "lots", which is not a port number` });
  });
});

describe("board start", () => {
  it("serves, prints the URL, opens a browser, and records which process it is", async () => {
    const { w, out, seen } = world();
    expect(await boardCommand(["start"], w)).toBe(0);
    expect(seen.served).toEqual([17820]);
    expect(seen.opened).toEqual(["http://127.0.0.1:17820"]);
    expect(plain(out)).toContain("board on http://127.0.0.1:17820");
    expect(plain(out)).toContain("ctrl-c stops it");
    expect(JSON.parse(readFileSync(boardPidFile(w.env), "utf8"))).toEqual({ pid: 4242, port: 17820 });
    seen.exits.forEach((fn) => fn());
    expect(existsSync(boardPidFile(w.env))).toBe(false);
  });

  it("opens nothing under --no-open, or with nobody at a terminal — a supervisor's start", async () => {
    const a = world();
    await boardCommand(["start", "--no-open"], a.w);
    expect(a.seen.opened).toEqual([]);
    const b = world({ interactive: false });
    await boardCommand(["start"], b.w);
    expect(b.seen.opened).toEqual([]);
  });

  it("says a board is already on the port in words, and where the port is set — not a bare EADDRINUSE", async () => {
    const { w, err, seen } = world({ answers: "board" });
    expect(await boardCommand(["start"], w)).toBe(1);
    expect(seen.served).toEqual([]);
    const said = plain(err);
    expect(said).toContain("a board is already on 17820 — http://127.0.0.1:17820");
    expect(said).toContain(`set board.port in ${join(home, "config.yml")}, or pass --port`);
    expect(said).not.toContain("EADDRINUSE");
  });

  it("says a port something else holds is not a board", async () => {
    const { w, err } = world({ answers: "other" });
    expect(await boardCommand(["start"], w)).toBe(1);
    expect(plain(err)).toContain("17820 is held by something that is not a Lingtai board");
  });

  it("points the old bare form at start", async () => {
    const { w, err } = world();
    expect(await boardCommand(["--port", "3200"], w)).toBe(2);
    expect(plain(err)).toContain("lingtai board start serves it");
  });
});

describe("board stop", () => {
  it("asks the supervisor when it keeps the board — a signal would be undone by KeepAlive", async () => {
    const { w, seen } = world({ job: { installed: true, loaded: true, running: true, lines: [], name: "ai.nextloom.lingtai.board" }, boards: [77], supervised: 77 });
    mkdirSync(home, { recursive: true });
    writeFileSync(boardPidFile(w.env), JSON.stringify({ pid: 77, port: 17820 }));
    expect(await boardCommand(["stop"], w)).toBe(0);
    expect(seen.supervisor).toEqual(["stop"]);
    expect(seen.signalled).toEqual([]);
  });

  it("stops a terminal's board that holds the port while the supervisor's waits out its throttle — not only the supervisor's", async () => {
    const job: BoardJob = { installed: true, loaded: true, running: false, lines: [], name: "ai.nextloom.lingtai.board" };
    const { w, seen } = world({ job, boards: [99] });
    writeFileSync(boardPidFile(w.env), JSON.stringify({ pid: 99, port: 17820 }));
    expect(await boardCommand(["stop"], w)).toBe(0);
    expect(seen.supervisor).toEqual(["stop"]);
    expect(seen.signalled).toEqual([99]);
  });

  it("does not say stopped when the supervisor let go and a board it cannot name still answers", async () => {
    const job: BoardJob = { installed: true, loaded: true, running: false, lines: [], name: "ai.nextloom.lingtai.board" };
    const { w, err, out } = world({ job, answers: "board" });
    expect(await boardCommand(["stop"], w)).toBe(1);
    expect(plain(err)).toContain("a board still answers on http://127.0.0.1:17820");
    expect(plain(out)).not.toMatch(/^stopped/m);
  });

  it("signals the process board start recorded, and nothing a reused pid now names", async () => {
    const a = world({ boards: [77] });
    writeFileSync(boardPidFile(a.w.env), JSON.stringify({ pid: 77, port: 17820 }));
    expect(await boardCommand(["stop"], a.w)).toBe(0);
    expect(a.seen.signalled).toEqual([77]);
    expect(existsSync(boardPidFile(a.w.env))).toBe(false);

    const b = world({ boards: [] });
    writeFileSync(boardPidFile(b.w.env), JSON.stringify({ pid: 78, port: 17820 }));
    expect(await boardCommand(["stop"], b.w)).toBe(0);
    expect(b.seen.signalled).toEqual([]);
    expect(plain(b.out)).toContain("no board is running on 17820");
  });

  it("does not claim to have stopped a board it cannot name", async () => {
    const { w, err, seen } = world({ answers: "board" });
    expect(await boardCommand(["stop"], w)).toBe(1);
    expect(seen.signalled).toEqual([]);
    expect(plain(err)).toContain("nothing was stopped");
  });
});

describe("board restart and status", () => {
  it("restart is stop then start, and checks nothing else", async () => {
    const { w, seen } = world({ boards: [77] });
    writeFileSync(boardPidFile(w.env), JSON.stringify({ pid: 77, port: 17820 }));
    expect(await boardCommand(["restart", "--no-open"], w)).toBe(0);
    expect(seen.signalled).toEqual([77]);
    expect(seen.served).toEqual([17820]);
  });

  it("status says the port and where it came from, what answers, and who keeps it", async () => {
    const { w, out } = world({ answers: "board", job: { installed: true, loaded: true, running: true, lines: ["state = running"], name: "ai.nextloom.lingtai.board" } });
    expect(await boardCommand(["status"], w)).toBe(0);
    const said = plain(out);
    expect(said).toContain("port        17820 — the default");
    expect(said).toContain("answering   http://127.0.0.1:17820 is a Lingtai board");
    expect(said).toContain("supervisor  ai.nextloom.lingtai.board");
    expect(said).toContain("  state = running");
  });
});
