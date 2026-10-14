"""The `e` table of one pack (design §1, §2; common taskbook v1 contract).

Records come from the pack's datasets in common.pair_files order, up to MAX_RECS per head:

  cedict   zh->en  head = simplified; one record of its English glosses (CL: notes dropped)
  jmdict   ja->en  head = first kanji spelling, else first reading; one record per sense,
                   coarse part of speech (an empty sense inherits the previous one)
  gloss    kaikki  head = word (zh source: folded to simplified); one record of its glosses
  tr       kaikki translation tables: one record per sense, its words in the target script

Chinese content is built in Simplified; a zh-TW pack converts every gloss with OpenCC s2twp
before the readings, drops the duplicates the conversion creates (inside a record and between
records), and looks readings up on the converted word in CC-CEDICT's Traditional column
(s2twp also changes words: 软件 -> 軟體, whose reading is not 软件's). Every record's reading
belongs to its translation word (common.translation_word).

en->zh adds the CC-CEDICT reverse lookup: an English gloss that names exactly one Chinese
head becomes a record of that head under the English word (origin cedict, its own pinyin).
"""
import os
import re

import common as C
import opencc
from readings import Readings

# JMdict part-of-speech codes -> the kaikki vocabulary the other packs use.
JM_POS = (('adj-', 'adj'), ('adv', 'adv'), ('aux', 'aux'), ('conj', 'conj'), ('cop', 'verb'),
          ('ctr', 'counter'), ('exp', 'phrase'), ('int', 'intj'), ('num', 'num'),
          ('pn', 'pron'), ('pref', 'prefix'), ('prt', 'particle'), ('suf', 'suffix'),
          ('v', 'verb'), ('n', 'noun'), ('unc', ''))

HAN = re.compile(r'[㐀-鿿豈-﫿]')
KANA = re.compile(r'[぀-ヿ]')
HANGUL = re.compile(r'[가-힯ᄀ-ᇿ㄰-㆏]')
CYRILLIC = re.compile(r'[Ѐ-ӿ]')
LATIN = re.compile(r'[A-Za-zÀ-ɏ]')

# CC-CEDICT reverse lookup (en->zh): which English glosses are clean enough to be a head.
REVERSE_MAX_WORDS = 3
REVERSE_REJECT = re.compile(r'[(/\d;,:]|CL:|variant of|\bsee\b|surname|abbr', re.I)


def jm_pos(codes):
    for code in codes:
        for prefix, pos in JM_POS:
            if code == prefix or code.startswith(prefix):
                return pos
    return ''


def fits_script(word, t):
    """Whether a translation-table word is written in target language t's script (the tables
    carry stray entries such as a Cyrillic word under Chinese)."""
    other = {'zh': (KANA, HANGUL, CYRILLIC), 'ja': (HANGUL, CYRILLIC),
             'ko': (KANA, CYRILLIC), 'ru': (HAN, KANA, HANGUL)}.get(t, (CYRILLIC, HAN, KANA, HANGUL))
    need = {'zh': (HAN,), 'ja': (HAN, KANA), 'ko': (HANGUL,), 'ru': (CYRILLIC,)}.get(t, (LATIN,))
    return any(p.search(word) for p in need) and not any(p.search(word) for p in other)


class Builder:
    """Collects one pack's records. build() returns the finished `e` plus what the other
    tables need: the kaikki examples per head, the pack's own form rows, the Traditional
    spellings of zh heads, and the dataset ids used."""

    def __init__(self, norm, work, src, tgt):
        self.norm, self.work = norm, work
        self.src, self.tgt = src, tgt
        self.s, self.t = C.iso(src), C.iso(tgt)
        self.e = {}
        self.used = set()
        self.kaikki_ex = {}           # head -> [(text, translation)]
        self.form_rows = []           # (form, head, tags) from the pack's own gloss slice
        self.trad_heads = []          # zh source: (written form, simplified head)
        self.hint = {}                # head -> English glosses for zh polyphone choice
        opencc_dir = os.path.join(norm, 'opencc')
        self.t2s = opencc.t2s(opencc_dir) if 'zh' in (self.s, self.t) else None
        self.s2twp = opencc.s2twp(opencc_dir) if tgt == 'zh-TW' else None
        if self.t2s:
            self.used.add('opencc')

    # ---------------- records ----------------
    def add(self, head, pos, glosses, origin, reading=None):
        if not head or not glosses:
            return False
        recs = self.e.setdefault(head, [])
        if len(recs) >= C.MAX_RECS or any(r[1] == glosses for r in recs):
            return False
        recs.append([pos, glosses, reading, origin])
        return True

    def head_of(self, w):
        """The head a source word is filed under: zh folds to Simplified and remembers the
        written form for the `f` table."""
        if self.s != 'zh':
            return w
        h = self.t2s(w)
        if h != w:
            self.trad_heads.append((w, h))
        return h

    def gloss(self, g):
        g = ' '.join(g.split())
        if self.t == 'zh':
            g = self.t2s(g)
        if self.t in C.CJK_LANGS:
            g = g.rstrip('。')
        if len(g) > C.GLOSS_CHARS:
            g = g[:C.GLOSS_CHARS - 1] + '…'
        return g

    def glosses(self, items):
        out = []
        for g in items:
            g = self.gloss(g)
            if g and g not in out:
                out.append(g)
            if len(out) == C.MAX_GLOSS:
                break
        return out

    def tr_word(self, word):
        word = ' '.join(word.split())
        if self.t == 'zh':
            word = word.rsplit(' /', 1)[1].strip() if ' /' in word else self.t2s(word)
        return word if word and fits_script(word, self.t) else ''

    # ---------------- sources ----------------
    def read_cedict(self, path):
        for r in C.read_jsonl(path):
            gl = self.glosses(g for g in r['g'] if not g.startswith('CL:'))
            self.add(r['s'], '', gl, 'cedict')

    def read_jmdict(self, path):
        for r in C.read_jsonl(path):
            head = (r['k'] or r['r'] or [''])[0]
            prev = ''
            for sense in r['s']:
                pos = jm_pos(sense['p']) or prev
                prev = pos
                self.add(head, pos, self.glosses(sense['g']), 'jmdict')

    def read_gloss(self, path):
        # The pack's own slice feeds `f` beside the per-language form table (formtab), which
        # already holds <s>-en; ja and zh build `f` from JMdict and the Traditional spellings.
        own = self.t != 'en' and self.s not in ('ja', 'zh')
        for r in C.read_jsonl(path):
            head = self.head_of(r['w'])
            if r['g']:
                self.add(head, r['pos'], self.glosses(r['g']), 'wiktionary')
                for text, tr in r.get('ex') or []:
                    self.kaikki_ex.setdefault(head, []).append((text, tr))
            if own:
                for form, tags in r['fm']:
                    self.form_rows.append((form, head, tuple(tags)))
                for lemma in r['lo']:
                    self.form_rows.append((r['w'], self.head_of(lemma), ('form-of',)))

    def read_tr(self, path):
        for r in C.read_jsonl(path):
            head = self.head_of(r['w'])
            for words in r['s']:
                out = []
                for w in words:
                    w = self.tr_word(w)
                    if w and w not in out:
                        out.append(w)
                if out:
                    self.add(head, r['pos'], out[:C.MAX_GLOSS], 'wiktionary')

    def cedict_reverse(self):
        """en->zh: English glosses of CC-CEDICT that name exactly one Simplified head."""
        by_gloss = {}
        for r in C.read_jsonl(os.path.join(self.norm, 'cedict.jsonl')):
            for g in r['g']:
                g = g.strip()
                if g.startswith('to '):
                    g = g[3:].strip()
                if not g or REVERSE_REJECT.search(g) or len(g.split()) > REVERSE_MAX_WORDS:
                    continue
                cur = by_gloss.get(g)
                if cur is None:
                    by_gloss[g] = (r['s'], r['p'])
                elif cur and cur[0] != r['s']:
                    by_gloss[g] = False
        added = 0
        for g, hit in by_gloss.items():
            if hit and self.add(g, '', [hit[0]], 'cedict', hit[1]):
                added += 1
        return added

    def jm_hints(self):
        """ja->zh: the JMdict English glosses of each head choose among Chinese readings."""
        for r in C.read_jsonl(os.path.join(self.norm, 'jmdict.jsonl')):
            g = [x for s in r['s'] for x in s['g']]
            for sp in r['k'] + r['r']:
                self.hint.setdefault(sp, g)

    # ---------------- build ----------------
    def build(self):
        readers = {'cedict': self.read_cedict, 'jmdict': self.read_jmdict,
                   'gloss': self.read_gloss, 'tr': self.read_tr}
        for path, kind in C.pair_files(self.norm, self.src, self.tgt):
            readers[kind](path)
        self.reverse_added = self.cedict_reverse() if (self.s, self.t) == ('en', 'zh') else 0
        if (self.s, self.t) == ('ja', 'zh'):
            self.jm_hints()
        if self.s2twp:
            self.to_traditional()
        rd = Readings(self.norm, self.work, self.t, traditional=bool(self.s2twp))
        for head, recs in self.e.items():
            for rec in recs:
                self.used.add(rec[3])
                word = C.translation_word(rec[1], self.t)
                if rec[2] is not None:
                    if C.reading_problem(rec[2], self.t, word):
                        rec[2] = None
                    continue
                if not word:
                    continue
                hint = [head] if self.s == 'en' else self.hint.get(head)
                reading, ids = rd.lookup(word, hint)
                rec[2] = reading
                self.used.update(ids or ())
        return self.e

    def to_traditional(self):
        """zh-TW: convert every gloss, then drop the duplicates the conversion made. A preset
        reading (the reverse lookup's pinyin) belonged to the Simplified word and is looked up
        again on the converted one."""
        for head, recs in self.e.items():
            out = []
            for pos, glosses, _reading, origin in recs:
                glosses = list(dict.fromkeys(self.s2twp(g) for g in glosses))
                if all(r[1] != glosses for r in out):
                    out.append([pos, glosses, None, origin])
            self.e[head] = out
