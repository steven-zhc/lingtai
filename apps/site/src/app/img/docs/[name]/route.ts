import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { docRoot } from "@/lib/docs";

/**
 * The diagrams in `doc/img/`, served at `/img/docs/<name>.svg`.
 *
 * A route rather than a copy into `public/`: a copy made when `next dev` starts
 * is missing for every diagram added after it, and the page then shows a broken
 * image until somebody restarts the server. Read from `doc/img/` on each request
 * in development, and written out as static files by the export, so the page and
 * the repository cannot disagree about which diagrams exist.
 */
export const dynamic = "force-static";
export const dynamicParams = false;

const dir = path.join(docRoot, "img");

export async function generateStaticParams() {
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.filter((name) => name.endsWith(".svg")).map((name) => ({ name }));
}

export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  // A name is one file in `doc/img/` and nothing else: no separator, no `..`.
  if (!/^[a-z0-9-]+\.svg$/.test(name)) return new Response("not found", { status: 404 });
  const body = await readFile(path.join(dir, name), "utf8").catch(() => null);
  if (body === null) return new Response("not found", { status: 404 });
  return new Response(body, { headers: { "Content-Type": "image/svg+xml; charset=utf-8" } });
}
