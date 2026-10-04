/**
 * A JSON reader that repairs exactly two things a reviewer's answer has broken
 * twice (`#318`): full-width punctuation standing in for a structural token,
 * and an answer that stopped writing before its outermost braces closed.
 *
 * **It is not a general "accept anything" reader**, and that is the whole
 * safety argument for using it in place of a library. `jsonrepair` and its
 * relatives are built to make *anything* parse, including turning stray prose
 * into a string value — exactly the failure mode `parseFindings` cannot afford,
 * because a finding's `claim` routinely quotes code and comments verbatim. This
 * reader is a hand-rolled recursive-descent tokenizer with one escape hatch:
 *
 * - **A full-width colon or comma (`：` U+FF1A, `，` U+FF0C) is accepted exactly
 *   where the ASCII one is expected** — between a key and its value, or between
 *   two members or elements. The string scanner (`parseString`) never consults
 *   this table, so a full-width character *inside* a quoted value is copied
 *   through unchanged: the repair table and the string scanner are separate
 *   code paths, and that separation is what makes a quoted comment safe.
 * - **A trailing comma before `]` or `}`** is dropped.
 * - **End of input while an array or object is still open, with the last value
 *   in it already complete**, closes it. An unterminated string, an unfinished
 *   number or literal, and a key with no value are not repaired — those report
 *   a failure at the offset where the input ran out.
 *
 * Every failure reports where it happened, because the one thing a hand-written
 * reader can promise over `JSON.parse` is that position: V8 reports an offset
 * for some syntax errors and not for others.
 *
 * **The contract is one sentence: the same candidates, the same extent rule as
 * `JSON.parse`, and only the listed repairs on top.** `JSON.parse` refuses
 * trailing content after a complete value (`JSON.parse('{"a":1} x')` throws),
 * and this reader must refuse it too — otherwise a findings-shaped example
 * quoted in a reviewer's prose, with the reviewer's real (and broken) answer
 * following it, would read as a complete value and be returned as though it
 * were the answer, fabricated findings and all (`#318`, the round-one review).
 */

export type TolerantParseResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      /** Where reading stopped, as an index into the string handed in. */
      offset: number;
      /** The character found there, or `null` when input ran out first. */
      char: string | null;
      /** Only set when `char` is `null`: what was still open at that point. */
      context?: string;
      /**
       * **Set only when a complete top-level value was read before this
       * failure** — the extent rule's own refusal, not a syntax error inside
       * the value (`#318`). A caller that wants to know whether the bytes
       * handed in even attempted JSON cannot read that off `char`/`offset`
       * alone: an object that reads fine and is simply followed by unrelated
       * text fails at the same shape of position as one that never parsed at
       * all. This is the value that was read, so a caller can tell the two
       * apart without guessing from the character that happens to sit after it.
       */
      trailingValue?: unknown;
    };

const FULL_WIDTH_COLON = "：";
const FULL_WIDTH_COMMA = "，";
const LITERALS: ReadonlyArray<{ word: string; value: unknown }> = [
  { word: "true", value: true },
  { word: "false", value: false },
  { word: "null", value: null },
];

/** Reads one JSON value from the start of `text`, tolerating the repairs above. */
export function readTolerantJson(text: string): TolerantParseResult {
  const len = text.length;
  let i = 0;

  const fail = (offset: number, char: string | null, context?: string): TolerantParseResult =>
    context === undefined ? { ok: false, offset, char } : { ok: false, offset, char, context };

  const skipWhitespace = (): void => {
    while (i < len && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  };

  function parseValue(): TolerantParseResult {
    skipWhitespace();
    if (i >= len) return fail(i, null, "value");
    const ch = text[i]!;
    if (ch === '"') return parseString();
    if (ch === "{") return parseObject();
    if (ch === "[") return parseArray();
    if (ch === "-" || (ch >= "0" && ch <= "9")) return parseNumber();
    for (const { word, value } of LITERALS) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return { ok: true, value };
      }
    }
    // A literal cut short by the end of the text reads as "ran out inside a
    // literal" rather than "found an unexpected character", because the
    // character it found was the literal's own first letter.
    const remaining = text.slice(i);
    for (const { word } of LITERALS) {
      if (remaining.length > 0 && remaining.length < word.length && word.startsWith(remaining)) {
        return fail(len, null, "literal");
      }
    }
    return fail(i, ch);
  }

  function parseString(): TolerantParseResult {
    const start = i;
    i++; // opening quote
    let out = "";
    while (i < len) {
      const ch = text[i]!;
      if (ch === '"') {
        i++;
        return { ok: true, value: out };
      }
      if (ch === "\\") {
        i++;
        if (i >= len) return fail(i, null, "string");
        const esc = text[i]!;
        if (esc === "u") {
          const hex = text.slice(i + 1, i + 5);
          if (hex.length < 4 || /[^0-9a-fA-F]/.test(hex)) return fail(i, null, "string");
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 5;
          continue;
        }
        const simple: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (!(esc in simple)) return fail(i, esc);
        out += simple[esc];
        i++;
        continue;
      }
      // JSON disallows a raw control character inside a quoted string — it
      // must arrive escaped (`\n`, `\t`, `\u0001`, …) — and this reader is not
      // the place to start accepting one unescaped: that is not in the listed
      // repair set, and a reviewer's `claim` quoting code verbatim is exactly
      // the text a silent exception here would corrupt.
      if (ch.charCodeAt(0) < 0x20) return fail(i, ch);
      out += ch;
      i++;
    }
    // Ran off the end still inside the quotes: not repaired, by design — a
    // string a reviewer meant to keep writing is not one this reader guesses
    // the end of. The offset is where reading stopped, not where the string
    // started: "it ended at offset N" is what a person reads.
    return fail(i, null, "string");
  }

  function parseNumber(): TolerantParseResult {
    const start = i;
    if (text[i] === "-") i++;
    const digitsStart = i;
    // JSON's own grammar: a leading zero is a complete integer part on its
    // own — "0", never "00" or "01" — so only the single digit is consumed
    // here, and a digit immediately following it is refused below rather than
    // silently absorbed the way `007` would be.
    if (text[i] === "0") i++;
    else while (i < len && text[i]! >= "0" && text[i]! <= "9") i++;
    if (i === digitsStart) return fail(i, i < len ? text[i]! : null, "number");
    if (i < len && text[i]! >= "0" && text[i]! <= "9") return fail(i, text[i]!);
    if (text[i] === ".") {
      i++;
      const fracStart = i;
      while (i < len && text[i]! >= "0" && text[i]! <= "9") i++;
      if (i === fracStart) return fail(i, i < len ? text[i]! : null, "number");
    }
    if (text[i] === "e" || text[i] === "E") {
      i++;
      if (text[i] === "+" || text[i] === "-") i++;
      const expStart = i;
      while (i < len && text[i]! >= "0" && text[i]! <= "9") i++;
      if (i === expStart) return fail(i, i < len ? text[i]! : null, "number");
    }
    return { ok: true, value: Number(text.slice(start, i)) };
  }

  function parseObject(): TolerantParseResult {
    i++; // {
    const obj: Record<string, unknown> = {};
    skipWhitespace();
    if (i >= len) return { ok: true, value: obj }; // Ran out right after `{`.
    if (text[i] === "}") {
      i++;
      return { ok: true, value: obj };
    }

    for (;;) {
      skipWhitespace();
      if (i >= len) return { ok: true, value: obj }; // Ran out between members: close.
      if (text[i] !== '"') return fail(i, text[i]!);
      const key = parseString();
      if (!key.ok) return key;
      skipWhitespace();
      if (i >= len) return fail(i, null, "key's value");
      const colon = text[i]!;
      if (colon === ":" || colon === FULL_WIDTH_COLON) i++;
      else return fail(i, colon);
      skipWhitespace();
      if (i >= len) return fail(i, null, "key's value");
      const value = parseValue();
      if (!value.ok) return value;
      // `CreateDataProperty`, not `obj[key] =`: a key literally named `__proto__`
      // must land as an own property the same way `JSON.parse` puts it, rather
      // than going through `Object.prototype`'s setter and changing `obj`'s
      // prototype instead of its contents.
      Object.defineProperty(obj, key.value as string, {
        value: value.value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      skipWhitespace();
      if (i >= len) return { ok: true, value: obj }; // Ran out after a complete member: close.
      const sep = text[i]!;
      if (sep === "}") {
        i++;
        return { ok: true, value: obj };
      }
      if (sep === "," || sep === FULL_WIDTH_COMMA) {
        i++;
        skipWhitespace();
        if (i >= len) return { ok: true, value: obj }; // Dangling comma, then nothing: close.
        if (text[i] === "}") {
          i++; // Trailing comma.
          return { ok: true, value: obj };
        }
        continue;
      }
      return fail(i, sep);
    }
  }

  function parseArray(): TolerantParseResult {
    i++; // [
    const arr: unknown[] = [];
    skipWhitespace();
    if (i >= len) return { ok: true, value: arr };
    if (text[i] === "]") {
      i++;
      return { ok: true, value: arr };
    }

    for (;;) {
      const value = parseValue();
      if (!value.ok) return value;
      arr.push(value.value);
      skipWhitespace();
      if (i >= len) return { ok: true, value: arr }; // Ran out after a complete element: close.
      const sep = text[i]!;
      if (sep === "]") {
        i++;
        return { ok: true, value: arr };
      }
      if (sep === "," || sep === FULL_WIDTH_COMMA) {
        i++;
        skipWhitespace();
        if (i >= len) return { ok: true, value: arr }; // Dangling comma, then nothing: close.
        if (text[i] === "]") {
          i++; // Trailing comma.
          return { ok: true, value: arr };
        }
        continue;
      }
      return fail(i, sep);
    }
  }

  const result = parseValue();
  if (!result.ok) return result;
  // The extent rule: `JSON.parse` throws on anything but whitespace after a
  // complete value, and this reader refuses it the same way rather than
  // silently returning the value it found first. `result.value` rides along
  // on the failure so a caller can tell this apart from a value that never
  // completed at all.
  skipWhitespace();
  if (i < len) return { ok: false, offset: i, char: text[i]!, trailingValue: result.value };
  return result;
}
