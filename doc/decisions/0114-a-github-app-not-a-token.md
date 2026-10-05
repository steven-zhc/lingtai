# 0114 — The GitHub App: Lingtai reaches GitHub as an App created from a manifest, never through a personal access token

**Status** accepted · 2026-10-01

Lingtai talks to GitHub as a GitHub App installed on each repository it
manages. Lingtai creates the App itself through GitHub's manifest flow, so a
person never chooses the permissions and so cannot choose them wrong. The App
asks for four permissions and subscribes to one event. Its credentials are an
App ID, a private key and an optional webhook secret. They live on the
conducting machine (`github:` in `~/.lingtai/config.yml`, with the key in
`~/.ssh`), never in a managed repository and never in an agent's environment.
API calls use short-lived installation tokens.

## Context

Lingtai reads issues, writes labels and comments, pushes branches, opens pull
requests and merges. A fine-grained personal access token can do all of that,
and it can also be wrong in a way that nothing reports. A token whose scope
misses one repository fails with a bare 403 in the middle of the work. An App
installation makes the set of reachable repositories explicit, and Lingtai can
check the App's permissions before any work starts.

## Decision

1. **An App, installed per repository, and never a token.** `packages/github`
   is the only client. It signs an App JWT locally with RS256 (`appJwt` in
   `packages/github/src/app.ts`, using no dependency beyond `node:crypto`) and
   exchanges it for an installation token. `installationToken` caches each token
   and refreshes it a minute before it expires, one refresh at a time, so a
   token never expires partway through a merge.

2. **The permissions are these four, and only these.**

| Permission | Level | For |
|---|---|---|
| Issues | read + write | reading work items, writing `agent:*` labels and comments |
| Contents | read + write | cloning, pushing `agent/*`, merging into base |
| Pull requests | read + write | opening and reading pull requests |
| Metadata | read | required by GitHub for any App |

   `REQUIRED_PERMISSIONS` in `packages/github/src/app.ts` is this table in code,
   and `packages/github/unit/manifest.test.ts` parses it from this file. When a
   repository is added (`onboard.ts`, `pick-repository.ts` in
   `packages/conductor/src`), `permissionGaps` checks the installation against
   the same list and names each missing grant, rather than leaving it to surface
   later as a 403.

3. **The App subscribes to `issues` and nothing else.** `MANIFEST_EVENTS` is
   `["issues"]` and matches the receiver's `ACTED_ON` in
   `packages/github/src/webhook.ts`. `push` is not subscribed, because the
   receiver would drop every push delivery. A webhook is an optimisation and
   never a dependency, because the daemon sweeps GitHub regardless. Without a
   public `https://` address, the manifest declares the hook **inactive** and
   does not point it at the local machine. `unreachableWebhook` refuses
   loopback, private, link-local and LAN-only addresses. The receiver is the
   board's `/api/webhook`, which verifies `x-hub-signature-256` in constant time
   and answers 503 when no secret is configured.

4. **The App is created from a manifest, in the board.** The board's
   `/setup/github-app` page (`packages/conductor/src/create-app.ts`, built on
   `packages/github/src/manifest.ts`) auto-submits a POST form to
   `github.com/settings/apps/new`, or to the organisation's equivalent page,
   with `state` in the query string. A person names the App on GitHub's screen.
   GitHub then redirects back with a code, and `POST
   /app-manifests/{code}/conversions` exchanges it for the credentials. The
   whole flow must finish within GitHub's one-hour limit. The App is private
   (`public: false`), created once per team. The installation flow returns to
   the repository picker through `setup_url`.

5. **Credentials live on the conducting machine, read fresh from file.** They
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

6. **Secrets are never written to the log or printed.** The conversion drops
   `client_id` and `client_secret` at the seam, because Lingtai has no OAuth
   flow. The log records `GitHubAppCreated { appId, slug }` on its own stream
   and nothing else. The private key and webhook secret are never printed or
   returned to a page. The App's credentials are the machine's, held by
   `@lingtai/env`. An agent's environment comes from `@lingtai/agent-env` and
   never contains them. Pushing, merging and closing are the conductor's
   effects, not an agent's.

## Consequences

- The set of repositories Lingtai can reach is visible in the installation, and
  a missing permission is named when the repository is added.
- Setting up takes more steps than pasting a token: create the App, then install
  it. The manifest flow reduces the first step to one click.
- The private key is a real long-lived secret on the conducting machine. It
  stays out of every repository and every managed project's environment.
- Changing the requested permissions requires editing this file's table and
  `REQUIRED_PERMISSIONS` together. The unit test fails if they differ.

---
*Replaces archived 0006 in [decisions-archive](../decisions-archive/).*
