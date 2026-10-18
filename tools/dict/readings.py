"""Translation readings (design §2, D-487): the pronunciation of the translation word in the
target language, looked up at build time and written into every `e` record.

  en      "/UK/|/US/": UK = kaikki en IPA labelled UK/RP, then ipa-dict en_UK; US = kaikki
          US/GA, then ipa-dict en_US, then CMUdict; an unlabelled kaikki IPA counts as US when
          neither side was found. A missing side is the empty string.
  zh      CC-CEDICT pinyin with tone marks, keyed on the Simplified head (zh-CN) or the
          Traditional head (zh-TW, whose glosses are converted before the lookup); several
          readings -> the one whose English gloss shares a word with the source entry's
          English (§2.3), else the first.
  ja      JMdict, the first reading of the entry.
  ko      Revised Romanization, computed per syllable (no data, no sound change rules).
  es/fr/de/pt/ru  kaikki IPA (English edition first, then the language's own edition), then
          ipa-dict; the word is folded first (common.fold_word: ru drops the stress mark).

Nothing found -> None; a reading is never guessed, and a reading in the wrong script
(common.reading_problem) is None too. Every lookup also names the dataset that
answered (a `sources[]` id), so a pack lists exactly the datasets it uses.

The big kaikki IPA columns are extracted once per language into <work>/read-<t>.tsv
(`prepare`), so packs that share a target language read a small table instead of the slice.
"""
import os
import re

import common as C

# Revised Romanization tables: initial (19), medial (21), final (28) jamo of a Hangul syllable.
RR_L = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't',
        'p', 'h']
RR_V = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo',
        'we', 'wi', 'yu', 'eu', 'ui', 'i']
RR_T = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'l', 'l', 'l', 'l', 'l', 'm', 'p',
        'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't']
IPADICT = {'en_UK': 'en', 'en_US': 'en', 'es': 'es_ES', 'fr': 'fr_FR', 'de': 'de', 'pt': 'pt_BR'}
WORDS = re.compile(r"[a-z]+")
GLOSS_STOP = {'a', 'an', 'the', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'with', 'by', 'at',
              'be', 'as', 'sb', 'sth', 'one', 'etc', 'used', 'see', 'also', 'variant', 'cl'}


def rr(word):
    """Revised Romanization of an all-Hangul word, '' when any character is not a syllable."""
    out = []
    for ch in word:
        o = ord(ch) - 0xAC00
        if not 0 <= o < 11172:
            return ''
        out.append(RR_L[o // 588] + RR_V[(o % 588) // 28] + RR_T[o % 28])
    return ''.join(out)


def gloss_words(texts):
    out = set()
    for t in texts:
        out.update(w for w in WORDS.findall(t.lower()) if w not in GLOSS_STOP and len(w) > 1)
    return out


# ---------------- table extraction (prepare) ----------------
def own_ipa(ipa):
    """French Wiktionary writes phonemic IPA between backslashes; use the usual slashes."""
    if len(ipa) > 2 and ipa[0] == '\\' and ipa[-1] == '\\':
        return '/' + ipa[1:-1] + '/'
    return ipa


PHONEMIC = re.compile(r'/[^/\[\]|]+/')
PHONETIC = re.compile(r'\[[^/\[\]|]+\]')
IPA_LETTER = re.compile(r'[^\W\d_]')


def one_transcription(ipa, phonetic_ok):
    """`ipa` when it is exactly one transcription: phonemic `/.../`, or phonetic `[...]` where
    `phonetic_ok`; else None. English readings are written "/UK/|/US/", so en takes phonemic
    only. Two transcriptions in one string, an unclosed delimiter, template residue such as
    `^((h aspiré))\\a.ka\\`, diaphonemic `⫽...⫽` and bare letters are all None, and so is
    a pair of delimiters with no letter inside: Wiktionary's elided "[…]" (en-de, fr-de)."""
    ok = PHONEMIC.fullmatch(ipa) or (phonetic_ok and PHONETIC.fullmatch(ipa))
    return ipa if ok and IPA_LETTER.search(ipa) else None


def kaikki_ipa_rows(path, own, phonetic_ok):
    """(word, label, ipa) of every record with one well-formed transcription
    (`one_transcription`); first per (word, label) wins."""
    seen = set()
    for r in C.read_jsonl(path):
        for label, ipa in r.get('ipa') or []:
            key = (r['w'], label)
            if key in seen or not ipa or not C.tsv_ok(r['w'], label, ipa):
                continue
            ipa = one_transcription(own_ipa(ipa) if own else ipa, phonetic_ok)
            if not ipa:
                continue
            seen.add(key)
            yield r['w'], label, ipa


def table_path(work, t):
    return os.path.join(work, f'read-{t}.tsv')


def prepare(norm, work, t):
    """Write <work>/read-<t>.tsv (word, label, ipa, rank) for a kaikki-IPA target language.
    rank 0 = English edition, 1 = own edition; en has only the English edition (en-en). A
    missing slice raises (L1 N4)."""
    os.makedirs(work, exist_ok=True)
    files = [(f'kaikki/{t}-en.jsonl', 0, False)] if t != 'en' else []
    files.append((f'kaikki/{t}-{t}.jsonl', 1 if t != 'en' else 0, t != 'en'))
    tmp = table_path(work, t) + '.tmp'
    n = 0
    with open(tmp, 'w', encoding='utf-8') as o:
        for rel, rank, own in files:
            p = os.path.join(norm, rel)
            for w, label, ipa in kaikki_ipa_rows(p, own, phonetic_ok=t != 'en'):
                o.write(f'{w}\t{label}\t{ipa}\t{rank}\n')
                n += 1
    os.replace(tmp, table_path(work, t))
    return t, n


def needs_prepare(t):
    return t in ('en', 'es', 'fr', 'de', 'pt', 'ru')


def read_ipa_map(path, phonetic_ok):
    """word -> IPA from a normalized ipa-dict / CMUdict table, under the same one-transcription
    rule as kaikki. normalize.py writes every table, so a missing one raises (L1 N4)."""
    m = {}
    with open(path, encoding='utf-8') as f:
        for line in f:
            w, v = line.rstrip('\n').split('\t', 1)
            if one_transcription(v, phonetic_ok):
                m.setdefault(w, v)
    return m


# ---------------- lookup ----------------
class Readings:
    """lookup(word, src_gloss_en=None) -> (reading | None, source id | None) for one target."""

    def __init__(self, norm, work, t, traditional=False):
        self.t = t
        ipa_dir = os.path.join(norm, 'ipa')
        if t == 'zh':
            key = 't' if traditional else 's'
            self.cedict = {}
            for r in C.read_jsonl(os.path.join(norm, 'cedict.jsonl')):
                self.cedict.setdefault(r[key], []).append((r['p'], r['g']))
        elif t == 'ja':
            self.jmdict = {}
            for r in C.read_jsonl(os.path.join(norm, 'jmdict.jsonl')):
                if not r['r']:
                    continue
                for w in r['k']:
                    self.jmdict.setdefault(w, r['r'][0])
                for w in r['r']:
                    self.jmdict.setdefault(w, w)
        elif t != 'ko':
            self.kaikki = {}
            with open(table_path(work, t), encoding='utf-8') as f:
                for line in f:
                    w, label, ipa, rank = line.rstrip('\n').split('\t')
                    d = self.kaikki.setdefault(w, {})
                    k = (label if t == 'en' else '')
                    if k not in d:
                        d[k] = ipa
            if t == 'en':
                self.uk = read_ipa_map(os.path.join(ipa_dir, 'ipadict-en_UK.tsv'), False)
                self.us = read_ipa_map(os.path.join(ipa_dir, 'ipadict-en_US.tsv'), False)
                self.cmu = read_ipa_map(os.path.join(ipa_dir, 'cmu-en.tsv'), False)
            elif t in IPADICT:
                self.ipadict = read_ipa_map(os.path.join(ipa_dir, f'ipadict-{IPADICT[t]}.tsv'), True)
            else:
                self.ipadict = {}

    def lookup(self, word, src_gloss_en=None):
        """(reading, source ids) for a translation word, or (None, None). A reading that
        breaks the target's script rule (common.reading_problem) is no reading: null, not a
        wrong one."""
        if not word:
            return None, None
        r, ids = getattr(self, '_' + (self.t if self.t in ('en', 'zh', 'ja', 'ko') else 'ipa'))(
            word, src_gloss_en)
        if r is None or C.reading_problem(r, self.t, word):
            return None, None
        return r, ids

    def candidates(self, word):
        """Every reading the tables hold for `word` (check.py G1: a record's reading must be
        one of these for its translation word)."""
        if not word:
            return set()
        if self.t == 'zh':
            return {p for p, _ in self.cedict.get(word, ())}
        r, _ = self.lookup(word)
        return {r} if r else set()

    def _en(self, word, _):
        k = self.kaikki.get(word) or self.kaikki.get(word.lower()) or {}
        low = word.lower()
        used = set()
        uk = k.get('UK')
        if uk:
            used.add('wiktionary')
        elif self.uk.get(low):
            uk = self.uk[low]
            used.add('ipadict')
        us = k.get('US')
        if us:
            used.add('wiktionary')
        elif self.us.get(low):
            us = self.us[low]
            used.add('ipadict')
        elif self.cmu.get(low):
            us = self.cmu[low]
            used.add('cmudict')
        if not uk and not us and k.get(''):
            us = k['']
            used.add('wiktionary')
        if not uk and not us:
            return None, None
        return f'{uk or ""}|{us or ""}', tuple(sorted(used))

    def _zh(self, word, src_gloss_en):
        rs = self.cedict.get(word)
        if not rs:
            return None, None
        pick = rs[0][0]
        if len({p for p, _ in rs}) > 1 and src_gloss_en:
            want = gloss_words(src_gloss_en)
            for p, g in rs:
                if want & gloss_words(g):
                    pick = p
                    break
        return pick, ('cedict',)

    def _ja(self, word, _):
        r = self.jmdict.get(word)
        return (r, ('jmdict',)) if r else (None, None)

    def _ko(self, word, _):
        r = rr(word)
        return (r, ()) if r else (None, None)

    def _ipa(self, word, _):
        word = C.fold_word(word, self.t)
        keys = (word, word.lower(), word[:1].upper() + word[1:])
        for w in keys:
            if w in self.kaikki:
                return next(iter(self.kaikki[w].values())), ('wiktionary',)
        for w in keys:
            if w in self.ipadict:
                return self.ipadict[w], ('ipadict',)
        return None, None

