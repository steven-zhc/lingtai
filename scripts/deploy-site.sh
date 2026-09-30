#!/bin/sh
# Builds apps/site on this machine and uploads it to Cloudflare Pages.
#
#   LINGTAI_DATABASE_URL=… LINGTAI_SITE_PUBLIC_PROJECTS=steven-zhc/lingtai \
#     scripts/deploy-site.sh
#
# **Why here and not in CI.** The front page's board is taken from the log at
# build time (doc/decisions/0035-the-site-is-a-projection.md §1), and the log is
# not something a GitHub runner should be able to reach. So the build runs
# beside the log, and what leaves this machine is `apps/site/out/` — a directory
# of files, with the board already frozen into it.
#
# **Why Cloudflare Pages and not GitHub Pages.** `apps/site/public/_headers` is
# Cloudflare's format, and its one rule — `install.sh` as `text/plain`,
# `nosniff`, five minutes — is what lets a reader read the installer before
# piping it into `sh`. GitHub Pages ignores the file.
#
# **It refuses to deploy a page with no board**, because `snapshot.ts` exits 0
# when it skips (no URL, or an empty `task_view`), and a deploy script that
# carried on would publish the "no snapshot" notice over a real board. Set
# LINGTAI_SITE_ALLOW_NO_BOARD=1 to publish that page on purpose.
#
# The Pages project and its custom domain are made once, by hand, in the
# Cloudflare dashboard — see the note at the bottom. This script only uploads.
#
# Environment:
#   LINGTAI_DATABASE_URL          the log the board is read from (read by snapshot.ts)
#   LINGTAI_SITE_PUBLIC_PROJECTS  owner/repo[,…] whose ticket titles may be shown
#   LINGTAI_SITE_PAGES_PROJECT    Cloudflare Pages project name (default: lingtai)
#   LINGTAI_SITE_ALLOW_NO_BOARD   1 to deploy without a board snapshot
#   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
#                                 optional; without them wrangler uses `wrangler login`
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

project=${LINGTAI_SITE_PAGES_PROJECT:-lingtai}
snapshot=apps/site/snapshot.json
out=apps/site/out

if [ -n "$(git status --porcelain)" ]; then
  echo "deploy-site: the working tree is not clean; the page would carry a commit that is not what it shows." >&2
  echo "  Commit or stash first." >&2
  exit 1
fi

pnpm --filter @lingtai/site build

if [ ! -f "$snapshot" ] && [ "${LINGTAI_SITE_ALLOW_NO_BOARD:-}" != "1" ]; then
  echo "deploy-site: the build wrote no board snapshot (see the snapshot: line above)." >&2
  echo "  Not deploying. Set LINGTAI_SITE_ALLOW_NO_BOARD=1 to publish the page without one." >&2
  exit 1
fi

# `--branch main` makes this the production deployment; any other branch name
# would land on a preview URL instead of the custom domain.
pnpm dlx wrangler@4 pages deploy "$out" \
  --project-name "$project" \
  --branch main \
  --commit-hash "$(git rev-parse HEAD)" \
  --commit-message "$(git log -1 --format=%s)"

# One-time setup, not repeated by this script:
#   1. pnpm dlx wrangler@4 login
#   2. pnpm dlx wrangler@4 pages project create lingtai --production-branch main
#   3. Cloudflare dashboard → Workers & Pages → lingtai → Custom domains →
#      add lingtai.hczhang.com. hczhang.com is on the same account, so the
#      CNAME and certificate are made for you.
