#!/usr/bin/env python3 -I
"""Check every built dictionary pack against the v1 contract and the acceptance lines.

Usage: python3 -I tools/dict/check.py <out-dir> [--samples DIR] [--opencc DIR]
           [--packs a-b,c-d] [--ver YYYY.MM.DD] [--report DIR] [--jobs N]

One line per pack (`OK <pack> ...` or `FAIL <pack>: <reasons>`), then a summary line; the exit
status is non-zero when any pack fails or is missing. Checked per pack:

  files     <pack>.json, LICENSE.txt (byte-equal to tools/dict/cc-by-sa-4.0.txt) and
            ATTRIBUTION.txt (equal to what attribution.text writes for the sources the pack
            lists, so it names exactly the datasets used, the date, the Tatoeba id URL and the
            MIT / BSD / Apache notices)
  shape     the v1 keys and types, `ver`, record and table caps, every `x`/`m` head and every
            `f` value a head of `e`, no `f` key that is itself a head, en readings "UK|US"
  heads     len(e) >= 0.95 x common.HEADS_BASE
  size      brotli -q 11 of the pack with x = {} <= common.br_budget (recomputed here from the
            shipped pack, not read from the build's stats); with examples <= 2x that, unless
            the pack was already cut to one example per head
  reading   design §2.1 metric on the sample tokens: of the sample types that resolve to a
            head whose records give a translation word (common.translation_word of the first
            record that has one), the share whose record carries a reading; >= READING_BASE - 3
  x         every row: source sentence <= 80 characters and containing the head or one of its
            `f` forms (common.contains), no repeated sentence, shortest first, ids int or null
  D-578     a zh-source pack: every `f` key is a Traditional spelling whose OpenCC t2s
            conversion is its value, or a CC-CEDICT pair (the value is a head written in Han);
            the share whose t2s differs is reported and must stay under D578_MAX_OTHER

Sample tokens are resolved the way the runtime resolves a looked-up word: the token, its
lower case, then `f` of each, and for ko the KO_PARTICLES stripped (the one runtime rule).
--report writes packs.csv and coverage.csv (sample hit rates, reading rate, sample example
rate and, for en->zh, the hit rate without the CC-CEDICT reverse-lookup heads).
"""
import argparse
import csv
import json
import os
import re
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import attribution  # noqa: E402
import common as C  # noqa: E402
import opencc  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
LICENSE = os.path.join(HERE, 'cc-by-sa-4.0.txt')
KEYS = ('v', 'src', 'tgt', 'ver', 'lic', 'sources', 'credits', 'e', 'x', 'm', 'f')
VER = re.compile(r'^\d{4}\.\d{2}\.\d{2}$')
ORIGINS = ('wiktionary', 'cedict', 'jmdict')
EX_RATIO_MAX = 2.0
D578_MAX_OTHER = 0.05
# Korean particles stripped from a looked-up word (spike hitrate.KO_PARTICLES, verbatim).
KO_PARTICLES = ['에서는', '으로는', '에게서', '으로써', '으로서', '에서도', '한테서', '까지는',
                '부터는', '이라고', '으로', '에서', '에게', '한테', '까지', '부터', '처럼', '보다',
                '마다', '조차', '라고', '께서', '은', '는', '이', '가', '을', '를', '의', '에',
                '로', '와', '과', '도', '만', '들', '요']
PACKS_CSV = ('pair', 'heads', 'f_keys', 'reading_rate', 'examples_head_rate', 'raw',
             'br_no_examples', 'br_with_examples')
COVERAGE_CSV = ('pair', 'sample', 'sample_types', 'sample_tokens', 'hit_types_pct',
                'hit_tokens_pct', 'reading_word_forms', 'reading_found', 'reading_rate',
                'reading_floor', 'record_reading_rate', 'example_hit_types_pct',
                'example_hit_tokens_pct', 'cedict_reverse_heads', 'hit_types_pct_without_reverse',
                'hit_tokens_pct_without_reverse', 'f_t2s_other')


def brotli_bytes(data):
    return len(subprocess.run(['brotli', '-q', '11', '-c'], input=data, capture_output=True,
                              check=True).stdout)


# ---------------- the runtime resolver ----------------
def candidates(tok, s):
    out = [tok]
    low = tok.lower()
    if low != tok:
        out.append(low)
    if s == 'ko':
        out += [tok[:-len(p)] for p in KO_PARTICLES if tok.endswith(p) and len(tok) > len(p)]
    return out


def resolve(tok, s, e, f):
    for c in candidates(tok, s):
        if c in e:
            return c
        h = f.get(c)
        if h is not None:
            return h
    return None


def first_word_record(recs, t):
    """The record whose translation word the card shows first (§2.1: the first candidate)."""
    for rec in recs:
        if C.translation_word(rec[1], t):
            return rec
    return None


def sample_metrics(pack, s, t, sample, skip=frozenset()):
    e, f, x = pack['e'], pack['f'], pack['x']
    if skip:
        e = {h: v for h, v in e.items() if h not in skip}
        f = {k: h for k, h in f.items() if h not in skip}
    hit_t = hit_n = wf = rd = ex_t = ex_n = 0
    for tok, n in sample:
        h = resolve(tok, s, e, f)
        if h is None:
            continue
        hit_t += 1
        hit_n += n
        if h in x:
            ex_t += 1
            ex_n += n
        rec = first_word_record(e[h], t)
        if rec is not None:
            wf += 1
            rd += rec[2] is not None
    types, tokens = len(sample), sum(n for _, n in sample)
    pct = (lambda a, b: round(100 * a / b, 1) if b else 0.0)
    return {'sample_types': types, 'sample_tokens': tokens,
            'hit_types_pct': pct(hit_t, types), 'hit_tokens_pct': pct(hit_n, tokens),
            'reading_word_forms': wf, 'reading_found': rd, 'reading_rate': pct(rd, wf),
            'example_hit_types_pct': pct(ex_t, hit_t), 'example_hit_tokens_pct': pct(ex_n, hit_n)}


# ---------------- per pack ----------------
def check_shape(pack, src, tgt, ver, err):
    if tuple(pack) != KEYS:
        err.append(f'keys {list(pack)}')
        return
    if pack['v'] != 1 or pack['src'] != src or pack['tgt'] != tgt:
        err.append('v/src/tgt')
    if not isinstance(pack['ver'], str) or not VER.match(pack['ver']) or (ver and pack['ver'] != ver):
        err.append(f"ver {pack['ver']!r}")
    if pack['lic'] != 'CC-BY-SA-4.0':
        err.append('lic')
    used = {r.get('id') for r in pack['sources']} if isinstance(pack['sources'], list) else set()
    if not used <= set(C.SOURCES) or pack['sources'] != C.sources_rows(used):
        err.append('sources rows')
    if pack['credits'] != C.credits_for(used):
        err.append('credits')
    t = C.iso(tgt)
    e, x, m, f = pack['e'], pack['x'], pack['m'], pack['f']
    bad = 0
    for h, recs in e.items():
        ok = isinstance(h, str) and h and isinstance(recs, list) and 0 < len(recs) <= C.MAX_RECS
        for r in recs if ok else ():
            ok = ok and isinstance(r, list) and len(r) == 4 and isinstance(r[0], str) \
                and isinstance(r[1], list) and 0 < len(r[1]) <= C.MAX_GLOSS \
                and all(isinstance(g, str) and g for g in r[1]) and r[3] in ORIGINS \
                and r[3] in used and (r[2] is None or (isinstance(r[2], str) and r[2]))
            if ok and t == 'en' and r[2] is not None:
                ok = r[2].count('|') == 1 and r[2] != '|'
        bad += not ok
    if bad:
        err.append(f'{bad} bad e entries')
    bad = sum(not (h in e and isinstance(rows, list) and 0 < len(rows) <= C.MAX_EX and all(
        isinstance(r, list) and len(r) == 4 and isinstance(r[0], str) and isinstance(r[1], str)
        and r[1] and all(i is None or isinstance(i, int) for i in r[2:]) for r in rows))
        for h, rows in x.items())
    if bad:
        err.append(f'{bad} bad x entries')
    bad = sum(not (h in e and isinstance(rows, list) and 0 < len(rows) <= C.MAX_FORMS_M and all(
        isinstance(r, list) and len(r) == 2 and all(isinstance(v, str) and v for v in r)
        for r in rows)) for h, rows in m.items())
    if bad:
        err.append(f'{bad} bad m entries')
    bad = sum(not (isinstance(k, str) and k and k not in e and h in e) for k, h in f.items())
    if bad:
        err.append(f'{bad} bad f keys')
    tat = any(r[2] is not None for rows in x.values() for r in rows)
    if tat != ('tatoeba' in used):
        err.append('tatoeba listed/used mismatch')
    return used


def check_examples(pack, s, err):
    forms_of = {}
    for k, h in pack['f'].items():
        forms_of.setdefault(h, []).append(k)
    bad = []
    for h, rows in pack['x'].items():
        texts = [r[0] for r in rows]
        if len(set(texts)) != len(texts) or [len(t) for t in texts] != sorted(map(len, texts)):
            bad.append(h)
            continue
        for text in texts:
            if len(text) > C.EX_SRC_CHARS or not C.contains(text, [h] + forms_of.get(h, []), s):
                bad.append(h)
                break
    if bad:
        err.append(f'{len(bad)} x heads fail containment/order (e.g. {bad[0]!r})')


def check_d578(pack, t2s, err):
    """zh source: `f` is the Traditional -> Simplified fold. Returns the share of keys whose
    OpenCC t2s is not their value (CC-CEDICT variant pairs)."""
    f = pack['f']
    han = re.compile(r'^[㐀-鿿豈-﫿〇]+$')
    nonhan = sum(1 for k, h in f.items() if not (han.match(k) and han.match(h)))
    if nonhan:
        err.append(f'D-578: {nonhan} f keys not Han -> Han')
    if not f:
        err.append('D-578: zh pack without Traditional keys')
        return None
    other = sum(1 for k, h in f.items() if t2s(k) != h)
    share = other / len(f)
    if share > D578_MAX_OTHER:
        err.append(f'D-578: {other}/{len(f)} f keys do not convert to their value')
    return round(100 * share, 2)


def check_pack(out, name, opts):
    src, tgt = C.split_pack(name)
    s, t = C.iso(src), C.iso(tgt)
    d = os.path.join(out, name)
    path = os.path.join(d, f'{name}.json')
    err = []
    if not os.path.exists(path):
        return {'pack': name, 'errors': ['missing pack json']}
    with open(path, 'rb') as fh:
        raw_bytes = fh.read()
    pack = json.loads(raw_bytes)
    used = check_shape(pack, src, tgt, opts['ver'], err)
    if used is None:
        return {'pack': name, 'errors': err}
    lic = os.path.join(d, 'LICENSE.txt')
    with open(LICENSE, 'rb') as a:
        want = a.read()
    if not os.path.exists(lic) or open(lic, 'rb').read() != want:
        err.append('LICENSE.txt missing or not the CC BY-SA 4.0 text')
    att = os.path.join(d, 'ATTRIBUTION.txt')
    if not os.path.exists(att) or open(att, encoding='utf-8').read() != attribution.text(
            src, tgt, pack['ver'], used):
        err.append('ATTRIBUTION.txt missing or not the text for the sources used')
    heads = len(pack['e'])
    floor = int(C.HEADS_FLOOR * C.HEADS_BASE[name])
    if heads < floor:
        err.append(f'heads {heads} < {floor}')
    br_no = brotli_bytes(C.dumps({**pack, 'x': {}}).encode('utf-8'))
    br_with = brotli_bytes(raw_bytes)
    budget = C.br_budget(name)
    if br_no > budget:
        err.append(f'br_no {br_no} > {budget}')
    one = all(len(rows) <= 1 for rows in pack['x'].values())
    if br_with > EX_RATIO_MAX * br_no and not one:
        err.append(f'br_with {br_with} > {EX_RATIO_MAX}x br_no and examples not cut to one')
    check_examples(pack, s, err)
    t2s = opencc.t2s(opts['opencc']) if s == 'zh' else None
    d578 = check_d578(pack, t2s, err) if s == 'zh' else None
    den = num = 0
    for recs in pack['e'].values():
        for rec in recs:
            if C.translation_word(rec[1], t):
                den += 1
                num += rec[2] is not None
    rows = []
    reverse = {h for h, recs in pack['e'].items() if all(r[3] == 'cedict' for r in recs)} \
        if (s, t) == ('en', 'zh') else set()
    samples = [src] + [o for o, _ in C.SERVES.get((src, tgt), ())]
    floor_r = round(C.READING_BASE[name] - C.READING_SLACK, 1)
    for lang in samples:
        sample = C.read_samples(opts['samples'], lang)
        r = {'pair': name, 'sample': lang, **sample_metrics(pack, s, t, sample),
             'reading_floor': floor_r,
             'record_reading_rate': round(100 * num / den, 1) if den else 0.0,
             'f_t2s_other': d578 if d578 is not None else ''}
        if reverse:
            wo = sample_metrics(pack, s, t, sample, skip=reverse)
            r.update(cedict_reverse_heads=len(reverse),
                     hit_types_pct_without_reverse=wo['hit_types_pct'],
                     hit_tokens_pct_without_reverse=wo['hit_tokens_pct'])
        rows.append(r)
    own = rows[0]
    if own['reading_rate'] < floor_r:
        err.append(f"reading {own['reading_rate']}% < {floor_r}%")
    xh = round(100 * len(pack['x']) / heads, 1) if heads else 0.0
    return {'pack': name, 'errors': err, 'heads': heads, 'f_keys': len(pack['f']),
            'reading_rate': own['reading_rate'], 'examples_head_rate': xh,
            'raw': len(raw_bytes), 'br_no_examples': br_no, 'br_with_examples': br_with,
            'br_budget': budget, 'heads_floor': floor, 'reading_floor': floor_r,
            'x_one': one, 'coverage': rows}


def line(r):
    if r['errors']:
        return f"FAIL {r['pack']}: " + '; '.join(r['errors'])
    return (f"OK {r['pack']} heads={r['heads']} (>={r['heads_floor']}) f={r['f_keys']} "
            f"reading={r['reading_rate']}% (>={r['reading_floor']}%) "
            f"x_heads={r['examples_head_rate']}% br_no={r['br_no_examples']} "
            f"(<={r['br_budget']}) br_with={r['br_with_examples']}"
            + (' [x one per head]' if r['x_one'] else ''))


def write_report(rep, results):
    os.makedirs(rep, exist_ok=True)
    with open(os.path.join(rep, 'packs.csv'), 'w', newline='', encoding='utf-8') as fh:
        w = csv.DictWriter(fh, PACKS_CSV, extrasaction='ignore')
        w.writeheader()
        for r in results:
            if 'heads' in r:
                w.writerow({**r, 'pair': r['pack']})
    with open(os.path.join(rep, 'coverage.csv'), 'w', newline='', encoding='utf-8') as fh:
        w = csv.DictWriter(fh, COVERAGE_CSV, extrasaction='ignore')
        w.writeheader()
        for r in results:
            for row in r.get('coverage', ()):
                w.writerow(row)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('out')
    ap.add_argument('--samples', help='tokens.<lang>.tsv directory (default <out>/../samples)')
    ap.add_argument('--opencc', help='OpenCC tables (default <out>/../norm/opencc)')
    ap.add_argument('--packs', default='')
    ap.add_argument('--ver', default='')
    ap.add_argument('--report')
    ap.add_argument('--jobs', type=int, default=os.cpu_count() or 4)
    a = ap.parse_args()
    out = os.path.abspath(a.out)
    base = os.path.dirname(out)
    opts = {'samples': os.path.abspath(a.samples or os.path.join(base, 'samples')),
            'opencc': os.path.abspath(a.opencc or os.path.join(base, 'norm', 'opencc')),
            'ver': a.ver}
    for lang in C.LANGS:
        if not os.path.exists(os.path.join(opts['samples'], f'tokens.{lang}.tsv')):
            raise SystemExit(f"check: no sample tokens.{lang}.tsv in {opts['samples']}")
    names = a.packs.split(',') if a.packs else [C.pack_name(*p) for p in C.PACKS]
    for n in names:
        if C.split_pack(n) not in C.PACKS:
            raise SystemExit(f'not a v1 pack: {n}')
    order = sorted(names, key=lambda n: -os.path.getsize(os.path.join(out, n, f'{n}.json'))
                   if os.path.exists(os.path.join(out, n, f'{n}.json')) else 0)
    results = {}
    with ProcessPoolExecutor(max_workers=a.jobs) as ex:
        futs = {n: ex.submit(check_pack, out, n, opts) for n in order}
        for n in order:
            try:
                results[n] = futs[n].result()
            except Exception as err:  # a pack that cannot be read fails, the others still run
                results[n] = {'pack': n, 'errors': [f'{type(err).__name__}: {err}']}
    results = [results[n] for n in names]
    for r in results:
        print(line(r), flush=True)
    failed = sum(1 for r in results if r['errors'])
    if a.report:
        write_report(os.path.abspath(a.report), results)
    print(f'check: {len(results) - failed}/{len(results)} packs OK', flush=True)
    if failed:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
