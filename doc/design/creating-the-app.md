# Creating the App, as step 0

**Status** built as [#169](https://github.com/steven-zhc/lingtai/issues/169) ·
2026-09-15 · `/setup/github-app` on the board, `packages/github/src/manifest.ts`
and `packages/conductor/src/create-app.ts` · precedes
[the onboarding wizard](the-onboarding-wizard.md) and
[#168](https://github.com/steven-zhc/lingtai/issues/168)

## The cost this removes, in the words of the decision that accepted it

[0006](../decisions/0006-github-app.md) chose a GitHub App over a personal
access token, and listed the price in its own Consequences:

> Setup is heavier than pasting a token: **an App must be created, given a
> private key, and installed.**

Three things. GitHub's **App Manifest flow** collapses the first two into one
click, and [#168](https://github.com/steven-zhc/lingtai/issues/168) is the
third. After both, the whole of 0006's price is a person naming an App and
choosing which repositories it may see.

## The flow

Four steps, and **all three network steps must complete inside one hour** —
that is GitHub's bound on the temporary code, not ours.

```
1. Lingtai serves a page that AUTO-SUBMITS A POST FORM  ← not a link
     personal → https://github.com/settings/apps/new?state=<CSRF>
     org      → https://github.com/organizations/<org>/settings/apps/new?state=<CSRF>
     body: manifest=<JSON>       ← the state is on the URL, not in here

2. GitHub's own screen. The person names the App and clicks Create GitHub App.

3. GitHub redirects to redirect_url?code=<temporary>&state=<ours>
     http://127.0.0.1:<port>/... is accepted — the loopback works

4. POST https://api.github.com/app-manifests/{code}/conversions   (unauthenticated)
     → id, slug, client_id, client_secret, webhook_secret, and the full PEM
```

**It is a POST, so it cannot be a link.** Whatever hosts step 1 must serve a
page whose form submits itself; there is no URL a person can be sent to.

## What is already here

Three things exist and were built for other reasons:

| | |
|---|---|
| `hasGitHubApp()` (`packages/env/src/index.ts:309`) | *"Whether the App is configured at all, without throwing to find out."* The board already calls it twice (`actions.ts:71`, `:198`). **This is half the idempotency check** the manifest flow needs and does not have of its own — half, because it reads a `process.env` fixed at start, and the other half is the file (below) |
| `githubApp()` reads the key **per call** | `readFileSync(resolvePath(path))` is inside the function, not module scope. A key written to `LINGTAI_GITHUB_APP_PRIVATE_KEY_PATH` after a process started is picked up by that process's next call |
| 0006's permission table | It is exactly the manifest's `default_permissions`, already agreed and already written down |

## The bootstrap asymmetry, and it is the finding

**The private key hot-reloads. The App ID does not.**

```ts
const appId = optional(`${PREFIX}GITHUB_APP_ID`, from);   // from process.env — set once, at start
if (path) return { ..., privateKey: readFileSync(resolvePath(path), "utf8") };   // re-read every call
```

So a Lingtai that is already running, and has a `.env` naming
`LINGTAI_GITHUB_APP_ID` and `..._PRIVATE_KEY_PATH`, gains a working credential
the moment the PEM lands at that path — **but only if the ID was already in the
environment**. Create the App at runtime and the ID is new, so nothing that is
already running can use it.

This is the shape 0010 named for code — *a process holds what it started with* —
reaching config. It has two honest answers and the ticket must pick one:

- **Write both and say a restart is needed.** Truthful, and `lingtai restart`
  ([0042](../decisions/0042-restart-is-a-command.md)) already exists to do it
  safely. The page ends on *"created — run `pnpm lingtai restart` to use it"*.
- **Mutate `process.env.LINGTAI_GITHUB_APP_ID` in the receiving process as well
  as writing the file.** The next `githubApp()` then works with no restart —
  **in that process only**. A daemon in another process still has the old
  answer, and a page that says "ready" while the daemon disagrees is worse than
  one that says "restart".

**The first is correct.** The second is the kind of half-true green that this
repository keeps finding — and the page would be claiming a state only one of
two processes is in.

**Neither was built, and the first was wrong.** A page naming `lingtai restart`
names a command that restarts the daemon and not the board — the process that
just wrote the credentials — so the next click still answers *no GitHub App
configured* and running it again prints the same sentence. The asymmetry is
closed at its source instead: `hasGitHubApp()` and `githubApp()` read the ID and
the key path from `.env.local` on disk, per call, whenever `process.env` does
not set them. The App is usable the moment it is written, in every process, and
the page names no restart. `process.env` still wins where it is set.

### Two more questions that look like one, found while building it

*Is an App configured here* is what decides whether the button is drawn, and it
has exactly two honest sources — and the first draft used neither of them
properly.

**It is asked of `.env.local` and not only of `process.env`.** The file is what
this flow *writes*; `process.env` is a snapshot `@lingtai/env` took when the
board started. An operator who finds they lack the organisation role the
manifest flow needs, falls back to `operating.md` and adds the two lines by hand
has changed nothing that snapshot can see — so a still-open board tab draws the
button, and the exchange replaces both lines with a second App's while the
screen says *Created*. Asking a snapshot whether the thing about to be
overwritten is there is not asking.

**And `GitHubAppCreated` says an App was minted, never that one is configured.**
The record is appended the moment the conversion returns — before the key file
and before the env file — precisely so that a write which fails leaves
something durable behind it. Folded into *configured*, it therefore reported
exactly the creations that did *not* finish as Apps a restart would pick up:
the key write failed, the page said *created here — run `lingtai restart`*, and
the restart found `LINGTAI_GITHUB_APP_ID` unset and changed nothing.

So there are three answers and the screen says a different thing about each:
**configured** (the credentials are here — install it), **minted** (an App of
ours is on GitHub and its key never landed — finish that one, and GitHub will
not hand the key over twice), and **unanswered** (the log did not say, so
nothing is offered). **Only `configured` and `unanswered` withhold the
button.** `minted` is named beside the form and does not close it: a stranded
App whose key cannot be fetched again must leave a way to create another, and
only a form posted *before* that App was minted is refused, where the writing
happens.

## Where the flow lives: the board

**This document first recommended the CLI, and the argument was wrong.** It is
recorded here rather than deleted, because the mistake is the useful part.

The argument was: the private key is the only long-lived secret in the system,
every other credential expires in an hour, and giving an HTTP handler the power
to write it is a power the board would keep. It reads well. It does not survive
looking at what the board can already do:

| `apps/board/src/app/actions.ts` | |
|---|---|
| `approveCard` | releases a hold at the merge point — the next pass merges into `main` |
| `editPrompt` | rewrites the whole document an agent is handed |
| `sendAttempt` | dispatches it |
| `runNow` | starts a pass |

**Those four compose into "merge arbitrary code into `main`."** Anyone who can
reach the board can already have an agent write and land anything — including
code that reads the private key and sends it elsewhere. Writing a key file is
**strictly less power than the board already holds**, so withholding it protects
nothing and costs the wizard its first screen.

The browser settles what is left. The manifest flow **requires** a browser —
step 2 is a person clicking on GitHub's own page:

```
board:  page → GitHub → page                                       2 hops
CLI:    terminal → open a browser → GitHub → 127.0.0.1 → terminal → board   5
```

Starting in a terminal takes someone out of the browser and puts them back.

**So: a board route, and the board writes the key.** What survives from the
rejected argument is not the location but the care — see [the secret, once it
arrives](#the-secret-once-it-arrives). The `0600` habit and the path convention
are `apps/cli/src/env.ts`'s and `.env.example:77`'s, and the board should reuse
them rather than invent a second place for the same file.

`hasGitHubApp()` (`packages/env/src/index.ts:309`) is what the page reads to
decide whether to offer creation at all — the board already calls it twice.

## The manifest, field by field

```jsonc
{
  "name":        "<suggested, and the person may change it>",
  "url":         "https://github.com/steven-zhc/lingtai",
  "public":      false,                       // one team's own App (0045)
  "default_permissions": {                    // 0006's table, verbatim
    "issues":        "write",
    "contents":      "write",
    "pull_requests": "write",
    "metadata":      "read"
  },
  "default_events":  ["issues"],             // not push: webhook.ts drops every one
  "redirect_url":    "http://127.0.0.1:<port>/created",
  "hook_attributes": { /* see below */ }
}
```

**`default_permissions` is the whole argument for doing this at all.** 0006
exists because of a day lost to a fine-grained PAT that covered the submodule
and not the repository, with nothing anywhere saying so. A manifest means
**the person never chooses permissions, so they cannot choose them wrong**. The
failure 0006 was written to make *visible* becomes one it makes *impossible*.

**`name` must be unique across all of GitHub**, and the flow has no idempotency:
every run tries to mint a new App, and a duplicate name fails on GitHub's own
screen — where Lingtai cannot see it. Suggest a name that is unlikely to
collide, and treat *the person never came back* as an expected outcome rather
than an error.

## Webhooks: say it rather than pre-fill a URL that cannot work

`hook_attributes.url` is where GitHub will post `issues`. Lingtai's
receiver is `apps/board/src/app/api/webhook/route.ts` — and on loopback
(`127.0.0.1:17820`, #187) **GitHub cannot reach it**.

Two honest options, and not a third:

- **Leave webhooks inactive** (`"active": false`) and say so on the page:
  *discovery runs on the sweep until this board has an address GitHub can
  reach*. **This costs nothing, and the codebase settled it already.**
  `work-loop.ts:21`:

  > a webhook needs a public address and **this runs on a laptop**: it is an
  > optimisation, and an optimisation must not be the only path. So the loop
  > also sweeps on a long interval, and the interval is long because the sweep
  > is a fallback and not the mechanism.

  Nothing degrades when the webhook is off. Discovery is slower by the sweep
  interval, which is the state every developer running Lingtai is in today.
- **Ask for a public URL** if the person has one, and set it.

What must not happen is filling in a `localhost` URL, which produces an App
whose webhook deliveries fail silently from the first minute — a configured
thing that does not work, which is [0016 §4](../decisions/0016-the-settled-model.md)'s
whole complaint.

## The secret, once it arrives

The conversion returns six values in one response. They are not equal:

| value | what to do |
|---|---|
| `id` | write to the env file |
| `pem` | write to `LINGTAI_GITHUB_APP_PRIVATE_KEY_PATH`, `0600`, and **print the path, never the key** |
| `webhook_secret` | write — the receiver verifies signatures with it |
| `slug` | useful for the install link (`https://github.com/apps/<slug>/installations/new`) |
| `client_id`, `client_secret` | **discard.** Lingtai has no OAuth flow ([0045](../decisions/0045-one-team-one-conductor.md) names user identity as a separate epic). A secret kept for a use that does not exist is a secret with no owner |

Three rules, and the third is the one this codebase is most at risk of breaking:

1. **Only accept a `code` whose `state` this process issued**, in this run.
2. **The PEM is never rendered and never logged** — not to stdout, not to the
   run log, not to `~/.lingtai/runs/`.
3. **The PEM never becomes an event.** The log is append-only and permanent by
   design; a secret written into it cannot be taken back out, and
   `lingtai projection rebuild` would faithfully replay it forever. Whatever
   event records that an App was created carries the **id and the slug**, and
   nothing else.

## Creating is not installing

Two different acts, at two different frequencies, and the epic should not blur
them:

```
create the App     once per team          ← this document
install on a repo  once per repository    ← #168
```

After step 4 the App exists and can see nothing. The natural next thing the page
offers is the install link, which is `#168`'s first screen — so this hands over
with the `slug` and nothing else.

## Failure modes to design for, not to discover

| what happens | what Lingtai sees | what it must do |
|---|---|---|
| the person closes GitHub's tab | nothing, ever | time out and say the App was not created, rather than wait |
| duplicate App name | nothing — the error is on GitHub's page | the same timeout path, with the name collision named as the likely cause |
| the code expires (one hour) | `422` from the conversion | say the hour lapsed and offer to start again |
| an App is already configured | `hasGitHubApp()` is true | **do not offer creation.** Offer the install link instead |
| org install, wrong role | GitHub refuses on its own screen | the timeout path again |
| a human never clicks | by design — GitHub requires it | this is not a bug to route around; there is no headless path and the page should not imply one |

## What this is not

- **Not headless.** *"A human still has to click 'Create GitHub App' in the
  browser. That is by design."* Lingtai's own agents cannot mint an App, and
  nothing here should be built as though a future version might.
- **Not for enterprise-owned Apps.** The manifest flow does not support them.
- **Not a replacement for `lingtai add`.** That still checks the installation
  and the scopes before recording anything, and that check is 0006's day-of-403
  lesson.

## Related

- **0006** — chose the App, and priced it. This pays two thirds of that price.
- **0045** — one team, one conductor. Why the App is `"public": false` and why
  creation is once-per-team rather than once-per-person.
- **0042** — `restart` as a checked command. Why *"created — now restart"* is an
  acceptable ending rather than a rough edge.
- **#168** — step 0's other half: install it, and pick a repository.
- **0016 §4** — a configured point that silently does not run is Lingtai's bug.
  The reason webhooks are declared inactive rather than pointed at `localhost`.
