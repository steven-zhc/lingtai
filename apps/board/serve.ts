/**
 * `pnpm --filter @lingtai/board dev|start`, on the port the rest of Lingtai
 * uses — `board.port` in `~/.lingtai/config.yml`, else `BOARD_PORT` (#187).
 *
 * **The number is not in `package.json`.** It held `next dev -p 3200`, and then
 * `-p 17820`, which is the wrong place twice over: somebody who installed
 * Lingtai has no `package.json` to edit, and this is the command four other
 * places send them to when there is no built board — `board start`'s refusal,
 * `lingtai service`'s `missing` remedy, `doc/operating.md` and
 * `doc/tutorial.md`, each saying it serves *the same port*. With the number
 * written here that sentence was false the moment anybody set `board.port`:
 * the board came up on 17820 while every card link, `lingtai board status` and
 * the service's board leg named the port they had asked for.
 *
 * A port that is not a port number is refused by name, as it is everywhere the
 * board is the subject: the sentence and not the stack, and nothing is served
 * on a number nobody chose.
 */
import { spawnSync } from "node:child_process";
import { boardPort } from "@lingtai/env";

let port: number;
try {
  port = boardPort();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const mode = process.argv[2] === "start" ? ["start"] : ["dev", "--turbopack"];
// `next` off the PATH pnpm gives a script — the same binary the literal
// command ran, invoked with the port this repository decides rather than one
// written in the file that invokes it.
const r = spawnSync("next", [...mode, "-p", String(port)], { stdio: "inherit" });
if (r.error) {
  console.error(r.error.message);
  process.exit(1);
}
process.exit(r.status ?? 1);
