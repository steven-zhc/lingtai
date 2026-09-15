# How Lingtai connects to GitHub

What the credential is, how it reaches `git`, and what the agent is not given.
[`operating.md`](operating.md) is what you *type*; this is what happens.

## One App, and it is not a person

[0006](decisions/0006-github-app.md) chose a GitHub App over a personal access
token, and the reason was a day:

> On 2026-08-30 the admin repository's CI failed on every run with a 403. The
> token was present and the secret was set; the fine-grained PAT simply covered
> the submodule repository and not the main one. **Nothing in the failure said
> so.**

A PAT can do everything Lingtai needs. What it cannot do is make *which
repositories are reachable* an explicit fact — under a PAT it is implicit in a
scope nobody can see; under an App it is the installation, which fails loudly at
install time instead of quietly at merge time.

There is a second reason, and 0006 does not state it: **Lingtai merges code
unattended.** Under a person's token every one of those merges reads, on GitHub,
as that person's act — and the whole log turns on separating *steven approved
this* from *steven's machine did this at 03:00*. See
[the gap](#identity-separation-is-half-built) below: this is currently true of
the push and not of the commit.

Permissions, as installed:

| Permission | Level | For |
|---|---|---|
| Issues | read + write | reading work items, writing `agent:*` labels and comments |
| Contents | read + write | cloning, pushing `agent/*`, merging into base |
| Pull requests | read + write | opening and reading PRs |
| Metadata | read | required |
| Webhooks | `issues`, `push` | event-driven discovery |

**Rate limit is not a reason.** An installation and a PAT both start at 5,000
requests an hour; the App's scales with repository and user count, and 15,000 is
an Enterprise Cloud figure. At two repositories the difference is nothing. Do
not cite it.

## The chain: one long secret, everything else an hour old

```
private key on disk            ← the only long-lived secret in the system
  │  sign a JWT as the App
  ▼
App JWT ──→ GET /repos/{owner}/{repo}/installation ──→ installation id
  │  POST /app/installations/{id}/access_tokens
  ▼
installation token             ← expires in one hour
```

Two names, both `LINGTAI_`-prefixed because [#63](https://github.com/steven-zhc/lingtai/issues/63)
made every name Lingtai reads for itself carry the prefix:

```bash
LINGTAI_GITHUB_APP_ID=123456
LINGTAI_GITHUB_APP_PRIVATE_KEY_PATH=~/.ssh/lingtai-agent.private-key.pem
# or, where only a single-line value can be carried:
#LINGTAI_GITHUB_APP_PRIVATE_KEY=-----BEGIN...\n...
```

`packages/env/src/index.ts:289` recognises the un-prefixed name and says so by
name rather than reporting the variable as unset — because for a while this
document told you to write it that way.

**The key is re-read on every call.** `readFileSync` sits inside `githubApp()`,
not at module scope, so a key that appears at that path later is picked up by a
process already running. **The App ID is not** — it comes from `process.env` and
is fixed when the process starts. That asymmetry is
[creating-the-app.md](design/creating-the-app.md)'s subject.

## `token()` is a function, and that is the point

`packages/github/src/client.ts:212`:

> A function rather than a value on purpose. An installation token lasts an hour
> and a run's wall limit is two, so a snapshot taken at the start would be
> expired by the time the integrator pushes.

A run may take two hours. The token lives one. Taking it once at the start means
it is dead at exactly the moment that must not fail — the push at the end.
Callers hold the function and resolve it per `git` invocation.

## How the token reaches `git`, and the two ways it does not

`packages/repo/src/git.ts:45`:

```ts
const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
env["GIT_CONFIG_COUNT"]   = "1";
env["GIT_CONFIG_KEY_0"]   = "http.https://github.com/.extraheader";
env["GIT_CONFIG_VALUE_0"] = `AUTHORIZATION: basic ${basic}`;
```

Its own comment says why the two obvious ways were rejected:

> argv is visible in `ps`; `.git/config` outlives the run and **would be
> readable from inside the worktree by the agent itself**. The environment of a
> single child process is neither.

| | why not |
|---|---|
| in the URL — `https://x-access-token:TOKEN@github.com/…` | lands in argv, and argv is world-readable in `ps` |
| written to `.git/config` | outlives the run, **and the agent is sitting in that worktree** |
| one child process's environment | neither ✓ |

And below it:

```ts
env["GIT_TERMINAL_PROMPT"] = "0";
```

> a hung credential prompt inside a daemon is indistinguishable from a slow
> clone.

## The agent is given nothing

[0020](decisions/0020-the-agent-environment-in-layers.md): **"A name that is not
declared never reaches the agent from `process.env`."** It names
`LINGTAI_DATABASE_URL` and the App's private key path as the two it must never
carry.

So the division is:

```
agent       edits code in the worktree and commits to its own branch. That is all.
conductor   pushes the branch, runs the gates, merges, writes labels, opens PRs.
```

The agent's prompt says *"You do not merge … pushing to the base branch or
merging a pull request is refused"*, and that sentence is not what makes it
true. **What makes it true is that the agent has no credential.**

## "Not installed" is not "no such repository"

`packages/github/src/app.ts:150`:

```ts
// 404 here means "no installation covers this repository", which is not the
// same as "no such repository" and reads very differently to whoever is
// trying to onboard it.
if (err.status === 404) throw new NotInstalledError(owner, repo);
```

That is 2026-08-30 written into the code: one status code, two meanings, said
apart.

## Two ways work is discovered

- **Webhook** — `issues` and `push`, received at
  `apps/board/src/app/api/webhook/route.ts`.
- **A long-interval sweep**, and it is not a backup plan bolted on.
  `packages/daemon/src/work-loop.ts:21`:

  > a webhook needs a public address and **this runs on a laptop**: it is an
  > optimisation, and **an optimisation must not be the only path**. So the loop
  > also sweeps on a long interval, and the interval is long because the sweep
  > is a fallback and not the mechanism.

Changes to the *log* need neither: Postgres `LISTEN`/`NOTIFY` carries those,
because *"polling the log would be choosing to be slow"*.

## Identity separation is half-built

**Verified, 2026-09-15.** `GIT_AUTHOR_*`, `GIT_COMMITTER_*`, `user.name` and
`--author` appear nowhere in `packages/` or `apps/`. Lingtai merges with local
`git merge` — `packages/github/src/client.ts` has no merge endpoint at all — so:

```
any merge commit Lingtai creates   ← the ~/.gitconfig of whoever runs the daemon
the push that moves the base       ← the App
```

The argument at the top of this file — that an App keeps *approved by a person*
distinct from *done by a machine* — holds for the push and **not for the commit
history**. Closing it means setting `GIT_COMMITTER_NAME` and `_EMAIL` to the
App's bot identity (`<slug>[bot]`,
`<id>+<slug>[bot]@users.noreply.github.com`) at the merge.

This is a gap, not a decision. It is small and it is not ticketed.

## What this cannot do yet

| | |
|---|---|
| **list repositories** | only `/repos/{owner}/{repo}/installation` — *is it installed here*. There is no call to `/installation/repositories`, so nothing can offer a picker. [#168](https://github.com/steven-zhc/lingtai/issues/168) |
| **link to the page that fixes a scope** | the installation object carries `html_url`; `app.ts:37` does not capture it. `permissionGaps` already computes which scope is missing and nothing renders it. [#168](https://github.com/steven-zhc/lingtai/issues/168) |
| **create the App** | today a person follows [`operating.md`](operating.md) by hand. GitHub's manifest flow makes it one click, and pre-fills the permission table above so it cannot be filled in wrong. [creating-the-app.md](design/creating-the-app.md) |
| **know who is asking** | `actor()` is `human:${process.env.USER}` — whatever the OS says, unverifiable, meaningless across machines. [0045](decisions/0045-one-team-one-conductor.md) names this as a separate epic |

## Related

- [0006](decisions/0006-github-app.md) — chose the App, and priced it.
- [0020](decisions/0020-the-agent-environment-in-layers.md) — the filtered
  environment, which is why the agent has no credential.
- [0045](decisions/0045-one-team-one-conductor.md) — one team, one conductor;
  where authority is named as unfinished.
- [`operating.md`](operating.md) — what to type.
- [`design/creating-the-app.md`](design/creating-the-app.md) — making the App
  itself one click.
