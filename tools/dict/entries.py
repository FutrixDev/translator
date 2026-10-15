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

Order of a head's records (D-614 R6, R8, R9), then cut to MAX_RECS:
  1. content records, by dataset (pair_files order, the reverse lookup last); translation
     tables of one dataset: first the kaikki entries that translate their widest table into
     this target (`pt`, normalize.kaikki_senses_tr: will's modal table has no Japanese,
     Russian or Portuguese row, so the noun's 意志 / во́ля / vontade goes before the verb
     "to wish"), then by the weight of their entry (its translation items: need -> the
     verb, 227 items, before the noun, 175), then by breadth (how many languages translate
     the table, widest first); everything else in file order;
  2. letter, unit and abbreviation senses (normalize marks them `mn`);
  3. CC-CEDICT meta records: proper names (capitalised pinyin) and entries or glosses that
     are only a surname, a variant, "used in", "abbr. for" (common.CEDICT_META), whatever
     the dataset: a zh head shows any sense it has before a pointer (check.py G4: 絫 shows
     its unit of weight before "variant of 累").
A head whose records are all of kind 2, or all from the reverse lookup, is weak
(`weak_heads`): formtab lets it yield to the lemma it is a form of (are -> be, children ->
child rather than the reverse lookup's 孩子们). So is an English head with no content record
from a translation table: what it has is a target edition's explanation of the form
("Subjonctif passé du verbe auxiliaire will", "filhos: ... (plural de child)"), and did,
would and children open do, will and child instead.

Glosses are cleaned before they are kept (D-614 L2 N5): wiki markup and the VOA attribution
are removed, a gloss that starts with stray punctuation loses it, and a CJK target drops a
gloss written in Latin letters only (an English explanation, not a translation) unless it is
the head itself. A gloss with no letter outside its parentheses and leftover punctuation
beside them ("(뽑는) , .") is dropped; a gloss that is one parenthesized label ("(женское
имя)" for a given name) is kept, as it describes a head that has no translation.
A zh target also drops glosses with Cyrillic or Cantonese/Min characters (R7, check.py G2).
A head masked with `*` is no head (L2 N9).
"""
import os
import re

import common as C
import opencc
from readings import Readings

# formtab's vote rank of the pack's own gloss slice (after the English edition, 0, and the
# source language's own edition, 1).
FORM_ROWS_RANK = 2

# JMdict part-of-speech codes -> the kaikki vocabulary the other packs use (then
# common.pos_abbr, the ja table: adj-na is a 形容動詞, 形動).
JM_POS = (('adj-na', 'adj_noun'), ('adj-', 'adj'), ('adv', 'adv'), ('aux', 'aux'),
          ('conj', 'conj'), ('cop', 'verb'), ('ctr', 'counter'), ('exp', 'phrase'),
          ('int', 'intj'), ('num', 'num'), ('pn', 'pron'), ('pref', 'prefix'),
          ('prt', 'particle'), ('suf', 'suffix'), ('v', 'verb'), ('n', 'noun'), ('unc', ''))

HAN = re.compile(r'[㐀-鿿豈-﫿]')
KANA = re.compile(r'[぀-ヿ]')
HANGUL = re.compile(r'[가-힯ᄀ-ᇿ㄰-㆏]')
CYRILLIC = re.compile(r'[Ѐ-ӿ]')
LATIN = re.compile(r'[A-Za-zÀ-ɏ]')
LETTER = re.compile(r'[^\W\d_]')

CJK_TEXT = re.compile(r'[぀-ヿ㐀-鿿豈-﫿가-힯ᄀ-ᇿ㄰-㆏\U00020000-\U0003ffff]')

# CC-CEDICT reverse lookup (en->zh): which English glosses are clean enough to be a head.
REVERSE_MAX_WORDS = 3
REVERSE_REJECT = re.compile(r'[(/\d;,:]|CL:|variant of|\bsee\b|surname|abbr', re.I)

# Record kinds, the first key of a head's record order (module docstring).
CONTENT, MINOR, META = 0, 1, 2

# CC-CEDICT cross-references inside a gloss: Traditional|Simplified[pin1 yin1] or
# Word[pin1 yin1]. Rendered as the Simplified word alone (FORMAT.md, D-614 R9).
CEDICT_REF = re.compile(r'(?:[^\x00-\x7f\s|\[\]]+\|)?([^\x00-\x7f\s|\[\]]+)\[[^\[\]]*\]')

# A CC-CEDICT gloss naming the written form it is a variant of (after CEDICT_REF).
CEDICT_VARIANT_OF = re.compile(r'^(?:\(old\) |old |archaic |erroneous |Japanese |\(archaic\) )?'
                               r'variant of (\S+)$')

# Gloss cleanup (D-614 L2 N5).
VOA = re.compile(r',?\s*(?:VOA )?Learning English \(public domain\)')
WIKI_LINK = re.compile(r'\[\[(?:[^\[\]|]*\|)?([^\[\]|]*)\]\]')
WIKI_REST = re.compile(r"\{\{[^{}]*\}\}|'{2,}|:?Template:\S*")
ONLY_LABELS = re.compile(r'^(?:[^\W\d_]{1,8}\.\s*)+$')


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
        self.form_rows = []           # (form, head, tags, rank) from the pack's own gloss slice
        self.trad_heads = []          # zh source: (written form, simplified head)
        self.hint = {}                # head -> English glosses for zh polyphone choice
        self.file_idx = 0             # which pair_files dataset is being read (record order)
        self.reverse_idx = None       # the file_idx of the en->zh reverse lookup
        self.tr_idx = set()           # the file_idx of every translation-table dataset
        self.weak_heads = set()       # heads that may yield to their lemma (module docstring)
        self.dropped_form_heads = set()   # heads starting with C.FORM_MARK, never kept (D-641)
        self.dropped_long_glosses = 0     # translation words over C.GLOSS_MAX (D-677)
        opencc_dir = os.path.join(norm, 'opencc')
        self.t2s = opencc.t2s(opencc_dir) if 'zh' in (self.s, self.t) else None
        self.s2twp = opencc.s2twp(opencc_dir) if tgt == 'zh-TW' else None
        if self.t2s:
            self.used.add('opencc')

    # ---------------- records ----------------
    def add(self, head, pos, glosses, origin, reading=None, kind=CONTENT, order=0):
        """Keep one record. Records carry their sort key (kind, dataset, order, arrival) as a
        fifth field until build() sorts, cuts and drops it. Two records with the same glosses
        are one: the one that sorts first stays, so en-de `still` keeps the adverb's "noch"
        rather than the copy an earlier adjective table carried. A head starting with the
        runtime's form-key mark (C.FORM_MARK: kaikki's "~" entry) is no head; its x, m and f
        rows never exist, as those tables only keep heads of `e`. The source tag becomes the
        source language's abbreviation here (C.pos_abbr), once for every dataset."""
        if not head or not glosses or '*' in head:
            return False
        if head.startswith(C.FORM_MARK):
            self.dropped_form_heads.add(head)
            return False
        pos = C.pos_abbr(self.s, pos)
        if self.s == 'zh' and kind == CONTENT and C.CEDICT_META.match(glosses[0]):
            kind = META
        recs = self.e.setdefault(head, [])
        key = (kind, self.file_idx, order)
        for i, r in enumerate(recs):
            if r[1] == glosses:
                if key >= r[4][:3]:
                    return False
                recs[i] = [pos, glosses, reading, origin, key + (r[4][3],)]
                return True
        recs.append([pos, glosses, reading, origin, key + (len(recs),)])
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

    def gloss(self, g, head=None):
        """The cleaned gloss, '' when nothing usable is left (module docstring)."""
        raw = ' '.join(g.split())
        g = WIKI_REST.sub('', WIKI_LINK.sub(r'\1', VOA.sub('', raw)))
        g = C.GLOSS_LEAD.sub('', ' '.join(g.split()))
        # A gloss that was only markup leaves nothing, or a bare label ("мед. [[]]").
        if not g or (g != raw and ONLY_LABELS.match(g)):
            return ''
        bare = C.PAREN.sub('', g)
        if not LETTER.search(bare) and (bare.strip() or not LETTER.search(g)):
            return ''
        if self.t == 'zh':
            g = self.t2s(g)
            if C.CYRILLIC.search(g) or any(ch in g for ch in C.ZH_DIALECT_CHARS):
                return ''
        if self.t in C.CJK_LANGS:
            g = g.rstrip('。')
            if not CJK_TEXT.search(g) and LATIN.search(g) and g != head:
                return ''
        g = C.tidy_commas(g)
        if len(g) > C.GLOSS_CHARS:
            g = g[:C.GLOSS_CHARS - 1] + '…'
        return g

    def glosses(self, items, head=None):
        out = []
        for g in items:
            g = self.gloss(g, head)
            if g and g not in out:
                out.append(g)
            if len(out) == C.MAX_GLOSS:
                break
        return out

    def tr_word(self, word):
        """A translation-table word as a gloss, '' when it is none. Table words are not cut
        like glosses: one over the runtime's limit (C.GLOSS_MAX, a whole paragraph pasted into
        a de-en table) is dropped, and the sense's next word takes its place (D-677)."""
        word = C.tidy_commas(' '.join(word.split()))
        if self.t == 'zh':
            word = word.rsplit(' /', 1)[1].strip() if ' /' in word else self.t2s(word)
        if not word or not fits_script(word, self.t):
            return ''
        if C.js_len(word) > C.GLOSS_MAX:
            self.dropped_long_glosses += 1
            return ''
        return word

    # ---------------- sources ----------------
    def read_cedict(self, path):
        """zh->en (D-614 R9). One record per entry; its content glosses first, meta glosses
        (common.CEDICT_META) after. A proper name (capitalised pinyin) or an all-meta entry is
        a META record, and so is a variant spelling (a Traditional form unlike the head) that
        names its own head as what it is a variant of. Several entries of one head (a
        polyphone: 要 yào / yāo) are content records ordered by how many content glosses
        CC-CEDICT gives them, most first: the common reading is the one with the senses
        (design §2.3 chooses a reading by English overlap, which a zh source has nothing to
        overlap with)."""
        for r in C.read_jsonl(path):
            items = [CEDICT_REF.sub(r'\1', g) for g in r['g'] if not g.startswith('CL:')]
            content = [g for g in items if not C.CEDICT_META.match(g)]
            meta = [g for g in items if C.CEDICT_META.match(g)]
            # A variant spelling filed under the head it is a variant of (秊 -> 年: "grain;
            # harvest (old); variant of 年") describes another written form: it goes after
            # the head's own entries, or 年 opens with "grain".
            own = r['t'] != r['s'] and any(m and m.group(1) == r['s']
                                           for m in map(CEDICT_VARIANT_OF.match, meta))
            kind = META if (not content or own or r['p'][:1].isupper()) else CONTENT
            self.add(r['s'], '', self.glosses(content + meta), 'cedict', kind=kind,
                     order=-len(content))

    def read_jmdict(self, path):
        for r in C.read_jsonl(path):
            head = (r['k'] or r['r'] or [''])[0]
            prev = ''
            for sense in r['s']:
                pos = jm_pos(sense['p']) or prev
                prev = pos
                self.add(head, pos, self.glosses(sense['g'], head), 'jmdict')

    def read_gloss(self, path):
        # The pack's own slice feeds `f` beside the per-language form table (formtab), which
        # already holds <s>-en; ja and zh build `f` from JMdict and the Traditional spellings.
        own = self.t != 'en' and self.s not in ('ja', 'zh')
        for r in C.read_jsonl(path):
            head = self.head_of(r['w'])
            if r['g']:
                self.add(head, r['pos'], self.glosses(r['g'], head), 'wiktionary',
                         kind=MINOR if r.get('mn') else CONTENT)
                for text, tr in r.get('ex') or []:
                    self.kaikki_ex.setdefault(head, []).append((text, tr))
            if own:
                for form, tags in r['fm']:
                    self.form_rows.append((form, head, tuple(tags), FORM_ROWS_RANK))
                for lemma in r['lo']:
                    self.form_rows.append((r['w'], self.head_of(lemma), ('form-of',),
                                           FORM_ROWS_RANK))

    def read_tr(self, path):
        for r in C.read_jsonl(path):
            head = self.head_of(r['w'])
            minor = set(r.get('mn') or ())
            for i, (words, breadth) in enumerate(zip(r['s'], r['b'])):
                out = []
                for w in words:
                    w = self.tr_word(w)
                    if w and w not in out:
                        out.append(w)
                if out:
                    self.add(head, r['pos'], out[:C.MAX_GLOSS], 'wiktionary',
                             kind=MINOR if i in minor else CONTENT,
                             order=(0 if r.get('pt') else 1, -r['ew'], -breadth))

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
            # The head goes through the same gloss cleaning as every other zh gloss, so the
            # dialect and Cyrillic filter (R7, check.py G2) holds here too (confer on -> 畀).
            glosses = self.glosses([hit[0]], g) if hit else []
            if glosses and self.add(g, '', glosses, 'cedict', hit[1]):
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
        for self.file_idx, (path, kind) in enumerate(C.pair_files(self.norm, self.src, self.tgt)):
            if kind == 'tr':
                self.tr_idx.add(self.file_idx)
            readers[kind](path)
        self.file_idx += 1
        self.reverse_idx = self.file_idx
        self.reverse_added = self.cedict_reverse() if (self.s, self.t) == ('en', 'zh') else 0
        self.order_records()
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
                    # A preset reading (the cedict reverse lookup's pinyin) stays only when
                    # the tables give it for this record's translation word (check.py G1).
                    if rec[2] not in rd.candidates(word) or C.reading_problem(rec[2], self.t,
                                                                              word):
                        rec[2] = None
                    continue
                if not word:
                    continue
                hint = [head] if self.s == 'en' else self.hint.get(head)
                reading, ids = rd.lookup(word, hint)
                rec[2] = reading
                self.used.update(ids or ())
        return self.e

    def order_records(self):
        """Sort every head's records by their key, cut to MAX_RECS, drop the key, and note
        the weak heads (module docstring)."""
        for head, recs in self.e.items():
            recs.sort(key=lambda r: r[4])
            if (all(r[4][0] == MINOR for r in recs)
                    or all(r[4][1] == self.reverse_idx for r in recs)
                    or (self.s == 'en' and not any(r[4][0] == CONTENT and r[4][1] in self.tr_idx
                                                   for r in recs))):
                self.weak_heads.add(head)
            self.e[head] = [r[:4] for r in recs[:C.MAX_RECS]]

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
