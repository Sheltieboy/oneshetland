# OneShetland — Brand Pack v1.0.0

**Everything Shetland, in one place.**
OneShetland · 60° North · oneshetland.com · Darren Fullerton Consultancy Ltd

This folder is the single source of truth for the OneShetland visual identity.
If you are an agent rebranding the ecosystem: read `tokens.json` first, wire
`tokens.css` (or `tailwind.brand.js`) into the app root, then replace logo,
icon and social assets from the inventory below. Do not invent colours, fonts,
radii or logo variants that are not in this folder.

---

## 1. Start here

| If you are… | Do this |
| --- | --- |
| Rebranding a web app | Link `tokens.css`, paste `head-snippet.html` into `<head>`, swap favicons and OG images. |
| Rebranding a Tailwind app | Merge `tailwind.brand.js` into `tailwind.config.js`; still load the Google Fonts line from `tokens.css`. |
| Building iOS / Android | Use `splash-*`, `app-icon-*`, `android-adaptive-*`, `android-play-store-512.png`. |
| Print, signage, merch, embroidery | Use `mark-vector*.svg`. Never a PNG. |
| Writing copy | Section 6, Voice. |

---

## 2. Colour

Six colours lifted from the rings of the mark, plus a neutral scale.
**Voe Navy carries the brand.** The other five are *section colours* — one per
area of the app. Never two section colours inside one component.

| Token | Name | Hex | Use |
| --- | --- | --- | --- |
| `--os-navy` | Voe Navy | `#17395B` | Primary. Type, headers, dark UI, one-colour mark. |
| `--os-teal` | Sea Teal | `#2A8E82` | Wallet, loyalty, payments, success. |
| `--os-amber` | Buoy Amber | `#EFAE4A` | What's On, island alerts, warnings. |
| `--os-coral` | Lamb Coral | `#E1604C` | Fetch, delivery, destructive/urgent. |
| `--os-purple` | Heather | `#A45FAE` | Hubs, community, memberships, donations. |
| `--os-indigo` | Simmer Dim | `#5C5FA0` | Spik, Aald Stories, Da Boats. |

Each has `-light` (hover) and `-dark` (pressed) steps — use those, don't
compute your own.

**Neutrals:** Paper `#F4F3F0` (page ground) · Haar `#E4E3DE` (wells, dividers)
· Stane `#9A9A96` (disabled) · Peat `#4A4A48` (secondary text) · Ink `#101112`
(body copy) · White `#FFFFFF` (card surfaces).

**Contrast rules — non-negotiable:**
- Body copy is Ink on Paper, or White on Voe Navy.
- Buoy Amber and Sea Teal never carry white text. Use Ink.
- Lamb Coral, Heather and Simmer Dim take white text at 18px and above only.
- One section colour per screen, alongside Voe Navy.

**Section → colour map** is in `tokens.json` under `sectionColour`, and as
`[data-section="…"]` rules at the foot of `tokens.css`. Set `data-section` on
a screen's root and use `var(--os-accent)` inside it.

---

## 3. Type

- **Headings:** Barlow Condensed 600, tracking `-0.02em`, line-height 1.1.
- **Body:** Barlow 400 / 500 / 700, line-height 1.6, measure capped at 68ch.
- **Labels / eyebrows:** Barlow 400, 11px, uppercase, tracking `0.22em`.
- Numerals tabular in tables, wallet balances and any figure column.
- Scale: display 58 · h1 42 · h2 34 · h3 25 · h4 20 · body 16 · small 14 · micro 11.

Both faces load from the Google Fonts URL at the top of `tokens.css`.
Self-host if the app must work offline — same families, same weights.

---

## 4. Logo

Eight brush-drawn rings orbiting one open centre: many islands, one place.

**Rules**
1. Never redraw the mark. Use the supplied files.
2. The open centre stays empty — no letters, no fill, nothing behind it.
3. Full-colour mark on Paper or White only. On colour or photography use `mark-white-1024.png`.
4. No shadows, glows, outlines, gradients, rotation, stretching or squashing.
5. Clear space on all sides = 0.25 × mark height. Keep it free of type, rules and other logos.
6. Minimum size: 24px on screen, 10mm in print. Below 24px use `favicon.svg`.

**Lockups**
- *Horizontal* (default): mark left, "OneShetland" right with "60° NORTH" beneath.
  Cap-height of the word = 0.46 × mark height; gap = 0.20 × mark height.
- *Stacked*: mark above, word and descriptor centred beneath. Splash, posters, merch.
- *Mark alone*: avatars, app icon, favicon.

**Two masters, two jobs**
- `mark-master.svg` + `mark-master-1254.png` — the brush artwork. Use for anything
  reproduced above 24px. Keep the two files together; the SVG references the PNG.
- `mark-vector.svg` — a simplified redraw: six true ellipse paths, each one's size,
  centre and angle measured off the brush artwork. Infinitely scalable. Use for
  embroidery, vinyl, engraving, laser and any process the brushwork can't survive.
  It reads as the same object, not as the same drawing.

---

## 5. Icons

Lucide, stroke-width **1.5**, on a 24px grid. Line only — never filled, never
two-tone. An icon takes its section's colour. Do not mix icon sets.

Section icons in use: Local `map-pin` · Wallet `credit-card` · What's On
`calendar` · Fetch `truck` · Work `briefcase` · Hubs `users` · Spik
`book-open` · Da Boats `anchor` · Cruise `ship` · Games `sparkles`.

---

## 6. Voice

- **Tagline:** "Everything Shetland, in one place." Comma, full stop. Never
  abbreviated, never translated, never reworded.
- **Supporting line:** "Built for the islands, by the islands." Once per page, no more.
- **Dialect:** Shaetlan appears in *section names only* — Spik, Aald Stories,
  Da Boats. Never in instructions or UI copy. Set plain: no italics, no quote
  marks, no gloss. It is **Aald**, not "Auld".
- **Tone:** plain, warm, specific. Say what a thing does. No hype, no
  exclamation marks, no emoji.

---

## 7. Watermarks

All from the mono mark, never the full-colour version.

| Treatment | Asset | Opacity | Use |
| --- | --- | --- | --- |
| Bleed corner | `mark-navy-1024.png` | 8% | Letterheads, invoices, certificates. Cropped off the lower-right edge. |
| Centred ghost | `mark-white-1024.png` | 10% | Slide backs, holding screens, dark panels. |
| Repeat tile | `watermark-navy-8pct-1024.png` | baked 8%, 96px tile | Packaging, linings, security print. |

Never place a watermark under body copy above these opacities.

---

## 8. Asset inventory

### Logo
| File | Size | Use |
| --- | --- | --- |
| `mark-master.svg` + `mark-master-1254.png` | scalable | Brush master. Keep together. |
| `mark-colour-1024.png` | 1024² | Primary mark, transparent, light grounds. |
| `mark-white-1024.png` | 1024² | Reversed mark for navy and photography. |
| `mark-navy-1024.png` | 1024² | Single-colour mark, Voe Navy. |
| `mark-ink-1024.png` | 1024² | One-colour print, engraving, stamps. |
| `mark-vector.svg` | scalable | True-path redraw, full colour. |
| `mark-vector-navy.svg` | scalable | One-colour vector — vinyl, single-plate print. |
| `mark-vector-white.svg` | scalable | Reversed vector for dark grounds. |
| `watermark-navy-8pct-1024.png` | 1024² | Ready-made 8% watermark and repeat tile. |

### Icons
| File | Size | Use |
| --- | --- | --- |
| `favicon.svg` | scalable | Single-ring favicon — link this one. |
| `favicon-32.png`, `favicon-16.png` | 32², 16² | Legacy fallbacks. |
| `apple-touch-icon-180.png` | 180² | iOS home-screen web icon. |
| `app-icon-1024-paper.png` | 1024² | iOS / Android store icon, light. |
| `app-icon-1024-navy.png` | 1024² | Dark-mode icon set. |
| `android-adaptive-foreground-432.png` | 432² | Adaptive icon foreground. |
| `android-adaptive-background-432.png` | 432² | Adaptive icon background. |
| `android-adaptive-monochrome-432.png` | 432² | Themed icons, Android 13+. |
| `android-play-store-512.png` | 512² | Play Store listing icon. |

### Screens & social
| File | Size | Use |
| --- | --- | --- |
| `splash-phone-1170x2532.png` | 1170 × 2532 | iPhone launch screen, light. |
| `splash-phone-dark-1170x2532.png` | 1170 × 2532 | iPhone launch screen, dark. |
| `splash-tablet-2048x2732.png` | 2048 × 2732 | iPad / tablet launch screen. |
| `og-card-light-1200x630.png` | 1200 × 630 | Open Graph / link preview, light. |
| `og-card-dark-1200x630.png` | 1200 × 630 | Open Graph / link preview, navy. |

### Code
| File | Use |
| --- | --- |
| `tokens.json` | Machine-readable source of truth. Read this first. |
| `tokens.css` | CSS custom properties, base type, section-accent rules. |
| `tailwind.brand.js` | Tailwind theme fragment to merge. |
| `manifest.webmanifest` | PWA manifest with the full icon set. |
| `head-snippet.html` | Favicons, theme-color, OG/Twitter meta. |

---

## 9. Rebranding checklist

- [ ] `tokens.css` imported once at the app root; no other font or colour imports remain.
- [ ] Every hard-coded hex replaced with an `--os-*` variable. Grep for `#` in styles.
- [ ] Every screen root carries `data-section` so `var(--os-accent)` resolves.
- [ ] Headings on Barlow Condensed 600; body on Barlow. No Inter, Roboto or system stack left.
- [ ] Border radius 0–4px. No pill cards, no large rounded containers.
- [ ] Favicons, apple-touch-icon and manifest replaced; `theme-color` is `#17395B`.
- [ ] OG and Twitter images point at the 1200 × 630 cards.
- [ ] Native splash screens replaced for phone and tablet, light and dark.
- [ ] Android adaptive layers (foreground, background, monochrome) in place.
- [ ] All icons Lucide at stroke-width 1.5. No filled or duotone icons.
- [ ] Copy audited: tagline exact, "Aald" not "Auld", no emoji, no exclamation marks.
- [ ] Contrast rules honoured — no white text on Amber or Teal.

---

## 10. Provenance

Every raster and vector here is generated from one keyed master
(`mark-master-1254.png`), so all files stay in register. The palette was
sampled from that artwork, not chosen separately.

**Known gaps** — ask before assuming:
- The vector mark is a measured simplification, not a trace of the brush texture.
  For very large-format print, source the original brush artwork.
- No square (1080²) or story (1080 × 1920) social crops yet.
- No email signature, business card or document templates yet.
- No dark-mode UI palette beyond the reversed mark and navy grounds.
