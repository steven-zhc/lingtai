/**
 * Reads `doc/rate-card.md` into rows — a test's job only. The pricing itself
 * (`RateRow`, `rateFor`, `priceTokens`) lives in `src/rate-card.ts` since #645;
 * `unit/rate-card.test.ts` holds its compiled `RATE_CARD` equal to what this
 * parses from the file.
 */
import type { RateRow } from '../src/rate-card.ts'

/**
 * One row per `| from | model | mode | input | output | cache read | cache
 * write |` line in `doc/rate-card.md`. Every other line — prose, headings,
 * the header row itself — does not match and is skipped.
 */
const ROW =
  /^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*`([^`]+)`\s*\|\s*([^|]*)\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*$/

export function parseRateCard(markdown: string): RateRow[] {
  const rows: RateRow[] = []
  for (const line of markdown.split('\n')) {
    const m = ROW.exec(line.trim())
    if (!m) continue
    rows.push({
      from: m[1]!,
      model: m[2]!,
      mode: m[3]!.trim(),
      input: Number(m[4]),
      output: Number(m[5]),
      cacheRead: Number(m[6]),
      cacheWrite: Number(m[7]),
    })
  }
  return rows
}
