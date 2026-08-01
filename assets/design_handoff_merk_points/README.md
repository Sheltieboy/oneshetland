# Handoff: Merk Points brand pack

## Overview
**Merk Points** is the island-wide loyalty scheme of **OneShetland** (Shetland, Scotland).
Shoppers earn one *merk* for every £1 spent with a local business and redeem merks for
community experiences — a swim, a museum visit, a film, a bus fare. The name is heritage:
a *merk* was a Norse-rooted Shetland unit of worth. **Merks are a reward, never cash** —
never present them as currency, a balance in £, or something withdrawable.

This pack contains the brand's identity system so it can be used everywhere in the
OneShetland product: a struck "1 MERK" coin, the *merk* currency glyph, the
wordmark/strapline lockups, and the colour + type tokens they all read from.

## About the design files
The files in this bundle are **design references created in HTML/CSS/SVG** — prototypes
showing the intended look, not production code to drop in wholesale. The task is to
**recreate these assets in the target codebase's own environment** (React, Vue, SwiftUI,
native, Tailwind, etc.) using its established patterns. The React files in `snippets/`
are a faithful starting point if the target is React/Next; port the same layer structure
if it isn't. If no environment exists yet, pick the framework that fits the product and
implement there.

Everything is **pure CSS + inline SVG**: no raster images, no icon font, no JS, no CDN
assets. It therefore scales, prints, themes and server-renders cleanly.

## Fidelity
**High fidelity.** Colours, geometry, type and relief values are final. Reproduce the
coin's layer stack and the glyph's path geometry exactly — the metal read depends on the
specific gradient stops, insets and shadow values listed below. Layout of the brand sheet
itself is a presentation surface, not a product screen; only the assets are normative.

---

## Assets in this pack

| Asset | Where | Notes |
| --- | --- | --- |
| Brand tokens | `assets/merk-tokens.css` | Colours + font stacks as CSS custom properties |
| Asset styles | `assets/merk-brand.css` | Coin layers, glyph, wordmark, lockups |
| Reference page | `reference/merk-brand-reference.html` | Open in a browser — every asset at real size |
| Currency glyph | `assets/merk-glyph.svg` | Standalone, `currentColor` |
| Mint mark (rings) | `assets/merk-mintmark.svg` | OneShetland rings — the brand's "O" |
| React components | `snippets/MerkCoin.jsx`, `snippets/MerkGlyph.jsx`, `snippets/MerkWordmark.jsx` | Includes `formatMerks` + `MerkPrice` |
| Design source | `design_source/*.dc.html` | The originating design files (reference only) |

---

## Design tokens

### Colour
| Token | Hex | Use |
| --- | --- | --- |
| `--merk-navy` | `#0B2836` | Primary brand ink (OneShetland navy); wordmark on light |
| `--merk-navy-deep` | `#081E29` | Dark ground / app hero |
| `--merk-gold` | `#C98A1F` | Strapline, inline glyph in prices |
| `--merk-gold-bright` | `#E6AC48` | Coin mid-tone; gold text on navy |
| `--merk-gold-light` | `#F6D079` | Coin highlight (top-left) |
| `--merk-gold-dark` | `#C6871D` | Coin shadow (bottom-right) |
| `--merk-engraved` | `#2B1E06` | Struck/engraved marks on the coin |
| `--merk-paper` | `#FBFAF7` | Cream neutral ground |
| `--merk-paper-ink` | `#1D1F20` | Body text on light grounds |

Accessibility: `#C98A1F` on white is ~3.4:1 — fine for large text, uppercase straplines
and icons; for gold body copy on light grounds darken to `#8A5D10` or use navy.
On `#081E29`, use `#E6AC48` (≈7:1).

### Type
- Wordmark: **Playfair Display 500** — `--merk-font-wordmark`
  (fallbacks: Hoefler Text, Baskerville, Georgia, serif)
- UI / strapline / coin legend: **Barlow 500** — `--merk-font-ui`
- Numerals & display headings: **Barlow Condensed 600** — `--merk-font-display`
- Strapline: uppercase, letter-spacing `0.30em`, size = **20% of the wordmark size**
- Coin legend "ONE MERK": uppercase Barlow 500, 19px at the 480px coin base,
  letter-spacing `0.34em`; rim legend 11px, `0.42em`
- Load Playfair Display 400/500/600, Barlow 400/500/700, Barlow Condensed 400/600.
  Self-host the woff2s in production (the reference page links Google Fonts for convenience).

### Spacing / geometry
No general spacing scale is imposed — follow the host codebase. Asset-internal geometry
is fixed and listed per asset below.

---

## Asset 1 — The coin ("1 MERK")

A struck gold coin: it must read as metal with relief, never as a flat sticker or emoji.

**Construction.** Authored on a **480 × 480 stage** and scaled with
`transform: scale(size / 480)` — this keeps every relief detail proportional at any
rendered size. Set the diameter with the unitless custom property
`--merk-coin-size` (px).

Layer stack, outermost first (all values at the 480 base):
1. **Reeded (milled) edge** — full circle,
   `repeating-conic-gradient(from 0deg, #b8791a 0 0.55deg, #f3cd83 0.55deg 1.15deg, #c88d24 1.15deg 1.8deg)`;
   drop shadow `0 18px 34px -12px rgba(20,14,2,.55), 0 2px 3px rgba(20,14,2,.35)`.
2. **Directional sheen** — highlight radial at 30% 24% `rgba(255,247,220,.75)` → transparent 42%;
   shade radial at 74% 82% `rgba(90,58,4,.45)` → transparent 48%.
3. **Raised rim** — `inset: 11px`, radial gradient at 30% 26%: `#F6D079 0% → #E6AC48 52% → #C6871D 100%`;
   `inset 0 2px 2px rgba(255,248,224,.85), inset 0 -3px 5px rgba(74,48,2,.45)`.
4. **Struck field** — `inset: 31px`, same gradient at 32% 26%; sunk with
   `inset 0 5px 10px rgba(52,34,2,.42), inset 0 -4px 8px rgba(255,243,205,.42)`.
   Inside it, two guilloché layers (an engine-turned radial comb masked to a ring, plus
   fine concentric rings) and one soft field highlight.
5. **Beaded inner ring** — r = 186, dashed `1.5 7.6` round-cap stroke at 4.6 width in
   `rgba(43,30,6,.5)`, doubled 0.9px lower in `rgba(255,246,214,.42)` for the highlight;
   plus two hairline circles (r 186 / 183.6).
6. **Mint mark** — the OneShetland rings, 104 × 104, centred at `top: 48px`.
7. **Denomination** — the merk glyph, 168 × 148, at `top: 170px` (optically centred).
8. **Legends** — "ONE MERK" arced along the bottom on r = 158; optional rim legend
   "· SHOP LOCAL · EARN A MERK ·" arced along the top on r = 202.

**Emboss technique (important).** Nothing on the coin is a flat fill. Every engraved
element is drawn **twice**: a pale copy (`rgba(255,246,214,.62–.72)`) offset **+1.5–1.8px
on Y**, then the dark copy (`#2B1E06`) on top. That offset pair is what reads as
incised metal. Keep it.

**Size bands (legibility).** Set `data-size-band` on the root:
- `l` — ≥ 300px: everything, including the rim legend.
- `m` — 150–299px: hide the rim legend.
- `s` — 56–149px: hide both arced legends; mint mark + denomination only.
- Below 56px do **not** use the coin — use the glyph mark instead.

**Do not**: round-crop it into a square card, add a coloured drop shadow, animate a
spin as a loader by default (a single 600ms flip on "merk earned" is welcome), or place
it on a busy photograph without a scrim.

## Asset 2 — The merk currency glyph

A capital **M** struck through with **two horizontal bars** — a designed monetary symbol
in the family of £ € ₩ ₽.

Geometry, viewBox `0 0 100 90`, strokes only, miter joins, butt caps:
- M skeleton: `M 20 79 L 20 15 L 50 53 L 80 15 L 80 79`, stroke-width **10**
- Upper bar: `M 10 38 L 90 38`, stroke-width **6.4**
- Lower bar: `M 10 52 L 90 52`, stroke-width **6.4**

Rules:
- Sizes with type: `height: 1em; width: 1.111em; vertical-align: -0.12em`.
- Inherits `currentColor`. In prices use `--merk-gold` for the glyph and navy for the
  numerals; single-colour contexts (favicon, app icon, disabled state) take navy or paper.
- Minimum size **14px** tall. Below that, use the word "merks".
- Never re-space the bars, never add a third bar, never outline or add a shadow.
- Amount format: whole numbers, thousands-separated, glyph then number with a hair gap
  (`ᛗ1,250` pattern — see `formatMerks`/`MerkPrice`). Never mix with £ in one figure;
  write "1 merk per £1" in prose.

## Asset 3 — Wordmark, strapline and lockups

- Wordmark: "Merk Points", Playfair Display 500, letter-spacing `0.005em`,
  line-height `0.98`, `white-space: nowrap`. Navy on light, `#F4EFE6` on navy.
- Strapline: "SHOP LOCAL · EARN A MERK", Barlow 500 uppercase, letter-spacing `0.30em`,
  **20% of the wordmark size**, gold (`--merk-gold` on light, `--merk-gold-bright` on navy).
  Gap between wordmark and strapline = **24% of the wordmark size**.
- **Horizontal lockup**: coin left, text right. Coin diameter ≈ **2.4×** the wordmark size;
  gap ≈ 0.6× wordmark size; vertically centred on the text block.
- **Stacked lockup**: coin above, text centred beneath, gap ≈ 0.5× wordmark size.
- Clear space around any lockup = the height of the wordmark's cap on all sides.
- Minimum wordmark size 24px (below that use the coin or glyph alone).
- Never set the wordmark in the sans, never letter-space it, never place the strapline
  above the wordmark.

---

## Interactions & behaviour (guidance for product use)
- **Earning**: on a confirmed transaction, show the coin at 76–132px with a single
  400–600ms scale-in (`transform: scale(.92 → 1)`, `cubic-bezier(.2,.7,.3,1)`) and a
  fade of the amount. No confetti, no bounce.
- **Balance**: glyph + condensed numerals, e.g. `ᛗ1,250`, with the label "merks" nearby
  on first use. Never label a balance "value" or show a £ equivalent.
- **Redemption**: state cost as `ᛗ250` and the experience name; the coin appears once at
  the top of the flow, not per row.
- **Reduced motion**: honour `prefers-reduced-motion` — drop the scale-in, keep the fade.
- **Accessibility**: coin `role="img"` with `aria-label="One merk"`; glyph
  `aria-label="merk"`; announce amounts as "250 merks" for screen readers rather than
  relying on the glyph.

## State management
None — every asset in this pack is presentational and stateless. The only dynamic input
is a merk amount (integer) passed to the price/balance components.

## Files in this bundle
```
design_handoff_merk_points/
├── README.md
├── assets/
│   ├── merk-tokens.css
│   ├── merk-brand.css
│   ├── merk-glyph.svg
│   └── merk-mintmark.svg
├── reference/
│   └── merk-brand-reference.html      ← open this first
├── snippets/
│   ├── MerkCoin.jsx
│   ├── MerkGlyph.jsx                  (+ formatMerks, MerkPrice)
│   └── MerkWordmark.jsx
└── design_source/
    ├── Merk Points Brand Sheet.dc.html
    ├── MerkCoin.dc.html
    ├── MerkGlyph.dc.html
    └── MerkWordmark.dc.html
```
The `design_source` files are the original design documents; they need a companion
runtime to open and are included for provenance only. Build from `assets/`,
`snippets/` and the reference page.

## Note on the rings mark
The rings mint mark is a redraw of the OneShetland rings supplied as reference (seven
overlapping ellipses, rx 35 / ry 45, rotated 0–156° in 26° steps, 2.3 stroke on a
108 box). On the coin it is engraved single-tone. Where OneShetland's own full-colour
rings artwork exists in the codebase, **use that official file** for OneShetland
contexts and keep this single-tone redraw for the coin only.
