# Arbr brand assets

Logos, colours, and usage rules for Arbr. If you are adding Arbr's mark to a
slide, a blog post, an integration page, or a fork's README, this is the source
of truth.

> **Trademark notice.** The Arbr **name and logo are not covered by the MIT
> licence** that governs this repository's source code. The code is yours to use,
> modify, and redistribute under MIT. The marks are not. See
> [Using the marks](#using-the-marks) below.

---

## Files in this folder

| File | Format | Use |
|---|---|---|
| `arbr-wordmark.svg` | SVG, ink `#171817` | Primary wordmark for **light** backgrounds. Prefer this everywhere it renders. |
| `arbr-wordmark-dark.svg` | SVG, white | Wordmark for **dark** backgrounds. |
| `arbr-wordmark.png` | PNG 1200×285, transparent | Raster fallback for light backgrounds (email, tools without SVG). |
| `arbr-wordmark-dark.png` | PNG 1200×285, transparent | Raster fallback for dark backgrounds. |
| `arbr-mark.svg` | SVG, ink `#171817` | The **A** apex mark alone, transparent. Favicons, in-app icons, tight square spaces on a known background. |
| `arbr-mark.png` | PNG 512×512, transparent | Raster mark for favicons. |
| `arbr-avatar.svg` / `.png` | SVG / PNG 512×512, paper mark on ink | **Org / social avatar** — a solid-background lockup. Use this (not the transparent mark) anywhere the avatar sits on an unknown or varying background and gets cropped to a rounded square (GitHub org avatar, npm, X, etc.). |
| `arbr-social-preview.png` | PNG 1280×640 | GitHub **social preview** (repo → Settings → Social preview) and OG/Twitter cards. |

All SVGs use no external fonts — the letterforms are outlined paths, so they
render identically everywhere. Recolour by editing the `fill` attribute; do not
apply CSS filters to shift the colour.

---

## Colour

The single-source accent is **cobalt**. Every green in older badges, the docs
theme, and the dashboard is legacy and is being migrated to cobalt — do not
introduce new greens.

| Token | Hex | RGB | Use |
|---|---|---|---|
| **Signal** (accent) | `#2f37ff` | `47, 55, 255` | Links, focus rings, the one thing on screen that should draw the eye. Use sparingly. |
| **Ink** | `#171817` | `23, 24, 23` | Logo on light, primary text, dark UI surfaces. |
| **Paper** | `#f3f2ed` | `243, 242, 237` | Warm off-white page background. Not pure white. |

Derive tints from the signal RGB rather than picking new hex values — e.g.
`rgba(47, 55, 255, 0.12)` for a hover wash. This mirrors the website, where the
accent is single-sourced from `--signal-rgb: 47, 55, 255`.

Contrast: ink on paper is ~15:1; signal `#2f37ff` on paper is ~7:1 — both clear
WCAG AA for text. White on signal is ~5.4:1 (AA for UI/large text); do not put
small ink text on a signal fill.

---

## Clear space & minimum size

- **Clear space:** keep padding of at least the height of the **A** apex on all
  sides of the wordmark. Nothing — text, other logos, edges — intrudes into it.
- **Minimum size:** wordmark no smaller than **96 px** (or 24 px tall) on screen;
  mark no smaller than **16 px**. Below that, switch from wordmark to mark.
- **Backgrounds:** use the dark wordmark only on surfaces at or darker than ink.
  Over a photo or busy background, place the logo on a solid ink or paper panel
  first — never key it directly over imagery.

---

## Do / don't

**Do**
- Use the SVG wherever possible.
- Pick the light or dark variant to suit the background.
- Keep the logo monochrome (ink or white).

**Don't**
- Recolour the logo to the signal cobalt, or any colour other than ink/white.
- Stretch, rotate, skew, add shadows, outlines, or gradients.
- Recreate the wordmark in another typeface, or change letter spacing.
- Box the wordmark in when clear space is available.
- Use the old baked-in dark rectangle version from the design source; the dark
  variant here is transparent so it sits on any dark surface.

---

## Using the marks

You **may**, without asking:

- Use the logo to link to this project or to state that your product integrates
  with or is built on Arbr ("Works with Arbr", "Powered by Arbr Control Plane"),
  provided the logo is unmodified and the relationship is stated accurately.
- Reproduce the logo in articles, talks, and documentation that reference Arbr.

You **may not**, without written permission:

- Use the Arbr name or logo as (or as part of) your own product, company, or
  domain name, or in a way that implies endorsement, sponsorship, or affiliation.
- Modify the marks, or use them as the primary branding of a fork or a derived
  hosted service.

Forks: the MIT licence lets you ship the code under your own name and brand.
Please replace Arbr's marks with your own so users can tell the projects apart.

Questions about usage: open an issue or contact the maintainers.

---

## Regenerating the raster assets

The PNGs are rendered from the SVGs (no design tool needed). With headless
Chrome:

```sh
# wordmark → 1200×285 PNG, transparent
chrome --headless=new --disable-gpu --default-background-color=00000000 \
  --screenshot=arbr-wordmark.png --window-size=1200,285 render.html
```

where `render.html` sizes the SVG to `width:1200px` on a transparent body. The
`--headless=new` flag matters — the legacy headless mode fails to apply
`@font-face` data-URIs. The social card is built from an HTML template with the
Inter variable font inlined as a base64 `woff2` (Chrome blocks `file://` font
loads otherwise). Keep the vector SVGs as the source; regenerate PNGs from them.
