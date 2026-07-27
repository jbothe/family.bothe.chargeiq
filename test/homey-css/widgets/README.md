# Homey widget Style Library (dev-only, committed, never shipped)

A **separate** asset tree from `../css`/`../font`/`../icons`/`../img` (the pair/settings Style
Library) - Homey ships a distinct set of CSS for widgets, documented at
https://apps.developer.homey.app/the-basics/widgets/styling, with its own manifest
(`homey.widgets.css`, not `homey.css`), its own variable-naming scheme, and its own font folder
layout. `test/widget-preview.html` links this tree to render
`widgets/power-flow/public/index.html` against real injected styling. Nothing in
`app.json`/`widget.compose.json` references `test/`, so none of this is packaged with the app.

Stored verbatim (original filenames, original relative layout) so `homey.widgets.css`'s own
`@import url(./...)` chain and `_homey-fonts.css`'s `url(../fonts/...)` resolve unchanged.

## Refreshing

Widget assets live under a `/widgets` suffix on the same base as `../fetch.sh` (the pair/settings
assets):

```bash
HOMEY_ASSETS_BASE='https://<your-homey-id>.connect.athom.com/manager/webserver/assets' \
  ./test/homey-css/widgets/fetch.sh && git diff --stat test/homey-css/widgets
```

i.e. `https://<your-homey-id>.connect.athom.com/manager/webserver/assets/widgets/css/homey.widgets.css`
and siblings. Same `HOMEY_ASSETS_BASE` value as `../fetch.sh` - this script appends `/widgets`
itself.

## Layout

```
css/
  homey.widgets.css      <- manifest: @imports the seven files below, no rules of its own
  _homey-fonts.css       <- @font-face declarations, url(../fonts/...) - see Fonts below
  _normalize.css         <- modern-normalize v3.0.0 (third-party reset, MIT licensed)
  _homey-variables.css   <- --homey-* custom properties + the .homey-dark-mode override block
                             - see Dark mode below
  _homey-base.css        <- html/body base, .homey-widget/-small/-full padding
  _homey-text.css        <- .homey-text-bold/-medium/-regular/-small/-small-light/-align-*
  _homey-icons.css       <- [class^='homey-custom-icon-'] sizing (no bundled icon files - a
                             widget supplies its own icon content, e.g. inline SVG, this class
                             only sizes/colors it via --homey-icon-size-*/--homey-icon-color-*)
  _homey-borders.css     <- .homey-border/-top/-right/-bottom/-left/-start/-end
  _homey-tables.css      <- .homey-table / .homey-table-striped
fonts/
  Roboto-Regular.ttf         <- byte-identical to ../font/roboto/Roboto-Regular.ttf
  Roboto-Medium.ttf          <- byte-identical to ../font/roboto/Roboto-Medium.ttf
  Roboto-Bold.ttf            <- byte-identical to ../font/roboto/Roboto-Bold.ttf
  Roboto-RegularItalic.ttf
  NotoSansArabic-Regular.ttf
  NotoSansArabic-Bold.ttf
  NotoSansArabic-Medium.ttf
  NotoSansArabic-Black.ttf
```

The three Roboto weights are byte-for-byte identical to `../font/roboto/`'s copies - Homey serves
the same font binary from both asset trees, just at different paths (`fonts/Roboto-Regular.ttf`
here vs `font/roboto/Roboto-Regular.ttf` there).

`css/_homey-variables.css` is a different file from `../css/_homey-variables.css` (the
pair/settings copy), not the same file at two paths: different variable-naming scheme
(`--homey-color-mono-010` here vs `--homey-color-mono-0`/`-01`/... there) and this copy alone
defines `--homey-table-head-color`, `--homey-line-light`, and `--homey-icon-size-medium`, none of
which exist in the pair/settings copy.

## Fonts

`_homey-fonts.css` declares Roboto at four weights/styles and NotoSansArabic at four weights, all
via `url(../fonts/<name>.ttf)` - a flat `fonts/` folder, not the pair/settings tree's
per-family `font/<family>/` subfolders. Only Regular/Medium/Bold are reachable from
`widgets/power-flow/public/index.html` today (it uses `.homey-text-*` classes, which map to
regular/medium/bold weights - see `_homey-text.css` - never italic or Arabic).

## Icons

`_homey-icons.css` only sizes/colors a `homey-custom-icon-*`-prefixed class via
`-webkit-mask-size`/`background-color` - it does not bundle any icon SVGs of its own the way the
pair wizard's `_homey-icon.css` bundles `arrow-left.svg`/`arrow-right.svg`. A widget supplies its
own icon content (inline SVG, a mask-image pointing at its own asset, etc.); nothing to fetch here.
`widgets/power-flow/public/index.html` doesn't use `homey-custom-icon-*` at all - its icons are
inline `<svg>` markup, styled via plain CSS (`color`/`width`/`height`), not this class.

## Dark mode

`css/_homey-variables.css` carries a `.homey-dark-mode { ... }` block redeclaring every
mono/background/text-color-light/line/icon token the rest of this tree uses, scoped to that class
- the same class `widgets/power-flow/public/index.html`'s top-of-file comment names as "a
separate, opt-in class for forcing dark mode, not something Homey sets automatically". There is no
separate dark stylesheet on the server (`_homey-variables-dark.css` does not exist); one file
carries both light and dark. `test/widget-preview.html`'s `setDarkClass()` toggles
`.homey-dark-mode` on the iframe's `<html>` once the base sheet is loaded.

This is a different mechanism from the pair/settings tree's invert-filter (`../README.md`'s "Dark
mode" section): pair/settings dark mode is a client-side CSS filter needing nothing theme-specific
from the server; widget dark mode is Homey's own semantic tokens resolving to different literal
values under an opt-in class.
