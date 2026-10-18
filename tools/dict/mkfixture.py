"""Cut the es-en unit-test fixture (test/fixtures/dict/) out of a full build.

usage: python3 -I tools/dict/mkfixture.py <build/dict/norm> <samples> <out> <n_tokens>

Keeps the es-en records of the n most frequent Spanish sample tokens, their translation
tables, the English IPA of their translation words, and up to 250 short Tatoeba en-es pairs
that contain a kept head; inflection lists are cut to the card's kinds and the forms those
tokens and sentences use. Every row is copied from the input, never written by hand.
"""
import json, os, sys
norm, samples, out, ntok = sys.argv[1:5]
ntok = int(ntok)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C
import labels
KINDS = labels.kind_table('es')

def slim_fm(fm, keep):
    """The inflection rows a test can see: the card's kinds (m) and forms in `keep`."""
    return [[f, t] for f, t in fm if tuple(sorted(t)) in KINDS or f in keep][:16]

def jl(p):
    with open(p, encoding='utf-8') as f:
        for line in f:
            if line.strip():
                yield json.loads(line)

def dump(path, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False, separators=(',', ':')) + '\n')

def top(lang, n):
    with open(os.path.join(samples, f'tokens.{lang}.tsv'), encoding='utf-8') as f:
        lines = f.read().splitlines()
    return lines[0], lines[1:n + 1]

hdr, es_lines = top('es', ntok)
toks = {l.split('\t')[0] for l in es_lines}
# es-en gloss slice: records whose word is a sample token, or that list a token as a form
recs = [r for r in jl(os.path.join(norm, 'kaikki/es-en.jsonl'))
        if r['w'] in toks or r['w'].lower() in toks or any(f in toks for f, _ in r['fm'])]
heads = {r['w'] for r in recs}
tr = [r for r in jl(os.path.join(norm, 'tr/es-en.jsonl')) if r['w'] in heads]
heads |= {r['w'] for r in tr}
# es-es feeds only the form table (formtab.rows_of reads w, fm, lo): keep those fields
eses = [{'w': r['w'], 'pos': r['pos'], 'fm': r['fm'], 'lo': r['lo'], 'ipa': []} for r in jl(os.path.join(norm, 'kaikki/es-es.jsonl'))
        if r['w'] in heads]
# English translation words of those records: only what the reading lookup needs
words = set()
for r in recs:
    for g in r['g']:
        w = C.word_form(g, 'en')
        if w: words.add(w)
for r in tr:
    for s in r['s']:
        w = C.translation_word(s, 'en')
        if w: words.add(w)
def first_per_label(ipa):
    seen = {}
    for label, v in ipa:
        seen.setdefault(label, [label, v])
    return list(seen.values())

enen = [{'w': r['w'], 'pos': r['pos'], 'fm': [], 'lo': [], 'ipa': first_per_label(r['ipa'])}
        for r in jl(os.path.join(norm, 'kaikki/en-en.jsonl')) if r['w'] in words and r.get('ipa')]
seen = set(); enen2 = []
for r in enen:
    if r['w'] not in seen:
        seen.add(r['w']); enen2.append(r)
dump(os.path.join(out, 'norm/tr/es-en.jsonl'), tr)
dump(os.path.join(out, 'norm/kaikki/en-en.jsonl'), enen2)
os.makedirs(os.path.join(out, 'norm/ipa'), exist_ok=True)
for name in ('cmu-en', 'ipadict-en_UK', 'ipadict-en_US'):
    with open(os.path.join(norm, f'ipa/{name}.tsv'), encoding='utf-8') as f, \
         open(os.path.join(out, f'norm/ipa/{name}.tsv'), 'w', encoding='utf-8') as o:
        for line in f:
            if line.split('\t', 1)[0] in words:
                o.write(line)
# Tatoeba en-es rows whose Spanish sentence contains a fixture head, shortest first
keys = {k for h in heads for k in [h.lower()]}
rows = []
with open(os.path.join(norm, 'tatoeba/en-es.tsv'), encoding='utf-8') as f:
    for line in f:
        p = line.rstrip('\n').split('\t')
        # sorted pair file en-es: en id, en text, es id, es text
        if len(p) == 4 and len(p[3]) <= 40 and any(k in keys for k in C.sentence_keys(p[3], 'es')):
            rows.append(line)
rows.sort(key=len)
os.makedirs(os.path.join(out, 'norm/tatoeba'), exist_ok=True)
with open(os.path.join(out, 'norm/tatoeba/en-es.tsv'), 'w', encoding='utf-8') as o:
    o.writelines(rows[:250])
keep = set(toks)
for line in rows[:250]:
    keep |= set(C.sentence_keys(line.rstrip('\n').split('\t')[3], 'es'))
for r in recs:
    r['fm'] = slim_fm(r['fm'], keep)
    r['g'] = r['g'][:4]
    r['ex'] = r['ex'][:1]
    r['ipa'] = []  # the es-en pack reads the English reading only
for r in eses:
    r['fm'] = slim_fm(r['fm'], keep)
dump(os.path.join(out, 'norm/kaikki/es-en.jsonl'), recs)
dump(os.path.join(out, 'norm/kaikki/es-es.jsonl'), eses)
os.makedirs(os.path.join(out, 'samples'), exist_ok=True)
for lang in C.LANGS:
    h, ls = top(lang, ntok if lang == 'es' else 10)
    with open(os.path.join(out, f'samples/tokens.{lang}.tsv'), 'w', encoding='utf-8') as o:
        o.write(h + '\n' + ''.join(l + '\n' for l in ls))
print('heads', len(heads), 'recs', len(recs), 'tr', len(tr), 'eses', len(eses), 'enen', len(enen2), 'words', len(words), 'tatoeba', min(250, len(rows)))
