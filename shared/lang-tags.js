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

  root.LangTags = {
    getLangBase,
    getScriptVariant,
    isSameLanguage,
    detectHanScript,
    refineScript,
  };
})(globalThis);
