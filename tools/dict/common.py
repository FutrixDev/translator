"""Shared constants and helpers for the offline dictionary build (tools/dict/).

Every entry script runs as `python3 -I <script> <paths...>`; -I keeps the data
directories and the current directory off sys.path, so each script puts its own
directory back explicitly before importing this module.
"""
import json
import os
import re
import subprocess

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
# Sources whose `f` takes kaikki inflection tables and form-of entries (formtab).
FORM_SOURCES = ('en', 'es', 'fr', 'de', 'pt', 'ru', 'ko')
# Their packs count entries (D-614 R8): the spike took a gloss that explains a form
# ("cemeteries: cemeteryの複数形") as content and counted the word as a head; R8 reads such a
# gloss as form-of and moves the word to `f` (design line 167). It still answers a lookup, so
# a word of the pack's gloss slices that the gloss-text rule made form-of (`lt`) and that `f`
# resolves counts beside the heads of `e`. A word kaikki itself marks form_of was `f` in the
# spike too and is not counted, and one `f` cannot take (a multiword plural, a lemma the pack
# lacks) does not count, so a real loss still shows against the floor.
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


def heads_unit(name):
    """What HEADS_BASE[name] is compared with: 'records', 'entries' or 'heads'."""
    if name in HEADS_UNIT:
        return HEADS_UNIT[name]
    return 'entries' if iso(split_pack(name)[0]) in FORM_SOURCES else 'heads'


def form_of_entries(norm, name):
    """The words of the pack's gloss slices that the gloss-text form-of rule moved out of
    `e` (normalize `lt`), folded as `f` keys are (formtab.fold_key)."""
    src, tgt = split_pack(name)
    s = iso(src)
    return {fold_word(r['w'], s) for path, kind in pair_files(norm, src, tgt) if kind == 'gloss'
            for r in read_jsonl(path) if r['lo'] and r.get('lt')}


def heads_count(name, e, f, norm):
    """The pack's count in the unit of heads_unit(name)."""
    unit = heads_unit(name)
    if unit == 'records':
        return sum(len(v) for v in e.values())
    if unit == 'entries':
        moved = form_of_entries(norm, name)
        return len(e) + sum(1 for k in f if k in moved and k not in e)
    return len(e)


# Reading rate floor: design §2.1 / spike data/readings/readings.csv reading_pct_of_word_forms,
# minus 3 points. Pairs the spike did not measure take the §2.1 value of their target language.
# The rate is measured on the sample tokens by runtime-check.cjs, which resolves each token
# with the extension's own DictPack.foldCandidates and reads the floor from reading_floor.
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


def reading_floor(name):
    return round(READING_BASE[name] - READING_SLACK, 1)


# Examples: a pack whose brotli size with examples is over EX_RATIO_MAX x the size without
# them keeps one example per head (pairs.py cuts, check.py holds the result to it).
EX_RATIO_MAX = 2.0

# Pack record caps (common taskbook v1 contract), the runtime's DictPack.LIMITS
# MAX_RECORDS / MAX_GLOSSES / MAX_EXAMPLES / MAX_FORMS. The build cuts at them where an entry
# comes in, so they are restated here; runtime-check.cjs fails when the two disagree.
MAX_RECS = 6
MAX_GLOSS = 4
MAX_EX = 2
MAX_FORMS_M = 8
GLOSS_CHARS = 120
EX_SRC_CHARS = 80

# The extension's parser (shared/dict-pack.js parsePack, D-641) refuses a whole pack over one
# record it cannot read: a head starting with its form-key mark, or a gloss longer than
# DictEntry.MAX_TEXT, counted as JavaScript counts a string's length (UTF-16 code units).
# The build drops both where they come in (entries.Builder); check.py and runtime-check.cjs
# fail a pack that still has one. runtime-check.cjs pins FORM_MARK, GLOSS_MAX (LIMITS.MAX_TEXT,
# DictEntry.MAX_TEXT), LANGS and CREDIT_HOSTS (the one host each of CREDITS may link to, as
# parsePack's credit check takes them) to the runtime and fails on any difference.
FORM_MARK = '~'
GLOSS_MAX = 500
SOURCE_URL = re.compile(r'^https://\S+$')
CREDIT_HOSTS = ('www.edrdg.org', 'tatoeba.org')


def js_len(s):
    """A string's length as JavaScript counts it: UTF-16 code units."""
    return len(s.encode('utf-16-le')) // 2


def gloss_fits(g):
    """A gloss the runtime shows: some non-space text, at most GLOSS_MAX code units."""
    return bool(g.strip()) and js_len(g) <= GLOSS_MAX


SPACE_COMMA = re.compile(r' +,')


def tidy_commas(s):
    """'a , b' -> 'a, b': Wiktionary's list glosses keep the space before a comma."""
    return SPACE_COMMA.sub(',', s)


# Part of speech, as the runtime prints it: an abbreviation in the SOURCE language
# (dict-entry.js: the pos is the head's, written as that language's dictionaries write it).
# Every tag a source can hand the build (kaikki pos, the tr tables, JMdict through
# entries.JM_POS) maps to one class; a class maps to one abbreviation per source language.
# A tag that names no part of speech (a character, a syllable, a root, ...) maps to '' and
# the record is printed without one. A tag not listed here is a build error, not a guess.
POS_CLASS = {
    'noun': 'n', 'name': 'prop',
    'verb': 'v', 'participle': 'v', 'gerund': 'v',
    'adj': 'adj', 'adj_noun': 'adjn', 'adv': 'adv', 'pron': 'pron', 'det': 'det',
    'article': 'art', 'num': 'num', 'counter': 'cl', 'classifier': 'cl',
    'prep': 'prep', 'postp': 'postp', 'conj': 'conj', 'intj': 'intj', 'interj': 'intj',
    'particle': 'part', 'aux': 'aux', 'adnominal': 'adn',
    'prefix': 'pref', 'suffix': 'suf', 'abbrev': 'abbr',
    'phrase': 'phr', 'prep_phrase': 'phr', 'adv_phrase': 'phr', 'proverb': 'phr',
}
POS_NONE = frozenset((
    '', 'unknown', 'character', 'syllable', 'root', 'stem', 'symbol', 'punct',
    'romanization', 'soft-redirect', 'typographic variant', 'combining_form', 'affix',
    'infix', 'interfix', 'circumfix', 'circumpos', 'contraction', 'onomatopoeia',
    'onomatopeia',
))
POS_ABBR = {
    'en': {'n': 'n.', 'prop': 'pr.n.', 'v': 'v.', 'adj': 'adj.', 'adjn': 'adj.',
           'adv': 'adv.', 'pron': 'pron.', 'det': 'det.', 'art': 'art.', 'num': 'num.',
           'cl': 'n.', 'prep': 'prep.', 'postp': 'postp.', 'conj': 'conj.', 'intj': 'int.',
           'part': 'part.', 'aux': 'aux.', 'adn': 'adj.', 'pref': 'pref.', 'suf': 'suf.',
           'abbr': 'abbr.', 'phr': 'phr.'},
    'de': {'n': 'Subst.', 'prop': 'Eigenn.', 'v': 'Verb', 'adj': 'Adj.', 'adjn': 'Adj.',
           'adv': 'Adv.', 'pron': 'Pron.', 'det': 'Det.', 'art': 'Art.', 'num': 'Num.',
           'cl': 'Subst.', 'prep': 'Präp.', 'postp': 'Postp.', 'conj': 'Konj.',
           'intj': 'Interj.', 'part': 'Partikel', 'aux': 'Verb', 'adn': 'Adj.',
           'pref': 'Präf.', 'suf': 'Suff.', 'abbr': 'Abk.', 'phr': 'Redew.'},
    'es': {'n': 's.', 'prop': 'n. pr.', 'v': 'v.', 'adj': 'adj.', 'adjn': 'adj.',
           'adv': 'adv.', 'pron': 'pron.', 'det': 'det.', 'art': 'art.', 'num': 'num.',
           'cl': 's.', 'prep': 'prep.', 'postp': 'posp.', 'conj': 'conj.', 'intj': 'interj.',
           'part': 'part.', 'aux': 'v.', 'adn': 'adj.', 'pref': 'pref.', 'suf': 'suf.',
           'abbr': 'abrev.', 'phr': 'loc.'},
    'fr': {'n': 'n.', 'prop': 'n. pr.', 'v': 'v.', 'adj': 'adj.', 'adjn': 'adj.',
           'adv': 'adv.', 'pron': 'pron.', 'det': 'dét.', 'art': 'art.', 'num': 'num.',
           'cl': 'n.', 'prep': 'prép.', 'postp': 'postp.', 'conj': 'conj.', 'intj': 'interj.',
           'part': 'part.', 'aux': 'v.', 'adn': 'adj.', 'pref': 'préf.', 'suf': 'suff.',
           'abbr': 'abrév.', 'phr': 'loc.'},
    'pt': {'n': 's.', 'prop': 'n. pr.', 'v': 'v.', 'adj': 'adj.', 'adjn': 'adj.',
           'adv': 'adv.', 'pron': 'pron.', 'det': 'det.', 'art': 'art.', 'num': 'num.',
           'cl': 's.', 'prep': 'prep.', 'postp': 'posp.', 'conj': 'conj.', 'intj': 'interj.',
           'part': 'part.', 'aux': 'v.', 'adn': 'adj.', 'pref': 'pref.', 'suf': 'suf.',
           'abbr': 'abrev.', 'phr': 'loc.'},
    'ru': {'n': 'сущ.', 'prop': 'собств.', 'v': 'гл.', 'adj': 'прил.', 'adjn': 'прил.',
           'adv': 'нареч.', 'pron': 'мест.', 'det': 'мест.', 'art': 'арт.', 'num': 'числ.',
           'cl': 'сущ.', 'prep': 'предл.', 'postp': 'послел.', 'conj': 'союз',
           'intj': 'межд.', 'part': 'част.', 'aux': 'гл.', 'adn': 'прил.',
           'pref': 'прист.', 'suf': 'суфф.', 'abbr': 'сокр.', 'phr': 'выраж.'},
    'zh': {'n': '名', 'prop': '专名', 'v': '动', 'adj': '形', 'adjn': '形', 'adv': '副',
           'pron': '代', 'det': '代', 'art': '冠', 'num': '数', 'cl': '量', 'prep': '介',
           'postp': '方位', 'conj': '连', 'intj': '叹', 'part': '助', 'aux': '助动',
           'adn': '形', 'pref': '前缀', 'suf': '后缀', 'abbr': '缩略', 'phr': '短语'},
    'ja': {'n': '名', 'prop': '固', 'v': '動', 'adj': '形', 'adjn': '形動', 'adv': '副',
           'pron': '代', 'det': '連体', 'art': '冠', 'num': '数', 'cl': '助数', 'prep': '前置',
           'postp': '助', 'conj': '接', 'intj': '感', 'part': '助', 'aux': '助動',
           'adn': '連体', 'pref': '接頭', 'suf': '接尾', 'abbr': '略', 'phr': '連語'},
    'ko': {'n': '명', 'prop': '고유', 'v': '동', 'adj': '형', 'adjn': '형', 'adv': '부',
           'pron': '대', 'det': '관', 'art': '관', 'num': '수', 'cl': '의명', 'prep': '전치',
           'postp': '조', 'conj': '접속', 'intj': '감', 'part': '조', 'aux': '보동',
           'adn': '관', 'pref': '접두', 'suf': '접미', 'abbr': '약', 'phr': '구'},
}


def pos_abbr(src_iso, tag):
    """The abbreviation a record from a `src_iso` head is printed with, for a source tag.

    Raises on a tag no table lists, so a new tag in a dump stops the build instead of
    printing an English name the runtime would show as a word of the target language."""
    if tag in POS_NONE:
        return ''
    if tag not in POS_CLASS:
        raise ValueError(f'unknown part-of-speech tag {tag!r} (add it to POS_CLASS or POS_NONE)')
    return POS_ABBR[src_iso][POS_CLASS[tag]]


def pos_values(src_iso):
    """Every pos a pack whose heads are in `src_iso` may carry."""
    return frozenset(POS_ABBR[src_iso].values()) | {''}

# Translation-table language codes per target. Chinese is Mandarin only (D-614 R7): yue, nan,
# hak, wuu, gan, dng and the other Sinitic codes are not aliases.
TR_ALIASES = {
    'zh': ('zh', 'cmn', 'zh-Hans', 'zh-Hant', 'zh-cn', 'zh-tw', 'zh-hans', 'zh-hant',
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
    Mirrors spike hitrate.pair_files minus ECDICT (D-566) and the empty cmn slice. Every
    slice listed here is expected: a missing one raises instead of building a smaller pack
    (D-614 L1 N4)."""
    s, t = iso(src), iso(tgt)
    out = []

    def add(rel, kind):
        p = os.path.join(norm, rel)
        if not os.path.exists(p):
            raise FileNotFoundError(f'{pack_name(src, tgt)} expects the normalized slice {rel}')
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


# ---------------- sense classification (D-614 R7, R8, R9; check.py G2-G4) ----------------
# Chinese translations that are not Mandarin although their code is zh/cmn: kaikki tags and
# language names of the dialect (R7). G2 checks the shown gloss for the Cantonese/Min marker
# characters as well.
ZH_DIALECT_TAGS = frozenset({
    'Cantonese', 'Hokkien', 'Teochew', 'Hakka', 'Wu', 'Gan', 'Xiang', 'Jin', 'Min', 'Min-Nan',
    'Min-Bei', 'Min-Dong', 'Puxian-Min', 'Hainanese', 'Shanghainese', 'Taishanese', 'Dungan',
    'Xiamen', 'Kinmen', 'Zhangzhou', 'Quanzhou', 'Sichuanese', 'Guangdong'})
ZH_DIALECT_LANG = re.compile(r'\b(Cantonese|Hokkien|Teochew|Hakka|Wu|Gan|Xiang|Jin|Min|'
                             r'Sichuanese|Dungan|Taishanese|Shanghainese|Hainanese)\b')
ZH_DIALECT_CHARS = '佢嘅喺睇畀嚟冇哋啲咗'
CYRILLIC = re.compile('[\u0400-\u04ff]')


# The same rule for the other targets: en-de child listed "Chind" (tag Alemannic-German) and
# "kindl" (lang "Bavarian German") beside Kind, all under code de. A dialect tag, or a language
# name that names the target's language but is not it ("Bavarian German", "Louisiana French",
# "Old Russian", "Middle Korean", "Classical Chinese"), marks another variety; the standard
# regional varieties below stay. Regional tags (Austria, Brazil, Quebec, Mexico) stay too: they
# mark a standard variety's regional word, which the pack keeps.
DIALECT_TAGS = ZH_DIALECT_TAGS | frozenset({
    'dialectal', 'Alemannic', 'Alemannic-German', 'Alsatian', 'Alsatian Alemannic German',
    'Bavarian', 'Swiss-German', 'Palatine', 'Rhine-Franconian', 'Silesian East Central German',
    'Louisiana', 'Kansai', 'Kagoshima', 'Kyūshū', 'Chūgoku', 'Gangwon', 'Gyeongsang', 'Jeolla',
    'Yanbian'})
STANDARD_VARIETIES = frozenset({
    'Chinese', 'Chinese Mandarin', 'Mandarin', 'Simplified Chinese', 'Traditional Chinese',
    'Chinese Traditional', 'Austrian German', 'Canadian French', 'French Canadian',
    'Brazilian Portuguese', 'Brazil Portuguese', 'European Portuguese'})


def other_variety(t, tags, lang):
    """Whether a translation item into target t belongs to another variety of t's language
    (R7 for zh: not Mandarin). `lang` is the item's language name, English in the English
    edition; another edition's names never contain the English one and are not judged."""
    lang = lang or ''
    if DIALECT_TAGS & set(tags):
        return True
    if t == 'zh' and ZH_DIALECT_LANG.search(lang):
        return True
    name = KAIKKI_EN_NAME.get(t)
    return bool(name) and name in lang and lang not in STANDARD_VARIETIES and lang != name


# A form-of gloss names its lemma and says which form this is ("plural of dog",
# "Plural von Hund", "dogの複数形"). Such a sense is no record: the lemma goes into the
# record's `lo` and `f` maps the form to it (R8, design line 167). One list per gloss
# language; group `l` is the lemma when the pattern can capture it. check.py G3 reuses it.
_L = r"[\"“«「『]?(?P<l>[^\W\d_][\w'’ -]*?)[\"”»」』]?"
_TAIL = r"\s*(?:\([^()]*\))?\s*[.。]?$"
# Japanese: the form is a grammar term ending in 形 (複数形, 過去形, 異形, 名詞形), a
# participle, a comparative or a spelling; a bare 形 after any noun (夏の大三角形, 円形) is a
# shape, not a form.
_JA_FORM = r'(?:[数數去在称性異別略縮約詞帰格原語他化]形|分詞|比較級|最上級|綴り|変化|表記|異綴|別綴|格)'
# Romance editions: the noun after "de" in "comparativo de igualdad", "tercera persona del
# plural", "pluriel de majesté" is a grammar term, not a lemma.
_NOT_TERM = (r'(?!(?:igualdad|superioridad|inferioridad|plural|singular|pluriel|singulier|'
             r'majesté|modestie|politesse|supériorité|infériorité|égalité|igualdade|'
             r'superioridade|inferioridade)\b)')
_NOT_ART = r'(?!(?:an?|the) )'
FORM_OF = {
    # A bare "form of X" is a noun phrase ("form of government"), so `form` needs a
    # qualifier; a lemma opening with an article is a description ("variant of a Chinese
    # character"), not a word.
    'en': [r'^(?:(?:an? |the )?(?:alternative|obsolete|archaic|dated|nonstandard|rare|eye '
           r'dialect|informal|euphemistic|abbreviated|pronunciation) )*(?:spelling|variant|'
           r'letter-case form)s? of ' + _NOT_ART + _L + _TAIL,
           r'^(?:(?:an? |the )?(?:alternative|obsolete|archaic|dated|nonstandard|rare|eye '
           r'dialect|informal|euphemistic|abbreviated|pronunciation) )+forms? of ' + _NOT_ART +
           _L + _TAIL,
           r'^(?:common )?misspelling of ' + _L + _TAIL,
           r'^(?:(?:simple )?past tense|past participle|present participle|plural|'
           r'(?:third-person )?singular|comparative|superlative|inflection|gerund|'
           r'(?:simple past|past) (?:tense )?and past participle)(?: form)?'
           r'(?: [\w-]+)*? of ' + _L + _TAIL],
    'ja': [r'^(?:[（(][^（）()]*[）)])?' + _L + r'\s*の[^。、]{0,14}?' + _JA_FORM +
           r'(?:[（(][^（）()]*[）)])?' + _TAIL,
           r'^[（(]' + _L + r'\s*の[^（）()]{0,20}?' + _JA_FORM + r'[）)]'],
    'ko': [_L + r'\s*의\s*(?:과거분사|과거형|과거|복수형|복수|비교급|최상급|현재분사|'
           r'3인칭 단수|삼인칭 단수)[^.]{0,8}' + _TAIL],
    'zh': [_L + r'\s*的(?:复数|複數|过去式|過去式|过去分词|過去分詞|现在分词|現在分詞|比较级|'
           r'比較級|最高级|最高級|第三人称单数|第三人稱單數)[^。]{0,8}' + _TAIL,
           # A usage note that only says which form this is: "(用于第三人称单数现在式) 是".
           # It names no lemma; the form table (forms-en) supplies is -> be.
           r'^[（(]用[於于][^（）()]*(?:人[稱称]|[過过]去|複數|复数|分[詞词]|現在式|现在式)'
           r'[^（）()]*[）)](?P<l>)'],
    'de': [r'^(?:Plural|Genitiv|Dativ|Akkusativ|Nominativ|Partizip (?:Perfekt|Präsens|I|II)|'
           r'Präteritum|Komparativ|Superlativ|(?:alternative |veraltete )?Schreibweise|'
           r'Variante|Nebenform|(?:\d\.|erste|zweite|dritte) Person[\w .]*?)'
           r'[\w .,]* (?:von|des|der|zu) (?:dem |der |des )?(?:Substantivs |Verbs |'
           r'Adjektivs |Wortes )?' + _L + _TAIL],
    'es': [r'^(?:Tiempo pasado|Participio (?:presente|pasado)|Gerundio|Grafía (?:obsoleta|'
           r'alternativa|arcaica)|Forma (?:alternativa|obsoleta)|Variante|Comparativo|'
           r'Superlativo|Plural|(?:Primera|Segunda|Tercera) persona)[\w ,()]* (?:de|del)'
           r'(?: verbo| sustantivo| adjetivo)?(?: \(to\))? ' + _NOT_TERM + _L + _TAIL],
    'fr': [r'^(?:Pluriel|(?:Première|Deuxième|Troisième) personne|Participe (?:passé|'
           r'présent)|(?:Ancienne )?(?:Variante|Graphie)|(?:Ancienne )?forme (?:alternative|'
           r'ancienne|archaïque|vieillie|abrégée|courte|longue|conjuguée|fléchie|féminine|'
           r'masculine|plurielle|du (?:verbe|nom|pluriel|féminin))|Comparatif|Superlatif|'
           r'Féminin|Masculin)[\w ,()’\'-]* (?:de |d’|d\'|du )' + _NOT_TERM + _L + _TAIL],
    'pt': [r'^(?:variante ortográfica|grafia (?:alternativa|antiga|obsoleta)|forma '
           r'(?:alternativa|antiga)|gerúndio|particípio|plural|pretérito|(?:primeira|'
           r'segunda|terceira) pessoa)[\w ,()-]* (?:de|do|da) ' + _NOT_TERM + _L + _TAIL],
    # A bare "форма X" / "вариант X" is a noun phrase ("форма листа", "вариант Самсона");
    # only "вариант написания" and the grammar abbreviations name a lemma.
    'ru': [r'^(?:устар\. )?(?:вариант написания|мн\. ч\. от|превосх\. ст\. к(?: прил\.)?|'
           r'сравн\. ст\. к(?: прил\.)?|то же, что) ' + _L + _TAIL],
}
FORM_OF = {lang: [re.compile(p, re.I) for p in ps] for lang, ps in FORM_OF.items()}
# What a gloss may start with that is not part of it: wiki markup ("*hebe的复数形式",
# ":Template:廢 ache的過去分詞") and stray punctuation (", variante de 叫 (jiào)"). The one
# definition for form-of detection here and for entries.Builder.gloss, so a form-of gloss
# cannot hide from normalize behind a prefix the shown gloss loses (D-614 G3).
GLOSS_LEAD = re.compile(r'^(?:[\s,.;:!?、，。；：！？%)\]）】}>|/\\*#=+•]+|Template:\S*)+')


def form_of_lemma(gloss, lang):
    """The lemma a form-of gloss in language `lang` names; '' when the gloss is a form-of
    explanation whose lemma could not be cut out; None when it is not one."""
    gloss = GLOSS_LEAD.sub('', gloss.strip())
    for p in FORM_OF.get(lang, ()):
        m = p.match(gloss)
        if m:
            return (m.group('l') or '').strip()
    return None


# Letter, unit and abbreviation senses: they go after every other sense of the word (R8:
# are 公亩, is ай, a 甲), and a word whose only senses are these yields to its `f` lemma.
MINOR_TAGS = frozenset({'abbreviation', 'initialism', 'acronym', 'letter', 'symbol'})
MINOR_TOPICS = frozenset({'units-of-measure', 'letter', 'letters', 'alphabet'})
# Sense glosses that say "letter / unit / abbreviation" in each edition's language. Each
# needs the explaining context (an ordinal, "of measure", "of"), since the bare word is
# itself an ordinary gloss (en "unity" -> de "Einheit").
MINOR_GLOSS = re.compile(
    r'\b(?:letter of the|letter in the|unit of|abbreviation of|abbreviation for|initialism '
    r'of|acronym of|symbol for|name of the (?:\w+ )*letter)\b|alphabet|alfabeto|abecedario|'
    r'алфавит|アルファベット|字母|알파벳|lettre de l|'
    r'unité de mesure|abréviation de|letra del (?:alfabeto|abecedario)|unidad de medida|'
    r'abreviatura de|Buchstabe des|Maßeinheit|Abkürzung (?:von|für)|буква .{0,30}алфавита|'
    r'единица измерения|сокращение от|letra do alfabeto|unidade de medida|abreviatura de|'
    r'第[0-9０-９一二三四五六七八九十]+(?:字|文字|番目)|の単位|の略|第.{1,3}个字母|的单位|'
    r'的單位|的缩写|的縮寫|[（(][^（）()]*(?:单位|單位|単位)|번째 (?:글자|문자)|의 단위|의 약어|'
    r'도량형|제곱미터', re.I)


def minor_sense(sense):
    """Whether a kaikki sense is a letter, unit or abbreviation sense."""
    if MINOR_TAGS & set(sense.get('tags') or ()):
        return True
    if MINOR_TOPICS & set(sense.get('topics') or ()):
        return True
    gl = sense.get('glosses') or sense.get('raw_glosses') or ['']
    return bool(MINOR_GLOSS.search(gl[0]))


# CC-CEDICT meta entries (R9, check.py G4): surnames, variants, bound forms and
# abbreviations, which go after the content entries of the same head.
CEDICT_META = re.compile(r'^(?:surname |(?:\(old\) |old |archaic |erroneous )?variant of |'
                         r'used in |abbr\. for |see |also written |Japanese variant of |'
                         r'\(archaic\) variant of )')


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
    `；;,，、/` or " or ", trailing sentence stops and spaces removed. A first segment that
    ends in a full stop while the gloss goes on is an abbreviated label (`мед., юр. общая
    практика`), not a word: ''."""
    parts = SEGMENT.split(strip_parens(gloss))
    g = parts[0].strip()
    if g.endswith('.') and any(p.strip() for p in parts[1:]):
        return ''
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
    A later gloss is never used. pairs.py looks the reading up for it; reading_rate and
    runtime-check.cjs use it as the reading-rate denominator, check.py for G1."""
    return word_form(glosses[0], t) if glosses else ''


def first_word_record(recs, t):
    """The record whose translation word the card shows first (§2.1: the first candidate)."""
    for rec in recs:
        if translation_word(rec[1], t):
            return rec
    return None


def reading_rate(e, t):
    """(records with a translation word, of those with a reading): the reading-rate fraction."""
    den = num = 0
    for recs in e.values():
        for rec in recs:
            if translation_word(rec[1], t):
                den += 1
                num += rec[2] is not None
    return den, num


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


def brotli_size(data):
    """The size of `data` (bytes) after `brotli -q 11`: every size rule is in this unit."""
    return len(subprocess.run(['brotli', '-q', '11', '-c'], input=data, capture_output=True,
                              check=True).stdout)


def read_samples(samples_dir, lang):
    """[(token, count)] from <samples_dir>/tokens.<lang>.tsv (header row first).

    samples_dir is build/dict/samples, copied there by build.sh from DICT_SAMPLES_DIR."""
    out = []
    with open(os.path.join(samples_dir, f'tokens.{lang}.tsv'), encoding='utf-8') as f:
        next(f)
        for line in f:
            p = line.rstrip('\n').split('\t')
            if len(p) >= 2 and p[0]:
                out.append((p[0], int(p[1])))
    return out
