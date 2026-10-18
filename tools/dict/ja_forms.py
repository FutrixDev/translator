"""Japanese conjugated forms for the `f` table (common taskbook: inflection lookup goes only
through `f`; the fixed table is documented in tools/dict/FORMAT.md).

`classes(pos_codes)` picks the conjugation classes of a JMdict entry from its sense pos codes,
`forms(word, cls)` returns [(form, kind)] for one spelling. Every form is generated from the
dictionary form alone; nothing is looked up.
"""

# Godan rows: dictionary ending -> (a, i, e, o) kana and the te/ta stem ending.
GODAN = {
    'う': ('わ', 'い', 'え', 'お', 'っ'), 'く': ('か', 'き', 'け', 'こ', 'い'),
    'ぐ': ('が', 'ぎ', 'げ', 'ご', 'い'), 'す': ('さ', 'し', 'せ', 'そ', 'し'),
    'つ': ('た', 'ち', 'て', 'と', 'っ'), 'ぬ': ('な', 'に', 'ね', 'の', 'ん'),
    'ぶ': ('ば', 'び', 'べ', 'ぼ', 'ん'), 'む': ('ま', 'み', 'め', 'も', 'ん'),
    'る': ('ら', 'り', 'れ', 'ろ', 'っ'),
}
VOICED_TE = set('ぐぬぶむ')     # te/ta become で/だ
GODAN_CLASSES = {'v5u': 'う', 'v5k': 'く', 'v5g': 'ぐ', 'v5s': 'す', 'v5t': 'つ', 'v5n': 'ぬ',
                 'v5b': 'ぶ', 'v5m': 'む', 'v5r': 'る', 'v5k-s': 'く', 'v5r-i': 'る',
                 'v5u-s': 'う', 'v5aru': 'る', 'vs-c': 'す'}
# Order of preference when an entry lists several classes (the first one present is used).
PREFERENCE = ('v1', 'v1-s', 'v5k-s', 'v5r-i', 'v5u-s', 'v5aru') + tuple(
    c for c in GODAN_CLASSES if c not in ('v5k-s', 'v5r-i', 'v5u-s', 'v5aru')) + (
    'vk', 'vs-s', 'vs-i', 'vz', 'adj-ix', 'adj-i', 'vs')

POLITE = (('ます', 'masu'), ('ました', 'mashita'), ('ません', 'masen'),
          ('ませんでした', 'masendeshita'))


def classes(pos_codes):
    """The conjugation class of an entry (one at most), from all its senses' pos codes."""
    have = set(pos_codes)
    for c in PREFERENCE:
        if c in have:
            return c
    return None


def _verb(stem_i, ta, te, nai_stem, extra):
    """The shared verb rows: polite, past, te, negative, desire, i-stem."""
    out = [(stem_i + s, k) for s, k in POLITE]
    out += [(ta, 'ta'), (te, 'te'), (stem_i + 'たい', 'tai'), (stem_i, 'stem')]
    if nai_stem is not None:
        out += [(nai_stem + 'ない', 'nai'), (nai_stem + 'なかった', 'nakatta')]
    return out + extra


def godan(word, cls):
    end = GODAN_CLASSES[cls]
    if not word.endswith(end) or len(word) < 2:
        return []
    base = word[:-1]
    a, i, e, o, t = GODAN[end]
    if cls == 'v5u-s':
        ta, te = base + 'うた', base + 'うて'
    elif cls == 'v5k-s':
        ta, te = base + 'った', base + 'って'
    elif end in VOICED_TE:
        ta, te = base + t + 'だ', base + t + 'で'
    else:
        ta, te = base + t + 'た', base + t + 'て'
    stem_i = base + ('い' if cls == 'v5aru' else i)
    imperative = base + ('い' if cls == 'v5aru' else e)
    nai_stem = None if cls == 'v5r-i' else base + a
    extra = [(base + e + 'ば', 'ba'), (base + o + 'う', 'volitional'), (imperative, 'imperative')]
    if cls != 'v5r-i':    # ある has no passive or potential in use
        extra = [(base + a + 'れる', 'passive'), (base + e + 'る', 'potential')] + extra
    return _verb(stem_i, ta, te, nai_stem, extra)


def ichidan(word, cls):
    if not word.endswith('る') or len(word) < 2:
        return []
    s = word[:-1]
    extra = [(s + 'られる', 'passive'), (s + 'れる', 'potential'), (s + 'れば', 'ba'),
             (s + 'よう', 'volitional'), (s + ('れ' if cls == 'v1-s' else 'ろ'), 'imperative')]
    return _verb(s, s + 'た', s + 'て', s, extra)


def kuru(word):
    """来る / くる and compounds ending in either (持って来る)."""
    for end, ki, ko, ku in (('来る', '来', '来', '来'), ('くる', 'き', 'こ', 'く')):
        if word.endswith(end):
            b = word[:-len(end)]
            extra = [(b + ko + 'られる', 'passive'), (b + ko + 'れる', 'potential'),
                     (b + ku + 'れば', 'ba'), (b + ko + 'よう', 'volitional'),
                     (b + ko + 'い', 'imperative')]
            return _verb(b + ki, b + ki + 'た', b + ki + 'て', b + ko, extra)
    return []


def suru(base, cls='vs'):
    """Forms of <base>する; vs-s (愛する) negates, passivises and makes its potential on さ/せ."""
    if cls == 'vs-s':
        extra = [(base + 'される', 'passive'), (base + 'せる', 'potential'),
                 (base + 'すれば', 'ba'), (base + 'しよう', 'volitional'),
                 (base + 'せよ', 'imperative')]
        return _verb(base + 'し', base + 'した', base + 'して', base + 'さ', extra)
    extra = [(base + 'される', 'passive'), (base + 'できる', 'potential'),
             (base + 'すれば', 'ba'), (base + 'しよう', 'volitional'),
             (base + 'しろ', 'imperative')]
    out = _verb(base + 'し', base + 'した', base + 'して', base + 'し', extra)
    if cls == 'vs':
        out.append((base + 'する', 'suru'))
    return out


def zuru(word):
    if not word.endswith('ずる') or len(word) < 3:
        return []
    b = word[:-2]
    extra = [(b + 'じられる', 'passive'), (b + 'ずれば', 'ba'), (b + 'じよう', 'volitional'),
             (b + 'じろ', 'imperative')]
    return _verb(b + 'じ', b + 'じた', b + 'じて', b + 'じ', extra)


def adjective(word, cls):
    if cls == 'adj-ix':
        for end, yo in (('いい', 'よ'), ('良い', '良'), ('善い', '善')):
            if word.endswith(end) and len(word) > len(end) - 1:
                s = word[:-len(end)] + yo
                break
        else:
            return []
    else:
        if not word.endswith('い') or len(word) < 2:
            return []
        s = word[:-1]
    return [(s + 'く', 'ku'), (s + 'かった', 'katta'), (s + 'くない', 'kunai'),
            (s + 'くて', 'kute'), (s + 'ければ', 'kereba'), (s + 'くなかった', 'kunakatta')]


def forms(word, cls):
    """[(form, kind)] of one spelling under one conjugation class; [] if it does not fit."""
    if cls in GODAN_CLASSES:
        return godan(word, cls)
    if cls in ('v1', 'v1-s'):
        return ichidan(word, cls)
    if cls == 'vk':
        return kuru(word)
    if cls == 'vs':
        return suru(word, 'vs')
    if cls in ('vs-i', 'vs-s'):
        return suru(word[:-2], cls) if word.endswith('する') and len(word) > 2 else []
    if cls == 'vz':
        return zuru(word)
    if cls in ('adj-i', 'adj-ix'):
        return adjective(word, cls)
    return []


# The kinds shown on the card (`m`), in this order; label text comes from labels.py.
M_KINDS = ('masu', 'ta', 'te', 'nai')
