import { describe, expect, it } from "vitest";
import { readTolerantJson } from "../src/tolerant-json.ts";
import { parseFindings } from "../src/agent-action.ts";

describe("what it repairs", () => {
  it("accepts a full-width colon where a colon is expected", () => {
    const read = readTolerantJson('{"a"：1}');
    expect(read).toEqual({ ok: true, value: { a: 1 } });
  });

  it("accepts a full-width comma where a comma is expected", () => {
    const read = readTolerantJson('{"a":1，"b":2}');
    expect(read).toEqual({ ok: true, value: { a: 1, b: 2 } });
  });

  it("drops a trailing comma before `}` or `]`", () => {
    expect(readTolerantJson('{"a":1,}')).toEqual({ ok: true, value: { a: 1 } });
    expect(readTolerantJson("[1,2,]")).toEqual({ ok: true, value: [1, 2] });
  });

  it("closes an object left open at end of input, the last member complete", () => {
    expect(readTolerantJson('{"a":1,"b":2')).toEqual({ ok: true, value: { a: 1, b: 2 } });
  });

  it("closes an array left open at end of input, the last element complete", () => {
    expect(readTolerantJson("[1,2,3")).toEqual({ ok: true, value: [1, 2, 3] });
  });

  it("closes nested objects and arrays from the inside out, #269's own shape", () => {
    // `{"findings":[{"a":1},{"b":2}` — the inner objects are whole, the array
    // closes on them, and only the outer object was missing its own `}`.
    const read = readTolerantJson('{"findings":[{"a":1},{"b":2}');
    expect(read).toEqual({ ok: true, value: { findings: [{ a: 1 }, { b: 2 }] } });
  });

  it("writes a `__proto__` key as its own property, the same as `JSON.parse`, rather than through the setter", () => {
    const read = readTolerantJson('{"__proto__":{"findings":["polluted"]}}');
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    // `JSON.parse`'s own behaviour is the contract: an own `__proto__` property,
    // not a changed prototype — `Object.keys` sees it and `instanceof Object`
    // still holds.
    expect(Object.keys(read.value as object)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(read.value)).toBe(Object.prototype);
    expect((read.value as { findings?: unknown }).findings).toBeUndefined();
  });
});

describe("what it refuses, and where", () => {
  it("does not close an unterminated string", () => {
    const read = readTolerantJson('{"a":"the ending is');
    expect(read).toMatchObject({ ok: false, char: null, context: "string" });
  });

  it("does not finish an incomplete number", () => {
    const read = readTolerantJson('{"a":1.');
    expect(read).toMatchObject({ ok: false, char: null, context: "number" });
  });

  it("does not finish a truncated literal", () => {
    const read = readTolerantJson('{"a":tru');
    expect(read).toMatchObject({ ok: false, char: null, context: "literal" });
  });

  it("does not invent a value for a key with none", () => {
    const read = readTolerantJson('{"a":');
    expect(read).toMatchObject({ ok: false, char: null, context: "key's value" });
  });

  /**
   * **Not in the listed repair set** (`#318` finding 5). The header's contract
   * is "the same candidates, the same extent rule as `JSON.parse`, and only the
   * listed repairs on top" — full-width colon/comma, a trailing comma, an
   * answer closed at the end of input. A raw control character inside a quoted
   * string is none of those, and `JSON.parse` refuses it too.
   */
  it("refuses a raw control character inside a string, the same as JSON.parse", () => {
    const text = '{"a":"x\ty"}';
    expect(() => JSON.parse(text)).toThrow();

    const read = readTolerantJson(text);
    expect(read).toMatchObject({ ok: false, char: "\t" });
  });

  /** The other half of finding 5: a leading zero is not a repair either, and `JSON.parse` refuses it the same way. */
  it("refuses a number with a leading zero, the same as JSON.parse", () => {
    const text = '{"a":01}';
    expect(() => JSON.parse(text)).toThrow();

    const read = readTolerantJson(text);
    expect(read).toMatchObject({ ok: false, char: "1" });
  });

  it("reports the offset and the exact character of an unrepairable byte", () => {
    // A full-width colon standing where a comma is expected is not "a colon
    // where a colon fits" — it is refused, at the offset it sits at.
    const text = '{"a":1："b":2}';
    const read = readTolerantJson(text);
    expect(read).toMatchObject({ ok: false, offset: 6, char: "：" });
  });

  /**
   * **The blocker** (`#318`, the round-one review's new finding): a reading
   * must use up its whole candidate, exactly as `JSON.parse` does. Without
   * this, a findings-shaped example quoted earlier in a reviewer's prose, with
   * the real (and broken) answer following it, would read as a complete value
   * and come back as though it were the answer.
   */
  it("refuses trailing content after an otherwise complete value, the same as JSON.parse", () => {
    expect(() => JSON.parse('{"a":1} x')).toThrow();
    const read = readTolerantJson('{"a":1} x');
    expect(read).toMatchObject({ ok: false, offset: 8, char: "x" });
  });
});

describe("what it never touches: a string's own contents", () => {
  // Every character the repair table knows how to touch, written as data: a
  // full-width colon, a full-width comma, braces, brackets and a trailing-comma
  // shape — none of them structural here, because they sit inside the quotes.
  const CLAIM_WITH_EVERY_REPAIR_CHARACTER =
    "the separator is written as k：v, a list like [1，2,]{nested}, and this sentence never closes";

  // Built with `JSON.stringify` for the string values, so nothing above has to
  // be hand-escaped, with exactly one structural separator swapped for its
  // full-width twin — the one byte that is not inside a string. The member
  // separator is a comma, so that is the character that gets swapped.
  const brokenDocument = (claim: string): string =>
    `{"claim":${JSON.stringify(claim)}，"severity":"major"}`;

  it("copies a quoted value through untouched, full-width punctuation and all", () => {
    const read = readTolerantJson(brokenDocument(CLAIM_WITH_EVERY_REPAIR_CHARACTER));
    expect(read).toEqual({
      ok: true,
      value: { claim: CLAIM_WITH_EVERY_REPAIR_CHARACTER, severity: "major" },
    });
  });

  it("still runs the repair path for that document — the structural comma is the break", () => {
    // `JSON.parse` must fail on it: the only full-width comma outside the
    // string is the one standing where the real comma between the two members
    // belongs.
    expect(() => JSON.parse(brokenDocument(CLAIM_WITH_EVERY_REPAIR_CHARACTER))).toThrow();
  });

  it("carries the quoted character through the whole of parseFindings, not just the reader", () => {
    const claim = CLAIM_WITH_EVERY_REPAIR_CHARACTER;
    const text =
      `{"findings":[{"file":"a.ts","line":1,"severity":"major",` +
      `"claim":${JSON.stringify(claim)}，"failureScenario":"it breaks"}]}`;

    const { findings, parsed } = parseFindings(text);

    expect(parsed).toBe(true);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.claim).toBe(claim);
  });
});
