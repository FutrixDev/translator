"""Translation readings (design §2, D-487): the pronunciation of the translation word in the
target language, looked up at build time and written into every `e` record.

  en      "/UK/|/US/": UK = kaikki en IPA labelled UK/RP, then ipa-dict en_UK; US = kaikki
          US/GA, then ipa-dict en_US, then CMUdict; an unlabelled kaikki IPA counts as US when
          neither side was found. A missing side is the empty string.
  zh      CC-CEDICT pinyin with tone marks; several readings -> the one whose English gloss
          shares a word with the source entry's English (§2.3), else the first.
  ja      JMdict, the first reading of the entry.
  ko      Revised Romanization, computed per syllable (no data, no sound change rules).
  es/fr/de/pt/ru  kaikki IPA (English edition first, then the language's own edition), then
          ipa-dict; ru strips the stress mark U+0301 before the lookup.

Nothing found -> None; a reading is never guessed. Every lookup also names the dataset that
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
STRESS = '́'
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


def kaikki_ipa_rows(path, own):
    """(word, label, ipa) of every record with IPA; first per (word, label) wins."""
    seen = set()
    for r in C.read_jsonl(path):
        for label, ipa in r.get('ipa') or []:
            key = (r['w'], label)
            if key in seen or not ipa or '\t' in ipa:
                continue
            seen.add(key)
            yield r['w'], label, own_ipa(ipa) if own else ipa


def table_path(work, t):
    return os.path.join(work, f'read-{t}.tsv')


def prepare(norm, work, t):
    """Write <work>/read-<t>.tsv (word, label, ipa, rank) for a kaikki-IPA target language.
    rank 0 = English edition, 1 = own edition; en has only the English edition (en-en)."""
    os.makedirs(work, exist_ok=True)
    files = [(f'kaikki/{t}-en.jsonl', 0, False)] if t != 'en' else []
    files.append((f'kaikki/{t}-{t}.jsonl', 1 if t != 'en' else 0, t != 'en'))
    tmp = table_path(work, t) + '.tmp'
    n = 0
    with open(tmp, 'w', encoding='utf-8') as o:
        for rel, rank, own in files:
            p = os.path.join(norm, rel)
            if not os.path.exists(p):
                continue
            for w, label, ipa in kaikki_ipa_rows(p, own):
                o.write(f'{w}\t{label}\t{ipa}\t{rank}\n')
                n += 1
    os.replace(tmp, table_path(work, t))
    return t, n


def needs_prepare(t):
    return t in ('en', 'es', 'fr', 'de', 'pt', 'ru')


def read_tsv_map(path):
    m = {}
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            for line in f:
                if '\t' in line:
                    w, v = line.rstrip('\n').split('\t', 1)
                    m.setdefault(w, v)
    return m


# ---------------- lookup ----------------
class Readings:
    """lookup(word, src_gloss_en=None) -> (reading | None, source id | None) for one target."""

    def __init__(self, norm, work, t):
        self.t = t
        ipa_dir = os.path.join(norm, 'ipa')
        if t == 'zh':
            self.cedict = {}
            for r in C.read_jsonl(os.path.join(norm, 'cedict.jsonl')):
                self.cedict.setdefault(r['s'], []).append((r['p'], r['g']))
        elif t == 'ja':
            self.jmdict = {}
            for r in C.read_jsonl(os.path.join(norm, 'jmdict.jsonl')):
                if not r['r']:
                    continue
                for w in (r['k'] or r['r']):
                    self.jmdict.setdefault(w, r['r'][0])
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
                self.uk = read_tsv_map(os.path.join(ipa_dir, 'ipadict-en_UK.tsv'))
                self.us = read_tsv_map(os.path.join(ipa_dir, 'ipadict-en_US.tsv'))
                self.cmu = read_tsv_map(os.path.join(ipa_dir, 'cmu-en.tsv'))
            elif t in IPADICT:
                self.ipadict = read_tsv_map(os.path.join(ipa_dir, f'ipadict-{IPADICT[t]}.tsv'))
            else:
                self.ipadict = {}

    def lookup(self, word, src_gloss_en=None):
        if not word:
            return None, None
        return getattr(self, '_' + (self.t if self.t in ('en', 'zh', 'ja', 'ko') else 'ipa'))(
            word, src_gloss_en)

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
        if not rs and len(word) > 2 and word[-1] in '的地':
            rs = self.cedict.get(word[:-1])
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
        if self.t == 'ru':
            word = word.replace(STRESS, '')
        k = self.kaikki.get(word) or self.kaikki.get(word.lower())
        if k:
            return next(iter(k.values())), ('wiktionary',)
        r = self.ipadict.get(word) or self.ipadict.get(word.lower())
        return (r, ('ipadict',)) if r else (None, None)

