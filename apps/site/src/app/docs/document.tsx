import path from "node:path";
import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { headingsOf, resolveHref } from "@/lib/docs";

/**
 * A file from `doc/`, rendered.
 *
 * Two things happen here and nothing else does. The file is not rewritten, not
 * reformatted, and not summarised — the projection's whole claim is that the
 * page and the repository cannot disagree, and the moment this function starts
 * improving a document that claim is gone.
 *
 * **Links are resolved.** A doc file's links are written for somebody reading
 * the repository: `decisions/0022-the-seams.md`, `../../packages/domain/src/events.ts`.
 * Rendered as they stand they 404 here. The alternative — editing the files to
 * suit the site — is the fork this exists to refuse, so the links are rewritten
 * at render instead and the files stay written for the repository. See
 * `resolveHref`.
 *
 * **Headings get the anchor GitHub would have given them.** `#the-layers` and
 * `design.md#8-deliberately-not-building` are written in these files and land
 * nowhere here, because nothing in this pipeline gives a heading an `id`. The
 * id is derived from the heading, in GitHub's dialect (`slugify`), so the
 * anchors in the files go on meaning what they meant — again without the files
 * being touched. It is also what the contents beside the page points at.
 *
 * **Raw HTML stays out.** `react-markdown` drops HTML nodes unless `rehype-raw`
 * is added, and it is not added; `rehype-sanitize` runs anyway. These files are
 * the repository's own and are as trusted as the build that reads them, which
 * is exactly why the guard belongs here rather than in a judgement about the
 * source: a pipeline that is safe because of who wrote today's input is a
 * pipeline that is unsafe the first time that changes.
 */
type HeadingProps = ComponentPropsWithoutRef<"h2"> & ExtraProps;

export function Document({
  slug,
  source,
  body,
  published,
}: {
  /** The document's own route, which is what decides how the page is set. */
  slug: string;
  /**
   * Its path under `doc/`, which relative links are resolved against — the
   * file's directory and not the route's, since `plugins/index.md` is served at
   * `/docs/plugins/` and a link beside it means the file beside it.
   */
  source: string;
  body: string;
  /** Every file the site projects, so a link can tell a page from a blob. */
  published: string[];
}) {
  const isPublished = (file: string) => published.includes(file);
  // By source line, and not by counting headings as they render: the id a
  // heading gets here and the id the contents links to have to be the same id,
  // and the only thing both sides can agree on without one of them assuming the
  // order the other ran in is where the heading is in the file.
  const ids = new Map(headingsOf(body).map((h) => [h.line, h.id]));
  const heading = (Tag: "h2" | "h3" | "h4") =>
    function Heading({ node, children, ...rest }: HeadingProps) {
      const id = ids.get(node?.position?.start.line ?? -1);
      return (
        <Tag id={id} {...rest}>
          {children}
          {id !== undefined && (
            <a className="anchor" href={`#${id}`} aria-label="Link to this section">
              #
            </a>
          )}
        </Tag>
      );
    };

  /**
   * A TL;DR row says what kind of row it is, so the stylesheet can colour the
   * two that carry a warning — *refuses* and *watch out* — differently from the
   * three that describe. The label is the document's own word; this reads it and
   * adds a data attribute, and rewrites nothing.
   */
  const rowKind = (node: unknown): string | undefined => {
    const cell = (node as { children?: unknown[] } | undefined)?.children?.find(
      (child) => (child as { type?: string }).type === "element",
    );
    const text = (n: unknown): string =>
      typeof n === "object" && n !== null && "value" in n
        ? String((n as { value: unknown }).value)
        : ((n as { children?: unknown[] } | null)?.children ?? []).map(text).join("");
    const label = text(cell).trim().toLowerCase();
    return { does: "does", "write it at": "where", needs: "needs", refuses: "refuses", "watch out": "watch" }[label];
  };

  const components: Components = {
    tr({ node, children, ...rest }) {
      return (
        <tr data-row={rowKind(node)} {...rest}>
          {children}
        </tr>
      );
    },
    h2: heading("h2"),
    h3: heading("h3"),
    h4: heading("h4"),
    a({ href, children, ...rest }) {
      return (
        <a href={resolveHref(source, href ?? "", isPublished)} {...rest}>
          {children}
        </a>
      );
    },
    img({ src, alt, ...rest }) {
      const written = typeof src === "string" ? src : "";
      // `doc/img/` is the one directory of images the build carries
      // (`scripts/doc-assets.ts` copies it to `public/img/docs/`), so a diagram
      // in a document is the same file on GitHub and on the site. Any other image
      // is pointed at the repository, where it is.
      const under = path.posix.normalize(path.posix.join(path.posix.dirname(source), written));
      if (!/^[a-z]+:/i.test(written) && under.startsWith("img/")) {
        return <img src={`/img/docs/${under.slice("img/".length)}`} alt={alt ?? ""} {...rest} />;
      }
      return <img src={resolveHref(source, written, isPublished)} alt={alt ?? ""} {...rest} />;
    },
  };

  return (
    <div className={slug === "tutorial" ? "prose tutorial-prose" : "prose"}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={components}>
        {body}
      </ReactMarkdown>
    </div>
  );
}
