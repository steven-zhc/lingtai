# 0055 — Absence chooses the store, and it chooses nothing for the tests

**Status** accepted · 2026-09-19 · **builds on [0003](0003-postgres-event-store.md)**,
which is no longer the only store, and settles the `TEST_` pair's future for 1.0

## Context

`.env.example` asked for four database URLs, and a person who had just installed
Lingtai needed none of them: [0052](0052-the-lock-is-sqlite-on-a-file.md) took
the last lock out of Postgres, #176 collapsed the pooled/direct pair to one line,
and #178 landed a SQLite store and a polling waker that pass the contracts
Postgres passes (`packages/event-store/test/contract.ts`,
`test/wake-contract.ts`). What was left was the question of which one a machine
uses, and every way of asking it out loud — a flag, a prompt, a `store:` key in
`config.yml` — is a second setting that can disagree with the first.

The shape this repository already trusts is `gates.merge: []`: nothing is
declared there, so nothing holds, and there is no second switch saying whether
the declaration counts. The configuration **is** the decision.

There is one place that must not inherit it. `packages/env/src/index.ts`'s
`testUrl` refuses to run the suite without `LINGTAI_TEST_DATABASE_URL`, and its
reason is on the line: *the suite writes real events, and writing them to the
operator's own log leaves work items and board cards that only deleting from an
append-only table can remove.* Since #158 the half that needs a database is the
half whose subject **is** Postgres — the projections, `LISTEN`/`NOTIFY`, two
clients racing — so a fallback there would leave `pnpm test:db` green while
asserting none of it.

## Decision

**1. A Postgres URL selects Postgres; nothing at all selects SQLite, in
`~/.lingtai/lingtai.db`.** One function, `storeChoice()` in `@lingtai/env`, and
`databaseUrl()` is written in terms of it so the sources and their order cannot
drift apart. `@lingtai/event-store`'s `eventStore` singleton is what the choice
opens, so it is the choice and not a description of one.

**2. Absence is *nothing at all* naming a connection.** A machine with only
`LINGTAI_DIRECT_DATABASE_URL` set is a Postgres machine missing a line, not a
machine that chose SQLite, and it is refused by name as it was before any of
this existed. Choosing SQLite there would start an empty log beside a database
somebody plainly configured.

**The pre-#63 name counts as naming one too.** An unprefixed `DATABASE_URL` and
no `LINGTAI_DATABASE_URL` is either an install older than the rename or the
mistake `renamedFrom` exists for — every provider's dashboard calls the variable
`DATABASE_URL` — so `storeChoice()` refuses there as well, with the one line
that names the fault and its one-word repair. Reporting a *deliberate choice of
SQLite* to somebody who made no choice is the failure this rule is against, and
it is the same failure in both halves of it.

**3. It chooses nothing for the tests.** Under `VITEST` or `LINGTAI_TEST`,
`storeChoice()` asks `testUrl` and that refusal stands unchanged.
`packages/env/test/env.test.ts` asserts it — including that the operator's own
`LINGTAI_DATABASE_URL` does not rescue it — so a later simplification that
reaches into the `TEST_` names fails a test rather than passing quietly.

**4. `LINGTAI_TEST_DATABASE_URL` survives 1.0. `LINGTAI_TEST_DIRECT_DATABASE_URL`
does not.** doc/design/1.0.md said *the test/production split goes too, because
the suite that needed its own database is the one that can now run on SQLite*.
That is true of the half that only needed somewhere to **record** events — which
is `pnpm test`, already on `createMemoryEventStore()` — and false of `pnpm
test:db`, which asserts Postgres itself and cannot be given a file instead. So
one name stays, required and refusing; the direct one goes, because #176's
fallback within the pair already makes it optional and #157 forbids the pooled
string it exists for. `.env.example` ships it commented out.

**5. `lingtai doctor` says which store is in use and where, in one row near the
top — and that row is red for SQLite until #175.** An unset
`LINGTAI_DATABASE_URL` used to mean a machine nobody had configured and now
means a machine that chose SQLite; nothing outside can tell those apart, so the
report says it rather than leaving it to be inferred from a variable nobody set.

The row would like to be a statement rather than a verdict — either store is a
legitimate answer, and what the rows below judge is whether the chosen one
works. It cannot be one yet — nor on either machine of §2, which chose neither:
`LINGTAI_DIRECT_DATABASE_URL` alone, and a `DATABASE_URL` under the pre-#63
name, are machines with *no* store, since `storeChoice` refuses every caller on
both, and the row that answers which store is in use fails rather than
reporting a Postgres one it cannot open — naming, in the second case, the
rename, which is the one repair that machine needs. A SQLite machine is a machine on which *no command
that appends runs at all* (see the first consequence), so a `store` row that
said `ok`, or even `warn`, would make the command that answers **is the system
doing what the code says** answer yes about a machine where nothing does. It
would also pass `lingtai restart`'s doctor gate, where a note is expressly not a
failure (0042 §4), and start a daemon that cannot open a log. So: `fail`, with
the way out in the detail, until #175 ports the projections and the waker — at
which point the row becomes `ok` and nothing else changes.

**6. An empty answer at `lingtai init` removes a `database.url` already in
`config.yml`.** It is the only deletion `init` makes, and it follows from §1:
absence is read back out of that same file, so a URL left standing there would
go on selecting Postgres on a machine init had just told the operator was on
SQLite — and `doctor`'s store row would then say the opposite of what init said.
The removed URL is named, redacted, in the line that reports the choice, because
silently dropping the operator's database out of their configuration is the one
thing worse than leaving it. Nothing is converted and the Postgres it named is
untouched; it is a new log, as §"No migration" has it.

**7. That answer also ends the run.** `init`'s remaining steps finish by serving
the board in its own process and opening it on `/setup/github-app`, and
rendering that page appends `GitHubAppCreated` through the event store — so an
`init` that went on would be the command that *created* `~/.lingtai/lingtai.db`
and put the machine's App in it, on the machine where every other appending
command has just been made to refuse. `entry.ts` answers these five commands
because each must run where there is no log; being the thing that makes one is
the same fault seen from the other side. The choice is kept — it is absence, so
there is nothing to keep — and the agent, the App and the board belong to the
next `lingtai init`, which is the one that names a Postgres URL.

## Consequences

- **The Postgres client is built on first use, not at import.**
  `export const db = createDb()` read `databaseUrl()` while the module loaded,
  which was a reasonable side effect while a machine without a URL was a broken
  machine. `postgresDb()` replaces it; `eventStore` is likewise opened on first
  use, so a bare `lingtai --version` neither builds a pool nor creates a file.
- **A SQLite machine is not yet a whole system, and is not a working one.** The
  projections and the `LISTEN`/`NOTIFY` waker still read `databaseUrl()`
  directly and refuse by name there, and the board's `task_view` reads are
  Postgres, so on a machine that names nothing, `lingtai approve`, `run` and the
  board all die — `createProjectionRunner` throws before the command has done
  anything. Porting them is the rest of #175. Until then this is stated where a
  person meets it rather than only here: the `store` row fails (§5),
  `README.md`, `.env.example` and `doc/operating.md` each say *name a Postgres
  URL today*, and `doctor` skips the Postgres block with a row that says the
  checks are implemented and were not run.
- **Two commands hold no projector, and are refused in its place**
  (`apps/cli/src/store.ts`). `lingtai add` and the four control verbs —
  `pause`, `resume`, `shutdown`, `now` — reach `eventStore` without one, the
  second deliberately (a pause must not replay a backlog before it pauses
  anything), so on a SQLite machine they did not die: they *succeeded*, writing
  `ProjectConfigured` at seq 1 into a log the board cannot read and the same
  command's own advice then tells the operator to leave behind. A refusal every
  document already promised is worth nothing until the two commands that could
  disprove it make it true, so they ask for it by name before they append.
  **`lingtai board` is the third**, and by §7's argument rather than this one:
  it does not append, it *serves the page that does* — the App wizard, in this
  process — so the guard `init` got is the same guard the other door to that
  screen needs. That file is deleted by #175 and nothing else changes with it.
- **No migration between the stores**, as doc/design/1.0.md has it: switching
  starts a new log and picks up new tickets. Nothing converts one to the other
  and no tool is built.
- **This repository stays on Postgres**, and by configuration rather than by
  exception: its own log is cited by ADRs and tickets, so it names a URL and is
  therefore Postgres — the same rule everybody else gets.
