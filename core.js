(function initCombinedAnnotatorCore(global) {
  "use strict";

  const DAY_MS = 24 * 60 * 60 * 1000;
  const TEN_MINUTES_MS = 10 * 60 * 1000;
  const SETTINGS_SCHEMA_VERSION = 3;
  const USER_DATA_SCHEMA_VERSION = 2;
  const CANTONESE_NATURAL_RATE_SCALE = 0.82 / 0.9;
  const PREFERRED_SPEECH_VOICE_NAMES = Object.freeze({
    en: Object.freeze(["jenny", "aria", "guy"]),
    "zh-cn": Object.freeze(["xiaoxiao", "yunxi"]),
    "zh-hk": Object.freeze(["hiumaan", "wanlung"])
  });
  const AZURE_SPEECH_VOICES = Object.freeze({
    "en-US": "en-US-JennyNeural",
    "zh-CN": "zh-CN-XiaochenNeural",
    "zh-HK": "zh-HK-HiuGaaiNeural"
  });

  const DEFAULT_SETTINGS = Object.freeze({
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
    uiAccent: "#0f766e",
    layoutMode: "adaptive",
    primaryLayer: "jyutping",
    annotationScale: 100,
    annotationSpacing: "normal",
    protectCompactUi: true,
    languageMode: "auto",
    peekKey: "Alt",
    readAloudCantoneseShortcut: "Ctrl+Alt+C",
    readAloudMandarinShortcut: "Ctrl+Alt+M",
    readAloudEnglishShortcut: "Ctrl+Alt+E",
    clipboardEditorSupport: true,
    speechBackend: "azure",
    speechRate: 0.9,
    speechPitch: 1,
    saveSourceUrl: false,
    settingsSchemaVersion: SETTINGS_SCHEMA_VERSION
  });

  const PROFILE_OVERRIDE_KEYS = Object.freeze([
    "showJyutping", "showPinyin", "showEnglish", "showHsk", "hoverOnly",
    "layoutMode", "primaryLayer", "languageMode"
  ]);

  function clamp(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  function cleanString(value, maxLength = Infinity) {
    return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  }

  function cleanColor(value, fallback) {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  }

  function isCantoneseLanguage(language) {
    const normalized = String(language || "").toLowerCase().replace(/_/g, "-");
    return normalized === "yue"
      || normalized.startsWith("yue-")
      || /^zh-(?:hant-)?(?:hk|mo)$/.test(normalized);
  }

  function normalizeChineseSpeechText(text) {
    return String(text || "")
      .replace(/[\u200b\u2060\ufeff]/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function speechRateForLanguage(rate, language) {
    const requested = clamp(rate, 0.1, 10, DEFAULT_SETTINGS.speechRate);
    if (!isCantoneseLanguage(language)) return requested;
    return Number((requested * CANTONESE_NATURAL_RATE_SCALE).toFixed(3));
  }

  function preferredSpeechVoiceNames(language) {
    const normalized = String(language || "").toLowerCase().replace(/_/g, "-");
    if (isCantoneseLanguage(normalized)) return PREFERRED_SPEECH_VOICE_NAMES["zh-hk"];
    if (normalized === "zh-cn" || normalized === "cmn-cn" || normalized === "zh-hans" || normalized.startsWith("zh-hans-")) {
      return PREFERRED_SPEECH_VOICE_NAMES["zh-cn"];
    }
    if (normalized === "en" || normalized.startsWith("en-")) return PREFERRED_SPEECH_VOICE_NAMES.en;
    return Object.freeze([]);
  }

  function speechVoicePreferenceScore(voice, language) {
    const description = `${voice?.name || ""} ${voice?.voiceURI || ""}`.toLowerCase();
    const preferredNames = preferredSpeechVoiceNames(language);
    const preferredIndex = preferredNames.findIndex((name) => description.includes(name));
    let score = preferredIndex >= 0 ? 1000 - (preferredIndex * 50) : 0;
    if (/\b(?:natural|neural|online)\b/.test(description)) score += 300;
    if (/\bmicrosoft\b/.test(description)) score += 100;
    if (voice?.default) score += 10;
    return score;
  }

  function rankSpeechVoices(voices, language) {
    return [...(Array.isArray(voices) ? voices : [])].sort((a, b) => {
      const scoreDifference = speechVoicePreferenceScore(b, language) - speechVoicePreferenceScore(a, language);
      if (scoreDifference) return scoreDifference;
      return String(a?.name || "").localeCompare(String(b?.name || ""));
    });
  }

  function isNaturalSpeechVoice(voice, language) {
    const description = `${voice?.name || ""} ${voice?.voiceURI || ""}`.toLowerCase();
    if (/\b(?:natural|neural|online)\b/.test(description)) return true;
    return preferredSpeechVoiceNames(language).some((name) => description.includes(name));
  }

  function normalizeAzureSpeechRegion(value, fallback = "eastus") {
    const region = String(value || "").trim().toLowerCase();
    return /^[a-z0-9-]{2,40}$/.test(region) ? region : fallback;
  }

  function azureSpeechVoiceForLanguage(language) {
    const normalized = String(language || "").toLowerCase().replace(/_/g, "-");
    if (isCantoneseLanguage(normalized)) return { lang: "zh-HK", voice: AZURE_SPEECH_VOICES["zh-HK"] };
    if (normalized === "zh" || normalized === "cmn" || normalized.startsWith("zh-") || normalized.startsWith("cmn-")) {
      return { lang: "zh-CN", voice: AZURE_SPEECH_VOICES["zh-CN"] };
    }
    return { lang: "en-US", voice: AZURE_SPEECH_VOICES["en-US"] };
  }

  function escapeXml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function signedPercent(value) {
    const rounded = Math.round(value);
    return `${rounded >= 0 ? "+" : ""}${rounded}%`;
  }

  function buildAzureSpeechRequest(input = {}) {
    const selection = azureSpeechVoiceForLanguage(input.lang);
    const text = String(input.text || "").trim().slice(0, 5000);
    const rate = clamp(input.rate, 0.5, 1.75, DEFAULT_SETTINGS.speechRate);
    const pitch = clamp(input.pitch, 0.5, 1.5, DEFAULT_SETTINGS.speechPitch);
    const ratePercent = signedPercent((rate - 1) * 100);
    const pitchPercent = signedPercent((pitch - 1) * 50);
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${selection.lang}"><voice name="${selection.voice}"><prosody rate="${ratePercent}" pitch="${pitchPercent}">${escapeXml(text)}</prosody></voice></speak>`;
    return { ...selection, text, rate, pitch, ssml };
  }

  const TTS_DIAGNOSTIC_STRING_FIELDS = Object.freeze([
    "event", "requestId", "backend", "state", "stage", "lang", "voice",
    "selectedVoice", "selectedVoiceLang", "region", "mimeType", "errorCode", "error"
  ]);
  const TTS_DIAGNOSTIC_NUMBER_FIELDS = Object.freeze([
    "textLength", "durationMs", "httpStatus", "audioBytes", "rate", "pitch", "voiceCount"
  ]);
  const TTS_DIAGNOSTIC_BOOLEAN_FIELDS = Object.freeze(["fallback", "permissionGranted"]);

  function sanitizeTtsDiagnosticEntry(input = {}) {
    const source = input && typeof input === "object" ? input : {};
    const entry = {};
    const timestamp = typeof source.timestamp === "string" && !Number.isNaN(Date.parse(source.timestamp))
      ? new Date(source.timestamp).toISOString()
      : new Date().toISOString();
    entry.timestamp = timestamp;
    for (const field of TTS_DIAGNOSTIC_STRING_FIELDS) {
      const value = cleanString(source[field], field === "error" ? 400 : 160);
      if (value) entry[field] = value;
    }
    for (const field of TTS_DIAGNOSTIC_NUMBER_FIELDS) {
      const value = Number(source[field]);
      if (Number.isFinite(value)) entry[field] = Math.round(value * 1000) / 1000;
    }
    for (const field of TTS_DIAGNOSTIC_BOOLEAN_FIELDS) {
      if (typeof source[field] === "boolean") entry[field] = source[field];
    }
    return entry;
  }

  function formatTtsDiagnosticLog(entries = [], metadata = {}) {
    const extensionVersion = cleanString(metadata.extensionVersion, 40) || "unknown";
    const browser = cleanString(metadata.browser, 240) || "unknown";
    const safeEntries = (Array.isArray(entries) ? entries : []).map(sanitizeTtsDiagnosticEntry);
    return [
      "Combined Annotator TTS diagnostic log",
      `Generated: ${new Date().toISOString()}`,
      `Extension version: ${extensionVersion}`,
      `Browser: ${browser}`,
      "Privacy: spoken text, page addresses, Azure keys, SSML, and audio are not recorded.",
      `Events: ${safeEntries.length}`,
      "",
      ...safeEntries.map((entry) => JSON.stringify(entry))
    ].join("\n");
  }

  function normalizeBoolean(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
  }

  function enumValue(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
  }

  function normalizeShortcut(value, fallback = "") {
    const source = cleanString(value, 80);
    const fallbackValue = cleanString(fallback, 80);
    if (!source) return fallbackValue;
    const aliases = { control: "Ctrl", ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Meta", command: "Meta", cmd: "Meta" };
    const modifiers = new Set();
    let key = "";
    for (const rawPart of source.split("+").map((part) => part.trim()).filter(Boolean)) {
      const modifier = aliases[rawPart.toLowerCase()];
      if (modifier) {
        modifiers.add(modifier);
        continue;
      }
      if (key) return fallbackValue;
      if (/^[a-z0-9]$/i.test(rawPart)) key = rawPart.toUpperCase();
      else if (/^f(?:[1-9]|1[0-2])$/i.test(rawPart)) key = rawPart.toUpperCase();
      else if (["Enter", "Space", "Backslash"].includes(rawPart)) key = rawPart;
      else return fallbackValue;
    }
    if (!key || !(modifiers.has("Ctrl") || modifiers.has("Alt") || modifiers.has("Meta"))) return fallbackValue;
    return ["Ctrl", "Alt", "Shift", "Meta"].filter((modifier) => modifiers.has(modifier)).concat(key).join("+");
  }

  function shortcutFromEvent(event) {
    if (!event || event.isComposing) return "";
    const rawKey = String(event.key || "");
    if (["Control", "Alt", "Shift", "Meta", "AltGraph"].includes(rawKey)) return "";
    let key = "";
    if (/^[a-z0-9]$/i.test(rawKey)) key = rawKey.toUpperCase();
    else if (/^f(?:[1-9]|1[0-2])$/i.test(rawKey)) key = rawKey.toUpperCase();
    else if (rawKey === " " || rawKey === "Spacebar") key = "Space";
    else if (rawKey === "Enter") key = "Enter";
    else if (rawKey === "\\") key = "Backslash";
    if (!key) return "";
    const modifiers = [];
    if (event.ctrlKey) modifiers.push("Ctrl");
    if (event.altKey) modifiers.push("Alt");
    if (event.shiftKey) modifiers.push("Shift");
    if (event.metaKey) modifiers.push("Meta");
    if (!modifiers.some((modifier) => modifier === "Ctrl" || modifier === "Alt" || modifier === "Meta")) return "";
    return modifiers.concat(key).join("+");
  }

  function matchesShortcut(event, shortcut) {
    const expected = normalizeShortcut(shortcut);
    return Boolean(expected && shortcutFromEvent(event) === expected);
  }

  function normalizeSettings(input = {}) {
    const legacyTone = typeof input.enableToneColoring === "boolean" ? input.enableToneColoring : undefined;
    const defaults = DEFAULT_SETTINGS;
    const readAloudCantoneseShortcut = normalizeShortcut(input.readAloudCantoneseShortcut, defaults.readAloudCantoneseShortcut);
    let readAloudMandarinShortcut = normalizeShortcut(input.readAloudMandarinShortcut, defaults.readAloudMandarinShortcut);
    let readAloudEnglishShortcut = normalizeShortcut(input.readAloudEnglishShortcut, defaults.readAloudEnglishShortcut);
    if (readAloudMandarinShortcut === readAloudCantoneseShortcut) {
      readAloudMandarinShortcut = [defaults.readAloudMandarinShortcut, "Alt+Shift+M"]
        .find((shortcut) => shortcut !== readAloudCantoneseShortcut);
    }
    if ([readAloudCantoneseShortcut, readAloudMandarinShortcut].includes(readAloudEnglishShortcut)) {
      readAloudEnglishShortcut = [defaults.readAloudEnglishShortcut, "Alt+Shift+E", "Meta+Shift+E"]
        .find((shortcut) => ![readAloudCantoneseShortcut, readAloudMandarinShortcut].includes(shortcut));
    }
    return {
      showJyutping: normalizeBoolean(input.showJyutping, defaults.showJyutping),
      showPinyin: normalizeBoolean(input.showPinyin, defaults.showPinyin),
      showEnglish: normalizeBoolean(input.showEnglish, defaults.showEnglish),
      enableEnglishColoring: normalizeBoolean(input.enableEnglishColoring, legacyTone ?? defaults.enableEnglishColoring),
      enablePinyinToneColoring: normalizeBoolean(input.enablePinyinToneColoring, legacyTone ?? defaults.enablePinyinToneColoring),
      enableJyutpingToneColoring: normalizeBoolean(input.enableJyutpingToneColoring, legacyTone ?? defaults.enableJyutpingToneColoring),
      englishColor: cleanColor(input.englishColor, defaults.englishColor),
      pinyinTone1Color: cleanColor(input.pinyinTone1Color, defaults.pinyinTone1Color),
      pinyinTone2Color: cleanColor(input.pinyinTone2Color, defaults.pinyinTone2Color),
      pinyinTone3Color: cleanColor(input.pinyinTone3Color, defaults.pinyinTone3Color),
      pinyinTone4Color: cleanColor(input.pinyinTone4Color, defaults.pinyinTone4Color),
      pinyinTone5Color: cleanColor(input.pinyinTone5Color, defaults.pinyinTone5Color),
      jyutpingTone1Color: cleanColor(input.jyutpingTone1Color, defaults.jyutpingTone1Color),
      jyutpingTone2Color: cleanColor(input.jyutpingTone2Color, defaults.jyutpingTone2Color),
      jyutpingTone3Color: cleanColor(input.jyutpingTone3Color, defaults.jyutpingTone3Color),
      jyutpingTone4Color: cleanColor(input.jyutpingTone4Color, defaults.jyutpingTone4Color),
      jyutpingTone5Color: cleanColor(input.jyutpingTone5Color, defaults.jyutpingTone5Color),
      jyutpingTone6Color: cleanColor(input.jyutpingTone6Color, defaults.jyutpingTone6Color),
      jyutpingVoice: cleanString(input.jyutpingVoice, 240),
      pinyinVoice: cleanString(input.pinyinVoice, 240),
      englishVoice: cleanString(input.englishVoice, 240),
      copyFormat: enumValue(input.copyFormat, ["smart", "horizontal", "all-top-bottom", "all-bottom-top", "per-char-top-bottom", "per-char-bottom-top"], defaults.copyFormat),
      hoverOnly: normalizeBoolean(input.hoverOnly, defaults.hoverOnly),
      showHsk: normalizeBoolean(input.showHsk, defaults.showHsk),
      uiTheme: enumValue(input.uiTheme, ["auto", "light", "dark"], defaults.uiTheme),
      uiAccent: cleanColor(input.uiAccent, defaults.uiAccent),
      layoutMode: enumValue(input.layoutMode, ["adaptive", "full", "primary", "popup", "pronunciation"], defaults.layoutMode),
      primaryLayer: enumValue(input.primaryLayer, ["jyutping", "pinyin", "english"], defaults.primaryLayer),
      annotationScale: Math.round(clamp(input.annotationScale, 75, 125, defaults.annotationScale)),
      annotationSpacing: enumValue(input.annotationSpacing, ["compact", "normal", "relaxed"], defaults.annotationSpacing),
      protectCompactUi: normalizeBoolean(input.protectCompactUi, defaults.protectCompactUi),
      languageMode: enumValue(input.languageMode, ["auto", "force"], defaults.languageMode),
      peekKey: enumValue(input.peekKey, ["Alt", "Control", "Shift", "Backslash"], defaults.peekKey),
      readAloudCantoneseShortcut,
      readAloudMandarinShortcut,
      readAloudEnglishShortcut,
      clipboardEditorSupport: normalizeBoolean(input.clipboardEditorSupport, defaults.clipboardEditorSupport),
      speechBackend: enumValue(input.speechBackend, ["browser", "azure"], defaults.speechBackend),
      speechRate: clamp(input.speechRate, 0.5, 1.75, defaults.speechRate),
      speechPitch: clamp(input.speechPitch, 0.5, 1.5, defaults.speechPitch),
      saveSourceUrl: normalizeBoolean(input.saveSourceUrl, defaults.saveSourceUrl),
      settingsSchemaVersion: SETTINGS_SCHEMA_VERSION
    };
  }

  function normalizeSiteProfile(input = {}, hostname = "") {
    const overrides = {};
    const source = input.overrides && typeof input.overrides === "object" ? input.overrides : input;
    for (const key of PROFILE_OVERRIDE_KEYS) {
      if (!(key in source)) continue;
      const normalized = normalizeSettings({ ...DEFAULT_SETTINGS, [key]: source[key] });
      overrides[key] = normalized[key];
    }
    return {
      hostname: cleanString(input.hostname || hostname, 255).toLowerCase(),
      enabled: input.enabled !== false,
      overrides,
      updatedAt: Number(input.updatedAt) || Date.now()
    };
  }

  function effectiveSettings(settings, profile) {
    const globalSettings = normalizeSettings(settings);
    if (!profile) return globalSettings;
    const cleanProfile = normalizeSiteProfile(profile, profile.hostname);
    return normalizeSettings({ ...globalSettings, ...cleanProfile.overrides });
  }

  function enabledLayerCount(settings) {
    const active = normalizeSettings(settings);
    return Number(active.showJyutping) + Number(active.showPinyin) + Number(active.showEnglish) + Number(active.showHsk);
  }

  function chooseLayoutContainerIndex(candidates) {
    if (!Array.isArray(candidates) || !candidates.length) return -1;
    const first = candidates[0] || {};
    if (first.reading || ["flex", "grid", "table-cell"].includes(first.display)) return 0;
    const firstWidth = Math.max(0, Number(first.width) || 0);

    // A short sentence inside a flex/table reading row is commonly
    // shrink-wrapped to the text itself. Promote at most two layout ancestors
    // so adaptive mode uses the space available to the sentence without
    // accidentally jumping from a narrow sidebar to the page's outer grid.
    for (let index = 1; index < Math.min(candidates.length, 3); index += 1) {
      const candidate = candidates[index] || {};
      if (candidate.reading) return index;
      const width = Math.max(0, Number(candidate.width) || 0);
      if (["flex", "grid", "table-cell"].includes(candidate.display) && width >= firstWidth + 8) return index;
    }
    return 0;
  }

  function isWideReadingControl(width, height, lineHeight, constrained = false) {
    const pixels = Math.max(0, Number(width) || 0);
    const blockSize = Math.max(0, Number(height) || 0);
    const line = Math.max(1, Number(lineHeight) || 16);
    return !constrained && pixels >= 560 && blockSize >= Math.max(72, line * 3.25);
  }

  function chooseLayout(width, settings) {
    const active = normalizeSettings(settings);
    if (active.layoutMode !== "adaptive") return active.layoutMode;
    const pixels = Number(width) || 0;
    if (pixels > 0 && pixels < 320) return "popup";
    const layers = enabledLayerCount(active);
    if (pixels > 0 && (pixels < 560 || (layers >= 3 && pixels < 720))) return "primary";
    return "full";
  }

  function isPronunciationMode(settings) {
    const active = normalizeSettings(settings);
    return active.layoutMode === "pronunciation";
  }

  function chooseSafeLayout(width, settings, context = {}) {
    const active = normalizeSettings(settings);
    const pixels = Number(width) || 0;
    // Compact-page protection is only a narrow-container escape hatch. A
    // false-positive on a wide article must never hide every annotation.
    if (active.protectCompactUi && context.compact && (pixels <= 0 || pixels < 560)) return "popup";
    return chooseLayout(width, active);
  }

  const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
  const KANA_RE = /[\u3040-\u30ff\u31f0-\u31ff]/u;
  const HANGUL_RE = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u;
  const CHINESE_LANGUAGE_SUBTAGS = new Set([
    "zh", "cmn", "yue", "wuu", "hak", "nan", "gan", "hsn", "cjy",
    "cdo", "cpx", "czh", "czo", "mnp", "lzh", "och", "ltc"
  ]);
  const UNDETERMINED_LANGUAGE_SUBTAGS = new Set(["und", "mul", "mis"]);

  function classifyLanguage(text, declaredLang = "") {
    const lang = cleanString(declaredLang, 64).toLowerCase().replace(/_/g, "-");
    const primarySubtag = lang.split("-", 1)[0];
    if (CHINESE_LANGUAGE_SUBTAGS.has(primarySubtag)) return "zh";
    if (primarySubtag === "ja") return "ja";
    if (primarySubtag === "ko") return "ko";
    // A specific BCP-47 language declaration is authoritative. This prevents
    // incidental Han characters in English, Vietnamese, Arabic, and other
    // non-Chinese content from being treated as Chinese prose.
    if (primarySubtag && !UNDETERMINED_LANGUAGE_SUBTAGS.has(primarySubtag)) return "other";
    const value = String(text || "");
    if (KANA_RE.test(value)) return "ja";
    if (HANGUL_RE.test(value)) return "ko";
    if (HAN_RE.test(value)) {
      let hanCount = 0;
      let otherLetterCount = 0;
      for (const character of value) {
        if (HAN_RE.test(character)) hanCount++;
        else if (/\p{L}/u.test(character)) otherLetterCount++;
      }
      if (hanCount <= 2 && otherLetterCount >= 8) return "other";
      return "zh";
    }
    return "unknown";
  }

  function shouldAnnotateLanguage(text, declaredLang, mode = "auto") {
    if (mode === "force") return HAN_RE.test(String(text || ""));
    return classifyLanguage(text, declaredLang) === "zh";
  }

  function normalizeReview(input = {}) {
    return {
      state: enumValue(input.state, ["new", "learning", "review", "known"], "new"),
      dueAt: input.dueAt == null ? null : Number(input.dueAt) || null,
      intervalDays: Math.max(0, Number(input.intervalDays) || 0),
      ease: clamp(input.ease, 1.3, 2.8, 2.3),
      repetitions: Math.max(0, Math.floor(Number(input.repetitions) || 0)),
      lapses: Math.max(0, Math.floor(Number(input.lapses) || 0)),
      lastReviewedAt: input.lastReviewedAt == null ? null : Number(input.lastReviewedAt) || null
    };
  }

  function rateReview(previous, rating, now = Date.now()) {
    const review = normalizeReview(previous);
    const next = { ...review, lastReviewedAt: now };
    if (rating === "known") {
      next.state = "known";
      next.dueAt = null;
      return next;
    }
    if (rating === "again") {
      next.state = "learning";
      next.dueAt = now + TEN_MINUTES_MS;
      next.intervalDays = review.repetitions > 0 ? 1 : 0;
      next.ease = Math.max(1.3, review.ease - 0.2);
      next.lapses = review.lapses + (review.repetitions > 0 ? 1 : 0);
      return next;
    }
    if (rating === "hard") {
      next.state = review.repetitions === 0 ? "learning" : "review";
      next.intervalDays = review.repetitions === 0 ? 1 : Math.max(1, Math.round(Math.max(1, review.intervalDays) * 1.2));
      next.dueAt = now + next.intervalDays * DAY_MS;
      next.ease = Math.max(1.3, review.ease - 0.15);
      next.repetitions = review.repetitions + 1;
      return next;
    }
    if (rating !== "good") throw new Error("Unknown review rating");
    next.state = "review";
    if (review.repetitions === 0) next.intervalDays = 1;
    else if (review.repetitions === 1) next.intervalDays = 3;
    else next.intervalDays = Math.max(3, Math.round(Math.max(1, review.intervalDays) * review.ease));
    next.dueAt = now + next.intervalDays * DAY_MS;
    next.ease = Math.min(2.8, review.ease + 0.05);
    next.repetitions = review.repetitions + 1;
    return next;
  }

  function stableId(prefix = "item") {
    if (global.crypto && typeof global.crypto.randomUUID === "function") return `${prefix}-${global.crypto.randomUUID()}`;
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function uniqueStrings(values, maxItems = 50, maxLength = 500) {
    const seen = new Set();
    const result = [];
    for (const value of Array.isArray(values) ? values : []) {
      const clean = cleanString(value, maxLength);
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      result.push(clean);
      if (result.length >= maxItems) break;
    }
    return result;
  }

  function vocabKey(entry = {}) {
    return [cleanString(entry.hanzi || entry.simplified || entry.traditional, 80), cleanString(entry.pinyin, 200), cleanString(entry.jyutping, 200)]
      .join("|").toLocaleLowerCase();
  }

  function normalizeVocabEntry(input = {}) {
    const now = Date.now();
    const hanzi = cleanString(input.hanzi || input.simplified || input.traditional, 80);
    if (!hanzi) return null;
    const definitions = uniqueStrings(input.definitions?.length ? input.definitions : [input.fullEnglish, input.english], 30, 1000);
    const normalized = {
      id: cleanString(input.id, 120) || stableId("word"),
      hanzi,
      simplified: cleanString(input.simplified, 80) || hanzi,
      traditional: cleanString(input.traditional, 80) || hanzi,
      pinyin: cleanString(input.pinyin, 240),
      jyutping: cleanString(input.jyutping, 240),
      definitions,
      english: definitions[0] || cleanString(input.english, 1000),
      hsk: cleanString(input.hsk, 20),
      note: cleanString(input.note, 4000),
      tags: uniqueStrings(input.tags, 30, 80),
      createdAt: Number(input.createdAt || input.savedAt) || now,
      updatedAt: Number(input.updatedAt) || now,
      normalizedKey: "",
      review: normalizeReview(input.review)
    };
    normalized.normalizedKey = vocabKey(normalized);
    return normalized;
  }

  function normalizeContext(input = {}, wordId = "", saveSourceUrl = false) {
    const sentence = cleanString(input.sentence || input.text, 500);
    if (!sentence) return null;
    let sourceUrl = "";
    if (saveSourceUrl && typeof input.sourceUrl === "string") {
      try {
        const url = new URL(input.sourceUrl);
        if (url.protocol === "http:" || url.protocol === "https:") sourceUrl = url.href.slice(0, 2048);
      } catch {}
    }
    return {
      id: cleanString(input.id, 120) || stableId("context"),
      wordId: cleanString(input.wordId || wordId, 120),
      sentence,
      sourceTitle: cleanString(input.sourceTitle, 240),
      sourceUrl,
      savedAt: Number(input.savedAt) || Date.now()
    };
  }

  function parseCedictGloss(gloss) {
    const classifiers = [];
    const references = [];
    const senses = [];
    for (const rawPart of String(gloss || "").split(/[;/]/)) {
      const part = rawPart.trim();
      if (!part) continue;
      if (/^CL:/i.test(part)) {
        const body = part.replace(/^CL:/i, "");
        for (const item of body.split(",")) {
          const match = item.trim().match(/^([^|\[]+)(?:\|([^\[]+))?\[([^\]]+)\]$/);
          classifiers.push(match ? { traditional: match[1], simplified: match[2] || match[1], pinyin: match[3] } : { traditional: item.trim(), simplified: item.trim(), pinyin: "" });
        }
        continue;
      }
      const refs = [...part.matchAll(/([\u3400-\u9fff]+)(?:\|([\u3400-\u9fff]+))?\[([^\]]+)\]/gu)];
      references.push(...refs.map((match) => ({ traditional: match[1], simplified: match[2] || match[1], pinyin: match[3] })));
      senses.push(part);
    }
    return { senses: uniqueStrings(senses, 40, 1000), classifiers, references };
  }

  function sentenceAround(text, offset = 0, maxLength = 500) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    if (!value) return "";
    const safeOffset = Math.max(0, Math.min(value.length, Number(offset) || 0));
    const boundaries = /[。！？!?\n]/;
    let start = safeOffset;
    let end = safeOffset;
    while (start > 0 && !boundaries.test(value[start - 1])) start--;
    while (end < value.length && !boundaries.test(value[end])) end++;
    if (end < value.length) end++;
    let sentence = value.slice(start, end).trim();
    if (!sentence) sentence = value;
    if (sentence.length > maxLength) {
      const local = Math.max(0, safeOffset - start);
      const from = Math.max(0, Math.min(sentence.length - maxLength, local - Math.floor(maxLength / 2)));
      sentence = sentence.slice(from, from + maxLength).trim();
    }
    return sentence;
  }

  function parseDelimited(text) {
    const source = String(text || "").replace(/^\uFEFF/, "");
    const firstLine = source.split(/\r?\n/, 1)[0] || "";
    const delimiter = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? "\t" : ",";
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    for (let index = 0; index <= source.length; index++) {
      const char = source[index] ?? "\n";
      if (quoted) {
        if (char === '"' && source[index + 1] === '"') { field += '"'; index++; }
        else if (char === '"') quoted = false;
        else field += char;
      } else if (char === '"') quoted = true;
      else if (char === delimiter) { row.push(field); field = ""; }
      else if (char === "\n") { row.push(field.replace(/\r$/, "")); field = ""; if (row.some((cell) => cell.trim())) rows.push(row); row = []; }
      else field += char;
    }
    if (!rows.length) return [];
    const aliases = {
      hanzi: ["hanzi", "chinese", "word", "characters", "front"],
      simplified: ["simplified", "simplified chinese"],
      traditional: ["traditional", "traditional chinese"],
      pinyin: ["pinyin", "mandarin"],
      jyutping: ["jyutping", "cantonese"],
      definitions: ["definition", "definitions", "english", "meaning", "back"],
      sentence: ["sentence", "context", "example"],
      sourceTitle: ["source", "source title", "title"],
      tags: ["tag", "tags"],
      note: ["note", "notes"]
    };
    const header = rows[0].map((cell) => cell.trim().toLowerCase());
    const hasHeader = header.some((cell) => Object.values(aliases).flat().includes(cell));
    const indexes = {};
    if (hasHeader) {
      for (const [key, names] of Object.entries(aliases)) indexes[key] = header.findIndex((cell) => names.includes(cell));
    } else {
      ["hanzi", "pinyin", "jyutping", "definitions", "sentence", "tags"].forEach((key, index) => { indexes[key] = index; });
    }
    return rows.slice(hasHeader ? 1 : 0).map((cells) => {
      const get = (key) => indexes[key] >= 0 ? cleanString(cells[indexes[key]], 4000) : "";
      const entry = normalizeVocabEntry({
        hanzi: get("hanzi") || get("simplified") || get("traditional"),
        simplified: get("simplified"), traditional: get("traditional"), pinyin: get("pinyin"), jyutping: get("jyutping"),
        definitions: get("definitions").split(/\s*\|\s*/).filter(Boolean), tags: get("tags").split(/\s*[,;]\s*/).filter(Boolean), note: get("note")
      });
      if (!entry) return null;
      const sentence = get("sentence");
      return { entry, context: sentence ? { sentence, sourceTitle: get("sourceTitle") } : null };
    }).filter(Boolean);
  }

  // Project source-character boundaries onto a converted string. OpenCC phrase
  // mappings are usually one-for-one, but a small number insert or remove a
  // character. A Levenshtein alignment lets annotated word wrappers follow
  // those changes without tearing down the surrounding page DOM.
  function alignConvertedBoundaries(sourceText, targetText) {
    const source = Array.from(String(sourceText || ""));
    const target = Array.from(String(targetText || ""));
    if (source.length === target.length) return Array.from({ length: source.length + 1 }, (_, index) => index);
    const rows = source.length + 1;
    const columns = target.length + 1;
    const costs = Array.from({ length: rows }, () => Array(columns).fill(0));
    const steps = Array.from({ length: rows }, () => Array(columns).fill(""));

    for (let row = 1; row < rows; row++) { costs[row][0] = row; steps[row][0] = "delete"; }
    for (let column = 1; column < columns; column++) { costs[0][column] = column; steps[0][column] = "insert"; }

    for (let row = 1; row < rows; row++) {
      for (let column = 1; column < columns; column++) {
        const same = source[row - 1] === target[column - 1];
        const diagonal = costs[row - 1][column - 1] + (same ? 0 : 1);
        const deletion = costs[row - 1][column] + 1;
        const insertion = costs[row][column - 1] + 1;
        if (diagonal <= deletion && diagonal <= insertion) {
          costs[row][column] = diagonal;
          steps[row][column] = same ? "match" : "replace";
        } else if (deletion <= insertion) {
          costs[row][column] = deletion;
          steps[row][column] = "delete";
        } else {
          costs[row][column] = insertion;
          steps[row][column] = "insert";
        }
      }
    }

    const operations = [];
    let row = source.length;
    let column = target.length;
    while (row > 0 || column > 0) {
      const step = steps[row][column] || (row > 0 ? "delete" : "insert");
      operations.push(step);
      if (step === "match" || step === "replace") { row--; column--; }
      else if (step === "delete") row--;
      else column--;
    }
    operations.reverse();

    const boundaries = Array(source.length + 1).fill(0);
    let sourceIndex = 0;
    let targetIndex = 0;
    for (const operation of operations) {
      if (operation === "insert") {
        targetIndex++;
        boundaries[sourceIndex] = targetIndex;
      } else if (operation === "delete") {
        sourceIndex++;
        boundaries[sourceIndex] = targetIndex;
      } else {
        sourceIndex++;
        targetIndex++;
        boundaries[sourceIndex] = targetIndex;
      }
    }
    boundaries[0] = 0;
    boundaries[boundaries.length - 1] = target.length;
    return boundaries;
  }
  const api = {
    DAY_MS,
    TEN_MINUTES_MS,
    SETTINGS_SCHEMA_VERSION,
    USER_DATA_SCHEMA_VERSION,
    DEFAULT_SETTINGS,
    PROFILE_OVERRIDE_KEYS,
    HAN_RE,
    isCantoneseLanguage,
    normalizeChineseSpeechText,
    speechRateForLanguage,
    preferredSpeechVoiceNames,
    speechVoicePreferenceScore,
    rankSpeechVoices,
    isNaturalSpeechVoice,
    normalizeAzureSpeechRegion,
    azureSpeechVoiceForLanguage,
    buildAzureSpeechRequest,
    sanitizeTtsDiagnosticEntry,
    formatTtsDiagnosticLog,
    normalizeShortcut,
    shortcutFromEvent,
    matchesShortcut,
    normalizeSettings,
    normalizeSiteProfile,
    isPronunciationMode,
    effectiveSettings,
    enabledLayerCount,
    chooseLayoutContainerIndex,
    isWideReadingControl,
    chooseLayout,
    chooseSafeLayout,
    classifyLanguage,
    shouldAnnotateLanguage,
    normalizeReview,
    rateReview,
    normalizeVocabEntry,
    normalizeContext,
    vocabKey,
    parseCedictGloss,
    sentenceAround,
    parseDelimited,
    alignConvertedBoundaries,
    stableId,
    uniqueStrings
  };

  global.CombinedAnnotatorCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
