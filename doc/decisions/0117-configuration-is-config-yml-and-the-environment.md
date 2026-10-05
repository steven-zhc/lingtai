# 0117 — Configuration: `~/.lingtai/config.yml` and the exported environment, the environment overriding, and no env file

**Status** accepted · 2026-10-05

Everything Lingtai reads about the machine it runs on comes from two sources:
`~/.lingtai/config.yml`, and the variables exported into the process. A
variable overrides the key of the same name. There is no third source: a
checkout's `.env.local` is not read, whatever it says. Both sources are read
through Effect's `Config` in `@lingtai/env`, and their names map onto each
other mechanically.

## Context

Four processes — the CLI, the daemon, the board and a service-managed daemon —
have to agree about one machine, and they start from different directories,
from a checkout or from a bundled binary. A configuration file found relative
to the source or to the working directory is seen by some of them and not
others, and none can tell which. A value with more than one source per name
also lets the GitHub App's id come from one place and its key or webhook
secret from another, which is a pair nobody configured.

## Decision

1. **Two sources.** `machineFile(from)` reads `config.yml` under `stateDir()`;
   `environmentProvider(from)` turns the environment handed in into a
   `ConfigProvider`. A `Config` is asked of the environment first and of the
   file second. An empty value is no value in either.

2. **One name for each thing.** A key's variable is its path in constant case
   under `LINGTAI_`: `github.app_id` is `LINGTAI_GITHUB_APP_ID`,
   `database.url` is `LINGTAI_DATABASE_URL`, `board.port` is
   `LINGTAI_BOARD_PORT`. `config.example.yml` at the repository root lists the
   keys, and `packages/env/unit/prefix.test.ts` holds the App's against it. A
   few names exist only as variables — `LINGTAI_DIRECT_DATABASE_URL`,
   `LINGTAI_HOME`, the `LINGTAI_TEST_*` names — because nothing on the machine
   should hold them.

3. **The file is read per call; a variable is read at start.** What the board's
   setup page or `lingtai init` writes into `config.yml` is seen by the next
   call in every running process. A variable is the environment the process
   was started with, so changing one is a restart, the rule a running daemon
   already follows for its code.

4. **The GitHub App is elected as a whole.** Whichever source names `app_id`
   answers for the key and the webhook secret too, and a name it does not carry
   is absent rather than borrowed from the other (`electGithubApp`, pinned by
   `packages/env/unit/github-app.test.ts`). An id from one source beside a key
   or secret from the other is a pair nobody configured. A relative
   `app_private_key_path` in the file resolves against `stateDir()`, never the
   checkout, which bundled is under `versions/`.

5. **The store is the one other exception, and 0100 says how.** An exported
   `LINGTAI_DATABASE_URL` selects Postgres for that process and supplies the
   URL; otherwise `database.store` decides
   ([0100](0100-one-append-only-log.md) §7).

6. **A file that cannot be read is named, never read as absent.** One that
   will not parse, or exists and cannot be opened, is `unreadable` with its
   path and reason. A missing file, or a path through something that is not a
   directory, is an empty one. A caller that only reports (`logConfigured`,
   `hasGitHubApp`, `lingtai doctor`) stays total; a caller about to connect or
   sign names the file.

7. **Which file a given environment reads.** One naming its own
   `LINGTAI_HOME` reads that home's file, which is how `lingtai doctor` and a
   test are pointed somewhere. Otherwise **a test reads no machine's file** —
   not this process's under vitest, and not one a test hands in — because the
   operator's file is the operator's log and App. Anything else reads
   `stateDir()`'s, including a copy of `process.env`, so `doctor`'s copied
   environment reaches the real file.

8. **An agent receives none of it.** An agent's environment is its project's
   own file ([0107](0107-the-agent-gets-what-the-recipe-allows.md)); there is no
   machine-wide layer to hand over.

## Consequences

- Every process on a machine agrees about its configuration, whichever
  directory it started in, checkout or binary.
- `config.yml` carries a database password and a webhook secret. The setup
  page creates it `0600`; an existing file's mode is the operator's.
- `LINGTAI_TEST_DATABASE_URL` has to be exported into the shell that runs the
  Postgres half of the suite, since there is no file for it to come from. Where
  it is not, the files on `ON_POSTGRES` are skipped, visibly.
- Something written into a checkout's `.env.local` does nothing, and nothing
  says so. A machine moving onto this has to copy its App into `config.yml`
  first, or it loses GitHub the moment the new code runs.
