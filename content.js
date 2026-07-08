const hasBrowserApi = typeof browser !== "undefined";
const ext = hasBrowserApi ? browser : chrome;

const CHINESE_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "TITLE",
  "TEXTAREA",
  "OPTION",
  "INPUT",
  "SELECT",
  "BUTTON",
  "CODE",
  "PRE",
  "KBD",
  "SAMP",
  "RUBY",
  "RT",
  "RP",
  "NOSCRIPT",
  "IFRAME",
  "CANVAS",
  "SVG"
]);

const SCAN_TEXT_NODES_PER_TICK = 350;
const MAX_BATCH_NODES = 14;
const MAX_BATCH_CHARS = 2200;
const MAX_TEXT_NODE_CHARS = 700;
const BATCH_PAUSE_MS = 24;
const CACHE_LIMIT = 500;
const SPEAKER_HIDE_DELAY_MS = 800;
const SPEAKER_FINISHED_HIDE_DELAY_MS = 0;
const VIEWPORT_TEXT_MARGIN_PX = 900;
const VIEWPORT_REFRESH_DELAY_MS = 180;
const COVERAGE_SWEEP_DELAY_MS = 650;
const MAX_COVERAGE_SWEEPS = 24;
const FORCE_VISIBLE_NODE_LIMIT = 1800;
const COVERAGE_SAMPLE_LIMIT = 8;

let settings = {
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
  uiTheme: "auto"
};
let scanQueue = [];
let scanScheduled = false;
let annotationQueue = [];
let annotationScheduled = false;
let mutationTimer = 0;
let observerPaused = false;
let pageVersion = 0;
let speechRequestCounter = 0;
let globalSpeakerHandlersInstalled = false;
let lastPointerSelectionKind = "";
let lastPointerSelectionAt = 0;
let lastPointerSelectionX = 0;
let lastPointerSelectionY = 0;
let lastPointerSelectionMaxDx = 0;
let lastPointerSelectionMaxDy = 0;

let queuedTextNodes = new WeakSet();
let observedElements = new WeakSet();
let pendingVisibleSweeps = new WeakSet();
const annotationCache = new Map();
const speakerHideTimers = new WeakMap();
const activeSpeechLines = new Map();
const speechUiTimers = new Map();
let lastSpeechDiagnostic = null;
let speechDiagnosticWaiters = [];
let lastSpeakRequest = { line: null, time: 0 };
let lastContextSpeakRequest = { key: "", time: 0 };
let lastContextChineseCharacter = "";
let strokeOverlayState = null;
let strokeSpeedRestartTimer = 0;
let viewportRefreshTimer = 0;
let coverageSweepTimer = 0;
let coverageSweepCount = 0;

const viewportObserver = new IntersectionObserver(handleIntersections, {
  root: null,
  rootMargin: "1200px 0px",
  threshold: 0
});

const mutationObserver = new MutationObserver(handleMutations);

function anyEnabled(active = settings) {
  if (siteDisabled) return false;
  return active.showJyutping || active.showPinyin || active.showEnglish;
}

function scheduleIdle(callback, timeout = 80) {
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(callback, { timeout });
    return;
  }
  window.setTimeout(callback, 0);
}

function sendMessage(message) {
  if (hasBrowserApi) {
    return ext.runtime.sendMessage(message).then((response) => {
      if (response && response.error) throw new Error(response.error);
      return response;
    });
  }

  return new Promise((resolve, reject) => {
    ext.runtime.sendMessage(message, (response) => {
      const error = ext.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (response && response.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response);
    });
  });
}

// Simplified/Traditional conversion runs in the background now (OpenCC is a
// ~1.2 MB library, so it is no longer injected into every frame). These helpers
// wrap the round-trip and fall back to the original text if it is unavailable.
async function convertViaBackground(text, mode) {
  const source = String(text || "");
  if (!source) return source;
  try {
    const response = await sendMessage({ type: "convert-text", text: source, mode });
    return typeof response?.text === "string" ? response.text : source;
  } catch (error) {
    console.warn("Combined Annotator: conversion failed", error);
    return source;
  }
}

async function convertManyViaBackground(texts, mode) {
  const inputs = texts.map((value) => String(value || ""));
  if (!inputs.length) return inputs;
  try {
    const response = await sendMessage({ type: "convert-texts", texts: inputs, mode });
    if (Array.isArray(response?.texts) && response.texts.length === inputs.length) return response.texts;
  } catch (error) {
    console.warn("Combined Annotator: batch conversion failed", error);
  }
  return inputs;
}

let siteDisabled = false;

// hanzi-writer.min.js is no longer injected into every frame; it is pulled into
// this frame's content-script world on demand the first time stroke order runs.
let hanziWriterReady = null;
function ensureHanziWriter() {
  if (globalThis.HanziWriter) return Promise.resolve(true);
  if (hanziWriterReady) return hanziWriterReady;
  hanziWriterReady = sendMessage({ type: "ensure-hanzi-writer" })
    .then(() => Boolean(globalThis.HanziWriter))
    .catch((error) => {
      console.warn("Combined Annotator: stroke library unavailable", error);
      hanziWriterReady = null;
      return false;
    });
  return hanziWriterReady;
}

function saveVocabEntry(entry) {
  return sendMessage({ type: "save-vocab", entry }).catch((error) => {
    console.warn("Combined Annotator: could not save word", error);
    return null;
  });
}

function isSkippableElement(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return true;
  if (SKIP_TAGS.has(element.nodeName)) return true;
  return Boolean(element.closest("[data-ca-annotation], [data-ca-stroke-overlay], [contenteditable='true'], ruby"));
}

function isValidTextNode(node) {
  return (
    node &&
    node.nodeType === Node.TEXT_NODE &&
    node.nodeValue &&
    CHINESE_RE.test(node.nodeValue) &&
    !isSkippableElement(node.parentElement)
  );
}

function textNodeSkipReason(node) {
  if (!node) return "missing-node";
  if (node.nodeType !== Node.TEXT_NODE) return "not-text";
  if (!node.nodeValue) return "empty";
  if (!CHINESE_RE.test(node.nodeValue)) return "no-chinese";
  const parent = node.parentElement;
  if (!parent) return "no-parent";
  const skipElement = parent.closest("[data-ca-annotation], [data-ca-stroke-overlay], [contenteditable='true'], ruby");
  if (skipElement) {
    if (skipElement.matches("[data-ca-annotation]")) return "already-annotated";
    if (skipElement.matches("[data-ca-stroke-overlay]")) return "stroke-overlay";
    if (skipElement.matches("[contenteditable='true']")) return "contenteditable";
    if (skipElement.matches("ruby")) return "ruby";
  }
  const blocked = parent.closest(Array.from(SKIP_TAGS).join(","));
  if (blocked) return `tag-${blocked.nodeName.toLowerCase()}`;
  return "";
}

function observeElementForLazyAnnotation(element) {
  if (!element || observedElements.has(element) || isSkippableElement(element)) return;
  observedElements.add(element);
  viewportObserver.observe(element);
}

function enqueueScan(root) {
  if (!root || !anyEnabled()) return;
  scanQueue.push(createTextWalker(root));
  scheduleScan();
}

function createTextWalker(root) {
  const start = root.nodeType === Node.TEXT_NODE ? root.parentElement : root;
  if (!start || isSkippableElement(start)) return null;

  return document.createTreeWalker(start, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return isValidTextNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
}

function scheduleScan() {
  if (scanScheduled) return;
  scanScheduled = true;
  scheduleIdle(runScanBatch);
}

function runScanBatch() {
  scanScheduled = false;

  let remaining = SCAN_TEXT_NODES_PER_TICK;
  while (remaining > 0 && scanQueue.length) {
    const walker = scanQueue[0];
    if (!walker) {
      scanQueue.shift();
      continue;
    }

    const textNode = walker.nextNode();
    if (!textNode) {
      scanQueue.shift();
      continue;
    }

    remaining--;
    observeElementForLazyAnnotation(textNode.parentElement);
  }

  if (scanQueue.length) scheduleScan();
}

function handleIntersections(entries) {
  for (const entry of entries) {
    if (entry.isIntersecting) enqueueVisibleText(entry.target);
  }
}

function isTextNodeNearViewport(node, margin = VIEWPORT_TEXT_MARGIN_PX) {
  const viewportTop = -margin;
  const viewportBottom = window.innerHeight + margin;
  const viewportLeft = -Math.min(240, margin);
  const viewportRight = window.innerWidth + Math.min(240, margin);

  try {
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = Array.from(range.getClientRects());
    range.detach?.();
    if (rects.some((rect) => rect.bottom >= viewportTop && rect.top <= viewportBottom && rect.right >= viewportLeft && rect.left <= viewportRight)) {
      return true;
    }
  } catch {
    // Fall back to the parent element below.
  }

  const parentRect = node.parentElement?.getBoundingClientRect?.();
  return Boolean(
    parentRect &&
    parentRect.bottom >= viewportTop &&
    parentRect.top <= viewportBottom &&
    parentRect.right >= viewportLeft &&
    parentRect.left <= viewportRight
  );
}

function enqueueVisibleText(root, options = {}) {
  const walker = createTextWalker(root);
  if (!walker) return;

  const visibleOnly = Boolean(options.visibleOnly);
  const maxNodes = options.maxNodes ?? Infinity;
  let enqueued = 0;
  let node = walker.nextNode();
  while (node) {
    if (!visibleOnly || isTextNodeNearViewport(node, options.margin ?? VIEWPORT_TEXT_MARGIN_PX)) {
      enqueueTextNode(node, options);
      enqueued++;
      if (enqueued >= maxNodes) break;
    }
    node = walker.nextNode();
  }
}

function getPreferredContentRoots() {
  const selectors = ["main", "article", "[role='main']", "#content", "#bodyContent", ".mw-body", ".mw-parser-output"];
  const roots = [];
  const seen = new Set();
  for (const selector of selectors) {
    document.querySelectorAll(selector).forEach((element) => {
      if (!seen.has(element) && !isSkippableElement(element)) {
        seen.add(element);
        roots.push(element);
      }
    });
  }
  if (!seen.has(document.body)) roots.push(document.body);
  return roots;
}

function getVisibleChineseTextNodes(options = {}) {
  const root = options.root || document.body;
  if (!root) return [];
  const nodes = [];
  const seen = new WeakSet();
  const maxNodes = options.maxNodes ?? Infinity;
  const margin = options.margin ?? VIEWPORT_TEXT_MARGIN_PX;
  const walkerRoot = root.nodeType === Node.TEXT_NODE ? root.parentElement : root;
  if (!walkerRoot) return nodes;

  const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (!seen.has(node) && CHINESE_RE.test(node.nodeValue || "") && isTextNodeNearViewport(node, margin)) {
      seen.add(node);
      nodes.push(node);
      if (nodes.length >= maxNodes) break;
    }
    node = walker.nextNode();
  }
  return nodes;
}

function enqueueVisibleContent(options = {}) {
  if (options.force || options.bodyWide) {
    for (const node of getVisibleChineseTextNodes({ maxNodes: options.maxNodes ?? FORCE_VISIBLE_NODE_LIMIT, margin: options.margin })) {
      if (isValidTextNode(node)) enqueueTextNode(node, options);
    }
    return;
  }

  for (const root of getPreferredContentRoots()) {
    enqueueVisibleText(root, { visibleOnly: true, ...options });
  }
}

function scheduleViewportRefresh() {
  if (!anyEnabled() || settings.hoverOnly) return;
  coverageSweepCount = 0;
  window.clearTimeout(viewportRefreshTimer);
  viewportRefreshTimer = window.setTimeout(() => {
    enqueueVisibleContent({ force: true });
    enqueueScan(document.body);
    scheduleCoverageSweep();
  }, VIEWPORT_REFRESH_DELAY_MS);
}

function hasRawVisibleChineseText() {
  for (const node of getVisibleChineseTextNodes({ maxNodes: 250 })) {
    if (isValidTextNode(node)) return true;
  }
  return false;
}

function scheduleCoverageSweep() {
  if (!anyEnabled() || settings.hoverOnly) return;
  window.clearTimeout(coverageSweepTimer);
  coverageSweepTimer = window.setTimeout(() => {
    if (!anyEnabled()) return;
    enqueueVisibleContent({ force: true, bodyWide: true });
    coverageSweepCount++;
    if (coverageSweepCount < MAX_COVERAGE_SWEEPS && (annotationQueue.length || hasRawVisibleChineseText())) {
      scheduleCoverageSweep();
    }
  }, COVERAGE_SWEEP_DELAY_MS);
}

function countVisibleCoverage() {
  const visibleNodes = getVisibleChineseTextNodes({ maxNodes: FORCE_VISIBLE_NODE_LIMIT });
  const skippedByReason = Object.create(null);
  const rawSamples = [];
  let rawVisible = 0;
  let validRawVisible = 0;
  let annotatedTextNodes = 0;

  for (const node of visibleNodes) {
    const reason = textNodeSkipReason(node);
    if (reason === "already-annotated") {
      annotatedTextNodes++;
      continue;
    }
    if (reason) {
      skippedByReason[reason] = (skippedByReason[reason] || 0) + 1;
      continue;
    }

    rawVisible++;
    if (isValidTextNode(node)) {
      validRawVisible++;
      if (rawSamples.length < COVERAGE_SAMPLE_LIMIT) {
        rawSamples.push(node.nodeValue.replace(/\s+/g, " ").trim().slice(0, 80));
      }
    }
  }

  return {
    ok: true,
    url: location.href,
    visibleChineseTextNodes: visibleNodes.length,
    annotatedUnits: document.querySelectorAll(".ca-unit").length,
    annotatedTextNodes,
    rawVisible,
    validRawVisible,
    queued: annotationQueue.length,
    scanQueue: scanQueue.length,
    cacheEntries: annotationCache.size,
    skippedByReason,
    samples: rawSamples.filter(Boolean)
  };
}

function enqueueTextNode(node, options = {}) {
  if (!isValidTextNode(node)) return;
  if (!options.force && queuedTextNodes.has(node)) return;
  queuedTextNodes.add(node);
  annotationQueue.push({ node, version: pageVersion });
  scheduleAnnotationBatch();
}

function scheduleAnnotationBatch() {
  if (annotationScheduled) return;
  annotationScheduled = true;
  window.setTimeout(processAnnotationBatch, BATCH_PAUSE_MS);
}

async function processAnnotationBatch() {
  annotationScheduled = false;
  if (!anyEnabled()) return;

  let nodeCount = 0;
  let charCount = 0;

  while (annotationQueue.length && nodeCount < MAX_BATCH_NODES && charCount < MAX_BATCH_CHARS) {
    const item = annotationQueue.shift();
    const node = item.node;

    if (item.version !== pageVersion || !isValidTextNode(node)) continue;

    if (node.nodeValue.length > MAX_TEXT_NODE_CHARS) {
      let splitIndex = MAX_TEXT_NODE_CHARS;
      const prevChar = node.nodeValue.charCodeAt(splitIndex - 1);
      if (prevChar >= 0xD800 && prevChar <= 0xDBFF) {
        splitIndex--; // Don't split a surrogate pair in half
      }
      const remainder = node.splitText(splitIndex);
      enqueueTextNode(remainder);
    }

    nodeCount++;
    charCount += node.nodeValue.length;
    
    try {
      await annotateNode(node, item.version);
    } catch (err) {
      const skipped = (node.nodeValue || "").replace(/\s+/g, " ").trim();
      console.warn(
        `Combined Annotator: skipped annotating text (${skipped.length} chars): "${skipped.slice(0, 120)}${skipped.length > 120 ? "…" : ""}"`,
        err
      );
    }
  }

  if (annotationQueue.length) scheduleAnnotationBatch();
}

async function annotateNode(node, version) {
  const text = node.nodeValue;
  const cacheKey = `${settings.showEnglish ? "e" : "-"}${settings.showJyutping ? "j" : "-"}${settings.showPinyin ? "p" : "-"}:${text}`;
  const cached = annotationCache.get(cacheKey);
  if (cached) {
    replaceTextNode(node, cached, version);
    return;
  }

  const response = await sendMessage({
    type: "annotate-text",
    text,
    leftContext: getContext(node, "left"),
    rightContext: getContext(node, "right"),
    settings
  });

  if (version !== pageVersion || !node.isConnected) return;

  const fragment = buildAnnotationFragment(text, response);
  annotationCache.set(cacheKey, fragment);
  if (annotationCache.size > CACHE_LIMIT) {
    annotationCache.delete(annotationCache.keys().next().value);
  }
  replaceTextNode(node, fragment, version);
}

function getContext(node, direction) {
  let text = "";
  let cursor = node;
  while (text.length < 20 && cursor) {
    cursor = direction === "left" ? cursor.previousSibling : cursor.nextSibling;
    if (!cursor) break;
    const value = siblingContextText(cursor);
    text = direction === "left" ? value.slice(-20) + text : text + value.slice(0, 20);
  }
  return text.slice(0, 20);
}

// Returns the original source text of a sibling for use as annotation context.
// Already-annotated nodes render pinyin/jyutping/emoji in their textContent, so
// read the stored original Chinese (data-ca-original) instead — otherwise that
// romanization leaks back into the engine as context.
function siblingContextText(cursor) {
  if (cursor.nodeType === Node.TEXT_NODE) return cursor.textContent || "";
  if (cursor.nodeType !== Node.ELEMENT_NODE) return "";
  if (cursor.matches("[data-ca-annotation]")) return cursor.dataset.caOriginal || "";
  if (cursor.querySelector("[data-ca-annotation]")) {
    let combined = "";
    for (const child of cursor.childNodes) combined += siblingContextText(child);
    return combined;
  }
  return cursor.textContent || "";
}

function scheduleVisibleSweep(root) {
  // In hover-only mode we annotate just the block the reader points at, so skip
  // the follow-up sweep that would otherwise expand into neighbouring content.
  if (settings.hoverOnly) return;
  if (!root || pendingVisibleSweeps.has(root)) return;
  pendingVisibleSweeps.add(root);
  window.setTimeout(() => {
    pendingVisibleSweeps.delete(root);
    if (root.isConnected && anyEnabled()) enqueueVisibleText(root, { force: true, visibleOnly: true });
  }, 0);
}

function replaceTextNode(node, fragment, version) {
  if (version !== pageVersion || !node.parentNode) return;
  const parent = node.parentNode;
  observerPaused = true;
  parent.replaceChild(fragment.cloneNode(true), node);
  window.setTimeout(() => {
    observerPaused = false;
    scheduleVisibleSweep(parent);
  }, 0);
}

function buildAnnotationFragment(originalText, response) {
  const annotatorText = response?.annotatorText || originalText;
  let pinyinParts = restoreOriginalBases(parseAnnotatedHtml(response?.pinyinHtml || annotatorText), originalText, annotatorText);
  let jyutpingParts = restoreOriginalBases(parseAnnotatedHtml(response?.jyutpingHtml || annotatorText), originalText, annotatorText);
  let primaryParts = choosePrimaryParts(originalText, pinyinParts, jyutpingParts);

  if (isSingleUnannotatedPart(primaryParts, originalText) && (response?.charPinyinHtml || response?.charJyutpingHtml)) {
    const fallbackPinyinParts = parseAnnotatedHtml(response?.charPinyinHtml || originalText).filter((part) => part.base && part.base.trim());
    const fallbackJyutpingParts = parseAnnotatedHtml(response?.charJyutpingHtml || originalText).filter((part) => part.base && part.base.trim());
    const fallbackPrimaryParts = choosePrimaryParts(originalText, fallbackPinyinParts, fallbackJyutpingParts).filter((part) => part.base && part.base.trim());
    if (!isSingleUnannotatedPart(fallbackPrimaryParts, originalText)) {
      pinyinParts = fallbackPinyinParts;
      jyutpingParts = fallbackJyutpingParts;
      primaryParts = fallbackPrimaryParts;
    }
  }

  if (isSingleUnannotatedPart(primaryParts, originalText) && response?.cedictGlosses) {
    primaryParts = splitUnannotatedChineseParts(originalText, response.cedictGlosses);
  }

  // Wrap the units in a single run element. This gives the inter-unit gaps
  // their own inline-selection context: `.ca-run::selection` can then blank the
  // native blue highlight in those gaps (which otherwise belongs to the page's
  // paragraph and can't be targeted). It also carries the same restore
  // attributes as a unit, so clearAnnotations() unwraps it unchanged.
  const run = document.createElement("span");
  run.className = "ca-run";
  run.dataset.caAnnotation = "true";
  run.dataset.caOriginal = originalText;
  const pageOriginal = originalForConvertedBase(originalText);
  if (pageOriginal && pageOriginal !== originalText) run.dataset.caPageOriginal = pageOriginal;

  for (let index = 0; index < primaryParts.length; index++) {
    const primary = primaryParts[index];
    const pinyin = findMatchingPart(primary, pinyinParts, index);
    const jyutping = findMatchingPart(primary, jyutpingParts, index);
    const cedictEnglish = response?.cedictGlosses?.[primary.base] || "";
    const englishGloss = chooseEnglishGloss(cedictEnglish, pinyin?.title || primary.title || "");
    const unit = createAnnotatedUnit(primary.base, {
      english: englishGloss.short,
      fullEnglish: englishGloss.full,
      jyutping: jyutping?.reading || "",
      pinyin: pinyin?.reading || "",
      hskLevel: response?.hskLevels?.[primary.base] || 0
    });
    run.appendChild(unit);
  }

  return run;
}

function restoreOriginalBases(parts, originalText, annotatorText) {
  if (!Array.isArray(parts) || originalText === annotatorText) return parts;
  const originalChars = Array.from(originalText || "");
  const annotatorChars = Array.from(annotatorText || "");
  let cursor = 0;

  return parts.map((part) => {
    const baseChars = Array.from(part.base || "");
    const start = cursor;
    cursor += baseChars.length;
    if (!baseChars.length || start >= originalChars.length) return part;

    const alignedAnnotator = annotatorChars.slice(start, cursor).join("");
    if (alignedAnnotator !== part.base) {
      const foundAt = annotatorText.indexOf(part.base, start);
      if (foundAt >= 0) {
        const foundLength = Array.from(part.base).length;
        cursor = Array.from(annotatorText.slice(0, foundAt)).length + foundLength;
        return { ...part, base: originalChars.slice(cursor - foundLength, cursor).join("") };
      }
      return part;
    }

    return { ...part, base: originalChars.slice(start, cursor).join("") };
  });
}

function choosePrimaryParts(originalText, pinyinParts, jyutpingParts) {
  const pinyinHasAnnotations = pinyinParts.some((part) => part.reading || part.title);
  if (pinyinHasAnnotations) return pinyinParts;
  const jyutpingHasAnnotations = jyutpingParts.some((part) => part.reading || part.title);
  if (jyutpingHasAnnotations) return jyutpingParts;
  return [{ base: originalText, reading: "", title: "" }];
}

function isSingleUnannotatedPart(parts, originalText) {
  return parts.length === 1 && parts[0].base === originalText && !parts[0].reading && !parts[0].title;
}

function splitUnannotatedChineseParts(text, glosses = {}) {
  const parts = [];
  let buffer = "";
  const flush = () => {
    if (buffer) {
      parts.push({ base: buffer, reading: "", title: "" });
      buffer = "";
    }
  };

  for (const char of Array.from(text)) {
    if (CHINESE_RE.test(char) && glosses[char]) {
      flush();
      parts.push({ base: char, reading: "", title: glosses[char] });
    } else if (CHINESE_RE.test(char)) {
      flush();
      parts.push({ base: char, reading: "", title: "" });
    } else {
      buffer += char;
    }
  }
  flush();
  return parts.length ? parts : [{ base: text, reading: "", title: "" }];
}

function findMatchingPart(primary, parts, index) {
  if (parts[index] && parts[index].base === primary.base) return parts[index];
  return parts.find((part) => part.base === primary.base) || null;
}

const PINYIN_TONE_MARK_RE = /[\u0101\u00e1\u01ce\u00e0\u0113\u00e9\u011b\u00e8\u012b\u00ed\u01d0\u00ec\u014d\u00f3\u01d2\u00f2\u016b\u00fa\u01d4\u00f9\u01d6\u01d8\u01da\u01dc\u0100\u00c1\u01cd\u00c0\u0112\u00c9\u011a\u00c8\u012a\u00cd\u01cf\u00cc\u014c\u00d3\u01d1\u00d2\u016a\u00da\u01d3\u00d9\u01d5\u01d7\u01d9\u01db\u00fc\u00dc]/;

function looksLikeRomanizationGloss(part) {
  const value = String(part || "").trim();
  if (!value || value === "*") return true;
  if (PINYIN_TONE_MARK_RE.test(value)) return true;
  if (/\b(?:pinyin|jyutping|putonghua|mandarin pronunciation|cantonese pronunciation)\b/i.test(value)) return true;
  if (/^[A-Z][a-z]+(?:[ -][A-Z]?[a-z]+)*$/.test(value) && !/\s/.test(value)) return true;
  return false;
}

function compactEnglishGloss(title) {
  if (!title) return "";

  // Drop the "\u2192 ..." tail first: it lists derived/figurative/slang senses that
  // are rarely what's meant in running text (e.g. \u6625 \u2192 "... [\u2192 [love; lust]]").
  const trimmed = String(title).replace(/\u2192.*/g, "");

  // Braced {...} marks the core/literal sense in the engine data (e.g.
  // \u6625 \u2192 "lust/{spring (season)}"), so surface those ahead of looser glosses.
  const bracedSenses = Array.from(trimmed.matchAll(/\{([^}]*)\}/g), (match) => match[1]);
  const plainSenses = trimmed.replace(/\{[^}]*\}/g, "").split(/[\/|;:\u00b7]/);

  const candidates = [...bracedSenses, ...plainSenses]
    .map((part) => part.replace(/\([^)]*\)/g, "").replace(/\[[^\]]*\]/g, "").trim())
    .filter(Boolean)
    .filter((part) => !looksLikeRomanizationGloss(part));

  const preferred = candidates.find((part) => !looksLikeLowPriorityGloss(part));
  const gloss = preferred || candidates[0] || "";
  return truncateGloss(gloss.replace(/\s+/g, " "), 24);
}
function looksLikeLowPriorityGloss(part) {
  const value = String(part || "");
  // "surname X" is listed first for many single characters in CC-CEDICT but is
  // almost never the intended meaning in running text, so demote it (and other
  // low-value glosses) behind any real definition.
  if (/\bsurname\b/i.test(value)) return true;
  if (/\bethnic group\b/i.test(value)) return true;
  if (/^\s*(?:abbr\.|old variant of|variant of)\b/i.test(value)) return true;
  return /\b(?:penis|dick|semen|vulva|vagina|cunt|shit|poo|pornography|euphemistic variant|variant of)\b/i.test(value);
}

// Choose the English gloss for a character/word. CC-CEDICT is preferred, but
// its single-character entries in this dataset are often just "surname X",
// which is meaningless in running text — so when the CC-CEDICT gloss compacts
// down to a low-value entry, fall back to the engine's dictionary gloss (which
// carries the real meaning, e.g. 山 → "mountain"). The engine gloss also wins
// when CC-CEDICT has nothing. A low-value gloss is only used as a last resort.
function chooseEnglishGloss(cedictEnglish, engineTitle) {
  const cedictCompact = cedictEnglish ? compactCedictGloss(cedictEnglish) : "";
  const engineCompact = engineTitle ? compactEnglishGloss(engineTitle) : "";

  if (cedictCompact && !looksLikeLowPriorityGloss(cedictCompact)) {
    return { short: cedictCompact, full: cedictEnglish };
  }
  if (engineCompact && !looksLikeLowPriorityGloss(engineCompact)) {
    return { short: engineCompact, full: engineTitle };
  }
  // Nothing meaningful available — prefer whichever exists, engine first.
  if (engineCompact) return { short: engineCompact, full: engineTitle };
  return { short: cedictCompact, full: cedictEnglish };
}

function compactCedictGloss(gloss) {
  if (!gloss) return "";
  const candidates = String(gloss)
    .split(/[;\/|]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !looksLikeRomanizationGloss(part));
  const preferred = candidates.find((part) => !looksLikeLowPriorityGloss(part));
  const best = preferred || candidates[0] || gloss;
  return truncateGloss(best.replace(/\s+/g, " "), 24);
}
function truncateGloss(gloss, maxLength) {
  if (gloss.length <= maxLength) return gloss;
  const trimmed = gloss.slice(0, maxLength + 1);
  const lastSpace = trimmed.lastIndexOf(" ");
  return `${trimmed.slice(0, lastSpace > 8 ? lastSpace : maxLength).trim()}...`;
}
function parseAnnotatedHtml(html) {
  const documentForHtml = new DOMParser().parseFromString(`<span>${html}</span>`, "text/html");
  const container = documentForHtml.body.firstElementChild;
  const parts = [];

  for (const child of container.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (child.nodeValue) parts.push({ base: child.nodeValue, reading: "", title: "" });
      continue;
    }

    if (child.nodeType === Node.ELEMENT_NODE && child.nodeName === "RUBY") {
      parts.push(parseRuby(child));
      continue;
    }

    const rubies = child.nodeType === Node.ELEMENT_NODE ? child.querySelectorAll("ruby") : [];
    if (rubies.length) {
      rubies.forEach((ruby) => parts.push(parseRuby(ruby)));
    } else if (child.textContent) {
      parts.push({ base: child.textContent, reading: "", title: "" });
    }
  }

  return parts;
}

function parseRuby(ruby) {
  const baseNodes = Array.from(ruby.querySelectorAll("rb"));
  const rtNodes = Array.from(ruby.querySelectorAll("rt"));
  const base = baseNodes.length
    ? baseNodes.map((node) => node.textContent).join("")
    : Array.from(ruby.childNodes)
        .filter((node) => node.nodeName !== "RT" && node.nodeName !== "RP")
        .map((node) => node.textContent || "")
        .join("");

  return {
    base,
    reading: rtNodes.map((node) => node.textContent).join(" ").trim(),
    title: ruby.getAttribute("title") || ""
  };
}

function getPinyinTone(value) {
  if (!value) return null;
  if (/[\u0101\u0113\u012b\u014d\u016b\u01d6\u0100\u0112\u012a\u014c\u016a\u01d5]/.test(value)) return 1;
  if (/[\u00e1\u00e9\u00ed\u00f3\u00fa\u01d8\u00c1\u00c9\u00cd\u00d3\u00da\u01d7]/.test(value)) return 2;
  if (/[\u01ce\u011b\u01d0\u01d2\u01d4\u01da\u01cd\u011a\u01cf\u01d1\u01d3\u01d9]/.test(value)) return 3;
  if (/[\u00e0\u00e8\u00ec\u00f2\u00f9\u01dc\u00c0\u00c8\u00cc\u00d2\u00d9\u01db]/.test(value)) return 4;
  const numbered = value.match(/[1-5](?!.*[1-5])/);
  return numbered ? Number(numbered[0]) : 5;
}

function getJyutpingTone(value) {
  const match = String(value || "").match(/([1-6])(?!.*[1-6])/);
  return match ? Number(match[1]) : null;
}

function extractTone(lines) {
  const pinyin = lines.find((l) => l[0] === "Pinyin")?.[1];
  const jyutping = lines.find((l) => l[0] === "Jyutping")?.[1];

  if (pinyin) return { system: "pinyin", tone: getPinyinTone(pinyin) || 5 };
  if (jyutping) {
    const tone = getJyutpingTone(jyutping);
    if (tone) return { system: "jyutping", tone };
  }
  return null;
}

const PINYIN_INITIALS = ["zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x", "r", "z", "c", "s", "y", "w"];
const PINYIN_FINALS = new Set([
  "a", "ai", "an", "ang", "ao", "e", "ei", "en", "eng", "er", "o", "ong", "ou",
  "i", "ia", "ian", "iang", "iao", "ie", "in", "ing", "iong", "iu",
  "u", "ua", "uai", "uan", "uang", "ui", "un", "uo",
  "v", "ve", "van", "vn", "\u00fc", "\u00fce", "\u00fcan", "\u00fcn",
  // "ue" appears when the üe final is written without dots after j/q/x/y (e.g., xué, yuè).
  "ue"
]);
const PINYIN_DIACRITIC_MAP = {
  "\u0101": "a", "\u00e1": "a", "\u01ce": "a", "\u00e0": "a", "\u0100": "a", "\u00c1": "a", "\u01cd": "a", "\u00c0": "a",
  "\u0113": "e", "\u00e9": "e", "\u011b": "e", "\u00e8": "e", "\u0112": "e", "\u00c9": "e", "\u011a": "e", "\u00c8": "e",
  "\u012b": "i", "\u00ed": "i", "\u01d0": "i", "\u00ec": "i", "\u012a": "i", "\u00cd": "i", "\u01cf": "i", "\u00cc": "i",
  "\u014d": "o", "\u00f3": "o", "\u01d2": "o", "\u00f2": "o", "\u014c": "o", "\u00d3": "o", "\u01d1": "o", "\u00d2": "o",
  "\u016b": "u", "\u00fa": "u", "\u01d4": "u", "\u00f9": "u", "\u016a": "u", "\u00da": "u", "\u01d3": "u", "\u00d9": "u",
  "\u01d6": "\u00fc", "\u01d8": "\u00fc", "\u01da": "\u00fc", "\u01dc": "\u00fc", "\u01d5": "\u00fc", "\u01d7": "\u00fc", "\u01d9": "\u00fc", "\u01db": "\u00fc", "\u00fc": "\u00fc", "\u00dc": "\u00fc"
};

function normalizePinyinLetters(value) {
  return Array.from(value).map((char) => PINYIN_DIACRITIC_MAP[char] || char.toLowerCase()).join("");
}

function isPinyinSyllable(value) {
  if (!value) return false;
  if (PINYIN_FINALS.has(value)) return true;
  return PINYIN_INITIALS.some((initial) => value.startsWith(initial) && PINYIN_FINALS.has(value.slice(initial.length)));
}

function splitPinyinWord(word) {
  const chars = Array.from(word);
  const normalized = normalizePinyinLetters(word);
  const segments = [];
  let index = 0;
  while (index < chars.length) {
    let best = 0;
    for (let end = chars.length; end > index; end--) {
      if (isPinyinSyllable(normalized.slice(index, end))) {
        best = end - index;
        break;
      }
    }
    if (!best) best = 1;
    segments.push(chars.slice(index, index + best).join(""));
    index += best;
  }
  return segments;
}

function splitRomanizationTokens(label, value) {
  if (label === "Jyutping") {
    return String(value).split(/([A-Za-z]+[1-6]?|[^A-Za-z]+)/g).filter(Boolean);
  }
  if (label === "Pinyin") {
    const chunks = String(value).split(/([^A-Za-z\u00c0-\u024f\u1e00-\u1eff\u00fc\u00dc]+)/g).filter(Boolean);
    return chunks.flatMap((chunk) => /^[A-Za-z\u00c0-\u024f\u1e00-\u1eff\u00fc\u00dc]+$/.test(chunk) ? splitPinyinWord(chunk) : [chunk]);
  }
  return [String(value)];
}

function toneClassForToken(label, token) {
  if (label === "Pinyin") return `ca-pinyin-tone-${getPinyinTone(token) || 5}`;
  if (label === "Jyutping") {
    const tone = getJyutpingTone(token);
    return tone ? `ca-jyutping-tone-${tone}` : "";
  }
  return "";
}

function appendRomanizationText(container, label, value) {
  if (label !== "Pinyin" && label !== "Jyutping") {
    container.textContent = value;
    return;
  }

  const displayValue = String(value || "").toLowerCase();
  for (const token of splitRomanizationTokens(label, displayValue)) {
    const span = document.createElement("span");
    span.className = "ca-tone-token";
    const toneClass = toneClassForToken(label, token);
    if (toneClass) span.classList.add(toneClass);
    span.textContent = token;
    container.appendChild(span);
  }
}

function createAnnotatedUnit(base, annotations) {
  if (!CHINESE_RE.test(base)) return document.createTextNode(base);

  const lines = [];
  if (annotations.english) lines.push(["English", annotations.english]);
  if (annotations.jyutping) lines.push(["Jyutping", annotations.jyutping]);
  if (annotations.pinyin) lines.push(["Pinyin", annotations.pinyin]);

  if (!lines.length) return document.createTextNode(base);

  const unit = document.createElement("span");
  unit.className = "ca-unit";
  unit.dataset.caAnnotation = "true";
  unit.dataset.caOriginal = base;
  if (annotations.fullEnglish) unit.dataset.caFullEnglish = annotations.fullEnglish;
  const pageOriginal = originalForConvertedBase(base);
  if (pageOriginal) unit.dataset.caPageOriginal = pageOriginal;
  unit.title = [
    ...lines.map(([label, value]) => `${label}: ${value}`),
    settings.showEnglish && annotations.fullEnglish ? `Full English: ${annotations.fullEnglish}` : ""
  ].filter(Boolean).join("\n");

  const lineBox = document.createElement("span");
  lineBox.className = "ca-lines";
  for (const [label, value] of lines) {
    const line = document.createElement("span");
    line.className = `ca-line ca-${label.toLowerCase()}`;
    
    if (label === "Pinyin") {
      const toneInfo = extractTone([["Pinyin", value]]);
      if (toneInfo) line.classList.add(`ca-${toneInfo.system}-tone-${toneInfo.tone}`);
    } else if (label === "Jyutping") {
      const toneInfo = extractTone([["Jyutping", value]]);
      if (toneInfo) line.classList.add(`ca-${toneInfo.system}-tone-${toneInfo.tone}`);
    }
    
    line.dataset.caSpeakLabel = label;
    line.dataset.caSpeakValue = value;
    line.dataset.caSpeakBase = base;

    const textNode = document.createElement("span");
    textNode.className = "ca-line-text";
    appendRomanizationText(textNode, label, value);

    const speakButton = document.createElement("button");
    speakButton.type = "button";
    speakButton.className = "ca-speak";
    speakButton.textContent = "🔊";
    speakButton.title = `Read ${label}`;
    speakButton.setAttribute("aria-label", `Read ${label}: ${value}`);

    attachSpeakerVisibility(line);
    line.append(textNode, speakButton);
    lineBox.appendChild(line);
  }

  if (annotations.hskLevel) {
    const label = annotations.hskLevel >= 7 ? "7-9" : String(annotations.hskLevel);
    unit.dataset.caHsk = label;
    const badge = document.createElement("span");
    badge.className = `ca-hsk-badge ca-hsk-${annotations.hskLevel}`;
    badge.textContent = `HSK ${label}`;
    lineBox.insertBefore(badge, lineBox.firstChild);
  }

  const baseNode = document.createElement("span");
  baseNode.className = "ca-base";
  baseNode.textContent = base;

  unit.append(lineBox, baseNode);
  return unit;
}


function attachSpeakerVisibility(line) {
  installGlobalSpeakerHandlers();
}

function appendDictionaryRow(container, label, value) {
  if (!value) return;

  const row = document.createElement("div");
  row.className = "ca-dict-row";

  const labelNode = document.createElement("span");
  labelNode.className = "ca-dict-label";
  labelNode.textContent = `${label}:`;

  const valueNode = document.createElement("span");
  valueNode.className = "ca-dict-value";
  if (label === "English" && settings.enableEnglishColoring) valueNode.style.color = settings.englishColor;
  appendRomanizationText(valueNode, label, value);

  row.append(labelNode, valueNode);
  container.appendChild(row);
}

function toggleDictionaryPopup(unit, baseNode) {
  const wasActive = unit.classList.contains("ca-popup-active");
  closeDictionaryPopup();
  if (wasActive) return;

  const rows = Array.from(unit.querySelectorAll(".ca-line"))
    .map((line) => [line.dataset.caSpeakLabel || "", line.dataset.caSpeakValue || ""])
    .filter(([label, value]) => label && value);
  if (!rows.length) return;

  const popup = document.createElement("div");
  popup.className = "ca-dictionary-popup";

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "ca-dict-close";
  closeButton.textContent = "×";
  closeButton.setAttribute("aria-label", "Close");
  closeButton.addEventListener("click", (event) => {
    event.stopPropagation();
    closeDictionaryPopup();
  });
  popup.appendChild(closeButton);

  const rowMap = Object.fromEntries(rows);
  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "ca-dict-save";
  saveButton.textContent = "☆ Save";
  saveButton.title = "Save this word to your list";
  saveButton.addEventListener("click", async (event) => {
    event.stopPropagation();
    saveButton.disabled = true;
    await saveVocabEntry({
      hanzi: unit.dataset.caOriginal || "",
      pinyin: rowMap.Pinyin || "",
      jyutping: rowMap.Jyutping || "",
      english: rowMap.English || "",
      fullEnglish: unit.dataset.caFullEnglish || rowMap.English || "",
      hsk: unit.dataset.caHsk || ""
    });
    saveButton.textContent = "★ Saved";
  });
  popup.appendChild(saveButton);

  const charHeader = document.createElement("div");
  charHeader.className = "ca-dict-char";
  charHeader.textContent = unit.dataset.caOriginal;
  popup.appendChild(charHeader);

  for (const [label, value] of rows) {
    appendDictionaryRow(popup, label, value);
  }

  document.body.appendChild(popup);
  positionDictionaryPopup(popup, baseNode);
  unit.classList.add("ca-popup-active");
}

function closeDictionaryPopup() {
  document.querySelectorAll(".ca-dictionary-popup").forEach((popup) => popup.remove());
  document.querySelectorAll(".ca-popup-active").forEach((popupUnit) => popupUnit.classList.remove("ca-popup-active"));
}

// The popup is position:fixed, so it uses viewport coordinates directly. Anchor
// it under the clicked character, flip above when there's no room below, and
// clamp to the viewport so it never drifts into the top-left corner.
function positionDictionaryPopup(popup, baseNode) {
  const rect = baseNode.getBoundingClientRect();
  const margin = 8;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const pw = popup.offsetWidth;
  const ph = popup.offsetHeight;

  let left = rect.left + rect.width / 2 - pw / 2;
  left = Math.min(Math.max(margin, left), Math.max(margin, vw - pw - margin));

  let top = rect.bottom + margin;
  if (top + ph > vh - margin && rect.top - margin - ph >= margin) {
    top = rect.top - margin - ph; // Not enough room below — flip above the character.
  }
  top = Math.min(Math.max(margin, top), Math.max(margin, vh - ph - margin));

  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
}

let lastPointerDownElement = null;

function installGlobalSpeakerHandlers() {
  if (globalSpeakerHandlersInstalled) return;
  globalSpeakerHandlersInstalled = true;

  document.addEventListener("pointerdown", (event) => {
    lastPointerDownElement = event.target;
  }, true);

  document.addEventListener("mouseover", (event) => {
    const line = event.target.closest?.(".ca-line");
    if (line) showSpeaker(line);
  });

  document.addEventListener("mouseout", (event) => {
    const line = event.target.closest?.(".ca-line");
    if (!line || line.contains(event.relatedTarget)) return;
    scheduleSpeakerHide(line, SPEAKER_HIDE_DELAY_MS);
  });

  document.addEventListener("focusin", (event) => {
    const line = event.target.closest?.(".ca-line");
    if (line) showSpeaker(line);
  });

  document.addEventListener("focusout", (event) => {
    const line = event.target.closest?.(".ca-line");
    if (!line || line.contains(event.relatedTarget)) return;
    scheduleSpeakerHide(line, SPEAKER_HIDE_DELAY_MS);
  });

  document.addEventListener("click", (event) => {
    const baseNode = event.target.closest?.(".ca-base");
    if (baseNode && !event.target.closest(".ca-speak")) {
      event.preventDefault();
      event.stopPropagation();
      const unit = baseNode.closest(".ca-unit");
      if (unit) toggleDictionaryPopup(unit, baseNode);
      return;
    }

    if (!event.target.closest?.(".ca-dictionary-popup")) {
      closeDictionaryPopup();
    }

    const button = event.target.closest?.(".ca-speak");
    if (!button) return;

    const line = button.closest(".ca-line");
    if (!line) return;

    event.preventDefault();
    event.stopPropagation();
    speakAnnotation(
      line.dataset.caSpeakLabel || "English",
      line.dataset.caSpeakValue || "",
      line.dataset.caSpeakBase || "",
      line
    );
  }, true);
}

function showSpeaker(line) {
  // Hide any previously visible speakers immediately, including stale speaking states.
  document.querySelectorAll(".ca-speaker-visible, .ca-speaking").forEach((otherLine) => {
    if (otherLine !== line) forceHideSpeakerLine(otherLine);
  });

  window.clearTimeout(speakerHideTimers.get(line));
  line.classList.add("ca-speaker-visible");
}

function scheduleSpeakerHide(line, delay) {
  window.clearTimeout(speakerHideTimers.get(line));
  if (line.classList.contains("ca-speaking")) return;

  const timer = window.setTimeout(() => {
    line.classList.remove("ca-speaker-visible");
  }, delay);
  speakerHideTimers.set(line, timer);
}

function forceHideSpeakerLine(line) {
  window.clearTimeout(speakerHideTimers.get(line));
  speakerHideTimers.delete(line);

  const speechId = line.dataset.caSpeechId;
  if (speechId) {
    window.clearTimeout(speechUiTimers.get(speechId));
    speechUiTimers.delete(speechId);
    activeSpeechLines.delete(speechId);
    delete line.dataset.caSpeechId;
  }

  line.classList.remove("ca-speaking", "ca-speaker-visible");
}

function estimateSpeechUiDuration(payload) {
  const rate = Number(payload.rate || 1);
  const textLength = String(payload.text || "").length;
  return Math.min(12000, Math.max(1800, textLength * 320 * (1 / Math.max(rate, 0.1)) + 1200));
}

function markSpeakerPlaying(line, speechId, payload) {
  // Clear any currently speaking elements since a new speech cancels the old one.
  activeSpeechLines.forEach((activeLine) => {
    forceHideSpeakerLine(activeLine);
  });
  activeSpeechLines.clear();

  window.clearTimeout(speakerHideTimers.get(line));
  window.clearTimeout(speechUiTimers.get(speechId));
  line.dataset.caSpeechId = speechId;
  line.classList.add("ca-speaker-visible", "ca-speaking");
  activeSpeechLines.set(speechId, line);

  const timer = window.setTimeout(() => {
    markSpeakerFinished(speechId);
  }, estimateSpeechUiDuration(payload));
  speechUiTimers.set(speechId, timer);
}

function markSpeakerFinished(speechId) {
  const line = activeSpeechLines.get(speechId);
  if (!line) return;

  window.clearTimeout(speechUiTimers.get(speechId));
  speechUiTimers.delete(speechId);
  activeSpeechLines.delete(speechId);
  line.classList.remove("ca-speaking");
  delete line.dataset.caSpeechId;
  scheduleSpeakerHide(line, SPEAKER_FINISHED_HIDE_DELAY_MS);
}

function speakAnnotation(label, value, base, line) {
  const payload = speechPayloadForLabel(label, value, base);
  if (!payload.text) return;

  const now = Date.now();
  if (lastSpeakRequest.line === line && (now - lastSpeakRequest.time) < 3000) {
    // If clicked again within 3 seconds, speak much slower
    payload.rate = Math.max(0.1, payload.rate * 0.5);
  }
  lastSpeakRequest.line = line;
  lastSpeakRequest.time = now;

  const speechId = `speech-${now}-${++speechRequestCounter}`;
  payload.id = speechId;
  markSpeakerPlaying(line, speechId, payload);

  // Speak directly from the content script. Injecting a page-context bridge is
  // blocked by strict site CSPs, and CustomEvents lose the user gesture that
  // speech synthesis requires anyway.
  speakFromContentScript(payload);
}

function speechPayloadForLabel(label, value, base) {
  if (label === "Jyutping") {
    return { text: base, lang: "yue-HK", rate: 0.82, voiceName: settings.jyutpingVoice };
  }
  if (label === "Pinyin") {
    return { text: base, lang: "zh-CN", rate: 0.82, voiceName: settings.pinyinVoice };
  }
  return { text: value, lang: "en-US", rate: 0.95, voiceName: settings.englishVoice };
}

function speakFromContentScript(payload) {
  if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
    console.warn("Combined Annotator: speech synthesis is not available.");
    notifySpeechDiagnostic({ id: payload.id, state: "error", error: "Web Speech API is not available in the content script." });
    return;
  }

  const utterance = new SpeechSynthesisUtterance(payload.text);
  utterance.lang = payload.lang;
  utterance.rate = payload.rate;

  const voices = window.speechSynthesis.getVoices();
  const normalizedLang = String(payload.lang || "").toLowerCase();
  const normalizedPreferred = String(payload.voiceName || "").toLowerCase();
  let voice = null;

  if (normalizedPreferred) {
    voice = voices.find((v) => v.name.toLowerCase() === normalizedPreferred);
  }

  if (!voice) {
    voice = voices.find((v) => v.lang && v.lang.toLowerCase() === normalizedLang);
  }
  
  if (!voice) {
    const baseLang = normalizedLang.split("-")[0];
    voice = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(baseLang));
    
    if (!voice && baseLang === "yue") {
      voice = voices.find((v) => v.lang && (v.lang.toLowerCase() === "zh-hk" || v.lang.toLowerCase() === "zh-mo" || v.lang.toLowerCase() === "zh-tw"));
    }
    
    if (!voice && (baseLang === "yue" || baseLang === "zh" || baseLang === "cmn")) {
      voice = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith("zh"));
    }
    
    if (!voice) {
      voice = voices.find((v) => v.default) || voices[0] || null;
    }
  }

  if (voice) {
    utterance.voice = voice;
  }

  // Prevent Firefox from garbage collecting the utterance before it finishes
  window._activeUtterances = window._activeUtterances || new Set();
  window._activeUtterances.add(utterance);

  const cleanup = () => {
    window._activeUtterances.delete(utterance);
  };

  utterance.onstart = () => notifySpeechDiagnostic({ id: payload.id, state: "start", lang: payload.lang });
  utterance.onend = () => {
    notifySpeechDiagnostic({ id: payload.id, state: "end", lang: payload.lang });
    cleanup();
  };
  utterance.oncancel = () => {
    notifySpeechDiagnostic({ id: payload.id, state: "canceled", lang: payload.lang });
    cleanup();
  };
  utterance.onerror = (event) => {
    notifySpeechDiagnostic({ id: payload.id, state: "error", lang: payload.lang, error: event.error || "Unknown speech error" });
    cleanup();
  };

  // Fallback: Firefox occasionally completely drops the onend event for short texts.
  // We estimate duration based on text length and rate, and forcefully clear it.
  const estimatedDurationMs = Math.max(1000, payload.text.length * 300 * (1 / payload.rate));
  window.setTimeout(() => {
    if (window._activeUtterances.has(utterance)) {
      notifySpeechDiagnostic({ id: payload.id, state: "end", lang: payload.lang, fallback: true });
      cleanup();
    }
  }, estimatedDurationMs + 800);

  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

function isTerminalSpeechState(state) {
  return state === "end" || state === "error" || state === "warning" || state === "canceled";
}

function notifySpeechDiagnostic(detail) {
  lastSpeechDiagnostic = detail || {};

  if (lastSpeechDiagnostic.id && isTerminalSpeechState(lastSpeechDiagnostic.state)) {
    markSpeakerFinished(lastSpeechDiagnostic.id);
  }

  const waiters = speechDiagnosticWaiters;
  speechDiagnosticWaiters = waiters.filter((waiter) => {
    if (waiter.matchId && lastSpeechDiagnostic.id !== waiter.matchId) return true;
    window.clearTimeout(waiter.timer);
    waiter.resolve(lastSpeechDiagnostic);
    return false;
  });

  try {
    const result = ext.runtime.sendMessage({ type: "speech-state", detail: lastSpeechDiagnostic });
    if (result && typeof result.catch === "function") result.catch(() => undefined);
  } catch (error) {
    // The popup may be closed; diagnostics are still kept locally for the next request.
  }
}

function waitForSpeechDiagnostic(matchId = "", timeoutMs = 1200) {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      speechDiagnosticWaiters = speechDiagnosticWaiters.filter((waiter) => waiter.resolve !== resolve);
      resolve(lastSpeechDiagnostic || { id: matchId, state: "timeout", error: "No speech diagnostic event came back from the page." });
    }, timeoutMs);
    speechDiagnosticWaiters.push({ matchId, resolve, timer });
  });
}

async function requestSpeechDiagnostics() {
  const id = `diagnostics-${Date.now()}-${++speechRequestCounter}`;
  const available = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;

  // Voices may load asynchronously (especially in Chrome). Wait briefly if none are ready yet.
  let voices = available ? window.speechSynthesis.getVoices() : [];
  if (available && voices.length === 0) {
    voices = await new Promise((resolve) => {
      const synth = window.speechSynthesis;
      const onVoicesChanged = () => {
        synth.removeEventListener("voiceschanged", onVoicesChanged);
        resolve(synth.getVoices());
      };
      synth.addEventListener("voiceschanged", onVoicesChanged);
      window.setTimeout(() => {
        synth.removeEventListener("voiceschanged", onVoicesChanged);
        resolve(synth.getVoices());
      }, 800);
    });
  }

  notifySpeechDiagnostic({
    id,
    state: "diagnostics",
    available,
    voiceCount: voices.length,
    voices: voices.map(v => ({ name: v.name, lang: v.lang, default: v.default, localService: v.localService }))
  });
  return waitForSpeechDiagnostic(id, 1400);
}

async function runSpeechTest(label) {
  const tests = {
    English: { value: "speech test", base: "" },
    Pinyin: { value: "", base: "中文测试" },
    Jyutping: { value: "", base: "中文測試" }
  };
  const test = tests[label] || tests.English;
  const payload = speechPayloadForLabel(label, test.value, test.base);
  payload.id = `speech-test-${Date.now()}-${++speechRequestCounter}`;

  speakFromContentScript(payload);
  return waitForSpeechDiagnostic(payload.id, 1800);
}

function clearAnnotations(root = document.body, options = {}) {
  pageVersion++;
  annotationQueue = [];
  scanQueue = [];
  queuedTextNodes = new WeakSet();
  observedElements = new WeakSet();
  pendingVisibleSweeps = new WeakSet();
  viewportObserver.disconnect();
  observerPaused = true;

  root.querySelectorAll("[data-ca-annotation='true']").forEach((node) => {
    const restored = options.restorePageOriginal
      ? node.dataset.caPageOriginal || node.dataset.caOriginal || node.textContent || ""
      : node.dataset.caOriginal || node.textContent || "";
    node.replaceWith(document.createTextNode(restored));
  });
  root.normalize();

  window.setTimeout(() => {
    observerPaused = false;
    if (anyEnabled()) enqueueScan(document.body);
  }, 0);
}

function reannotateVisiblePage() {
  clearAnnotations();
  window.setTimeout(() => {
    if (anyEnabled()) {
      coverageSweepCount = 0;
      enqueueVisibleContent({ force: true });
      scheduleCoverageSweep();
    }
  }, 0);
}

function handleMutations(mutations) {
  if (observerPaused || !anyEnabled() || settings.hoverOnly) return;
  window.clearTimeout(mutationTimer);
  mutationTimer = window.setTimeout(() => {
    for (const mutation of mutations) {
      if (mutation.type === "characterData") {
        enqueueScan(mutation.target.parentElement);
      }
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
          enqueueScan(document.body);
        }
      }
    }
  }, 120);
}

// Injected overlays/popups follow the extension's Theme setting (not the page's
// prefers-color-scheme) so they stay consistent with the toolbar popup.
function resolveUiTheme(uiTheme) {
  if (uiTheme === "light" || uiTheme === "dark") return uiTheme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyInjectedTheme() {
  document.documentElement.dataset.caTheme = resolveUiTheme(settings.uiTheme || "auto");
}

function applyToneColors(settings) {
  document.body.classList.toggle("ca-english-coloring", Boolean(settings.enableEnglishColoring));
  document.body.classList.toggle("ca-pinyin-tone-coloring", Boolean(settings.enablePinyinToneColoring));
  document.body.classList.toggle("ca-jyutping-tone-coloring", Boolean(settings.enableJyutpingToneColoring));
  document.body.classList.toggle("ca-show-jyutping", Boolean(settings.showJyutping));
  document.body.classList.toggle("ca-show-pinyin", Boolean(settings.showPinyin));
  document.body.classList.toggle("ca-show-english", Boolean(settings.showEnglish));
  document.body.classList.toggle("ca-show-hsk", Boolean(settings.showHsk));
  document.body.style.setProperty("--ca-pinyin-tone-1", settings.pinyinTone1Color);
  document.body.style.setProperty("--ca-pinyin-tone-2", settings.pinyinTone2Color);
  document.body.style.setProperty("--ca-pinyin-tone-3", settings.pinyinTone3Color);
  document.body.style.setProperty("--ca-pinyin-tone-4", settings.pinyinTone4Color);
  document.body.style.setProperty("--ca-pinyin-tone-5", settings.pinyinTone5Color);
  document.body.style.setProperty("--ca-jyutping-tone-1", settings.jyutpingTone1Color);
  document.body.style.setProperty("--ca-jyutping-tone-2", settings.jyutpingTone2Color);
  document.body.style.setProperty("--ca-jyutping-tone-3", settings.jyutpingTone3Color);
  document.body.style.setProperty("--ca-jyutping-tone-4", settings.jyutpingTone4Color);
  document.body.style.setProperty("--ca-jyutping-tone-5", settings.jyutpingTone5Color);
  document.body.style.setProperty("--ca-jyutping-tone-6", settings.jyutpingTone6Color);
  document.body.style.setProperty("--ca-english-color", settings.englishColor);
}

async function refreshFromSettings(nextSettings) {
  const oldSettings = settings;
  settings = nextSettings || (await sendMessage({ type: "get-settings" }));
  applyToneColors(settings);
  applyInjectedTheme();

  if (!oldSettings) {
    reannotateVisiblePage();
    return;
  }

  const hoverChanged = Boolean(settings.hoverOnly) !== Boolean(oldSettings.hoverOnly);

  if (settings.hoverOnly) {
    if (hoverChanged) {
      // Switched into hover-only: drop the full-page annotations; the hover
      // handler re-adds them per block as the reader points at them.
      clearAnnotations();
      document.querySelectorAll("[data-ca-hover-done]").forEach((el) => delete el.dataset.caHoverDone);
    }
    return;
  }

  if (anyEnabled(settings) && (!anyEnabled(oldSettings) || hoverChanged)) {
    coverageSweepCount = 0;
    enqueueVisibleContent({ force: true });
    enqueueScan(document.body);
    scheduleCoverageSweep();
  }
}
ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === "settings-updated") {
      await refreshFromSettings(message.settings);
      return { ok: true };
    }
    if (message?.type === "refresh-visible") {
      reannotateVisiblePage();
      return { ok: true, detail: countVisibleCoverage() };
    }
    if (message?.type === "annotation-coverage") {
      enqueueVisibleContent({ force: true, bodyWide: true });
      scheduleCoverageSweep();
      return { ok: true, detail: countVisibleCoverage() };
    }
    if (message?.type === "context-menu-action") {
      handleContextMenuAction(message.action, message.selectionText);
      return { ok: true };
    }
    if (message?.type === "site-disabled-changed") {
      siteDisabled = Boolean(message.disabled);
      if (siteDisabled) {
        clearAnnotations(document.body, { restorePageOriginal: false });
      } else {
        settings = await sendMessage({ type: "get-settings" });
        applyToneColors(settings);
        if (anyEnabled()) {
          coverageSweepCount = 0;
          enqueueVisibleContent({ force: true, bodyWide: true });
          enqueueScan(document.body);
          scheduleCoverageSweep();
        }
      }
      return { ok: true };
    }
    if (message?.type === "page-conversion-action") {
      const action = message.action || message.settings?.action;
      return { ok: true, changed: await handlePageConversion(action) };
    }
    if (message?.type === "export-csv") {
      exportVocabularyCsv();
      return { ok: true };
    }
    if (message?.type === "speech-diagnostics") {
      return { ok: true, detail: await requestSpeechDiagnostics() };
    }
    if (message?.type === "speech-test") {
      if (message.settings) settings = message.settings;
      return { ok: true, detail: await runSpeechTest(message.label || "English") };
    }
    return null;
  })().then(sendResponse);
  return true;
});

function selectionIntersectsNode(range, node) {
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
}

function getSelectedAnnotationUnits(selection) {
  const units = [];
  const seen = new Set();
  for (let index = 0; index < selection.rangeCount; index++) {
    const range = selection.getRangeAt(index);
    const root = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    if (!root) continue;

    const candidates = [];
    const directUnit = root.closest?.(".ca-unit");
    if (directUnit) candidates.push(directUnit);
    root.querySelectorAll?.(".ca-unit").forEach((unit) => candidates.push(unit));

    for (const unit of candidates) {
      if (seen.has(unit) || !selectionIntersectsNode(range, unit)) continue;
      seen.add(unit);
      units.push(unit);
    }
  }
  return units.sort((a, b) => {
    const position = a.compareDocumentPosition(b);
    return position & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1;
  });
}

// Determine which single annotation layer a selection is about, based on where
// it was anchored (the pointer-down target, or the selection anchor as a
// fallback): a Chinese base → "Chinese", a romanization/gloss line → its label.
function primarySelectedKind(selection) {
  let node = lastPointerDownElement;

  if (node && !selection.containsNode(node, true)) node = null;
  if (!node && selection && selection.anchorNode) node = selection.anchorNode;
  if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  if (!node) return "Chinese";

  if (node.closest(".ca-base")) return "Chinese";

  const line = node.closest(".ca-line");
  if (line) return line.dataset.caSpeakLabel || "Chinese";

  return "Chinese";
}

function allEnabledKinds() {
  const kinds = new Set();
  if (settings.showEnglish) kinds.add("English");
  if (settings.showJyutping) kinds.add("Jyutping");
  if (settings.showPinyin) kinds.add("Pinyin");
  kinds.add("Chinese");
  return kinds;
}

function valueForUnitKind(unit, kind) {
  if (kind === "Chinese") return unit.dataset.caOriginal || "";
  const line = unit.querySelector(`.ca-${kind.toLowerCase()}`);
  return line?.dataset?.caSpeakValue || "";
}

function buildAnnotationCopyText(units) {
  const format = settings.copyFormat || "smart";

  // "smart" and "horizontal": copy only the single detected layer, horizontally
  if (format === "smart" || format === "horizontal") {
    const selection = window.getSelection();
    const kind = primarySelectedKind(selection);
    const values = units.map((unit) => valueForUnitKind(unit, kind)).filter(Boolean);
    if (!values.length) return "";
    return kind === "Chinese" ? values.join("") : values.join(" ");
  }

  const kinds = allEnabledKinds();

  // Determine layer order based on format
  const isBottomUp = format === "all-bottom-top" || format === "per-char-bottom-top";
  const order = isBottomUp
    ? ["Chinese", "Pinyin", "Jyutping", "English"]
    : ["English", "Jyutping", "Pinyin", "Chinese"];

  // Per-character interleaved: each character gets all its layers stacked, separated by blank lines
  if (format === "per-char-top-bottom" || format === "per-char-bottom-top") {
    const blocks = [];
    for (const unit of units) {
      const parts = [];
      for (const kind of order) {
        if (kinds.has(kind)) {
          const val = valueForUnitKind(unit, kind);
          if (val) parts.push(val);
        }
      }
      if (parts.length) blocks.push(parts.join("\n"));
    }
    return blocks.join("\n\n");
  }

  // All-layers grouped horizontally: each layer is one horizontal line
  const lines = [];
  for (const kind of order) {
    if (!kinds.has(kind)) continue;
    const values = units.map((unit) => valueForUnitKind(unit, kind)).filter(Boolean);
    if (!values.length) continue;
    lines.push(kind === "Chinese" ? values.join("") : values.join(" "));
  }
  return lines.join("\n");
}

function handleAnnotationCopy(event) {
  try {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;

    const units = getSelectedAnnotationUnits(selection);
    if (!units.length) return; // Fall through to the browser's default copy.

    const text = buildAnnotationCopyText(units);
    if (!text) return;

    event.preventDefault();
    event.clipboardData.setData("text/plain", text);
  } catch (error) {
    console.warn("Combined Annotator: copy handling failed", error);
  }
}

function exportVocabularyCsv() {
  const units = document.querySelectorAll(".ca-unit");
  const seen = new Set();
  const rows = [["Chinese", "Pinyin", "Jyutping", "English"]];
  
  for (const unit of units) {
    const hanzi = unit.dataset.caOriginal;
    if (!hanzi || seen.has(hanzi)) continue;
    seen.add(hanzi);
    
    let pinyin = "", jyutping = "", english = "";
    
    unit.querySelectorAll(".ca-line").forEach(line => {
      const label = line.dataset.caSpeakLabel;
      const value = line.dataset.caSpeakValue;
      if (label === "Pinyin") pinyin = value;
      else if (label === "Jyutping") jyutping = value;
      else if (label === "English") english = value;
    });
    
    if (unit.dataset.caFullEnglish) {
      english = unit.dataset.caFullEnglish.replace("Full English: ", "");
    }
    
    const escapeCsv = (str) => `"${(str || "").replace(/"/g, '""')}"`;
    rows.push([hanzi, pinyin, jyutping, english].map(escapeCsv));
  }
  
  const csvContent = rows.map(e => e.join(",")).join("\n");
  const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "annotator-vocabulary.csv";
  a.click();
  URL.revokeObjectURL(url);
}

function handleSelectionChange() {
  document.querySelectorAll(".ca-visually-selected").forEach(el => el.classList.remove("ca-visually-selected"));
  
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount || !settings) return;
  
  const format = settings.copyFormat || "smart";
  if (format !== "smart" && format !== "horizontal") return;
  
  const units = getSelectedAnnotationUnits(selection);
  if (!units.length) return;
  
  const kind = primarySelectedKind(selection);
  
  for (const unit of units) {
    if (kind === "Chinese") {
      const base = unit.querySelector(".ca-base");
      if (base) base.classList.add("ca-visually-selected");
    } else {
      const line = unit.querySelector(`.ca-${kind.toLowerCase()}`);
      if (line) line.classList.add("ca-visually-selected");
    }
  }
}

async function init() {
  if (!document.body) return;
  const storage = await ext.storage.local.get("disabledSites");
  const disabledSites = storage.disabledSites || [];
  // Track the disabled state instead of bailing out, so the observers and
  // listeners exist and the site can be re-enabled live from the popup.
  siteDisabled = disabledSites.includes(window.location.hostname);

  installGlobalSpeakerHandlers();
  document.addEventListener("copy", handleAnnotationCopy);
  document.addEventListener("selectionchange", handleSelectionChange);
  settings = await sendMessage({ type: "get-settings" });
  applyToneColors(settings);
  applyInjectedTheme();
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if ((settings.uiTheme || "auto") === "auto") applyInjectedTheme();
  });
  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });
  window.addEventListener("scroll", scheduleViewportRefresh, { passive: true });
  window.addEventListener("resize", scheduleViewportRefresh, { passive: true });
  document.addEventListener("mouseover", handleHoverAnnotate, { passive: true });
  if (anyEnabled() && !settings.hoverOnly) {
    enqueueVisibleContent({ force: true });
    enqueueScan(document.body);
    scheduleCoverageSweep();
  }
}

// Hover-only mode: instead of annotating the whole page, annotate the block a
// reader points at, the first time they point at it.
let hoverAnnotateTimer = 0;
function handleHoverAnnotate(event) {
  if (!settings.hoverOnly || !anyEnabled()) return;
  const target = event.target;
  if (!target || target.nodeType !== Node.ELEMENT_NODE || isSkippableElement(target)) return;
  const host = target.closest("p, li, td, th, dd, dt, h1, h2, h3, h4, h5, h6, blockquote, figcaption, span, a, div") || target;
  if (host.dataset.caHoverDone || isSkippableElement(host)) return;
  if (!CHINESE_RE.test(host.textContent || "")) return;
  host.dataset.caHoverDone = "1";
  window.clearTimeout(hoverAnnotateTimer);
  hoverAnnotateTimer = window.setTimeout(() => {
    if (host.isConnected && anyEnabled()) enqueueVisibleText(host, { force: true });
  }, 60);
}

init().catch((error) => console.error("Combined Annotator content error:", error));

const originalTextNodes = new WeakMap();
const originalTextByConvertedText = new Map();

function rememberConvertedOriginal(original, converted) {
  if (!original || !converted || original === converted) return;
  originalTextByConvertedText.set(converted, original);
  const originalChars = Array.from(original);
  const convertedChars = Array.from(converted);
  if (originalChars.length === convertedChars.length) {
    for (let index = 0; index < convertedChars.length; index++) {
      if (originalChars[index] !== convertedChars[index]) {
        originalTextByConvertedText.set(convertedChars[index], originalChars[index]);
      }
    }
  }
}

function originalForConvertedBase(base) {
  if (!base) return "";
  const exact = originalTextByConvertedText.get(base);
  if (exact) return exact;
  const chars = Array.from(base);
  const restored = chars.map((char) => originalTextByConvertedText.get(char) || char).join("");
  return restored !== base ? restored : "";
}

async function handlePageConversion(mode) {
  if (!document.body) return 0;
  if (mode !== "page-traditional" && mode !== "page-simplified" && mode !== "page-original") return 0;

  const shouldReannotate = anyEnabled();
  clearAnnotations(document.body, { restorePageOriginal: mode === "page-original" });

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue || !CHINESE_RE.test(node.nodeValue)) continue;
    if (node.parentElement && ["SCRIPT", "STYLE", "NOSCRIPT"].includes(node.parentElement.tagName)) continue;
    if (node.parentElement?.closest("[data-ca-stroke-overlay]")) continue;
    if (node.parentElement?.id === "ca-revert-floating-btn") continue;
    nodes.push(node);
  }

  // Capture each node's original text before touching the DOM, then resolve the
  // replacement text (a single background round-trip for the whole page).
  const originals = nodes.map((textNode) => {
    const original = originalTextNodes.get(textNode) || textNode.nodeValue;
    if (!originalTextNodes.has(textNode)) originalTextNodes.set(textNode, original);
    return original;
  });

  let nextValues;
  if (mode === "page-original") {
    nextValues = originals;
  } else {
    nextValues = await convertManyViaBackground(originals, mode === "page-traditional" ? "traditional" : "simplified");
  }

  let changed = 0;
  observerPaused = true;
  for (let index = 0; index < nodes.length; index++) {
    const textNode = nodes[index];
    if (!textNode.isConnected) continue;
    const original = originals[index];
    const nextValue = nextValues[index];
    if (textNode.nodeValue !== nextValue) {
      if (mode !== "page-original") rememberConvertedOriginal(original, nextValue);
      textNode.nodeValue = nextValue;
      changed++;
    }
  }

  window.setTimeout(() => {
    observerPaused = false;
    if (shouldReannotate) {
      coverageSweepCount = 0;
      enqueueVisibleContent({ force: true, bodyWide: true });
      enqueueScan(document.body);
      scheduleCoverageSweep();
    }
  }, 0);

  if (mode === "page-original") {
    document.getElementById("ca-revert-floating-btn")?.remove();
  } else if (changed > 0) {
    let revertBtn = document.getElementById("ca-revert-floating-btn");
    if (!revertBtn) {
      revertBtn = document.createElement("button");
      revertBtn.id = "ca-revert-floating-btn";
      revertBtn.textContent = "Revert Chinese";
      revertBtn.style.cssText = "position:fixed;bottom:20px;right:20px;z-index:2147483647;background:white;border:1px solid #e2e8f0;padding:8px 12px;border-radius:8px;box-shadow:0 4px 6px -1px rgba(0,0,0,0.1);cursor:pointer;font-family:system-ui,sans-serif;color:#1a202c;font-weight:600;font-size:14px;";
      revertBtn.onclick = () => handlePageConversion("page-original");
      document.body.appendChild(revertBtn);
    }
  }

  return changed;
}
async function handleContextMenuAction(action, text) {
  if (action === "convert-traditional" || action === "convert-simplified") {
    const selection = window.getSelection();
    if (!selection.rangeCount) return;

    const range = selection.getRangeAt(0);
    const converted = await convertViaBackground(text, action === "convert-traditional" ? "traditional" : "simplified");

    try {
      range.deleteContents();
      range.insertNode(document.createTextNode(converted));
    } catch (error) {
      console.warn("Combined Annotator: could not replace selection", error);
    }
  } else if (action === "stroke-order-simplified" || action === "stroke-order-traditional") {
    showStrokeOrderOverlay(text, action === "stroke-order-traditional" ? "traditional" : "simplified");
  } else if (action === "read-aloud-jyutping" || action === "read-aloud-pinyin" || action === "read-aloud-english") {
    let lang = "en-US";
    let voice = settings.englishVoice;
    
    if (action === "read-aloud-jyutping") {
      lang = "yue-HK";
      voice = settings.jyutpingVoice;
    } else if (action === "read-aloud-pinyin") {
      lang = "zh-CN";
      voice = settings.pinyinVoice;
    }
    // Jyutping/Pinyin read the actual Chinese characters aloud in the matching
    // dialect voice (yue-HK / zh-CN) — the TTS engine pronounces the hanzi, so
    // we must NOT feed it the romanization string ("ceon1 min4"). English reads
    // the gloss text instead.
    let kind = action === "read-aloud-english" ? "English" : "Chinese";

    const now = Date.now();
    let extractedText = text || "";
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const units = getSelectedAnnotationUnits(selection);
      if (units.length > 0) {
        // Pull only the relevant layer from each selected unit. Never fall back
        // to the raw selection string — it contains every stacked layer
        // (English + Jyutping + Pinyin + Chinese), which reads back repetitively.
        let values = units.map((u) => valueForUnitKind(u, kind)).filter(Boolean);
        if (!values.length && kind !== "Chinese") {
          // English gloss unavailable — read the characters instead.
          kind = "Chinese";
          values = units.map((u) => valueForUnitKind(u, "Chinese")).filter(Boolean);
        }
        extractedText = kind === "Chinese" ? values.join("") : values.join(" ");
      }
    }
    const normalizedText = String(extractedText).replace(/\s+/g, " ").trim();
    const repeatKey = `${action}:${normalizedText}`;
    const shouldReadSlower = repeatKey === lastContextSpeakRequest.key && (now - lastContextSpeakRequest.time) < 8000;
    lastContextSpeakRequest = { key: repeatKey, time: now };
    
    const payload = {
      id: `speech-context-${now}`,
      text: normalizedText,
      lang: lang,
      rate: shouldReadSlower ? 0.41 : 0.82,
      voiceName: voice
    };

    if (!payload.text) return;

    speakFromContentScript(payload);
  }
}


















function installStrokeOrderContextTracker() {
  document.addEventListener("contextmenu", (event) => {
    lastContextChineseCharacter = findChineseCharacterFromPoint(event) || "";
  }, true);
}

function findChineseCharacterFromPoint(event) {
  const unit = event.target.closest?.(".ca-unit");
  const unitText = unit?.dataset?.caOriginal || "";
  const unitChar = firstChineseCharacter(unitText);
  if (unitChar) return unitChar;

  const textNodeInfo = caretTextNodeFromPoint(event.clientX, event.clientY);
  if (textNodeInfo?.node?.nodeValue) {
    const value = textNodeInfo.node.nodeValue;
    const offset = Math.max(0, Math.min(textNodeInfo.offset || 0, value.length));
    const nearby = `${value.slice(Math.max(0, offset - 2), offset)}${value.slice(offset, offset + 2)}`;
    const nearbyChar = firstChineseCharacter(nearby);
    if (nearbyChar) return nearbyChar;
  }

  return firstChineseCharacter(event.target.textContent || "");
}

function caretTextNodeFromPoint(x, y) {
  if (document.caretPositionFromPoint) {
    const position = document.caretPositionFromPoint(x, y);
    if (position?.offsetNode?.nodeType === Node.TEXT_NODE) {
      return { node: position.offsetNode, offset: position.offset };
    }
  }

  if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y);
    if (range?.startContainer?.nodeType === Node.TEXT_NODE) {
      return { node: range.startContainer, offset: range.startOffset };
    }
  }

  return null;
}

function firstChineseCharacter(text) {
  return extractChineseCharacters(text)[0] || "";
}

function extractChineseCharacters(text) {
  const chars = [];
  const seen = new Set();
  for (const char of String(text || "")) {
    if (!CHINESE_RE.test(char) || seen.has(char)) continue;
    seen.add(char);
    chars.push(char);
    if (chars.length >= 32) break;
  }
  return chars;
}

function strokeSourceText(text) {
  return extractChineseCharacters(text).length ? text : lastContextChineseCharacter;
}

async function normalizeStrokeCharacters(text, mode) {
  const source = strokeSourceText(text);
  const converted = await convertViaBackground(source || "", mode === "traditional" ? "traditional" : "simplified");
  return extractChineseCharacters(converted);
}

async function showStrokeOrderOverlay(text, mode) {
  const sourceText = strokeSourceText(text);
  const chars = await normalizeStrokeCharacters(sourceText, mode);
  if (!chars.length) {
    showStrokeOrderNotice("Select or right-click a Chinese character first.");
    return;
  }

  closeStrokeOrderOverlay();
  closeDictionaryPopup(); // Don't let a stale dictionary popup sit on top of the overlay.
  await ensureHanziWriter(); // Loaded on demand rather than in every frame.

  const overlay = document.createElement("div");
  overlay.className = "ca-stroke-overlay";
  overlay.dataset.caStrokeOverlay = "true";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "false");
  overlay.setAttribute("aria-label", "Chinese stroke order");

  const panel = document.createElement("div");
  panel.className = "ca-stroke-panel";

  const header = document.createElement("div");
  header.className = "ca-stroke-header";

  const title = document.createElement("div");
  title.className = "ca-stroke-title";
  title.textContent = mode === "traditional" ? "Stroke Order: Traditional" : "Stroke Order: Simplified";

  const headerActions = document.createElement("div");
  headerActions.className = "ca-stroke-header-actions";

  const modeButton = document.createElement("button");
  modeButton.type = "button";
  modeButton.className = "ca-stroke-mode-toggle";
  modeButton.textContent = mode === "traditional" ? "Simplified" : "Traditional";
  modeButton.title = mode === "traditional" ? "Switch to Simplified" : "Switch to Traditional";
  modeButton.addEventListener("click", toggleStrokeOrderMode);
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "ca-stroke-close";
  closeButton.textContent = "×";
  closeButton.setAttribute("aria-label", "Close stroke order");
  closeButton.addEventListener("click", closeStrokeOrderOverlay);

  headerActions.append(modeButton, closeButton);
  header.append(title, headerActions);

  const picker = document.createElement("div");
  picker.className = "ca-stroke-picker";

  const annotationBox = document.createElement("div");
  annotationBox.className = "ca-stroke-annotations";
  const canvas = document.createElement("div");
  canvas.className = "ca-stroke-canvas";

  const status = document.createElement("div");
  status.className = "ca-stroke-status";
  status.setAttribute("aria-live", "polite");

  const controls = document.createElement("div");
  controls.className = "ca-stroke-controls";

  const pauseButton = createStrokeButton("Pause", toggleStrokeAnimationPause);
  const practiceButton = createStrokeButton("Practice", toggleStrokePracticeMode);

  const speedControl = document.createElement("label");
  speedControl.className = "ca-stroke-speed";
  const speedText = document.createElement("span");
  speedText.textContent = "Speed";
  const speedValue = document.createElement("output");
  speedValue.className = "ca-stroke-speed-value";
  speedValue.value = "1.0x";
  speedValue.textContent = "1.0x";
  const speedSlider = document.createElement("input");
  speedSlider.type = "range";
  speedSlider.min = "0.25";
  speedSlider.max = "2.5";
  speedSlider.step = "0.25";
  
  const storage = await ext.storage.local.get("strokeAnimationSpeed");
  const initialSpeed = normalizeStrokeSpeed(storage.strokeAnimationSpeed || 1);
  speedSlider.value = String(initialSpeed);
  
  speedSlider.setAttribute("aria-label", "Stroke animation speed");
  speedSlider.addEventListener("input", () => setStrokeAnimationSpeed(Number(speedSlider.value)));
  speedSlider.addEventListener("change", () => restartStrokeAnimationAtCurrentSpeed());
  speedControl.append(speedText, speedSlider, speedValue);

  controls.append(practiceButton, pauseButton, speedControl);
  panel.append(header, picker, annotationBox, canvas, status, controls);
  overlay.appendChild(panel);
  document.documentElement.appendChild(overlay);

  strokeOverlayState = {
    overlay,
    picker,
    annotationBox,
    canvas,
    status,
    sourceText,
    mode,
    title,
    modeButton,
    chars,
    currentChar: chars[0],
    writer: null,
    speed: initialSpeed,
    isPaused: false,
    isPractice: false,
    pauseButton,
    practiceButton,
    speedSlider,
    speedValue
  };

  buildStrokeCharacterPicker();
  animateStrokeCharacter(chars[0]);
}

async function toggleStrokeOrderMode() {
  if (!strokeOverlayState) return;
  const nextMode = strokeOverlayState.mode === "traditional" ? "simplified" : "traditional";
  const chars = await normalizeStrokeCharacters(strokeOverlayState.sourceText, nextMode);
  if (!chars.length || !strokeOverlayState) return;

  strokeOverlayState.mode = nextMode;
  strokeOverlayState.chars = chars;
  strokeOverlayState.currentChar = chars[0];
  strokeOverlayState.title.textContent = nextMode === "traditional" ? "Stroke Order: Traditional" : "Stroke Order: Simplified";
  strokeOverlayState.modeButton.textContent = nextMode === "traditional" ? "Simplified" : "Traditional";
  strokeOverlayState.modeButton.title = nextMode === "traditional" ? "Switch to Simplified" : "Switch to Traditional";
  buildStrokeCharacterPicker();
  animateStrokeCharacter(chars[0]);
}
function createStrokeButton(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function buildStrokeCharacterPicker() {
  const { picker, chars } = strokeOverlayState;
  picker.textContent = "";
  chars.forEach((char) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ca-stroke-char-button";
    button.textContent = char;
    button.setAttribute("aria-label", `Show stroke order for ${char}`);
    button.addEventListener("click", () => animateStrokeCharacter(char));
    picker.appendChild(button);
  });
}

function animateStrokeCharacter(char, options = {}) {
  if (!strokeOverlayState || !char) return;
  const { canvas, status, picker } = strokeOverlayState;
  const wasPaused = strokeOverlayState.isPaused;
  strokeOverlayState.currentChar = char;
  canvas.textContent = "";
  status.textContent = `Loading ${char}...`;

  picker.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("is-active", button.textContent === char);
  });

  if (!globalThis.HanziWriter) {
    status.textContent = "Stroke animation library did not load.";
    return;
  }

  // Size the character to the canvas box (not the window), so it stays centred
  // and fully inside the panel regardless of viewport width.
  const available = Math.min(canvas.clientWidth, canvas.clientHeight) || 240;
  const size = Math.max(160, Math.min(248, available - 12));
  try {
    strokeOverlayState.writer = globalThis.HanziWriter.create(canvas, char, {
      width: size,
      height: size,
      padding: 8,
      showOutline: true,
      showCharacter: false,
      strokeAnimationSpeed: strokeOverlayState.speed,
      delayBetweenStrokes: 180,
      delayBetweenLoops: 650,
      drawingWidth: 32,
      radicalColor: "#0f766e",
      strokeColor: "#111827",
      outlineColor: "#cbd5e1",
      characterDataLoader: loadStrokeCharacterData
    });
    strokeOverlayState.isPaused = wasPaused;
    updateStrokePlaybackControls();
    updateStrokeStatus();
    updateStrokeAnnotations(char);
    strokeOverlayState.writer.loopCharacterAnimation();
    if (strokeOverlayState.isPaused) strokeOverlayState.writer.pauseAnimation();
  } catch (error) {
    status.textContent = error.message || String(error);
  }
}

function toggleStrokeAnimationPause() {
  if (!strokeOverlayState?.writer) return;
  strokeOverlayState.isPaused = !strokeOverlayState.isPaused;
  if (strokeOverlayState.isPaused) {
    strokeOverlayState.writer.pauseAnimation();
  } else if (!strokeOverlayState.isPractice) {
    strokeOverlayState.writer.resumeAnimation();
  }
  updateStrokePlaybackControls();
  updateStrokeStatus();
}

function toggleStrokePracticeMode() {
  if (!strokeOverlayState?.writer) return;
  const entering = !strokeOverlayState.isPractice;
  try {
    if (entering) {
      // HanziWriter has no cancelAnimation(); quiz() cancels any running quiz
      // and takes over the looping animation itself. It returns a promise, so
      // guard against async rejection separately.
      const result = strokeOverlayState.writer.quiz();
      if (result && typeof result.catch === "function") {
        result.catch((error) => console.warn("Combined Annotator: stroke quiz failed", error));
      }
    } else {
      strokeOverlayState.writer.cancelQuiz();
      strokeOverlayState.writer.loopCharacterAnimation();
      if (strokeOverlayState.isPaused) strokeOverlayState.writer.pauseAnimation();
    }
    strokeOverlayState.isPractice = entering;
  } catch (error) {
    console.warn("Combined Annotator: stroke practice toggle failed", error);
    strokeOverlayState.status.textContent = "Practice mode is unavailable for this character.";
    return;
  }
  updateStrokePlaybackControls();
  updateStrokeStatus();
}

function formatStrokeSpeed(speed) {
  return Number(speed || 1).toFixed(2).replace(/0$/, "").replace(/\.0$/, ".0");
}
function normalizeStrokeSpeed(speed) {
  const value = Math.min(2.5, Math.max(0.25, Number(speed) || 1));
  return Math.round(value / 0.25) * 0.25;
}

function setStrokeAnimationSpeed(speed) {
  if (!strokeOverlayState) return;
  strokeOverlayState.speed = normalizeStrokeSpeed(speed);
  ext.storage.local.set({ strokeAnimationSpeed: strokeOverlayState.speed });
  updateStrokePlaybackControls();
  updateStrokeStatus();
}

function restartStrokeAnimationAtCurrentSpeed() {
  window.clearTimeout(strokeSpeedRestartTimer);
  if (!strokeOverlayState?.currentChar) return;
  animateStrokeCharacter(strokeOverlayState.currentChar, { skipAnnotations: true });
}

function updateStrokePlaybackControls() {
  if (!strokeOverlayState) return;
  strokeOverlayState.pauseButton.textContent = strokeOverlayState.isPaused ? "Resume" : "Pause";
  strokeOverlayState.pauseButton.disabled = strokeOverlayState.isPractice;
  if (strokeOverlayState.practiceButton) {
    strokeOverlayState.practiceButton.textContent = strokeOverlayState.isPractice ? "Stop Practice" : "Practice";
    strokeOverlayState.practiceButton.classList.toggle("is-active", strokeOverlayState.isPractice);
  }
  strokeOverlayState.speedSlider.value = String(strokeOverlayState.speed);
  const speedLabel = `${formatStrokeSpeed(strokeOverlayState.speed)}x`;
  strokeOverlayState.speedValue.value = speedLabel;
  strokeOverlayState.speedValue.textContent = speedLabel;
}

function updateStrokeStatus() {
  if (!strokeOverlayState) return;
  const char = strokeOverlayState.currentChar;
  const index = strokeOverlayState.chars.indexOf(char) + 1;
  const total = strokeOverlayState.chars.length;
  if (strokeOverlayState.isPractice) {
    strokeOverlayState.status.textContent = `${char} (${index}/${total}) - practice: trace the strokes with your mouse`;
    return;
  }
  const state = strokeOverlayState.isPaused ? "paused" : "looping";
  strokeOverlayState.status.textContent = `${char} (${index}/${total}) - ${state} at ${formatStrokeSpeed(strokeOverlayState.speed)}x`;
}

async function updateStrokeAnnotations(char) {
  if (!strokeOverlayState?.annotationBox) return;
  const box = strokeOverlayState.annotationBox;
  box.textContent = "";
  const loading = document.createElement("div");
  loading.className = "ca-stroke-annotation-status";
  loading.textContent = "Loading readings...";
  box.appendChild(loading);

  try {
    const annotations = await getStrokeAnnotations(char);
    if (!strokeOverlayState || strokeOverlayState.currentChar !== char) return;
    renderStrokeAnnotations(annotations);
  } catch (error) {
    if (!strokeOverlayState || strokeOverlayState.currentChar !== char) return;
    box.textContent = "";
    const message = document.createElement("div");
    message.className = "ca-stroke-annotation-status";
    message.textContent = "No readings found.";
    box.appendChild(message);
  }
}

async function getStrokeAnnotations(char) {
  const response = await sendMessage({
    type: "annotate-text",
    text: char,
    leftContext: "",
    rightContext: "",
    settings: { ...settings, showEnglish: true, showJyutping: true, showPinyin: true }
  });
  const pinyinPart = parseAnnotatedHtml(response?.pinyinHtml || char).find((part) => part.base === char) || {};
  const jyutpingPart = parseAnnotatedHtml(response?.jyutpingHtml || char).find((part) => part.base === char) || {};
  const cedictEnglish = response?.cedictGlosses?.[char] || "";
  const englishGloss = chooseEnglishGloss(cedictEnglish, pinyinPart.title || jyutpingPart.title || "");
  return {
    char,
    english: englishGloss.short,
    jyutping: jyutpingPart.reading || "",
    pinyin: pinyinPart.reading || ""
  };
}

function renderStrokeAnnotations(annotations) {
  const box = strokeOverlayState.annotationBox;
  box.textContent = "";
  const rows = [
    ["English", annotations.english],
    ["Jyutping", annotations.jyutping],
    ["Pinyin", annotations.pinyin]
  ].filter(([, value]) => value);

  if (!rows.length) {
    const message = document.createElement("div");
    message.className = "ca-stroke-annotation-status";
    message.textContent = "No readings found.";
    box.appendChild(message);
    return;
  }

  rows.forEach(([label, value]) => {
    const row = document.createElement("div");
    row.className = `ca-stroke-annotation-row ca-stroke-${label.toLowerCase()}`;
    const toneInfo = label === "Pinyin" || label === "Jyutping" ? extractTone([[label, value]]) : null;
    if (toneInfo) row.classList.add(`ca-${toneInfo.system}-tone-${toneInfo.tone}`);

    const name = document.createElement("span");
    name.className = "ca-stroke-annotation-label";
    name.textContent = label;

    const text = document.createElement("span");
    text.className = "ca-stroke-annotation-value";
    appendRomanizationText(text, label, value);

    const speaker = document.createElement("button");
    speaker.type = "button";
    speaker.className = "ca-stroke-annotation-speaker";
    speaker.textContent = "🔊";
    speaker.title = `Read ${label}`;
    speaker.setAttribute("aria-label", `Read ${label}: ${value}`);
    speaker.addEventListener("click", () => speakStrokeAnnotation(label, value, annotations.char));

    row.append(name, text, speaker);
    box.appendChild(row);
  });
}

function speakStrokeAnnotation(label, value, base) {
  const payload = speechPayloadForLabel(label, value, base);
  if (!payload.text) return;
  payload.id = `speech-stroke-${Date.now()}-${++speechRequestCounter}`;
  speakFromContentScript(payload);
}

const strokeDataCache = new Map();

function loadStrokeCharacterData(char, onComplete, onError) {
  if (strokeDataCache.has(char)) {
    onComplete(strokeDataCache.get(char));
    return;
  }
  // Stroke data now lives in a single bundle served from the background (via
  // IndexedDB), instead of one web-accessible file per character.
  sendMessage({ type: "get-stroke-data", char })
    .then((response) => {
      const data = response?.data;
      if (!data) throw new Error(`No stroke data for ${char}`);
      strokeDataCache.set(char, data);
      onComplete(data);
    })
    .catch((error) => {
      if (strokeOverlayState?.currentChar === char) {
        strokeOverlayState.status.textContent = `No stroke data found for ${char}.`;
      }
      if (onError) onError(error);
    });
}

function showStrokeOrderNotice(message) {
  closeStrokeOrderOverlay();
  const overlay = document.createElement("div");
  overlay.className = "ca-stroke-overlay ca-stroke-notice-overlay";
  overlay.dataset.caStrokeOverlay = "true";
  overlay.innerHTML = `<div class="ca-stroke-panel ca-stroke-notice"><div>${message}</div><button type="button">Close</button></div>`;
  overlay.querySelector("button").addEventListener("click", () => overlay.remove());
  document.documentElement.appendChild(overlay);
  window.setTimeout(() => overlay.remove(), 3500);
}

function closeStrokeOrderOverlay() {
  window.clearTimeout(strokeSpeedRestartTimer);
  if (strokeOverlayState?.writer) strokeOverlayState.writer.pauseAnimation();
  if (strokeOverlayState?.overlay) strokeOverlayState.overlay.remove();
  strokeOverlayState = null;
}

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && strokeOverlayState) closeStrokeOrderOverlay();
});