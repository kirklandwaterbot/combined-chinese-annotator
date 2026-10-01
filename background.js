// Chrome runs the background as a single service-worker file, so the shared
// engine scripts have to be pulled in here. Firefox instead lists them under
// "background.scripts" in manifest.firefox.json, where importScripts is
// undefined and globalThis.OpenCC is populated before this file runs.
if (typeof importScripts === "function") {
  if (!globalThis.CombinedAnnotatorCore) importScripts("core.js", "user-store.js", "stroke-codec-v2.js");
  if (typeof globalThis.OpenCC === "undefined") importScripts("opencc.js", "converter.js", "pinyin-web-engine.js");
}

const ext = typeof browser !== "undefined" ? browser : chrome;
const Core = globalThis.CombinedAnnotatorCore;
const UserStore = globalThis.CombinedAnnotatorUserStore;
const DEFAULT_SETTINGS = Core.DEFAULT_SETTINGS;
const AZURE_SPEECH_CONFIG_KEY = "azureSpeechConfigV1";
const AZURE_SPEECH_DATA_TYPES = Object.freeze(["authenticationInfo", "websiteContent"]);
const AZURE_SPEECH_MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const TTS_DIAGNOSTIC_LOG_KEY = "ttsDiagnosticLogV1";
const TTS_DIAGNOSTIC_LOG_LIMIT = 200;
let ttsDiagnosticWriteQueue = Promise.resolve();
const editorCopyStateByTab = new Map();
ext.tabs?.onRemoved?.addListener((tabId) => editorCopyStateByTab.delete(tabId));

function recordTtsDiagnostic(input = {}) {
  const entry = Core.sanitizeTtsDiagnosticEntry({ ...input, timestamp: new Date().toISOString() });
  ttsDiagnosticWriteQueue = ttsDiagnosticWriteQueue
    .catch(() => undefined)
    .then(async () => {
      const stored = await ext.storage.local.get(TTS_DIAGNOSTIC_LOG_KEY);
      const existing = Array.isArray(stored?.[TTS_DIAGNOSTIC_LOG_KEY]) ? stored[TTS_DIAGNOSTIC_LOG_KEY] : [];
      const entries = [...existing, entry].slice(-TTS_DIAGNOSTIC_LOG_LIMIT);
      await ext.storage.local.set({ [TTS_DIAGNOSTIC_LOG_KEY]: entries });
      return entry;
    });
  return ttsDiagnosticWriteQueue.catch((error) => {
    console.warn("Combined Annotator: could not save TTS diagnostic event", error);
    return entry;
  });
}

async function getTtsDiagnosticLog() {
  await ttsDiagnosticWriteQueue.catch(() => undefined);
  const stored = await ext.storage.local.get(TTS_DIAGNOSTIC_LOG_KEY);
  const entries = Array.isArray(stored?.[TTS_DIAGNOSTIC_LOG_KEY]) ? stored[TTS_DIAGNOSTIC_LOG_KEY] : [];
  return entries.slice(-TTS_DIAGNOSTIC_LOG_LIMIT).map((entry) => Core.sanitizeTtsDiagnosticEntry(entry));
}

async function clearTtsDiagnosticLog() {
  ttsDiagnosticWriteQueue = ttsDiagnosticWriteQueue
    .catch(() => undefined)
    .then(() => ext.storage.local.remove(TTS_DIAGNOSTIC_LOG_KEY));
  await ttsDiagnosticWriteQueue;
  return [];
}

function speechDiagnosticError(message, code, httpStatus) {
  const error = new Error(message);
  error.diagnosticCode = code;
  if (Number.isFinite(httpStatus)) error.httpStatus = httpStatus;
  return error;
}

// Deduplicate write operations: content scripts include a requestId so that
// retries after service-worker eviction don't cause duplicate writes.
// Max 200 entries to bound memory.
const completedRequestIds = new Set();

async function getAzureSpeechConfig() {
  const stored = await ext.storage.local.get(AZURE_SPEECH_CONFIG_KEY);
  const raw = stored?.[AZURE_SPEECH_CONFIG_KEY];
  return {
    key: typeof raw?.key === "string" ? raw.key.trim().slice(0, 512) : "",
    region: Core.normalizeAzureSpeechRegion(raw?.region)
  };
}

async function setAzureSpeechConfig(input = {}) {
  if (input.clear === true) {
    await ext.storage.local.remove(AZURE_SPEECH_CONFIG_KEY);
    await recordTtsDiagnostic({ event: "azure.config.cleared", backend: "azure" });
    return { configured: false, region: "eastus" };
  }
  const current = await getAzureSpeechConfig();
  const key = typeof input.key === "string" && input.key.trim()
    ? input.key.trim().slice(0, 512)
    : current.key;
  const region = Core.normalizeAzureSpeechRegion(input.region, current.region || "eastus");
  if (!key) throw new Error("Enter an Azure Speech resource key before enabling Azure Neural voices.");
  await ext.storage.local.set({ [AZURE_SPEECH_CONFIG_KEY]: { key, region } });
  await recordTtsDiagnostic({ event: "azure.config.saved", backend: "azure", region });
  return { configured: true, region };
}

async function hasAzureSpeechDataPermission() {
  const optional = ext.runtime.getManifest()?.browser_specific_settings?.gecko?.data_collection_permissions?.optional;
  if (!Array.isArray(optional) || !AZURE_SPEECH_DATA_TYPES.every((type) => optional.includes(type))) return true;
  if (typeof ext.permissions?.contains !== "function") return false;
  try {
    return await ext.permissions.contains({ data_collection: [...AZURE_SPEECH_DATA_TYPES] });
  } catch {
    return false;
  }
}

async function getEditorCompatibilityDiagnostics(tabId = null) {
  const manifest = ext.runtime.getManifest();
  const activeSettings = normalizeSettings(await getSettings());
  const azure = await getAzureSpeechConfig();
  let clipboardPermissionGranted = manifest.permissions?.includes("clipboardRead") === true;
  if (!clipboardPermissionGranted && typeof ext.permissions?.contains === "function") {
    try {
      clipboardPermissionGranted = await ext.permissions.contains({ permissions: ["clipboardRead"] });
    } catch {
      clipboardPermissionGranted = false;
    }
  }
  const copyState = Number.isInteger(tabId) ? editorCopyStateByTab.get(tabId) : null;
  return {
    backgroundRuntimeReady: true,
    extensionVersion: manifest.version || "unknown",
    compatibilityEnabled: Boolean(activeSettings.clipboardEditorSupport),
    clipboardPermissionDeclared: manifest.permissions?.includes("clipboardRead") === true
      || manifest.optional_permissions?.includes("clipboardRead") === true,
    clipboardPermissionGranted,
    configuredBackend: activeSettings.speechBackend,
    azureConfigured: Boolean(azure.key),
    azureRegion: azure.region,
    azureDataPermissionGranted: await hasAzureSpeechDataPermission(),
    recentEditorCopy: copyState ? {
      observed: true,
      ageMs: Math.max(0, Date.now() - copyState.observedAt),
      frameId: copyState.frameId,
      source: copyState.source || "copy-event"
    } : { observed: false, ageMs: null, frameId: null, source: null },
    azureVoices: {
      english: Core.azureSpeechVoiceForLanguage("en-US").voice,
      mandarin: Core.azureSpeechVoiceForLanguage("zh-CN").voice,
      cantonese: Core.azureSpeechVoiceForLanguage("zh-HK").voice
    }
  };
}

async function getEditorSelectionLogoDiagnostics(tabId) {
  if (!Number.isInteger(tabId)) return { error: "No editor tab is available.", frames: [] };
  let frames = [];
  try {
    frames = await ext.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => ({ readyState: document.readyState })
    });
  } catch (error) {
    return { error: String(error?.message || error).slice(0, 300), frames: [] };
  }
  const reports = await Promise.all((frames || []).map(async ({ frameId, result }) => {
    try {
      const report = await sendTabMessageToFrame(tabId, {
        type: "run-selection-logo-diagnostics",
        reason: "background-cross-frame-request"
      }, frameId);
      return { frameId, reachable: true, pageReadyState: result?.readyState || "unknown", report };
    } catch (error) {
      return {
        frameId,
        reachable: false,
        pageReadyState: result?.readyState || "unknown",
        error: String(error?.message || error).slice(0, 300)
      };
    }
  }));
  return {
    tabId,
    frameCount: reports.length,
    reachableFrameCount: reports.filter((item) => item.reachable).length,
    frames: reports
  };
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}

async function synthesizeAzureSpeech(message = {}) {
  const startedAt = Date.now();
  const requestId = String(message.requestId || `azure-${startedAt}-${Math.random().toString(36).slice(2, 8)}`).slice(0, 160);
  const requestedTextLength = String(message.text || "").trim().length;
  let region = "";
  let request = null;
  let response = null;
  await recordTtsDiagnostic({
    event: "azure.request.received", requestId, backend: "azure", lang: message.lang,
    textLength: requestedTextLength, rate: message.rate, pitch: message.pitch
  });
  try {
    const permissionGranted = await hasAzureSpeechDataPermission();
    if (!permissionGranted) {
      throw speechDiagnosticError("Firefox permission to send spoken text and the Azure key has not been granted. Re-enable Azure from the Speech panel.", "permission-denied");
    }
    const config = await getAzureSpeechConfig();
    region = config.region;
    if (!config.key) {
      throw speechDiagnosticError("Azure Speech is not configured. Add the resource key and region in the Speech panel.", "not-configured");
    }
    request = Core.buildAzureSpeechRequest(message);
    if (!request.text) throw speechDiagnosticError("There is no text to speak.", "empty-text");

    await recordTtsDiagnostic({
      event: "azure.request.started", requestId, backend: "azure", region,
      lang: request.lang, voice: request.voice, textLength: request.text.length,
      rate: request.rate, pitch: request.pitch, permissionGranted
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      response = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: "POST",
        headers: {
          "Content-Type": "application/ssml+xml",
          "Ocp-Apim-Subscription-Key": config.key,
          "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3"
        },
        body: request.ssml,
        signal: controller.signal
      });
    } catch (error) {
      if (error?.name === "AbortError") throw speechDiagnosticError("Azure Speech timed out after 25 seconds.", "timeout");
      throw speechDiagnosticError(`Could not reach Azure Speech: ${error?.message || String(error)}`, "network");
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw speechDiagnosticError("Azure rejected the Speech key or region.", "authentication", response.status);
      }
      if (response.status === 429) {
        throw speechDiagnosticError("Azure Speech quota or rate limit reached.", "quota", response.status);
      }
      throw speechDiagnosticError(`Azure Speech request failed with HTTP ${response.status}.`, "http", response.status);
    }
    const audio = await response.arrayBuffer();
    if (!audio.byteLength) throw speechDiagnosticError("Azure Speech returned empty audio.", "empty-audio", response.status);
    if (audio.byteLength > AZURE_SPEECH_MAX_AUDIO_BYTES) {
      throw speechDiagnosticError("Azure Speech audio exceeded the 8 MB safety limit.", "audio-too-large", response.status);
    }
    const durationMs = Date.now() - startedAt;
    const mimeType = response.headers.get("content-type") || "audio/mpeg";
    await recordTtsDiagnostic({
      event: "azure.request.succeeded", requestId, backend: "azure", region,
      lang: request.lang, voice: request.voice, textLength: request.text.length,
      durationMs, httpStatus: response.status, audioBytes: audio.byteLength, mimeType
    });
    return {
      audioBase64: arrayBufferToBase64(audio), mimeType, voice: request.voice,
      lang: request.lang, requestId, durationMs, audioBytes: audio.byteLength
    };
  } catch (error) {
    await recordTtsDiagnostic({
      event: "azure.request.failed", requestId, backend: "azure", region,
      lang: request?.lang || message.lang, voice: request?.voice,
      textLength: request?.text?.length ?? requestedTextLength,
      durationMs: Date.now() - startedAt, httpStatus: error?.httpStatus || response?.status,
      errorCode: error?.diagnosticCode || "unexpected", error: error?.message || String(error)
    });
    throw error;
  }
}

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
      if (Array.isArray(merged[mergeKey]) && Array.isArray(chunk[mergeKey])) {
        merged[mergeKey].push(...chunk[mergeKey]);
      } else {
        Object.assign(merged[mergeKey], chunk[mergeKey]);
      }
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
const DICT_DB_VERSION = 3;
const DICT_DATA_VERSION = "2026-08-04.1"; // pinned CC-CEDICT runtime projection
const DICT_STORE_META = "meta";
const DICT_STORE_CEDICT = "cedict";
const DICT_STORE_HSK = "hsk";

let cedictMaxKeyLength = 12;
let hskMaxKeyLength = 4;
let cedictEntries = null; // in-memory fallback, only populated if IDB fails
let hskEntries = null;
let dictDb = null;
let dictReady = null;
let cedictClassifierEntries = null;
let cedictClassifiersReady = null;

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
      for (const store of [DICT_STORE_META, DICT_STORE_CEDICT, DICT_STORE_HSK]) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      }
      if (db.objectStoreNames.contains("stroke")) db.deleteObjectStore("stroke");
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

async function clearDictionary(db, store) {
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).clear();
  await idbTxDone(tx);
}

function expandCedictRecords(data) {
  if (data?.entries && !Array.isArray(data.entries)) return data.entries;
  const entries = Object.create(null);
  for (const record of data?.records || []) {
    const traditional = String(record?.[0] || "");
    const simplified = String(record?.[1] || traditional);
    const gloss = String(record?.[2] || "").trim();
    for (const form of new Set([traditional, simplified])) {
      if (!form || !gloss) continue;
      const existing = entries[form];
      entries[form] = existing && existing !== gloss ? `${existing}; ${gloss}` : gloss;
    }
  }
  return entries;
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
          loadChunkedJSON("ccedict-glosses", "records"),
          fetch(ext.runtime.getURL("hsk-data.json")).then((r) => r.json())
        ]);
        cedictMaxKeyLength = cedict._meta?.maxKeyLength || cedict.maxKeyLength || 12;
        hskMaxKeyLength = hsk._meta?.maxKeyLength || 4;
        const cedictForms = expandCedictRecords(cedict);
        await clearDictionary(db, DICT_STORE_CEDICT);
        await clearDictionary(db, DICT_STORE_HSK);
        await importDictionary(db, DICT_STORE_CEDICT, cedictForms);
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
    const cedict = await loadChunkedJSON("ccedict-glosses", "records");
    cedictEntries = expandCedictRecords(cedict);
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

// Stroke records are fetched from the one compact shard selected by code point. Decoded characters are cached individually.
const strokeShardPromises = new Map();
const decodedStrokeCache = new Map();
const DECODED_STROKE_CACHE_LIMIT = 400;

async function getStrokeData(char) {
  const character = Array.from(String(char || ""))[0] || "";
  if (!character) return null;
  if (decodedStrokeCache.has(character)) return decodedStrokeCache.get(character);
  const shard = (character.codePointAt(0) % 64).toString(16).padStart(2, "0");
  if (!strokeShardPromises.has(shard)) {
    strokeShardPromises.set(shard, fetch(ext.runtime.getURL(`stroke-data/${shard}.bin`))
      .then((response) => {
        if (!response.ok) throw new Error(`Stroke shard ${shard} is unavailable`);
        return response.arrayBuffer();
      })
      .then((payload) => globalThis.CombinedAnnotatorStrokeCodec.decodeShard(payload))
      .catch((error) => {
        strokeShardPromises.delete(shard);
        throw error;
      }));
  }
  const encoded = (await strokeShardPromises.get(shard)).get(character);
  if (!encoded) return null;
  const decoded = globalThis.CombinedAnnotatorStrokeCodec.decodeRecord(encoded);
  decodedStrokeCache.set(character, decoded);
  while (decodedStrokeCache.size > DECODED_STROKE_CACHE_LIMIT) {
    decodedStrokeCache.delete(decodedStrokeCache.keys().next().value);
  }
  return decoded;
}

async function runBackgroundDiagnostics() {
  const checks = [];
  const add = (status, label, detail) => checks.push({ status, label, detail: String(detail || "") });
  const manifest = ext.runtime.getManifest();

  add("pass", "Background runtime", `Responding — extension ${manifest.version || "unknown"}`);
  add(typeof ensureContentRuntime === "function" ? "pass" : "fail", "Extension reload recovery", typeof ensureContentRuntime === "function" ? "Ready" : "Missing");
  add(typeof Core?.normalizeSettings === "function" ? "pass" : "fail", "Core library", typeof Core?.normalizeSettings === "function" ? "Loaded" : "Missing");
  add(typeof globalThis.CombinedAnnotatorStrokeCodec?.decodeRecord === "function" ? "pass" : "fail", "Stroke codec", typeof globalThis.CombinedAnnotatorStrokeCodec?.decodeRecord === "function" ? "Loaded" : "Missing");

  let activeSettings = null;
  try {
    activeSettings = normalizeSettings(await getSettings());
    add("pass", "Settings storage", "Readable and valid");
  } catch (error) {
    add("fail", "Settings storage", error?.message || String(error));
  }

  try {
    const samples = await Promise.all(["低", "漢"].map(async (character) => [character, await getStrokeData(character)]));
    const invalid = samples.filter(([, data]) => !data || !Array.isArray(data.strokes) || !data.strokes.length || data.strokes.length !== data.medians?.length);
    if (invalid.length) {
      add("fail", "Packaged stroke data", `Invalid data for ${invalid.map(([character]) => character).join(", ")}`);
    } else {
      add("pass", "Packaged stroke data", samples.map(([character, data]) => `${character}: ${data.strokes.length} strokes`).join("; "));
    }
  } catch (error) {
    add("fail", "Packaged stroke data", error?.message || String(error));
  }

  try {
    const azure = await getAzureSpeechConfig();
    if (activeSettings?.speechBackend === "azure") {
      add(azure.key ? "pass" : "fail", "Azure speech configuration", azure.key ? `Configured for ${azure.region}` : "Azure is selected but no key is configured");
    } else {
      add("info", "Azure speech configuration", azure.key ? `Configured for ${azure.region}; browser voices are currently selected` : "Not configured; browser voices are currently selected");
    }
  } catch (error) {
    add("warn", "Azure speech configuration", error?.message || String(error));
  }

  return {
    ok: !checks.some((check) => check.status === "fail"),
    checkedAt: new Date().toISOString(),
    version: manifest.version || "unknown",
    checks
  };
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
function invalidateAnnotationResponses() {
  annotationResponseCache.clear();
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

async function ensureCedictClassifiers() {
  if (!cedictClassifiersReady) {
    cedictClassifiersReady = fetch(ext.runtime.getURL("lexicon-data/classifiers.json"))
      .then((response) => response.ok ? response.json() : Object.create(null))
      .then((entries) => { cedictClassifierEntries = entries || Object.create(null); })
      .catch((error) => {
        console.warn("Combined Annotator: classifier data unavailable", error);
        cedictClassifierEntries = Object.create(null);
      });
  }
  await cedictClassifiersReady;
}

async function lookupCedictClassifiers(text) {
  await ensureCedictClassifiers();
  const result = Object.create(null);
  for (const key of collectChineseKeyCandidates(text, cedictMaxKeyLength)) {
    const records = cedictClassifierEntries?.[key];
    if (!Array.isArray(records)) continue;
    result[key] = records.map((item) => ({
      traditional: String(item?.[0] || ""),
      simplified: String(item?.[1] || item?.[0] || ""),
      pinyin: String(item?.[2] || "")
    }));
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
let customDictionaryCache = null;

async function lookupCustomOverrides(text) {
  const source = String(text || "");
  if (!source || !hasChinese(source)) return Object.create(null);
  if (!customDictionaryCache) customDictionaryCache = UserStore.getCustomEntries();
  const entries = await customDictionaryCache;
  const result = Object.create(null);
  for (const entry of entries) {
    for (const form of Core.uniqueStrings([entry.headword, entry.simplified, entry.traditional], 3, 80)) {
      if (!source.includes(form)) continue;
      const existing = result[form];
      if (!existing) {
        result[form] = {
          pinyin: entry.pinyin || "",
          jyutping: entry.jyutping || "",
          definitions: entry.definitions || [],
          mode: entry.mode || "merge"
        };
      } else {
        existing.pinyin ||= entry.pinyin || "";
        existing.jyutping ||= entry.jyutping || "";
        existing.definitions = Core.uniqueStrings([...(existing.definitions || []), ...(entry.definitions || [])], 30, 1000);
        if (entry.mode === "replace") existing.mode = "replace";
      }
    }
  }
  return result;
}


function normalizeSettings(settings = {}) {
  return Core.normalizeSettings(settings);
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
  return UserStore.getVocab();
}

async function saveVocabEntry(entry) {
  const saved = await UserStore.saveVocab(entry, entry?.context || null);
  return { saved, entries: await UserStore.getVocab() };
}

async function removeVocabEntry(idOrHanzi) {
  return UserStore.removeVocab(idOrHanzi);
}

async function getSettings() {
  return UserStore.getSettings();
}

async function setSettings(settings) {
  return UserStore.setSettings(settings);
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
    hskLevels: settings.showHsk ? await lookupHskLevels(sourceText) : Object.create(null),
    customOverrides: await lookupCustomOverrides(sourceText)
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

function decodeHtmlText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function readingFromRuby(html) {
  return [...String(html || "").matchAll(/<rt[^>]*>([\s\S]*?)<\/rt>/gi)]
    .map((match) => decodeHtmlText(match[1]))
    .filter(Boolean)
    .join(" ");
}

function overlapsOffset(text, phrase, offset) {
  let found = text.indexOf(phrase);
  while (found >= 0) {
    if (offset >= found && offset < found + phrase.length) return true;
    found = text.indexOf(phrase, found + 1);
  }
  return false;
}

async function dictionaryLookup(message = {}) {
  const sourceText = String(message.text || message.headword || "").slice(0, 500);
  const requestedHeadword = String(message.headword || "").trim();
  const offset = Math.max(0, Math.min(sourceText.length - 1, Number(message.offset) || 0));
  if (!sourceText) return { entries: [] };
  await Promise.all([ensureAnnotatorData(), ensureDictionaries()]);
  const windowStart = Math.max(0, offset - cedictMaxKeyLength + 1);
  const lookupWindow = sourceText.slice(windowStart, Math.min(sourceText.length, offset + cedictMaxKeyLength));
  const [glosses, classifiers, levels, customEntries, vocabulary] = await Promise.all([
    lookupCedictGlosses(lookupWindow),
    lookupCedictClassifiers(lookupWindow),
    lookupHskLevels(lookupWindow),
    UserStore.getCustomEntries(),
    UserStore.getVocab()
  ]);
  const customByWord = new Map();
  for (const entry of customEntries) {
    for (const form of [entry.headword, entry.simplified, entry.traditional]) {
      if (!form) continue;
      if (!customByWord.has(form)) customByWord.set(form, []);
      customByWord.get(form).push(entry);
    }
  }
  const words = new Set();
  for (const word of Object.keys(glosses)) {
    if (word === requestedHeadword || overlapsOffset(sourceText, word, offset)) words.add(word);
  }
  for (const word of customByWord.keys()) {
    if (word === requestedHeadword || overlapsOffset(sourceText, word, offset)) words.add(word);
  }
  if (requestedHeadword) words.add(requestedHeadword);
  if (!words.size) {
    const char = Array.from(sourceText)[offset] || Array.from(sourceText)[0];
    if (char && hasChinese(char)) words.add(char);
  }
  const converter = globalThis.CombinedConverter;
  const entries = [];
  for (const headword of [...words].sort((a, b) => b.length - a.length || a.localeCompare(b)).slice(0, 16)) {
    const pinyinHtml = globalThis.PinyinWebAnnotator.annotate(normalizeTextForAnnotator(headword), 0, 2, 0, "", "");
    const jyutpingHtml = globalThis.PinyinWebAnnotator.annotate(normalizeTextForAnnotator(headword), 3, 2, 0, "", "");
    const parsed = Core.parseCedictGloss(glosses[headword] || "");
    const custom = customByWord.get(headword) || [];
    const replacing = custom.find((item) => item.mode === "replace");
    const mergedDefinitions = Core.uniqueStrings([
      ...custom.flatMap((item) => item.definitions || []),
      ...(replacing ? [] : parsed.senses)
    ], 40, 1000);
    const preferred = custom[0] || null;
    const saved = vocabulary.find((item) => [item.hanzi, item.simplified, item.traditional].includes(headword));
    const savedContexts = saved?.contexts || [];

    entries.push({
      headword,
      simplified: preferred?.simplified || converter?.toSimplified(headword) || headword,
      traditional: preferred?.traditional || converter?.toTraditional(headword) || headword,
      pinyin: preferred?.pinyin || readingFromRuby(pinyinHtml),
      jyutping: preferred?.jyutping || readingFromRuby(jyutpingHtml),
      senses: mergedDefinitions,
      classifiers: classifiers[headword] || parsed.classifiers,
      references: parsed.references,
      hsk: levels[headword] ? String(levels[headword] >= 7 ? "7-9" : levels[headword]) : "",
      customEntries: custom,
      sentence: String(message.sentence || "").slice(0, 500),
      savedContexts
    });
  }
  return { entries };
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
    title: "Read Selected/Copied (Cantonese)",
    contexts: ["selection", "page"]
  });
  ext.contextMenus.create({
    id: "read-aloud-pinyin",
    title: "Read Selected/Copied (Mandarin)",
    contexts: ["selection", "page"]
  });
  ext.contextMenus.create({
    id: "read-aloud-english",
    title: "Read Selected/Copied (English)",
    contexts: ["selection", "page"]
  });
  ext.contextMenus.create({
    id: "open-reader",
    title: "Open in Chinese Reader",
    contexts: ["selection", "page"]
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
  ext.contextMenus.create({
    id: "toggle-site-annotations",
    title: "Toggle Annotations on This Site",
    contexts: ["page"]
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

const CONTENT_RUNTIME_FILES = ["core.js", "content.js", "overlay.js"];
const contentRuntimeRecoveries = new Map();

function isInjectablePageUrl(value) {
  try {
    return ["http:", "https:", "file:", "ftp:"].includes(new URL(String(value || "")).protocol);
  } catch {
    return false;
  }
}

function isMissingContentRuntimeError(error) {
  return /receiving end does not exist|could not establish connection|message (?:channel|port) closed|extension context invalidated/i.test(String(error?.message || error || ""));
}

function staleContentRuntimeCleanup() {
  document.getElementById("combined-annotator-overlay-host")?.remove();
  document.querySelectorAll("[data-ca-stroke-overlay], .ca-dictionary-popup, .ca-speech-notice, .ca-diagnostic-stroke-host").forEach((node) => node.remove());
}

function sendTabMessageToFrame(tabId, payload, frameId = 0) {
  return ext.tabs.sendMessage(tabId, payload, { frameId });
}

async function probeContentRuntime(tabId, frameId = 0, attempts = 3) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await sendTabMessageToFrame(tabId, { type: "runtime-ready" }, frameId);
      if (response?.ready) return response;
    } catch (error) {
      lastError = error;
      if (!isMissingContentRuntimeError(error)) throw error;
    }
    if (attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  if (lastError) throw lastError;
  throw new Error("The page content runtime did not answer its readiness check.");
}

async function injectContentRuntime(tabId, options = {}) {
  const frameId = Number.isInteger(options.frameId) ? options.frameId : 0;
  const target = { tabId, frameIds: [frameId] };
  await ext.scripting.executeScript({ target, func: staleContentRuntimeCleanup });
  await ext.scripting.insertCSS({ target, files: ["annotation.css"] });
  await ext.scripting.executeScript({ target, files: CONTENT_RUNTIME_FILES });
}

async function ensureContentRuntime(tabId, options = {}) {
  const frameId = Number.isInteger(options.frameId) ? options.frameId : 0;
  try {
    return await probeContentRuntime(tabId, frameId);
  } catch (error) {
    if (!isMissingContentRuntimeError(error) && !/readiness check/i.test(String(error?.message || ""))) throw error;
  }

  const key = `${tabId}:${frameId}`;
  if (!contentRuntimeRecoveries.has(key)) {
    const recovery = injectContentRuntime(tabId, { frameId })
      .then(() => probeContentRuntime(tabId, frameId, 2))
      .finally(() => contentRuntimeRecoveries.delete(key));
    contentRuntimeRecoveries.set(key, recovery);
  }
  return contentRuntimeRecoveries.get(key);
}

async function sendTabMessageWithRecovery(tabId, payload, options = {}) {
  const frameId = Number.isInteger(options.frameId) ? options.frameId : 0;
  try {
    return await sendTabMessageToFrame(tabId, payload, frameId);
  } catch (error) {
    if (!isMissingContentRuntimeError(error)) throw error;
  }
  await ensureContentRuntime(tabId, { frameId });
  return sendTabMessageToFrame(tabId, payload, frameId);
}

async function recoverOpenContentRuntimes() {
  const tabs = await ext.tabs.query({});
  const recoveries = tabs
    .filter((tab) => Number.isInteger(tab.id) && isInjectablePageUrl(tab.url))
    .map(async (tab) => {
      const frames = await ext.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => true
      });
      await Promise.allSettled((frames || []).map(({ frameId }) => ensureContentRuntime(tab.id, { frameId })));
    });
  await Promise.allSettled(recoveries);
}

function collectReaderCandidateInFrame() {
  const cleanElementText = (element) => {
    if (!element) return "";
    const clone = element.cloneNode(true);
    clone.querySelectorAll("#combined-annotator-overlay-host, [data-ca-stroke-overlay], .ca-dictionary-popup").forEach((node) => node.remove());
    clone.querySelectorAll(".ca-unit[data-ca-original]").forEach((unit) => {
      unit.replaceWith(document.createTextNode(unit.dataset.caOriginal || ""));
    });
    clone.querySelectorAll(".ca-run[data-ca-original]").forEach((run) => {
      run.replaceWith(document.createTextNode(run.textContent || run.dataset.caOriginal || ""));
    });
    return String(clone.textContent || "").replace(/\s+/g, " ").trim();
  };

  const selection = window.getSelection();
  let text = "";
  let selected = false;
  if (selection && !selection.isCollapsed && selection.rangeCount) {
    const selectedUnits = [];
    const seen = new Set();
    for (let rangeIndex = 0; rangeIndex < selection.rangeCount; rangeIndex++) {
      const range = selection.getRangeAt(rangeIndex);
      for (const unit of document.querySelectorAll(".ca-unit[data-ca-original]")) {
        if (seen.has(unit)) continue;
        try {
          if (!range.intersectsNode(unit)) continue;
        } catch {
          continue;
        }
        seen.add(unit);
        selectedUnits.push(unit);
      }
    }
    if (selectedUnits.length) {
      selectedUnits.sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1);
      text = selectedUnits.map((unit) => unit.dataset.caOriginal || "").join("");
    } else {
      const holder = document.createElement("div");
      for (let rangeIndex = 0; rangeIndex < selection.rangeCount; rangeIndex++) {
        holder.append(selection.getRangeAt(rangeIndex).cloneContents());
      }
      text = cleanElementText(holder);
    }
    selected = /[\u3400-\u9fff\uf900-\ufaff]/.test(text);
  }

  if (!selected) {
    text = cleanElementText(document.querySelector("article, main, [role='main']") || document.body);
  }
  text = String(text || "").trim().slice(0, 25000);
  const hanCount = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  return { text, selected: selected && hanCount > 0, hanCount };
}

async function openReaderInBestFrame(tabId) {
  if (!Number.isInteger(tabId)) return { error: "No active tab is available." };
  const results = await ext.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: collectReaderCandidateInFrame
  });
  const candidates = (results || []).filter((item) => item?.result?.text && item.result.hanCount > 0);
  candidates.sort((a, b) => {
    const selectionDifference = Number(Boolean(b.result.selected)) - Number(Boolean(a.result.selected));
    if (selectionDifference) return selectionDifference;
    const hanDifference = b.result.hanCount - a.result.hanCount;
    if (hanDifference) return hanDifference;
    return b.result.text.length - a.result.text.length;
  });
  const chosen = candidates[0];
  if (!chosen) return { error: "No Chinese text was found on this page." };
  await sendTabMessageWithRecovery(tabId, {
    type: "open-reader",
    text: chosen.result.text
  }, { frameId: chosen.frameId });
  return {
    ok: true,
    frameId: chosen.frameId,
    source: chosen.result.selected ? "selection" : "article"
  };
}

async function convertPageInAllFrames(tabId, action) {
  if (!Number.isInteger(tabId)) return { error: "No active tab is available." };
  if (!["page-traditional", "page-simplified", "page-original"].includes(action)) {
    return { error: "Unknown page conversion action." };
  }
  const frames = await ext.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => true
  });
  const responses = await Promise.all((frames || []).map(async ({ frameId }) => {
    try {
      return await sendTabMessageWithRecovery(tabId, {
        type: "page-conversion-action",
        action
      }, { frameId });
    } catch {
      return null;
    }
  }));
  return {
    ok: true,
    changed: responses.reduce((total, response) => total + Math.max(0, Number(response?.changed) || 0), 0),
    frameCount: responses.filter(Boolean).length
  };
}
ext.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "toggle-site-annotations") {
    (async () => {
      try {
        const hostname = new URL(tab.url).hostname;
        const effective = await UserStore.getEffectiveSettings(hostname);
        const currentlyEnabled = effective.enabled !== false;
        const profile = effective.profile || { hostname, enabled: true, overrides: {} };
        profile.enabled = !currentlyEnabled;
        await UserStore.setProfile(hostname, profile);
        sendTabMessageWithRecovery(tab.id, {
          type: "site-disabled-changed",
          disabled: !profile.enabled
        }, { frameId: Number.isInteger(info.frameId) ? info.frameId : 0 }).catch(() => {});
      } catch (error) {
        console.warn("Combined Annotator: toggle-site-annotations failed", error);
      }
    })();
    return;
  }
  if (info.menuItemId === "open-reader" || info.menuItemId.startsWith("convert-") || info.menuItemId.startsWith("read-aloud-") || info.menuItemId.startsWith("stroke-order-")) {
    console.info("[Combined Annotator][Context menu] dispatch", {
      action: info.menuItemId,
      frameId: Number.isInteger(info.frameId) ? info.frameId : 0,
      selectionLength: String(info.selectionText || "").length,
      tabAvailable: Number.isInteger(tab?.id)
    });
    Promise.resolve(sendTabMessageWithRecovery(tab.id, {
      type: "context-menu-action",
      action: info.menuItemId,
      selectionText: info.selectionText
    }, { frameId: Number.isInteger(info.frameId) ? info.frameId : 0 })).catch((error) => {
      console.warn("Combined Annotator context-menu action failed", error);
    });
  }
});

ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!message || typeof message !== "object") return null;

    if (message.type === "send-tab-message-with-recovery") {
      const tabId = Number(message.tabId);
      if (!Number.isInteger(tabId) || !message.payload || typeof message.payload !== "object") {
        throw new Error("A valid tab and page message are required.");
      }
      return sendTabMessageWithRecovery(tabId, message.payload, {
        frameId: Number.isInteger(message.frameId) ? message.frameId : 0
      });
    }

    if (message.type === "get-settings") {
      if (message.hostname) return UserStore.getEffectiveSettings(message.hostname);
      return getSettings();
    }

    if (message.type === "run-extension-diagnostics") {
      return runBackgroundDiagnostics();
    }

    if (message.type === "get-editor-compatibility-diagnostics") {
      return getEditorCompatibilityDiagnostics(sender?.tab?.id);
    }

    if (message.type === "get-editor-selection-logo-diagnostics") {
      return getEditorSelectionLogoDiagnostics(sender?.tab?.id);
    }

    if (message.type === "editor-copy-observed") {
      if (!Number.isInteger(sender?.tab?.id)) return { recorded: false };
      const observedAt = Math.min(Date.now(), Math.max(0, Number(message.observedAt) || Date.now()));
      editorCopyStateByTab.set(sender.tab.id, {
        observedAt,
        frameId: Number.isInteger(sender.frameId) ? sender.frameId : 0,
        source: ["keyboard-shortcut", "selection-tools"].includes(message.source) ? message.source : "copy-event"
      });
      return { recorded: true, observedAt };
    }

    if (message.type === "get-editor-copy-state") {
      if (!Number.isInteger(sender?.tab?.id)) return { observedAt: 0, ageMs: null };
      const state = editorCopyStateByTab.get(sender.tab.id);
      return state ? { ...state, ageMs: Math.max(0, Date.now() - state.observedAt) } : { observedAt: 0, ageMs: null };
    }

    if (message.type === "set-settings") {
      if (message.requestId && completedRequestIds.has(message.requestId)) return { duplicate: true, requestId: message.requestId };
      const result = await setSettings(message.settings);
      if (message.requestId) {
        completedRequestIds.add(message.requestId);
        if (completedRequestIds.size > 200) completedRequestIds.delete(completedRequestIds.values().next().value);
      }
      return result;
    }

    if (message.type === "get-azure-speech-config") {
      const config = await getAzureSpeechConfig();
      return { configured: Boolean(config.key), region: config.region };
    }

    if (message.type === "set-azure-speech-config") {
      return setAzureSpeechConfig(message);
    }

    if (message.type === "get-tts-diagnostic-log") {
      return { entries: await getTtsDiagnosticLog() };
    }

    if (message.type === "clear-tts-diagnostic-log") {
      return { entries: await clearTtsDiagnosticLog() };
    }

    if (message.type === "speech-state") {
      const detail = message.detail && typeof message.detail === "object" ? message.detail : {};
      const backend = detail.backend === "azure" ? "azure" : "browser";
      await recordTtsDiagnostic({
        ...detail,
        event: `${backend}.playback.${String(detail.state || "event").toLowerCase()}`,
        requestId: detail.id,
        backend
      });
      return { logged: true };
    }

    if (message.type === "synthesize-azure-speech") {
      return synthesizeAzureSpeech(message);
    }

    if (message.type === "get-site-profiles") {
      return { profiles: await UserStore.getProfiles() };
    }

    if (message.type === "set-site-profile") {
      if (message.requestId && completedRequestIds.has(message.requestId)) return { duplicate: true, requestId: message.requestId };
      const profile = await UserStore.setProfile(message.hostname, message.profile);
      const result = { profile, effective: await UserStore.getEffectiveSettings(message.hostname) };
      if (message.requestId) {
        completedRequestIds.add(message.requestId);
        if (completedRequestIds.size > 200) completedRequestIds.delete(completedRequestIds.values().next().value);
      }
      return result;
    }

    if (message.type === "dictionary-lookup") {
      return dictionaryLookup(message);
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
      return { entries: await UserStore.getVocab({ filter: message.filter, search: message.search }) };
    }

    if (message.type === "save-vocab") {
      if (message.requestId && completedRequestIds.has(message.requestId)) return { duplicate: true, requestId: message.requestId };
      const result = await saveVocabEntry({ ...message.entry, context: message.context || message.entry?.context });
      if (message.requestId) {
        completedRequestIds.add(message.requestId);
        if (completedRequestIds.size > 200) completedRequestIds.delete(completedRequestIds.values().next().value);
      }
      return result;
    }

    if (message.type === "remove-vocab") {
      if (message.requestId && completedRequestIds.has(message.requestId)) return { duplicate: true, requestId: message.requestId };
      const result = { entries: await removeVocabEntry(message.id || message.hanzi) };
      if (message.requestId) {
        completedRequestIds.add(message.requestId);
        if (completedRequestIds.size > 200) completedRequestIds.delete(completedRequestIds.values().next().value);
      }
      return result;
    }

    if (message.type === "clear-vocab") {
      return { entries: await UserStore.clearVocab() };
    }

    if (message.type === "get-review-queue") {
      return { entries: await UserStore.getReviewQueue(message.now, message.newLimit || 20) };
    }

    if (message.type === "rate-review") {
      if (message.requestId && completedRequestIds.has(message.requestId)) return { duplicate: true, requestId: message.requestId };
      const result = { review: await UserStore.rateReview(message.wordId, message.rating, message.now) };
      if (message.requestId) {
        completedRequestIds.add(message.requestId);
        if (completedRequestIds.size > 200) completedRequestIds.delete(completedRequestIds.values().next().value);
      }
      return result;
    }

    if (message.type === "undo-review") {
      return { result: await UserStore.undoLastReview() };
    }

    if (message.type === "get-custom-dictionary") {
      return { entries: await UserStore.getCustomEntries(message.headword) };
    }

    if (message.type === "save-custom-entry") {
      if (message.requestId && completedRequestIds.has(message.requestId)) return { duplicate: true, requestId: message.requestId };
      const entry = await UserStore.saveCustomEntry(message.entry);
      customDictionaryCache = null;
      invalidateAnnotationResponses();
      if (message.requestId) {
        completedRequestIds.add(message.requestId);
        if (completedRequestIds.size > 200) completedRequestIds.delete(completedRequestIds.values().next().value);
      }
      // Notify all tabs so they clear their annotation caches and re-annotate
      const tabs = await ext.tabs.query({});
      for (const tab of tabs) {
        try {
          ext.tabs.sendMessage(tab.id, { type: "custom-dictionary-changed" });
        } catch (e) {
          // Tab may not be ready, ignore
        }
      }
      return { entry };
    }

    if (message.type === "remove-custom-entry") {
      if (message.requestId && completedRequestIds.has(message.requestId)) return { duplicate: true, requestId: message.requestId };
      const entries = await UserStore.removeCustomEntry(message.id);
      customDictionaryCache = null;
      invalidateAnnotationResponses();
      if (message.requestId) {
        completedRequestIds.add(message.requestId);
        if (completedRequestIds.size > 200) completedRequestIds.delete(completedRequestIds.values().next().value);
      }
      // Notify all tabs so they clear their annotation caches and re-annotate
      const tabs = await ext.tabs.query({});
      for (const tab of tabs) {
        try {
          ext.tabs.sendMessage(tab.id, { type: "custom-dictionary-changed" });
        } catch (e) {
          // Tab may not be ready, ignore
        }
      }
      return { entries };
    }

    if (message.type === "export-user-data") {
      return { data: await UserStore.exportUserData() };
    }

    if (message.type === "import-user-data") {
      if (message.requestId && completedRequestIds.has(message.requestId)) return { duplicate: true, requestId: message.requestId };
      const result = await UserStore.importUserData(message.data, message.mode);
      customDictionaryCache = null;
      invalidateAnnotationResponses();
      if (message.requestId) {
        completedRequestIds.add(message.requestId);
        if (completedRequestIds.size > 200) completedRequestIds.delete(completedRequestIds.values().next().value);
      }
      return result;
    }

    if (message.type === "import-vocabulary") {
      const result = await UserStore.importDelimited(message.text);
      invalidateAnnotationResponses();
      return result;
    }

    if (message.type === "page-conversion-in-tab") {
      return convertPageInAllFrames(Number(message.tabId), message.action);
    }

    if (message.type === "open-reader-in-tab") {
      return openReaderInBestFrame(Number(message.tabId));
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

    if (message.type === "get-auto-backups") {
      const backups = [];
      for (let i = 1; i <= 5; i++) {
        const stored = await ext.storage.local.get(`autoBackup${i}`);
        const backup = stored[`autoBackup${i}`];
        if (backup) {
          backups.push({ slot: i, timestamp: backup.timestamp, date: backup.date });
        }
      }
      return { backups };
    }

    if (message.type === "restore-auto-backup") {
      const slot = Number(message.slot);
      if (slot < 1 || slot > 5 || !Number.isInteger(slot)) return { error: "Invalid slot" };
      const stored = await ext.storage.local.get(`autoBackup${slot}`);
      const backup = stored[`autoBackup${slot}`];
      if (!backup || !backup.data) return { error: "Backup not found" };
      const result = await UserStore.importUserData(backup.data, "replace");
      customDictionaryCache = null;
      invalidateAnnotationResponses();
      return result;
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

// Reloading a temporary Firefox add-on restarts the background page but leaves
// existing web documents open. Restore their content runtime proactively so
// the old visible controls do not remain disconnected until a page refresh.
recoverOpenContentRuntimes().catch((error) => {
  console.warn("Combined Annotator: existing-tab recovery failed", error);
});

ext.commands.onCommand.addListener(async (command) => {
  const current = await getSettings();
  if (command === "toggle-jyutping") current.showJyutping = !current.showJyutping;
  if (command === "toggle-pinyin") current.showPinyin = !current.showPinyin;
  if (command === "toggle-english") current.showEnglish = !current.showEnglish;
  if (command === "cycle-annotation-layers") {
    // Cycle through: Jyutping only → Pinyin only → English only → All three → None
    const j = current.showJyutping, p = current.showPinyin, e = current.showEnglish;
    if (j && !p && !e)      { current.showJyutping = false; current.showPinyin = true;  current.showEnglish = false; }  // → Pinyin only
    else if (!j && p && !e) { current.showJyutping = false; current.showPinyin = false; current.showEnglish = true;  }  // → English only
    else if (!j && !p && e) { current.showJyutping = true;  current.showPinyin = true;  current.showEnglish = true;  }  // → All three
    else if (j && p && e)   { current.showJyutping = false; current.showPinyin = false; current.showEnglish = false; }  // → None
    else                    { current.showJyutping = true;  current.showPinyin = false; current.showEnglish = false; }  // → Jyutping only (default)
  }
  const saved = await setSettings(current);

  // Keep every tab in sync, not just the focused one, so annotations stay
  // consistent across windows and background tabs.
  const tabs = await ext.tabs.query({});
  for (const tab of tabs) {
    if (tab.id == null) continue;
    Promise.resolve(sendTabMessageWithRecovery(tab.id, { type: "settings-updated", settings: saved })).catch(() => {});
  }
});

// --- Automatic rotating local backups ---

async function performAutoBackup() {
  try {
    const data = await UserStore.exportUserData();
    const timestamp = Date.now();
    const backup = {
      timestamp,
      date: new Date(timestamp).toISOString(),
      data,
      backupType: "auto",
      backupTimestamp: timestamp
    };

    // Read existing backups
    const keys = ["autoBackup1", "autoBackup2", "autoBackup3", "autoBackup4", "autoBackup5"];
    const stored = await ext.storage.local.get(keys);

    // Rotate: shift 4→5, 3→4, 2→3, 1→2
    const toSet = {};
    for (let i = 4; i >= 1; i--) {
      const existing = stored[`autoBackup${i}`];
      if (existing) {
        toSet[`autoBackup${i + 1}`] = existing;
      }
    }
    // Save new backup as autoBackup1
    toSet["autoBackup1"] = backup;
    await ext.storage.local.set(toSet);
  } catch (error) {
    console.warn("Combined Annotator: auto-backup failed", error);
  }
}

// Run backup on startup
performAutoBackup();

// Schedule periodic backup every 24 hours
if (ext.alarms) {
  ext.alarms.create("autoBackup", { periodInMinutes: 24 * 60 });
  ext.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "autoBackup") performAutoBackup();
  });
} else {
  setInterval(performAutoBackup, 24 * 60 * 60 * 1000);
}
