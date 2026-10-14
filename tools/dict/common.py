"""Shared constants and helpers for the offline dictionary build (tools/dict/).

Every entry script runs as `python3 -I <script> <paths...>`; -I keeps the data
directories and the current directory off sys.path, so each script puts its own
directory back explicitly before importing this module.
"""
import json
import os
import re

# The ten extension language codes (§1.2). zh-CN and zh-TW share one Chinese source pack.
LANGS = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'pt', 'ru']
ISO = {'zh-CN': 'zh', 'zh-TW': 'zh'}


def iso(lang):
    return ISO.get(lang, lang)


# The 30 packs of design §1.2/§1.3 (34 directed pairs: a zh-CN source pack also serves zh-TW).
PACKS = [
    ('en', 'zh-CN'), ('en', 'zh-TW'), ('en', 'ja'), ('en', 'ko'), ('en', 'es'), ('en', 'fr'),
    ('en', 'de'), ('en', 'pt'), ('en', 'ru'),
    ('zh-CN', 'en'), ('ja', 'en'), ('ko', 'en'), ('es', 'en'), ('fr', 'en'), ('de', 'en'),
    ('pt', 'en'), ('ru', 'en'),
    ('zh-CN', 'ja'), ('zh-CN', 'ko'), ('zh-CN', 'fr'),
    ('ja', 'zh-CN'), ('ja', 'zh-TW'), ('ja', 'ko'),
    ('es', 'fr'), ('fr', 'es'), ('de', 'fr'), ('fr', 'de'), ('de', 'ru'), ('fr', 'ru'), ('pt', 'fr'),
]
SERVES = {('zh-CN', t): [('zh-TW', t)] for t in ('en', 'ja', 'ko', 'fr')}


def pack_name(src, tgt):
    return f'{src}-{tgt}'


def split_pack(name):
    m = re.match(r'^(zh-CN|zh-TW|[a-z]{2})-(zh-CN|zh-TW|[a-z]{2})$', name)
    if not m:
        raise ValueError(f'not a pack name: {name}')
    return m.group(1), m.group(2)


# ---------------- acceptance lines (taskbook "验收线") ----------------
# Headword floor: 95% of design §4.1 (spike data/pack_sizes.csv, "full" json rows); packs
# without a §4.1 row use §1.2 min(headwords, glossed records) (spike data/matrix.csv).
# Deviation (report.md): the spike counted zh heads as raw `w`, Simplified and Traditional
# spellings separately; a pack folds them into one Simplified head (D-578). The zh-source
# bases are therefore the spike's own count folded by OpenCC t2s, reproduced by
# evidence/offline-dict/a/zhheads.py (raw -> folded: zh-CN-en 272627 -> 223012, zh-CN-ja
# 47032 -> 31795, zh-CN-ko 20257 -> 17128, zh-CN-fr 18793 -> 14710; the raw figures equal
# matrix.csv exactly, and the §4.1 zh-CN-en row, 269675, is the same unfolded count).
HEADS_BASE = {
    'en-zh-CN': 113818, 'en-zh-TW': 113818, 'en-ja': 81027, 'en-ko': 33415, 'en-es': 67931,
    'en-fr': 131160, 'en-de': 71484, 'en-pt': 57484, 'en-ru': 94070,
    'zh-CN-en': 223012, 'ja-en': 254559, 'ko-en': 37364, 'es-en': 111259, 'fr-en': 166627,
    'de-en': 126131, 'pt-en': 79131, 'ru-en': 82892,
    'zh-CN-ja': 31795, 'ja-zh-CN': 33141, 'ja-zh-TW': 33141, 'es-fr': 40201, 'fr-es': 57131,
    # §1.2 matrix rows (no §4.1 measurement)
    'zh-CN-ko': 17128, 'zh-CN-fr': 14710, 'ja-ko': 14997, 'de-fr': 139359, 'fr-de': 54185,
    'de-ru': 98181, 'fr-ru': 36750, 'pt-fr': 39241,
}
HEADS_FLOOR = 0.95
# The unit a base counts. §1.2 takes min(headwords, glossed_records); where the minimum is
# the record count (matrix.csv glossed_records: de-fr 139359, pt-fr 39241) the floor
# compares the pack's record count (sum of len(e[h])), not its heads.
HEADS_UNIT = {'de-fr': 'records', 'pt-fr': 'records'}
# Brotli budget: §4.1 brotli bytes + 10%. Packs §4.1 did not measure use its stated bound
# "≤ 2 MB br" (en→zh without ECDICT: "≈ 2 MB").
# Deviation (report.md, needs a ruling): §4.1 measured `e` alone (spike
# scripts/pack_sizes.py:5, pack = {v, src, tgt, lic, e}: no `f`, `m` or record origin), and
# the design sizes `f` separately as "未单测 … brotli ≈ 0.5 MB" (ext-offline-dictionary.md:167).
# So the budget applies to the pack's `e` part (the pack with x, f, m = {}), and the whole
# no-example pack is held to budget + F_ALLOWANCE (br_ceiling).
BR_BASE = {
    'en-ja': 2265243, 'en-ko': 1274632, 'en-es': 2490669, 'en-fr': 3733857, 'en-de': 2799305,
    'en-pt': 2049508, 'en-ru': 3033480, 'zh-CN-en': 5710808, 'ja-en': 6068642, 'ko-en': 1029436,
    'es-en': 2483429, 'fr-en': 4751068, 'de-en': 3835686, 'pt-en': 2063016, 'ru-en': 2847170,
    'zh-CN-ja': 875218, 'ja-zh-CN': 876402, 'ja-zh-TW': 876402, 'es-fr': 1032328,
    'fr-es': 1621367,
}
BR_DEFAULT = 2000000
BR_SLACK = 1.10


F_ALLOWANCE = 500000


def br_budget(name):
    """Brotli bound of the pack's `e` part."""
    return int(BR_BASE.get(name, BR_DEFAULT) * BR_SLACK)


def br_ceiling(name):
    """Brotli bound of the whole pack without examples (`e` + `f` + `m`)."""
    return br_budget(name) + F_ALLOWANCE


def heads_count(name, e):
    """What HEADS_BASE[name] counts in `e`: heads, or records (HEADS_UNIT)."""
    if HEADS_UNIT.get(name) == 'records':
        return sum(len(v) for v in e.values())
    return len(e)


# Reading rate floor: design §2.1 / spike data/readings/readings.csv reading_pct_of_word_forms,
# minus 3 points. Pairs the spike did not measure take the §2.1 value of their target language.
READING_BASE = {
    'en-zh-CN': 70.3, 'en-zh-TW': 70.3, 'en-ja': 71.4, 'en-ko': 95.4, 'en-es': 92.1,
    'en-fr': 89.5, 'en-de': 90.6, 'en-pt': 93.9, 'en-ru': 88.3,
    'zh-CN-en': 97.2, 'ja-en': 95.4, 'ko-en': 97.7, 'es-en': 96.8, 'fr-en': 94.5, 'de-en': 88.5,
    'pt-en': 97.4, 'ru-en': 96.0, 'zh-CN-ja': 62.7, 'ja-zh-CN': 80.9, 'ja-zh-TW': 80.9,
    'ja-ko': 99.2,
    # target-language value of §2.1 (en→<tgt> row)
    'zh-CN-ko': 95.4, 'zh-CN-fr': 89.5, 'es-fr': 89.5, 'fr-es': 92.1, 'de-fr': 89.5,
    'fr-de': 90.6, 'de-ru': 88.3, 'fr-ru': 88.3, 'pt-fr': 89.5,
}
READING_SLACK = 3.0

# Pack record caps (common taskbook v1 contract).
MAX_RECS = 6
MAX_GLOSS = 4
MAX_EX = 2
MAX_FORMS_M = 8
GLOSS_CHARS = 120
EX_SRC_CHARS = 80

TR_ALIASES = {
    'zh': ('zh', 'cmn', 'zh-Hans', 'zh-Hant', 'zh-cn', 'zh-tw', 'zh-hans', 'zh-hant', 'yue',
           'zh-CN', 'zh-TW'),
    'pt': ('pt', 'pt-BR', 'pt-br'),
}


def tr_codes(t):
    return TR_ALIASES.get(t, (t,))


# Tatoeba language codes.
TAT = {'en': 'eng', 'zh': 'cmn', 'ja': 'jpn', 'ko': 'kor', 'es': 'spa', 'fr': 'fra',
       'de': 'deu', 'pt': 'por', 'ru': 'rus'}

# kaikki English-edition slice names.
KAIKKI_EN_NAME = {'en': 'English', 'zh': 'Chinese', 'ja': 'Japanese', 'ko': 'Korean',
                  'es': 'Spanish', 'fr': 'French', 'de': 'German', 'pt': 'Portuguese',
                  'ru': 'Russian'}
LATIN = ('en', 'es', 'fr', 'de', 'pt', 'ru')
CJK_LANGS = ('zh', 'ja', 'ko')


def pair_files(norm, src, tgt):
    """Normalized datasets for one pack, in priority order: [(path, kind)], kind is 'gloss'
    (records carry glosses in the target language) or 'tr' (translation table slice).
    Mirrors spike hitrate.pair_files minus ECDICT (D-566) and the empty cmn slice."""
    s, t = iso(src), iso(tgt)
    out = []

    def add(rel, kind):
        p = os.path.join(norm, rel)
        if os.path.exists(p):
            out.append((p, kind))
    if s == 'zh' and t == 'en':
        add('cedict.jsonl', 'cedict')
    if s == 'ja' and t == 'en':
        add('jmdict.jsonl', 'jmdict')
    if t == 'en':
        add(f'kaikki/{s}-en.jsonl', 'gloss')
    if s == 'en':
        add(f'tr/en-{t}.jsonl', 'tr')
    if t != 'en':
        add(f'kaikki/{s}-{t}.jsonl', 'gloss')
    if s != 'en':
        add(f'tr/{s}-{t}.jsonl', 'tr')
    return out


# ---------------- word form (design §2.2, spike pairdata.word_form) ----------------
PAREN = re.compile(r'\([^()]*\)|\[[^\[\]]*\]|（[^（）]*）|【[^【】]*】|<[^<>]*>')
ARTICLES = {
    'en': ('to ', 'a ', 'an ', 'the ', 'be ', 'become '),
    'de': ('der ', 'die ', 'das ', 'ein ', 'eine ', 'sich '),
    'fr': ('le ', 'la ', 'les ', "l'", 'un ', 'une ', 'se ', "s'"),
    'es': ('el ', 'la ', 'los ', 'las ', 'un ', 'una ', 'se '),
    'pt': ('o ', 'a ', 'os ', 'as ', 'um ', 'uma ', 'se '),
}
CJK = re.compile(r'^[぀-ヿ㐀-鿿가-힯ｦ-ﾟー々]+$')
LATIN_WORD = re.compile(r"[^\W\d_]+(?:['’-][^\W\d_]+)*")
SEGMENT = re.compile(r'[；;,，、/]| or ')
STRESS = chr(0x301)


def fold_word(text, lang):
    """The one stress fold (design §2.1): Russian glosses and heads carry the stress mark
    U+0301, which no reading table, Tatoeba sentence or user selection has. Every lookup key
    (word_form, readings, fold_surface, formtab.fold_key) goes through here; the gloss shown
    in a pack keeps its stress mark. Other languages are untouched (a decomposed e + U+0301
    in French is an accent, not a stress mark)."""
    return text.replace(STRESS, '') if lang == 'ru' else text


def strip_parens(text):
    """Remove bracketed asides, innermost first, until nothing changes: `dog (Canis (lupus)
    familiaris)` -> `dog`."""
    while True:
        out = PAREN.sub('', text)
        if out == text:
            return out
        text = out


def first_segment(gloss):
    """The first segment of a gloss (§2.2): parentheticals removed, cut at the first
    `；;,，、/` or " or ", trailing sentence stops and spaces removed."""
    g = SEGMENT.split(strip_parens(gloss))[0].strip()
    return g.rstrip('.。!?！？').strip()


def word_form(gloss, t):
    """One dictionary word form out of a gloss string in target language t (iso), or ''.
    The first segment only, articles dropped, stress folded; a definition sentence's capital
    (`Manger (pour les humains).` -> `manger`) is lowered except in German, whose nouns are
    capitalised."""
    g = fold_word(first_segment(gloss), t)
    low = g.lower()
    for a in ARTICLES.get(t, ()):
        if low.startswith(a):
            g = g[len(a):].strip()
            break
    if not g:
        return ''
    if t in CJK_LANGS:
        return g if CJK.match(g) and len(g) <= 8 else ''
    if not (LATIN_WORD.fullmatch(g) and len(g) <= 30):
        return ''
    if t != 'de' and g[:1].isupper() and g[1:].islower():
        g = g[0].lower() + g[1:]
    return g


def translation_word(glosses, t):
    """The translation word a record's reading belongs to (design l.264, D-614 R2): the word
    form of the first segment of the first gloss, or '' (then the record has no reading).
    A later gloss is never used. pairs.py looks the reading up for it; check.py uses it as
    the reading-rate denominator and for G1."""
    return word_form(glosses[0], t) if glosses else ''


# ---------------- reading script (L1 N1, L2 N7) ----------------
PINYIN = re.compile(r"[A-Za-züÜāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜńňǹḿ]+(?:[ ·'’-][A-Za-züÜāáǎàēéěè"
                    r"īíǐìōóǒòūúǔùǖǘǚǜńňǹḿ]+)*")
HAN = re.compile(r'[㐀-鿿]+')
KANA = re.compile(r'[぀-ヿー・ ]+')
ROMAN_KO = re.compile(r"[a-z]+(?:[ '-][a-z]+)*")


def reading_problem(reading, t, word):
    """Why a reading cannot belong to `word` in target t (iso), or '' when it can.
    zh: tone-marked Latin, one syllable per Han character when the word is all Han
    (an erhua reading such as `wánr` for 玩儿 fails, and goes null); ja: kana; ko: lowercase
    Revised Romanization. The pipeline sets a reading with a problem to null, check.py
    fails it: one rule for both."""
    if t == 'zh':
        if not PINYIN.fullmatch(reading):
            return 'zh reading is not tone-marked Latin'
        if HAN.fullmatch(word) and len(re.split(r"[ ·'’-]+", reading)) != len(word):
            return 'zh syllables != Han characters'
    elif t == 'ja':
        if not KANA.fullmatch(reading):
            return 'ja reading is not kana'
    elif t == 'ko':
        if not ROMAN_KO.fullmatch(reading):
            return 'ko reading is not lowercase Latin'
    return ''


# ---------------- example containment (common taskbook §x, D-566 item 1) ----------------
# An example belongs to a head only when its source sentence contains the head or one of the
# head's `f` forms: CJK and Korean by substring, every other language by whole word after
# case folding. examples.py picks sentences with it and check.py re-verifies every `x` row.
SUBSTRING_LANGS = CJK_LANGS
SUBSTRING_MAX = 10          # longest head/form looked for inside a CJK sentence
WORD_NGRAM_MAX = 4          # longest multi-word head looked for in a spaced sentence
CHUNK = re.compile(r"\w+(?:['-]\w+)*")
SENTENCE_WORD = re.compile(r"[^\W\d_]+(?:['-][^\W\d_]+)*")
CLAUSE = re.compile(r'[.!?…;:,，。！？；：、"“”«»()\[\]]')


def fold_surface(text, lang):
    """The key a head or form is matched by: case-folded, curly apostrophe straightened, and
    the stress fold (fold_word; Tatoeba writes no stress marks)."""
    return fold_word(text.replace('\u2019', "'").casefold(), lang)


def clauses(sentence, lang):
    """The sentence cut at punctuation (CLAUSE), folded: no key spans a comma or a stop, so
    `Alors, que` gives `alors` and `que` but never `alors que` (L2 N3)."""
    return [c for c in CLAUSE.split(fold_surface(sentence, lang)) if c.strip()]


def sentence_keys(sentence, lang):
    """Every surface a sentence can be said to contain, folded like fold_surface, never across
    punctuation (clauses): substrings (length 1..SUBSTRING_MAX) for zh/ja/ko, else word
    n-grams (1..WORD_NGRAM_MAX) plus the parts of an apostrophe or hyphen compound
    (l'homme -> l, homme). A word glued to digits (13e, 5G, K2, 22h20) is no word."""
    keys = set()
    for c in clauses(sentence, lang):
        if lang in SUBSTRING_LANGS:
            n = len(c)
            keys.update(c[i:j] for i in range(n) for j in range(i + 1, min(n, i + SUBSTRING_MAX) + 1))
            continue
        for toks in word_runs(c):
            for i in range(len(toks)):
                for k in range(1, WORD_NGRAM_MAX + 1):
                    if i + k <= len(toks):
                        keys.add(' '.join(toks[i:i + k]))
                if "'" in toks[i] or '-' in toks[i]:
                    keys.update(p for p in re.split(r"['-]", toks[i]) if p)
    return keys


def word_runs(clause):
    """The clause's words in runs: a chunk with a digit or underscore in it (13e, 5G, K2,
    22h20) is no word and ends the run, so no n-gram reaches across it."""
    runs, cur = [], []
    for chunk in CHUNK.findall(clause):
        if SENTENCE_WORD.fullmatch(chunk):
            cur.append(chunk)
        elif cur:
            runs.append(cur)
            cur = []
    if cur:
        runs.append(cur)
    return runs


def contains(sentence, surfaces, lang):
    """True when `sentence` contains any of `surfaces` (a head and its forms) by the rule above."""
    if lang in SUBSTRING_LANGS:
        cs = clauses(sentence, lang)
        return any(x and fold_surface(x, lang) in c for x in surfaces for c in cs)
    keys = sentence_keys(sentence, lang)
    return any(fold_surface(x, lang) in keys for x in surfaces)


# ---------------- sources and credits (v1 `sources[]` / `credits`) ----------------
# Every dataset a pack can draw on, as the v1 `sources[]` row; a pack lists only the ids it
# used (D-570); attribution.py words its ATTRIBUTION.txt block.
SOURCES = {
    'wiktionary': {'name': 'Wiktionary (kaikki.org)', 'license': 'CC BY-SA 4.0',
                   'url': 'https://kaikki.org/'},
    'cedict': {'name': 'CC-CEDICT', 'license': 'CC BY-SA 4.0',
               'url': 'https://www.mdbg.net/chinese/dictionary?page=cc-cedict'},
    'jmdict': {'name': 'JMdict (EDRDG)', 'license': 'CC BY-SA 4.0',
               'url': 'https://www.edrdg.org/jmdict/j_jmdict.html'},
    'tatoeba': {'name': 'Tatoeba', 'license': 'CC BY 2.0 FR', 'url': 'https://tatoeba.org/'},
    'ipadict': {'name': 'ipa-dict', 'license': 'MIT',
                'url': 'https://github.com/open-dict-data/ipa-dict'},
    'cmudict': {'name': 'CMUdict', 'license': 'BSD-2-Clause',
                'url': 'https://github.com/cmusphinx/cmudict'},
    'opencc': {'name': 'OpenCC', 'license': 'Apache-2.0', 'url': 'https://github.com/BYVoid/OpenCC'},
}
SOURCE_ORDER = tuple(SOURCES)
CREDITS = {
    'jmdict': {'label': 'JMdict \u00a9 EDRDG', 'href': 'https://www.edrdg.org/edrdg/licence.html'},
    'tatoeba': {'label': 'Tatoeba', 'href': 'https://tatoeba.org/'},
}


def sources_rows(used):
    return [dict(id=k, **SOURCES[k]) for k in SOURCE_ORDER if k in used]


def credits_for(used):
    return {k: dict(v) for k, v in CREDITS.items() if k in used}


# ---------------- io ----------------
TSV_BREAKS = ('\t', '\n', '\r')


def tsv_ok(*fields):
    """True when no field holds a tab or a line break: the work tables are one row per line
    (text mode also splits on a bare CR). pt Wiktionary has IPA fields with newlines in them."""
    return not any(b in f for f in fields for b in TSV_BREAKS)


def read_jsonl(path):
    with open(path, encoding='utf-8') as f:
        for line in f:
            if line.strip():
                yield json.loads(line)


def dumps(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':'))


def read_samples(samples_dir, lang):
    """[(token, count)] from tools/dict/samples/tokens.<lang>.tsv (header row first)."""
    out = []
    with open(os.path.join(samples_dir, f'tokens.{lang}.tsv'), encoding='utf-8') as f:
        next(f)
        for line in f:
            p = line.rstrip('\n').split('\t')
            if len(p) >= 2 and p[0]:
                out.append((p[0], int(p[1])))
    return out
