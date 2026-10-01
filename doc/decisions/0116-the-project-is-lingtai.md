# 0116 — The name: the project, its commands and every name it owns are Lingtai

**Status** accepted · 2026-10-01

The system is called **Lingtai** (灵台), and every identifier it owns carries that
name: the package scope, the commands, the environment variables, the labels,
the state directory and the database objects. The one other name in the code,
`escapement`, is a retired name kept only so that old database objects can be
found and dropped. Seeing it anywhere else is a bug.

## Context

A name in this system is not only text. Several identifiers have a counterpart
elsewhere that must match exactly, and a mismatch fails silently: a `NOTIFY`
channel the trigger writes to and the listener does not hear leaves appends
working and the loop never waking. So the name is fixed in one form everywhere,
and the places that must agree are listed.

## Decision

1. **Lingtai, everywhere it is a name.** The repository is
   `steven-zhc/lingtai`, the root package is `lingtai`, and workspace packages
   are `@lingtai/*`.

2. **The commands.** The CLI is `lingtai` (`apps/cli`, entry `src/entry.ts`);
   the runtime hook binary is `lingtai-hook` (`packages/hook`).

3. **Every environment name Lingtai reads for itself begins `LINGTAI_`.** This
   includes the test pair (`LINGTAI_TEST_DATABASE_URL`, with `TEST_` after the
   prefix) so the rule has no exceptions; `packages/env/unit/prefix.test.ts`
   checks it. A managed project's own environment file keeps its own names.

4. **The state directory is `~/.lingtai`**, overridable with `$LINGTAI_HOME`. It
   holds `config.yml`, each project's `recipe.yml`, the SQLite log, locks, run
   logs and worktrees.

5. **GitHub labels Lingtai writes use the `lingtai:` prefix** — for example
   `lingtai:queued`, `lingtai:working`, `lingtai:waiting`. Labels a person sets
   to steer the queue (`agent:hold`, the kind labels) are the person's.

6. **Database objects on Postgres are `lingtai_*`, and the channel is
   `lingtai`.** The trigger `lingtai_events_notify` (function
   `lingtai_notify_event()`) notifies channel `lingtai`, which is the `CHANNEL`
   the waker listens on (`packages/event-store/src/wake.ts`); the append-only
   rules are `lingtai_events_no_update` and `lingtai_events_no_delete`. The
   trigger and the listener must name the same channel.

7. **`escapement` is retired and lives in one place.** `NOTIFY_SQL` in
   `packages/event-store/src/schema.ts` ends by dropping
   `escapement_events_notify`, `escapement_notify_event()` and the two
   `escapement_*` rules, after the `lingtai_*` replacements exist so the table is
   never without its no-delete rule. Those drop statements are the only place
   the retired name belongs in code.

8. **A name changes nothing in the log.** Stream ids (`wi-`, `run-`, `prj-`,
   `int-`, `ctl-`, `chat-`) and event types do not carry the product name, so a
   rename never requires a reset or an upcaster.

## Consequences

- Any future rename has to move the channel, the trigger, function and rules,
  the state directory, the label prefix and the environment prefix together,
  and drop the old database objects by their old names.
- A helper that merely spells something similar (an `esc` quoting function, for
  instance) is not the product name and is left alone; a rename is done by
  reading, not by substitution.

---
*Replaces archived 0017 in [decisions-archive](../decisions-archive/).*
