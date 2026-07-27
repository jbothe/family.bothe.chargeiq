#!/usr/bin/env bash
#
# Re-download Homey's own widget Style Library assets over the committed copies in this folder.
#
# Widget assets live under a /widgets suffix on the same base as test/homey-css/fetch.sh (the
# pair/settings assets): manager/webserver/assets/widgets/. Set HOMEY_ASSETS_BASE to the same
# value you'd give that script - this one appends /widgets itself. Fetches the same defensive way
# test/homey-css/fetch.sh does (rejects HTML error pages rather than saving them over a good
# file). See ../README.md's "Layout" section for what each file is.
#
# Usage:
#     HOMEY_ASSETS_BASE='https://<your-homey-id>.connect.athom.com/manager/webserver/assets' \
#       ./test/homey-css/widgets/fetch.sh
set -euo pipefail

BASE="${HOMEY_ASSETS_BASE:-}"
if [ -z "$BASE" ]; then
  echo "error: set HOMEY_ASSETS_BASE first - see the usage comment at the top of this file." >&2
  exit 2
fi
BASE="${BASE%/}/widgets"

cd "$(dirname "$0")"

# Every file homey.widgets.css's own @import chain references, plus the manifest itself and
# every font weight _homey-fonts.css declares.
FILES=(
  css/homey.widgets.css
  css/_homey-variables.css
  css/_homey-base.css css/_homey-borders.css css/_homey-fonts.css
  css/_homey-icons.css css/_homey-tables.css css/_homey-text.css css/_normalize.css
  fonts/Roboto-Regular.ttf fonts/Roboto-Medium.ttf fonts/Roboto-Bold.ttf
  fonts/Roboto-RegularItalic.ttf
  fonts/NotoSansArabic-Regular.ttf fonts/NotoSansArabic-Bold.ttf
  fonts/NotoSansArabic-Medium.ttf fonts/NotoSansArabic-Black.ttf
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

  # A 404 is often served *with* an HTML body, so status alone is not enough - a saved error page
  # under a real-looking filename passes any presence-only check.
  if head -c 200 "$tmp" | grep -qiE '^[[:space:]]*<(!doctype html|html[[:space:]>])'; then
    printf '  FAIL %-46s HTML error page (wrong base URL?)\n' "$p"
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
echo "All ${#FILES[@]} files fetched. Now: git diff --stat test/homey-css/widgets"
