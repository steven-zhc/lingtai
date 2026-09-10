import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { docRoot, HTML_DOCS } from "../src/lib/docs.ts";

/**
 * Carries the documents that are already HTML into the export.
 *
 * `architecture.html` is a thousand lines of hand-written HTML with its own
 * diagrams and its own stylesheet. Rendering it through the markdown pipeline
 * would mean rewriting it, and a rewritten copy is the fork the whole docs
 * projection exists to refuse — so the build moves the file, byte for byte,
 * and the site links to `/doc/architecture.html`.
 *
 * The copies land in `public/` and are **not committed** (see `.gitignore`):
 * a copy in git is a second file to keep in step, which is the failure again.
 * This runs before `next dev` and before `next build`, so the copy is never
 * older than the build that serves it.
 */
const out = path.resolve(process.cwd(), "public/doc");

await mkdir(out, { recursive: true });
for (const doc of HTML_DOCS) {
  // No try: a missing `architecture.html` means the projection is pointing at
  // a document that no longer exists, and a build that quietly serves a
  // dangling link is how documentation starts lying.
  await copyFile(path.join(docRoot, doc.file), path.join(out, doc.file));
}
console.log(`doc-assets: ${HTML_DOCS.map((d) => d.file).join(", ")} → public/doc/`);
