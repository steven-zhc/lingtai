# Extensions

An extension is a command, and the only question is whether the core waits for
it ([0037](../doc/decisions/0037-an-extension-is-a-command.md)). There is no
registry, no manifest and no loader: a gate action is a `run:` whose exit code is
a verdict, and a subscriber is a `run:` whose exit code is discarded.

These two are subscribers. They are here rather than in `packages/` because
**nothing in the core imports them** — that is the point of them. They read JSON
on stdin, do one thing, and exit; a `pnpm-workspace` entry buys them a
`typecheck` and a `test` and nothing else. Neither imports `@lingtai/*`, so
neither can reach the log, the projections or the daemon's credentials, and both
restate the payload shape themselves the way somebody outside this repository
would have to.

| | what it does | needs |
|---|---|---|
| [`notify`](notify) | a macOS notification, clickable through to the board | nothing |
| [`telegram`](telegram) | a Telegram message | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |

## Declaring one

In the managed repository's `.lingtai/config.yaml`:

```yaml
subscribers:
  - name: notify
    on: [ApprovalRequested, WorkItemBlocked, RunAwaitingInput, IntegrationRefused]
    run: node "$HOME/workspace/lingtai/extensions/notify/src/notify.ts"
```

`on:` **is** the subscription — declaring an event type is subscribing to it,
and a type nothing declares is a process that is never started. The names are
checked against the log's own vocabulary when the recipe is read, so a
misspelling refuses the recipe rather than becoming a subscriber that never
fires.

## What one is given

**On stdin, one JSON object, then EOF.** A command that does not read it ignores
it, which is why every `run:` that works today still works:

```json
{
  "schema": 1,
  "event": { "seq": "4231", "streamId": "wi-lingtai-126", "type": "WorkItemLanded",
             "version": 7, "schemaVer": 1, "actor": "conductor",
             "causation": null, "at": "2026-09-10T09:12:44.000Z", "data": { } },
  "project": "lingtai",
  "ticket": { "project": "lingtai", "issue": "126", "stream": "wi-lingtai-126" },
  "board": { "url": "http://localhost:3200", "task": "http://localhost:3200/task/wi-lingtai-126" }
}
```

**In the environment, the names it declared and nothing else.** `env:` on the
subscriber lists them; they resolve from the same two files the agent's do — the
machine's, minus everything of Lingtai's own, then `~/.lingtai/env/<project>.env`
over it — plus `PATH`, `HOME` and the four other variables a process needs to be
a process. The daemon's own environment is not inherited, so
`LINGTAI_DATABASE_URL` is not reachable from here; the recipe schema refuses a
`LINGTAI_` name outright as well.

A declared name neither file supplies is a failure *before* the command starts,
recorded like any other.

## What it may say back

**Its exit code, and nothing else.** Zero is *nothing to report*. Anything else,
including a timeout or a command that could not be started at all, appends
`PluginFailed` to the log with the tail of what it printed, and `lingtai doctor`
reads those back under `subscribers: failures`. Nothing is retried: a subscriber
exists for effects that are worthless late.

stdout is not a channel. It is the failure output of every ordinary `run:`
command and stays that.
