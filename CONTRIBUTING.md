# Contributing

Lingtai maintains this repository through its own pipeline: most changes are
made by agents working tickets. The most useful thing you can give it is a
clear issue.

## Opening an issue

Use the templates: a bug report or a feature request. Each asks for the
**Problem** (the failure, not the area), the **Want** (what is true when it is
done) and the **Watch out** (the trap), with Evidence and Done when if you have
them. [What a good ticket holds](CLAUDE.md#opening-an-issue) is written out in
`CLAUDE.md`.

Every issue from a template is held, so nothing is worked by an agent until a
person has read it and lifted the hold.

For a vulnerability or a conduct concern, use the "Private contact" form and
put no details in the issue. See [SECURITY.md](SECURITY.md) and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Pull requests

Pull requests from people are welcome. To set up and run Lingtai, start with
[doc/tutorial.md](doc/tutorial.md). A pull request must pass
[`.github/workflows/check.yml`](.github/workflows/check.yml), which runs
`pnpm typecheck` and `HOME=/nonexistent pnpm test`. It does not run the
integration half, and neither should you.

Commit messages follow [Commits](CLAUDE.md#commits) in `CLAUDE.md`: one line,
lower case, stating what is now true. Never write close, closes, fixes or
resolves next to an issue number unless you mean to close it; GitHub does not
read the sentence around it, so a negation closes the issue too. Write "see"
and the number instead.
