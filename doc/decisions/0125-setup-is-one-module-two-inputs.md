# 0125 — Setup is one module, and the terminal and the board are two inputs to it

**Status** accepted · 2026-11-07

Setting up a project — detect what a repository is, propose a recipe, write it,
register the project — is one module, `@lingtai/setup`. `lingtai add` and the
board's wizard are two inputs to it: each gathers answers and hands them over,
and neither carries a question, a detection or a recipe writer of its own.
Changing a project that already exists is not a wizard; it is editing its recipe
YAML, which is checked by resolving it.

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
   - `proposed:` is `[]` by default.
   - *Already added* is `registered`, `pending` or `unrecorded`, as
     `alreadyOnboarded` answers.
   - Detected values are defaults the person may override
     ([0103](0103-a-pass-is-ten-fixed-steps.md)).

6. **There is no edit wizard.** Changing an existing project is editing its recipe
   YAML. Saving resolves the recipe and writes nothing that fails to resolve —
   the check `lingtai add`, `lingtai doctor` and the daemon already share
   ([0104](0104-the-recipe-is-the-pipeline.md) §11).

7. **The trial build is the terminal's alone.** It is in `lingtai add` and is not
   offered on the board. It runs after the module has finished and is not a setup
   question, so it is the one difference between the inputs and not a copy.

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
