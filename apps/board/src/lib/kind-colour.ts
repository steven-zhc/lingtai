/**
 * A repository's own label colour, made safe to put on this board — or refused.
 *
 * The board's palette is not decorative and says so (`globals.css:1`): five
 * semantic hues, every one of them about *state*. Teal is structure, green is
 * pass, red is fail, purple is held, and **amber is reserved exclusively for "a
 * human is the thing being waited on"**. None of them is about taxonomy, and a
 * kind is a taxonomy, so a kind cannot take one of them.
 *
 * Nor can Lingtai make one up. Kinds are unbounded since #76 — any label a
 * repository chooses — so an invented hue would have to be derived from the
 * name, and a hash lands on amber or red eventually and silently: name a kind
 * `urgent` and it might come out the colour that means *a person is needed*.
 * The colour therefore comes from GitHub, where the repository's team already
 * chose one, and this file only decides whether it can be drawn.
 *
 * Two constraints, and they are the whole of the module.
 *
 * **The contrast floor.** GitHub's label colours are picked against GitHub's
 * light UI; this board has two themes. `#a2eeef` is legible there and vanishes
 * on `--surface` in the dark, and a fully saturated one glows on the light. So
 * the hue and the saturation — which are the repository's choice — are kept
 * exactly, and only the lightness moves, by the least that puts the colour's
 * relative luminance inside a band that clears 3:1 against both grounds.
 *
 * **Amber stays reserved.** A label that is already amber is refused outright
 * rather than rotated: rotating would be inventing a hue, which is the thing
 * this whole design is avoiding. A refused colour renders exactly as a kind
 * with no colour does — grey text and no dot — which is how every kind rendered
 * before #85, so nothing is lost that was not already absent.
 *
 * **This is the one place Lingtai overrides a repository's choice**, and it is
 * stated here because it is done here.
 */

/**
 * The amber the palette reserves is `--signal`: `#9c5a08` light, `#e0a55c`
 * dark, both hue 33°. The band around it is wide enough that a colour a person
 * would call amber, orange or gold cannot slip through — the collision is what
 * matters, not the exact token.
 */
const AMBER_FROM = 20;
const AMBER_TO = 55;

/**
 * Below this a colour reads as grey whatever its hue is, so a nominally amber
 * hue at this saturation is not amber to anybody looking at it, and refusing it
 * would cost a legible dot for nothing.
 */
const AMBER_MIN_SATURATION = 0.2;

/**
 * The luminance band, from 3:1 against both grounds.
 *
 * The dark card surface is `#131e22` (luminance 0.012), so `(L + 0.05) /
 * 0.062 >= 3` gives the floor; the light surface is `#ffffff`, so `1.05 / (L +
 * 0.05) >= 3` gives the ceiling. A dot is a small non-text mark, which is what
 * 3:1 is the threshold for.
 */
const LUM_MIN = 0.14;
const LUM_MAX = 0.3;

/**
 * The colour to draw a kind's dot in, or null for "draw no dot".
 *
 * Null covers both refusals and they are deliberately the same outcome: GitHub
 * had no colour for the label, or the colour it had is the one amber owns. The
 * caller renders the kind as grey text either way, which is what it did before
 * any of this existed.
 */
export function kindDot(color: string | null | undefined): string | null {
  const rgb = parseHex(color);
  if (rgb === null) return null;

  const { h, s, l } = toHsl(rgb);
  if (s >= AMBER_MIN_SATURATION && h >= AMBER_FROM && h <= AMBER_TO) return null;

  const lum = luminance(rgb);
  if (lum >= LUM_MIN && lum <= LUM_MAX) return toHex(rgb);

  // Hue and saturation are the repository's and do not move. Lightness is the
  // only axis touched, and only as far as the band's near edge — a colour that
  // is barely too pale comes back barely darker.
  return toHex(atLuminance(h, s, lum < LUM_MIN ? LUM_MIN + 0.005 : LUM_MAX - 0.005));
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `#rrggbb`, as `client.ts` normalises GitHub's answer to. Anything else is null. */
function parseHex(color: string | null | undefined): Rgb | null {
  if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) return null;
  return {
    r: Number.parseInt(color.slice(1, 3), 16) / 255,
    g: Number.parseInt(color.slice(3, 5), 16) / 255,
    b: Number.parseInt(color.slice(5, 7), 16) / 255,
  };
}

function toHex({ r, g, b }: Rgb): string {
  const part = (c: number) =>
    Math.round(Math.min(1, Math.max(0, c)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** WCAG relative luminance, which is what a contrast ratio is computed from. */
function luminance({ r, g, b }: Rgb): number {
  const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function toHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h =
    max === r
      ? 60 * (((g - b) / d + 6) % 6)
      : max === g
        ? 60 * ((b - r) / d + 2)
        : 60 * ((r - g) / d + 4);
  return { h, s, l };
}

function fromHsl(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return { r: r + m, g: g + m, b: b + m };
}

/**
 * The same hue and saturation at a given relative luminance.
 *
 * Bisection rather than arithmetic: luminance is monotonic in HSL lightness for
 * a fixed hue and saturation, and there is no closed form through the sRGB
 * transfer function worth writing. Twenty-four halvings put it well inside a
 * hex digit of the target.
 */
function atLuminance(h: number, s: number, target: number): Rgb {
  let lo = 0;
  let hi = 1;
  let rgb = fromHsl(h, s, 0.5);
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    rgb = fromHsl(h, s, mid);
    if (luminance(rgb) < target) lo = mid;
    else hi = mid;
  }
  return rgb;
}
