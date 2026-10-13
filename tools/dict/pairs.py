#!/usr/bin/env python3 -I
"""Build the dictionary packs (v1 contract) from the normalized datasets.

Usage: python3 -I tools/dict/pairs.py <norm-dir> <out-dir> --work <dir> --stats <dir>
           --ver YYYY.MM.DD --license <cc-by-sa-4.0.txt> [--packs a-b,c-d] [--jobs N]
           [--reuse-work] [--layers]

Steps:
  prepare  the per-language tables several packs share, written once into --work:
           read-<t>.tsv (readings.prepare) and forms-<s>.tsv (formtab.prepare).
           --reuse-work keeps tables that already exist.
  packs    one process per pack: `e` (entries.Builder), `f`/`m` (formtab), `x` (examples).
           Writes out/<pack>/{<pack>.json, LICENSE.txt, ATTRIBUTION.txt} (D-570) and, in
           --stats, <pack>.noex.json (the same pack with x = {}) and <pack>.json (numbers).

Size rules (taskbook): a pack whose no-example brotli is over common.br_budget takes the
formtab.RUNGS cuts in order until it fits (stats `size_cuts`); then, when the brotli size of
the pack is more than twice that of its no-example variant, the pack is rebuilt with one
example per head and its stats say so (`examples_cut_to_one`).
"""
import argparse
import os
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import attribution  # noqa: E402
import common as C  # noqa: E402
import examples  # noqa: E402
import formtab  # noqa: E402
import readings  # noqa: E402
from entries import Builder  # noqa: E402

EX_RATIO_MAX = 2.0


def brotli_size(path):
    return len(subprocess.run(['brotli', '-q', '11', '-c', path], capture_output=True,
                              check=True).stdout)


def write_json(path, obj):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(C.dumps(obj))
    os.replace(tmp, path)
    return os.path.getsize(path)


# ---------------- prepare ----------------
def prepare_jobs(packs, work, reuse):
    jobs = []
    tgts = sorted({C.iso(t) for _, t in packs if readings.needs_prepare(C.iso(t))})
    srcs = sorted({C.iso(s) for s, _ in packs if formtab.needs_prepare(C.iso(s))})
    for t in tgts:
        if not (reuse and os.path.exists(readings.table_path(work, t))):
            jobs.append((readings.prepare, 'read', t))
    for s in srcs:
        if not (reuse and os.path.exists(formtab.table_path(work, s))):
            jobs.append((formtab.prepare, 'forms', s))
    return jobs


def run_prepare(norm, work, packs, reuse, n):
    os.makedirs(work, exist_ok=True)
    jobs = prepare_jobs(packs, work, reuse)
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=n) as ex:
        futs = [(kind, lang, ex.submit(fn, norm, work, lang)) for fn, kind, lang in jobs]
        for kind, lang, fut in futs:
            _, rows = fut.result()
            print(f'  prepare {kind}-{lang}: {rows} rows', flush=True)
    print(f'prepare: {len(jobs)} tables in {round(time.time() - t0)}s', flush=True)


# ---------------- one pack ----------------
def reading_rate(e, t):
    """(records with a translation word, of those with a reading): the reading-rate fraction."""
    den = num = 0
    for recs in e.values():
        for rec in recs:
            if C.translation_word(rec[1], t):
                den += 1
                num += rec[2] is not None
    return den, num


def compose(b, x, f, m, ver, used):
    """The pack object. Tables are written in head order and `f` grouped by head (then key):
    the order means nothing to a lookup, and grouping like keys and like values together
    makes brotli 7-24% smaller (es-en `f`: 1.94 MB in build order, 1.48 MB grouped)."""
    return {'v': 1, 'src': b.src, 'tgt': b.tgt, 'ver': ver, 'lic': 'CC-BY-SA-4.0',
            'sources': C.sources_rows(used), 'credits': C.credits_for(used),
            'e': dict(sorted(b.e.items())), 'x': dict(sorted(x.items())),
            'm': dict(sorted(m.items())),
            'f': dict(sorted(f.items(), key=lambda kv: (kv[1], kv[0])))}


def layer_sizes(pack, stats_dir, name):
    out = {}
    for k in ('e', 'x', 'm', 'f'):
        p = os.path.join(stats_dir, f'{name}.layer-{k}.json')
        write_json(p, pack[k])
        out[k] = brotli_size(p)
        os.remove(p)
    return out


def measure_noex(b, f, m, ver, used, path):
    write_json(path, compose(b, {}, f, m, ver, used))
    return brotli_size(path)


def build_pack(norm, out, work, stats_dir, ver, license_path, src, tgt, layers):
    t0 = time.time()
    name = C.pack_name(src, tgt)
    b = Builder(norm, work, src, tgt)
    b.build()
    f, m, fstats = formtab.build(norm, work, b)
    used_noex = set(b.used)
    noex_path = os.path.join(stats_dir, f'{name}.noex.json')
    br_no = measure_noex(b, f, m, ver, used_noex, noex_path)
    # Size cut 4 (formtab.RUNGS): only while the no-example variant is over its ceiling, and
    # before `x`, which finds its sentences through the final `f`.
    budget, cuts, att = C.br_budget(name), [], None
    for rung in formtab.RUNGS:
        if br_no <= budget:
            break
        att = att or formtab.attested(norm, b.s, b.e, f)
        f, m = formtab.cut(rung, f, m, *att)
        cuts.append(rung)
        br_no = measure_noex(b, f, m, ver, used_noex, noex_path)
    x, xused, xstats = examples.build(norm, b, f)
    used = used_noex | xused
    pack_dir = os.path.join(out, name)
    os.makedirs(pack_dir, exist_ok=True)
    pack_path = os.path.join(pack_dir, f'{name}.json')
    pack = compose(b, x, f, m, ver, used)
    raw = write_json(pack_path, pack)
    br_with = brotli_size(pack_path)
    cut_x = False
    if br_with > EX_RATIO_MAX * br_no:
        cut_x = True
        x, xused, xstats = examples.build(norm, b, f, per_head=1)
        used = used_noex | xused
        pack = compose(b, x, f, m, ver, used)
        raw = write_json(pack_path, pack)
        br_with = brotli_size(pack_path)
    attribution.write(pack_dir, src, tgt, ver, used, license_path)
    den, num = reading_rate(b.e, b.t)
    st = {'pack': name, 'heads': len(b.e), 'records': sum(len(v) for v in b.e.values()),
          'reading_den': den, 'reading_num': num,
          'reading_rate': round(100 * num / den, 1) if den else None,
          **fstats, 'f_keys_built': fstats['f_keys'], 'f_keys': len(f),
          'm_heads_built': fstats['m_heads'], 'm_heads': len(m), 'size_cuts': cuts,
          **xstats,
          'examples_head_rate': round(100 * xstats['x_heads'] / len(b.e), 1) if b.e else 0,
          'examples_cut_to_one': cut_x, 'raw': raw,
          'raw_no_examples': os.path.getsize(noex_path), 'br_budget': budget,
          'br_no_examples': br_no, 'br_with_examples': br_with,
          'reverse_added': b.reverse_added, 'sources': sorted(used),
          'seconds': round(time.time() - t0, 1)}
    if layers:
        st['br_layers'] = layer_sizes(pack, stats_dir, name)
    write_json(os.path.join(stats_dir, f'{name}.json'), st)
    return st


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('norm')
    ap.add_argument('out')
    ap.add_argument('--work', required=True)
    ap.add_argument('--stats', required=True)
    ap.add_argument('--ver', required=True)
    ap.add_argument('--license', required=True)
    ap.add_argument('--packs', default='')
    ap.add_argument('--jobs', type=int, default=os.cpu_count() or 4)
    ap.add_argument('--reuse-work', action='store_true')
    ap.add_argument('--layers', action='store_true')
    a = ap.parse_args()
    norm, out, work, stats = (os.path.abspath(p) for p in (a.norm, a.out, a.work, a.stats))
    packs = [C.split_pack(p) for p in a.packs.split(',')] if a.packs else list(C.PACKS)
    unknown = [p for p in packs if p not in C.PACKS]
    if unknown:
        raise SystemExit(f'not a v1 pack: {unknown}')
    os.makedirs(out, exist_ok=True)
    os.makedirs(stats, exist_ok=True)
    t0 = time.time()
    run_prepare(norm, work, packs, a.reuse_work, a.jobs)
    # Largest packs first so the long ones do not start last.
    order = sorted(packs, key=lambda p: -C.HEADS_BASE[C.pack_name(*p)])
    lic = os.path.abspath(a.license)
    failed = 0
    with ProcessPoolExecutor(max_workers=a.jobs) as ex:
        futs = [(p, ex.submit(build_pack, norm, out, work, stats, a.ver, lic, p[0], p[1],
                              a.layers)) for p in order]
        for p, fut in futs:
            try:
                st = fut.result()
            except Exception as err:  # one failed pack fails the build, after the others finish
                failed += 1
                print(f'  FAIL {C.pack_name(*p)}: {type(err).__name__}: {err}', flush=True)
                continue
            print(f"  {st['pack']}: heads={st['heads']} f={st['f_keys']} "
                  f"reading={st['reading_rate']}% x_heads={st['examples_head_rate']}% "
                  f"br_no={st['br_no_examples']} br_with={st['br_with_examples']} "
                  f"{st['seconds']}s" + (' [x cut to 1]' if st['examples_cut_to_one'] else '')
                  + (f" [cuts {','.join(st['size_cuts'])}]" if st['size_cuts'] else ''),
                  flush=True)
    print(f'pairs: {len(packs) - failed}/{len(packs)} packs in {round(time.time() - t0)}s',
          flush=True)
    if failed:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
