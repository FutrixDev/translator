// 「这一段已经是母语了，不用翻」—— 主体是母语、夹着几个外文名词的正文也算。
//
// 整段交给 chrome.i18n.detectLanguage 判不出来：中文技术文章满是英文名词，检测器
// 在这种句子上的置信度掉到 55、64，甚至答 kk、ja（下面 FAKE_CLD 的混排一档就是
// 真实 Chrome 的实测读数）。所以先按句拆开、把外文名词摘掉，再问剩下的正文；
// 有成句的外文就照译。翻译单位仍是整段，按句只是判定的单位。
//
// 这一份守三件事：
//   1. splitForeignTerms 的拆法（纯函数，shared/lang-tags.js）；
//   2. 整页翻译的预筛 filterBlocksByLanguage 真的按摘过名词的正文去问检测器；
//   3. 一段母语后面跟着一整句外文时，这一段照译 —— 哪怕那句外文在第 400 个字之后；
//   4. 同一种字母写的外文句子（法文段落里的一句英文）一句句问检测器，只采信有把握
//      的读数，只问够长的句子，中文摘过名词的碎片不这样问。
import test from 'node:test';
import assert from 'node:assert/strict';

await import('../../shared/lang-tags.js');
await import('../../shared/text-markers.js');
const L = globalThis.LangTags;

// ==================== splitForeignTerms ====================

const ZH_WITH_TERMS = [
  '我最近在用 React Server Components 和 Next.js App Router 重写博客，SSR 的性能提升很明显。',
  '这个 bug 是 TypeScript 的 strictNullChecks 引起的。',
  'OpenAI 发布了 GPT-5，Anthropic 的 Claude 也更新了。',
  '用 kubectl apply -f deployment.yaml 部署到 Kubernetes 集群。',
  'iPhone 17 Pro Max 评测：A19 Pro 芯片、ProMotion 屏幕。',
  'Apple 宣布 WWDC 2026 将于 6 月举行',
  '我们在 Hacker News 上看到一篇关于 Rust async runtime 的文章，作者对比了 tokio、async-std 和 smol 三个库的 benchmark。',
  '今天发布新版本。Enjoy!',
];

test('中文正文夹英文名词：名词摘掉，不算成句的外文', () => {
  for (const text of ZH_WITH_TERMS) {
    const { residue, foreign } = L.splitForeignTerms(text, 'zh-CN');
    assert.equal(foreign, false, `「${text}」被当成了成句的外文`);
    assert.ok(!/\p{Script=Latin}/u.test(residue), `「${text}」摘完还剩拉丁字母：${residue}`);
    assert.ok(/\p{Script=Han}/u.test(residue), `「${text}」的正文被摘空了`);
  }
});

test('有成句的外文就得译：夹一整句、长从句、或外文压过母语', () => {
  const cases = [
    // 一整句英文夹在两句中文中间。
    '今天天气很好。I went to the park with my friends and we had a great picnic by the lake. 然后回家了。',
    // 一句中文里夹着超过 TERM_MAX_WORDS 个词的英文从句（母语够长，比例那一条拦不住它）。
    '我们今天开会讨论了下一季度的产品规划和团队分工，他最后说 we should ship it before the end of March 然后散会了。',
    // 一句夹了个中文词的英文：外文词数是母语的三倍。
    'We use 微服务 architecture for our backend.',
  ];
  for (const text of cases) {
    assert.equal(L.splitForeignTerms(text, 'zh-CN').foreign, true, `「${text}」该译`);
  }
  // 整段英文：中文写不成拉丁字母，整段是外文，不问检测器。
  assert.deepEqual(
    L.splitForeignTerms('The quick brown fox jumps over the lazy dog.', 'zh-CN'),
    { residue: '', foreign: true, sentences: [] },
  );
});

test('母语站在哪一边看这段文字：拉丁字母写的塞尔维亚语不被摘空', () => {
  // sr 按 Intl 补全是西里尔；只按默认文字摘，这一句整句被当外文。
  assert.deepEqual(
    L.splitForeignTerms('Ovo je tekst na srpskom jeziku.', 'sr'),
    { residue: 'Ovo je tekst na srpskom jeziku.', foreign: false, sentences: [] },
  );
  // 西里尔写的照旧按非拉丁轴摘英文名词。
  assert.deepEqual(
    L.splitForeignTerms('Ово је чланак о React Server Components.', 'sr'),
    { residue: 'Ово је чланак о .', foreign: false, sentences: [] },
  );
  // 反方向同理：uz 按 Intl 补全是拉丁，西里尔写的乌兹别克语照样摘英文名词。
  assert.deepEqual(
    L.splitForeignTerms('Бу мақола React ҳақида.', 'uz'),
    { residue: 'Бу мақола ҳақида.', foreign: false, sentences: [] },
  );
  // 拼音、转写俄文也是：检测器会答 zh-Latn / ru-Latn，不能拿去问。
  assert.equal(L.splitForeignTerms('Wo men jin tian qu gong yuan wan.', 'zh-CN').foreign, true);
  assert.equal(L.splitForeignTerms('Privet, kak dela u tebya segodnya?', 'ru').foreign, true);
});

test('摘的轴是拉丁 / 非拉丁：假名和谚文不当外文名词摘', () => {
  // 摘了假名剩一串汉字，日文段落就成了「本来就是中文」。
  assert.equal(L.splitForeignTerms('東京の天気は晴れです。', 'zh-CN').residue, '東京の天気は晴れです。');
  assert.equal(L.splitForeignTerms('오늘 날씨가 좋습니다.', 'zh-CN').residue, '오늘 날씨가 좋습니다.');
  assert.equal(L.isHanOnly('東京の天気'), false);
  assert.equal(L.isHanOnly('使用'), true);
  assert.equal(L.isHanOnly('2026 年 6 月'), true);
  assert.equal(L.isHanOnly('2026'), false);
});

test('目标是拉丁语言时反过来：摘的是非拉丁的名词', () => {
  assert.deepEqual(
    L.splitForeignTerms('We use 微服务 architecture for our backend.', 'en'),
    { residue: 'We use architecture for our backend.', foreign: false, sentences: [] },
  );
  // 主体是中文的一段，对英文读者是成句的外文。
  assert.equal(L.splitForeignTerms('我们在 Hacker News 上看到一篇关于 Rust 的文章。', 'en').foreign, true);
});

test('母语在拉丁那一边时，给出值得一句句问检测器的句子', () => {
  const block = 'Ceci est une phrase en français. This is a complete English sentence that should be translated. Encore une phrase.';
  // 拆字看不见那句英文：同一种字母。
  const split = L.splitForeignTerms(block, 'fr');
  assert.equal(split.foreign, false);
  assert.equal(split.residue, block);
  // 不长过 TERM_MAX_WORDS（6）个词的句子不给：检测器在那上面只是在猜。
  assert.deepEqual(split.sentences, ['This is a complete English sentence that should be translated.']);
  // 给的是摘过非拉丁名词的那一句。
  assert.deepEqual(
    L.splitForeignTerms('We use 微服务 architecture for our backend services every day.', 'en').sentences,
    ['We use architecture for our backend services every day.'],
  );
  // 母语不在拉丁那一边：摘过名词的中文是碎片，一句也不给。
  const zh = '我最近在用 React Server Components 和 Next.js App Router 重写博客，SSR 的性能提升很明显。这个 bug 是 TypeScript 的 strictNullChecks 引起的，改完以后编译就通过了。';
  assert.deepEqual(L.splitForeignTerms(zh, 'zh-CN').sentences, []);
});

test('检测器分不开塞尔维亚语、克罗地亚语、波斯尼亚语', () => {
  for (const [detected, target] of [['bs', 'sr'], ['hr', 'sr'], ['sr', 'hr'], ['bs', 'sr-Latn'], ['sh', 'bs'], ['en', 'en-GB'], ['zh', 'zh-TW']]) {
    assert.equal(L.isDetectedAsLanguage(detected, target), true, `${detected} → ${target}`);
  }
  // 斯洛文尼亚语是另一门语言；简繁仍是两套字。
  for (const [detected, target] of [['sl', 'sr'], ['mk', 'sr'], ['zh-Hant', 'zh-CN'], ['en', 'fr'], [null, 'sr'], ['sr', '']]) {
    assert.equal(L.isDetectedAsLanguage(detected, target), false, `${detected} → ${target}`);
  }
  // 作者写的标签照旧按字面比。
  assert.equal(L.isSameLanguage('bs', 'sr'), false);
});

// ==================== 整页翻译的预筛 ====================

// 假的 chrome.i18n.detectLanguage。混排一档是真实 Chrome 对整段的实测：中英混排
// 的中文技术句子只给 zh:55 且 isReliable:false —— 不摘名词就判不成中文。
//
// 纯拉丁的那几档按句子查表，表里是 e2e 那个 Chrome 的实测读数（isReliable 用 R / u
// 记）：法文、塞尔维亚语、英文句子在九个词上下才开始有把握；拉丁字母写的塞尔维亚语
// 答 bs。
const MEASURED = new Map([
  ['Ceci est une phrase en français. This is a complete English sentence that should be translated. Encore une phrase.', 'R fr'],
  ['This is a complete English sentence that should be translated.', 'R en'],
  ['Ceci est une phrase en français.', 'u fr'],
  ['Encore une phrase.', 'u it'],
  ["Nous avons publié une nouvelle version de l'application mobile ce matin. Read the full story on our website. La réunion de demain est reportée à la semaine prochaine pour des raisons de planning.", 'R fr'],
  ["Nous avons publié une nouvelle version de l'application mobile ce matin.", 'R fr'],
  ['Read the full story on our website.', 'u en'],
  ['La réunion de demain est reportée à la semaine prochaine pour des raisons de planning.', 'R fr'],
  ['Le weekend dernier, nous avons fait du shopping au centre commercial avec des amis. I went to the park with my friends yesterday.', 'R fr'],
  ['Le weekend dernier, nous avons fait du shopping au centre commercial avec des amis.', 'R fr'],
  ['I went to the park with my friends yesterday.', 'u en'],
  ['Danas je lep dan i idemo u park sa decom i prijateljima. Ovo je tekst na srpskom jeziku koji treba da ostane netaknut.', 'R bs'],
  ['Danas je lep dan i idemo u park sa decom i prijateljima.', 'R bs'],
  ['Ovo je tekst na srpskom jeziku koji treba da ostane netaknut.', 'R bs'],
  ['Danas je lep dan i idemo u park sa decom i prijateljima. Hrvatska vlada je danas predstavila novi plan za gospodarstvo.', 'R bs'],
  ['Hrvatska vlada je danas predstavila novi plan za gospodarstvo.', 'R sl'],
  ['Please read the documentation carefully before you open an issue. We are hiring engineers who love working on hard problems.', 'R en'],
]);
const asked = [];
function fakeCld(text) {
  const has = (re) => re.test(text);
  const measured = MEASURED.get(text);
  if (measured) {
    const [reliable, language] = measured.split(' ');
    return { isReliable: reliable === 'R', languages: [{ language, percentage: 100 }] };
  }
  // 摘过名词的短正文，检测器照例答 isReliable:false，语言却是对的（实测）。
  if (has(/\p{Script=Hiragana}|\p{Script=Katakana}/u)) return { isReliable: false, languages: [{ language: 'ja', percentage: 100 }] };
  if (has(/\p{Script=Hangul}/u)) return { isReliable: true, languages: [{ language: 'ko', percentage: 100 }] };
  // 不是拉丁字母的外文不摘（摘的轴是拉丁 / 非拉丁），检测器在这种混排上同样没把握。
  if (has(/\p{Script=Han}/u) && has(/\p{Script=Cyrillic}/u)) return { isReliable: false, languages: [{ language: 'zh', percentage: 60 }] };
  if (has(/\p{Script=Han}/u) && has(/\p{Script=Latin}/u)) return { isReliable: false, languages: [{ language: 'zh', percentage: 55 }] };
  if (has(/\p{Script=Han}/u)) return { isReliable: false, languages: [{ language: 'zh', percentage: 100 }] };
  // 纯拉丁的短文本检测器基本在猜（实测 hello→sr），它自己也说没把握。
  if (text.split(/\s+/).length < 3) return { isReliable: false, languages: [{ language: 'en', percentage: 90 }] };
  return { isReliable: true, languages: [{ language: 'en', percentage: 99 }] };
}

globalThis.chrome = {
  i18n: {
    detectLanguage(text, callback) {
      asked.push(text);
      callback(fakeCld(text));
    },
  },
};
globalThis.document = {};
globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
let target = 'zh-CN';
globalThis.window = {
  AI_TRANSLATOR_CONTENT: {
    settings: { skipTargetLanguageText: true },
    state: {},
    t: (key) => key,
    isExtensionContextAvailable: () => true,
    isExtensionContextInvalidated: () => false,
  },
};
// 语言那几个 ctx.x 用真的 content-language.js 挂：maxChars 这一条要守的正是它的
// getLanguageDetectionText。目标语言换成测试自己的，batch.js 在加载时取走它。
await import('../../content/content-language.js');
const ctx = globalThis.window.AI_TRANSLATOR_CONTENT;
ctx.getEffectiveTargetLang = () => target;
await import('../../content/page/batch.js');

async function translated(texts) {
  const blocks = texts.map((text) => ({ text }));
  return (await ctx.filterBlocksByLanguage(blocks)).map((block) => block.text);
}

test('主体是中文、夹英文名词的段落不翻；成句的外文照翻', async () => {
  target = 'zh-CN';
  const foreign = [
    '今天天气很好。I went to the park with my friends and we had a great picnic by the lake. 然后回家了。',
    'We use 微服务 architecture for our backend.',
    '東京の天気は晴れです。',
    '오늘 날씨가 좋습니다.',
    'The quick brown fox jumps over the lazy dog.',
    // 繁体对简体的目标：同是 zh，书写系统不同，用户要的就是这一次转换。
    '這個網站說的話，後面還有很多繁體的字。',
    // 置信度不到门槛就不算「已经是母语」：宁可多译一段。
    '这是 Красная площадь 的照片。',
  ];
  assert.deepEqual(await translated([...ZH_WITH_TERMS, ...foreign]), foreign);
});

test('检测器问的是摘过名词的正文，只有汉字的正文不问', async () => {
  target = 'zh-CN';
  asked.length = 0;
  assert.deepEqual(await translated(['这个 bug 是 TypeScript 的 strictNullChecks 引起的。', '使用 Docker']), []);
  // 只有汉字的正文直接按中文算（检测器在「使用」上答 ja:100），一次都不问。
  assert.deepEqual(asked, []);

  asked.length = 0;
  assert.deepEqual(await translated(['用 kubectl 部署，然后看 ログ。']), ['用 kubectl 部署，然后看 ログ。']);
  assert.equal(asked.length, 1);
  assert.ok(!/\p{Script=Latin}/u.test(asked[0]), `问检测器的还带着外文名词：${asked[0]}`);
});

test('成句的外文在第 400 个字之后也算：判定看完整一段', async () => {
  target = 'zh-CN';
  const head = '这是一段很长的中文正文，讲的是部署流程里的每一个步骤。'.repeat(20);
  assert.ok(head.length > 400);
  const block = `${head}After that, the whole cluster restarts and every pod is rescheduled onto new nodes.`;
  assert.deepEqual(await translated([block]), [block]);
});

test('目标是日文：日文正文夹英文名词不翻，检测器说没把握也采信（字母体系本身是证据）', async () => {
  target = 'ja';
  const zh = '这个 bug 是 TypeScript 的 strictNullChecks 引起的。';
  assert.deepEqual(await translated(['この bug は TypeScript の strictNullChecks が原因です。', zh]), [zh]);
});

test('目标是英文：英文正文夹中文名词不翻，中文正文翻', async () => {
  target = 'en';
  const zh = '我们在 Hacker News 上看到一篇关于 Rust 的文章。';
  assert.deepEqual(await translated(['We use 微服务 architecture for our backend.', zh]), [zh]);
  // 纯拉丁的剩余正文要检测器自己说有把握；没把握就照译（这道门只放非拉丁的字）。
  assert.deepEqual(await translated(['Hi there']), ['Hi there']);
});

// ==================== 同一种字母写的外文句子 ====================

const FR_WITH_EN = 'Ceci est une phrase en français. This is a complete English sentence that should be translated. Encore une phrase.';

test('法文段落里夹一整句英文：整段读成 fr，那句英文一句问出来，这一段照译', async () => {
  target = 'fr';
  asked.length = 0;
  assert.deepEqual(await translated([FR_WITH_EN]), [FR_WITH_EN]);
  // 整段一次、那句英文一次；不到七个词的两句法文不问。
  assert.deepEqual(asked, [FR_WITH_EN, 'This is a complete English sentence that should be translated.']);
});

test('检测器对那一句没把握，就不算外文：这一段仍是母语', async () => {
  target = 'fr';
  const blocks = [
    // 七个词，过了下限，检测器答 en 但 isReliable:false（实测）。
    "Nous avons publié une nouvelle version de l'application mobile ce matin. Read the full story on our website. La réunion de demain est reportée à la semaine prochaine pour des raisons de planning.",
    // 九个词，也还没把握（实测）。
    'Le weekend dernier, nous avons fait du shopping au centre commercial avec des amis. I went to the park with my friends yesterday.',
  ];
  asked.length = 0;
  assert.deepEqual(await translated(blocks), []);
  // 每一段都真的一句句问过了 —— 跳过是因为读数没把握，不是没问。
  assert.ok(asked.includes('Read the full story on our website.'), asked.join('\n'));
  assert.ok(asked.includes('I went to the park with my friends yesterday.'), asked.join('\n'));
});

test('整段已经判成外文就不再一句句问；整段只有一句时不问第二遍', async () => {
  target = 'fr';
  asked.length = 0;
  const english = 'Please read the documentation carefully before you open an issue. We are hiring engineers who love working on hard problems.';
  assert.deepEqual(await translated([english]), [english]);
  assert.deepEqual(asked, [english]);

  target = 'en';
  asked.length = 0;
  assert.deepEqual(await translated(['This is a complete English sentence that should be translated.']), []);
  assert.deepEqual(asked, ['This is a complete English sentence that should be translated.']);
});

test('塞尔维亚语答成 bs 不算外文；一句读成 sl 的照译', async () => {
  // 拉丁写的塞尔维亚语检测器读 bs：目标 sr 和 hr 都得认它是自己人。
  const serbian = 'Danas je lep dan i idemo u park sa decom i prijateljima. Ovo je tekst na srpskom jeziku koji treba da ostane netaknut.';
  const withSl = 'Danas je lep dan i idemo u park sa decom i prijateljima. Hrvatska vlada je danas predstavila novi plan za gospodarstvo.';
  for (const lang of ['sr', 'hr']) {
    target = lang;
    asked.length = 0;
    assert.deepEqual(await translated([serbian, withSl]), [withSl], lang);
    // 塞尔维亚语那一段两句都问过，答 bs 都放过了。
    assert.ok(asked.includes('Ovo je tekst na srpskom jeziku koji treba da ostane netaknut.'), asked.join('\n'));
  }
});
