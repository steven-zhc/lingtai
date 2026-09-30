import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { DOCS_PUBLIC, PUBLIC_SLUGS } from "../src/lib/docs.ts";

/**
 * Next's static exporter insists that a dynamic route has at least one static
 * parameter, and emits 404-shaped files for the docs index and the inert slug,
 * which a static host can serve with a misleading 200 status. When docs are
 * private, remove everything under `out/docs/` that is not a public page, and
 * the carried HTML drawings in `out/doc/`, so those URLs genuinely do not exist.
 */
if (!DOCS_PUBLIC) {
  const out = path.resolve(process.cwd(), "out");
  const keep = (name: string) => PUBLIC_SLUGS.some((s) => name === s || name.startsWith(`${s}.`));
  const docs = path.join(out, "docs");
  const names = await readdir(docs).catch(() => [] as string[]);
  await Promise.all([
    rm(path.join(out, "doc"), { recursive: true, force: true }),
    ...names.filter((n) => !keep(n)).map((n) => rm(path.join(docs, n), { recursive: true, force: true })),
  ]);
  console.log(`docs: kept ${PUBLIC_SLUGS.join(", ")}; removed the rest of /docs and /doc from the static export`);
}
