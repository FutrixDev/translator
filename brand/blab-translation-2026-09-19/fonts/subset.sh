#!/bin/sh
# Cuts the two bundled fonts down to the glyphs the brand drawings print, so the
# export never falls back to whatever fonts the host happens to have.
# Rerun after changing any text in icon.js or export.html:
#   sh brand/blab-translation-2026-09-19/fonts/subset.sh <nunito.ttf> <noto-sans-sc.ttf>
# Sources: the variable TTFs from github.com/googlefonts/nunito and
# github.com/notofonts/noto-cjk (both SIL OFL 1.1, see OFL.txt).
set -eu
HERE=$(dirname "$0")
# Latin comes from Nunito, which is first in the stack; Noto only has to cover the Chinese.
LATIN=' ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz·'
CJK='叭翻译，一切网页电子书视频字幕'
subset() {
  uv run --with fonttools --with brotli pyftsubset "$1" --flavor=woff2 \
    --text="$2" --layout-features='*' --output-file="$HERE/$3"
}
subset "$1" "$LATIN" nunito.woff2
subset "$2" "$CJK" noto-sans-sc.woff2
