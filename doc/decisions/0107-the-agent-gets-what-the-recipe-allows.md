# 0107 — The agent's environment: two files hold the values, the recipe decides what an agent sees, and nothing named `LINGTAI_` reaches it

**Status** accepted · 2026-10-01

An agent's environment is built from two files and nothing else: the machine's
own env file, with every `LINGTAI_*` name removed, and
`~/.lingtai/env/<project>.env` on top of it. The operator's shell is not part of
it. The recipe names variables and never holds their values. `env.allow` and
`env.deny` decide which values reach the agent. `env.required` is a check: if a
required name has no value, the whole project is refused before anything is
claimed. A `run:` extension gets only the names it declares. Every name Lingtai
reads for itself starts with `LINGTAI_`, so one prefix rule keeps Lingtai's own
credentials away from agents without a denylist. `@lingtai/agent-env` decides
all of this, and `lingtai env` writes the project file.

## Context

An agent and the commands a pass runs are subprocesses of the conductor, and the
conductor's environment holds Lingtai's own log URL and GitHub App key. A
project often needs its own values, such as a database URL for its tests, and
two projects can use the same variable name with different values. A run that
starts without a value it needs fails late and quietly. It claims the ticket and
pays for an agent that cannot finish. What an agent may see is the operator's
decision, made through the recipe. It is not a list built into Lingtai's source.

## Decision

1. **The values come from two files, and the project's file wins.**
   - The machine layer is the env file `@lingtai/env` loads at start
     (`.env.local`, then `.env`, at the root Lingtai runs from), as returned by
     `machineEnvFile()`. It is not `process.env`, so whatever is exported in the
     operator's terminal (`AWS_*`, npm tokens and so on) is never handed over.
     Empty values and every name starting with `LINGTAI_` are dropped from this
     layer.
   - The project layer is `~/.lingtai/env/<project>.env`
     (`projectEnvPath`, under `stateDir()`). It is merged on top of the machine
     layer, and the `LINGTAI_` strip does not apply to it. The operator writes it
     for one project, so a value there is a deliberate hand-over. For example,
     Lingtai's own recipe can be given `LINGTAI_TEST_DATABASE_URL` this way.

2. **The recipe names variables; `allow` and `deny` filter what reaches the
   agent.** If neither is set, everything in the merged files passes. With
   `allow` alone, only the names it lists pass. With `deny` alone, everything
   passes except what it lists. With both, the result is `allow` minus `deny`.
   This is `filterEnv` in `packages/agent-env/src/index.ts`.

3. **`env.required` is a check against the merged data, not a filter.** It is
   evaluated before `allow`/`deny` apply, so a name can be both required and
   denied: the machine must be configured with it, and this run does not need to
   see it. If a required name has no value in either file, the project is
   refused for that pass at stage `env`, before any work item is claimed and
   before any agent starts. The refusal names each missing variable and the
   `lingtai env set` command that fixes it. The environment belongs to the
   project, not the ticket, so it is refused once rather than once per ticket.

4. **What the agent receives is the filtered values plus `RUNNABLE`.**
   `runnableEnv` adds `PATH`, `HOME`, `TMPDIR`, `LANG`, `USER` and `LOGNAME`
   from the conductor's process, so binaries can be found, and a project's own
   value for any of these wins. The filtered values are passed in the agent
   process's environment. They are also written as a file at `env.plantAt`
   inside the worktree (mode `0600`, `renderEnvFile`, by
   `packages/repo/src/worktree.ts`), because frameworks read `.env.local` from
   an app directory. The runtime's hook wiring is added for the agent process
   itself (see [0106](0106-a-role-keeps-its-powers-across-runtimes.md)).

5. **An extension gets exactly the names it declares.** A `run:` plugin's
   `env:` list and a subscriber's `env:` list are read from the merged data
   (before `allow`/`deny`) by `extensionEnv`, plus `RUNNABLE`. An extension that
   declares nothing gets only `RUNNABLE`. It never receives the agent's
   environment. A declared name that starts with `LINGTAI_` is refused when the
   recipe resolves (`ExtensionEnvNames` in `packages/recipe/src/recipe.ts`).

6. **Every name Lingtai reads for itself starts with `LINGTAI_`.** `PREFIX` in
   `packages/env/src/index.ts`, with `TEST_` coming after the prefix:
   `LINGTAI_DATABASE_URL`, `LINGTAI_TEST_DATABASE_URL`,
   `LINGTAI_GITHUB_APP_ID`, `LINGTAI_HOME`, and so on.
   `packages/env/unit/prefix.test.ts` reads that file and holds the rule
   without exceptions. A project's own variables keep their own names, so
   `DATABASE_URL` in a project file is that project's application database and
   never Lingtai's. The prefix is what removes Lingtai's credentials from the
   machine layer (rule 1) and from extensions (rule 5). There is no list of
   reserved names to maintain.

7. **A value that looks like production is refused before the claim.** Any
   value that is a URL is checked segment by segment against `prod`,
   `production` and the recipe's `env.refuseHosts`. The recipe can only add to
   those two built-in patterns, never remove them (`productionPatterns`). The
   check runs against the host, and `refuseHosts` entries are also checked
   against the URL's username, because a pooled connection puts the project ref
   there. A hit throws `ProductionValueError`. This covers every value that
   reaches the agent and every extension's declared values, and the pass is
   refused at stage `env`.

8. **Names and layers are always visible; values never are.**
   `lingtai doctor` reports, per project, every declared name and which layer
   answered for it (`machine file`, `project file`, or `not set`) in
   `env: <project>`, and does the same for each extension in
   `env: <project> extensions`. `lingtai env list <project>` prints the same
   names and layers. A daemon started by a service manager may see a different
   machine file than a terminal does, so running `doctor` in the daemon's
   environment is how that difference shows up.

9. **`lingtai env` writes the project file one value at a time.**
   `lingtai env set <project> KEY=VALUE` writes or replaces one line.
   `lingtai env set <project> KEY` reads the value from stdin without echoing
   it, which keeps secrets out of shell history. `lingtai env unset <project> KEY`
   removes a line and exits non-zero if it was not there. The file is created
   `0600` in a `0700` directory, and names and project names are validated.
   There is no bulk import from an application's `.env`, because copying a
   whole file is how a production credential reaches an agent.

10. **The agent's environment and the machine's are separate packages.**
    `@lingtai/agent-env` holds what an agent and an extension receive:
    `resolveAgentEnv`, `filterEnv`, `extensionEnv`, `runnableEnv`, the
    production tripwire, the project file's reader and writer, and
    `renderEnvFile`. `@lingtai/env` holds the machine's own configuration: the
    connection strings, the GitHub App key, `stateDir()` and `PREFIX`.
    `@lingtai/repo` depends on `@lingtai/agent-env` to render the file it
    plants, never the other way round.

## Consequences

- The operator carries the risk of what an agent can see. The recipe is the
  control, and `doctor`'s names-and-layers report is how the operator checks
  it. The production tripwire is a backstop, not a guarantee. It only fires on
  hosts that the patterns or `refuseHosts` actually name.
- A machine-wide key is set once in the machine file, and one project can
  override it in its own file.
- A value exported only in a shell is invisible to agents. That is intended:
  values must be put in one of the two files.
- A project can never receive a `LINGTAI_*` value from the machine file. If it
  really needs one, it has to be written into that project's own file.

## Not built yet

- **A secret source.** A project-file value starting with `!` (for example
  `KEY=!op read op://…`) is reserved for fetching a secret on demand, and
  nothing fetches it. Such a line counts as no value: a required name that has
  only a `!` value refuses with a message saying the source is not built, and
  `lingtai env set` refuses to write a value starting with `!`.

---
*Replaces archived 0020, 0021, 0024 in [decisions-archive](../decisions-archive/).*
