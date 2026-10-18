"""The `x` table of one pack: human-translated example sentences only.

Candidates are the Tatoeba pairs of the pack's two languages and the kaikki example sentences
of the pack's own gloss slice (no Tatoeba ids). A candidate belongs to a head only when its
source sentence contains the head or one of the head's `f` forms (common.contains: substring
for zh/ja/ko, whole word after case folding otherwise) and is at most EX_SRC_CHARS long.
Each head keeps at most `per_head` (MAX_EX) rows, shortest source sentence first, one row per
source sentence and one per translation: Tatoeba holds a Chinese sentence in both scripts,
and the two rows of 你們/你们 translate alike (L2 N6). Chinese translations follow the pack's
target: OpenCC t2s for zh-CN (Tatoeba mixes both scripts), s2twp alone for zh-TW (no t2s step
first: s2twp leaves Traditional text as it is). Source sentences
are kept as written. A sentence that starts with a colon is the tail of a cut-up example
(":It's a ...") and is no candidate (L2 N9).
"""
import os

import common as C


def tatoeba_path(norm, s, t):
    a, b = sorted((s, t))
    return os.path.join(norm, 'tatoeba', f'{a}-{b}.tsv'), s == a


def tatoeba_rows(norm, s, t):
    """(src text, tgt text, src id, tgt id) of every Tatoeba pair of the pack. normalize.py
    writes a file for every pack's pair, so a missing one is an error, not "no examples"."""
    path, src_first = tatoeba_path(norm, s, t)
    out = []
    with open(path, encoding='utf-8') as f:
        for line in f:
            ia, ta, ib, tb = line.rstrip('\n').split('\t')   # normalize.py writes 4 fields
            if src_first:
                out.append((ta, tb, int(ia), int(ib)))
            else:
                out.append((tb, ta, int(ib), int(ia)))
    return out


def usable(text, tr):
    """A candidate pair short enough (EX_SRC_CHARS) and not the tail of a cut-up example."""
    return (len(text) <= C.EX_SRC_CHARS and not text.lstrip().startswith((':', '：'))
            and not tr.lstrip().startswith((':', '：')))


def surface_index(e, f, s):
    """{folded surface: [heads]} for every head of `e` and every `f` key."""
    idx = {}
    for head in e:
        idx.setdefault(C.fold_surface(head, s), []).append(head)
    for form, head in f.items():
        lst = idx.setdefault(C.fold_surface(form, s), [])
        if head not in lst:
            lst.append(head)
    return idx


def build(norm, builder, f, per_head=C.MAX_EX):
    """`x` and stats. builder: the finished entries.Builder (its e, kaikki_ex, converters)."""
    s, t = builder.s, builder.t
    conv = builder.s2twp or (builder.t2s if t == 'zh' else None)
    cands = []
    for text, tr, si, ti in tatoeba_rows(norm, s, t):
        if usable(text, tr):
            cands.append((len(text), si, text, tr, si, ti, None))
    tat = bool(cands)
    for head, rows in builder.kaikki_ex.items():
        if head not in builder.e:
            continue
        for text, tr in rows:
            if usable(text, tr):
                cands.append((len(text), 0, text, tr, None, None, head))
    # Shortest first; Tatoeba before kaikki at equal length (smaller id = older, reviewed).
    cands.sort(key=lambda c: (c[0], c[4] is None, c[1]))
    idx = surface_index(builder.e, f, s)
    forms_of = {}
    for k, h in f.items():
        forms_of.setdefault(h, []).append(k)
    x, seen = {}, {}
    for _n, _o, text, tr, si, ti, own in cands:
        if own is None:
            heads = []
            for k in C.sentence_keys(text, s):
                for h in idx.get(k, ()):
                    if h not in heads:
                        heads.append(h)
        elif C.contains(text, [own] + forms_of.get(own, []), s):
            heads = [own]
        else:
            continue
        for h in heads:
            rows = x.setdefault(h, [])
            if len(rows) >= per_head:
                continue
            shown = conv(tr) if conv else tr
            texts, trs = seen.setdefault(h, (set(), set()))
            if text in texts or shown in trs:
                continue
            texts.add(text)
            trs.add(shown)
            rows.append([text, shown, si, ti])
    x = {h: rows for h, rows in x.items() if rows}
    used = set()
    if any(r[2] is not None for rows in x.values() for r in rows):
        used.add('tatoeba')
    if any(r[2] is None for rows in x.values() for r in rows):
        used.add('wiktionary')
    stats = {'x_heads': len(x), 'x_rows': sum(len(v) for v in x.values()),
             'tatoeba_pairs': tat, 'per_head': per_head}
    return x, used, stats

