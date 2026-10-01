# 0005 — Configuration lives in the managed repository

**Status** superseded · 2026-08-31 · supersedes an earlier draft that put it
outside · its **policy half is superseded by
[0016](0016-the-settled-model.md)** and **its surviving half by
[0046](0046-lingtai-is-personal.md) §3** · qualified by
[0047](0047-the-recipe-a-run-got-is-on-the-log.md)

**Nothing here is in force, and the reversal is worth reading beside the
argument.** This file's whole subject — the recipe at
`<repo>/.lingtai/config.yaml`, read from `origin/<base>` and never from the
agent's branch — moved out of the managed repository in
[#180](https://github.com/steven-zhc/lingtai/issues/180). The recipe is now
`~/.lingtai/<project>/recipe.yml`, nothing is read from or written to the
repository for it, and a `.lingtai/config.yaml` still committed there is an
ordinary file that changes nothing.

Two things survive translated rather than deleted. **§Context's objection was
never answered by being argued with — it was answered by location.** "Putting
gate definitions in the repository hands the exam paper to the candidate" was
solved here by reading from the base branch; 0046 solves it more completely,
because an agent's blast radius is its worktree and `~/.lingtai/` is not in it.
And the sentence below that 0046 quotes back: what a team genuinely shares was
never the recipe — *which checks are required, and who may approve, are not in
the repository at all, they are branch protection*.

Also gone, and gone earlier: "a recipe may add strictness and can never remove
it" — there is no longer an outside policy for it to be measured against. The
workflow is the user's to define.

## Context

Onboarding a repository should be: give a repo path and GitHub permissions.
That argues for `<repo>/.lingtai/config.yaml`, the way GitHub Actions uses
`.github/workflows/`.

The objection is real: the managed repository is exactly what the agent edits.
Putting gate definitions in it hands the exam paper to the candidate — one
"tidied up the config" commit and the review gate is gone.

The first draft of this design concluded *therefore configuration must live
outside the repository*. **That conclusion was wrong.** Actions solved this years
ago, and better:

1. The workflow that judges a pull request is read **from the base branch**. A
   PR cannot change the rules that govern it.
2. Which checks are *required*, and who may approve, are not in the repository
   at all — they are branch protection.

Definition may live in the repo. Enforcement must not.

## Decision

**Recipe** in `<repo>/.lingtai/config.yaml`, committed to the managed
repository. **Policy** in Lingtai's own database as `ProjectPolicySet`
events.

| | recipe · in the repo | policy · in Lingtai |
|---|---|---|
| Answers | how this project runs | what is not negotiable |
| Holds | build/test commands, where the env file is planted, which gates exist, which prompt, submodules, priority labels | tier floor, which gates are mandatory, production host patterns, deny list, concurrency, who may approve |
| Written by | the project, evolving with its code | you, from the board or `lingtai policy` |
| Can the agent change it | it can edit the file, but not this run's rules, and never without passing `tamper` | no |
| GitHub's equivalent | `.github/workflows/*.yml` | branch protection |

### The governance rule

**A run's configuration is read from `origin/<base>`, never from the agent's
branch.** So:

- an agent that edits `.lingtai/config.yaml` changes nothing about the run in
  flight — the recipe was already snapshotted, and its hash recorded in
  `RunStarted`;
- the edit appears in the diff, where the `tamper` gate catches it and routes to
  human approval;
- it takes effect from the next work item, after a human approves and merges it.

A recipe may **add** strictness. It can never remove a gate policy marks
mandatory, nor lower the tier. `lingtai doctor` fails loudly on a conflict and names
the clause.

## Consequences

- `lingtai add <owner>/<repo>` is the whole onboarding step.
- `tamper` becomes a standard gate, watching `.lingtai/**` plus the rest of
  the verification surface the agent can reach: `package.json#scripts`, test
  configuration, `.github/workflows/**`. The old loop had no defence here at all.
- The recipe holds **variable names only**, never values — so it is safe to
  commit. Values resolve at runtime from somewhere the agent cannot see, the
  same shape as Actions secrets.
- A configuration change is itself an event (`ProjectConfigured`, with the
  resolved hash), so "did results change after I edited the pipeline?" is
  answerable by replay.
