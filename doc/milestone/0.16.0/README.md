# 0.16.0: more agents through ACP, and solo and team

Everything written while planning 0.16.0, in one place. The milestone on GitHub
is `0.16.0`.

| File | What it is |
|---|---|
| [0.16.md](0.16.md) | The plan, as narrowed on 2026-11-20: an ACP runtime usable wherever its capabilities reach, and solo and team modes — a team takes the tickets assigned to the person, lands on their personal branch and submits a PR draft. The ticket sources and the GitLab acceptance run moved to [../later/ticket-sources.md](../later/ticket-sources.md) |
| [acp-experiments.md](acp-experiments.md) | The experiments E1–E12 run before the ACP questions are discussed: setup, steps, what each one decides |
| [acp-libraries.md](acp-libraries.md) | The ACP libraries a TypeScript client could be built on, surveyed 2026-11-19 |
| [team-mode/](team-mode/index.html) | The board mocks for team mode, for the operator to agree before its board tickets are cut: the PR page, home's split *Landed* column, a ticket in review, syncing with `main` and its conflict, `/recipe` |
| [vibe-kanban-demand-vs-lingtai.md](vibe-kanban-demand-vs-lingtai.md) | What Vibe Kanban's users ask for, against what Lingtai already does |

## Moved here from 0.15.0

On 2026-11-16 the operator narrowed 0.15.0 to four parts
([../0.15.0/0.15.md](../0.15.0/0.15.md)) and moved three here. On 2026-11-18,
narrowing 0.16.0 itself ([0.16.md](0.16.md)):

- **A GitLab or Bitbucket remote, local tickets documented** became the GitLab
  acceptance run; the epic #340 stays here for its Linear half only, if there
  is time.
- **A first run measured on a clean machine** is that same acceptance run.
- **[0129](../../decisions/0129-one-module-owns-each-aggregate.md)'s other
  owners**, Control, Integration and Attempt, are out of 0.16.0, unless the ACP
  runtime adds Attempt events (0.16.md, question 5).

On 2026-11-20 both — the GitLab acceptance run and the ticket sources with epic
#340 — moved out of 0.16.0 to [../later/ticket-sources.md](../later/ticket-sources.md),
and solo and team took their place.
