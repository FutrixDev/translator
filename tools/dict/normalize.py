#!/usr/bin/env -S python3 -I
"""Normalize the downloaded datasets into the line-per-record shapes pairs.py reads.

Usage: python3 -I tools/dict/normalize.py <data-dir> <norm-dir> [--jobs N]

Every path is an argument and nothing inside <data-dir> is executed (it is untrusted data).
Each big source file is read exactly once and fanned out to every pack that needs it; the
files run in parallel, largest first. Output (all UTF-8, one JSON object per line):

  kaikki/<s>-<ed>.jsonl  kaikki edition <ed>, words of language <s>, glossed in <ed>:
                         {w, pos, g:[gloss], lo:[lemma], ex:[[text, translation]],
                          fm:[[form, [tags]]], ipa:[[label, ipa]], r:kana|null, mn?:1, lt?:1}
                         (kaikki_record: form-of senses -> lo, minor glosses last)
  kaikki/<s>-<s>.jsonl   own edition (and en-en), slim: {w, pos, fm, lo, ipa}; only for the
                         Latin-script sources whose f table and readings need it
  tr/<s>-<t>.jsonl       translation tables of <s> words into <t>, one list per table, widest
                         first (kaikki_senses_tr): {w, pos, s:[[word, ...], ...],
                         b:[languages per table], ew:items of the whole entry,
                          mn?:[indices of minor tables]}
  cedict.jsonl           {s, t, p (pinyin with tone marks), g:[gloss]}
  jmdict.jsonl           {k:[keb], r:[reb], nf:int|null, s:[{p:[pos code], m:[misc code], g:[gloss]}]}
  tatoeba/<a>-<b>.tsv    idA, textA, idB, textB for every Tatoeba link of the pair (a < b)
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
    """One normalized record of a kaikki entry, or None when it carries nothing usable.

    A form-of or alt-of sense (kaikki `form_of`/`alt_of`, or a gloss that explains a form:
    common.form_of_lemma) is no gloss: its lemma goes into `lo` and `f` maps the word to it
    (D-614 R8). Letter, unit and abbreviation glosses (common.minor_sense) come after the
    others, and `mn` is 1 when they are all the record has. `lt` is 1 when a sense was found
    to be a form by its gloss text alone: the spike took that gloss as content and counted
    the word as a head (common.heads_count)."""
    w = e.get('word')
    if not w or not isinstance(w, str):
        return None
    glosses, minor, lemma_of, ex = [], [], [], []
    text_form_of = False
    for sense in e.get('senses') or []:
        fo = sense.get('form_of') or sense.get('alt_of') or []
        if fo:
            lemma_of.extend(x.get('word') for x in fo if x.get('word'))
            continue
        if slim:
            continue
        gl = sense.get('glosses') or sense.get('raw_glosses') or []
        if not gl:
            continue
        g = gl[-1] if len(gl) > 1 else gl[0]
        lemma = C.form_of_lemma(g, ed)
        if lemma is not None:
            text_form_of = True
            if lemma:
                lemma_of.append(lemma)
            continue
        (minor if C.minor_sense(sense) else glosses).append(g)
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
    rec.update(g=glosses + minor, ex=ex, r=reading)
    if minor and not glosses:
        rec['mn'] = 1
    if text_form_of:
        rec['lt'] = 1
    return rec if (rec['g'] or lemma_of) else None


# A translation-table word that is a sentence or a note, not a translation (D-614 R8): it
# ends like a sentence or is a "a/b" fragment (zh writes "Traditional /Simplified", which
# entries.tr_word splits). The sentence test applies to a one-word head only: a phrase or a
# proverb ("fall on deaf ears", "where are we") is translated by a phrase or a sentence
# ("tomber dans l'oreille d'un sourd"). Length alone is no test: a one-word head may need a
# long translation (Grenzpolizist: "agent de la police des frontières").
TR_SENTENCE = re.compile(r'[.!?。！？]$')
# A table some editor filled with an example sentence cut into items (would: "ob der Bus
# diesmal zu spät käme.", "Выключите" / "пожалуйста" / "телевизор.", "¿Podría usted ...").
# One such piece spoils every word of that language in that table. "!" is left out
# ("Hallo!" is a translation of hello), and so is a short dotted token ("usw.").
TR_PIECE = re.compile(r'^[¿¡]|\S\s+\S.*[.?。？]$|[^\W\d_]{5,}[.。]$')
# The same item of three or more words under three or more languages is the English
# example the editor left in the table ("We sat on the bench" under fr, de, ru, es, pt).
TR_SHARED_WORDS = 3
TR_SHARED_CODES = 3
# An English usage note in a non-English column ("future tense", "colloquial or regional
# usage", "present tense form is often used"); only checked on words of two or more tokens.
TR_NOTE = re.compile(r'\b(?:tense|used|colloquial|equivalent|expressed|literally)\b')


def tr_item_word(x, t, phrase, affix):
    """The word of one translation item into target t, or None when it is not one. `phrase`:
    the head is more than one word (comment above); `affix`: the head is a prefix or suffix."""
    word = x.get('word')
    if not word or not isinstance(word, str):
        return None
    word = ' '.join(word.split())
    if not phrase and TR_SENTENCE.search(word):
        return None
    if ' ' in word and t != 'en' and TR_NOTE.search(word):
        return None
    if '/' in (word.replace(' /', '', 1) if t == 'zh' else word):
        return None
    # The target's standard language only (R7: Mandarin for zh; Alemannic and Bavarian are
    # not German), and no stray Cyrillic (Dungan) word under zh.
    tags = list(x.get('tags') or []) + list(x.get('raw_tags') or [])
    if C.other_variety(t, tags, x.get('lang')) or (t == 'zh' and C.CYRILLIC.search(word)):
        return None
    # A suffix or prefix translates only a suffix or prefix (fr will: "-ra", "-rons").
    if not affix and (word[:1] == '-' or word[-1:] == '-'):
        return None
    return word


def kaikki_senses_tr(e, code_to_t):
    """({t: (senses, breadth, minor, primary)}, weight) from the entry's translation tables:
    senses is [[word, ...]] per table, breadth the number of languages each table translates
    into, minor the indices of letter/unit/abbreviation tables, primary whether t has words
    for the entry's widest non-minor table; weight is the number of translation items of the
    whole entry, every language and table counted.

    Tables are ordered by how many languages translate them (D-614 R6: the widest table is
    the word's main sense; kaikki attaches tables to senses unevenly, e.g. dog's "male
    canine" sense precedes the 683-language "animal" table), then sense-level before the
    entry-level tables of older dumps, then sense order. Minor tables go last. The weight
    orders a word's entries (parts of speech) against each other in entries.read_tr: need
    has 227 verb items and 175 noun items, so the verb comes first. Primary goes before the
    weight there (D-614 R6): will's verb entry outweighs its noun, but its widest table is
    the modal one, which has no Japanese, Russian or Portuguese row, and what those targets
    have of the verb is the rare "to wish"."""
    groups = {}   # key -> (minor, top-level, sense index, codes, {t: [words]}, {spoilt t})
    weight = 0
    head = str(e.get('word') or '')
    phrase = len(head.split()) > 1
    affix = head[:1] == '-' or head[-1:] == '-'
    shared = {}   # item of TR_SHARED_WORDS+ words -> the language codes it is listed under
    pools = [(-1, None, e.get('translations') or [])]
    for i, sense in enumerate(e.get('senses') or []):
        if sense.get('translations'):
            pools.append((i, sense, sense['translations']))
    for i, sense, items in pools:
        for x in items:
            weight += 1
            label = x.get('sense') or str(x.get('sense_index') or '')
            key = (i, label)
            g = groups.get(key)
            if g is None:
                minor = C.minor_sense(sense if sense is not None else {'glosses': [label]})
                g = groups[key] = (minor, i < 0, i, set(), {}, set())
            code = x.get('lang_code') or x.get('code')
            g[3].add(code)
            raw = ' '.join(x['word'].split()) if isinstance(x.get('word'), str) else ''
            if len(raw.split()) >= TR_SHARED_WORDS:
                shared.setdefault(raw, set()).add(code)
            t = code_to_t.get(code)
            if t and not phrase and TR_PIECE.search(raw):
                g[5].add(t)
            word = tr_item_word(x, t, phrase, affix) if t else None
            if word:
                words = g[4].setdefault(t, [])
                if word not in words:
                    words.append(word)
    order = sorted(groups.values(), key=lambda g: (g[0], -len(g[3]), g[1], g[2]))
    widest = max((len(g[3]) for g in order if not g[0]), default=0)
    out = {}
    for minor, _top, _i, codes, by_t, spoilt in order:
        for t, words in by_t.items():
            words = [w for w in words if len(shared.get(w, ())) < TR_SHARED_CODES]
            if t in spoilt or not words:
                continue
            senses, breadth, mn, primary = out.setdefault(t, ([], [], [], [False]))
            if minor:
                mn.append(len(senses))
            elif len(codes) == widest:
                primary[0] = True
            senses.append(words)
            breadth.append(len(codes))
    return {t: (s, b, mn, p[0]) for t, (s, b, mn, p) in out.items()}, weight


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
    skipped = 0      # lines that are not a JSON object (D-614 L1 N4: counted, not silent)
    with gzip.open(path, 'rt', encoding='utf-8') as f:
        for line in f:
            try:
                e = json.loads(line)
            except ValueError:
                e = None
            if not isinstance(e, dict):
                skipped += 1
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
                by_t, weight = kaikki_senses_tr(e, code_to_t)
                for t, (senses, breadth, mn, primary) in by_t.items():
                    rel = f'tr/{s}-{t}.jsonl'
                    rec = {'w': e['word'], 'pos': e.get('pos') or '', 's': senses,
                           'b': breadth, 'ew': weight}
                    if mn:
                        rec['mn'] = mn
                    if primary:
                        rec['pt'] = 1
                    dump(out(rel), rec)
                    counts[rel] += 1
    for fh in outs.values():
        fh.close()
    counts['skipped:not-json'] = skipped
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
    t0, n, skipped = time.time(), 0, 0
    with gzip.open(path, 'rt', encoding='utf-8') as f, \
            open(os.path.join(norm, 'cedict.jsonl'), 'w', encoding='utf-8') as o:
        for line in f:
            if line.startswith('#'):
                continue
            m = CEDICT_LINE.match(line)
            if not m:
                skipped += 1
                continue
            trad, simp, py, gl = m.groups()
            dump(o, {'s': simp, 't': trad, 'p': pinyin_marks(py), 'g': [g for g in gl.split('/') if g]})
            n += 1
    return 'cedict', {'cedict.jsonl': n, 'skipped:unparsed': skipped}, round(time.time() - t0, 1)


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
    """The iso pairs the packs need, each sorted (a < b)."""
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
    t0, bad = time.time(), 0
    links, want = {}, {}
    for a, b in tatoeba_pairs():
        p, x, y = find_links(data, a, b)
        rows = []
        with bz2.open(p, 'rt', encoding='utf-8') as f:
            for line in f:
                parts = line.rstrip('\n').split('\t')
                if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
                    rows.append((int(parts[0]), int(parts[1])))
                else:
                    bad += 1
        # Written under the sorted pair name (examples.tatoeba_path), whichever way round
        # Tatoeba names its links file (eng-deu, fra-deu, cmn-fra ...).
        if x != a:
            rows = [(j, i) for i, j in rows]
        links[(a, b)] = rows
        want.setdefault(a, set()).update(r[0] for r in rows)
        want.setdefault(b, set()).update(r[1] for r in rows)
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
    counts['skipped:bad-link'] = bad
    return 'tatoeba', counts, round(time.time() - t0, 1)


# ---------------- pronunciation tables and OpenCC ----------------
ARPA = {'AA': 'ɑ', 'AE': 'æ', 'AH': 'ʌ', 'AO': 'ɔ', 'AW': 'aʊ', 'AY': 'aɪ', 'B': 'b', 'CH': 'tʃ',
        'D': 'd', 'DH': 'ð', 'EH': 'ɛ', 'ER': 'ɝ', 'EY': 'eɪ', 'F': 'f', 'G': 'ɡ', 'HH': 'h',
        'IH': 'ɪ', 'IY': 'i', 'JH': 'dʒ', 'K': 'k', 'L': 'l', 'M': 'm', 'N': 'n', 'NG': 'ŋ',
        'OW': 'oʊ', 'OY': 'ɔɪ', 'P': 'p', 'R': 'ɹ', 'S': 's', 'SH': 'ʃ', 'T': 't', 'TH': 'θ',
        'UH': 'ʊ', 'UW': 'u', 'V': 'v', 'W': 'w', 'Y': 'j', 'Z': 'z', 'ZH': 'ʒ'}


def first_variant(ipa):
    """ipa-dict lists variants inside one pair of slashes (`/ðə, ði/`, en_UK) or each in its
    own (`/ˈeɪ/, /ə/`, en_US): keep the first, in exactly one pair of slashes."""
    ipa = ipa.strip()
    slashed = ipa.startswith('/')
    first = ipa.split(',')[0].strip().strip('/').strip()
    return f'/{first}/' if slashed and first else first


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
                ipa = first_variant(ipa)
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
