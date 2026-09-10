# 0038 — The site deploys to a domain root, and the shared palette is what decides that

**Status** accepted · 2026-09-10

## Context

[0035](0035-the-site-is-a-projection.md) settled what the site is and `apps/site`
built it. `pnpm --filter @lingtai/site build` produces a directory of files and
has since 2026-09-09, and nothing published them anywhere. `#115` asked for a
site that *exists, builds, and deploys somewhere with a URL*, and the third of
those was the one still open.

The obvious host was GitHub Pages: the repository is already on GitHub, the
export is already static, and the deploy needs no account, no token and no
secret — `GITHUB_TOKEN` is enough. It is the cheapest answer to the question and
this file exists because it is the wrong one.

## Decision

### 1. The site is served from a domain root, and this is not a preference

A GitHub Pages project site serves at `/<repo>/`. Next.js has `basePath` for
exactly that, and it rewrites `<Link>`, `next/font` and `next/image` for you.
**It does not rewrite `url()` inside an imported stylesheet**, and the board's
palette contains one:

```css
/* apps/board/src/app/globals.css */
--mark: url("/logo.png");
```

That line is not incidental. The comment above it says why it is a token rather
than a choice made in the markup — *"the two files are the same shape with the
ink recoloured for the ground it sits on, which is exactly what every line above
this one is"* — and the board renders `<span className="mark">` with no `src`
anywhere in the TSX precisely so the mark follows the palette.

Under a base path, `/logo.png` resolves to the *domain* root, which on
`steven-zhc.github.io` is not ours. The only repair is a second `--mark` in
`site.css` pointing at `/lingtai/logo.png` — and a second definition of one of
the board's tokens is exactly what `#115`'s second requirement forbids: **the
theme tokens come from `apps/board/src/app/globals.css`, not from a copy.** Two
files drifting apart is the same defect as two docs drifting apart, which is the
defect [0022](0022-the-seams.md) deleted a subsystem to stop having.

So the sub-path host is refused, and the reason is worth stating plainly because
it inverts the usual order: **the palette rule chose the host.** A rule that
only constrains stylesheets is a style guide. This one reached out and settled a
deployment question, which is the evidence that it is load-bearing.

`apps/site/test/theme.test.ts` holds the rule it rests on — the site redefines
none of the board's tokens — so the day somebody adds `--mark` to `site.css` to
make a sub-path deploy work, the suite says what it costs before the deploy
happens.

### 2. Vercel, from `vercel.json`, and previews only on `main`

The repository has no CI: Lingtai's own gates are what judge a change, and a
GitHub Actions workflow duplicating `pnpm typecheck && pnpm test` would be a
second thing to keep correct. The deploy is therefore configured and not
scripted — `vercel.json` at the repository root names the install, the build and
the output directory, and the host's git integration does the rest on every
merge to `main`.

```json
"git": { "deploymentEnabled": { "main": true } }
```

is the one line that is about *this* repository rather than about any Next.js
export. Lingtai opens a branch per attempt — `agent/115` has nine — and a host
that builds a preview for every branch would spend a build on each of them,
including the eight that produced nothing. `main` is the only branch whose
content anyone would look at.

### 3. A cloud build has no log, and the page says so rather than pretending

The hero is the real board, read from `task_view` at build time. A build running
on a host somewhere has no `LINGTAI_DATABASE_URL` and cannot have one — the log
is a Postgres database on one machine of yours, which is what Lingtai *is*. So
the deployed hero arrives empty.

That is not a fault to route around, and 0035 already refused the route: **the
generator refuses to invent a board**, and with no log it writes nothing and the
page says it has no snapshot. A marketing page that fabricates its own evidence
is worth less than one that admits it has none, on a site whose entire claim is
that you can see what happened.

What makes the hero real is a build run beside the log, which is what 0035 named
as still owed and this is:

    pnpm site:deploy

`vercel build --prod && vercel deploy --prebuilt --prod`. The build runs on your
machine, in your environment, so `snapshot.ts` reads the log the same way it does
under `pnpm build`; only the finished directory is uploaded. The two paths differ
in exactly one thing — whether there was a log in the room — and that is the
correct thing for them to differ in.

## Consequences

- `vercel.json` and the `site:deploy` script are committed; `.vercel/` is
  ignored, because a link between one machine and one hosting account is not a
  fact about this repository.
- **One step is a person's and cannot be automated from here**: creating the
  Vercel project and linking it (`vercel link`, once, at the repository root).
  Until that happens there is configuration and no URL. The name decides the
  URL — `lingtai` gives `https://lingtai.vercel.app`.
- A merge to `main` republishes the documentation, which is the part that
  actually changes. The board on the front page updates when somebody runs
  `pnpm site:deploy`, and is honest about being absent until they do.
- Moving to any other host is now a bounded question with one requirement:
  **it must serve at a domain root.** Cloudflare Pages, Netlify and a GitHub
  Pages site with a custom domain all qualify; a GitHub Pages project site does
  not, for §1's reason and no other.
- The `--mark` token is now load-bearing beyond the board. It was already a
  palette entry rather than a markup decision; it is now also the reason this
  file exists, and a change to it should read §1 first.
