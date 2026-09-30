import { rm } from "node:fs/promises";
import path from "node:path";
import { DOCS_PUBLIC } from "../src/lib/docs.ts";

/**
 * Next's static exporter insists that a dynamic route has at least one static
 * parameter, even while the route deliberately returns `notFound()`. That
 * leaves 404-shaped files under `out/docs/`, which a static host can serve with
 * a misleading 200 status. When docs are private, remove both generated route
 * trees after the export so those URLs genuinely do not exist.
 */
if (!DOCS_PUBLIC) {
  const out = path.resolve(process.cwd(), "out");
  await Promise.all([
    rm(path.join(out, "docs"), { recursive: true, force: true }),
    rm(path.join(out, "doc"), { recursive: true, force: true }),
  ]);
  console.log("docs: removed /docs and /doc from the static export");
}
