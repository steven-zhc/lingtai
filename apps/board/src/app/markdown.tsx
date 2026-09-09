/**
 * A document, rendered the one way its source allows.
 *
 * The rule and its reasons are in `lib/markdown.ts`; this is the only place
 * that acts on them. Nothing on this page passes text to a renderer directly —
 * it passes a source, and `DocumentBody` decides — so "a log rendered as
 * markdown" is not a mistake a call site can make. That is the difference
 * between a rule and a convention.
 *
 * ## The ticket body is untrusted input
 *
 * Anyone who can file an issue on a managed repository writes it, and the board
 * renders it on the operator's own origin, next to the buttons that approve
 * merges. Four things follow, and none of them is optional:
 *
 * - **No raw HTML.** `react-markdown` drops HTML nodes unless `rehype-raw` is
 *   added, and it is not added here. `rehype-sanitize` runs anyway, because a
 *   plugin somebody adds later must not silently open the door.
 * - **A library's sanitiser, at its defaults.** `defaultSchema` is GitHub's own
 *   allowlist, including the `user-content-` prefixing that stops a crafted
 *   `id` from clobbering this page's DOM. A hand-rolled subset for untrusted
 *   input is the thing #106 says explicitly not to build.
 * - **No image is ever fetched.** `img` renders as a link, so a tracking pixel
 *   in an issue body costs a click and not a request from the board's origin.
 *   Blocking it here rather than in the schema keeps the alt text: the reader
 *   is told an image was there and what it claimed to be.
 * - **A link does not read as trusted chrome.** `.mdlink` is not the accent
 *   `.tlink` the page's own links use — amber means *a human is being waited
 *   on* and appears once per screen — and it carries `nofollow ugc noreferrer`
 *   and an outbound mark.
 */
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { renderingFor, type DocumentSource } from "@/lib/markdown";

const COMPONENTS: Components = {
  /**
   * A link out, marked as one.
   *
   * A fragment is left alone: GFM footnotes link to themselves, and opening a
   * new tab on `#user-content-fn-1` would be nonsense.
   */
  a({ href, children, ...rest }) {
    if (typeof href === "string" && href.startsWith("#")) {
      return (
        <a href={href} {...rest}>
          {children}
        </a>
      );
    }
    return (
      <a className="mdlink" href={href} target="_blank" rel="noreferrer nofollow ugc">
        {children}
        <span className="mdout" aria-hidden="true">
          {" ↗"}
        </span>
      </a>
    );
  },

  /**
   * Never an `<img>`. The src is what the sanitiser allowed — `http` or
   * `https`, nothing else — and it is offered rather than fetched.
   */
  img({ src, alt }) {
    const url = typeof src === "string" ? src : "";
    const said = alt && alt.trim() ? alt : url;
    return (
      <a className="mdimg" href={url} target="_blank" rel="noreferrer nofollow ugc">
        image: {said} ↗
      </a>
    );
  },
};

/** The renderer, configured once. Reached only through `DocumentBody`. */
function Rendered({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/**
 * A document, in the form its source earns.
 *
 * `rawClass` says how raw text looks *here* — the ticket body and a payload
 * document sit in different boxes — and is used by every rendering except
 * `rendered`, which brings its own.
 */
export function DocumentBody({
  source,
  text,
  rawClass,
}: {
  source: DocumentSource;
  text: string;
  rawClass: string;
}) {
  const rendering = renderingFor(source);

  if (rendering === "rendered") return <Rendered text={text} />;

  return (
    <>
      {/* `pre-wrap`, so a selection copies out as the document rather than as
          one very long line — the thing somebody reproducing a run by hand
          pastes into `claude -p`. */}
      <pre className={rawClass}>{text}</pre>
      {/* Offered, never taken by default: the raw form above is the record and
          this is a reading of it. A `details` rather than a toggle because the
          page has no client JavaScript here and does not need any. */}
      {rendering === "on request" ? (
        <details className="mdask">
          <summary>Read as markdown</summary>
          <Rendered text={text} />
        </details>
      ) : null}
    </>
  );
}
