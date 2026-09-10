#!/usr/bin/env node
/**
 * Lingtai's own notifications, as an extension.
 *
 * The first thing to cross the boundary
 * ([0037](../../../doc/decisions/0037-an-extension-is-a-command.md)), and the
 * only reason it is first: **a first-party extension on a privileged path
 * proves nothing.** This one needs no credentials, imports nothing of
 * Lingtai's, and is started as a command with JSON on stdin exactly as
 * somebody else's would be. If it works, the mechanism works.
 *
 * It reads one event and exits. Everything it used to be part of — which types
 * are worth interrupting somebody for, whether the daemon is up, what happens
 * when it fails — belongs to the recipe and the boundary now:
 *
 *   subscribers:
 *     - name: notify
 *       on: [ApprovalRequested, WorkItemBlocked, RunAwaitingInput, IntegrationRefused]
 *       run: node "$HOME/workspace/lingtai/extensions/notify/src/notify.ts"
 *
 * Exit 0 means delivered. Anything else is a `PluginFailed` on the log with the
 * tail of this text on it, which is the half of `#120` that made a notifier
 * that has silently stopped notifying visible at all.
 */
import { macNotifier } from "./channel.ts";
import { parsePayload } from "./payload.ts";
import { describe } from "./render.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const payload = parsePayload(await readStdin());
  const channel = await macNotifier();
  await channel.send(describe(payload));
}

await main().catch((err: unknown) => {
  // The core collects both streams into the tail it records, so this is on
  // stderr because that is where a message about a failure belongs, not
  // because one of them is read and the other is not. The non-zero exit is the
  // whole of the report either way.
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
