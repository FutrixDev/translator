"""OpenCC conversion from the project's own dictionary files (no OpenCC binary).

t2s  : Traditional -> Simplified (TSPhrases + TSCharacters), used to fold Chinese glosses
       and example translations to zh-CN.
s2twp: Simplified -> Traditional (Taiwan, with phrases), the chain of OpenCC's
       s2twp.json: (STPhrases + STCharacters) -> TWPhrases -> TWVariants. zh-TW targets are
       built as s2twp(t2s(text)) from the zh-CN content.

Each step is forward maximum matching over one merged table; the first value of a key wins,
as OpenCC does for a key with several candidates.
"""
import os

T2S_FILES = (('TSPhrases.txt', 'TSCharacters.txt'),)
S2TWP_FILES = (('STPhrases.txt', 'STCharacters.txt'), ('TWPhrases.txt',), ('TWVariants.txt',))
OPENCC_FILES = sorted({f for step in T2S_FILES + S2TWP_FILES for f in step})


def load_table(path, out):
    with open(path, encoding='utf-8') as f:
        for line in f:
            if line.startswith('#') or '\t' not in line:
                continue
            k, v = line.rstrip('\n').split('\t', 1)
            if k and k not in out:
                out[k] = v.split(' ')[0]


class Step:
    def __init__(self, table):
        self.table = table
        self.maxlen = max((len(k) for k in table), default=1)

    def __call__(self, s):
        out, i, n, tab = [], 0, len(s), self.table
        while i < n:
            for size in range(min(self.maxlen, n - i), 0, -1):
                v = tab.get(s[i:i + size])
                if v is not None:
                    out.append(v)
                    i += size
                    break
            else:
                out.append(s[i])
                i += 1
        return ''.join(out)


class Converter:
    def __init__(self, opencc_dir, steps):
        self.steps = []
        for files in steps:
            table = {}
            for name in files:
                load_table(os.path.join(opencc_dir, name), table)
            self.steps.append(Step(table))
        self.cache = {}

    def __call__(self, s):
        if not s:
            return s
        hit = self.cache.get(s)
        if hit is None:
            hit = s
            for step in self.steps:
                hit = step(hit)
            if len(self.cache) < 2_000_000:
                self.cache[s] = hit
        return hit


def t2s(opencc_dir):
    return Converter(opencc_dir, T2S_FILES)


def s2twp(opencc_dir):
    return Converter(opencc_dir, S2TWP_FILES)
