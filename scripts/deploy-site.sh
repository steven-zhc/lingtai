#!/bin/sh
# Builds apps/site on this machine and uploads it to Cloudflare Pages.
#
#   scripts/deploy-site.sh
#
# **No environment is needed.** The site is a static export and nothing in it
# talks to a server once deployed. The one input it can take is at *build*
# time: the front page's board is read from the log by `snapshot.ts`
# (doc/decisions/0035-the-site-is-a-projection.md §1). Without
# LINGTAI_DATABASE_URL that step is skipped and the hero says it has no
# snapshot; with it, the board is frozen into the files:
#
#   LINGTAI_DATABASE_URL=… LINGTAI_SITE_PUBLIC_PROJECTS=steven-zhc/lingtai \
#     scripts/deploy-site.sh
#
# **Why here and not in CI.** Only when a board is wanted does it matter: the
# log is not something a GitHub runner should be able to reach, so a build with
# a board runs beside the log and what leaves this machine is `apps/site/out/`.
#
# **Why Cloudflare Pages and not GitHub Pages.** `apps/site/public/_headers` is
# Cloudflare's format, and its one rule — `install.sh` as `text/plain`,
# `nosniff`, five minutes — is what lets a reader read the installer before
# piping it into `sh`. GitHub Pages ignores the file.
#
# The Pages project and its custom domain are made once, by hand, in the
# Cloudflare dashboard — see the note at the bottom. This script only uploads.
#
# Environment, all optional:
#   LINGTAI_DATABASE_URL          the log the board is read from (read by snapshot.ts)
#   LINGTAI_SITE_PUBLIC_PROJECTS  owner/repo[,…] whose ticket titles may be shown
#   LINGTAI_SITE_PAGES_PROJECT    Cloudflare Pages project name (default: lingtai)
#   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
#                                 optional; without them wrangler uses `wrangler login`
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

project=${LINGTAI_SITE_PAGES_PROJECT:-lingtai}
out=apps/site/out

if [ -n "$(git status --porcelain)" ]; then
  echo "deploy-site: the working tree is not clean; the page would carry a commit that is not what it shows." >&2
  echo "  Commit or stash first." >&2
  exit 1
fi

pnpm --filter @lingtai/site build

# pnpm runs no dependency's install script unless told to, and wrangler needs
# two: esbuild's and workerd's, each of which fetches its platform binary.
# Named here so `dlx` does not stop and ask on every run.
#
# `--branch main` makes this the production deployment; any other branch name
# would land on a preview URL instead of the custom domain.
pnpm dlx --allow-build=esbuild --allow-build=workerd wrangler@4 pages deploy "$out" \
  --project-name "$project" \
  --branch main \
  --commit-hash "$(git rev-parse HEAD)" \
  --commit-message "$(git log -1 --format=%s)"

# One-time setup, not repeated by this script:
#   1. pnpm dlx --allow-build=esbuild --allow-build=workerd wrangler@4 login
#   2. pnpm dlx --allow-build=esbuild --allow-build=workerd wrangler@4 pages project create lingtai --production-branch main
#   3. Cloudflare dashboard → Workers & Pages → lingtai → Custom domains →
#      add lingtai.hczhang.com. hczhang.com is on the same account, so the
#      CNAME and certificate are made for you.
