# Upgrading to 0.16

This page is for a project that was made before 0.16 and is running now. It
takes the project to 0.16 without unholding a ticket and without changing what
it does. Nothing here is urgent: a project you leave alone stays **solo**, which
is how Lingtai has always run.

What changed for you, in the order you meet it:

1. Every installation of the GitHub App is asked to approve two new read
   permissions, once.
2. A recipe says `branch.main` where it said `base`, and `take: all` where it
   said `take: both`. The old spellings are refused, so this comes before any
   restart.
3. The hold label is `lingtai:hold`, not `agent:hold`.
4. A recipe may say `mode: team`. A recipe that names no mode is `solo`.

Do them in this order. A wrong order costs you: a daemon restarted onto a recipe
that still has an old spelling takes nothing, and a hold label renamed out of
order unholds tickets.

## 1. Approve the App's two new permissions

*Every project on GitHub, solo or team.* Lingtai reads the checks and statuses
on a team PR's head, so its permissions list gains **Checks: read** and
**Statuses: read**. The list is one list for every project, as `workflows` was,
so a solo project is asked too. Until the installation has approved them,
`lingtai add` refuses that repository, naming the two; a project already added
is not stopped by it.

An installation can only accept what the App already asks for, so the order
matters, and looking only at the installation shows nothing to approve:

1. Add them to the **App** itself, at `https://github.com/settings/apps/<slug>/permissions`
   (an organisation's App is at
   `https://github.com/organizations/<org>/settings/apps/<slug>/permissions`).
   Set **Checks** and **Statuses** to *Read-only*.
2. Accept them on the **installation**: GitHub emails the account that owns it,
   and the installation's settings page shows the request.
3. Confirm it took. On the installation's settings page both permissions read
   *Read-only*, with nothing left pending. **No command re-checks a repository
   that is already added**: `lingtai add` refuses it as already added before it
   reads permissions, and `lingtai doctor` does not check them. The check
   happens when a repository not yet added is onboarded (`lingtai add`, or the
   board's picker, which names a gap beside the installation), so that is where
   a missing approval would show. The table of every permission is in
   [GitHub](github.md#one-app-and-it-is-not-a-person), and
   [operating](operating.md) has the setup for a new App.

A person using `gh` rather than an App has nothing to approve.

## 2. Let `lingtai doctor` rewrite the old spellings

Four spellings in a recipe were renamed:

| Before | Now |
|---|---|
| `repo.base`, or `base` under an `admit` entry's `worktree:` | `branch.main` |
| `take: both` | `take: all` |
| `runtime.assignee` | `source.assignee` |
| `init --base <branch>` on the command line | `init --main <branch>` |

A recipe that still writes one is **refused** by 0.16 when it resolves, with a
sentence naming the key and the fix, so a daemon restarted onto it takes nothing:
do this step before restarting for anything else on this page. `lingtai doctor`
names each one it finds, by key, and `lingtai doctor --fix` rewrites them as a
**new recipe change on the project's log**. `init --base` is likewise refused in
favour of `--main`.

`--fix` moves `runtime.assignee` as a block, `login` and `take` together, under
`source:`, and rewrites `take: both` to `all` in the same change. A recipe that
writes both keys keeps `source.assignee` and loses `runtime.assignee`.

```bash
lingtai doctor            # names the old spellings
lingtai doctor --fix      # rewrites them as a new recipe change
lingtai restart "0.16 recipe"
```

Restart once the recipe is fixed: the daemon holds the recipe it started with. See
[`doc/cli.md`](cli.md) for the flags.

## 3. Rename the hold label, in this order

Every hold Lingtai writes is now `lingtai:hold`, and a hold is only what the
project's recipe **excludes**. A ticket holding `agent:hold` is held only while
`agent:hold` is in `exclude`. So there is a wrong order: take `agent:hold` out of
`exclude`, or put only `lingtai:hold` in, before the tickets carry the new label,
and every ticket you were holding is **unheld at once** and taken on the next
pass.

The right order, done by you and not by an agent:

1. **Relabel.** Every ticket that carries `agent:hold` also gets `lingtai:hold`.
   On GitHub, with `gh`:

   ```bash
   gh label create lingtai:hold --description "held by a person" 2>/dev/null || true
   gh api --paginate 'repos/{owner}/{repo}/issues?labels=agent:hold&state=open&per_page=100' \
     --jq '.[].number' |
     xargs -I{} gh issue edit {} --add-label lingtai:hold
   ```

   `gh issue edit --add-label` needs the label to exist, so the first line creates
   it (harmless where it already does). `--paginate` follows every page, so no
   count caps it; `gh issue list --limit` would, silently. Verify with the same
   unbounded listing: this prints the number of every open `agent:hold` issue
   that does not yet carry `lingtai:hold`, and **must print nothing** before you
   go on:

   ```bash
   gh api --paginate 'repos/{owner}/{repo}/issues?labels=agent:hold&state=open&per_page=100' \
     --jq '.[] | select(([.labels[].name] | index("lingtai:hold")) | not) | .number'
   ```

   On the local ticket store you do nothing: the store's own migration adds
   `lingtai:hold` to every ticket that has `agent:hold` the first time it is
   opened by 0.16, and does the same for `agent:followup`, which gains `lingtai:followup`.
   It leaves a ticket whose labels it cannot read alone.
2. **Exclude both.** In the project's recipe, `source.exclude` (or the `exclude`
   of the `queue:` entry at `claim`, if the recipe declares one) lists
   `agent:hold` **and** `lingtai:hold`. `lingtai doctor` gives a `hold label:
   <project>` warning for a recipe that excludes the old label and not the new
   one, and says nothing changes until you edit the recipe by hand. Restart the
   daemon afterwards (`lingtai restart "0.16 hold label"`), because a running
   daemon holds the recipe it started with.
3. **Remove the old label last.** Once `lingtai status` shows both in the
   project's `excludes` line and every held ticket carries the new label, take
   `agent:hold` off the tickets, and out of `exclude`.

The board and `lingtai backlog` write `lingtai:hold` from 0.16 on, and a
person's own `lingtai:` label survives Lingtai's label writes. [Operating](operating.md)
has the long account of what a hold is and is not.

## 4. Switching to team, if you want it

You need nothing here to stay on 0.16. A recipe that names no `mode` is solo:
every ticket with a kind label and no hold is taken, work lands on `branch.main`,
and a landed ticket is closed. A **new** project defaults to team; an existing one
does not move.

To make a project a team project, edit its recipe: write `mode: team`, give it a
`branch.personal` (made from `origin/<branch.main>` when it does not exist), and
on GitHub a `login` for `take: mine`.

```yaml
mode: team

branch:
  main: main
  personal: steven-zhc/steven-s-macbook-pro

source:
  assignee:
    login: steven-zhc
    take: mine
```

A team project takes only the tickets assigned to that login, lands them on
`branch.personal`, and reaches `main` through a PR you submit: see
[A PR's life](team.md)
and [a team project's PR on GitHub](github.md#a-team-projects-pr). The recipe
refuses `take: all` or `take: unassigned` in team mode, and `branch.personal` in a
solo one, each by name. Two things to know before you switch:

- **A squash merge loses what a merge commit keeps.** Merge a PR with a merge
  commit and one ticket the team refuses is one `git revert`. A squash still
  counts as merged, but the tickets are no longer separate commits.
- **Two people on one Postgres log is not supported.** One personal branch is
  one machine's.

[0130](decisions/0130-a-project-is-solo-or-team.md) and
[0131](decisions/0131-a-pr-goes-from-draft-to-merged.md) are the decisions.
