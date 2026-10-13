#!/usr/bin/env python3 -I
"""Normalize the downloaded datasets into the line-per-record shapes pairs.py reads.

Usage: python3 -I tools/dict/normalize.py <data-dir> <norm-dir> [--jobs N]

Every path is an argument and nothing inside <data-dir> is executed (it is untrusted data).
Each big source file is read exactly once and fanned out to every pack that needs it; the
files run in parallel, largest first. Output (all UTF-8, one JSON object per line):

  kaikki/<s>-<ed>.jsonl  kaikki edition <ed>, words of language <s>, glossed in <ed>:
                         {w, pos, g:[gloss], lo:[lemma], ex:[[text, translation]],
                          fm:[[form, [tags]]], ipa:[[label, ipa]], r:kana|null}
  kaikki/<s>-<s>.jsonl   own edition (and en-en), slim: {w, pos, fm, lo, ipa}; only for the
                         Latin-script sources whose f table and readings need it
  tr/<s>-<t>.jsonl       translation tables of <s> words into <t>, one list per sense:
                         {w, pos, s:[[word, ...], ...]}
  cedict.jsonl           {s, t, p (pinyin with tone marks), g:[gloss]}
  jmdict.jsonl           {k:[keb], r:[reb], nf:int|null, s:[{p:[pos code], m:[misc code], g:[gloss]}]}
  tatoeba/<a>-<b>.tsv    idA, textA, idB, textB for every Tatoeba link between the two languages
  ipa/ipadict-<name>.tsv word, ipa (first variant) from ipa-dict
  ipa/cmu-en.tsv         word, IPA converted from CMUdict ARPAbet
  opencc/*.txt           the OpenCC tables, copied verbatim
"""
import bz2
import gzip
import json
import os
import re
import shutil
import sys
import time
from concurrent.futures import ProcessPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402
from opencc import OPENCC_FILES  # noqa: E402

FORM_SKIP_TAGS = {'romanization', 'canonical', 'table-tags', 'inflection-template', 'class'}
IPA_LABEL = (('UK', {'UK', 'Received-Pronunciation', 'RP', 'British', 'England'}),
             ('US', {'US', 'General-American', 'GA', 'American', 'GenAm'}))
EX_MAX_CHARS = 200
EX_PER_RECORD = 5
IPADICT = ('en_UK', 'en_US', 'es_ES', 'fr_FR', 'de', 'pt_BR', 'ko', 'ja', 'zh_hans')


def dump(fh, rec):
    fh.write(json.dumps(rec, ensure_ascii=False, separators=(',', ':')) + '\n')


# ---------------- which slices the 30 packs need ----------------
def needs():
    """(gloss slices {(s, ed)}, own-edition fan-out {s: [t...]}) for the packs in common.PACKS."""
    gloss, fan = set(), {}
    for src, tgt in C.PACKS:
        s, t = C.iso(src), C.iso(tgt)
        gloss.add((s, t))
        fan.setdefault(s, set()).add(t)
    return gloss, {s: sorted(ts) for s, ts in fan.items()}


def kaikki_path(data, s, ed):
    if ed == 'en':
        return os.path.join(data, 'kaikki-en', f'kaikki.org-dictionary-{C.KAIKKI_EN_NAME[s]}.jsonl.gz')
    return os.path.join(data, f'kaikki-{ed}', f'{s}.jsonl.gz')


# ---------------- kaikki ----------------
def kaikki_ipa(sounds):
    out = []
    for snd in sounds or []:
        ipa = snd.get('ipa')
        if not ipa or not isinstance(ipa, str):
            continue
        tags = set(snd.get('tags') or [])
        label = ''
        for lab, keys in IPA_LABEL:
            if tags & keys:
                label = lab
                break
        out.append([label, ipa])
    return out


def kaikki_forms(e):
    out = []
    for x in e.get('forms') or []:
        fm, tags = x.get('form'), x.get('tags') or []
        if fm and isinstance(fm, str) and not (FORM_SKIP_TAGS & set(tags)):
            out.append([fm, tags])
    return out


def kaikki_record(e, ed, slim):
    """One normalized record of a kaikki entry, or None when it carries nothing usable."""
    w = e.get('word')
    if not w or not isinstance(w, str):
        return None
    glosses, lemma_of, ex = [], [], []
    for sense in e.get('senses') or []:
        tags = set(sense.get('tags') or [])
        fo = sense.get('form_of') or sense.get('alt_of') or []
        if fo:
            lemma_of.extend(x.get('word') for x in fo if x.get('word'))
            if 'form-of' in tags or 'alt-of' in tags:
                continue
        if slim:
            continue
        gl = sense.get('glosses') or sense.get('raw_glosses') or []
        if gl:
            glosses.append(gl[-1] if len(gl) > 1 else gl[0])
        for x in sense.get('examples') or []:
            text = x.get('text')
            # English edition: the translation is English ('english' in older dumps); every
            # other edition writes the translation in its own language under 'translation'.
            tr = x.get('translation') or (x.get('english') if ed == 'en' else None)
            if (text and tr and len(text) <= EX_MAX_CHARS and len(tr) <= EX_MAX_CHARS
                    and len(ex) < EX_PER_RECORD):
                ex.append([text, tr])
    rec = {'w': w, 'pos': e.get('pos') or '', 'fm': kaikki_forms(e),
           'lo': sorted(set(lemma_of)), 'ipa': kaikki_ipa(e.get('sounds'))}
    if slim:
        return rec if (rec['fm'] or rec['lo'] or rec['ipa']) else None
    reading = None
    for x in e.get('forms') or []:
        tags = set(x.get('tags') or [])
        if {'hiragana', 'katakana', 'kana'} & tags:
            reading = x.get('form')
            break
    rec.update(g=glosses, ex=ex, r=reading)
    return rec if (glosses or lemma_of) else None


def kaikki_senses_tr(e, code_to_t):
    """{t: [[words of one sense], ...]} from entry-level and per-sense translation lists."""
    pools = [e.get('translations') or []]
    for sense in e.get('senses') or []:
        if sense.get('translations'):
            pools.append(sense['translations'])
    by_sense = {}
    for i, items in enumerate(pools):
        for x in items:
            t = code_to_t.get(x.get('lang_code') or x.get('code'))
            word = x.get('word')
            if not t or not word or not isinstance(word, str):
                continue
            key = (i, x.get('sense') or str(x.get('sense_index') or ''))
            words = by_sense.setdefault(t, {}).setdefault(key, [])
            if word not in words:
                words.append(word)
    return {t: list(senses.values()) for t, senses in by_sense.items()}


def job_kaikki(path, norm, s, ed, gloss_slice, fan_targets, slim_own):
    """One pass over one kaikki file: the gloss slice <s>-<ed> and/or the slim own-edition file
    plus the translation tables of <s> into every target in fan_targets."""
    t0 = time.time()
    outs, counts = {}, {}

    def out(rel):
        if rel not in outs:
            p = os.path.join(norm, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            outs[rel] = open(p, 'w', encoding='utf-8')
            counts[rel] = 0
        return outs[rel]
    code_to_t = {code: t for t in fan_targets for code in C.tr_codes(t)}
    with gzip.open(path, 'rt', encoding='utf-8') as f:
        for line in f:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if not isinstance(e, dict):
                continue
            if gloss_slice:
                rec = kaikki_record(e, ed, slim=False)
                if rec:
                    dump(out(f'kaikki/{s}-{ed}.jsonl'), rec)
                    counts[f'kaikki/{s}-{ed}.jsonl'] += 1
            if slim_own:
                rec = kaikki_record(e, ed, slim=True)
                if rec:
                    dump(out(f'kaikki/{s}-{s}.jsonl'), rec)
                    counts[f'kaikki/{s}-{s}.jsonl'] += 1
            if code_to_t and e.get('word'):
                for t, senses in kaikki_senses_tr(e, code_to_t).items():
                    rel = f'tr/{s}-{t}.jsonl'
                    dump(out(rel), {'w': e['word'], 'pos': e.get('pos') or '', 's': senses})
                    counts[rel] += 1
    for fh in outs.values():
        fh.close()
    return os.path.basename(path), counts, round(time.time() - t0, 1)


# ---------------- CC-CEDICT ----------------
CEDICT_LINE = re.compile(r'^(\S+) (\S+) \[([^\]]+)\] /(.+)/\s*$')
TONE_MARKS = {'a': 'āáǎà', 'e': 'ēéěè', 'i': 'īíǐì', 'o': 'ōóǒò', 'u': 'ūúǔù', 'ü': 'ǖǘǚǜ'}


def pinyin_marks(num):
    """CEDICT numbered pinyin -> tone marks (a/e first, then o of ou, else the last vowel)."""
    out = []
    for syl in num.split():
        m = re.match(r'^([A-Za-zü:]+?)([1-5])$', syl.replace('u:', 'ü').replace('v', 'ü'))
        if not m:
            out.append(syl)
            continue
        body, tone = m.group(1), int(m.group(2))
        if tone == 5:
            out.append(body)
            continue
        low = body.lower()
        if 'a' in low:
            i = low.index('a')
        elif 'e' in low:
            i = low.index('e')
        elif 'ou' in low:
            i = low.index('o')
        else:
            i = max((low.rfind(v) for v in 'iouü'), default=-1)
        if i < 0:
            out.append(body)
            continue
        marked = TONE_MARKS[low[i]][tone - 1]
        if body[i].isupper():
            marked = marked.upper()
        out.append(body[:i] + marked + body[i + 1:])
    return ' '.join(out)


def job_cedict(path, norm):
    t0, n = time.time(), 0
    with gzip.open(path, 'rt', encoding='utf-8') as f, \
            open(os.path.join(norm, 'cedict.jsonl'), 'w', encoding='utf-8') as o:
        for line in f:
            if line.startswith('#'):
                continue
            m = CEDICT_LINE.match(line)
            if not m:
                continue
            trad, simp, py, gl = m.groups()
            dump(o, {'s': simp, 't': trad, 'p': pinyin_marks(py), 'g': [g for g in gl.split('/') if g]})
            n += 1
    return 'cedict', {'cedict.jsonl': n}, round(time.time() - t0, 1)


# ---------------- JMdict ----------------
XML_LANG = '{http://www.w3.org/XML/1998/namespace}lang'
ENTITY = re.compile(r'<!ENTITY (\S+) "([^"]*)">')


def jmdict_entities(path):
    """Entity text -> code from the DTD (ElementTree expands &v5k; to its description)."""
    rev, buf = {}, []
    with gzip.open(path, 'rt', encoding='utf-8') as f:
        for line in f:
            buf.append(line)
            if line.startswith(']>'):
                break
    for code, text in ENTITY.findall(''.join(buf)):
        rev.setdefault(text, code)
    return rev


def job_jmdict(path, norm):
    import xml.etree.ElementTree as ET
    t0, n = time.time(), 0
    rev = jmdict_entities(path)

    def code(el):
        return rev.get(el.text or '', el.text or '')
    with gzip.open(path, 'rb') as f, open(os.path.join(norm, 'jmdict.jsonl'), 'w', encoding='utf-8') as o:
        for _, el in ET.iterparse(f, events=('end',)):
            if el.tag != 'entry':
                continue
            kebs = [k.findtext('keb') for k in el.findall('k_ele')]
            rebs = [r.findtext('reb') for r in el.findall('r_ele')]
            nf = None
            for pri in list(el.iter('ke_pri')) + list(el.iter('re_pri')):
                m = re.match(r'nf(\d+)', pri.text or '')
                if m:
                    nf = min(nf or 99, int(m.group(1)))
            senses, pos = [], []
            for s in el.findall('sense'):
                p = [code(x) for x in s.findall('pos')]
                if p:
                    pos = p  # a sense without <pos> inherits the previous one (JMdict DTD)
                gl = [g.text for g in s.findall('gloss') if g.text and g.get(XML_LANG, 'eng') == 'eng']
                if gl:
                    senses.append({'p': pos, 'm': [code(x) for x in s.findall('misc')], 'g': gl})
            if senses and (kebs or rebs):
                dump(o, {'k': [k for k in kebs if k], 'r': [r for r in rebs if r], 'nf': nf, 's': senses})
                n += 1
            el.clear()
    return 'jmdict', {'jmdict.jsonl': n}, round(time.time() - t0, 1)


# ---------------- Tatoeba ----------------
def tatoeba_pairs():
    """Unordered iso pairs the packs need, as (a, b, links file stem)."""
    out = {}
    for src, tgt in C.PACKS:
        a, b = sorted((C.iso(src), C.iso(tgt)))
        out[(a, b)] = None
    return sorted(out)


def find_links(data, a, b):
    for x, y in ((a, b), (b, a)):
        p = os.path.join(data, 'tatoeba', f'{C.TAT[x]}-{C.TAT[y]}_links.tsv.bz2')
        if os.path.exists(p):
            return p, x, y
    raise FileNotFoundError(f'no Tatoeba links file for {a}-{b}')


def job_tatoeba(data, norm):
    t0 = time.time()
    links, want = {}, {}
    for a, b in tatoeba_pairs():
        p, x, y = find_links(data, a, b)
        rows = []
        with bz2.open(p, 'rt', encoding='utf-8') as f:
            for line in f:
                parts = line.rstrip('\n').split('\t')
                if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
                    rows.append((int(parts[0]), int(parts[1])))
        links[(x, y)] = rows
        want.setdefault(x, set()).update(r[0] for r in rows)
        want.setdefault(y, set()).update(r[1] for r in rows)
    text = {}
    for lang, ids in want.items():
        m = text.setdefault(lang, {})
        with bz2.open(os.path.join(data, 'tatoeba', f'{C.TAT[lang]}_sentences.tsv.bz2'), 'rt',
                      encoding='utf-8') as f:
            for line in f:
                parts = line.rstrip('\n').split('\t')
                if len(parts) >= 3 and parts[0].isdigit():
                    i = int(parts[0])
                    if i in ids and len(parts[2]) <= EX_MAX_CHARS:
                        m[i] = parts[2]
    counts = {}
    os.makedirs(os.path.join(norm, 'tatoeba'), exist_ok=True)
    for (x, y), rows in links.items():
        rel = f'tatoeba/{x}-{y}.tsv'
        n = 0
        with open(os.path.join(norm, rel), 'w', encoding='utf-8') as o:
            for i, j in rows:
                tx, ty = text[x].get(i), text[y].get(j)
                if tx and ty and '\t' not in tx + ty:
                    o.write(f'{i}\t{tx}\t{j}\t{ty}\n')
                    n += 1
        counts[rel] = n
    return 'tatoeba', counts, round(time.time() - t0, 1)


# ---------------- pronunciation tables and OpenCC ----------------
ARPA = {'AA': 'ɑ', 'AE': 'æ', 'AH': 'ʌ', 'AO': 'ɔ', 'AW': 'aʊ', 'AY': 'aɪ', 'B': 'b', 'CH': 'tʃ',
        'D': 'd', 'DH': 'ð', 'EH': 'ɛ', 'ER': 'ɝ', 'EY': 'eɪ', 'F': 'f', 'G': 'ɡ', 'HH': 'h',
        'IH': 'ɪ', 'IY': 'i', 'JH': 'dʒ', 'K': 'k', 'L': 'l', 'M': 'm', 'N': 'n', 'NG': 'ŋ',
        'OW': 'oʊ', 'OY': 'ɔɪ', 'P': 'p', 'R': 'ɹ', 'S': 's', 'SH': 'ʃ', 'T': 't', 'TH': 'θ',
        'UH': 'ʊ', 'UW': 'u', 'V': 'v', 'W': 'w', 'Y': 'j', 'Z': 'z', 'ZH': 'ʒ'}


def job_tables(data, norm):
    t0, counts = time.time(), {}
    os.makedirs(os.path.join(norm, 'ipa'), exist_ok=True)
    for name in IPADICT:
        rel, seen = f'ipa/ipadict-{name}.tsv', set()
        with open(os.path.join(data, 'ipa-dict', f'{name}.txt'), encoding='utf-8') as f, \
                open(os.path.join(norm, rel), 'w', encoding='utf-8') as o:
            for line in f:
                if '\t' not in line:
                    continue
                w, ipa = line.rstrip('\n').split('\t', 1)
                ipa = ipa.split(',')[0].strip()
                if w and ipa and w not in seen:
                    seen.add(w)
                    o.write(f'{w}\t{ipa}\n')
        counts[rel] = len(seen)
    seen = set()
    with open(os.path.join(data, 'cmudict', 'cmudict.dict'), encoding='latin-1') as f, \
            open(os.path.join(norm, 'ipa', 'cmu-en.tsv'), 'w', encoding='utf-8') as o:
        for line in f:
            if line.startswith(';;;'):
                continue
            parts = line.split('#')[0].split()
            if len(parts) < 2:
                continue
            w = re.sub(r'\(\d+\)$', '', parts[0])
            if w in seen:
                continue
            seen.add(w)
            ph = []
            for p in parts[1:]:
                if p.endswith('1'):
                    ph.append('ˈ')
                base = re.sub(r'\d', '', p)
                ph.append(ARPA.get(base, base))
            o.write(f"{w}\t/{''.join(ph)}/\n")
    counts['ipa/cmu-en.tsv'] = len(seen)
    os.makedirs(os.path.join(norm, 'opencc'), exist_ok=True)
    for name in OPENCC_FILES:
        shutil.copyfile(os.path.join(data, 'opencc', name), os.path.join(norm, 'opencc', name))
    counts['opencc'] = len(OPENCC_FILES)
    return 'tables', counts, round(time.time() - t0, 1)


# ---------------- driver ----------------
def inputs(data):
    """Every file under <data-dir> this step reads, relative to it (tools/dict/sources.json
    pins each one's URL and sha256)."""
    gloss, fan = needs()
    paths = {kaikki_path(data, s, ed) for s, ed in gloss if s != ed}
    paths |= {kaikki_path(data, s, s) for s in fan}
    langs = set()
    for a, b in tatoeba_pairs():
        p, x, y = find_links(data, a, b)
        paths.add(p)
        langs |= {x, y}
    paths |= {os.path.join(data, 'tatoeba', f'{C.TAT[x]}_sentences.tsv.bz2') for x in langs}
    paths.add(os.path.join(data, 'jmdict', 'JMdict.gz'))
    paths.add(os.path.join(data, 'cedict', 'cedict_1_0_ts_utf-8_mdbg.txt.gz'))
    paths |= {os.path.join(data, 'ipa-dict', f'{n}.txt') for n in IPADICT}
    paths.add(os.path.join(data, 'cmudict', 'cmudict.dict'))
    paths |= {os.path.join(data, 'opencc', n) for n in OPENCC_FILES}
    return sorted(os.path.relpath(p, data) for p in paths)


def plan(data, norm):
    """[(bytes, fn, args)] for every job; kaikki own-edition files fan out to all targets."""
    gloss, fan = needs()
    jobs = {}
    for s, ed in sorted(gloss):
        if s != ed:
            jobs.setdefault((s, ed), {'gloss': False, 'fan': [], 'slim': False})['gloss'] = True
    for s, ts in fan.items():
        ed = s  # own edition; the English edition's own slice is the English one
        j = jobs.setdefault((s, ed), {'gloss': False, 'fan': [], 'slim': False})
        j['fan'] = ts
        j['slim'] = s in C.LATIN
    out = []
    for (s, ed), j in jobs.items():
        path = kaikki_path(data, s, ed)
        if not os.path.exists(path):
            raise FileNotFoundError(path)
        gloss_slice = j['gloss'] and s != ed
        out.append((os.path.getsize(path), job_kaikki,
                    (path, norm, s, ed, gloss_slice, j['fan'], j['slim'])))
    out.append((os.path.getsize(os.path.join(data, 'jmdict', 'JMdict.gz')) * 6, job_jmdict,
                (os.path.join(data, 'jmdict', 'JMdict.gz'), norm)))
    out.append((60_000_000, job_tatoeba, (data, norm)))
    out.append((os.path.getsize(os.path.join(data, 'cedict', 'cedict_1_0_ts_utf-8_mdbg.txt.gz')),
                job_cedict, (os.path.join(data, 'cedict', 'cedict_1_0_ts_utf-8_mdbg.txt.gz'), norm)))
    out.append((1, job_tables, (data, norm)))
    return sorted(out, key=lambda x: -x[0])


def main():
    import argparse
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('data')
    ap.add_argument('norm')
    ap.add_argument('--jobs', type=int, default=os.cpu_count() or 4)
    ap.add_argument('--list-inputs', action='store_true',
                    help='print the files under <data-dir> this step reads, then exit')
    a = ap.parse_args()
    data, norm, jobs_n = os.path.abspath(a.data), os.path.abspath(a.norm), a.jobs
    if a.list_inputs:
        print('\n'.join(inputs(data)))
        return
    os.makedirs(norm, exist_ok=True)
    t0 = time.time()
    work = plan(data, norm)
    print(f'normalize: {len(work)} jobs on {jobs_n} processes', flush=True)
    with ProcessPoolExecutor(max_workers=jobs_n) as ex:
        futs = [ex.submit(fn, *a) for _, fn, a in work]
        for fut in futs:
            name, counts, secs = fut.result()
            print(f'  {name}: {secs}s ' + ' '.join(f'{k}={v}' for k, v in sorted(counts.items())),
                  flush=True)
    print(f'normalize: done in {round(time.time() - t0)}s', flush=True)


if __name__ == '__main__':
    main()
