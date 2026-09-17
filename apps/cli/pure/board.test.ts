import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boardEntry, serveBoard } from "../src/board.ts";

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
