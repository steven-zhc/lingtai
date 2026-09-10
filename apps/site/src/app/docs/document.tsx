import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { resolveHref } from "@/lib/docs";

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
 * **Raw HTML stays out.** `react-markdown` drops HTML nodes unless `rehype-raw`
 * is added, and it is not added; `rehype-sanitize` runs anyway. These files are
 * the repository's own and are as trusted as the build that reads them, which
 * is exactly why the guard belongs here rather than in a judgement about the
 * source: a pipeline that is safe because of who wrote today's input is a
 * pipeline that is unsafe the first time that changes.
 */
export function Document({
  slug,
  body,
  published,
}: {
  /** The document's own route, which relative links are resolved against. */
  slug: string;
  body: string;
  /** Every file the site projects, so a link can tell a page from a blob. */
  published: string[];
}) {
  const isPublished = (file: string) => published.includes(file);
  const components: Components = {
    a({ href, children, ...rest }) {
      return (
        <a href={resolveHref(slug, href ?? "", isPublished)} {...rest}>
          {children}
        </a>
      );
    },
    img({ src, alt, ...rest }) {
      // Images in `doc/` are files in `doc/`, and the export does not carry
      // them. Pointed at the repository, where they are.
      return <img src={resolveHref(slug, typeof src === "string" ? src : "", isPublished)} alt={alt ?? ""} {...rest} />;
    },
  };

  return (
    <div className="prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={components}>
        {body}
      </ReactMarkdown>
    </div>
  );
}
