# Connect GitHub

*Chapter 3 — your own repository on GitHub, in the same home*

Chapters 1 and 2 ran on a checkout on your machine. This chapter adds a
repository of your own on GitHub to that same home, as a team project. Three
things change: tickets are GitHub issues instead of `lingtai ticket new`, a PR
opens on GitHub and waits for its CI, and a review there can send work back.
Nothing else does. Use a repository you can push to and a small one to start
with: nothing reaches `main` until you merge.

## Sign in

Sign the GitHub CLI in with the scopes Lingtai checks for. No GitHub App is
needed for one person; for a team, see [GitHub](github.md).

```sh
gh auth login --hostname github.com --scopes repo,workflow
```

Already signed in without `workflow`? Run
`gh auth refresh --hostname github.com --scopes workflow`.

## Add the repository

Do not make a new `LINGTAI_HOME`: the home from chapter 1 takes this project
beside Chapter Garden. Two projects collide only by repository name, so a
repository that is itself called `chapter-garden` is refused as already added.

```sh
lingtai add <owner>/<repo> --github-auth gh
```

`--github-auth gh` tells `add` to use the login you just made. Without it, a home
made with `init --local` has no way to reach GitHub, and `add` stops before it can
ask. The flag signs nobody in: a `gh` that is signed out, or short of a scope, is
refused with the check's own lines. `add` then asks for the project's mode, and
team is the default. Your tickets land on a personal branch,
`<login>/<machine>`, and `main` moves only when you merge a PR. Check the result:

```sh
lingtai doctor
```

`github: gh login` should read `ok` and name your account, and `github: app
credentials` reads `skip`, as there is no App.

## An issue, assigned to you

Open an issue on GitHub. It needs a kind label (`bug`, `tech-debt`, `feature` or
`documentation`), or the queue never sees it. A new repository may lack some of
them, and has no `lingtai:pr-fix`; GitHub's issue form cannot pick a label that does
not exist. Create what is missing once, `--force` leaving the ones you have:

```sh
for l in bug tech-debt feature documentation lingtai:pr-fix; do
  gh label create "$l" --repo <owner>/<repo> --force
done
```

A team project takes only issues
assigned to your login, so assign it to yourself. Add `lingtai:hold` if you want to
read it before an agent starts. [Tickets](tickets.md) is about writing one
well. The ticket is worked as in chapter 2, and when it lands it is on your
personal branch, not `main`.

## Submit the PR

```sh
lingtai pr <repo>
```

```text
draft: 1 ticket(s) landed on <login>/<machine>
```

`<repo>` is the repository's name, `chapter-garden` being the other project in this home: with two projects registered, `lingtai pr` alone is refused. The draft is the project's next PR, not yet submitted. It holds the tickets landed
on your personal branch since the last PR was frozen. Then submit it:

```sh
lingtai pr submit <repo>
```

A submit with nothing landed is refused, and a refused submit returns the PR to the
draft. Otherwise the conductor pushes the PR's branch and opens a draft pull
request on GitHub. If the repository has a workflow that runs on `pull_request`,
the PR waits for every check on its head; if it has none, the PR page says there
is no CI step. Nothing in the recipe is needed for that: `pr.ci.required` only
narrows which checks count. When the checks pass, the PR is topped up with its
summary and marked ready, on the head they passed. Run `lingtai pr <repo>` to follow it.

## A review asks for a change

Review the PR on GitHub as you would anyone's. Lingtai does not read review
comments, so a comment alone starts nothing. To send the change back, open the PR's
page on the board and choose *New pr-fix ticket*: it opens GitHub's new-issue form
with the `lingtai:pr-fix` label (created above) and a title put in. Write what must change, assign
the issue to yourself, and create it. That ticket is cut from the PR's branch and
lands on it, so the fix is another commit on the same PR. The PR stays ready and
does not go back to a draft, and CI runs again on the new head.

## Merge it

Merge the PR on GitHub with a merge commit, never a squash, as in chapter 2. The conductor then closes the PR's tickets and catches your personal
branch up with `main`. A protected `main` is no obstacle, because nothing Lingtai
does in team mode pushes to it.

One personal branch belongs to one machine. A second machine gets a branch of its
own, and its tickets are a second draft.

## Next

Next: [How an attempt goes](concepts.md) — what a ticket does between start and landing.
