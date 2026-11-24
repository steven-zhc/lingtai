# Solo mode

Pick solo when nobody else works on the repository. `lingtai add` asks `Does anyone else work on this repository?` and offers `team` or `solo`; the solo choice reads "Solo — just me: each ticket lands on main by itself". Enter makes a team project, which chapters 1–3 teach.

What changes from those chapters:

- Every ticket with a kind label and no hold is taken. Nothing has to be assigned to you.
- Work lands on `branch.main`.
- A landed ticket is closed.
- There is no PR page and no `lingtai pr` step: `lingtai pr submit` is refused in a solo project.

## Where work lands

Solo always lands on `branch.main`. What differs is the value `lingtai add` writes there, so the answer depends on how the project was added.

- **A local project** (`init --local`, `add --local`): `lingtai-base`, a branch made from the one you have checked out when it is absent. Solo does not change that, so a first project where you answer `solo` still lands on `lingtai-base`, as in team. `--main <branch>` names another.
- **A GitHub project**: the repository's default branch, usually `main`. `--base <branch>` names another.

In both, the value is in the recipe, and editing `branch.main` there moves it.

## Switching

Edit the recipe; nothing moves a project between the modes by itself. A recipe that names no `mode` is solo, and an existing project stays as it is until you change it. [Upgrading to 0.16](upgrading-to-0.16.md#4-switching-to-team-if-you-want-it) has the YAML for going to team, and [the recipe](recipe.md) has the keys. Team refuses `take: all` and `take: unassigned`; solo refuses `branch.personal`.
