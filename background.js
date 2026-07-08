// Chrome runs the background as a single service-worker file, so the shared
// engine scripts have to be pulled in here. Firefox instead lists them under
// "background.scripts" (see manifest.json), where importScripts is undefined
// and globalThis.OpenCC is already populated by the time this runs.
if (typeof importScripts === "function" && typeof globalThis.OpenCC === "undefined") {
  importScripts("opencc.js", "converter.js", "pinyin-web-engine.js");
}

const ext = typeof browser !== "undefined" ? browser : chrome;

const DEFAULT_SETTINGS = {
  showJyutping: true,
  showPinyin: false,
  showEnglish: false,
  enableEnglishColoring: true,
  enablePinyinToneColoring: true,
  enableJyutpingToneColoring: true,
  englishColor: "#374151",
  pinyinTone1Color: "#e53e3e",
  pinyinTone2Color: "#38a169",
  pinyinTone3Color: "#3182ce",
  pinyinTone4Color: "#805ad5",
  pinyinTone5Color: "#718096",
  jyutpingTone1Color: "#e53e3e",
  jyutpingTone2Color: "#38a169",
  jyutpingTone3Color: "#3182ce",
  jyutpingTone4Color: "#805ad5",
  jyutpingTone5Color: "#718096",
  jyutpingTone6Color: "#319795",
  jyutpingVoice: "",
  pinyinVoice: "",
  englishVoice: "",
  copyFormat: "smart",
  hoverOnly: false,
  showHsk: false,
  uiTheme: "auto",
  uiAccent: "#0f766e"
};

// annotate-dat.txt is a ~27MB engine index that must live in memory while the
// engine runs. Load it lazily (only when an annotation is actually requested),
// so service-worker wake-ups for other messages don't pay for it.
let annotatorDataReady = null;
function ensureAnnotatorData() {
  if (annotatorDataReady) return annotatorDataReady;
  annotatorDataReady = fetch(ext.runtime.getURL("annotate-dat.txt"))
    .then((response) => response.text())
    .then((data) => {
      globalThis.PinyinWebAnnotator.Annotator.data = data;
    });
  return annotatorDataReady;
}

// Helper: loads a JSON file that was split into chunks (prefix-1.json,
// prefix-2.json, ...). Each chunk has a _chunk.total field. The merged result
// combines all entries under `mergeKey` (or top-level keys if mergeKey is null).
async function loadChunkedJSON(prefix, mergeKey) {
  // Load the first chunk to discover the total count
  const first = await fetch(ext.runtime.getURL(`${prefix}-1.json`)).then((r) => r.json());
  const total = first._chunk?.total || 1;
  delete first._chunk;

  if (total === 1) return first;

  // Load remaining chunks in parallel
  const rest = await Promise.all(
    Array.from({ length: total - 1 }, (_, i) =>
      fetch(ext.runtime.getURL(`${prefix}-${i + 2}.json`)).then((r) => r.json())
    )
  );

  // Merge: if mergeKey is provided, combine that key's entries; otherwise merge top-level
  if (mergeKey) {
    const merged = { ...first };
    for (const chunk of rest) {
      delete chunk._chunk;
      Object.assign(merged[mergeKey], chunk[mergeKey]);
    }
    return merged;
  } else {
    const merged = { ...first };
    for (const chunk of rest) {
      delete chunk._chunk;
      Object.assign(merged, chunk);
    }
    return merged;
  }
}

// The CC-CEDICT (~8.5MB) and HSK dictionaries are large lookup tables. Instead
// of parsing them into the service-worker heap on every wake (Chrome evicts the
// worker aggressively), import them once into IndexedDB as per-word records and
// query only the words a page actually contains. If IndexedDB is unavailable we
// fall back to the previous in-memory fetch+parse path.
const DICT_DB_NAME = "combinedAnnotatorDicts";
const DICT_DB_VERSION = 2;
const DICT_DATA_VERSION = "1"; // bump to force a re-import after data changes
const STROKE_DATA_VERSION = "1";
const DICT_STORE_META = "meta";
const DICT_STORE_CEDICT = "cedict";
const DICT_STORE_HSK = "hsk";
const DICT_STORE_STROKE = "stroke";

let cedictMaxKeyLength = 12;
let hskMaxKeyLength = 4;
let cedictEntries = null; // in-memory fallback, only populated if IDB fails
let hskEntries = null;
let dictDb = null;
let dictReady = null;

let strokeReady = null;
let strokeUsable = false; // true once stroke data is queryable from IndexedDB
let strokeBundle = null;  // in-memory fallback, only populated if IDB fails

let dbOpenPromise = null;
function openDictDb() {
  if (dbOpenPromise) return dbOpenPromise;
  dbOpenPromise = new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(DICT_DB_NAME, DICT_DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of [DICT_STORE_META, DICT_STORE_CEDICT, DICT_STORE_HSK, DICT_STORE_STROKE]) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbTxDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function idbMetaGet(db, key) {
  return idbRequest(db.transaction(DICT_STORE_META, "readonly").objectStore(DICT_STORE_META).get(key));
}

async function importDictionary(db, store, entries) {
  const keys = Object.keys(entries);
  const CHUNK = 4000;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const tx = db.transaction(store, "readwrite");
    const objectStore = tx.objectStore(store);
    const end = Math.min(i + CHUNK, keys.length);
    for (let j = i; j < end; j++) objectStore.put(entries[keys[j]], keys[j]);
    await idbTxDone(tx);
  }
}

// Ensures the dictionaries are queryable: imported into IndexedDB (once, on
// first run or after a version bump), or loaded into memory if IDB is unusable.
function ensureDictionaries() {
  if (dictReady) return dictReady;
  dictReady = (async () => {
    try {
      const db = await openDictDb();
      const storedVersion = await idbMetaGet(db, "version");
      if (storedVersion !== DICT_DATA_VERSION) {
        const [cedict, hsk] = await Promise.all([
          loadChunkedJSON("ccedict-glosses", "entries"),
          fetch(ext.runtime.getURL("hsk-data.json")).then((r) => r.json())
        ]);
        cedictMaxKeyLength = cedict._meta?.maxKeyLength || cedict.maxKeyLength || 12;
        hskMaxKeyLength = hsk._meta?.maxKeyLength || 4;
        await importDictionary(db, DICT_STORE_CEDICT, cedict.entries || Object.create(null));
        await importDictionary(db, DICT_STORE_HSK, hsk.levels || Object.create(null));
        const metaTx = db.transaction(DICT_STORE_META, "readwrite");
        const meta = metaTx.objectStore(DICT_STORE_META);
        meta.put(cedictMaxKeyLength, "cedictMaxKeyLength");
        meta.put(hskMaxKeyLength, "hskMaxKeyLength");
        meta.put(DICT_DATA_VERSION, "version");
        await idbTxDone(metaTx);
      } else {
        cedictMaxKeyLength = (await idbMetaGet(db, "cedictMaxKeyLength")) || 12;
        hskMaxKeyLength = (await idbMetaGet(db, "hskMaxKeyLength")) || 4;
      }
      dictDb = db;
    } catch (error) {
      console.warn("Combined Annotator: falling back to in-memory dictionaries", error);
      dictDb = null;
      await loadDictionariesIntoMemory();
    }
  })();
  return dictReady;
}

async function loadDictionariesIntoMemory() {
  try {
    const cedict = await loadChunkedJSON("ccedict-glosses", "entries");
    cedictEntries = cedict.entries || Object.create(null);
    cedictMaxKeyLength = cedict._meta?.maxKeyLength || cedict.maxKeyLength || 12;
  } catch (error) {
    cedictEntries = Object.create(null);
  }
  try {
    const hsk = await fetch(ext.runtime.getURL("hsk-data.json")).then((r) => r.json());
    hskEntries = hsk.levels || Object.create(null);
    hskMaxKeyLength = hsk._meta?.maxKeyLength || 4;
  } catch (error) {
    hskEntries = Object.create(null);
  }
}

// Stroke-order data ships as a single ~31MB bundle (hanzi-writer-data.json)
// instead of ~9,500 individual files. It is imported once into IndexedDB on
// first use, then queried one character at a time so it never sits in memory.
function ensureStrokeData() {
  if (strokeReady) return strokeReady;
  strokeReady = (async () => {
    try {
      const db = await openDictDb();
      const storedVersion = await idbMetaGet(db, "strokeVersion");
      if (storedVersion !== STROKE_DATA_VERSION) {
        const bundle = await loadChunkedJSON("hanzi-writer-data", null);
        await importDictionary(db, DICT_STORE_STROKE, bundle);
        const tx = db.transaction(DICT_STORE_META, "readwrite");
        tx.objectStore(DICT_STORE_META).put(STROKE_DATA_VERSION, "strokeVersion");
        await idbTxDone(tx);
      }
      strokeUsable = true;
    } catch (error) {
      console.warn("Combined Annotator: falling back to in-memory stroke data", error);
      strokeUsable = false;
      try {
        strokeBundle = await loadChunkedJSON("hanzi-writer-data", null);
      } catch (bundleError) {
        strokeBundle = Object.create(null);
      }
    }
  })();
  return strokeReady;
}

async function getStrokeData(char) {
  await ensureStrokeData();
  if (strokeUsable) {
    try {
      const db = await openDictDb();
      const value = await idbRequest(db.transaction(DICT_STORE_STROKE, "readonly").objectStore(DICT_STORE_STROKE).get(char));
      return value ?? null;
    } catch (error) {
      console.warn("Combined Annotator: stroke lookup failed", error);
    }
  }
  return strokeBundle ? (strokeBundle[char] ?? null) : null;
}

const ANNOTATION_CACHE_STORAGE_KEY = "annotationResponseCacheV3";
const ANNOTATION_RESPONSE_CACHE_LIMIT = 650;
let annotationResponseCache = new Map();
let annotationCacheReady = null;
let annotationCacheSaveTimer = 0;

function ensureAnnotationCacheReady() {
  if (annotationCacheReady) return annotationCacheReady;
  annotationCacheReady = ext.storage.local.get(ANNOTATION_CACHE_STORAGE_KEY)
    .then((stored) => {
      const entries = stored?.[ANNOTATION_CACHE_STORAGE_KEY];
      if (Array.isArray(entries)) {
        annotationResponseCache = new Map(entries.filter((entry) => Array.isArray(entry) && entry.length === 2));
      }
      trimAnnotationResponseCache();
    })
    .catch((error) => {
      console.warn("Combined Annotator: annotation cache unavailable", error);
      annotationResponseCache = new Map();
    });
  return annotationCacheReady;
}

function annotationCacheKey(text, settings) {
  const active = normalizeSettings(settings);
  return `v3|${active.showEnglish ? "e" : "-"}${active.showHsk ? "h" : "-"}|${text}`;
}

function trimAnnotationResponseCache() {
  while (annotationResponseCache.size > ANNOTATION_RESPONSE_CACHE_LIMIT) {
    annotationResponseCache.delete(annotationResponseCache.keys().next().value);
  }
}

function scheduleAnnotationCacheSave() {
  clearTimeout(annotationCacheSaveTimer);
  annotationCacheSaveTimer = setTimeout(() => {
    trimAnnotationResponseCache();
    ext.storage.local.set({ [ANNOTATION_CACHE_STORAGE_KEY]: Array.from(annotationResponseCache.entries()) })
      .catch((error) => console.warn("Combined Annotator: could not save annotation cache", error));
  }, 1200);
}

function rememberAnnotationResponse(key, response) {
  if (annotationResponseCache.has(key)) annotationResponseCache.delete(key);
  annotationResponseCache.set(key, response);
  trimAnnotationResponseCache();
  scheduleAnnotationCacheSave();
}
function hasChinese(text) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text);
}

// All Chinese substrings (up to maxKeyLength) that could be dictionary keys.
function collectChineseKeyCandidates(text, maxKeyLength) {
  const keys = new Set();
  for (let start = 0; start < text.length; start++) {
    if (!hasChinese(text[start])) continue;
    const maxEnd = Math.min(text.length, start + maxKeyLength);
    for (let end = maxEnd; end > start; end--) {
      const candidate = text.slice(start, end);
      if (hasChinese(candidate)) keys.add(candidate);
    }
  }
  return keys;
}

// Batch-read the given keys from an IndexedDB store in a single transaction.
async function idbLookupMany(store, keys) {
  const result = Object.create(null);
  if (!keys.size || !dictDb) return result;
  const tx = dictDb.transaction(store, "readonly");
  const objectStore = tx.objectStore(store);
  await Promise.all([...keys].map(async (key) => {
    const value = await idbRequest(objectStore.get(key));
    if (value !== undefined) result[key] = value;
  }));
  return result;
}

async function lookupCedictGlosses(text) {
  const result = Object.create(null);
  if (!text) return result;
  const keys = collectChineseKeyCandidates(text, cedictMaxKeyLength);
  if (dictDb) {
    try {
      return await idbLookupMany(DICT_STORE_CEDICT, keys);
    } catch (error) {
      console.warn("Combined Annotator: CC-CEDICT lookup failed", error);
    }
  }
  if (cedictEntries) {
    for (const key of keys) {
      const gloss = cedictEntries[key];
      if (gloss) result[key] = gloss;
    }
  }
  return result;
}

async function lookupHskLevels(text) {
  const result = Object.create(null);
  if (!text) return result;
  const keys = collectChineseKeyCandidates(text, hskMaxKeyLength);
  if (dictDb) {
    try {
      return await idbLookupMany(DICT_STORE_HSK, keys);
    } catch (error) {
      console.warn("Combined Annotator: HSK lookup failed", error);
    }
  }
  if (hskEntries) {
    for (const key of keys) {
      const level = hskEntries[key];
      if (level !== undefined) result[key] = level;
    }
  }
  return result;
}

function normalizeSettings(settings = {}) {
  return {
    showJyutping: Boolean(settings.showJyutping),
    showPinyin: Boolean(settings.showPinyin),
    showEnglish: Boolean(settings.showEnglish),
    enableEnglishColoring: normalizeBooleanSetting(settings.enableEnglishColoring, settings.enableToneColoring, DEFAULT_SETTINGS.enableEnglishColoring),
    enablePinyinToneColoring: normalizeBooleanSetting(settings.enablePinyinToneColoring, settings.enableToneColoring, DEFAULT_SETTINGS.enablePinyinToneColoring),
    enableJyutpingToneColoring: normalizeBooleanSetting(settings.enableJyutpingToneColoring, settings.enableToneColoring, DEFAULT_SETTINGS.enableJyutpingToneColoring),
    englishColor: normalizeColor(settings.englishColor, DEFAULT_SETTINGS.englishColor),
    pinyinTone1Color: normalizeColor(settings.pinyinTone1Color, DEFAULT_SETTINGS.pinyinTone1Color),
    pinyinTone2Color: normalizeColor(settings.pinyinTone2Color, DEFAULT_SETTINGS.pinyinTone2Color),
    pinyinTone3Color: normalizeColor(settings.pinyinTone3Color, DEFAULT_SETTINGS.pinyinTone3Color),
    pinyinTone4Color: normalizeColor(settings.pinyinTone4Color, DEFAULT_SETTINGS.pinyinTone4Color),
    pinyinTone5Color: normalizeColor(settings.pinyinTone5Color, DEFAULT_SETTINGS.pinyinTone5Color),
    jyutpingTone1Color: normalizeColor(settings.jyutpingTone1Color, DEFAULT_SETTINGS.jyutpingTone1Color),
    jyutpingTone2Color: normalizeColor(settings.jyutpingTone2Color, DEFAULT_SETTINGS.jyutpingTone2Color),
    jyutpingTone3Color: normalizeColor(settings.jyutpingTone3Color, DEFAULT_SETTINGS.jyutpingTone3Color),
    jyutpingTone4Color: normalizeColor(settings.jyutpingTone4Color, DEFAULT_SETTINGS.jyutpingTone4Color),
    jyutpingTone5Color: normalizeColor(settings.jyutpingTone5Color, DEFAULT_SETTINGS.jyutpingTone5Color),
    jyutpingTone6Color: normalizeColor(settings.jyutpingTone6Color, DEFAULT_SETTINGS.jyutpingTone6Color),
    jyutpingVoice: normalizeVoice(settings.jyutpingVoice),
    pinyinVoice: normalizeVoice(settings.pinyinVoice),
    englishVoice: normalizeVoice(settings.englishVoice),
    copyFormat: ["smart", "horizontal", "all-top-bottom", "all-bottom-top", "per-char-top-bottom", "per-char-bottom-top"].includes(settings.copyFormat) ? settings.copyFormat : "smart",
    hoverOnly: Boolean(settings.hoverOnly),
    showHsk: Boolean(settings.showHsk),
    uiTheme: ["auto", "light", "dark"].includes(settings.uiTheme) ? settings.uiTheme : "auto",
    uiAccent: normalizeColor(settings.uiAccent, DEFAULT_SETTINGS.uiAccent)
  };
}

function normalizeColor(value, fallback) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function normalizeBooleanSetting(value, legacyValue, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof legacyValue === "boolean") return legacyValue;
  return fallback;
}

function normalizeVoice(value) {
  return typeof value === "string" ? value : "";
}

const SAVED_VOCAB_STORAGE_KEY = "savedVocab";
const SAVED_VOCAB_LIMIT = 5000;

function normalizeVocabEntry(entry = {}) {
  const clean = (value) => (typeof value === "string" ? value : "");
  const hanzi = clean(entry.hanzi).trim();
  if (!hanzi) return null;
  return {
    hanzi,
    pinyin: clean(entry.pinyin),
    jyutping: clean(entry.jyutping),
    english: clean(entry.english),
    fullEnglish: clean(entry.fullEnglish),
    hsk: clean(entry.hsk),
    savedAt: Number(entry.savedAt) || Date.now()
  };
}

async function getSavedVocab() {
  const stored = await ext.storage.local.get(SAVED_VOCAB_STORAGE_KEY);
  const entries = stored?.[SAVED_VOCAB_STORAGE_KEY];
  return Array.isArray(entries) ? entries.map(normalizeVocabEntry).filter(Boolean) : [];
}

async function saveVocabEntry(entry) {
  const normalized = normalizeVocabEntry(entry);
  if (!normalized) return getSavedVocab();
  const entries = (await getSavedVocab()).filter((item) => item.hanzi !== normalized.hanzi);
  entries.unshift(normalized);
  if (entries.length > SAVED_VOCAB_LIMIT) entries.length = SAVED_VOCAB_LIMIT;
  await ext.storage.local.set({ [SAVED_VOCAB_STORAGE_KEY]: entries });
  return entries;
}

async function removeVocabEntry(hanzi) {
  const entries = (await getSavedVocab()).filter((item) => item.hanzi !== hanzi);
  await ext.storage.local.set({ [SAVED_VOCAB_STORAGE_KEY]: entries });
  return entries;
}

async function getSettings() {
  const stored = await ext.storage.local.get(DEFAULT_SETTINGS);
  return normalizeSettings(stored);
}

async function setSettings(settings) {
  const normalized = normalizeSettings(settings);
  await ext.storage.local.set(normalized);
  return normalized;
}

const ANNOTATOR_PUNCTUATION_MAP = {
  "\uFF0C": ",",
  "\u3002": ".",
  "\u3001": ",",
  "\uFF1B": ";",
  "\uFF1A": ":",
  "\uFF1F": "?",
  "\uFF01": "!",
  "\uFF08": "(",
  "\uFF09": ")",
  "\uFF3B": "[",
  "\uFF3D": "]",
  "\u3010": "[",
  "\u3011": "]",
  "\u300A": "<",
  "\u300B": ">",
  "\u300C": "\"",
  "\u300D": "\"",
  "\u300E": "\"",
  "\u300F": "\"",
  "\u201C": "\"",
  "\u201D": "\"",
  "\u2018": "'",
  "\u2019": "'",
  "\u2014": "-",
  "\u2026": "..."
};

function normalizeTextForAnnotator(text) {
  return Array.from(String(text || "")).map((char) => ANNOTATOR_PUNCTUATION_MAP[char] || char).join("");
}

// The engine's `annotate(..., contextL_u8, contextR_u8)` expects the context as
// a UTF-8 byte string — the same encoding it applies to the main input
// internally. Passing a raw JS string makes its escape()/decodeURIComponent()
// context decoding throw "URI malformed" on any non-ASCII (e.g. Chinese)
// character, which bubbles up and silently drops annotation for that node.
// Normalize punctuation first, then encode to UTF-8 the way the engine expects.
function encodeAnnotatorContext(text) {
  const normalized = normalizeTextForAnnotator(text);
  return unescape(encodeURIComponent(normalized));
}

async function annotateText({ text, leftContext = "", rightContext = "", settings = {} }) {
  const annotator = globalThis.PinyinWebAnnotator;
  const sourceText = String(text || "");
  const annotatorText = normalizeTextForAnnotator(sourceText);
  const annotatorLeftContext = encodeAnnotatorContext(leftContext);
  const annotatorRightContext = encodeAnnotatorContext(rightContext);
  const pinyinHtml = annotator.annotate(annotatorText, 0, 2, 0, annotatorLeftContext, annotatorRightContext);
  const jyutpingHtml = annotator.annotate(annotatorText, 3, 2, 0, annotatorLeftContext, annotatorRightContext);
  const result = {
    pinyinHtml,
    jyutpingHtml,
    annotatorText,
    cedictGlosses: settings.showEnglish ? await lookupCedictGlosses(sourceText) : Object.create(null),
    hskLevels: settings.showHsk ? await lookupHskLevels(sourceText) : Object.create(null)
  };

  const needsCharacterFallback =
    sourceText &&
    sourceText.length <= 120 &&
    hasChinese(sourceText) &&
    (!/<ruby/i.test(pinyinHtml) || !/<ruby/i.test(jyutpingHtml));
  if (needsCharacterFallback) {
    const characterText = Array.from(annotatorText).map((char) => hasChinese(char) ? char : " ").join(" ");
    if (!/<ruby/i.test(pinyinHtml)) {
      result.charPinyinHtml = annotator.annotate(characterText, 0, 2, 0, "", "");
    }
    if (!/<ruby/i.test(jyutpingHtml)) {
      result.charJyutpingHtml = annotator.annotate(characterText, 3, 2, 0, "", "");
    }
  }

  return result;
}

function createContextMenus() {
  ext.contextMenus.create({
    id: "convert-traditional",
    title: "Convert to Traditional",
    contexts: ["selection"]
  });
  ext.contextMenus.create({
    id: "convert-simplified",
    title: "Convert to Simplified",
    contexts: ["selection"]
  });
  ext.contextMenus.create({
    id: "read-aloud-jyutping",
    title: "Read Selected (Jyutping)",
    contexts: ["selection"]
  });
  ext.contextMenus.create({
    id: "read-aloud-pinyin",
    title: "Read Selected (Pinyin)",
    contexts: ["selection"]
  });
  ext.contextMenus.create({
    id: "read-aloud-english",
    title: "Read Selected (English)",
    contexts: ["selection"]
  });
  ext.contextMenus.create({
    id: "stroke-order-simplified",
    title: "Show Stroke Order (Simplified)",
    contexts: ["selection", "page"]
  });
  ext.contextMenus.create({
    id: "stroke-order-traditional",
    title: "Show Stroke Order (Traditional)",
    contexts: ["selection", "page"]
  });
}

function resetContextMenus() {
  try {
    const result = ext.contextMenus.removeAll();
    if (result && typeof result.then === "function") {
      result.then(createContextMenus).catch((error) => console.warn("Combined Annotator menu setup error:", error));
      return;
    }
  } catch (error) {
    console.warn("Combined Annotator menu reset error:", error);
  }
  createContextMenus();
}

resetContextMenus();
ext.runtime.onInstalled.addListener(resetContextMenus);
ext.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId.startsWith("convert-") || info.menuItemId.startsWith("read-aloud-") || info.menuItemId.startsWith("stroke-order-")) {
    ext.tabs.sendMessage(tab.id, {
      type: "context-menu-action",
      action: info.menuItemId,
      selectionText: info.selectionText
    });
  }
});

ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!message || typeof message !== "object") return null;

    if (message.type === "get-settings") {
      return getSettings();
    }

    if (message.type === "set-settings") {
      return setSettings(message.settings);
    }

    if (message.type === "ensure-hanzi-writer") {
      // Inject the stroke-order library on demand into the requesting frame's
      // content-script world, instead of loading its ~37 KB into every frame.
      if (!sender?.tab?.id) return { ok: false };
      try {
        await ext.scripting.executeScript({
          target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] },
          files: ["hanzi-writer.min.js"]
        });
        return { ok: true };
      } catch (error) {
        console.warn("Combined Annotator: could not inject hanzi-writer", error);
        return { ok: false };
      }
    }

    if (message.type === "get-stroke-data") {
      return { data: await getStrokeData(String(message.char || "")) };
    }

    if (message.type === "get-vocab") {
      return { entries: await getSavedVocab() };
    }

    if (message.type === "save-vocab") {
      return { entries: await saveVocabEntry(message.entry) };
    }

    if (message.type === "remove-vocab") {
      return { entries: await removeVocabEntry(message.hanzi) };
    }

    if (message.type === "clear-vocab") {
      await ext.storage.local.set({ [SAVED_VOCAB_STORAGE_KEY]: [] });
      return { entries: [] };
    }

    if (message.type === "convert-text") {
      const converter = globalThis.CombinedConverter;
      const source = String(message.text || "");
      if (!converter) return { text: source };
      const text = message.mode === "traditional"
        ? converter.toTraditional(source)
        : converter.toSimplified(source);
      return { text };
    }

    if (message.type === "convert-texts") {
      const converter = globalThis.CombinedConverter;
      const inputs = Array.isArray(message.texts) ? message.texts.map((value) => String(value || "")) : [];
      if (!converter) return { texts: inputs };
      const convert = message.mode === "traditional" ? converter.toTraditional : converter.toSimplified;
      return { texts: inputs.map((value) => convert(value)) };
    }

    if (message.type === "annotate-text") {
      const active = normalizeSettings(message.settings);
      await Promise.all([
        ensureAnnotatorData(),
        ensureAnnotationCacheReady(),
        (active.showEnglish || active.showHsk) ? ensureDictionaries() : Promise.resolve()
      ]);

      const key = annotationCacheKey(message.text || "", active);
      const cached = annotationResponseCache.get(key);
      if (cached) return cached;

      const response = await annotateText({ ...message, settings: active });
      rememberAnnotationResponse(key, response);
      return response;
    }

    return null;
  })()
    .then(sendResponse)
    .catch((error) => {
      console.error("Combined Annotator background error:", error);
      sendResponse({ error: error.message || String(error) });
    });

  return true;
});

ext.commands.onCommand.addListener(async (command) => {
  const current = await getSettings();
  if (command === "toggle-jyutping") current.showJyutping = !current.showJyutping;
  if (command === "toggle-pinyin") current.showPinyin = !current.showPinyin;
  if (command === "toggle-english") current.showEnglish = !current.showEnglish;
  const saved = await setSettings(current);

  // Keep every tab in sync, not just the focused one, so annotations stay
  // consistent across windows and background tabs.
  const tabs = await ext.tabs.query({});
  for (const tab of tabs) {
    if (tab.id == null) continue;
    Promise.resolve(ext.tabs.sendMessage(tab.id, { type: "settings-updated", settings: saved })).catch(() => {});
  }
});