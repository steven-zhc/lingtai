# 0114 — GitHub access: the person's own `gh` login for one person, a GitHub App for a team

**Status** accepted · 2026-10-01 · revised 2026-10-28 (§1, §8: the `gh` login)

Lingtai talks to GitHub in one of two ways, chosen once per machine. **A person
working alone** lends Lingtai their own GitHub CLI login: Lingtai asks `gh auth
token` for a token each time it needs one and keeps nothing. **A team** uses a
GitHub App installed on each repository Lingtai manages, which Lingtai creates
itself through GitHub's manifest flow so nobody chooses its permissions wrong.
Either way the credential belongs to the conducting machine and never reaches an
agent, and a repository Lingtai cannot reach is named when it is added, not
discovered in the middle of a merge.

## Context

Lingtai reads issues, writes labels and comments, pushes branches, opens pull
requests and merges. A fine-grained personal access token can do all of that,
and it can also be wrong in a way that nothing reports: a token whose scope
misses one repository fails with a bare 403 in the middle of the work. An App
installation makes the set of reachable repositories explicit, and Lingtai can
check the App's permissions before any work starts.

An App is also the heaviest step in setting Lingtai up: create it, keep its
private key, install it on each repository. For one person on their own
repositories that buys little. Most developers already have the GitHub CLI
signed in, its token reaches exactly the repositories that person can, and the
failure that motivated the App (a scope that silently omits a repository) is
answered by checking the repository at the moment it is added (§8). A token a
person pastes is still never accepted: it is the case that fails silently.

## Decision

1. **Two ways in, chosen once per machine, and never a pasted token.**
   `github.auth` in `~/.lingtai/config.yml` (or `LINGTAI_GITHUB_AUTH`) is `gh`
   or `app`, and `lingtai init` writes it.
   - `gh`: the person's own GitHub CLI login (§8), worded as *for one person*.
   - `app`: the GitHub App (§2–§7), for a team, for an organisation that blocks
     the CLI's OAuth app, or for a person who does not want Lingtai to act as
     them.
   - Absent, an `app_id` that is configured means `app`, so a machine set up
     before this revision keeps working unchanged; otherwise no project can be
     added from GitHub, and the refusal says to run `lingtai init`.

   **When it is asked.** Setting up a project asks, in order: where the code
   is (a directory on this machine, or a GitHub repository); for a GitHub
   repository, where its tickets come from (its issues, or Lingtai's own
   table); and then, only when the answer needs GitHub, how this machine
   reaches it. A directory on this machine is pushed with the person's own
   `git` credentials and its tickets are Lingtai's own table, so it never
   asks. The question is asked once per machine: when `github.auth` is set, or
   an App is configured, it is not asked again, and a later `lingtai add` says
   which way is in use.

   **How it is asked.** When `gh auth status` says the CLI is signed in to
   github.com with the `repo` and `workflow` scopes, `gh` is the default and
   the prompt says that Lingtai's labels, comments, pull requests and pushes
   will appear as that account (§8). Otherwise the choices are to sign in now,
   or to create an App. Signing in now hands the terminal to `gh auth login
   --hostname github.com --web --scopes workflow` (or, for a login that lacks
   only `workflow`, `gh auth refresh --hostname github.com --scopes
   workflow`), and then checks the scopes again; a sign-in that fails or is
   interrupted returns to the choice. Lingtai passes no `--git-protocol` and
   answers none of `gh`'s own questions: how `gh` configures git on this
   machine is the person's, and Lingtai does not use it (§8). It is offered
   only at a terminal. `gh` not installed is said with how to install it, and
   the App is still offered. `--github-auth <gh|app>` answers the question on
   the command line; `--defaults` does not, because it decides whose name
   Lingtai acts under.

   **Not offered yet: a directory on this machine with its GitHub issues as
   tickets.** A local project has no owner (#354) and so no GitHub client;
   giving it one is a separate decision. A person who wants GitHub issues adds
   the GitHub repository instead.

   `packages/github` is the only client either way. Both are a `token()`
   function, resolved per call, so the rest of Lingtai does not know which.

2. **The App, installed per repository.** `packages/github`
   is the only client. It signs an App JWT locally with RS256 (`appJwt` in
   `packages/github/src/app.ts`, using no dependency beyond `node:crypto`) and
   exchanges it for an installation token. `installationToken` caches each token
   and refreshes it a minute before it expires, one refresh at a time, so a
   token never expires partway through a merge.

3. **The permissions are these five, and only these.**

| Permission | Level | For |
|---|---|---|
| Issues | read + write | reading work items, writing `agent:*` labels and comments |
| Contents | read + write | cloning, pushing `agent/*`, merging into base |
| Pull requests | read + write | opening and reading pull requests |
| Workflows | read + write | pushing changes to `.github/workflows` |
| Metadata | read | required by GitHub for any App |

   `REQUIRED_PERMISSIONS` in `packages/github/src/app.ts` is this table in code,
   and `packages/github/unit/manifest.test.ts` parses it from this file. When a
   repository is added (`onboard.ts`, `pick-repository.ts` in
   `packages/conductor/src`), `permissionGaps` checks the installation against
   the same list and names each missing grant, rather than leaving it to surface
   later as a 403.

4. **The App subscribes to `issues` and nothing else.** `MANIFEST_EVENTS` is
   `["issues"]` and matches the receiver's `ACTED_ON` in
   `packages/github/src/webhook.ts`. `push` is not subscribed, because the
   receiver would drop every push delivery. A webhook is an optimisation and
   never a dependency, because the daemon sweeps GitHub regardless. Without a
   public `https://` address, the manifest declares the hook **inactive** and
   does not point it at the local machine. `unreachableWebhook` refuses
   loopback, private, link-local and LAN-only addresses. The receiver is the
   board's `/api/webhook`, which verifies `x-hub-signature-256` in constant time
   and answers 503 when no secret is configured.

5. **The App is created from a manifest, in the board.** The board's
   `/setup/github-app` page (`packages/conductor/src/create-app.ts`, built on
   `packages/github/src/manifest.ts`) auto-submits a POST form to
   `github.com/settings/apps/new`, or to the organisation's equivalent page,
   with `state` in the query string. A person names the App on GitHub's screen.
   GitHub then redirects back with a code, and `POST
   /app-manifests/{code}/conversions` exchanges it for the credentials. The
   whole flow must finish within GitHub's one-hour limit. The App is private
   (`public: false`), created once per team. The installation flow returns to
   the repository picker through `setup_url`.

6. **Credentials live on the conducting machine, read fresh from file.** They
   are the `github:` section of `~/.lingtai/config.yml`, each key overridable by
   the exported variable of the same name ([0117](0117-configuration-is-config-yml-and-the-environment.md)):
   - `app_id` / `LINGTAI_GITHUB_APP_ID`: the App ID.
   - `app_private_key_path` / `LINGTAI_GITHUB_APP_PRIVATE_KEY_PATH`: the PEM's
     path, default `~/.ssh/lingtai-agent.private-key.pem`, written with mode
     `0600`; relative in the file means relative to `~/.lingtai`.
     `app_private_key` / `LINGTAI_GITHUB_APP_PRIVATE_KEY` takes the PEM inline
     instead, for hosts that can carry it only as one line.
   - `webhook_secret` / `LINGTAI_GITHUB_WEBHOOK_SECRET`: optional. Without it
     `/api/webhook` answers 503 with a sentence naming where it belongs.

   The setup page writes `github:` into `config.yml`, editing the document so
   every other section and comment stays, creating the file `0600`, and
   refusing when an `app_id` is already there. `githubApp()` and
   `hasGitHubApp()` in `packages/env/src/index.ts` read the file as it is at
   call time, so an App created at runtime works in every running process
   without a restart. **One source answers every name** (`electGithubApp`):
   an exported `LINGTAI_GITHUB_APP_ID` takes the key and secret from the
   environment too, otherwise all of them come from the file, so an ID, a key
   and a secret from different Apps are never paired. A `config.yml` that will
   not parse or cannot be opened is named as that file — never as *not set*,
   and never as the log being unreadable — and the setup page offers no App
   over it.

7. **Secrets are never written to the log or printed.** The conversion drops
   `client_id` and `client_secret` at the seam, because Lingtai has no OAuth
   flow. The log records `GitHubAppCreated { appId, slug }` on its own stream
   and nothing else. The private key and webhook secret are never printed or
   returned to a page. The App's credentials are the machine's, held by
   `@lingtai/env`. An agent's environment comes from `@lingtai/agent-env` and
   never contains them. Pushing, merging and closing are the conductor's
   effects, not an agent's.

8. **The `gh` login: borrowed per call, checked per repository.**
   - **Only the saved login is borrowed.** `gh` prefers `GH_TOKEN`, then
     `GITHUB_TOKEN` (and their `GH_ENTERPRISE_`/`GITHUB_ENTERPRISE_` forms),
     over the account it has saved. A token in the environment is a pasted
     token (§1), so every `gh` Lingtai runs, `gh auth status` and `gh auth
     token` alike, runs with those variables removed, and the account and
     scopes Lingtai reports are the saved login's.
   - **The token is asked for, never kept.** `token()` runs `gh auth token
     --hostname github.com` each time and holds the answer only for that call.
     It is never written to `config.yml`, the log, a remote URL or an agent's
     environment. It enters only the temporary authentication environment of
     each `git` child process the conductor starts, the same way an
     installation token does. A `gh` that is missing, signed out, or answers
     nothing is named as that, never as a 403.
   - **The repository is checked when it is added.** `lingtai add` reads the
     repository with the token and requires `permissions.push`; it refuses by
     name when the token lacks the `repo` or `workflow` scope or the person
     cannot push,
     so §3's rule (a missing grant is named before work starts) holds without
     an installation.
   - **Two identities, and the token is only one of them.** What Lingtai does
     through the API (labels, comments, pull requests) and who pushes are the
     signed-in account, not a bot; that is said where `init` offers this way,
     and it is the main reason a team uses §2. Who *authored* a commit, the
     agent's commits and the merge commit alike (`git merge` in
     `packages/repo/src/integrate.ts:521`), is the conducting machine's git
     identity (`user.name`, `user.email`), which Lingtai does not set; that is
     so under the App too. A person signed in to `gh` as one account with git
     configured as another sees both names. Making them one is a separate
     decision.
   - **No webhook.** There is no App to subscribe; the daemon's sweep finds
     work, as it does wherever the webhook is inactive (§4).
   - **It changes nothing about what an agent can reach.** An agent is given
     no GitHub credential either way (§7). The person's `gh` login is on the
     machine already, as it was before; keeping an agent from using it is the
     runtime's own sandbox, configured by the person.

## Consequences

- One person can start without creating anything on GitHub: `gh auth login`,
  then `lingtai init`.
- Under `gh`, Lingtai's API actions and pushes are indistinguishable from the
  person's on GitHub, and the token is as long-lived as their CLI session.
- Under either way, commits are authored by the machine's git identity, not
  by the credential.
- Changing `.github/workflows/*` needs its own grant: the `workflow` scope
  under `gh`, and `Workflows: write` under the App. Without it a ticket that
  edits CI would be refused at the push, after its build was paid for, so both
  ways ask for it up front.
- Under `app`, the set of repositories Lingtai can reach is visible in the
  installation, a missing permission is named when the repository is added,
  and the private key is a real long-lived secret on the conducting machine
  that stays out of every repository and every managed project's environment.
- Changing the App's requested permissions requires editing §3's table and
  `REQUIRED_PERMISSIONS` together. The unit test fails if they differ.

## Not built yet

- `github.auth`, `--github-auth`, the `gh` token source, the embedded sign-in and the question order (§1, §8); today only the App exists.

---
*Replaces archived 0006 in [decisions-archive](../decisions-archive/).*
