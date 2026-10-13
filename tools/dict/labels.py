"""The `m` table (FIELDS.forms): which inflected forms a card shows and what each is called.

`KINDS[src]` lists the kinds in display order with the kaikki tag sets that name each;
ja kinds come from ja_forms.M_KINDS. `LABEL[kind]` gives the label in each of the ten target
languages (order of TARGETS). A kind a pack needs without a label is a build error.
"""

TARGETS = ('en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'de', 'pt', 'ru')


def _t(*tags):
    return tuple(sorted(tags))


_ROMANCE_NOMINAL = [('pl', [_t('plural')]), ('fem', [_t('feminine')]),
                    ('mpl', [_t('masculine', 'plural')]), ('fpl', [_t('feminine', 'plural')])]
_ROMANCE_PRES1 = [_t('first-person', 'indicative', 'present', 'singular'),
                  _t('first-person', 'present', 'singular')]
_ROMANCE_PRET1 = [_t('first-person', 'indicative', 'preterite', 'singular'),
                  _t('first-person', 'preterite', 'singular')]
# kind -> the exact tag sets (sorted tuples) that name it, per source language, in display
# order (at most MAX_FORMS_M are kept). The English edition and a language's own edition tag
# the same form differently (es-en `gerund`, es-es `gerund impersonal`), so a kind may list
# several sets; the first form found for a kind is the one shown.
KINDS = {
    'en': [('pl', [_t('plural')]), ('pres3', [_t('present', 'singular', 'third-person')]),
           ('past', [_t('past')]), ('pp', [_t('participle', 'past')]),
           ('prp', [_t('participle', 'present')]), ('cmp', [_t('comparative')]),
           ('sup', [_t('superlative')])],
    'es': _ROMANCE_NOMINAL + [
        ('pres1', _ROMANCE_PRES1), ('pret1', _ROMANCE_PRET1),
        ('pp', [_t('masculine', 'participle', 'past', 'singular'), _t('participle', 'past'),
                _t('impersonal', 'participle')]),
        ('ger', [_t('gerund'), _t('gerund', 'impersonal')])],
    'pt': _ROMANCE_NOMINAL + [
        ('pres1', _ROMANCE_PRES1), ('pret1', _ROMANCE_PRET1),
        ('pp', [_t('participle', 'past'), _t('participle')]), ('ger', [_t('gerund')])],
    'fr': _ROMANCE_NOMINAL + [
        ('pres1', [_t('first-person', 'indicative', 'present', 'singular')]),
        ('fut1', [_t('first-person', 'future', 'indicative', 'singular')]),
        ('pp', [_t('participle', 'past')]),
        ('prp', [_t('gerund', 'participle', 'present'), _t('participle', 'present')])],
    'de': [('gen', [_t('genitive'), _t('genitive', 'singular')]), ('pl', [_t('plural')]),
           ('pres3', [_t('present', 'singular', 'third-person'),
                      _t('indicative', 'present', 'singular', 'third-person')]),
           ('past', [_t('past'), _t('first-person', 'indicative', 'preterite', 'singular')]),
           ('pp', [_t('participle', 'past')]), ('cmp', [_t('comparative')]),
           ('sup', [_t('superlative')])],
    'ru': [('gen_sg', [_t('genitive', 'singular')]), ('nom_pl', [_t('nominative', 'plural')]),
           ('gen_pl', [_t('genitive', 'plural')]),
           ('pres1', [_t('first-person', 'present', 'singular')]),
           ('fut1', [_t('first-person', 'future', 'singular')]),
           ('pres3', [_t('present', 'singular', 'third-person')]),
           ('past_m', [_t('masculine', 'past', 'singular')]),
           ('past_f', [_t('feminine', 'past', 'singular')]),
           ('imp2', [_t('imperative', 'second-person', 'singular')]),
           ('cmp', [_t('comparative')])],
    'ko': [('ko_polite', [_t('indicative', 'informal', 'non-past', 'polite')]),
           ('ko_formal', [_t('formal', 'indicative', 'non-past', 'polite')]),
           ('ko_past', [_t('formal', 'indicative', 'past')]),
           ('ko_and', [_t('conjunctive', 'formal')]), ('ko_if', [_t('conditional', 'formal')])],
}

#          en                    zh-CN           zh-TW           ja              ko
#          es                    fr                      de                pt                ru
LABEL = {
    'pl': ('plural', '复数', '複數', '複数形', '복수',
           'plural', 'pluriel', 'Plural', 'plural', 'мн. ч.'),
    'fem': ('feminine', '阴性', '陰性', '女性形', '여성형',
            'femenino', 'féminin', 'Femininum', 'feminino', 'ж. р.'),
    'mpl': ('masculine plural', '阳性复数', '陽性複數', '男性複数形', '남성 복수',
            'masculino plural', 'masculin pluriel', 'Maskulinum Plural', 'masculino plural',
            'м. р. мн. ч.'),
    'fpl': ('feminine plural', '阴性复数', '陰性複數', '女性複数形', '여성 복수',
            'femenino plural', 'féminin pluriel', 'Femininum Plural', 'feminino plural',
            'ж. р. мн. ч.'),
    'gen': ('genitive', '属格', '屬格', '属格', '속격',
            'genitivo', 'génitif', 'Genitiv', 'genitivo', 'род. п.'),
    'gen_sg': ('genitive singular', '单数属格', '單數屬格', '単数属格', '단수 속격',
               'genitivo singular', 'génitif singulier', 'Genitiv Singular', 'genitivo singular',
               'род. п. ед. ч.'),
    'nom_pl': ('nominative plural', '复数主格', '複數主格', '複数主格', '복수 주격',
               'nominativo plural', 'nominatif pluriel', 'Nominativ Plural',
               'nominativo plural', 'им. п. мн. ч.'),
    'gen_pl': ('genitive plural', '复数属格', '複數屬格', '複数属格', '복수 속격',
               'genitivo plural', 'génitif pluriel', 'Genitiv Plural', 'genitivo plural',
               'род. п. мн. ч.'),
    'pres1': ('present, 1st person singular', '现在时第一人称单数', '現在式第一人稱單數',
              '現在・一人称単数', '현재 1인칭 단수',
              'presente, 1.ª persona singular', 'présent, 1re personne du singulier',
              'Präsens, 1. Person Singular', 'presente, 1.ª pessoa do singular',
              'наст. вр., 1 л. ед. ч.'),
    'pres3': ('present, 3rd person singular', '现在时第三人称单数', '現在式第三人稱單數',
              '現在・三人称単数', '현재 3인칭 단수',
              'presente, 3.ª persona singular', 'présent, 3e personne du singulier',
              'Präsens, 3. Person Singular', 'presente, 3.ª pessoa do singular',
              'наст. вр., 3 л. ед. ч.'),
    'fut1': ('future, 1st person singular', '将来时第一人称单数', '未來式第一人稱單數',
             '未来・一人称単数', '미래 1인칭 단수',
             'futuro, 1.ª persona singular', 'futur, 1re personne du singulier',
             'Futur, 1. Person Singular', 'futuro, 1.ª pessoa do singular',
             'буд. вр., 1 л. ед. ч.'),
    'past': ('past tense', '过去式', '過去式', '過去形', '과거형',
             'pasado', 'passé', 'Präteritum', 'passado', 'прош. вр.'),
    'pret1': ('preterite, 1st person singular', '过去时第一人称单数', '過去式第一人稱單數',
              '過去・一人称単数', '과거 1인칭 단수',
              'pretérito, 1.ª persona singular', 'passé simple, 1re personne du singulier',
              'Präteritum, 1. Person Singular', 'pretérito, 1.ª pessoa do singular',
              'прош. вр., 1 л. ед. ч.'),
    'past_m': ('past, masculine', '过去时阳性', '過去式陽性', '過去・男性', '과거 남성',
               'pasado, masculino', 'passé, masculin', 'Präteritum, Maskulinum',
               'passado, masculino', 'прош. вр., м. р.'),
    'past_f': ('past, feminine', '过去时阴性', '過去式陰性', '過去・女性', '과거 여성',
               'pasado, femenino', 'passé, féminin', 'Präteritum, Femininum',
               'passado, feminino', 'прош. вр., ж. р.'),
    'pp': ('past participle', '过去分词', '過去分詞', '過去分詞', '과거분사',
           'participio', 'participe passé', 'Partizip II', 'particípio passado',
           'прич. прош. вр.'),
    'prp': ('present participle', '现在分词', '現在分詞', '現在分詞', '현재분사',
            'participio presente', 'participe présent', 'Partizip I', 'particípio presente',
            'прич. наст. вр.'),
    'ger': ('gerund', '副动词', '副動詞', '動名詞', '동명사',
            'gerundio', 'gérondif', 'Gerundium', 'gerúndio', 'деепричастие'),
    'imp2': ('imperative', '命令式', '命令式', '命令形', '명령형',
             'imperativo', 'impératif', 'Imperativ', 'imperativo', 'повел. накл.'),
    'cmp': ('comparative', '比较级', '比較級', '比較級', '비교급',
            'comparativo', 'comparatif', 'Komparativ', 'comparativo', 'сравн. ст.'),
    'sup': ('superlative', '最高级', '最高級', '最上級', '최상급',
            'superlativo', 'superlatif', 'Superlativ', 'superlativo', 'превосх. ст.'),
    # Japanese (ja_forms.M_KINDS)
    'masu': ('polite (-masu)', '礼貌形（ます形）', '禮貌形（ます形）', 'ます形', '정중형 (ます)',
             'forma cortés (-masu)', 'forme polie (-masu)', 'Höflichkeitsform (-masu)',
             'forma polida (-masu)', 'вежливая форма (-масу)'),
    'ta': ('past (-ta)', '过去形（た形）', '過去形（た形）', 'た形', '과거형 (た)',
           'pasado (-ta)', 'passé (-ta)', 'Vergangenheit (-ta)', 'passado (-ta)',
           'прошедшее (-та)'),
    'te': ('te-form', '连接形（て形）', '連接形（て形）', 'て形', '연결형 (て)',
           'forma -te', 'forme en -te', 'te-Form', 'forma -te', 'форма на -тэ'),
    'nai': ('negative (-nai)', '否定形（ない形）', '否定形（ない形）', 'ない形', '부정형 (ない)',
            'negativo (-nai)', 'négatif (-nai)', 'Verneinung (-nai)', 'negativo (-nai)',
            'отрицание (-най)'),
    # Korean
    'ko_polite': ('polite (-yo)', '敬语（-요）', '敬語（-요）', '丁寧形（-요）', '해요체',
                  'cortés (-yo)', 'poli (-yo)', 'höflich (-yo)', 'polido (-yo)',
                  'вежливая (-ё)'),
    'ko_formal': ('formal polite (-mnida)', '正式敬语（-니다）', '正式敬語（-니다）',
                  '格式丁寧形（-니다）', '합쇼체', 'formal (-mnida)', 'formel (-mnida)',
                  'förmlich (-mnida)', 'formal (-mnida)', 'официальная (-мнида)'),
    'ko_past': ('past', '过去式', '過去式', '過去形', '과거형',
                'pasado', 'passé', 'Vergangenheit', 'passado', 'прош. вр.'),
    'ko_and': ('and (-go)', '连接（-고）', '連接（-고）', '接続（-고）', '연결 (-고)',
               'y (-go)', 'et (-go)', 'und (-go)', 'e (-go)', 'и (-го)'),
    'ko_if': ('if (-myeon)', '条件（-면）', '條件（-면）', '条件（-면）', '조건 (-면)',
              'si (-myeon)', 'si (-myeon)', 'wenn (-myeon)', 'se (-myeon)', 'если (-мён)'),
}

for _k, _v in LABEL.items():
    if len(_v) != len(TARGETS):
        raise AssertionError(f'label row {_k} has {len(_v)} entries, want {len(TARGETS)}')


def label(kind, tgt):
    """The label of `kind` in pack target language `tgt` (raises KeyError when missing)."""
    return LABEL[kind][TARGETS.index(tgt)]


def kind_table(src_iso):
    """{tag tuple: (rank, kind)} for one source language ({} when it has no kaikki kinds)."""
    return {tags: (i, kind) for i, (kind, sets) in enumerate(KINDS.get(src_iso, ()))
            for tags in sets}
