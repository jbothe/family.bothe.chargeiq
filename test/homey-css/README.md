# Homey Style Library (dev-only, committed, never shipped)

Athom's own CSS, fonts and icons, exactly as a Homey serves them to a pairing wizard and to an app
settings page, so `test/pair-login-preview.html` can render `drivers/charger/pair/start.html` and
`test/settings-preview.html` can render `settings/index.html` against the real injected styling.
Nothing in `app.json` or `driver.compose.json` references `test/`, so none of this is packaged
with the app.

**Widgets have their own, separate copy in `widgets/`** (`homey.widgets.css`, not `homey.css`),
served under a `/widgets` suffix on this same asset base - different manifest, different
variable-naming scheme, different font folder layout, and a different (class-based rather than
filter-based) dark-mode mechanism. See `widgets/README.md` for that tree specifically.

Stored **verbatim** — original filenames and folder layout, no combining or renaming — so the
relative `@import` and `url()` paths inside the files resolve unchanged, and the committed copies
stay byte-comparable against a live Homey.

These are Homey firmware assets, not anything app-specific — the same Style Library files a Homey
serves regardless of which app's pairing wizard requests them, which is why `fetch.sh` below takes
no app-specific parameters.

## Refreshing

```bash
HOMEY_ASSETS_BASE='https://<your-homey-id>.connect.athom.com/manager/webserver/assets' \
  ./test/homey-css/fetch.sh && git diff --stat test/homey-css
```

`fetch.sh` re-downloads all 25 files in place; `git diff` then shows whether a firmware update
changed the pair screen. It rejects any response that is an HTML error page rather than writing
it over a good file, and leaves existing copies untouched if anything fails. Find
`<your-homey-id>` in the URL bar with the Homey web app open. No authentication is needed.

**`icons/` and `img/` are siblings of `css/`, not children.** The sheets reach them as
`../icons/` and `../img/`. A `css/`-relative URL returns a 404 whose body is an HTML error page,
which then saves under the right filename and passes any does-the-file-exist check:

```
assets/icons/chevron-down-regular.svg      not  assets/css/icons/…
assets/img/spinner.svg                     not  assets/css/img/…
```

**`homey.css` vs `homey.drivers.css`** — similar names, unrelated files. The first is the Style
Library manifest (all `@import`s, no rules of its own); the second is the pairing wizard chrome
(`#hy-wrap` / `#hy-views` / `.hy-view` / `#hy-nav`). There is no `homey-drivers.css` or
`homey-app.css` on the server.

**`homey.drivers.css` is pair-only.** A pair view is one fragment inside Homey's own multi-step
wizard shell, which is what that file's chrome belongs to. An app settings page
(`settings/index.html`) is loaded standalone, with no wizard around it, so Homey injects only
`homey.css` (the manifest) and its six partials there — never `homey.drivers.css`. This is the
one difference between the two harnesses: `test/pair-login-preview.html` links both stylesheets,
`test/settings-preview.html` links only `homey.css`.

## Layout

```
test/homey-css/
  css/
    homey.css                <- Style Library manifest: @imports only, no rules
    homey.drivers.css        <- pairing wizard chrome (#hy-wrap / #hy-views / .hy-view / #hy-nav)
    _homey-variables.css     <- --homey-* custom properties (colors, --homey-su-* spacing)
    _base.css                <- reset / base element styles
    _homey-typography.css    <- .homey-title / .homey-subtitle / .homey-text-* / .homey-form-legend
    _homey-button.css        <- .homey-button-* (native Continue button on start.html, see caveat
                                 below; .homey-button-primary/-secondary-shadow/-danger-shadow/
                                 -transparent on settings/index.html directly)
    _homey-form.css          <- .homey-form-fieldset/-checkbox/-input/-label (unused by start.html,
                                 used throughout settings/index.html)
    _homey-icon.css          <- .homey-icon-arrow-{left,right} (unused by both preview pages today)
  font/
    roboto/roboto.css        <- + its .ttf files (see Fonts)
    notosansarabic/notosansarabic.css
    fontawesome/fontawesome.css
  icons/
    chevron-down-regular.svg <- unused by start.html (no <select> there); kept for parity
    checkmark.svg
    checkmark-square-empty.svg
    checkmark-square-fill.svg
    arrow-left.svg           <- RTL swaps the pair; possible Continue-button icon
    arrow-right.svg          <- possible Continue-button icon                    [pair view]
  img/
    spinner.svg               <- possible Continue button .is-loading state      [pair view]
    throbber-black.svg        <- .hy-throbber-black, #hy-overlay-loading (step transitions)
    throbber-white.svg
    search.png                <- 32x32, unused by start.html
    search-clear.png          <- 32x32, unused by start.html
```

Only the two marked `[pair view]` are directly reachable from `start.html` today (via the native
Continue-button chrome — see the caveat below); the rest cover checkboxes, radios, wizard nav, the
loading overlay and search fields used by Homey's own built-in `list_devices`/`add_devices`
templates later in the same pairing flow, and are kept so those don't need another download.
`settings/index.html` reaches none of `icons/`/`img/` at all — its checkbox/stepper controls are
Style Library classes, not images, and it has no loading-overlay or Continue-button chrome to draw.

Without the six `_*.css` partials the pair/settings screens render essentially unstyled —
`homey.css` alone carries no rules.

## Fonts

`font/*/*.css` declares `@font-face` rules pointing at **`.ttf`** files beside them. Without the
binaries the browser falls back to a system font, and font metrics are what this harness exists
to get right.

`roboto.css` declares eight faces, but only three weights are reachable from the pair/settings
screens:

| Weight | File | Used by |
|---|---|---|
| 700 | `Roboto-Bold.ttf` | `.homey-title`, `.window-title` (settings) |
| 500 | `Roboto-Medium.ttf` | `[class*='homey-button']`, incl. the native Continue button and every settings button |
| 400 | `Roboto-Regular.ttf` | `.homey-subtitle`, `.homey-text-regular`, form labels/inputs (settings) |

A missing weight is synthesised from Regular, with the wrong metrics. Noto Sans Arabic and Font
Awesome matter only for RTL locales and Homey's icon glyphs; the harness names whichever files
are absent.

## Dark mode

Homey **inverts** a pair view or settings page rather than re-theming it, and both harnesses do
the same:

```css
html { filter: invert(1) hue-rotate(180deg); }
```

That is the `--theme-filter-dark-mode` Homey's own web app defines
(`:root, .lightTheme { none }` / `.darkTheme { invert(1) hue-rotate(180deg) }`). `invert(1)` flips
lightness; the `hue-rotate(180deg)` restores hues, so blues stay blue. Filtering the root inverts
its own background too, so `_base.css`'s `--homey-color-white` renders `#000`.

The Style Library has **no dark values at all** — no `prefers-color-scheme` query, no
`[data-theme]` selector, no `@media` block in any partial. On a real Homey in dark mode, inside
either frame, `--homey-color-white` still computes to `#fff` while the screen renders dark.
Nothing here changes between light and dark, which is why switching theme downloads nothing.

Inversion is also the only mechanism available: both the wizard and the settings iframe are
served from `<id>.connect.athom.com`, separately from the `my.homey.app` shell, so the shell
cannot reach into either one's DOM to re-theme it. A filter on the frame needs no DOM access.

### Consequences for `pair/start.html` and `settings/index.html`

- Everything inverts wholesale and **no `--homey-*` token can opt out**. There are no images on
  `start.html` to worry about negating; `settings/index.html`'s per-window swatches and chart
  cells use inline `background` colors (data-driven, not `--homey-*` tokens) and invert too.
- A hardcoded colour is not the light-only bug it would be under a themed system — it inverts
  along with everything else. `start.html` has none; it is entirely Style Library classes.
  `settings/index.html` has a handful of defensive literal-color fallbacks (`--homey-line`, the
  uncovered-chart-cell background) documented inline in its own `<style>` block, for the same
  reason — see that file's own comments for why each one exists.

## Not covered

- **The native Continue button's actual markup/class.** `start.html` declares
  `"navigation": { "next": "list_devices" }` in `driver.compose.json` and supplies no button of
  its own, so Homey renders its own chrome inside `#hy-nav`. That chrome's exact class name,
  label, and icon are assigned by Homey's proprietary wizard JS (served from `my.homey.app`, not
  part of the Style Library CSS this folder holds), so it isn't something `fetch.sh` can retrieve.
  `test/pair-login-preview.html` renders a labelled **approximation** (`.homey-button-primary-full`
  inside `#hy-nav.visible`) — real placement/spacing confirmed via `homey.drivers.css`'s own
  `#hy-nav` grid rules, but the button's exact on-device appearance is unconfirmed. Not yet
  verified against a real device; see `CLAUDE.md`'s "Not yet verified on hardware" section.
- `Homey.alert()`'s modal is in none of these stylesheets (`homey.drivers.css` covers only
  `#hy-overlay-loading`), so the harness would show a clearly-labelled approximation of it if
  `start.html` ever called it (it doesn't today).
- **`settings/index.html`'s native `type=time` rendering.** The file's own comments already flag
  this as unconfirmed on-device (`.homey-form-input` is documented for text/number/password/url
  only) — a browser's native time control isn't something any of these stylesheets style, so
  `test/settings-preview.html` shows whatever this browser's own time picker looks like, which may
  not match a real Homey settings iframe's browser engine.
- **`--homey-line`.** `settings/index.html`'s own comments record that this token doesn't actually
  resolve on a real device (confirmed: the `.time-box` border rendered as nothing), which is why
  every use there already carries a literal `rgba(...)` fallback. `test/settings-preview.html`
  inherits that same fallback via the unmodified source file — nothing extra to do here, just
  noting it isn't a gap in this Style Library copy, it's a real (already-worked-around) Homey
  behaviour.
