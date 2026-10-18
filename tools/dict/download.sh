#!/usr/bin/env bash
# Fetch the datasets the dictionary build reads and check every one against sources.json.
#
# Usage: bash tools/dict/download.sh <data-dir> [--offline]
#
# Each file of tools/dict/sources.json lands at <data-dir>/<path>. A file already there is not
# fetched again; every file, fetched or not, must match its sha256, or the script exits 1.
# --offline fetches nothing and only checks (build.sh runs it this way).
#
# kaikki.org and Tatoeba publish new dumps under the same URL, so on a later date a fresh fetch
# is expected to fail the check: regenerate sources.json (README.md) and rebuild, rather than
# building from data nobody pinned.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
data="${1:?usage: download.sh <data-dir> [--offline]}"
offline=0
[[ "${2:-}" == "--offline" ]] && offline=1

rows="$(python3 -I - "$here/sources.json" <<'PY'
import json, sys
for r in json.load(open(sys.argv[1], encoding='utf-8'))['files']:
    print('\t'.join((r['path'], r['url'], r['sha256'])))
PY
)"

bad=0
n=0
while IFS=$'\t' read -r path url sha; do
  n=$((n + 1))
  dest="$data/$path"
  if [[ ! -f "$dest" ]]; then
    if (( offline )); then
      echo "missing: $path" >&2
      bad=$((bad + 1))
      continue
    fi
    mkdir -p "$(dirname "$dest")"
    echo "fetch: $url" >&2
    curl -fsSL --retry 3 -o "$dest.part" "$url"
    mv "$dest.part" "$dest"
  fi
  got="$(shasum -a 256 "$dest" | cut -d' ' -f1)"
  if [[ "$got" != "$sha" ]]; then
    echo "sha256 mismatch: $path (want $sha, got $got)" >&2
    bad=$((bad + 1))
  fi
done <<< "$rows"

if (( bad )); then
  echo "download: $bad of $n files missing or changed" >&2
  exit 1
fi
echo "download: $n files verified"
