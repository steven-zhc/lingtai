"use client";

import { useRef, useState } from "react";

/**
 * The install line, with a button that copies it.
 *
 * The command is **the text on the page and nothing else** — the button copies
 * what `command` says, so what is shown and what is pasted into a shell cannot
 * disagree. A client component for the one thing that needs the browser; the
 * rest of the home page stays static.
 *
 * `execCommand` is the fallback for a page served over plain HTTP or an older
 * browser, where `navigator.clipboard` does not exist: the command is selected
 * from the DOM and copied the old way, so the button works wherever the line can
 * be read.
 */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const text = useRef<HTMLElement>(null);

  async function copy() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(command);
      ok = true;
    } catch {
      const node = text.current;
      if (node !== null) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        ok = document.execCommand("copy");
        selection?.removeAllRanges();
      }
    }
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  }

  return (
    <div className="command install-line">
      <span aria-hidden="true">$</span>
      <code ref={text}>{command}</code>
      <button type="button" className="copy" onClick={copy} aria-label="Copy the install command">
        {copied ? "Copied" : "Copy"}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </div>
  );
}
