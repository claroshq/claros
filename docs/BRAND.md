# BRAND.md - Claros Design Language

This is the complete design language for the Claros product UI. It replaces
the previous brand document in full: the citron accent, the corner-bracket
mark, the dark-only palette, and the old type and spacing rules are retired.
If you are building a screen and this document does not answer your question,
the answer is to copy the behaviour of the nearest existing screen, not to
invent a new pattern.

Implementation lives in `apps/dashboard`. Tokens: `src/index.css`. Primitives:
`src/components/ui/`. Reference screens: `src/pages/LoginPage.tsx` and
`src/pages/FlowsPage.tsx`. Contrast audit: `scripts/contrast.mjs` (run it,
do not eyeball it).

## 1. Direction

Claros is an instrument, not a brochure. The user is a technical founder who
lives in this tool daily and reads dense state at a glance. Surfaces stay
neutral and quiet so text and data do the work, but the brand has a voice:
signal cyan (the heritage logo hue) marks what is interactive, focused, or
current, primary actions are deep-cyan fills that give every screen a clear
main verb, and a strictly secondary coral "pop" marks positive deltas and
rare celebratory moments. Typography carries the personality: Bricolage
Grotesque display headings, real scale contrast, tight display tracking,
micro labels for furniture, mono for machine data. Every screen has exactly
one focal point - one page title, one primary action, everything else
subdued. Space is spent where it earns its place (page headers, the login
screen, between sections) and withheld where it does not (table rows,
forms).

What this deliberately is not:

- Not a marketing site. No hero shadows, no illustration beyond the mark
  and the login motif, no large chromatic fills.
- Not a shadcn template. The default shadcn look (one size, one weight,
  slate palette, filled semantic badges) is precisely what this system
  replaces.
- Not dark-only and not light-only. Both themes are designed; neither is a
  derivation.
- Not dense everywhere. Dense where the user scans data, spacious where the
  user thinks.
- Not flat everywhere either. Surfaces are drawn with 1px lines and surface
  steps; shadows exist only for overlays. Cards do not float.

## 2. Themes

Two themes, selected by the `.dark` class on `<html>`:

- Light values live in `:root`, dark values in `.dark`, both in
  `src/index.css`. The `@theme inline` block maps Tailwind utility names to
  those vars. Components reference utility names only.
- Selection: `src/lib/theme.ts`. Modes are `light`, `dark`, `system`
  (default). The choice persists in `localStorage` under `claros-ui-theme`.
  An inline script in `index.html` applies the resolved theme before first
  paint; there is no flash and no client-only theming.
- `color-scheme` is set per theme so native controls and scrollbars match.
- The user override is the ThemeToggle in the shell header and on the login
  page (`src/components/theme-toggle.tsx`).

Rules:

1. Every color comes from a token. No hex, rgb, or oklch literals in
   components, and no new values outside `index.css`. The one exception is
   `public/favicon.svg`, a standalone asset whose values are copied from the
   tokens with a comment saying so.
2. No alpha modifiers (`/50`, `bg-x/10`) and no element-level `opacity` on
   any element whose contrast matters. Alpha composites in gamma-encoded
   sRGB and silently destroys measured contrast; two production bugs came
   from this. Where a tint is needed, define a solid token (`-soft`
   variants) and measure it.
3. Dark theme raises surfaces by making them lighter (`--bg` 0.205 ->
   `--bg-raised` 0.232). Light theme grounds them by making them greyer
   (`--bg` 0.992 canvas - the marketing white from claros-web, white
   raised cards; sidebar is `--bg-sunken` 0.95, so the order is sidebar
   < canvas < card, ratio sidebar/canvas ~1.13). Never invert these
   directions.

## 3. Color

### Tokens

| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg` | oklch(0.992 0.002 264) | oklch(0.205 0.01 264) | page canvas (marketing white) |
| `--bg-raised` | oklch(1 0 0) | oklch(0.232 0.011 264) | cards, hover surfaces |
| `--bg-sunken` | oklch(0.95 0.003 264) | oklch(0.165 0.009 264) | recessed panels (sidebar in light), disabled fills |
| `--border` | oklch(0.846 0.007 264) | oklch(0.335 0.013 264) | decorative container edges |
| `--border-strong` | oklch(0.62 0.014 264) | oklch(0.53 0.015 264) | control boundaries (3:1+) |
| `--fg` | oklch(0.24 0.014 264) | oklch(0.945 0.005 264) | primary text |
| `--fg-muted` | oklch(0.452 0.016 264) | oklch(0.715 0.014 264) | secondary text (4.5:1+) |
| `--fg-subtle` | oklch(0.53 0.015 264) | oklch(0.6 0.014 264) | small de-emphasized text, placeholders, disabled labels |
| `--accent` | oklch(0.6 0.13 225) | oklch(0.78 0.12 220) | signal cyan: dots, chips, the mark |
| `--accent-text` | oklch(0.45 0.12 240) | oklch(0.8 0.11 222) | links, active text (4.5:1+) |
| `--accent-fg` | oklch(0.2 0.03 240) | oklch(0.2 0.04 240) | text on accent fills |
| `--accent-soft` | oklch(0.93 0.035 225) | oklch(0.33 0.055 230) | active nav, selection, accent chips |
| `--accent-deep` | oklch(0.47 0.13 245) | oklch(0.72 0.13 222) | primary action fill |
| `--accent-deep-fg` | oklch(0.985 0.005 240) | oklch(0.2 0.04 240) | text on the primary fill (4.5:1+) |
| `--pop` | oklch(0.55 0.21 35) | oklch(0.72 0.17 40) | coral energy: filled pop, dots |
| `--pop-text` | oklch(0.48 0.19 35) | oklch(0.76 0.16 40) | positive deltas, pop text (4.5:1+) |
| `--pop-fg` | oklch(0.97 0.01 35) | oklch(0.21 0.04 35) | text on pop fills |
| `--pop-soft` | oklch(0.93 0.04 35) | oklch(0.35 0.07 38) | pop chip surfaces |
| `--success` / `-soft` | oklch(0.5 0.11 185) / oklch(0.93 0.025 185) | oklch(0.755 0.13 185) / oklch(0.3 0.045 185) | working as intended |
| `--warning` / `-soft` | oklch(0.47 0.1 72) / oklch(0.935 0.025 80) | oklch(0.8 0.11 82) / oklch(0.31 0.04 82) | needs attention, in progress |
| `--danger` / `-soft` | oklch(0.52 0.18 27) / oklch(0.935 0.025 27) | oklch(0.72 0.15 27) / oklch(0.31 0.05 27) | broken |
| `--danger-fill` | oklch(0.52 0.18 27) | oklch(0.55 0.17 27) | destructive button fill |
| `--chart-positive` / `--chart-negative` | oklch(0.72 0.08 185) / oklch(0.74 0.09 27) | oklch(0.8 0.07 185) / oklch(0.8 0.08 27) | direction-split chart bars: pastel step between the semantic `-soft` surfaces and the full tones |
| `--product-dot-l` / `--product-dot-c` | 0.62 / 0.13 | 0.74 / 0.12 | product identity dot in the sidebar switcher: `oklch(l c hue)`, hue from a fixed set (225, 255, 285, 315, 345, 140, 110) picked per product id, clear of the semantic and coral hues so it never reads as a status |
| `--skeleton` | oklch(0.935 0.004 264) | oklch(0.30 0.012 264) | loading placeholders |
| `--selected` | oklch(0.93 0.012 255) | oklch(0.335 0.028 250) | selected state: active nav, selected rows. Neutral slate-blue, quieter than `--accent-soft` |
| `--ring` | = `--accent` | = `--accent` | focus rings |

### Roles

- **Primary action** = deep cyan. `bg-primary` is `--accent-deep`,
  `text-primary-foreground` is `--accent-deep-fg` (white in light,
  near-black in dark; both measured at 4.5+). Reserved for the single main
  verb per screen.
- **Signal cyan** appears on: links, focus rings, the active nav item,
  the mark, status dots of accent tone, and small chips. It never covers
  large areas; the only cyan fill that carries text is the deep variant.
- **Coral pop** is the energy accent and is strictly secondary: positive
  deltas, live indicators, rare celebratory moments. Cyan and coral never
  appear inside the same component, and coral never touches navigation,
  links, or form chrome.
- **Semantic colors** appear only as: status dots, status text, badge tints,
  banner surfaces, and the direction-split chart (bars in the pastel
  `--chart-positive`/`--chart-negative`, legend text and values in full
  `--success`/`--danger`). Success, warning, and danger are never
  decorative. The success hue (185) sits between green and the brand cyan
  so semantic color reads as part of the family.
- **`-soft` surfaces** pair with their semantic text token or with `--fg`
  (both measured). Do not pair them with `--fg-muted` unmeasured; add the
  pair to `scripts/contrast.mjs` first.
- **`--fg-subtle`** is for small de-emphasized text (muted badge text,
  footer lines), placeholders, and disabled labels. It is measured at 4.5+
  on both its sanctioned surfaces (`--bg` and `--bg-sunken`) in both themes;
  it never carries body-size (14px) content. This rule exists because the
  old UI used muted gray for real content and failed AA on it.

## 4. Typography

Fonts (self-hosted via fontsource, licences in `public/fonts-license.txt`):

- Display: **Bricolage Grotesque Variable** (wght 200-800). Page titles and
  the login brand headline only. It is the voice of the product; using it
  for anything else (card titles, buttons, labels) dilutes it into noise.
- UI: **Instrument Sans Variable** (wght 400-700). Everything that is not a
  page title or machine data.
- Brand: **Quicksand Variable** (wght 700 only). The wordmark in the brand
  lockup, nowhere else. It is a deliberate nod to the heritage logo.
- Data: **JetBrains Mono Variable**. Mono is for machine data: IDs,
  timestamps, event names, trigger types, code. Never for prose.

### Scale

| Step | Size / leading | Font / weight | Tracking | Use |
|---|---|---|---|---|
| Display | 40 / 46 | Bricolage 700 | -0.02em | login brand panel headline only |
| Page title | 28 / 34 | Bricolage 700 | -0.02em | one per page, top of content |
| Section title | 20 / 28 | Instrument 600 | -0.015em | card titles, form headings |
| Emphasis | 15 / 24 | Instrument 500 | 0 | empty-state headings |
| Body | 14 / 22 | Instrument 400 | 0 | default UI text, forms |
| Small | 13 / 20 | Instrument 400/500 | 0 | nav, table cells, secondary text |
| Micro | 11 / 16 | Instrument 600 | +0.06em, uppercase | table headers, eyebrows |
| Mono data | 12-13 / 20 | JetBrains Mono 400 | 0 | IDs, dates, trigger types |

Rules:

1. One page title per page, and it is the focal point: eyebrow micro label
   above it (accent-text), one-line muted subtitle below, primary action
   top right. Nothing else on the page uses Bricolage or 20px+ type except
   section titles inside cards.
2. Tracking is negative only at 20px and above. Never letterspace body text.
3. Weight contrast, not size-only contrast: headings 600/700, emphasis 500,
   body 400. Do not set headings in 400 at a big size.
4. Uppercase exists only in micro labels. Never uppercase a sentence.
5. The old 16px mono floor is retired. Mono data renders at 12-13px at
   measured contrast; the floor existed to prop up a muted-gray palette
   that no longer exists.

## 5. Spacing, radii, borders, elevation

Spacing uses the Tailwind 4px scale with these conventions:

- Page padding: 32px (`px-8 py-8`). Content column: `max-w-6xl mx-auto`.
- Page header to content: 32px (`mb-8`).
- Between sections: 24px. Between form fields: 16-20px. Inside cards: 24px.
- Table cell padding: 12px vertical, 12px horizontal (`py-3 px-3`).
- Sidebar width 240px, header height 64px.

Radii: `--radius-sm` 6px (small chips, toggle segments), `--radius-md` 8px
(buttons, inputs, banners), `--radius-lg` 12px (cards, panels). Status
badges and dots are fully round. Do not introduce other radii.

Borders and elevation:

- Structure is drawn with 1px `--border` lines and surface steps. Cards do
  not float: no shadows on cards, tables, or static panels.
- Shadows exist only for overlays (dropdowns, dialogs): the single
  `--shadow-overlay` token (`shadow-overlay` utility). If it is not an
  overlay, it does not get a shadow.
- `--border` is decorative (container edges, table separators).
  `--border-strong` is the boundary of interactive controls (inputs,
  outline buttons) and is measured at 3:1+ against the canvas. This split
  exists because a single border token either fails WCAG 1.4.11 on inputs
  or makes every card edge shout.
- Empty states use a dashed `--border-strong` frame: the dashed edge says
  "content will live here" without inventing a new color.

## 6. Iconography

Lucide (`lucide-react`), already a dependency. Rules:

- 16px at strokeWidth 1.5 alongside 13px text (buttons, lists). Nav icons
  are the exception at strokeWidth 1.75, so they carry their weight against
  the larger sidebar lockup. 14px in the theme toggle. Nothing larger than
  24px anywhere in chrome.
- Icons are functional, not decorative filler: an icon earns its place if it
  speeds up scanning (nav, primary action affordance) and is removed
  otherwise.
- No emoji anywhere in the UI. No custom icon sets without asking.

## 7. Motion

- Durations: `--dur-fast` 120ms (hover color changes), `--dur-med` 180ms
  (state transitions). Nothing exceeds 200ms except the skeleton pulse.
- Easing: `--ease` = cubic-bezier(0.2, 0, 0, 1) (ease-out). Entering
  elements ease out; nothing bounces.
- Only `color`, `background-color`, `border-color`, `box-shadow`,
  `opacity`, and `transform` may animate. Never animate layout properties
  (width, height, padding).
- The skeleton pulse and the badge `pulse` prop animate opacity only.
- `prefers-reduced-motion` collapses all durations to ~0 globally (set in
  `index.css`). Do not add animations that bypass it.
- Motion signals state change; it never decorates. If removing the
  animation loses no information, remove the animation.

## 8. Focus

Every interactive element shows a 2px ring in `--ring` with an offset
against the page background, on `focus-visible` only:

```
focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
focus-visible:ring-offset-2 focus-visible:ring-offset-background
```

`outline: none` without a ring replacement is a bug. Pointer users never
see the ring; keyboard users always do. The ring token passes 3:1 against
both canvases (measured below).

## 9. Data density

- Tables: 13px cells, 44px row rhythm, micro-label headers, 1px `--border`
  separators, hover raises the row to `--bg-raised`. No outer frame, no
  zebra striping (zebra adds a surface per row and still loses to
  whitespace plus hover).
- Numeric and machine columns are mono 12px muted. Identifiers and dates
  right-align when the column is numeric or temporal.
- Status columns use dot badges, so four status columns in one row stay
  scannable. The old filled pills made every row a traffic light.
- Lists always show their primary action, including while loading, empty,
  or failed. A list screen with no verb is a defect: this rule exists
  because the flows list shipped with its action missing from every state
  except the populated one.
- Loading skeletons mirror the layout they replace (same columns, same
  rhythm) and use `--skeleton`, which steps away from the canvas in the
  direction content will appear: greyer in light, lighter in dark. Never
  brand-colored; a loading state is absence of content, not a brand moment.
- Error states are banners: `--danger-soft` surface, `--danger` border,
  `--fg` text, and a retry action when retry is possible.

## 10. Components

Primitives in `src/components/ui/`, dependency-free. If a screen needs a
new primitive, it is added here first, in both themes, with its contrast
pairs added to `scripts/contrast.mjs`.

- **Button**: variants `default` (deep cyan fill, the one main verb),
  `outline` (border-strong boundary), `secondary` (raised surface with
  border), `ghost` (quiet chrome actions like Sign out), `destructive`
  (`--danger-fill` with white text), `link` (accent text). Sizes `sm`
  (32px), `default` (36px), `lg` (40px), `icon`. Disabled state is a solid
  `--bg-sunken` fill with muted text: never opacity. The old disabled style
  (accent at 50% opacity) rendered as a muddy olive and failed AA; that is
  why this rule exists.
- **Input / Select / Textarea**: 36px fields (textarea grows), page-canvas
  fill, `--border-strong` boundary, focus ring per section 8. Select is a
  styled native element: no custom listbox. Placeholders are
  `--fg-subtle`; labels live outside the field, always visible.
- **Table**: see section 9.
- **Badge**: dot plus tinted text on a `-soft` surface, fully round. Tones:
  `accent`, `neutral`, `muted`, `success`, `warning`, `danger`. `pulse`
  animates the dot for in-progress states (compile pending). No other
  variant names exist; the pre-redesign aliases were removed once all call
  sites used canonical tones.
- **Skeleton**: `--skeleton` fill, opacity pulse, matches the layout it
  replaces.
- **ThemeToggle**: light / system / dark segmented control.
- **BrandMark**: see section 11.
- **Isolated content**: model-generated or tenant-authored HTML
  (approval drafts, HTML knowledge entries) is never injected into the
  dashboard DOM. It renders in `<iframe sandbox="" referrerPolicy="no-referrer"
  srcDoc={...}>`: no scripts, no same-origin access, no forms, no popups.
  The frame carries a 1px `--border` and a white surface, because email is
  white regardless of theme; that is the one sanctioned place a surface
  does not come from a token pair (it is content, not chrome).
- **Disclosure**: secondary explanation (AI reasoning behind a draft) lives
  in a native `<details>` element, collapsed by default, muted text, never
  styled to compete with the content it explains.
- **Charts** (`src/components/charts.tsx`): hand-rolled SVG, no library.
  Chart ink comes from tokens via `var()` references (`--accent` for series,
  `--border` for baselines, the `--fg-*` ladder for segmented strips,
  `--chart-positive`/`--chart-negative` for direction-split movement), so
  both themes
  work with zero per-chart logic.   Daily series use slim bars (40% slot
  width) with max/total annotations and date endpoints; a fat uniform bar
  per day is a picket fence, not a chart. Direction-split bars are
  diverging: good movement rises above a shared zero line in
  `--chart-positive`, bad movement sinks below it in `--chart-negative`,
  so a bad trend reads before any table does. The pastel pair sits between
  the `-soft` surfaces and the full semantic tones: full `--success`/
  `--danger` read harsh at bar scale, pure `-soft` washes out at 40% slot
  width. Hovering a chart shows a hover band
  over the active day and a tooltip card (bordered `--card` surface, no
  shadow); values on hover are required, a chart without them is cosmetic
  only. The sr-only data table lives inside an `sr-only` WRAPPER div,
  never as a class on the table element itself: table auto-layout ignores
  the 1px width and the box leaks into the scrollable area (this exact bug
  broke shell scrolling once). Every chart carries an sr-only data
  table. A chart of nothing renders its frame with a centred note;
  fabricated sample data is a defect. Rates with a denominator under 20
  are hidden and replaced by counts, with the reason stated: a percentage
  over a handful of messages is noise. This decision was made against
  Recharts (~45 KB gz, library look), nivo (opinionated defaults),
  Chart.js (canvas, second color system), and visx (same hand work plus
  D3).

## 11. The mark

The mark is a solid droplet pointing right with a circular cutout. The
droplet is movement through a system; the cutout is the contact passing
through it. It derives from the heritage logo's interlocked drops, reduced
to a single ownable shape that survives favicon size.

Geometry (`viewBox="0 0 24 24"`, `src/components/brand-mark.tsx`):

- Droplet: tip at (0, -10.8), body circle radius 7.8 centered at (0, 1.6),
  rotated 90 degrees about (12, 12) so the tip points right. The wide body
  keeps the mark full and weighty; it nearly fills the viewBox.
- Cutout: circle radius 3.7 centered at (0, -2.4), subtracted with
  `fill-rule="evenodd"`. The deliberately small cutout leaves a thick ring,
  so the mark reads solid at small sizes.
- Color: `currentColor` always. Paint it with a token (`text-accent` in
  brand contexts, `text-foreground` in quiet contexts). Never hardcode a
  value in the SVG.

Usage:

- Lockup: mark left, wordmark right. The wordmark is lowercase "claros" in
  Quicksand 700, tracking +0.03em. The lockup geometry is optically tuned,
  not mathematically centered: the gap between mark and wordmark is the
  mark size x 0.09 (about 2-3px at product sizes), the mark is nudged down
  by the   mark size x 0.05 to sit on the x-height optical center of the
  wordmark, and the mark is sized at roughly the wordmark size x 1.15
  (26px mark against 22.6px type in the sidebar). The ratio is 1.15, not the
  classic 1.29, because the mark is a solid fill: at 1.29 it visually
  overpowered the light-stroked Quicksand wordmark. The lockup appears in the
  sidebar and the login panel; nowhere else needs it.
- Minimum size: 16px. Below that the cutout fills in optically.
- Favicon / avatar: the bare mark on a transparent ground, no tile
  (`public/favicon.svg`). The SVG fill adapts to the browser chrome with
  `prefers-color-scheme`: light chrome gets the light theme accent
  (#008fba), dark chrome the dark theme accent (#4ac9ec). The raster set
  derives from it: `favicon.ico` (16+32, PNG-in-ICO) and `favicon-16.png` /
  `favicon-32.png` in a fixed mid cyan (#12acd2) that reads on both chromes
  (PNGs cannot adapt), and `apple-touch-icon.png` (180px, full-bleed light
  tile since iOS renders transparency as black and applies its own mask).
- The mark does not animate.

## 12. Layout

- Shell: a single chrome column. The 240px sidebar carries the brand lockup
  at the top, navigation in the middle, and a footer with the theme toggle,
  the signed-in user, and sign out. There is no horizontal header: it would
  spend the scarce axis (vertical space in a data-dense tool) to hold three
  small controls, and identity belongs with navigation, where every
  comparable product puts it. (This replaces an earlier version of this
  rule that prescribed a 64px header with a right-aligned cluster; the
  header did no work proportional to its cost.)
- Nav items: 13-14px, 16px icons, 8px radius. Active item: the `--selected`
  fill (neutral slate-blue tint, not cyan) with `--fg` text at weight 600.
  Never a one-sided border or edge indicator bar (the user has rejected
  that pattern explicitly; it applies product-wide). The brand lockup above
  the nav sits on the page canvas (no band or card of its own), padded so
  the mark and the nav icons share one vertical axis.
  Disabled destinations render in `--fg-subtle` and are not focusable.
- The sidebar footer is separated by a 1px `--border` line. The user email
  truncates; sign out is a quiet icon button, not a primary action.
- Pages: one title (28px Bricolage, the focal point), one eyebrow micro
  label above it, one-line muted subtitle, primary action top right,
  content in a `max-w-6xl` column. The header block renders in every state
  of the page.
- Unknown routes render inside the shell: the chrome persists and only the
  content region reports the miss, with a way back to the default page.
- Editor pages use a main column plus a 288px right rail for details and
  metadata. The primary surface of the page leads the main column.
- Multi-section pages (Settings) are sub-routes with a persistent in-page
  nav, never one long scroll with anchor links. The in-page nav mirrors
  the shell nav (240px column, 14px items with 16px icons, `--selected`
  active fill, sticky with its own scroll), groups its items under 11px
  micro labels, and may carry a small warning dot on sections that need
  attention. Each sub-page is its own URL, so setup hints anywhere in the
  app deep-link to the exact section.
- Login: split screen. Brand panel (44%, `--bg-sunken`) carries the only
  display typography in the app plus the flow motif (a node entering a
  dashed path that resolves into a ring: a contact entering a compiled
  plan). The form side is deliberately quiet.

## 13. Accessibility: measured contrast

Method (implemented in `apps/dashboard/scripts/contrast.mjs`): oklch ->
oklab -> linear sRGB -> WCAG relative luminance. Ratios are
`(L1 + 0.05) / (L2 + 0.05)`. Pairs involving alpha are composited in
gamma-encoded sRGB first, because that is how CSS blends them; computing on
the underlying token values is meaningless once opacity is involved. A
token-pair measurement is also only valid when nothing composes on top of
it: these pairs are sanctioned for elements with no opacity, no alpha
modifier, and no blended backdrop.

### Light theme

| Pair | Ratio | Required | Verdict |
|---|---|---|---|
| body text on bg | 16.08 | 4.5 | PASS |
| body text on raised | 16.46 | 4.5 | PASS |
| muted text on bg | 7.21 | 4.5 | PASS |
| muted text on raised | 7.38 | 4.5 | PASS |
| subtle text on bg | 5.16 | 4.5 | PASS |
| subtle text on sunken (badge, footer) | 4.56 | 4.5 | PASS |
| subtle dot on sunken (badge dot) | 4.56 | 3.0 | PASS |
| accent text (link) on bg | 7.04 | 4.5 | PASS |
| accent text on accent-soft | 5.91 | 4.5 | PASS |
| muted text on accent-soft | 6.05 | 4.5 | PASS |
| muted text on sunken (chips) | 6.38 | 4.5 | PASS |
| warning text on raised (badge on card) | 6.97 | 4.5 | PASS |
| success text on success-soft (badge) | 4.66 | 4.5 | PASS |
| warning text on warning-soft (banner) | 5.75 | 4.5 | PASS |
| accent-fg on accent (filled chip) | 4.84 | 4.5 | PASS |
| primary button (deep-fg on deep fill) | 6.43 | 4.5 | PASS |
| accent dot on bg (status) | 3.65 | 3.0 | PASS |
| pop-text on bg (positive delta) | 6.99 | 4.5 | PASS |
| pop-fg on pop (filled pop) | 4.90 | 4.5 | PASS |
| pop-text on pop-soft (pop chip) | 5.72 | 4.5 | PASS |
| fg on pop-soft (pop chip fallback) | 13.16 | 4.5 | PASS |
| success text on bg | 5.55 | 4.5 | PASS |
| warning text on bg | 6.81 | 4.5 | PASS |
| danger text on bg | 5.90 | 4.5 | PASS |
| danger text on danger-soft (banner) | 4.95 | 4.5 | PASS |
| body text on danger-soft (banner) | 13.48 | 4.5 | PASS |
| body text on warning-soft (banner) | 13.58 | 4.5 | PASS |
| white text on danger-fill (button) | 6.04 | 4.5 | PASS |
| input boundary (border-strong vs bg) | 3.56 | 3.0 | PASS |
| focus ring (accent vs bg) | 3.65 | 3.0 | PASS |
| status dots (success/warning/danger vs bg) | 5.55 / 6.81 / 5.90 | 3.0 | PASS |
| disabled text (fg at 60% on bg, composited) | 4.34 | 3.0 advisory | PASS |
| card edge (border vs raised) | 1.60 | n/a decorative | container edge, not a control boundary |

### Dark theme

| Pair | Ratio | Required | Verdict |
|---|---|---|---|
| body text on bg | 15.25 | 4.5 | PASS |
| body text on raised | 14.31 | 4.5 | PASS |
| muted text on bg | 7.09 | 4.5 | PASS |
| muted text on raised | 6.65 | 4.5 | PASS |
| subtle text on bg | 4.54 | 4.5 | PASS |
| subtle text on sunken (badge, footer) | 4.88 | 4.5 | PASS |
| subtle dot on sunken (badge dot) | 4.88 | 3.0 | PASS |
| accent text (link) on bg | 9.87 | 4.5 | PASS |
| accent text on accent-soft | 6.65 | 4.5 | PASS |
| muted text on accent-soft | 4.78 | 4.5 | PASS |
| muted text on sunken (chips) | 7.63 | 4.5 | PASS |
| warning text on raised (badge on card) | 8.93 | 4.5 | PASS |
| success text on success-soft (badge) | 6.47 | 4.5 | PASS |
| warning text on warning-soft (banner) | 7.01 | 4.5 | PASS |
| accent-fg on accent (filled chip) | 9.33 | 4.5 | PASS |
| primary button (deep-fg on deep fill) | 7.54 | 4.5 | PASS |
| accent dot on bg (status) | 9.25 | 3.0 | PASS |
| pop-text on bg (positive delta) | 7.70 | 4.5 | PASS |
| pop-fg on pop (filled pop) | 6.76 | 4.5 | PASS |
| pop-text on pop-soft (pop chip) | 5.00 | 4.5 | PASS |
| fg on pop-soft (pop chip fallback) | 9.90 | 4.5 | PASS |
| success text on bg | 8.67 | 4.5 | PASS |
| warning text on bg | 9.52 | 4.5 | PASS |
| danger text on bg | 6.78 | 4.5 | PASS |
| danger text on danger-soft (banner) | 5.08 | 4.5 | PASS |
| body text on danger-soft (banner) | 11.43 | 4.5 | PASS |
| body text on warning-soft (banner) | 11.23 | 4.5 | PASS |
| white text on danger-fill (button) | 5.28 | 4.5 | PASS |
| input boundary (border-strong vs bg) | 3.39 | 3.0 | PASS |
| focus ring (accent vs bg) | 9.25 | 3.0 | PASS |
| status dots (success/warning/danger vs bg) | 8.67 / 9.52 / 6.78 | 3.0 | PASS |
| disabled text (fg at 60% on bg, composited) | 6.15 | 3.0 advisory | PASS |
| card edge (border vs raised) | 1.40 | n/a decorative | container edge, not a control boundary |

Notes:

- Placeholders and disabled controls are exempt under WCAG; the subtle
  rows are held to the full 4.5 normal-text bar anyway, because muted badge
  text and footer lines are content the user reads. The earlier values
  (light 4.22, dark 4.44 on some surfaces) failed that bar and the token
  was corrected (light 0.552 -> 0.53, dark 0.585 -> 0.60).
- Card edges are container decoration, not control boundaries, so WCAG
  1.4.11 does not apply to them. Control boundaries use `--border-strong`
  and are measured above.
- When you add a pairing, add it to `scripts/contrast.mjs` and paste the
  new numbers here. Unmeasured pairings do not ship.

## 14. Writing in the UI

- Sentence case everywhere except micro labels (uppercase) and the
  wordmark (lowercase).
- Buttons are verbs: "New flow", "Send login link", "Try again". Never
  "OK" or "Submit".
- No em dashes in UI copy, comments, or docs. Use hyphens.
- No emoji.
