# 0125 — Setup is one module, and the terminal and the board are two inputs to it

**Status** accepted · 2026-11-07

Setting up a project — detect what a repository is, propose a recipe, write it,
register the project — is one module, `@lingtai/setup`. `lingtai add` and the
board's wizard are two inputs to it: each gathers answers and hands them over,
and neither carries a question, a detection or a recipe writer of its own.
Changing a project that already exists is running setup again, `lingtai add` or
`lingtai init`: the same questions, with the recipe's own values as their
defaults.

## Context

Setup's pieces are spread across packages, and nothing names them as one thing:

- detection is `apps/cli/src/detect-setup.ts:1-4`;
- the repository picker and the *already added* answer are
  `packages/conductor/src/pick-repository.ts` (`alreadyOnboarded`, line 235);
- registering a project is `packages/conductor/src/onboard.ts`;
- a page model for the wizard is `packages/conductor/src/wizard-page.ts`, which no
  page uses;
- the board's `/setup/repository` renders `apps/board/src/app/setup/terminal.tsx`,
  which only points at the terminal.

The recipe lives at `~/.lingtai/<project>/recipe.yml` and nothing is committed to
the repository ([0104](0104-the-recipe-is-the-pipeline.md) §1).

## Decision

1. **Setup is one module, `@lingtai/setup`.** Detect, propose, write the recipe,
   register. Every setup question, default and check is in it once.

2. **Two inputs, no copy.** `lingtai add` and the board's wizard are two inputs to
   that module. An input gathers answers and shows the module's result; it
   neither asks a question the other does not, nor detects, nor writes a recipe.

3. **The terminal input keeps [0121](0121-the-cli-output-and-input-contract.md)
   §9.** *"A prompt never appears without a TTY: every question has a flag, and
   when there is no terminal and no flag the command refuses by name, saying
   which flag would answer it. Under `--json` there are no prompts at all."* The
   board asks the same questions as form fields; that adds an input and replaces
   none.

4. **A repository comes from GitHub or from a local directory.**
   - The GitHub list is the App's installations or the `gh` login's pushable
     repositories ([0114](0114-a-github-app-not-a-token.md)), plus
     an `owner/repo` typed into the filter.
   - A local directory is an absolute path; the server checks that it is a git
     repository and reads its remote.
   - A local directory's tickets are the issues of its GitHub remote when
     `origin` is on GitHub, and are local tickets otherwise.

5. **The module proposes the same on both inputs.**
   - The default kinds are `bug`, `feature`, `tech-debt`, `documentation`.
   - Kinds are a filter: nothing creates labels, and a missing label is not a
     warning.
   - `proposed:` holds one `judge:` for `findings` naming the writer (#1448), and no hold unless a person asks for one; it is empty when the writer cannot judge (`copilot`, `antigravity`) or nobody is signed in. An existing recipe is never rewritten.
   - *Already added* is `registered`, `pending` or `unrecorded`, as
     `alreadyOnboarded` answers.
   - Detected values are defaults the person may override
     ([0103](0103-a-pass-is-ten-fixed-steps.md)).

6. **Changing a project is running setup again.** `lingtai add` and `lingtai
   init` share one path for a project. `add` runs it; `init` first asks the
   machine's own questions (the database, how this machine reaches GitHub, the
   sandbox token) and then runs the same path, for a local directory or an
   `owner/repo`. The first run of that path on a project adds it; a later run, by
   either command, asks every question the first run asks, in the same order and
   in the same way. Only the defaults differ: the first run offers the system's, a
   later run offers what the recipe says. `lingtai add` on a project already added
   is therefore not refused: it is that later run (decided 2026-11-26).
   - An answer that differs is written, through `@lingtai/project`'s
     `changeRecipe`, which appends the change on `prj-{project}` and then writes
     the file ([0128](0128-the-project-aggregate-holds-every-project-fact.md) §6).
     An answer that does not differ writes nothing, so a run that takes every
     default changes neither the file nor the log, however often it runs.
   - A recipe that cannot be read is refused by name, never replaced by the
     system's defaults.
   - A change that leaves something behind is written, and then said with what
     the person has to do. Team to solo is refused by name while a ticket has landed on the
     personal branch and not reached `main`, or a PR is open
     ([0130](0130-a-project-is-solo-or-team.md) §1); once neither holds it is written.
     Solo to team leaves nothing. Another working branch that does not exist yet
     is cut from the old one, so nothing that has not reached `main` is lost; one
     that exists is left as it is, and the commits only the old one has are listed.
     Another database is a new, empty log
     ([0100](0100-one-append-only-log.md) §9);
     nothing is copied across.
   - Lingtai moves, merges and deletes no branch or commit of the person's to make
     a change fit.
   - Editing the YAML by hand stays possible. Either way, saving resolves the recipe
     and writes nothing that fails to resolve — the check `lingtai add`, `lingtai
     doctor` and the daemon already share
     ([0104](0104-the-recipe-is-the-pipeline.md) §11).

7. **The trial build is the terminal's alone.** It is in `lingtai add` and is not
   offered on the board. It runs after the module has finished and is not a setup
   question, so it is the one difference between the inputs and not a copy.

8. **`init` and `add` ask a project the same questions in the same order.** Where
   the code is, solo or team, the working or personal branch, *use every
   default?*, the recipe's questions, *register?*. `init` asks only this machine's
   own questions before them. *Use every default?* answers only what comes after
   it; the mode and the branch take their defaults only under `--defaults`, and the
   card names them. *Use every default?* is shown as the list of what it would
   decide, each with its value, then *use this setup?* (§9).

9. **Setup is two ordered lists of questions: the machine's and the project's**
   (decided 2026-11-27).
   - **The machine list**: the store, how this machine reaches GitHub, the daily
     spend ceiling, the sandboxed Claude Code token. **The project list**: where
     the code is, solo or team, the working or personal branch, then the writer
     and its model, the reviewer and its model, the sandbox and its hosts, the
     install command, the checks, the trial build, the ticket source and kinds,
     the landing, the limits.
   - `lingtai init` asks the machine list and then the project list; `lingtai add`
     asks the project list. No question is asked outside these two lists, and no
     command keeps a copy of one.
   - **Every question has one default**: the value in force now — `config.yml` or
     the recipe, the environment winning where it overrides
     ([0117](0117-configuration-is-config-yml-and-the-environment.md)) — and the
     system's default where nothing is in force. A first run and a later run are
     the same code; only where the defaults come from differs.
   - An answer equal to the value in force writes nothing; another answer is
     written (§6). Taking the system's default for a key that was never written
     writes it.
   - What is written for the person but never asked (the findings judge, #1448)
     is added on a new recipe and follows the writer when the writer changes;
     a recipe whose judge was removed by hand keeps it removed while the writer
     stays (decided 2026-11-27). It is never reported as a question the person
     skipped.
   - Each list is written once, when it is answered to its end: a Ctrl+C inside
     a list leaves what that list writes as it was (decided 2026-11-27,
     replacing #392's keep-what-was-answered; a rerun's defaults are the values
     in force, so running again and pressing Enter returns to the same place).
     The machine list is answered before the project list, so a Ctrl+C in the
     project list keeps the machine answers already written (`github.auth`
     included) and writes no recipe, makes no branch and registers nothing.
   - The list shown before *use this setup?* and the card at the end are built
     from the same lists; on a later run the card shows old → new for each value
     that changed.

## Consequences

- A change to what setup proposes is one edit, and both inputs show it.
- A test of setup is a test of the module; an input's test is that it passes
  answers through.
- The board's setup page grows a form where it now points at the terminal.

## Not built yet

- `@lingtai/setup` does not exist; the pieces above are where they are today.
- `/setup/repository` still renders `terminal.tsx`.

---

_New topic; replaces no archived ADR. The design discussion is #964._
