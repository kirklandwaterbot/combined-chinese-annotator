const assert = require("assert/strict");
const Core = require("../core.js");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (error) { console.error(`FAIL  ${name}`); throw error; }
}

test("adaptive layout uses popup below 320px", () => assert.equal(Core.chooseLayout(280, {...Core.DEFAULT_SETTINGS, showPinyin:true, showEnglish:true}), "popup"));
test("adaptive layout uses primary at 430px", () => assert.equal(Core.chooseLayout(430, {...Core.DEFAULT_SETTINGS, showPinyin:true, showEnglish:true}), "primary"));
test("three layers remain primary below 720px", () => assert.equal(Core.chooseLayout(700, {...Core.DEFAULT_SETTINGS, showPinyin:true, showEnglish:true}), "primary"));
test("three layers expand at 800px", () => assert.equal(Core.chooseLayout(800, {...Core.DEFAULT_SETTINGS, showPinyin:true, showEnglish:true}), "full"));
test("explicit modes ignore width", () => assert.equal(Core.chooseLayout(200, {...Core.DEFAULT_SETTINGS, layoutMode:"full"}), "full"));
test("compact UI protection uses popup in genuinely narrow containers", () => assert.equal(Core.chooseSafeLayout(280, {...Core.DEFAULT_SETTINGS, layoutMode:"full"}, {compact:true}), "popup"));
test("compact UI false positives cannot hide wide article annotations", () => assert.equal(Core.chooseSafeLayout(800, {...Core.DEFAULT_SETTINGS, layoutMode:"full"}, {compact:true}), "full"));
test("compact UI protection can be disabled", () => assert.equal(Core.chooseSafeLayout(800, {...Core.DEFAULT_SETTINGS, layoutMode:"full", protectCompactUi:false}, {compact:true}), "full"));
test("shrink-wrapped lesson text promotes to its nearby flex reading row", () => assert.equal(Core.chooseLayoutContainerIndex([
  {display:"block",width:109},
  {display:"block",width:158},
  {display:"flex",width:650}
]), 2));
test("layout promotion does not escape a narrow sidebar into a distant page grid", () => assert.equal(Core.chooseLayoutContainerIndex([
  {display:"block",width:280},
  {display:"block",width:300},
  {display:"block",width:300},
  {display:"grid",width:1200}
]), 0));
test("large multi-line role buttons are reading cards, not compact controls", () => assert.equal(Core.isWideReadingControl(771,102,24,false), true));
test("toolbar-sized and clamped role buttons remain compact", () => {
  assert.equal(Core.isWideReadingControl(771,40,20,false), false);
  assert.equal(Core.isWideReadingControl(771,102,24,true), false);
});

test("Japanese kana blocks are skipped", () => assert.equal(Core.shouldAnnotateLanguage("\u4eca\u65e5\u306f\u5929\u6c17", "", "auto"), false));
test("Korean blocks are skipped", () => assert.equal(Core.shouldAnnotateLanguage("\uc624\ub298 \u4e2d\u570b", "", "auto"), false));
test("incidental Han in untagged non-Chinese text is skipped", () => assert.equal(Core.shouldAnnotateLanguage("English title with \u82f1\u8a9e background music", "", "auto"), false));
test("substantial untagged Chinese remains eligible", () => assert.equal(Core.shouldAnnotateLanguage("BGM \u4e2d\u6587\u5b78\u7fd2\u97f3\u6a02", "", "auto"), true));
test("explicit nested Chinese is accepted", () => assert.equal(Core.shouldAnnotateLanguage("\u4eca\u5929\u5929\u6c14", "zh-Hant", "auto"), true));
test("explicit non-Chinese language blocks are skipped", () => {
  for (const lang of ["en", "en-US", "vi", "fr-CA", "ru", "ar", "th"]) {
    assert.equal(Core.classifyLanguage("\u4e2d\u6587 example", lang), "other", lang);
    assert.equal(Core.shouldAnnotateLanguage("\u4e2d\u6587 example", lang, "auto"), false, lang);
  }
});
test("Chinese BCP-47 varieties remain eligible", () => {
  for (const lang of ["zh-Hant", "cmn-Hans-CN", "yue-Hant-HK", "wuu", "hak", "nan", "gan", "hsn", "cjy", "lzh"]) {
    assert.equal(Core.classifyLanguage("", lang), "zh", lang);
    assert.equal(Core.shouldAnnotateLanguage("\u4e2d\u6587", lang, "auto"), true, lang);
  }
});
test("undetermined and multilingual tags fall back to script detection", () => {
  assert.equal(Core.classifyLanguage("\u4e2d\u6587", "und"), "zh");
  assert.equal(Core.classifyLanguage("\u4e2d\u6587", "mul"), "zh");
});
test("force mode accepts Han in mixed text", () => assert.equal(Core.shouldAnnotateLanguage("\u4eca\u65e5\u306f", "ja", "force"), true));

const now = 1_800_000_000_000;
test("Again is due in ten minutes", () => {
  const next = Core.rateReview({}, "again", now);
  assert.equal(next.dueAt, now + Core.TEN_MINUTES_MS);
  assert.equal(next.state, "learning");
});
test("lapse resets interval to one day", () => assert.equal(Core.rateReview({repetitions:3,intervalDays:9}, "again", now).intervalDays, 1));
test("Good follows 1 day, 3 days, then ease", () => {
  const first = Core.rateReview({}, "good", now);
  const second = Core.rateReview(first, "good", now);
  const third = Core.rateReview(second, "good", now);
  assert.deepEqual([first.intervalDays, second.intervalDays, third.intervalDays], [1, 3, 7]);
});
test("Hard new cards use one day", () => assert.equal(Core.rateReview({}, "hard", now).dueAt, now + Core.DAY_MS));
test("Known removes a card from scheduling", () => assert.deepEqual(Core.rateReview({}, "known", now), {...Core.normalizeReview(), state:"known", dueAt:null, lastReviewedAt:now}));
test("ease is bounded", () => {
  let review = {ease:1.3,repetitions:10,intervalDays:1};
  for(let i=0;i<20;i++) review=Core.rateReview(review,"again",now+i);
  assert.equal(review.ease,1.3);
});

test("CC-CEDICT senses and classifiers remain separate", () => {
  const parsed = Core.parseCedictGloss("book; volume/CL:\u672c[ben3],\u518a|\u518c[ce4]/see \u5716\u66f8|\u56fe\u4e66[tu2 shu1]");
  assert.deepEqual(parsed.senses, ["book", "volume", "see \u5716\u66f8|\u56fe\u4e66[tu2 shu1]"]);
  assert.equal(parsed.classifiers.length, 2);
  assert.equal(parsed.classifiers[1].simplified, "\u518c");
  assert.equal(parsed.references[0].pinyin, "tu2 shu1");
});

test("CSV parser detects header and quoted commas", () => {
  const rows = Core.parseDelimited('Word,Pinyin,Definitions,Sentence,Tags\n"\u4e2d\u6587","zhong1 wen2","Chinese, language","\u6211\u5b66\u4e2d\u6587\u3002","core, hsk"');
  assert.equal(rows.length,1);
  assert.equal(rows[0].entry.hanzi,"\u4e2d\u6587");
  assert.equal(rows[0].entry.definitions[0],"Chinese, language");
});
test("TSV parser detects no-header rows", () => {
  const rows = Core.parseDelimited("\u5b78\u7fd2\txue2 xi2\thok6 zaap6\tto study");
  assert.equal(rows[0].entry.jyutping,"hok6 zaap6");
});
test("context URLs are opt-in", () => {
  assert.equal(Core.normalizeContext({sentence:"\u4f8b\u5b50",sourceUrl:"https://example.com"},"word",false).sourceUrl,"");
  assert.equal(Core.normalizeContext({sentence:"\u4f8b\u5b50",sourceUrl:"javascript:alert(1)"},"word",true).sourceUrl,"");
});
test("sentence extraction respects Chinese punctuation", () => assert.equal(Core.sentenceAround("\u7b2c\u4e00\u53e5\u3002\u6211\u5b66\u4e2d\u6587\u3002\u7b2c\u4e09\u53e5\u3002", 7), "\u6211\u5b66\u4e2d\u6587\u3002"));
test("settings are strictly normalized", () => {
  const value=Core.normalizeSettings({layoutMode:"bad",annotationScale:900,speechPitch:-1,unknown:"x"});
  assert.equal(value.layoutMode,"adaptive");assert.equal(value.annotationScale,125);assert.equal(value.speechPitch,.5);assert.equal(value.protectCompactUi,true);assert.equal(value.clipboardEditorSupport,true);assert.equal(value.speechBackend,"azure");assert.equal("unknown" in value,false);
  assert.equal(Core.normalizeSettings({clipboardEditorSupport:true}).clipboardEditorSupport,true);
});

test("read-aloud shortcuts are normalized and unique", () => {
  assert.equal(Core.normalizeShortcut("alt + ctrl + c"), "Ctrl+Alt+C");
  assert.equal(Core.normalizeShortcut("Shift+C", "Ctrl+Alt+C"), "Ctrl+Alt+C");
  const value = Core.normalizeSettings({
    readAloudCantoneseShortcut: "Ctrl+Alt+1",
    readAloudMandarinShortcut: "Ctrl+Alt+1",
    readAloudEnglishShortcut: "Meta+E"
  });
  assert.equal(value.readAloudCantoneseShortcut, "Ctrl+Alt+1");
  assert.equal(value.readAloudMandarinShortcut, Core.DEFAULT_SETTINGS.readAloudMandarinShortcut);
  assert.equal(value.readAloudEnglishShortcut, "Meta+E");
  const conflictingDefaults = Core.normalizeSettings({
    readAloudCantoneseShortcut: Core.DEFAULT_SETTINGS.readAloudMandarinShortcut,
    readAloudMandarinShortcut: Core.DEFAULT_SETTINGS.readAloudMandarinShortcut,
    readAloudEnglishShortcut: Core.DEFAULT_SETTINGS.readAloudMandarinShortcut
  });
  assert.equal(new Set([
    conflictingDefaults.readAloudCantoneseShortcut,
    conflictingDefaults.readAloudMandarinShortcut,
    conflictingDefaults.readAloudEnglishShortcut
  ]).size, 3);
});

test("read-aloud shortcuts are captured and matched from keyboard events", () => {
  const event = { key:"c", altKey:true, shiftKey:false, ctrlKey:true, metaKey:false, isComposing:false };
  assert.equal(Core.shortcutFromEvent(event), "Ctrl+Alt+C");
  assert.equal(Core.matchesShortcut(event, "Ctrl+Alt+C"), true);
  assert.equal(Core.matchesShortcut(event, "Ctrl+Alt+M"), false);
});

test("Chinese speech removes invisible separators but preserves real spaces", () => {
  assert.equal(Core.normalizeChineseSpeechText("\u200b\u5ee3\u5dde \u2060Windows 11 \ufeff\u4e2d\u5fc3"), "\u5ee3\u5dde Windows 11 \u4e2d\u5fc3");
  assert.equal(Core.normalizeChineseSpeechText("\u56e0 \u70ba\t\u73e0\u6c5f"), "\u56e0 \u70ba \u73e0\u6c5f");
});

test("Cantonese speech keeps the natural legacy rate while other languages do not", () => {
  assert.equal(Core.speechRateForLanguage(0.9, "zh-HK"), 0.82);
  assert.equal(Core.speechRateForLanguage(0.45, "yue-HK"), 0.41);
  assert.equal(Core.speechRateForLanguage(0.9, "zh-CN"), 0.9);
  assert.equal(Core.speechRateForLanguage(0.9, "en-US"), 0.9);
});

test("natural Microsoft voices rank ahead of legacy voices", () => {
  const voices = [
    {name:"Microsoft Zira - English (United States)",lang:"en-US",default:true},
    {name:"Microsoft Jenny Online (Natural) - English (United States)",lang:"en-US",default:false},
    {name:"Microsoft Huihui - Chinese (Simplified, PRC)",lang:"zh-CN",default:true},
    {name:"Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)",lang:"zh-CN",default:false}
  ];
  assert.equal(Core.rankSpeechVoices(voices.filter((voice) => voice.lang === "en-US"), "en-US")[0].name, voices[1].name);
  assert.equal(Core.rankSpeechVoices(voices.filter((voice) => voice.lang === "zh-CN"), "zh-CN")[0].name, voices[3].name);
  assert.equal(Core.isNaturalSpeechVoice(voices[1], "en-US"), true);
  assert.equal(Core.isNaturalSpeechVoice(voices[0], "en-US"), false);
});

test("Azure speech uses fixed neural voices and escaped SSML", () => {
  const english = Core.buildAzureSpeechRequest({text:"Jenny & <friends>",lang:"en-US",rate:1.1,pitch:.8});
  assert.equal(english.voice,"en-US-JennyNeural");
  assert.equal(english.lang,"en-US");
  assert.match(english.ssml,/rate="\+10%"/);
  assert.match(english.ssml,/pitch="-10%"/);
  assert.match(english.ssml,/Jenny &amp; &lt;friends&gt;/);
  const mandarin = Core.buildAzureSpeechRequest({text:"中文测试",lang:"zh-CN"});
  const cantonese = Core.buildAzureSpeechRequest({text:"中文測試",lang:"zh-HK"});
  assert.equal(mandarin.voice,"zh-CN-XiaochenNeural");
  assert.equal(cantonese.voice,"zh-HK-HiuGaaiNeural");
  assert.equal(Core.normalizeAzureSpeechRegion(" EASTUS2 "),"eastus2");
  assert.equal(Core.normalizeAzureSpeechRegion("https://example.com"),"eastus");
  assert.equal(Core.normalizeSettings({speechBackend:"azure"}).speechBackend,"azure");
  assert.equal(Core.normalizeSettings({speechBackend:"unknown"}).speechBackend,"azure");
});

test("TTS diagnostics keep operational data but remove speech content and credentials", () => {
  const entry = Core.sanitizeTtsDiagnosticEntry({
    timestamp:"2026-09-24T12:00:00Z",event:"azure.request.failed",requestId:"speech-1",
    backend:"azure",region:"eastus",lang:"en-US",voice:"en-US-JennyNeural",
    textLength:42,durationMs:1250.4567,httpStatus:429,errorCode:"quota",error:"Rate limited",
    text:"secret spoken words",key:"secret-key",ssml:"<speak>secret</speak>",audioBase64:"AAAA",url:"https://example.com/private"
  });
  assert.equal(entry.textLength,42);
  assert.equal(entry.durationMs,1250.457);
  assert.equal(entry.errorCode,"quota");
  for (const privateField of ["text","key","ssml","audioBase64","url"]) assert.equal(entry[privateField],undefined);
  const output = Core.formatTtsDiagnosticLog([entry],{extensionVersion:"0.2.2",browser:"Firefox"});
  assert.match(output,/azure\.request\.failed/);
  assert.match(output,/spoken text, page addresses, Azure keys, SSML, and audio are not recorded/);
  assert.doesNotMatch(output,/secret spoken words|secret-key|example\.com/);
});

test("converted text boundaries support insertions and deletions", () => {
  assert.deepEqual(Core.alignConvertedBoundaries("AB", "AXB"), [0, 2, 3]);
  assert.deepEqual(Core.alignConvertedBoundaries("AXB", "AB"), [0, 1, 1, 2]);
  assert.deepEqual(Core.alignConvertedBoundaries("怎么", "怎麼"), [0, 1, 2]);
});
console.log(`\n${passed} core tests passed`);
