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
- The runtime (`shared/dict-pack.js` `parsePack`, D-641) refuses the whole pack over one
  record it cannot read, so the build drops such input where it comes in
  (`entries.Builder`): a head starting with `~` (the runtime's form-key mark; kaikki has
  entries for the tilde itself), and a translation-table word longer than 500 UTF-16 code
  units (`GLOSS_MAX`, the runtime's `MAX_TEXT`; the only gloss path not cut to 120). A
  record left without a gloss is not written, a head without a record is not a head, and
  `x`, `m` and `f` hold only heads of `e`. `stats/<pack>.json` counts both
  (`dropped_form_heads`, `dropped_long_glosses`). Wiktionary's list glosses `a , b` are
  written `a, b`. `npm run dict:runtime-check` reads every pack with that parser, and fails
  when a cap or the mark in `common.py` differs from the runtime's.
- `pos` is the head's part of speech written as the source language's dictionaries write it
  (below), `''` if the dataset names none.
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

`reading` is the pronunciation of the record's **translation word** (the word form of the
first segment of its first gloss, `common.translation_word`; when that segment is not a single
word form, the record has no reading and no later gloss is tried), in the target language:

| target | notation | source order |
| --- | --- | --- |
| en | `"/UK/\|/US/"`, a missing side empty | kaikki UK/RP → ipa-dict en_UK; kaikki US/GA → ipa-dict en_US → CMUdict |
| zh-CN / zh-TW | pinyin with tone marks | CC-CEDICT; several readings → the one whose English gloss shares a word with the entry (§2.3) |
| ja | kana | JMdict, first reading |
| ko | Revised Romanization | computed per syllable |
| es / fr / de / pt / ru | IPA | kaikki (English edition, then own edition) → ipa-dict |

Nothing found → `null`; a reading is never guessed. A transcription with no letter in it
(`[…]`, Wiktionary's placeholder for a missing one) is not a reading.

### Part of speech (D-677)

The runtime prints `pos` as it is in front of the glosses (`dict-entry.js`), so it is an
abbreviation in the language of the **head** (the pack's source), never an English tag name.
The build maps every tag a dataset hands it (kaikki `pos`, JMdict's coarse class through
`entries.JM_POS`, the translation tables' `pos`) with `common.pos_abbr`: the tag picks a row,
the source language a column. A tag in no row stops the build. CC-CEDICT has no part of
speech, so its records carry `''`. `check.py` fails a pack holding a value outside its column
and `''`. The table is `common.POS_CLASS` × `common.POS_ABBR`; `test/unit/dict-tools.test.mjs`
holds this copy to it.

| tags | en | zh-CN/zh-TW | ja | ko | es | fr | de | pt | ru |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `noun` | n. | 名 | 名 | 명 | s. | n. | Subst. | s. | сущ. |
| `name` | pr.n. | 专名 | 固 | 고유 | n. pr. | n. pr. | Eigenn. | n. pr. | собств. |
| `verb` `participle` `gerund` | v. | 动 | 動 | 동 | v. | v. | Verb | v. | гл. |
| `adj` | adj. | 形 | 形 | 형 | adj. | adj. | Adj. | adj. | прил. |
| `adj_noun` | adj. | 形 | 形動 | 형 | adj. | adj. | Adj. | adj. | прил. |
| `adv` | adv. | 副 | 副 | 부 | adv. | adv. | Adv. | adv. | нареч. |
| `pron` | pron. | 代 | 代 | 대 | pron. | pron. | Pron. | pron. | мест. |
| `det` | det. | 代 | 連体 | 관 | det. | dét. | Det. | det. | мест. |
| `article` | art. | 冠 | 冠 | 관 | art. | art. | Art. | art. | арт. |
| `num` | num. | 数 | 数 | 수 | num. | num. | Num. | num. | числ. |
| `counter` `classifier` | n. | 量 | 助数 | 의명 | s. | n. | Subst. | s. | сущ. |
| `prep` | prep. | 介 | 前置 | 전치 | prep. | prép. | Präp. | prep. | предл. |
| `postp` | postp. | 方位 | 助 | 조 | posp. | postp. | Postp. | posp. | послел. |
| `conj` | conj. | 连 | 接 | 접속 | conj. | conj. | Konj. | conj. | союз |
| `intj` `interj` | int. | 叹 | 感 | 감 | interj. | interj. | Interj. | interj. | межд. |
| `particle` | part. | 助 | 助 | 조 | part. | part. | Partikel | part. | част. |
| `aux` | aux. | 助动 | 助動 | 보동 | v. | v. | Verb | v. | гл. |
| `adnominal` | adj. | 形 | 連体 | 관 | adj. | adj. | Adj. | adj. | прил. |
| `prefix` | pref. | 前缀 | 接頭 | 접두 | pref. | préf. | Präf. | pref. | прист. |
| `suffix` | suf. | 后缀 | 接尾 | 접미 | suf. | suff. | Suff. | suf. | суфф. |
| `abbrev` | abbr. | 缩略 | 略 | 약 | abrev. | abrév. | Abk. | abrev. | сокр. |
| `phrase` `prep_phrase` `adv_phrase` `proverb` | phr. | 短语 | 連語 | 구 | loc. | loc. | Redew. | loc. | выраж. |

`''` (no part of speech): `''`, `affix`, `character`, `circumfix`, `circumpos`, `combining_form`, `contraction`, `infix`, `interfix`, `onomatopeia`, `onomatopoeia`, `punct`, `romanization`, `root`, `soft-redirect`, `stem`, `syllable`, `symbol`, `typographic variant`, `unknown`.

The abbreviations follow each language's general dictionaries: en n./v./adj.; zh 名/动/形
(现代汉语词典); ja 名/動/形/形動/連体 (国語辞典; JMdict `adj-na` is a 形容動詞, 形動); ko 명/동/형
(표준국어대사전; a counter is a 의존 명사, 의명); es/pt s. for sustantivo/substantivo, loc. for a
locución/locução; fr n./v./loc.; de Subst./Verb/Adj./Redew. (Duden); ru сущ./гл./прил./выраж..
Rows a language's dictionaries do not keep apart share its nearest class: an English counter or
classifier is a noun, a determiner in zh or ru is a pronoun, an auxiliary in es/fr/pt/de/ru is a
verb, a participle or gerund is a verb everywhere.

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

The only inflection lookup: the runtime folds a word into its spellings
(`DictPack.foldCandidates`: the token and the token without one trailing sentence stop, each
as written, lower-cased, NFKC and NFKC lower-cased, plus the particle-stripped word for ko),
tries every spelling as a head of `e`, then every spelling as a key of `f`.
`runtime-check.cjs` measures sample coverage through that same function. Every key is in the source script, contains no space, slash or parenthesis, is
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
  (`stripParticle` in `shared/dict-pack.js`); this is the one runtime rule, no other stemming
  exists.

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

`sources[].url` is https. `credits` holds only `jmdict` and `tatoeba`, each only when the pack
uses that dataset, with its `href` on the runtime's credit hosts (`www.edrdg.org`,
`tatoeba.org`; `common.CREDIT_HOSTS`): the card's credit line stays those two (design §6).
Wiktionary is credited by the pack itself: a pack with a `wiktionary` record lists Wiktionary
in `sources` (CC BY-SA 4.0, https url) and names it in `ATTRIBUTION.txt`, and `check.py` fails
it otherwise (D-677).

## Deviation from design §4.1

§4.1 sketched records as `[pos, [gloss…], reading|null]`. v1 adds `origin` as a fourth
field (which dataset the record came from, so attribution is traceable per record) and adds `ver`, `sources`, `credits`, `x` and `m`
at the top level. `f` keeps the §4.1 shape `{form: head}`.
