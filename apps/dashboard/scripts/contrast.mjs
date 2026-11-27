/**
 * Contrast audit for the Claros design tokens.
 *
 * Converts the oklch token values from src/index.css to sRGB, computes WCAG
 * relative luminance, and prints contrast ratios for every text-on-surface
 * and UI-boundary pair the design system allows, in both themes.
 *
 * Pairs that involve opacity (alpha modifiers such as /60) are composited in
 * gamma-encoded sRGB, which is how CSS actually blends them. Computing on the
 * underlying token values would be wrong.
 *
 * Usage: node scripts/contrast.mjs
 */

// -- oklch -> sRGB -----------------------------------------------------------

function oklchToLinearSrgb(L, C, H) {
  const hr = (H * Math.PI) / 180;
  const a = C * Math.cos(hr);
  const b = C * Math.sin(hr);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function linearToGamut(c) {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

function oklchToSrgb(L, C, H) {
  return oklchToLinearSrgb(L, C, H).map((v) =>
    Math.min(1, Math.max(0, linearToGamut(v))),
  );
}

function luminance(srgb) {
  const lin = srgb.map((c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// CSS alpha compositing happens in gamma-encoded sRGB space.
function compositeOver(fg, alpha, bg) {
  return fg.map((c, i) => c * alpha + bg[i] * (1 - alpha));
}

// -- tokens (mirror of src/index.css) ----------------------------------------

const themes = {
  light: {
    bg: [0.963, 0.005, 258],
    raised: [1.0, 0.0, 0],
    sunken: [0.95, 0.005, 258],
    border: [0.87, 0.011, 260],
    "border-strong": [0.6, 0.016, 262],
    fg: [0.205, 0.013, 264],
    "fg-muted": [0.38, 0.024, 264],
    "fg-subtle": [0.5, 0.022, 264],
    selected: [0.935, 0.016, 252],
    accent: [0.6, 0.13, 225],
    "accent-text": [0.45, 0.12, 240],
    "accent-fg": [0.2, 0.03, 240],
    "accent-soft": [0.93, 0.035, 225],
    "accent-deep": [0.47, 0.13, 245],
    "accent-deep-fg": [0.985, 0.005, 240],
    pop: [0.55, 0.21, 35],
    "pop-text": [0.48, 0.19, 35],
    "pop-fg": [0.97, 0.01, 35],
    "pop-soft": [0.93, 0.04, 35],
    success: [0.47, 0.1, 185],
    "success-soft": [0.93, 0.025, 185],
    warning: [0.47, 0.1, 72],
    "warning-soft": [0.935, 0.025, 80],
    danger: [0.5, 0.18, 27],
    "danger-soft": [0.935, 0.025, 27],
    "danger-fill": [0.5, 0.18, 27],
  },
  dark: {
    bg: [0.205, 0.01, 264],
    raised: [0.232, 0.011, 264],
    sunken: [0.165, 0.009, 264],
    border: [0.335, 0.013, 264],
    "border-strong": [0.53, 0.015, 264],
    fg: [0.945, 0.005, 264],
    "fg-muted": [0.715, 0.014, 264],
    "fg-subtle": [0.63, 0.014, 264],
    selected: [0.335, 0.028, 250],
    accent: [0.78, 0.12, 220],
    "accent-text": [0.8, 0.11, 222],
    "accent-fg": [0.2, 0.04, 240],
    "accent-soft": [0.33, 0.055, 230],
    "accent-deep": [0.72, 0.13, 222],
    "accent-deep-fg": [0.2, 0.04, 240],
    pop: [0.72, 0.17, 40],
    "pop-text": [0.76, 0.16, 40],
    "pop-fg": [0.21, 0.04, 35],
    "pop-soft": [0.35, 0.07, 38],
    success: [0.755, 0.13, 185],
    "success-soft": [0.3, 0.045, 185],
    warning: [0.8, 0.11, 82],
    "warning-soft": [0.31, 0.04, 82],
    danger: [0.72, 0.15, 27],
    "danger-soft": [0.31, 0.05, 27],
    "danger-fill": [0.55, 0.17, 27],
  },
};

const WHITE = [1, 1, 1];

// -- pairs -------------------------------------------------------------------
// [label, fgToken|{token,alpha}, bgToken, minimum, kind]

const pairs = [
  ["body text on bg", "fg", "bg", 4.5, "text"],
  ["body text on raised", "fg", "raised", 4.5, "text"],
  ["muted text on bg", "fg-muted", "bg", 4.5, "text"],
  ["muted text on raised", "fg-muted", "raised", 4.5, "text"],
  ["subtle text (placeholder) on bg", "fg-subtle", "bg", 3.0, "advisory"],
  ["subtle text on raised (timestamps on cards)", "fg-subtle", "raised", 4.5, "text"],
  ["border vs bg (card edge on canvas, decorative)", "border", "bg", 0, "info"],
  ["raised vs bg (card off canvas, decorative)", "raised", "bg", 0, "info"],
  ["subtle text on sunken (badge/login footer)", "fg-subtle", "sunken", 3.0, "advisory"],
  ["subtle dot on sunken (badge dot)", "fg-subtle", "sunken", 3.0, "boundary"],
  ["accent text (link) on bg", "accent-text", "bg", 4.5, "text"],
  ["accent text on accent-soft", "accent-text", "accent-soft", 4.5, "text"],
  ["fg on selected (active nav)", "fg", "selected", 4.5, "text"],
  ["muted text on accent-soft (queue item meta)", "fg-muted", "accent-soft", 4.5, "text"],
  ["muted text on sunken (chips)", "fg-muted", "sunken", 4.5, "text"],
  ["fg on sunken (active nav)", "fg", "sunken", 4.5, "text"],
  ["bg on fg (active nav block)", "bg", "fg", 4.5, "text"],
  ["warning text on raised (badge on card)", "warning", "raised", 4.5, "text"],
  ["success text on success-soft (badge)", "success", "success-soft", 4.5, "text"],
  ["warning text on warning-soft (banner)", "warning", "warning-soft", 4.5, "text"],
  ["accent-fg on accent (filled chip)", "accent-fg", "accent", 4.5, "text"],
  ["primary button: deep-fg on deep fill", "accent-deep-fg", "accent-deep", 4.5, "text"],
  ["accent dot on bg (status)", "accent", "bg", 3.0, "boundary"],
  ["pop-text on bg (positive delta)", "pop-text", "bg", 4.5, "text"],
  ["pop-fg on pop (filled pop)", "pop-fg", "pop", 4.5, "text"],
  ["pop-text on pop-soft (pop chip)", "pop-text", "pop-soft", 4.5, "text"],
  ["fg on pop-soft (pop chip fallback)", "fg", "pop-soft", 4.5, "text"],
  ["success text on bg", "success", "bg", 4.5, "text"],
  ["warning text on bg", "warning", "bg", 4.5, "text"],
  ["danger text on bg", "danger", "bg", 4.5, "text"],
  ["danger text on danger-soft (banner)", "danger", "danger-soft", 4.5, "text"],
  ["body text on danger-soft (banner)", "fg", "danger-soft", 4.5, "text"],
  ["body text on warning-soft (banner)", "fg", "warning-soft", 4.5, "text"],
  ["body text on success-soft (grid cell)", "fg", "success-soft", 4.5, "text"],
  ["muted text on success-soft (grid cell meta)", "fg-muted", "success-soft", 4.5, "text"],
  ["muted text on warning-soft (grid cell meta)", "fg-muted", "warning-soft", 4.5, "text"],
  ["muted text on danger-soft (grid cell meta)", "fg-muted", "danger-soft", 4.5, "text"],
  ["white text on danger-fill (button)", { white: true }, "danger-fill", 4.5, "text"],
  ["border vs bg (input boundary)", "border-strong", "bg", 3.0, "boundary"],
  ["border vs raised (card edge, decorative, 1.4.11 n/a)", "border", "raised", 0, "info"],
  ["focus ring (accent) vs bg", "accent", "bg", 3.0, "boundary"],
  ["status dot success vs bg", "success", "bg", 3.0, "boundary"],
  ["status dot warning vs bg", "warning", "bg", 3.0, "boundary"],
  ["status dot danger vs bg", "danger", "bg", 3.0, "boundary"],
  // alpha-composited pairs (the gamma trap: composite in sRGB first)
  ["fg at 60% on bg (disabled)", { token: "fg", alpha: 0.6 }, "bg", 3.0, "advisory-alpha"],
  ["raised at 50% on bg (row hover)", { token: "raised", alpha: 0.5 }, "bg", 0, "info"],
];

function srgbOf(theme, ref) {
  if (ref.white) return WHITE;
  const t = typeof ref === "string" ? ref : ref.token;
  const [L, C, H] = themes[theme][t];
  return oklchToSrgb(L, C, H);
}

for (const theme of ["light", "dark"]) {
  console.log(`\n== ${theme.toUpperCase()} ==`);
  console.log(
    "pair".padEnd(48) + "ratio".padStart(7) + "  min".padStart(6) + "  verdict",
  );
  for (const [label, fgRef, bgToken, min, kind] of pairs) {
    const bg = srgbOf(theme, bgToken);
    let fg = srgbOf(theme, fgRef);
    if (typeof fgRef === "object" && fgRef.alpha !== undefined) {
      fg = compositeOver(fg, fgRef.alpha, bg);
    }
    const r = contrast(fg, bg);
    const verdict = min === 0 ? "info" : r >= min ? "PASS" : "FAIL";
    console.log(
      label.padEnd(48) + r.toFixed(2).padStart(7) + ("  " + min).padStart(6) + "  " + verdict,
    );
  }
}
