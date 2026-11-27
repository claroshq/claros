/**
 * Logo background detection and removal, on raw RGBA pixels.
 *
 * A logo exported on a solid white (or other light) background shows as a
 * light box when the email is read in dark mode. Before an upload the
 * dashboard decodes the image, asks analyzeLogo whether it has such a
 * background, and offers removeBackground's transparent version instead.
 *
 * Pure logic, no DOM: logo-image.ts does the decoding and encoding.
 *
 * Removal is not a global "white becomes transparent": that would also
 * erase white parts of the logo. Instead:
 *   1. Pixels within MATCH_TOLERANCE of the background color that are
 *      connected to the image border are cleared (a flood fill). With
 *      clearEnclosed, enclosed areas of that color (the holes in "o", "d",
 *      "p") of at least MIN_ENCLOSED_PIXELS are cleared as well.
 *   2. Pixels within EDGE_RADIUS of a cleared pixel that are near-background
 *      halos, or sit on a gradient into the logo, are anti-aliased edges: a
 *      mix of logo color and background. They get a partial alpha and their
 *      color is un-mixed from the background (color to alpha), so no light
 *      halo is left around the shapes. Flat pale shapes keep their edges.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export type LogoAnalysis =
  /** The image already has transparent pixels on its border: nothing to do. */
  | { kind: "transparent" }
  /** A uniform light background fills the border: removal is offered. */
  | { kind: "light-background"; background: Rgb }
  /** Anything else (dark or colored background, artwork to the edge). */
  | { kind: "other" };

/** Largest per-channel difference for a pixel to count as background. */
export const MATCH_TOLERANCE = 12;
/** Share of border pixels that must match the background color. */
export const BORDER_MATCH_SHARE = 0.9;
/** Smallest relative luminance (0..1) of a background that counts as light. */
export const LIGHT_LUMINANCE = 0.75;
/** Distance, in pixels, from a cleared pixel within which edges are un-mixed. */
export const EDGE_RADIUS = 2;
/** Smallest enclosed area cleared with clearEnclosed; smaller ones are compression specks. */
export const MIN_ENCLOSED_PIXELS = 6;
/** An edge pixel at most this opaque against the background is a halo and is always un-mixed. */
export const HALO_ALPHA = 16 / 255;
/** How much more opaque a neighbour must be for a pixel to count as an anti-aliased edge. */
export const EDGE_STEP = 0.1;
/** Body color of the built-in layouts in dark mode (packages/core/src/email-shell.ts). */
export const DARK_MAIL_BG: Rgb = { r: 0x1a, g: 0x1a, b: 0x1a };

function relativeLuminance({ r, g, b }: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Indexes (pixel numbers, not byte offsets) of the 1px border ring. */
function borderPixels(width: number, height: number): number[] {
  const out: number[] = [];
  for (let x = 0; x < width; x++) {
    out.push(x);
    if (height > 1) out.push((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    out.push(y * width);
    if (width > 1) out.push(y * width + width - 1);
  }
  return out;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function matches(data: Uint8ClampedArray, p: number, bg: Rgb, tolerance: number): boolean {
  const o = p * 4;
  return (
    data[o + 3]! >= 250 &&
    Math.abs(data[o]! - bg.r) <= tolerance &&
    Math.abs(data[o + 1]! - bg.g) <= tolerance &&
    Math.abs(data[o + 2]! - bg.b) <= tolerance
  );
}

/** Decide whether the image sits on a uniform light background. */
export function analyzeLogo(data: Uint8ClampedArray, width: number, height: number): LogoAnalysis {
  if (width < 1 || height < 1 || data.length < width * height * 4) return { kind: "other" };
  const ring = borderPixels(width, height);
  if (ring.some((p) => data[p * 4 + 3]! < 250)) return { kind: "transparent" };

  const background: Rgb = {
    r: median(ring.map((p) => data[p * 4]!)),
    g: median(ring.map((p) => data[p * 4 + 1]!)),
    b: median(ring.map((p) => data[p * 4 + 2]!)),
  };
  const matching = ring.filter((p) => matches(data, p, background, MATCH_TOLERANCE)).length;
  if (matching / ring.length < BORDER_MATCH_SHARE) return { kind: "other" };
  if (relativeLuminance(background) < LIGHT_LUMINANCE) return { kind: "other" };
  return { kind: "light-background", background };
}

export interface RemoveOptions {
  /** Also clear enclosed areas of the background color (letter holes). */
  clearEnclosed: boolean;
}

/**
 * Alpha a pixel needs so that it equals `color` composited over `bg`, at
 * the least opacity (GIMP's color to alpha). 0 when color equals bg.
 */
function alphaOver(c: number, bg: number): number {
  if (c > bg) return bg === 255 ? 0 : (c - bg) / (255 - bg);
  if (c < bg) return bg === 0 ? 0 : (bg - c) / bg;
  return 0;
}

/**
 * A copy of the image with the background cleared. The input is not
 * changed. Returns the new pixels and how many pixels became fully
 * transparent.
 */
export function removeBackground(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  background: Rgb,
  options: RemoveOptions,
): { data: Uint8ClampedArray<ArrayBuffer>; cleared: number } {
  const total = width * height;
  const out = new Uint8ClampedArray(data.length);
  out.set(data);
  const clear = new Uint8Array(total);

  // 4-connected components of background-colored pixels. The ones that
  // touch the border are the background; enclosed ones (letter holes) are
  // cleared with clearEnclosed unless they are specks of compression noise.
  const seen = new Uint8Array(total);
  const component = (seed: number): number[] => {
    const pixels = [seed];
    seen[seed] = 1;
    for (let i = 0; i < pixels.length; i++) {
      const p = pixels[i]!;
      const x = p % width;
      const y = (p - x) / width;
      const next = [
        x > 0 ? p - 1 : -1,
        x < width - 1 ? p + 1 : -1,
        y > 0 ? p - width : -1,
        y < height - 1 ? p + width : -1,
      ];
      for (const n of next) {
        if (n >= 0 && !seen[n] && matches(data, n, background, MATCH_TOLERANCE)) {
          seen[n] = 1;
          pixels.push(n);
        }
      }
    }
    return pixels;
  };
  for (const p of borderPixels(width, height)) {
    if (!seen[p] && matches(data, p, background, MATCH_TOLERANCE)) for (const q of component(p)) clear[q] = 1;
  }
  if (options.clearEnclosed) {
    for (let p = 0; p < total; p++) {
      if (seen[p] || !matches(data, p, background, MATCH_TOLERANCE)) continue;
      const pixels = component(p);
      if (pixels.length >= MIN_ENCLOSED_PIXELS) for (const q of pixels) clear[q] = 1;
    }
  }

  let cleared = 0;
  for (let p = 0; p < total; p++) {
    if (clear[p]) {
      out[p * 4 + 3] = 0;
      cleared++;
    }
  }

  // Un-mix the anti-aliased edge pixels near anything cleared. A pixel
  // counts as an edge when it is almost background (a halo) or when a
  // neighbour is clearly more opaque against the background (it sits on a
  // gradient into the logo). A flat light shape, such as a pale gray box,
  // has neither and keeps its edge.
  const b = [background.r, background.g, background.b] as const;
  const alpha = new Float32Array(total);
  for (let p = 0; p < total; p++) {
    const o = p * 4;
    alpha[p] = Math.max(alphaOver(data[o]!, b[0]), alphaOver(data[o + 1]!, b[1]), alphaOver(data[o + 2]!, b[2]));
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (clear[p]) continue;
      let nearCleared = false;
      let maxNeighbour = 0;
      for (let dy = -EDGE_RADIUS; dy <= EDGE_RADIUS; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -EDGE_RADIUS; dx <= EDGE_RADIUS; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width || (dx === 0 && dy === 0)) continue;
          const n = yy * width + xx;
          if (clear[n]) nearCleared = true;
          else if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) maxNeighbour = Math.max(maxNeighbour, alpha[n]!);
        }
      }
      if (!nearCleared) continue;
      const a = alpha[p]!;
      if (a > HALO_ALPHA && maxNeighbour - a < EDGE_STEP) continue;

      const o = p * 4;
      if (a <= 0) {
        out[o + 3] = 0;
        cleared++;
        continue;
      }
      for (let i = 0; i < 3; i++) out[o + i] = Math.round((data[o + i]! - (1 - a) * b[i]!) / a);
      out[o + 3] = Math.round((a * data[o + 3]!));
    }
  }

  return { data: out, cleared };
}

function contrastRatio(x: Rgb, y: Rgb): number {
  const a = relativeLuminance(x);
  const b = relativeLuminance(y);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Share (0..1) of a logo's visible pixels (alpha at least half) whose
 * contrast against `bg` is below 3:1, the WCAG minimum for graphics.
 * Removing a background does not help a dark logo on a dark mail body;
 * the dashboard uses this to say so.
 */
export function lowContrastShare(data: Uint8ClampedArray, width: number, height: number, bg: Rgb = DARK_MAIL_BG): number {
  let visible = 0;
  let low = 0;
  for (let p = 0; p < width * height; p++) {
    const o = p * 4;
    if (data[o + 3]! < 128) continue;
    visible++;
    if (contrastRatio({ r: data[o]!, g: data[o + 1]!, b: data[o + 2]! }, bg) < 3) low++;
  }
  return visible ? low / visible : 0;
}

/** Lightness range of a recolored pixel in the dark-mode version (HSL, 0..1). */
const DARK_VARIANT_MIN_L = 0.75;
const DARK_VARIANT_MAX_L = 0.94;
/** Contrast a recolored pixel is lifted to, where the lightness range allows. */
const DARK_VARIANT_CONTRAST = 4.5;

function rgbToHsl({ r, g, b }: Rgb): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue(p, q, h + 1 / 3) * 255),
    g: Math.round(hue(p, q, h) * 255),
    b: Math.round(hue(p, q, h - 1 / 3) * 255),
  };
}

/**
 * The logo's dark-mode version: every visible pixel with less than 3:1
 * contrast against `bg` gets its lightness inverted (kept between 75% and
 * 94%, raised toward 4.5:1), with hue, saturation and alpha unchanged. A
 * black or navy wordmark becomes off-white, a dark green one pale green;
 * colors that already read on dark (an accent dot, a mid gray) are left
 * alone. Meant for a logo whose background is already transparent.
 */
export function darkVariant(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  bg: Rgb = DARK_MAIL_BG,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(data.length);
  out.set(data);
  for (let p = 0; p < width * height; p++) {
    const o = p * 4;
    if (data[o + 3]! === 0) continue;
    const c = { r: data[o]!, g: data[o + 1]!, b: data[o + 2]! };
    if (contrastRatio(c, bg) >= 3) continue;
    const [h, s, l] = rgbToHsl(c);
    let lightness = Math.min(DARK_VARIANT_MAX_L, Math.max(DARK_VARIANT_MIN_L, 1 - l));
    let next = hslToRgb(h, s, lightness);
    while (contrastRatio(next, bg) < DARK_VARIANT_CONTRAST && lightness < DARK_VARIANT_MAX_L) {
      lightness = Math.min(DARK_VARIANT_MAX_L, lightness + 0.02);
      next = hslToRgb(h, s, lightness);
    }
    out[o] = next.r;
    out[o + 1] = next.g;
    out[o + 2] = next.b;
  }
  return out;
}
