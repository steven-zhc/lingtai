# 0112 — The website: a static projection of the repository, showing the real board

**Status** accepted · 2026-10-01

The public site (`apps/site`) is a Next.js static export built from this
repository: its documentation pages are rendered from the files in `doc/` at
build time and never copied, and its front page shows Lingtai's own board as a
snapshot read from the log once at build time, with every card from a
non-public project withheld rather than dropped. Only an allow-list of docs is
public today (`PUBLIC_SLUGS`, behind the `DOCS_PUBLIC` switch). It is deployed
by `scripts/deploy-site.sh` to Cloudflare Pages, and it also serves the
installer.

## Context

A stranger needs one page that says what Lingtai does and a readable form of
the documentation that already exists as files. Documentation that drifts from
the repository is confidently wrong, so the site must have no second copy to
drift. A marketing page that queried the event store live would go down with the
database and could expose a private project's tickets. The product's claim is
that you can see what happened, so the page must not flatter: invented figures,
or a board with its stuck work removed, would contradict the pitch.

## Decision

1. **The site is `output: "export"`, with no server behind it.**
   `apps/site/next.config.ts` makes it a directory of files (`apps/site/out`,
   `trailingSlash: true`), so a page cannot grow a query without that line being
   deleted first. It is built with `pnpm --filter @lingtai/site build` from the
   repository root, and not by `pnpm build`.
2. **The front page's board is the real board, frozen at build time.**
   `apps/site/scripts/snapshot.ts` reads `task_view` once from
   `LINGTAI_DATABASE_URL`, hands the rows to `takeBoard`
   (`apps/site/src/lib/snapshot.ts`) and writes `snapshot.json`, stamped with
   when it was taken and the commit. All lanes appear, the stuck one included.
   The hero above it is a labelled illustration of the loop, never fabricated
   board data.
3. **The generator refuses to invent a board.** It deletes any previous
   `snapshot.json` first. With no `LINGTAI_DATABASE_URL` it writes nothing and
   exits 0, and the page says it has no snapshot; an empty `task_view` is
   treated the same way. A URL that is set and cannot be read stops the build.
4. **A card is withheld, never dropped, and nothing is public by default.**
   Only projects named in `LINGTAI_SITE_PUBLIC_PROJECTS` (comma-separated
   `owner/repo`, empty by default) are named on the page. A withheld card keeps
   its lane, age, attempts and money and loses everything that identifies it, so
   lane counts and totals stay true; the page says how many were withheld.
5. **The docs are a projection of `doc/`, never a copy.**
   `apps/site/src/lib/docs.ts` reads the files at build time. Links are
   rewritten at render, never in the files; a link to anything not published
   resolves to the file on GitHub (`GITHUB_BLOB`). The index is generated, and
   each decision's status is read out of `doc/README.md`'s table. Hand-written
   HTML documents (`HTML_DOCS`) are copied as they are by
   `scripts/doc-assets.ts`, not converted. Neither generator's output is
   committed.
6. **What is published is an allow-list, and the remainder is listed.**
   `SECTIONS` names what each docs section takes; every markdown file in `doc/`
   that no section takes is listed on the docs index with a GitHub link.
7. **Only `PUBLIC_SLUGS` are public while `DOCS_PUBLIC` is `false`.** Today that
   is `tutorial` and `plugins` (and everything under it). `servable()` filters
   to them, and `scripts/prune-hidden-docs.ts` runs after `next build` and
   removes every other path under `out/docs/` and all of `out/doc/`, so hidden
   pages do not exist rather than 404 with a 200. Turning `DOCS_PUBLIC` on
   restores the index, every document route and the HTML drawings together.
8. **The site takes the product's palette and fonts, and adds coral only as the
   way in.** `layout.tsx` imports `apps/board/src/app/globals.css`, and the snapshot
   renders with the board's own `.col`, `.card` and `.pill` classes. Coral `#FD5D3F`
   (`--way-in`) is allowed at most twice per page: one `.way-in` action and one
   `.claim` panel that cannot be pressed. Faces are IBM Plex Sans and Mono, with
   no serif.
9. **What does not work yet is on the front page.** A limits section names the
   gaps plainly; hiding them would contradict the claim the product makes.
10. **No hosted service is implied.** Lingtai runs on the user's machine, and no
    copy may promise a signup.
11. **`scripts/deploy-site.sh` builds on the operator's machine and uploads to
    Cloudflare Pages.** It refuses a dirty working tree, runs the site build, and
    deploys `apps/site/out` with `wrangler pages deploy --branch main` to the
    project named by `LINGTAI_SITE_PAGES_PROJECT` (default `lingtai`). A board on
    the page requires running it beside the log with `LINGTAI_DATABASE_URL`
    set; no CI or hosting provider is given that credential. Creating the Pages
    project and custom domain is a one-time manual step.
12. **The site serves the installer.** `apps/site/public/install.sh` is
    published at `/install.sh`, and `apps/site/public/_headers` serves it as
    `text/plain`, `nosniff`, cached five minutes. `/install.sh` needs a WAF skip:
    bot protection can answer it with a 200 HTML page that `curl -f` does not
    catch. The root `.node-version` (`26`) lets a provider's build run the `.ts`
    scripts directly.

## Consequences

- `doc/` has a second reader. A document that reads badly on the site is a
  fault in the document; editing it to suit the site is the fork this forbids.
- The front-page board is only as current as the last deploy, and it is dated
  so it does not claim to be now.
- A board requires a deploy from a machine that can reach the log; a build
  anywhere else ships the *no snapshot* notice.
- The snapshot is taken only where `LINGTAI_DATABASE_URL` is set; the
  operator who runs the deploy decides, by setting it and
  `LINGTAI_SITE_PUBLIC_PROJECTS`, what the page shows.
- A new HTML document in `doc/` is unreachable on the site until it is added to
  `HTML_DOCS`.

---
*Replaces archived 0035 in [decisions-archive](../decisions-archive/).*
