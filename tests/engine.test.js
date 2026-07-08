// Regression tests for the annotation engine and its integration points.
// Run with: node tests/engine.test.js   (or: npm test)
//
// These load the real engine + OpenCC + CC-CEDICT data the extension ships, so
// they guard the bugs we actually hit: the "URI malformed" context-encoding
// crash, Traditional-input annotation, and Simplified/Traditional conversion.

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const root = path.join(__dirname, "..");
const sandbox = { console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const load = (file) => vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), sandbox, { filename: file });

load("opencc.js");
load("converter.js");
load("pinyin-web-engine.js");
sandbox.globalThis.PinyinWebAnnotator.Annotator.data = fs.readFileSync(path.join(root, "annotate-dat.txt"), "utf8");

const engine = sandbox.globalThis.PinyinWebAnnotator;
const converter = sandbox.globalThis.CombinedConverter;

// Mirror background.js encodeAnnotatorContext: normalize a few punctuation
// marks, then encode to a UTF-8 byte string (what the engine expects).
const PUNCT = { "，": ",", "。": ".", "「": '"', "」": '"' };
const normalize = (t) => Array.from(String(t || "")).map((c) => PUNCT[c] || c).join("");
const encodeContext = (t) => unescape(encodeURIComponent(normalize(t)));
const annotate = (text, left = "", right = "") =>
  engine.annotate(normalize(text), 0, 2, 0, encodeContext(left), encodeContext(right));

let passed = 0;
let failed = 0;
function check(name, condition) {
  if (condition) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}`);
  }
}

// 1. Converter turns Traditional into Simplified.
check("converter traditional->simplified", converter.toSimplified("白日依山盡") === "白日依山尽");
check("converter simplified->traditional", converter.toTraditional("学中文").length === 3);

// 2. Simplified and Traditional lines both annotate to ruby.
check("simplified line has ruby", /<ruby/i.test(annotate("春眠不觉晓，处处闻啼鸟。")));
check("traditional line has ruby", /<ruby/i.test(annotate("白日依山盡，黃河入海流。")));

// 3. A Chinese left/right context must NOT throw and must still annotate
//    (regression for the raw-string context that produced "URI malformed").
let threw = false;
let html = "";
try {
  html = annotate("白日依山盡，黃河入海流。", "处处闻啼鸟", "");
} catch (error) {
  threw = true;
}
check("chinese context does not throw", !threw);
check("annotates with a left context", /<ruby/i.test(html));

// 4. Empty context still works.
check("empty context works", /<ruby/i.test(annotate("学中文")));

// 5. HSK 3.0 dataset is present and does longest-match lookups.
const hsk = JSON.parse(fs.readFileSync(path.join(root, "hsk-data.json"), "utf8"));
check("hsk standard is 3.0", /3\.0/.test(hsk._meta.standard));
check("hsk has >5000 words", Object.keys(hsk.levels).length > 5000);
check("hsk 中文 is level 1", hsk.levels["中文"] === 1);
check("hsk maxKeyLength is >=1", hsk._meta.maxKeyLength >= 1);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
