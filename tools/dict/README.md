# tools/dict — offline dictionary packs

Builds the 30 offline dictionary packs (34 directed pairs: a zh-CN source pack also serves
zh-TW) of design `ext-offline-dictionary.md` §1.2/§1.3 from open data, reproducibly, on one
machine. The pack format (v1 contract) is in [FORMAT.md](FORMAT.md). Nothing here is loaded by
the extension at runtime; the packs are published separately.

## Datasets

Every file the build reads is pinned in [sources.json](sources.json): URL, bytes, SHA-256,
the dataset it belongs to, its licence and its version date (the day it was downloaded, for
sources that republish under one URL). `attribution.py` takes the date it prints from there.

| id | dataset | licence | used for |
| --- | --- | --- | --- |
| wiktionary | Wiktionary via kaikki.org (wiktextract JSONL, English + own editions) | CC BY-SA 4.0 | heads, senses, translation tables, inflected forms, IPA, examples |
| cedict | CC-CEDICT | CC BY-SA 4.0 | zh heads, en glosses, pinyin, Traditional spellings, en->zh reverse lookup |
| jmdict | JMdict (EDRDG) | CC BY-SA 4.0 | ja heads, en glosses, kana, conjugation classes |
| tatoeba | Tatoeba sentences + links | CC BY 2.0 FR | human-translated examples (ids kept) |
| ipadict | ipa-dict | MIT | IPA fallback |
| cmudict | CMUdict | BSD 2-Clause | en US IPA fallback (ARPAbet converted) |
| opencc | OpenCC dictionary tables | Apache 2.0 | Simplified/Traditional conversion |

Not used, by decision: ECDICT (D-566), and no model output of any kind; nothing is pivoted
through English (a pack's glosses come only from data that pairs its two languages
directly). Every pack is CC BY-SA 4.0 (`LICENSE.txt`); its `ATTRIBUTION.txt` names only the
datasets that pack used (D-570). Licence notices for MIT/BSD/Apache live verbatim in
`notices/`, so a build never reads a licence out of the downloaded data.

## Reproduce

```bash
# 1. fetch (or verify) every pinned file; ~2.8 GB
bash tools/dict/download.sh "$DICT_DATA_DIR"          # --offline: verify only

# 2. build every pack into build/dict/out (git-ignored)
DICT_DATA_DIR=... DICT_SAMPLES_DIR=... npm run dict:build

# 3. check every pack against the contract and the acceptance lines (exit != 0 on any FAIL)
npm run dict:check
python3 -I tools/dict/check.py build/dict/out --report <dir>   # + packs.csv / coverage.csv
```

`build.sh` environment: `DICT_DATA_DIR` (required), `DICT_SAMPLES_DIR` (default
`$DICT_DATA_DIR/../samples/tokens`), `DICT_VER` (default today, UTC, `YYYY.MM.DD`),
`DICT_JOBS` (default the CPU count), `DICT_PACKS` (comma list such as `en-ja,ja-en`, default
all 30). Steps: verify (`download.sh --offline`) → `normalize.py` → copy the samples →
`pairs.py` → `check.py` (so a build that exits 0 has passed the check too). Output under `build/dict/`: `norm/` (normalized data), `work/` (per-language
tables shared by packs), `out/<pack>/` (`<pack>.json`, `LICENSE.txt`, `ATTRIBUTION.txt`),
`stats/` (per-pack numbers and the no-example variant), `samples/`.

**Samples.** The reading-rate gate (design §2.1) measures packs on sample tokens,
`tokens.<lang>.tsv` (a header row, then `token<TAB>count`) for the ten source languages. They are
derived from crawled pages and are not committed; `build.sh` refuses to run without them, and
`check.py` names the missing `tokens.<lang>.tsv`. They come from the 74 pages listed in the
offline-dictionary spike (`docs/delivery/evidence/offline-dict/spike/`, `data/urls.tsv`),
fetched through crawl-store and cut into tokens with `Intl.Segmenter`, keeping only what the
extension's own `DictEntry.isLookup` treats as a lookup:

```sh
python3 -I spike/scripts/crawl_pages.py urls.tsv pages/          # crawl-store REST, cached
node spike/scripts/sample_tokens.mjs translator/shared pages/ tokens/
```

**The data is untrusted.** Every script runs as `python3 -I` with paths as arguments, and
nothing inside the data directory is executed or imported.

**Kaikki and Tatoeba republish under the same URL**, so a fresh `download.sh` against a new
snapshot fails its hash check by design. To move to a new snapshot: download into a new
directory, run `python3 -I tools/dict/normalize.py <data> <norm> --list-inputs` for the
files the build reads, and regenerate `sources.json` with their sizes and SHA-256 sums.

## Modules

| file | role |
| --- | --- |
| `download.sh` | fetch missing files listed in sources.json, verify every SHA-256 |
| `build.sh` | the whole pipeline (above) |
| `normalize.py` | read each big source once, fan it out into per-pack line-per-record files |
| `pairs.py` | per-language tables, then one process per pack; size cuts and the 2x example rule |
| `entries.py` | the `e` table (records from CEDICT / JMdict / kaikki glosses / translation tables; en->zh CEDICT reverse lookup) |
| `readings.py` | the reading of each record's translation word (design §2, D-487) |
| `formtab.py` | the `f` (form -> head) and `m` (forms shown) tables, size cuts 1–4 |
| `ja_forms.py` | the Japanese conjugation generator (FORMAT.md) |
| `labels.py` | `m` kinds per source language and their labels in the ten targets |
| `examples.py` | the `x` table (Tatoeba + Wiktionary examples, containment rule) |
| `opencc.py` | OpenCC t2s / s2twp from the OpenCC tables, no binary |
| `attribution.py` | `LICENSE.txt` / `ATTRIBUTION.txt` of a pack |
| `common.py` | pack list, acceptance lines, caps, shared helpers |
| `check.py` | the gate: shape, heads, size, reading rate, `x`, D-578; `--report` CSVs |
| `mkfixture.py` | cuts the es-en test fixture (`test/fixtures/dict/`) out of a full build's `norm/` |

Acceptance lines (all in `common.py`): heads ≥ 0.95 × `HEADS_BASE` (in the unit of
`heads_unit`: records for the `HEADS_UNIT` packs; entries — heads plus the words the R8
gloss-text form-of rule moved to `f` — for the `FORM_SOURCES` packs); brotli (`-q 11`) of the `e` part ≤ `br_budget` (1.1 × `BR_BASE`, 2 MB
where §4.1 has no row) and of the pack with `x = {}` ≤ `br_ceiling` (+ 0.5 MB for `f`/`m`,
FORMAT.md "Size cuts"); reading rate ≥ `READING_BASE` − 3 points; with examples ≤ 2 ×
without, else one example per head.

Tests: `test/unit/dict-tools.test.mjs` runs `pairs.py` and `check.py` on the fixture in
`test/fixtures/dict/` (a small real excerpt, provenance in its README); it needs `python3` and
`brotli` on PATH and fails without them.
