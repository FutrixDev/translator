#!/usr/bin/env bash
# Build every v1 dictionary pack from the pinned datasets (npm run dict:build).
#
# Environment:
#   DICT_DATA_DIR     the datasets, laid out as tools/dict/sources.json says (required; fill it
#                     with `bash tools/dict/download.sh "$DICT_DATA_DIR"`). Read only, never run.
#   DICT_SAMPLES_DIR  the per-language sample token tables check.py measures hits and readings
#                     on (default: $DICT_DATA_DIR/../samples/tokens)
#   DICT_VER          the packs' `ver` (default: today, UTC, YYYY.MM.DD)
#   DICT_JOBS         processes (default: all cores)
#   DICT_PACKS        a comma-separated subset such as es-en,ja-en (default: all 30)
#
# Output under build/dict/ (git-ignored):
#   norm/     the normalized datasets (normalize.py)
#   work/     per-language tables several packs share (pairs.py prepare)
#   out/<pack>/{<pack>.json, LICENSE.txt, ATTRIBUTION.txt}
#   stats/    per-pack numbers and the no-example variants
#   samples/  the sample tables, copied for check.py
# norm/, work/, out/ and stats/ are rebuilt from scratch on every run.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
data="${DICT_DATA_DIR:?set DICT_DATA_DIR to the dataset directory (see tools/dict/README.md)}"
data="$(cd "$data" && pwd)"
samples="${DICT_SAMPLES_DIR:-$data/../samples/tokens}"
ver="${DICT_VER:-$(date -u +%Y.%m.%d)}"
jobs="${DICT_JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || nproc)}"
build="$root/build/dict"

start=$(date +%s)
step() { echo "== $1 ($(( $(date +%s) - start ))s)"; }

step "verify datasets"
bash "$here/download.sh" "$data" --offline

step "normalize"
rm -rf "$build/norm" "$build/work" "$build/out" "$build/stats"
mkdir -p "$build"
python3 -I "$here/normalize.py" "$data" "$build/norm" --jobs "$jobs"

step "samples"
[[ -d "$samples" ]] || { echo "no sample tables at $samples (set DICT_SAMPLES_DIR)" >&2; exit 1; }
rm -rf "$build/samples"
mkdir -p "$build/samples"
cp "$samples"/tokens.*.tsv "$build/samples/"

step "packs"
packs=()
[[ -n "${DICT_PACKS:-}" ]] && packs=(--packs "$DICT_PACKS")
python3 -I "$here/pairs.py" "$build/norm" "$build/out" --work "$build/work" \
  --stats "$build/stats" --ver "$ver" --license "$here/cc-by-sa-4.0.txt" --jobs "$jobs" \
  ${packs[@]+"${packs[@]}"}

step "done"
echo "dict:build: ver $ver in $(( $(date +%s) - start ))s"
