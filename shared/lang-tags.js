// Blab Translation —— 语言标签的一个主人。
//
// 「这两门语言是同一门吗」在这个扩展里被问了四次，从四个完全不同的地方：字幕
// 引擎问声道语言和目标语言，整页翻译问某一段正文和目标语言，自动翻译的决策层
// 问页面语言和目标语言，界面层问该把哪个选项标成选中。四处各写一遍的结果不是
// 「四份一样的代码」，是**同一对语言在不同地方得到不同答案**——而这种不一致
// 只会以「有时候翻、有时候不翻」的形式被用户看见，没有报错，没有日志。
//
// 所以这里是那一问的唯一出处。它是纯函数，没有 DOM、没有 chrome.*，node --test
// 里直接跑。
//
// 装载顺序：凡是装了 shared/caption-core.js 或 shared/site-rules.js 的地方，这
// 个文件都要排在它们前面——两者都在加载时就把函数取走。
// test/unit/site-rules.test.mjs 的「装载清单」那条守着这一点。
(function (root) {
  'use strict';

  /** 'zh-Hant-TW' -> 'zh'。空串表示「这不是一个语言标签」。 */
  function getLangBase(lang) {
    if (!lang) return '';
    return String(lang).split('-')[0].toLowerCase();
  }

  // 中文按地区分简繁的那些子标签。标签本身很少直接带书写系统：YouTube 发
  // `zh-Hans`/`zh-Hant`，而野生的 <track> 和 <html lang> 写 `zh-CN`/`zh-TW`
  // 的多得多。
  const ZH_HANT_SUBTAGS = new Set(['hant', 'tw', 'hk', 'mo']);
  const ZH_HANS_SUBTAGS = new Set(['hans', 'cn', 'sg', 'my']);

  /**
   * 这个中文标签写的是哪套字 —— 'hans'、'hant'，或者 '' 表示「这个标签没说」，
   * 后者也包含所有非中文的语言。
   */
  function getScriptVariant(lang) {
    const parts = String(lang || '').toLowerCase().split('-').filter(Boolean);
    if (parts[0] !== 'zh') return '';
    for (let i = 1; i < parts.length; i += 1) {
      if (ZH_HANT_SUBTAGS.has(parts[i])) return 'hant';
      if (ZH_HANS_SUBTAGS.has(parts[i])) return 'hans';
    }
    return '';
  }

  /**
   * 这两个标签是同一门语言、且是同一套字吗？
   *
   * 光比基码回答不了这一问。`zh-CN` 和 `zh-TW` 都归约成 `zh`，而它们是两套字：
   * 一份繁体的原文配简体的目标，正是用户要转换的那一件事，按基码判会答「本来
   * 就是你的语言」，于是一个字也不翻。别的语言上基码就是全部答案——`en-GB` 对
   * `en` 是同一门英语，为它花钱翻一遍才是 bug。
   *
   * 没说自己是哪套字的那一边算「同语言」，因为 `zh` 对 `zh-CN` 是真的不知道，
   * 而这一问是一道**花钱的闸**：猜「不同」是替用户买一次多半什么也没变的翻译，
   * 猜「相同」不会拿走他已有的东西。
   */
  function isSameLanguage(a, b) {
    const baseA = getLangBase(a);
    const baseB = getLangBase(b);
    if (!baseA || !baseB || baseA !== baseB) return false;
    const scriptA = getScriptVariant(a);
    const scriptB = getScriptVariant(b);
    if (!scriptA || !scriptB) return true;
    return scriptA === scriptB;
  }


  // 简繁的分水岭：每两个字一对，偶数位是简体那一侧，奇数位是繁体那一侧。
  //
  // **只收两侧互不相同、而且各自在另一侧不存在的字。** 像 里/裡、后/後、几/幾、
  // 台/臺、干/幹、只/隻、面/麵 这些不能收：简体那一侧在繁体文本里本来就是个合法
  // 的字（皇后、茶几、台北），拿它们计数会把繁体页面读成简体。写成一条长字符串
  // 而不是两张表，是因为这样「两侧一一对应」肉眼可查，而两张表会各自漂移。
  const HAN_PAIRS = '这這个個们們说說国國会會学學东東车車马馬龙龍点點为為过過时時实實发發体體语語读讀经經认認么麼万萬来來对對开開关關门門问問题題样樣机機种種业業产產区區长長张張爱愛欢歡乐樂儿兒无無旧舊听聽写寫书書专專价價传傳备備现現见見觉覺观觀规規视視论論讲講记記设設请請话話谁誰调調变變边邊达達运運远遠连連进進还還选選银銀钱錢铁鐵错錯间間队隊阳陽难難离離页頁风風飞飛饭飯馆館验驗术術华華单單买買员員团團图圖场場报報动動医醫厂廠历歷参參双雙号號声聲处處头頭妈媽孙孫宁寧宝寶导導尽盡师師带帶帮幫广廣应應当當录錄总總战戰数數断斷显顯杀殺条條极極标標树樹欧歐汉漢汤湯洁潔济濟满滿灯燈灵靈热熱营營独獨环環电電确確礼禮积積称稱简簡类類紧緊红紅级級纪紀纸紙线線练練组組细細织織终終结結给給绝絕统統续續维維绿綠编編网網罗羅义義习習联聯脑腦脸臉艺藝节節荣榮药藥获獲虽雖补補装裝计計让讓许許证證识識词詞译譯试試诚誠详詳误誤课課谈談谢謝财財责責败敗货貨质質购購贵貴费費资資赛賽赢贏军軍转轉轮輪软軟输輸辞辭违違递遞邮郵郑鄭释釋针針钟鐘钢鋼锁鎖锅鍋键鍵镇鎮闪閃闭閉闻聞阅閱阶階陈陳险險随隨隐隱雾霧静靜韩韓顶頂项項顺順预預领領颜顏额額飘飄饥飢饮飲饱飽驾駕骂罵鱼魚鲜鮮鸟鳥鸡雞鸭鴨麦麥齐齊齿齒龄齡龟龜';

  const HANS_CHARS = new Set();
  const HANT_CHARS = new Set();
  for (let i = 0; i < HAN_PAIRS.length; i += 2) {
    HANS_CHARS.add(HAN_PAIRS[i]);
    HANT_CHARS.add(HAN_PAIRS[i + 1]);
  }

  /**
   * 这段中文写的是哪套字 —— 'hans'、'hant'，或者 '' 表示「看不出来」。
   *
   * 为什么需要它：chrome.i18n.detectLanguage 对繁体和简体一律回答 `zh`（在真实
   * Chrome 里实测过，两边都是 zh / 100% / isReliable）。也就是说**光靠标签永远
   * 分不出简繁**——而「繁转简」正是用户要的那一件事。分水岭只能从字本身来。
   *
   * 数完谁多算谁，平手（含一个都没数到）算看不出来。一页里混着两套字是有的
   * （繁体站引一段简体原文），多数派就是这一页的立场；而只数到一个字也作数，
   * 因为上面那张表里的每个字都**只在一侧存在**，一个就是证据。
   */
  function detectHanScript(text) {
    const str = String(text || '');
    let hans = 0;
    let hant = 0;
    for (const ch of str) {
      if (HANS_CHARS.has(ch)) hans += 1;
      else if (HANT_CHARS.has(ch)) hant += 1;
    }
    if (hans > hant) return 'hans';
    if (hant > hans) return 'hant';
    return '';
  }

  /**
   * 把一个没说书写系统的中文标签，按这段文字补成 zh-Hans / zh-Hant。
   *
   * 别的语言、以及本来就说了书写系统的标签，原样返回 —— 这是一次**补充**，
   * 不是一次改写：标签自己说了的话，永远压过我们从字里数出来的。
   */
  function refineScript(lang, text) {
    if (!lang) return lang;
    if (getLangBase(lang) !== 'zh' || getScriptVariant(lang)) return lang;
    const script = detectHanScript(text);
    if (!script) return lang;
    return script === 'hant' ? 'zh-Hant' : 'zh-Hans';
  }

  // ==================== 字母体系 ====================

  // Script=Common 涵盖数字、标点、空白和 emoji，Inherited 涵盖组合用附加符号，
  // 所以 "hello 😀" 和 "café" 都仍算纯拉丁。
  const HAS_NON_LATIN_CHARS = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;

  /** 这段文字里有没有拉丁字母以外的字（数字、标点、emoji 不算）。 */
  function hasNonLatinChars(text) {
    return HAS_NON_LATIN_CHARS.test(String(text || ''));
  }

  // 拉丁轴两边都有大量正文的语言。Intl 只给一门语言一个默认文字（sr→Cyrl、
  // uz→Latn、bs→Latn、kk→Cyrl），而这几门的另一套字一样常见：拉丁字母的塞尔维亚
  // 语（target-lang.js 把 sr-Latn 也收成 sr）、西里尔字母的乌兹别克语和波斯尼亚语、
  // 正在改用拉丁字母的哈萨克语。只按默认文字判，这些页面上一半的正文会被判成「不
  // 可能是这门语言」。两套都是非拉丁的（pa 的古木基和沙穆基）不影响这条轴，不收。
  const BOTH_SIDES_LANGS = new Set(['sr', 'bs', 'uz', 'kk']);

  /**
   * 这段文字可不可能是用这门语言写的 —— 只看拉丁 / 非拉丁这一条轴。
   *
   * 问的是 Intl 而不是一张手抄的表：往支持列表里加语言的人不该还要记得同步第二处。
   * 标签自己写明了文字（sr-Latn、zh-Hant）就只认那一套；没写明的，两套都常见的
   * 语言两边都算，其余按 Intl 补全的默认文字。认不出来的标签（'english'、'x'）答
   * 「不可能」—— 调用方拿它做的都是「否决」，多否决一次的代价小。
   */
  function langFitsText(lang, text) {
    let locale;
    try {
      locale = new Intl.Locale(String(lang));
    } catch (error) {
      return false;
    }
    if (!locale.script && BOTH_SIDES_LANGS.has(locale.language)) return true;
    const script = locale.maximize().script;
    if (!script) return false;
    return (script !== 'Latn') === hasNonLatinChars(text);
  }

  // 默认文字不是拉丁、但拉丁字母也是它的正经写法的语言。Intl 只给默认文字
  // （sr → Cyrl），分不出这一层，只能列出来。只收目标语言列表里真这样用的：
  // target-lang 把 sr-Latn 也收成 sr。罗马化的中文、俄文、日文、印地文不算 ——
  // 选了它们的读者要的就是本族文字，拼音段落得译。
  const ALSO_WRITTEN_IN_LATIN = new Set(['sr']);

  /** 这门语言的正文可以是拉丁字母写的（en、fr，以及拉丁写法的 sr）。 */
  function writesInLatin(lang) {
    return !isNonLatinLang(lang) || ALSO_WRITTEN_IN_LATIN.has(getLangBase(lang));
  }

  // ==================== 母语正文里夹带的外文名词 ====================

  // 「这一段是不是已经是目标语言」不能整段交给检测器：中文技术文章满是英文名词，
  // 实测（Chrome 的 chrome.i18n.detectLanguage）「这个 bug 是 TypeScript 的
  // strictNullChecks 引起的。」只给 zh:64，「用 kubectl apply -f deployment.yaml
  // 部署到 Kubernetes 集群。」干脆答 kk:47 —— 两句都过不了「有把握」那道门，于是
  // 母语读者自己的正文被花钱译一遍。把另一种字母体系里的名词摘掉之后，剩下的
  // 「这个 是 的 引起的。」「用 部署到 集群。」都是 zh:100。
  //
  // 摘的轴是**拉丁 / 非拉丁**，不是「目标语言的文字 / 其余」：目标是中文时，日文
  // 段落的假名不能当外文名词摘掉 —— 摘了剩一串汉字，就成了「本来就是中文」。按拉丁
  // 轴摘，假名、谚文都留在剩下的正文里，检测器自己分得出 ja / ko / zh。
  //
  // 母语站在轴的哪一边，看的是**这段文字**，不只看目标语言的默认文字：目标是 sr、
  // 这一段却一个非拉丁字都没有（拉丁字母写的塞尔维亚语），按默认的西里尔一侧摘，
  // 整句被当外文摘空，每一段母语都照译。所以这段文字有非拉丁字、目标语言又写得
  // 出非拉丁字时摘拉丁名词，否则摘非拉丁名词 —— 一段纯拉丁的英文配中文目标，没有
  // 可摘的「另一边」，整段原样交给检测器，它答 en，照译。

  // 一串拉丁字母写的外文：从字母开始、到字母或数字结束，中间可以夹空白、数字和
  // 标点（"Next.js App Router"、"iPhone 17 Pro Max"、"kubectl apply -f deployment.yaml"）。
  const LATIN_RUN = /\p{Script=Latin}(?:[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]*[\p{Script=Latin}\d])?/gu;
  // 反过来：拉丁正文里一串非拉丁的字（"We use 微服务 architecture"）。
  const NON_LATIN_RUN = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}](?:[^\p{Script=Latin}]*[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}])?/gu;
  const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
  const LETTER = /\p{L}/u;

  // 一串外文有几个词。不用空格分词的汉字和假名按两个字一个词算。
  function countWords(run) {
    const cjk = (run.match(CJK_CHAR) || []).length;
    const spaced = (run.replace(CJK_CHAR, ' ').match(/[\p{L}\p{M}]+/gu) || []).length;
    return spaced + Math.ceil(cjk / 2);
  }

  // 夹在母语句子里的一串外文，多长还算「名词」。实测的技术名词最长是
  // "kubectl apply -f deployment.yaml"（5 个词）；再长就是一个从句，读者未必读得懂。
  const TERM_MAX_WORDS = 6;
  // 一句里外文的词数最多是母语的几倍，还算「母语句子夹名词」。实测的中文技术
  // 句子里，外文最多到母语的两倍（「iPhone 17 Pro Max 评测：A19 Pro 芯片、
  // ProMotion 屏幕。」是 6 比 3）；反过来「We use 微服务 architecture for our
  // backend.」是 6 比 2 —— 那是一句夹了个中文词的英文，得译。
  const FOREIGN_RATIO_MAX = 2;
  // 一整句都是外文（这一句里一个母语字都没有）时，多长就不再当成顺手的一句
  // 「Enjoy!」「Thanks.」，而是读者要读的一句外文。
  const FOREIGN_SENTENCE_MIN_WORDS = 3;

  let sentenceSegmenter = null;

  /**
   * 按句拆开，把母语正文里夹带的外文名词摘掉。
   *
   * 回答两件事：
   *   residue —— 摘完名词、按句拼回的正文。拿它去问检测器「这是不是目标语言」。
   *              一句里一个母语字都不剩的，不进 residue。
   *   foreign —— 这一段里有没有**成句的外文**：某一句里夹着一串超过
   *              TERM_MAX_WORDS 个词的外文、外文词数超过母语的 FOREIGN_RATIO_MAX
   *              倍，或者某一整句都是外文且不止两个词。
   *              有就得译 —— 主体是母语也不行，那几句读者要的就是译文。
   *
   * 这里只拆字，不判语言：判语言要问 chrome.i18n.detectLanguage，这一份是纯函数。
   */
  function splitForeignTerms(text, targetLang) {
    const source = String(text || '');
    const foreignRun = hasNonLatinChars(source) && langFitsText(targetLang, source) ? LATIN_RUN : NON_LATIN_RUN;
    if (!sentenceSegmenter) sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
    const kept = [];
    let foreign = false;
    for (const { segment } of sentenceSegmenter.segment(source)) {
      let longest = 0;
      let total = 0;
      const rest = segment.replace(foreignRun, (run) => {
        const words = countWords(run);
        longest = Math.max(longest, words);
        total += words;
        return ' ';
      });
      if (LETTER.test(rest)) {
        if (longest > TERM_MAX_WORDS || total > FOREIGN_RATIO_MAX * countWords(rest)) foreign = true;
        kept.push(rest);
      } else if (total >= FOREIGN_SENTENCE_MIN_WORDS) {
        foreign = true;
      }
    }
    return { residue: kept.join(' ').replace(/\s+/g, ' ').trim(), foreign };
  }

  // 只有汉字（没有假名、谚文）的正文。检测器在两三个汉字上会答 ja（实测「使用」→
  // ja:100），可没有假名的日文只出现在「会議」「東京」这种短标签上 —— 对中文读者
  // 它们本来就读得懂，按中文算。
  const HAN_ONLY = /^[\p{Script=Han}\p{Script=Common}\p{Script=Inherited}]+$/u;
  function isHanOnly(text) {
    return HAN_ONLY.test(text) && /\p{Script=Han}/u.test(text);
  }

  root.LangTags = {
    getLangBase,
    getScriptVariant,
    isSameLanguage,
    detectHanScript,
    refineScript,
    hasNonLatinChars,
    langFitsText,
    splitForeignTerms,
    isHanOnly,
  };
})(globalThis);
