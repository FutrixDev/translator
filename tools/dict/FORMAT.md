# Dictionary pack format (v1)

One pack is one JSON object, `out/<pack>/<pack>.json`, published brotli-compressed. The shape
is the cross-batch v1 contract; `check.py` verifies every rule below on every pack.

```
{
  "v": 1,
  "src": "en", "tgt": "zh-CN",                     // extension language codes
  "ver": "2026.10.13",                             // build date, YYYY.MM.DD
  "lic": "CC-BY-SA-4.0",
  "sources": [{"id", "name", "license", "url"}],   // only the datasets this pack used
  "credits": {"tatoeba": {"label", "href"}, ...},  // ids from `sources` that ask for a credit line
  "e": { head: [ [pos, [gloss, ...], reading|null, origin], ... ] },
  "x": { head: [ [srcSentence, tgtSentence, tatoebaSrcId|null, tatoebaTgtId|null], ... ] },
  "m": { head: [ [label, form], ... ] },
  "f": { form: head }
}
```

## `e` — entries

- A head has at most 6 records (`MAX_RECS`), a record at most 4 glosses (`MAX_GLOSS`), each
  at most 120 characters (`GLOSS_CHARS`, cut with `…`). Duplicate gloss lists are dropped.
- `pos` is the dataset's part of speech (kaikki `pos`, JMdict coarse class), `''` if none.
- `origin` is the `sources[]` id the record came from (`wiktionary`, `cedict`, `jmdict`).
- Heads are written in the source script; a zh source is folded to Simplified (the
  Traditional spellings go to `f`, D-578). A zh-TW target pack holds its glosses converted by
  OpenCC s2twp.
- Record order (`entries.Builder.order_records`, D-614 R6/R8/R9): content records first,
  then minor ones (a letter, unit, abbreviation or symbol sense), then meta ones (a zh→en
  CC-CEDICT entry that is only cross-references, "surname …", "variant of …", "abbr. for …",
  or a proper name with capitalised pinyin). Within a kind, dataset priority
  (`common.pair_files`: CC-CEDICT for zh→en, JMdict for ja→en, the kaikki gloss slice, then
  kaikki translation tables), then the dataset's own order. No pair goes through a third
  language.
- Translation tables are read widest first: the table most languages translate is the word's
  main sense, then sense-level tables before the entry-level ones of older dumps, then sense
  order. A table word is the target's standard language only (zh: Mandarin, no Cantonese,
  Min, Wu, Hakka, Gan or Dungan, no Cyrillic; de: no Alemannic or Bavarian), never a sentence
  fragment, and a prefix or suffix only under a prefix or suffix head.
- zh→en: one record per CC-CEDICT entry, its content glosses before its meta glosses. A
  polyphone's entries (要 yào / yāo) are ordered by how many content glosses each has, most
  first. A cross-reference inside a gloss, `Traditional|Simplified[pin1 yin1]` or
  `Word[pin1 yin1]`, is written as the Simplified word alone: `abbr. for 書經|书经[Shu1 jing1]`
  becomes `abbr. for 书经`.
- A weak head (all its records minor, or all reverse lookups, or, from an English source,
  no content translation-table record) that is a plain inflected form of another head leaves
  `e` for `f` (`children` → child, `is` → be).
- en→zh adds the CC-CEDICT reverse lookup: an English gloss that names exactly one
  Simplified head becomes a record of that head under the English word (`origin: cedict`).
  Only a short plain gloss (at most 3 words, a leading "to " dropped) is a lookup key: one
  with a digit, `( / ; , :`, a classifier, a cross-reference, "surname" or "abbr" is a
  note, not a word (`entries.REVERSE_REJECT`).

### Readings (design §2, D-487)

`reading` is the pronunciation of the record's **translation word** (the word form of its
first gloss that has one, `common.translation_word`), in the target language:

| target | notation | source order |
| --- | --- | --- |
| en | `"/UK/\|/US/"`, a missing side empty | kaikki UK/RP → ipa-dict en_UK; kaikki US/GA → ipa-dict en_US → CMUdict |
| zh-CN / zh-TW | pinyin with tone marks | CC-CEDICT; several readings → the one whose English gloss shares a word with the entry (§2.3) |
| ja | kana | JMdict, first reading |
| ko | Revised Romanization | computed per syllable |
| es / fr / de / pt / ru | IPA | kaikki (English edition, then own edition) → ipa-dict |

Nothing found → `null`; a reading is never guessed.

## `x` — examples (D-566 item 1)

Human translations only: Tatoeba pairs of the pack's two languages and kaikki examples that
carry a translation. At most 2 rows per head; the source sentence is at most 80 characters
and contains the head or one of its `f` forms (substring for zh/ja/ko, whole word after case
folding otherwise, `common.contains`); shortest first, Tatoeba before kaikki at equal length,
no repeated sentence. Tatoeba rows keep both sentence ids (look up at
`https://tatoeba.org/sentences/show/<id>`); kaikki rows have `null` ids. A Chinese translation
follows the target script (OpenCC t2s for zh-CN, s2twp for zh-TW).

If the pack with examples is more than twice the brotli size of the pack without them, it is
rebuilt with one example per head (stats `examples_cut_to_one`).

## `m` — forms shown on the card

At most 8 `[label, form]` pairs per head, in the order of `labels.KINDS[src]` (English: plural,
3rd singular, past, past participle, present participle, comparative, superlative; others
per source language). Labels are written in the target language (`labels.LABEL`). Japanese
shows `masu`, `ta`, `te`, `nai` (`ja_forms.M_KINDS`).

## `f` — form → head

The only inflection lookup: the runtime resolves a word as the token, its lower case, then
`f` of each. Every key is in the source script, contains no space, slash or parenthesis, is
not its own head and not a head of `e`, and its value is a head of `e`. The first row for a
key wins. Russian keys and heads drop the stress mark U+0301.

- **en/es/fr/de/pt/ru/ko**: kaikki inflection tables and form-of entries (English edition,
  then the language's own edition, then the pack's own slice).
- **zh (D-578)**: every Traditional spelling whose Simplified head is in `e` — the spellings
  the pack's slices were folded from, then CC-CEDICT's. The runtime carries no
  Simplified/Traditional table. `check.py` requires every key to be a script fold of its
  value (same length, differing only where both characters are Han, so `00後 -> 00后` and
  `X射線 -> X射线` pass and a changed digit or Latin letter does not), and fails a pack where
  more than 5% of the keys do not convert to their value by OpenCC t2s (the rest are
  CC-CEDICT variant pairs).
- **ja**: generated by `ja_forms.py` from JMdict's conjugation class (below).
- **ko**: in addition, the runtime strips one particle from the end of a word
  (`check.KO_PARTICLES`); this is the one runtime rule, no other stemming exists.

### Japanese conjugation table (`ja_forms.py`)

The class is the first of the entry's JMdict pos codes in this order: `v1 v1-s v5k-s v5r-i
v5u-s v5aru v5u v5k v5g v5s v5t v5n v5b v5m v5r vs-c vk vs-s vs-i vz adj-ix adj-i vs`.
Forms are generated from the dictionary form alone.

| class | kinds generated |
| --- | --- |
| godan `v5u v5k v5g v5s v5t v5n v5b v5m v5r v5k-s v5u-s v5aru vs-c` | masu, mashita, masen, masendeshita, ta, te, tai, stem, nai, nakatta, passive, potential, ba, volitional, imperative |
| `v5r-i` (ある) | as godan, without nai/nakatta, passive, potential |
| ichidan `v1 v1-s` | as godan (`v1-s` imperative in れ) |
| `vk` 来る / くる (and compounds) | as godan, on 来/き/こ/く |
| `vs-s` 愛する, `vs-i` 〜する | as godan on し/さ/せ; `vs-i` potential できる |
| `vz` 〜ずる | as godan on じ, without potential |
| `adj-i`, `adj-ix` (いい/良い/善い → よ) | ku, katta, kunai, kute, kereba, kunakatta |

Special stems: godan te/ta by row (う/つ/る → っ, く → い, ぐ → いで, ぬ/ぶ/む → んで,
す → し); `v5k-s` 行く → 行った; `v5u-s` 問う → 問うた; `v5aru` stem and imperative in い.

Each JMdict entry is conjugated on its anchor spelling (the first spelling that is a head of
`e`) and its first kana reading only; every form points at the anchor.

## Size cuts

Two bounds, both brotli `-q 11` (`common.py`). Design §4.1 measured `e` alone, and sized `f`
separately at about 0.5 MB, so:

- the `e` part (the pack with `x`, `f`, `m` empty) ≤ `br_budget` = 1.1 × §4.1, or 1.1 × 2 MB
  where §4.1 has no row;
- the pack with `x = {}` ≤ `br_ceiling` = `br_budget` + 0.5 MB (`F_ALLOWANCE`).

A pack over its ceiling is cut in this order, and `stats/<pack>.json` lists what it took:

1. Spanish clitic-attached and voseo forms (`formtab.TRIM`) — always.
2. The rare future subjunctive (`formtab.TRIM_EXACT`) — always.
3. Japanese: the noun + suru class `vs` is not conjugated (410k keys for −0.1 sample type
   hits), and only the anchor spelling and first kana are conjugated — always.
4. Only while still over the ceiling, rung by rung (`formtab.RUNGS`): `m-attested` keeps `m`
   for heads the Tatoeba corpus of the source language attests (head or any `f` key);
   `f-attested` keeps `f` keys of attested heads plus every key the corpus itself contains.
   Either rung leaves every key a Tatoeba sentence contains, so `x` is unchanged by them.

## Pack directory

`out/<pack>/` holds `<pack>.json`, `LICENSE.txt` (CC BY-SA 4.0 legal code, byte-equal to
`tools/dict/cc-by-sa-4.0.txt`) and `ATTRIBUTION.txt` (each dataset used with URL, licence,
extraction date 2026-10-13 and role; the selected/filtered/reordered/merged statement; the
Tatoeba id lookup; the EDRDG notice; the MIT/BSD/Apache notices from `notices/`) (D-570).

## Deviation from design §4.1

§4.1 sketched records as `[pos, [gloss…], reading|null]`. v1 adds `origin` as a fourth
field (which dataset the record came from, so attribution is traceable per record) and adds `ver`, `sources`, `credits`, `x` and `m`
at the top level. `f` keeps the §4.1 shape `{form: head}`.
