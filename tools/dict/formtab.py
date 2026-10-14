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
value is a head of `e`. A key that several rows send to different heads (a conflict) goes
to a strong head before a weak one (Builder.weak_heads), then to the head the most
authoritative source names most often (rows counted per rank: the English edition, then the
language's own edition, then the pack's gloss slice), then to the head named first: `is` is
listed as the plural of the letter i once and as a form of be three times, so it opens be;
rows marked archaic, obsolete, dialectal, rare or alternative count only after every plain
row: `went` has seven plain rows for go and eight archaic ones for wend, so it opens go.

A weak head that is also an inflected form of a strong head yields (D-614 R8): it becomes an
`f` key and leaves `e`, so `are` and `is` open be rather than the unit 公亩 and the letter
name, and `children` opens child rather than the reverse lookup's lone 孩子们. Only a plain
inflection row (not a bare form-of row, not a marked one) makes it yield, so the English
`the` keeps its own entry rather than opening `thee`, which lists it as an obsolete
spelling; such a head stays in `e` and its key leaves `f` (stats: weak_heads_kept). Keys
that pointed at a yielded head point at its lemma, and a form-of row of the pack's gloss slice
whose lemma is not a head but is itself a key follows it one hop (stats: f_via_form_of). Russian keys and heads lose the stress mark (Tatoeba
and running text write none); `m` keeps it, since the card shows the form.
"""
import os

import common as C
import ja_forms
import labels
from entries import FORM_ROWS_RANK, fits_script

RANKS = FORM_ROWS_RANK + 1   # vote ranks (Forms.put)
# Tags of a form row that name a fringe relation: such rows vote after every plain row, and
# never make a weak head yield (module docstring).
MARKED = frozenset({'archaic', 'obsolete', 'dialectal', 'rare', 'alternative'})
FORM_OF = ('form-of',)

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
BAD_KEY = (' ', '/', '(', ')', '\t')


def fold_key(form, s):
    return C.fold_word(form, s)


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
    return s in C.FORM_SOURCES


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
    # normalize.py writes the English-edition slice of every source language and the slim
    # own edition of the Latin-script ones (C.LATIN); a missing one is an error (L1 N4).
    files = [(f'kaikki/{s}-en.jsonl' if s != 'en' else 'kaikki/en-en.jsonl', 0)]
    if s in C.LATIN and s != 'en':
        files.append((f'kaikki/{s}-{s}.jsonl', 1))
    tmp = table_path(work, s) + '.tmp'
    n = 0
    def every():
        for rel, rank in files:
            yield from rows_of(os.path.join(norm, rel), s, rank)
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
            form, head, tags, rank = line.rstrip('\n').split('\t')
            yield form, head, tuple(tags.split(',')) if tags else (), int(rank)


# ---------------- per pack ----------------
class Forms:
    """Accumulates one pack's `f` and `m` against its finished `e`."""

    def __init__(self, e, s, tgt, weak_heads=frozenset(), lt_words=frozenset()):
        self.e, self.s, self.tgt = e, s, tgt
        self.weak = weak_heads
        self.lt_words = lt_words  # words normalize marked `lt` (common.form_of_entries)
        self.votes = {}      # key -> {head: [plain rows per rank, marked rows per rank]}
        self.inflected = set()   # (key, head) named by a plain inflection row
        self.via = {}            # key -> its gloss-slice form-of lemma, not a head of `e`
        self.m = {}
        self.kinds = labels.kind_table(s)

    def put(self, key, head, rank=0, tags=()):
        """One row naming `head` for `key`. JMdict conjugations and Traditional spellings
        come without tags and count as plain inflection rows."""
        if key == head:
            return
        if head not in self.e:
            if rank == FORM_ROWS_RANK and tuple(tags) == FORM_OF and key not in self.e:
                self.via.setdefault(key, head)
            return
        if key in self.e and (key not in self.weak or head in self.weak):
            return
        marked = bool(MARKED.intersection(tags))
        counts = self.votes.setdefault(key, {}).setdefault(head, [0] * (2 * RANKS))
        counts[rank + RANKS * marked] += 1
        if not marked and tuple(tags) != FORM_OF:
            self.inflected.add((key, head))

    def resolve(self):
        """key -> head under the module docstring's order, and the number of conflicts."""
        f, conflicts = {}, 0
        for key, heads in self.votes.items():
            if len(heads) == 1:
                f[key] = next(iter(heads))
                continue
            conflicts += 1
            rank = {h: i for i, h in enumerate(heads)}
            f[key] = min(heads, key=lambda h: (h in self.weak, [-n for n in heads[h]], rank[h]))
        return f, conflicts

    def show(self, head, rank, kind, form):
        if head in self.e:
            slot = self.m.setdefault(head, {})
            if kind not in slot:
                slot[kind] = (rank, form)

    def kaikki_rows(self, rows):
        for form, head, tags, rank in screen(rows, self.s):
            key = fold_key(form, self.s)
            if not key_ok(key, self.s):
                continue
            self.put(key, head, rank, tags)
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
        """`f` and `m`; the yielded heads leave `e` (module docstring)."""
        self.f, self.conflicts = self.resolve()
        self.votes = None
        kept = {k for k, h in self.f.items() if k in self.e and (k, h) not in self.inflected}
        for k in kept:
            del self.f[k]
        self.inflected = None
        self.kept_weak = len(kept)
        yielded = {k for k in self.f if k in self.e}
        for k in yielded:
            del self.e[k]
            self.m.pop(k, None)
        for k, h in list(self.f.items()):
            seen = {k}
            while h in yielded and h not in seen:
                seen.add(h)
                h = self.f[h]
            if h in seen:
                del self.f[k]
            else:
                self.f[k] = h
        self.yielded = len(yielded)
        # One hop through a form-of lemma that is itself a key, for the words of the pack's
        # own gloss slice only (R8 moved them out of `e`; they must not vanish): `steppingstones`
        # is the plural of `steppingstone`, an alternative form of the head `stepping stone`.
        # Kaikki's own form-of rows do not chain: a lemma key may name a homograph's head.
        chained = {k: self.f[h] for k, h in self.via.items()
                   if k not in self.f and k not in self.e and h in self.f}
        self.f.update(chained)
        self.via = None
        self.chained = len(chained)
        # The keys R8 moved out of `e` (yielded heads, gloss-text form-of words, chained ones):
        # size cut 4 keeps them, since they were entries and count toward the heads floor.
        self.moved = frozenset(k for k in self.f
                               if k in yielded or k in chained or k in self.lt_words)
        m = {}
        for head, slot in self.m.items():
            rows = sorted(slot.items(), key=lambda kv: kv[1][0])[:C.MAX_FORMS_M]
            m[head] = [[labels.label(kind, self.tgt), form] for kind, (_r, form) in rows]
        return self.f, m


def build(norm, work, builder):
    """`f`, `m` and stats for a pack whose `e` the Builder has finished."""
    s = builder.s
    # The gloss-text form-of words are the set the heads floor counts (common.heads_count),
    # so size cut 4 keeps exactly the moved words the floor will look for.
    lt_words = C.form_of_entries(norm, C.pack_name(builder.src, builder.tgt))
    fm = Forms(builder.e, s, builder.tgt, builder.weak_heads, lt_words)
    if s in C.FORM_SOURCES:
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
    return f, m, fm.moved, {'f_keys': len(f), 'f_conflicts': fm.conflicts, 'm_heads': len(m),
                            'yielded_heads': fm.yielded, 'weak_heads_kept': fm.kept_weak,
                            'f_via_form_of': fm.chained, 'f_moved': len(fm.moved)}


# ---------------- size cut 4: what the source corpus attests ----------------
# A pack whose no-example brotli is still over its ceiling (common.br_ceiling) after cuts
# 1-3 keeps, rung by rung until it fits:
#   rung 1  `m` only for heads the corpus attests (the head or any of its `f` keys);
#   rung 2  `f` only for keys of attested heads, plus every key the corpus itself attests,
#           plus every key R8 moved out of `e` (Forms.moved: those were entries).
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


def cut(rung, f, m, by_head, keys, moved):
    """Apply one rung of size cut 4; returns the new (f, m)."""
    if rung == 'm-attested':
        return f, {h: v for h, v in m.items() if h in by_head}
    if rung == 'f-attested':
        return {k: h for k, h in f.items() if h in by_head or k in keys or k in moved}, m
    raise ValueError(rung)

