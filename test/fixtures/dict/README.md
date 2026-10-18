# test/fixtures/dict — es-en excerpt for `test/unit/dict-tools.test.mjs`

A small real excerpt of the normalized data (`build/dict/norm/`) the full build reads, enough
for `tools/dict/pairs.py` to build the es-en pack and `tools/dict/check.py` to check it.
Every row is copied from the full build; nothing is written by hand.

Regenerate (after `npm run dict:build`):

```bash
python3 -I tools/dict/mkfixture.py build/dict/norm build/dict/samples <out> 160
# then replace test/fixtures/dict/{norm,samples} with <out>/{norm,samples}
```

`mkfixture.py` keeps the es-en records of the 160 most frequent Spanish sample tokens, their
translation-table rows, the English IPA of their translation words, and up to 250 Tatoeba
en-es pairs (Spanish side ≤ 40 characters) that contain a kept head. Inflection lists are cut
to the kinds the card shows and the forms those tokens and sentences use; senses to 4
glosses, examples to 1.

## Provenance

Snapshot downloaded 2026-10-13; URLs, sizes and SHA-256 of the source files are in
`tools/dict/sources.json`.

| file | source (sources.json path) | licence |
| --- | --- | --- |
| `norm/kaikki/es-en.jsonl`, `norm/tr/es-en.jsonl`, `norm/kaikki/en-en.jsonl` | Wiktionary via kaikki.org, English edition (`kaikki-en/kaikki.org-dictionary-Spanish.jsonl.gz`, `kaikki-en/kaikki.org-dictionary-English.jsonl.gz`) | CC BY-SA 4.0 |
| `norm/kaikki/es-es.jsonl` | Wiktionary via kaikki.org, Spanish edition (`kaikki-es/es.jsonl.gz`) | CC BY-SA 4.0 |
| `norm/tatoeba/en-es.tsv` | Tatoeba (`tatoeba/eng_sentences`, `spa_sentences`, `eng-spa_links`); ids kept, `https://tatoeba.org/sentences/show/<id>` | CC BY 2.0 FR |
| `norm/ipa/ipadict-en_UK.tsv`, `ipadict-en_US.tsv` | ipa-dict (`ipa-dict/en_UK.txt`, `en_US.txt`) | MIT (`tools/dict/notices/`) |
| `norm/ipa/cmu-en.tsv` | CMUdict (`cmudict/cmudict.dict`), ARPAbet converted to IPA | BSD 2-Clause (`tools/dict/notices/`) |
| `samples/tokens.<lang>.tsv` | the top rows of the reading-rate sample tokens (word frequencies counted on crawled pages, design §2.1): 160 for es, 10 for the others | counts only, no page text |
