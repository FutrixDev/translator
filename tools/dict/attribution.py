"""LICENSE.txt and ATTRIBUTION.txt of one pack directory (D-570).

ATTRIBUTION.txt names only the datasets the pack used: each with its URL, licence and the
extraction date, the statement that the entries were selected, reordered and merged, how a
Tatoeba sentence id is looked up, and the full notices the MIT (ipa-dict), BSD (CMUdict) and
Apache 2.0 (OpenCC) licences ask to travel with the data. The notice texts are kept verbatim in
tools/dict/notices/ so a build never reads a licence out of the downloaded (untrusted) data.
"""
import os
import shutil

import common as C

HERE = os.path.dirname(os.path.abspath(__file__))
NOTICES = os.path.join(HERE, 'notices')
EXTRACTED = '2026-10-13'
TATOEBA_SHOW = 'https://tatoeba.org/sentences/show/<id>'

# What each dataset contributed, in the words ATTRIBUTION.txt uses.
ROLE = {
    'wiktionary': 'headwords, senses, translations, inflected forms, IPA and example sentences '
                  '(Wiktionary content as extracted by kaikki.org / wiktextract)',
    'cedict': 'Chinese headwords, English glosses, pinyin and Traditional spellings',
    'jmdict': 'Japanese headwords, English glosses, kana readings and the conjugation classes '
              'the inflected forms are generated from',
    'tatoeba': 'example sentence pairs translated by people',
    'ipadict': 'IPA pronunciations',
    'cmudict': 'English pronunciations (ARPAbet, converted to IPA)',
    'opencc': 'Simplified/Traditional Chinese conversion tables',
}
NOTICE_FILE = {
    'ipadict': ('ipa-dict (MIT License)', 'ipa-dict.MIT.txt'),
    'cmudict': ('CMUdict (BSD 2-Clause License)', 'cmudict.BSD.txt'),
    'opencc': ('OpenCC (Apache License 2.0), Copyright (c) Carbo Kuo (BYVoid) and contributors',
               'opencc.Apache-2.0.txt'),
}


def text(src, tgt, ver, used):
    rows = C.sources_rows(used)
    out = [
        f'Blab Translation offline dictionary pack {C.pack_name(src, tgt)}, version {ver}',
        '',
        'This pack is licensed under the Creative Commons Attribution-ShareAlike 4.0',
        'International licence (CC BY-SA 4.0); the full text is in LICENSE.txt.',
        '',
        'It is a derived work. Its entries were selected, filtered, reordered and merged from',
        f'the datasets below, extracted on {EXTRACTED}; glosses were shortened, Chinese text was',
        'converted between Simplified and Traditional script, and inflected forms and readings',
        'were attached to the entries they belong to. No dataset was used unmodified.',
        '',
        'Sources:',
    ]
    for r in rows:
        out += [f'- {r["name"]}', f'  {r["url"]}', f'  Licence: {r["license"]}',
                f'  Extracted: {EXTRACTED}', f'  Used for: {ROLE[r["id"]]}']
    if 'tatoeba' in used:
        out += ['', 'Tatoeba sentences keep their ids: an example row carries the id of its source',
                'sentence and of its translation, and either sentence (with its author and',
                f'history) can be looked up at {TATOEBA_SHOW}.']
    if 'jmdict' in used:
        out += ['', 'JMdict is the property of the Electronic Dictionary Research and Development',
                'Group (EDRDG) and is used in conformance with the Group\'s licence:',
                'https://www.edrdg.org/edrdg/licence.html']
    for sid in C.SOURCE_ORDER:
        if sid in used and sid in NOTICE_FILE:
            title, fname = NOTICE_FILE[sid]
            with open(os.path.join(NOTICES, fname), encoding='utf-8') as f:
                body = f.read().rstrip('\n')
            out += ['', '=' * 72, f'Notice for {title}', '=' * 72, '', body]
    return '\n'.join(out) + '\n'


def write(pack_dir, src, tgt, ver, used, license_path):
    shutil.copyfile(license_path, os.path.join(pack_dir, 'LICENSE.txt'))
    with open(os.path.join(pack_dir, 'ATTRIBUTION.txt'), 'w', encoding='utf-8') as f:
        f.write(text(src, tgt, ver, used))
