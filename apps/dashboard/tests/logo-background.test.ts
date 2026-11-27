import { describe, expect, it } from "vitest";
import { analyzeLogo, darkVariant, lowContrastShare, removeBackground } from "../src/lib/logo-background.js";

type Px = [number, number, number, number];
const W: Px = [255, 255, 255, 255];
const K: Px = [0, 0, 0, 255];
const R: Px = [200, 30, 40, 255];
const T: Px = [0, 0, 0, 0];

function image(rows: Px[][]): { data: Uint8ClampedArray; width: number; height: number } {
  const height = rows.length;
  const width = rows[0]!.length;
  const data = new Uint8ClampedArray(width * height * 4);
  rows.flat().forEach((px, i) => data.set(px, i * 4));
  return { data, width, height };
}

function alphaAt(data: Uint8ClampedArray, width: number, x: number, y: number): number {
  return data[(y * width + x) * 4 + 3]!;
}

/** 11x11: white background, a black ring (rows/cols 2..8) with a 3x3 white hole in the middle. */
function ringLogo() {
  const rows: Px[][] = [];
  for (let y = 0; y < 11; y++) {
    const row: Px[] = [];
    for (let x = 0; x < 11; x++) {
      const inSquare = x >= 2 && x <= 8 && y >= 2 && y <= 8;
      const inHole = x >= 4 && x <= 6 && y >= 4 && y <= 6;
      row.push(inSquare && !inHole ? K : W);
    }
    rows.push(row);
  }
  return image(rows);
}

describe("analyzeLogo", () => {
  it("finds a white background", () => {
    const { data, width, height } = ringLogo();
    expect(analyzeLogo(data, width, height)).toEqual({ kind: "light-background", background: { r: 255, g: 255, b: 255 } });
  });

  it("reports an image that is already transparent", () => {
    const { data, width, height } = image([
      [T, T, T],
      [T, K, T],
      [T, T, T],
    ]);
    expect(analyzeLogo(data, width, height).kind).toBe("transparent");
  });

  it("ignores a dark or colored background", () => {
    const dark = image([
      [K, K, K],
      [K, W, K],
      [K, K, K],
    ]);
    expect(analyzeLogo(dark.data, dark.width, dark.height).kind).toBe("other");
    const red = image([
      [R, R, R],
      [R, W, R],
      [R, R, R],
    ]);
    expect(analyzeLogo(red.data, red.width, red.height).kind).toBe("other");
  });

  it("ignores artwork that runs to the edge", () => {
    const { data, width, height } = image([
      [K, K, W, W],
      [K, K, W, W],
      [K, K, W, W],
      [K, K, W, W],
    ]);
    expect(analyzeLogo(data, width, height).kind).toBe("other");
  });

  it("accepts near-white JPEG noise on the border", () => {
    const n: Px = [246, 250, 243, 255];
    const { data, width, height } = image([
      [W, n, W],
      [n, K, W],
      [W, W, n],
    ]);
    expect(analyzeLogo(data, width, height).kind).toBe("light-background");
  });
});

describe("removeBackground", () => {
  const white = { r: 255, g: 255, b: 255 };

  it("clears the outer background and keeps the logo opaque", () => {
    const { data, width, height } = ringLogo();
    const out = removeBackground(data, width, height, white, { clearEnclosed: false });
    expect(alphaAt(out.data, width, 0, 0)).toBe(0);
    expect(alphaAt(out.data, width, 10, 10)).toBe(0);
    expect(alphaAt(out.data, width, 2, 2)).toBe(255);
    // The enclosed hole stays without clearEnclosed.
    expect(alphaAt(out.data, width, 5, 5)).toBe(255);
    // Input untouched.
    expect(alphaAt(data, width, 0, 0)).toBe(255);
  });

  it("clears enclosed holes with clearEnclosed", () => {
    const { data, width, height } = ringLogo();
    const out = removeBackground(data, width, height, white, { clearEnclosed: true });
    expect(alphaAt(out.data, width, 5, 5)).toBe(0);
    expect(alphaAt(out.data, width, 2, 2)).toBe(255);
  });

  it("keeps a single white speck inside a shape", () => {
    const rows: Px[][] = [];
    for (let y = 0; y < 7; y++) {
      const row: Px[] = [];
      for (let x = 0; x < 7; x++) row.push(x >= 1 && x <= 5 && y >= 1 && y <= 5 && !(x === 3 && y === 3) ? K : W);
      rows.push(row);
    }
    const { data, width, height } = image(rows);
    const out = removeBackground(data, width, height, white, { clearEnclosed: true });
    expect(alphaAt(out.data, width, 0, 0)).toBe(0);
    expect(alphaAt(out.data, width, 3, 3)).toBe(255);
  });

  it("turns an anti-aliased gray edge into semi-transparent black", () => {
    const g: Px = [128, 128, 128, 255];
    const { data, width, height } = image([
      [W, W, W, W, W],
      [W, g, K, K, W],
      [W, W, W, W, W],
    ]);
    const out = removeBackground(data, width, height, white, { clearEnclosed: false });
    const o = (1 * width + 1) * 4;
    expect(out.data[o]).toBe(0);
    expect(out.data[o + 3]).toBeGreaterThan(120);
    expect(out.data[o + 3]).toBeLessThan(135);
  });

  it("keeps a colored pixel's hue when un-mixing it", () => {
    // 50% red over white.
    const pink: Px = [228, 143, 148, 255];
    // An anti-aliased edge of a red shape.
    const { data, width, height } = image([
      [W, W, W, W],
      [W, pink, R, W],
      [W, W, W, W],
    ]);
    const out = removeBackground(data, width, height, white, { clearEnclosed: false });
    const o = (1 * width + 1) * 4;
    const [r, g, b, a] = [out.data[o]!, out.data[o + 1]!, out.data[o + 2]!, out.data[o + 3]!];
    expect(a).toBeGreaterThan(100);
    expect(a).toBeLessThan(255);
    // Composited back over white it is the same pixel, and still red.
    const over = (c: number) => Math.round((c * a) / 255 + 255 * (1 - a / 255));
    expect(Math.abs(over(r) - pink[0])).toBeLessThanOrEqual(2);
    expect(Math.abs(over(g) - pink[1])).toBeLessThanOrEqual(2);
    expect(Math.abs(over(b) - pink[2])).toBeLessThanOrEqual(2);
    expect(r).toBeGreaterThan(g + 100);
  });
});

describe("removeBackground on a pale shape", () => {
  it("keeps a pale gray box and its edge opaque", () => {
    const G: Px = [232, 234, 238, 255];
    const rows: Px[][] = [];
    for (let y = 0; y < 8; y++) {
      const row: Px[] = [];
      for (let x = 0; x < 8; x++) row.push(x >= 2 && x <= 5 && y >= 2 && y <= 5 ? G : W);
      rows.push(row);
    }
    const { data, width, height } = image(rows);
    const out = removeBackground(data, width, height, { r: 255, g: 255, b: 255 }, { clearEnclosed: true });
    expect(alphaAt(out.data, width, 0, 0)).toBe(0);
    for (const [x, y] of [[2, 2], [5, 2], [3, 4], [5, 5]] as const) expect(alphaAt(out.data, width, x, y)).toBe(255);
  });

  it("clears a near-white halo next to the background", () => {
    const h: Px = [248, 249, 250, 255];
    const { data, width, height } = image([
      [W, W, W, W],
      [W, h, K, W],
      [W, W, W, W],
    ]);
    // h is within the match tolerance, so it is cleared with the background.
    const out = removeBackground(data, width, height, { r: 255, g: 255, b: 255 }, { clearEnclosed: false });
    expect(alphaAt(out.data, width, 1, 1)).toBe(0);
    expect(alphaAt(out.data, width, 2, 1)).toBe(255);
  });
});

describe("lowContrastShare", () => {
  it("counts dark visible pixels and ignores transparent ones", () => {
    const { data, width, height } = image([[K, K, W, T]]);
    expect(lowContrastShare(data, width, height)).toBeCloseTo(2 / 3);
  });
});

describe("darkVariant", () => {
  const lum = (r: number, g: number, b: number) => {
    const f = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const onDark = (r: number, g: number, b: number) => (lum(r, g, b) + 0.05) / (lum(26, 26, 26) + 0.05);

  it("turns a navy or black wordmark off-white and keeps alpha", () => {
    const navy: Px = [26, 26, 46, 255];
    const edge: Px = [26, 26, 46, 120];
    const { data, width, height } = image([[navy, edge, K]]);
    const out = darkVariant(data, width, height);
    for (let i = 0; i < 3; i++) {
      const [r, g, b] = [out[i * 4]!, out[i * 4 + 1]!, out[i * 4 + 2]!];
      expect(onDark(r, g, b)).toBeGreaterThanOrEqual(4.5);
      expect(Math.max(r, g, b)).toBeLessThan(250); // off-white, not pure white
    }
    // Navy keeps a blue cast.
    expect(out[2]!).toBeGreaterThan(out[0]!);
    expect(out[7]).toBe(120);
  });

  it("leaves colors that already read on dark, and transparent pixels, alone", () => {
    const red: Px = [224, 52, 47, 255];
    const gray: Px = [154, 160, 168, 255];
    const { data, width, height } = image([[red, gray, T]]);
    expect(Array.from(darkVariant(data, width, height))).toEqual(Array.from(data));
  });
});
