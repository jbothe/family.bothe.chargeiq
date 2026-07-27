#!/usr/bin/env bash
#
# Re-download Homey's own Style Library assets over the committed copies in this folder.
#
# These files are committed deliberately (see README.md), so the point of this script is not
# initial setup - a fresh clone already works. It is to answer "did a firmware update change
# anything?", which is a plain:
#
#     ./test/homey-css/fetch.sh && git diff --stat test/homey-css
#
# An empty diff means the committed copies still match the Homey. A non-empty one is a real
# finding and worth reading before committing - the pair screen's appearance depends on it.
#
# Usage:
#     HOMEY_ASSETS_BASE='https://<your-homey-id>.connect.athom.com/manager/webserver/assets' \
#       ./test/homey-css/fetch.sh
#
# Find <your-homey-id> in the URL bar with the Homey web app open. It is not hardcoded here
# because it differs per Homey.
set -euo pipefail

BASE="${HOMEY_ASSETS_BASE:-}"
if [ -z "$BASE" ]; then
  echo "error: set HOMEY_ASSETS_BASE first - see the usage comment at the top of this file." >&2
  exit 2
fi
BASE="${BASE%/}"

cd "$(dirname "$0")"

# Every file the six partials and homey.drivers.css actually reference, plus the manifest itself.
# Paths are relative to the asset root and are mirrored verbatim into this folder, which is what
# keeps the relative @import / url() paths inside the CSS resolving unchanged.
#
# Note css/homey.css (the Style Library manifest, all @imports and no rules) vs css/homey.drivers.css
# (the pairing wizard chrome, #hy-wrap / #hy-views / .hy-view). Similar names, unrelated files -
# and there is no homey-drivers.css or homey-app.css on the server despite those names having
# circulated here early on; both were this same homey.css saved twice under invented filenames,
# confirmed byte-identical by md5.
FILES=(
  css/homey.css css/homey.drivers.css
  css/_homey-variables.css css/_base.css css/_homey-typography.css
  css/_homey-button.css css/_homey-form.css css/_homey-icon.css
  font/roboto/roboto.css
  font/roboto/Roboto-Regular.ttf font/roboto/Roboto-Medium.ttf font/roboto/Roboto-Bold.ttf
  font/notosansarabic/notosansarabic.css
  font/fontawesome/fontawesome.css
  icons/chevron-down-regular.svg icons/checkmark.svg
  icons/checkmark-square-empty.svg icons/checkmark-square-fill.svg
  icons/arrow-left.svg icons/arrow-right.svg
  img/spinner.svg img/throbber-black.svg img/throbber-white.svg
  img/search.png img/search-clear.png
)

fail=0
for p in "${FILES[@]}"; do
  mkdir -p "$(dirname "$p")"
  tmp="$(mktemp)"
  code="$(curl -sS -o "$tmp" -w '%{http_code}' "$BASE/$p" || echo 000)"

  if [ "$code" != "200" ]; then
    printf '  FAIL %-46s HTTP %s\n' "$p" "$code"
    rm -f "$tmp"; fail=1; continue
  fi

  # A 404 here is often served *with* an HTML body, so status alone is not enough - and a saved
  # error page under the right filename is exactly how two SVGs silently broke the harness once.
  # icons/ and img/ are siblings of css/, not children; a css/-relative URL is the usual cause.
  if head -c 200 "$tmp" | grep -qiE '^[[:space:]]*<(!doctype html|html[[:space:]>])'; then
    printf '  FAIL %-46s HTML error page (wrong folder? see README)\n' "$p"
    rm -f "$tmp"; fail=1; continue
  fi

  mv "$tmp" "$p"
  printf '  ok   %-46s %s bytes\n' "$p" "$(wc -c < "$p" | tr -d ' ')"
done

if [ "$fail" -ne 0 ]; then
  echo
  echo "One or more files failed; existing copies were left untouched." >&2
  exit 1
fi

echo
echo "All ${#FILES[@]} files fetched. Now: git diff --stat test/homey-css"
