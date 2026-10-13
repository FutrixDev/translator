"""The `f` (form -> head) and `m` (forms shown on the card) tables of one pack.

Inflection is resolved only through `f`, built once here (common taskbook):

  en/es/fr/de/pt/ru/ko  kaikki `forms[]` and form-of lemmas: the English edition first
           (rank 0), then the language's own edition (rank 1), then the pack's own gloss
           slice (rank 2, Builder.form_rows). `prepare` extracts ranks 0 and 1 once per
           source language into <work>/forms-<s>.tsv.
  ja       JMdict: every spelling of an entry conjugated by ja_forms under the entry's class,
           pointing at the entry's head in `e`.
  zh       D-578: every Traditional spelling whose Simplified head is in `e`; the spellings
           the pack's own slices were folded from first, then CC-CEDICT's.

Rules every key obeys: written in the source script, no space, slash or parenthesis, not
equal to its head and not itself a head of `e` (the runtime finds those directly), and its
value is a head of `e`. The first row for a key wins; a later row naming another head is
counted as a conflict. Russian keys and heads lose the stress mark (Tatoeba and running text
write none); `m` keeps it, since the card shows the form.
"""
import os

import common as C
import ja_forms
import labels
from entries import fits_script

# Tags of a kaikki form row that make it a different word or not a form at all.
DERIVED = frozenset({
    'diminutive', 'augmentative', 'relational', 'adjective', 'collective', 'pejorative',
    'romanization', 'eumhun', 'abbreviation', 'error-unknown-tag', 'error-unrecognized-form',
    'table-tags', 'inflection-template', 'class', 'nonstandard', 'misspelling', 'dated',
    'causative', 'demonym', 'abstract-noun', 'noun-from-verb', 'singulative'})
# Size cuts (taskbook: a pack over its brotli ceiling trims `f` in this order; FORMAT.md):
# Spanish clitic-attached forms and voseo forms, then the rare subjunctive future.
TRIM = frozenset({'combined-form', 'vos-form', 'with-vos'})
TRIM_EXACT = (frozenset({'future', 'subjunctive'}),)
# Size cut 3 (ja): the noun + suru class, generated for every suru noun.
JA_SKIP_CLASSES = frozenset({'vs'})
FORM_SOURCES = ('en', 'es', 'fr', 'de', 'pt', 'ru', 'ko')
BAD_KEY = (' ', '/', '(', ')', '\t')


def fold_key(form, s):
    return form.replace(C.STRESS, '') if s == 'ru' else form


def dropped(tags):
    t = set(tags)
    if t & DERIVED or t & TRIM:
        return True
    return any(x <= t for x in TRIM_EXACT)


def key_ok(key, s):
    return bool(key) and not any(b in key for b in BAD_KEY) and fits_script(key, s)


# ---------------- prepare ----------------
def table_path(work, s):
    return os.path.join(work, f'forms-{s}.tsv')


def needs_prepare(s):
    return s in FORM_SOURCES


def rows_of(path, s, rank):
    """(form, head, tags, rank) of one edition: the inflection rows of each entry and, for an
    entry that is itself a form of another word, a ('form-of',) row. Dropped rows are kept
    here; screen() decides."""
    for r in C.read_jsonl(path):
        head = fold_key(r['w'], s)
        for form, tags in r['fm']:
            if key_ok(fold_key(form, s), s):
                yield form, head, tuple(tags), rank
        for lemma in r['lo']:
            if key_ok(head, s):
                yield r['w'], fold_key(lemma, s), ('form-of',), rank


def screen(rows, s):
    """The rows `f` may use. A form-of row carries no tags, but Wiktionary gives every
    conjugated form its own form-of page, clitic-attached and voseo forms included, so a
    form-of row is dropped when its lemma's inflection table lists that form only under
    dropped tags (otherwise TRIM would come back through the form-of pages)."""
    rows = list(rows)
    kept, gone = set(), set()
    for form, head, tags, *_ in rows:
        if tags != ('form-of',):
            (gone if dropped(tags) else kept).add((fold_key(form, s), head))
    for row in rows:
        form, head, tags = row[0], row[1], row[2]
        pair = (fold_key(form, s), head)
        if tags == ('form-of',):
            if pair in gone and pair not in kept:
                continue
        elif dropped(tags):
            continue
        yield row


def prepare(norm, work, s):
    """Write <work>/forms-<s>.tsv (form, head, tags, rank) from the kaikki editions."""
    os.makedirs(work, exist_ok=True)
    files = [(f'kaikki/{s}-en.jsonl' if s != 'en' else 'kaikki/en-en.jsonl', 0)]
    if s not in ('en', 'ko'):
        files.append((f'kaikki/{s}-{s}.jsonl', 1))
    tmp = table_path(work, s) + '.tmp'
    n = 0
    def every():
        for rel, rank in files:
            p = os.path.join(norm, rel)
            if os.path.exists(p):
                yield from rows_of(p, s, rank)
    with open(tmp, 'w', encoding='utf-8') as o:
        for form, head, tags, rank_ in screen(every(), s):
            if not C.tsv_ok(form, head, *tags):
                continue
            o.write(f'{form}\t{head}\t{",".join(tags)}\t{rank_}\n')
            n += 1
    os.replace(tmp, table_path(work, s))
    return s, n


def read_table(work, s):
    with open(table_path(work, s), encoding='utf-8') as f:
        for line in f:
            form, head, tags, _rank = line.rstrip('\n').split('\t')
            yield form, head, tuple(tags.split(',')) if tags else ()


# ---------------- per pack ----------------
class Forms:
    """Accumulates one pack's `f` and `m` against its finished `e`."""

    def __init__(self, e, s, tgt):
        self.e, self.s, self.tgt = e, s, tgt
        self.f = {}
        self.m = {}
        self.conflicts = 0
        self.kinds = labels.kind_table(s)

    def put(self, key, head):
        if key == head or key in self.e or head not in self.e:
            return
        cur = self.f.get(key)
        if cur is None:
            self.f[key] = head
        elif cur != head:
            self.conflicts += 1

    def show(self, head, rank, kind, form):
        if head in self.e:
            slot = self.m.setdefault(head, {})
            if kind not in slot:
                slot[kind] = (rank, form)

    def kaikki_rows(self, rows):
        for form, head, tags in screen(rows, self.s):
            key = fold_key(form, self.s)
            if not key_ok(key, self.s):
                continue
            self.put(key, head)
            hit = self.kinds.get(tuple(sorted(tags)))
            if hit and form != head:
                self.show(head, hit[0], hit[1], form)

    def jmdict(self, path):
        """Conjugate the entry's head spelling and its first kana reading only (size cut 3:
        rare alternative kanji spellings tripled the table for +0.2 sample hits), and not
        the noun + suru class `vs` (勉強 -> 勉強した): 410k keys for -0.1 type hits."""
        order = {k: i for i, k in enumerate(ja_forms.M_KINDS)}
        for r in C.read_jsonl(path):
            spellings = r['k'] + r['r']
            anchor = next((sp for sp in spellings if sp in self.e), None)
            if anchor is None:
                continue
            cls = ja_forms.classes(p for sense in r['s'] for p in sense['p'])
            if cls is None or cls in JA_SKIP_CLASSES:
                continue
            for sp in dict.fromkeys([anchor] + r['r'][:1]):
                for form, kind in ja_forms.forms(sp, cls):
                    self.put(form, anchor)
                    if sp == anchor and kind in order:
                        self.show(anchor, order[kind], kind, form)

    def traditional(self, pairs):
        for trad, simp in pairs:
            self.put(trad, simp)

    def cedict_traditional(self, path):
        for r in C.read_jsonl(path):
            t = r.get('t')
            if t and t != r['s']:
                self.put(t, r['s'])

    def finish(self):
        m = {}
        for head, slot in self.m.items():
            rows = sorted(slot.items(), key=lambda kv: kv[1][0])[:C.MAX_FORMS_M]
            m[head] = [[labels.label(kind, self.tgt), form] for kind, (_r, form) in rows]
        return self.f, m


def build(norm, work, builder):
    """`f`, `m` and stats for a pack whose `e` the Builder has finished."""
    s = builder.s
    fm = Forms(builder.e, s, builder.tgt)
    if s in FORM_SOURCES:
        fm.kaikki_rows(read_table(work, s))
        fm.kaikki_rows(builder.form_rows)
    elif s == 'ja':
        fm.jmdict(os.path.join(norm, 'jmdict.jsonl'))
        builder.used.add('jmdict')
    elif s == 'zh':
        fm.traditional(builder.trad_heads)
        fm.cedict_traditional(os.path.join(norm, 'cedict.jsonl'))
        builder.used.add('cedict')
    f, m = fm.finish()
    return f, m, {'f_keys': len(f), 'f_conflicts': fm.conflicts, 'm_heads': len(m)}


# ---------------- size cut 4: what the source corpus attests ----------------
# A pack whose no-example brotli is still over its ceiling (common.br_ceiling) after cuts
# 1-3 keeps, rung by rung until it fits:
#   rung 1  `m` only for heads the corpus attests (the head or any of its `f` keys);
#   rung 2  `f` only for keys of attested heads, plus every key the corpus itself attests.
# The corpus is every Tatoeba sentence in the source language. Keys a Tatoeba sentence
# contains always survive, so the Tatoeba part of `x` is unchanged by either rung.
RUNGS = ('m-attested', 'f-attested')


def tatoeba_sentences(norm, s):
    """Every distinct Tatoeba sentence in language s, across all the pair files."""
    seen = set()
    d = os.path.join(norm, 'tatoeba')
    for name in sorted(os.listdir(d)) if os.path.isdir(d) else ():
        a, b = name[:-len('.tsv')].split('-')
        if s not in (a, b):
            continue
        col = 0 if a == s else 2
        with open(os.path.join(d, name), encoding='utf-8') as f:
            for line in f:
                p = line.rstrip('\n').split('\t')
                if len(p) == 4 and p[col] not in seen:
                    seen.add(p[col])
                    yield p[col + 1]


def attested(norm, s, e, f):
    """{head: number of corpus sentence hits of the head and its `f` keys}, and the set of
    `f` keys the corpus contains."""
    want = {C.fold_surface(w, s) for w in e} | {C.fold_surface(k, s) for k in f}
    hits = {}
    for text in tatoeba_sentences(norm, s):
        for key in C.sentence_keys(text, s):
            if key in want:
                hits[key] = hits.get(key, 0) + 1
    by_head, keys = {}, set()
    for h in e:
        n = hits.get(C.fold_surface(h, s), 0)
        if n:
            by_head[h] = by_head.get(h, 0) + n
    for k, h in f.items():
        n = hits.get(C.fold_surface(k, s), 0)
        if n:
            keys.add(k)
            by_head[h] = by_head.get(h, 0) + n
    return by_head, keys


def cut(rung, f, m, by_head, keys):
    """Apply one rung of size cut 4; returns the new (f, m)."""
    if rung == 'm-attested':
        return f, {h: v for h, v in m.items() if h in by_head}
    if rung == 'f-attested':
        return {k: h for k, h in f.items() if h in by_head or k in keys}, m
    raise ValueError(rung)

