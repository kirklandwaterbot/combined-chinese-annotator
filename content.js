const hasBrowserApi = typeof browser !== "undefined";
const ext = hasBrowserApi ? browser : chrome;
const Core = globalThis.CombinedAnnotatorCore;
const LAYOUT_REVISION = "wide-reading-cards-v5";
const SELECTION_LOGO_DIAGNOSTICS_REVISION = "cross-frame-v2";
document.documentElement.dataset.caLayoutRevision = LAYOUT_REVISION;
document.documentElement.dataset.caSelectionLogoDiagnosticsRevision = SELECTION_LOGO_DIAGNOSTICS_REVISION;

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
const MAX_CONCURRENT_ANNOTATIONS = 4;
const MAX_TEXT_NODE_CHARS = 700;
const BATCH_PAUSE_MS = 24;
const CACHE_LIMIT = 500;
const SPEAKER_HIDE_DELAY_MS = 800;
const SPEAKER_FINISHED_HIDE_DELAY_MS = 0;
const SPEECH_VOICE_WAIT_MS = 800;
const SPEECH_CANCEL_SETTLE_MS = 500;
const STROKE_DATA_TIMEOUT_MS = 8000;
const VIEWPORT_TEXT_MARGIN_PX = 900;
const VIEWPORT_REFRESH_DELAY_MS = 180;
const COVERAGE_SWEEP_DELAY_MS = 650;
const MAX_COVERAGE_SWEEPS = 24;
const FORCE_VISIBLE_NODE_LIMIT = 1800;
const COVERAGE_SAMPLE_LIMIT = 8;
const EDITOR_COPY_FRESHNESS_MS = 5 * 60 * 1000;

let settings = Core.normalizeSettings();
let scanQueue = [];
let scanScheduled = false;
let annotationQueue = [];
let annotationScheduled = false;
let annotationProcessing = false;
let annotationSequence = 0;
let annotationCompletedCount = 0;
let annotationFailedCount = 0;
let annotationTotalQueued = 0;
let annotationStopped = false;
let annotatePlainTextGeneration = 0;
let pausedUntil = 0;
let pauseMode = null;
let mutationTimer = 0;
let observerPaused = false;
let pageVersion = 0;
let pageConversionChain = Promise.resolve();
let speechRequestCounter = 0;
let speechStartSequence = 0;
let activeAzureSpeech = null;
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
let lastContextChineseCharacter = "";
let lastContextSpeak = { key: "", time: 0, slowNext: true };
let strokeOverlayState = null;
let strokeSpeedRestartTimer = 0;
let viewportRefreshTimer = 0;
let coverageSweepTimer = 0;
let coverageSweepCount = 0;
let selectionToolsTimer = 0;
let selectionActionRange = null;
let selectionActionText = "";
let selectionActionUsesClipboard = false;
let selectionToolsDismissedForScroll = false;
let selectionScrollDiagnosticAt = 0;
let lastEditorCopySignal = { source: "none", observedAt: 0 };
let lastSelectionLogoEvaluation = { key: "", observedAt: 0 };

const viewportObserver = new IntersectionObserver(handleIntersections, {
  root: null,
  rootMargin: "1200px 0px",
  threshold: 0
});

const mutationObserver = new MutationObserver(handleMutations);
const layoutRunsByContainer = new WeakMap();
const layoutContextByContainer = new WeakMap();
const layoutContextByRun = new WeakMap();
const layoutUnsafeContainers = new WeakSet();
const observedLayoutContainers = new WeakSet();
const pendingLayoutContainers = new Map();
const observedEditorCopyEvents = new WeakSet();
const READING_CONTAINER_TAGS = new Set(["P", "LI", "DD", "DT", "BLOCKQUOTE", "ARTICLE", "SECTION", "MAIN", "TD", "TH", "H1", "H2", "H3", "H4", "H5", "H6"]);
const COMPACT_UI_SELECTOR = 'nav a, nav [role="link"], [role="navigation"] a, [role="navigation"] [role="link"], [role="menuitem"], [role="tab"], [role="option"], [role="tooltip"]';
const COMPACT_UI_NAME_RE = /(?:^|[-_])(title|metadata|menu|tooltip|overlay|chip|badge|card)(?:[-_]|$)/i;
let layoutFrame = 0;
const layoutObserver = typeof ResizeObserver === "function" ? new ResizeObserver((entries) => {
  for (const entry of entries) pendingLayoutContainers.set(entry.target, entry.contentRect?.width);
  if (layoutFrame) return;
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = 0;
    const pending = Array.from(pendingLayoutContainers.entries());
    pendingLayoutContainers.clear();
    for (const [container, width] of pending) refreshContainerLayouts(container, width);
  });
}) : null;

function annotationLayoutContainer(source) {
  let current = source?.matches?.(".ca-run") ? source.parentElement : source;
  const candidates = [];
  while (current && current !== document.body && candidates.length < 5) {
    const display = getComputedStyle(current).display;
    if (["block", "flex", "grid", "table-cell", "list-item"].includes(display)) {
      const rect = current.getBoundingClientRect?.();
      candidates.push({
        element: current,
        display,
        reading: READING_CONTAINER_TAGS.has(current.nodeName),
        width: Math.max(rect?.width || 0, current.clientWidth || 0)
      });
    }
    current = current.parentElement;
  }
  const selected = Core.chooseLayoutContainerIndex(candidates);
  return candidates[selected]?.element || candidates[0]?.element || current || document.body;
}

function availableInlineWidth(container) {
  const widths = [];
  let current = container;
  for (let depth = 0; current && depth < 3; depth++, current = current.parentElement) {
    const rectWidth = current.getBoundingClientRect?.().width || 0;
    const clientWidth = current.clientWidth || 0;
    if (rectWidth > 0) widths.push(rectWidth);
    if (clientWidth > 0) widths.push(clientWidth);
  }
  return widths.length ? Math.min(...widths) : window.innerWidth;
}

function computedLineHeight(style) {
  const explicit = Number.parseFloat(style?.lineHeight);
  if (Number.isFinite(explicit)) return explicit;
  return (Number.parseFloat(style?.fontSize) || 16) * 1.2;
}

function hasCompactUiName(element) {
  if (!element) return false;
  const names = `${element.id || ""} ${typeof element.className === "string" ? element.className : ""}`;
  return COMPACT_UI_NAME_RE.test(names);
}

function isWideReadingRoleButton(element) {
  if (!element) return false;
  const style = getComputedStyle(element);
  const clamp = Number.parseInt(style.webkitLineClamp, 10);
  const constrained = style.whiteSpace === "nowrap"
    || style.textOverflow === "ellipsis"
    || (Number.isFinite(clamp) && clamp > 0);
  const rect = element.getBoundingClientRect();
  return Core.isWideReadingControl(rect.width, rect.height, computedLineHeight(style), constrained);
}

function isCompactUiSurface(source, container) {
  if (!source || !container || layoutUnsafeContainers.has(container)) return Boolean(container && layoutUnsafeContainers.has(container));
  if (source.closest?.(COMPACT_UI_SELECTOR)) return true;
  const roleButton = source.closest?.('[role="button"]');
  if (roleButton && !isWideReadingRoleButton(roleButton)) return true;
  const width = availableInlineWidth(container);
  if (width < 320 && source.closest?.('a, [role="link"]')) return true;
  let current = source;
  for (let depth = 0; current && depth < 6; depth++, current = current.parentElement) {
    const style = getComputedStyle(current);
    const clamp = Number.parseInt(style.webkitLineClamp, 10);
    if (style.whiteSpace === "nowrap" || style.textOverflow === "ellipsis" || (Number.isFinite(clamp) && clamp > 0)) return true;
    if (width < 720 && hasCompactUiName(current)) return true;
    if (current === container) break;
  }
  const style = getComputedStyle(container);
  const height = container.getBoundingClientRect().height || 0;
  const shortNonReadingUi = !READING_CONTAINER_TAGS.has(container.nodeName)
    && width > 0 && width < 720
    && height > 0 && height <= computedLineHeight(style) * 3.25;
  return shortNonReadingUi;
}

function captureLayoutContext(source) {
  const container = annotationLayoutContainer(source);
  if (!container) return null;
  const style = getComputedStyle(container);
  const rect = container.getBoundingClientRect();
  const compact = isCompactUiSurface(source, container);
  return {
    container,
    width: availableInlineWidth(container),
    compact,
    compactReason: compact ? "compact-ui" : "",
    baselineHeight: rect.height || 0,
    baselineClientWidth: container.clientWidth || rect.width || 0,
    baselineScrollWidth: container.scrollWidth || 0,
    lineHeight: computedLineHeight(style)
  };
}

function primaryLayerForSettings() {
  const configured = settings.primaryLayer;
  if (configured === "jyutping" && settings.showJyutping) return configured;
  if (configured === "pinyin" && settings.showPinyin) return configured;
  if (configured === "english" && settings.showEnglish) return configured;
  if (settings.showJyutping) return "jyutping";
  if (settings.showPinyin) return "pinyin";
  return "english";
}

function applyRunLayout(run, width, context = {}) {
  if (!run) return;
  const mode = Core.chooseSafeLayout(width, settings, context);
  run.dataset.caLayout = mode;
  run.dataset.caPrimary = primaryLayerForSettings();
  if (context.compact) run.dataset.caLayoutGuard = context.compactReason || "compact-ui";
  else delete run.dataset.caLayoutGuard;
}

function refreshContainerLayouts(container, measuredWidth) {
  const runs = layoutRunsByContainer.get(container);
  if (!runs) return;
  const previous = layoutContextByContainer.get(container) || {};
  const liveWidth = availableInlineWidth(container);
  const width = Math.min(...[Number(measuredWidth), liveWidth].filter((value) => value > 0));
  const resolvedWidth = Number.isFinite(width) ? width : liveWidth;
  const containerUnsafe = layoutUnsafeContainers.has(container);
  const context = { ...previous, width: resolvedWidth, compact: containerUnsafe, compactReason: containerUnsafe ? "overflow" : "" };
  layoutContextByContainer.set(container, context);
  for (const run of [...runs]) {
    if (!run.isConnected) {
      runs.delete(run);
      continue;
    }
    const remembered = layoutContextByRun.get(run) || captureLayoutContext(run.parentElement) || {};
    const runCompact = containerUnsafe || isCompactUiSurface(run.parentElement, container);
    const runContext = {
      ...context,
      ...remembered,
      container,
      width: resolvedWidth,
      compact: runCompact,
      compactReason: containerUnsafe ? "overflow" : (runCompact ? "compact-ui" : "")
    };
    layoutContextByRun.set(run, runContext);
    applyRunLayout(run, runContext.width, runContext);
  }
}

function verifyRunLayoutSafety(run, context) {
  if (!run?.isConnected || !context?.container || run.dataset.caLayout === "popup") return;
  // Reading containers are expected to grow vertically as annotations stack.
  // Treating their transient scroll width as a compact-UI failure collapses an
  // entire article paragraph after its annotations briefly appear.
  if (READING_CONTAINER_TAGS.has(context.container.nodeName)) return;
  requestAnimationFrame(() => {
    if (!run.isConnected || !context.container.isConnected || run.dataset.caLayout === "popup") return;
    const clientWidth = context.container.clientWidth || context.container.getBoundingClientRect().width || 0;
    const overflowBefore = Math.max(0, context.baselineScrollWidth - context.baselineClientWidth);
    const overflowAfter = Math.max(0, context.container.scrollWidth - clientWidth);
    if (overflowAfter <= overflowBefore + 4) return;
    layoutUnsafeContainers.add(context.container);
    const safeContext = { ...context, width: availableInlineWidth(context.container), compact: true, compactReason: "overflow" };
    layoutContextByContainer.set(context.container, safeContext);
    const affectedRuns = layoutRunsByContainer.get(context.container) || [run];
    for (const affectedRun of affectedRuns) {
      const affectedContext = { ...(layoutContextByRun.get(affectedRun) || {}), ...safeContext };
      layoutContextByRun.set(affectedRun, affectedContext);
      applyRunLayout(affectedRun, affectedContext.width, affectedContext);
    }
  });
}

function registerRunLayout(run, preparedContext = null) {
  const context = preparedContext?.container?.isConnected ? preparedContext : captureLayoutContext(run?.parentElement);
  const container = context?.container || annotationLayoutContainer(run);
  if (!container) return;
  const previous = layoutContextByContainer.get(container);
  const containerUnsafe = layoutUnsafeContainers.has(container);
  const sharedContext = {
    ...(context || {}),
    ...(previous || {}),
    container,
    width: context?.width || previous?.width || availableInlineWidth(container),
    compact: containerUnsafe,
    compactReason: containerUnsafe ? "overflow" : ""
  };
  const activeContext = {
    ...sharedContext,
    ...(context || {}),
    container,
    width: sharedContext.width,
    compact: Boolean(context?.compact || containerUnsafe),
    compactReason: containerUnsafe ? "overflow" : (context?.compact ? (context.compactReason || "compact-ui") : "")
  };
  layoutContextByContainer.set(container, sharedContext);
  layoutContextByRun.set(run, activeContext);
  if (!layoutRunsByContainer.has(container)) layoutRunsByContainer.set(container, new Set());
  layoutRunsByContainer.get(container).add(run);
  applyRunLayout(run, activeContext.width || availableInlineWidth(container), activeContext);
  verifyRunLayoutSafety(run, activeContext);
  if (layoutObserver && !observedLayoutContainers.has(container)) {
    observedLayoutContainers.add(container);
    layoutObserver.observe(container);
  }
}

function anyEnabled(active = settings) {
  if (siteDisabled) return false;
  if (annotationStopped) return false;
  if (pauseMode === "page") return false;
  if (pauseMode === "timer" && pausedUntil > Date.now()) return false;
  return active.showJyutping || active.showPinyin || active.showEnglish;
}

function scheduleIdle(callback, timeout = 80) {
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(callback, { timeout });
    return;
  }
  window.setTimeout(callback, 0);
}

const SEND_MESSAGE_MAX_RETRIES = 3;
const SEND_MESSAGE_BASE_DELAY_MS = 200;

function sendMessageOnce(message) {
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

function isChannelClosedError(error) {
  const message = String(error?.message || "");
  return message.includes("message channel closed") || message.includes("receiving end does not exist");
}

function sendMessage(message, retries = SEND_MESSAGE_MAX_RETRIES) {
  return sendMessageOnce(message).catch((error) => {
    if (retries > 0 && isChannelClosedError(error)) {
      // Exponential backoff: 200ms, 400ms, 800ms
      const delay = SEND_MESSAGE_BASE_DELAY_MS * Math.pow(2, SEND_MESSAGE_MAX_RETRIES - retries);
      return new Promise((resolve) => window.setTimeout(resolve, delay))
        .then(() => sendMessage(message, retries - 1));
    }
    throw error;
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

let pageLanguageHint = "unknown";

function isNativeCaptionElement(element) {
  if (!element?.closest) return false;
  const candidate = element.closest(
    ".ytp-caption-segment, .ytp-caption-window-container, [data-purpose='captions-cue-text'], [class*='caption' i], [class*='subtitle' i]"
  );
  if (!candidate) return false;
  if (candidate.matches(".ytp-caption-segment, .ytp-caption-window-container, [data-purpose='captions-cue-text']")) return true;
  const className = String(candidate.className || "").toLowerCase();
  if (!className.includes("caption") && !className.includes("subtitle")) return false;
  const style = getComputedStyle(candidate);
  const rect = candidate.getBoundingClientRect();
  return ["fixed", "absolute"].includes(style.position) && rect.top > innerHeight * 0.45;
}

function countMatches(text, regex) {
  return (String(text || "").match(regex) || []).length;
}

function refreshPageLanguageHint() {
  const declared = document.documentElement?.lang || "";
  const declaredKind = Core.classifyLanguage("", declared);
  // A declared non-Chinese language (e.g. lang="en") is authoritative for
  // Japanese/Korean pages, but English-language sites frequently contain
  // Chinese text (language-learning platforms, dictionaries, wikis).  Sample
  // the page body anyway: if it has substantial Chinese text, treat it as
  // Chinese so annotations are not silently disabled.
  if (declaredKind === "zh") {
    pageLanguageHint = "zh";
    return pageLanguageHint;
  }
  const sample = String(document.body?.innerText || document.body?.textContent || "").slice(0, 12000);
  if (declaredKind === "ja" || countMatches(sample, /[\u3040-\u30ff\u31f0-\u31ff]/gu) >= 4) {
    pageLanguageHint = "ja";
    return pageLanguageHint;
  }
  if (declaredKind === "ko" || countMatches(sample, /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/gu) >= 4) {
    pageLanguageHint = "ko";
    return pageLanguageHint;
  }
  // For declared "other" (e.g. en, fr, vi) or "unknown", check whether the
  // page body contains Chinese characters.  If it does, annotate it.
  if (CHINESE_RE.test(sample)) {
    pageLanguageHint = "zh";
    return pageLanguageHint;
  }
  pageLanguageHint = declaredKind !== "unknown" ? declaredKind : "unknown";
  return pageLanguageHint;
}

function languageContextText(node) {
  const original = String(node?.nodeValue || "").replace(/\s+/g, " ").trim();
  let best = original;
  let current = node?.parentElement;
  for (let depth = 0; current && current !== document.body && depth < 6; depth++, current = current.parentElement) {
    const candidate = String(siblingContextText(current) || "").replace(/\s+/g, " ").trim().slice(0, 480);
    if (candidate.length >= best.length) best = candidate;
    const kind = Core.classifyLanguage(candidate, "");
    if (kind === "ja" || kind === "ko" || kind === "other") return candidate;
    if (candidate.length >= 120) break;
    if (current.matches?.("p, li, td, th, dd, dt, h1, h2, h3, h4, h5, h6, blockquote, figcaption, a, [role='link'], [role='heading']") && candidate.length > original.length) break;
  }
  return best.slice(0, 480);
}

function shouldAnnotateNodeLanguage(node) {
  if (settings.languageMode === "force") return true;
  const parent = node?.parentElement;
  if (!parent) return false;
  const langElement = parent.closest("[lang]");
  const declared = langElement?.getAttribute("lang") || "";
  const declaredKind = Core.classifyLanguage("", declared);
  if (declaredKind === "zh") return true;
  if (declaredKind !== "unknown") return false;
  if (pageLanguageHint !== "unknown" && pageLanguageHint !== "zh") return false;
  return Core.shouldAnnotateLanguage(languageContextText(node), declared, "auto");
}

function isSkippableElement(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return true;
  if (SKIP_TAGS.has(element.nodeName)) return true;
  if (isNativeCaptionElement(element)) return true;
  return Boolean(element.closest("[data-ca-annotation], [data-ca-overlay-host], [data-ca-stroke-overlay], [contenteditable='true'], ruby"));
}

function isValidTextNode(node) {
  return (
    node &&
    node.nodeType === Node.TEXT_NODE &&
    node.nodeValue &&
    CHINESE_RE.test(node.nodeValue) &&
    shouldAnnotateNodeLanguage(node) &&
    !isSkippableElement(node.parentElement)
  );
}

function textNodeSkipReason(node) {
  if (!node) return "missing-node";
  if (node.nodeType !== Node.TEXT_NODE) return "not-text";
  if (!node.nodeValue) return "empty";
  if (!CHINESE_RE.test(node.nodeValue)) return "no-chinese";
  if (!shouldAnnotateNodeLanguage(node)) return `language-${pageLanguageHint}`;
  const parent = node.parentElement;
  if (!parent) return "no-parent";
  if (isNativeCaptionElement(parent)) return "native-caption";
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
    processing: annotationProcessing,
    completed: annotationCompletedCount,
    failed: annotationFailedCount,
    revision: LAYOUT_REVISION,
    scanQueue: scanQueue.length,
    cacheEntries: annotationCache.size,
    skippedByReason,
    samples: rawSamples.filter(Boolean)
  };
}

function enqueueTextNode(node, options = {}) {
  if (!isValidTextNode(node)) return;
  // A forced coverage sweep may retry a node after a failure, but it must not
  // duplicate work that is already queued or in flight.
  if (queuedTextNodes.has(node)) return;
  queuedTextNodes.add(node);
  annotationTotalQueued++;
  const preferredRoot = node.parentElement?.closest?.("main, article, [role='main'], #content, #bodyContent, .mw-body, .mw-parser-output");
  annotationQueue.push({
    node,
    version: pageVersion,
    priority: preferredRoot ? 0 : 1,
    sequence: annotationSequence++
  });
  scheduleAnnotationBatch();
}

function scheduleAnnotationBatch() {
  if (annotationScheduled || annotationProcessing) return;
  annotationScheduled = true;
  publishAnnotationDiagnostics();
  window.setTimeout(processAnnotationBatch, BATCH_PAUSE_MS);
}

function publishAnnotationDiagnostics() {
  const root = document.documentElement;
  if (!root) return;
  root.dataset.caAnnotationState = annotationProcessing ? "processing" : (annotationQueue.length ? "queued" : "idle");
  root.dataset.caAnnotationQueue = String(annotationQueue.length);
  root.dataset.caAnnotationCompleted = String(annotationCompletedCount);
  root.dataset.caAnnotationFailed = String(annotationFailedCount);
  root.dataset.caAnnotationTotal = String(annotationTotalQueued);

  // Health status for popup / diagnostics consumers.
  let health = "ready";
  if (siteDisabled || !anyEnabled()) {
    health = "disabled";
  } else if (annotationFailedCount > 5) {
    health = "error";
  } else if (annotationProcessing || annotationQueue.length > 0) {
    health = "annotating";
  }
  root.dataset.caHealth = health;
}

async function processAnnotationBatch() {
  annotationScheduled = false;
  if (annotationProcessing || !anyEnabled()) return;
  annotationProcessing = true;
  publishAnnotationDiagnostics();

  let nodeCount = 0;
  let charCount = 0;
  const batch = [];

  // Keep the reading surface responsive even when navigation and sidebars
  // contain hundreds of Chinese snippets.
  annotationQueue.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);

  while (annotationQueue.length && nodeCount < Math.min(MAX_BATCH_NODES, MAX_CONCURRENT_ANNOTATIONS) && charCount < MAX_BATCH_CHARS) {
    const item = annotationQueue.shift();
    const node = item.node;

    if (item.version !== pageVersion || !isValidTextNode(node)) {
      queuedTextNodes.delete(node);
      continue;
    }

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
    batch.push(item);
  }

  await Promise.all(batch.map(async (item) => {
    const node = item.node;
    try {
      await annotateNode(node, item.version);
      annotationCompletedCount++;
    } catch (err) {
      annotationFailedCount++;
      const skipped = (node.nodeValue || "").replace(/\s+/g, " ").trim();
      console.warn(
        `Combined Annotator: skipped annotating text (${skipped.length} chars): "${skipped.slice(0, 120)}${skipped.length > 120 ? "\u2026" : ""}"`,
        err
      );
    } finally {
      queuedTextNodes.delete(node);
    }
  }));

  annotationProcessing = false;
  publishAnnotationDiagnostics();
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
  // Instead of dropping in-flight annotations when clearAnnotations() bumps
  // pageVersion, check whether the text node is still a live, unannotated
  // text node in the DOM.  If it was already replaced (by another annotation
  // or a page mutation) we skip it; otherwise we apply the fragment.
  if (!node.isConnected || node.nodeType !== Node.TEXT_NODE) return;
  if (node.parentElement?.closest?.("[data-ca-annotation]")) return;
  const parent = node.parentNode;
  const layoutContext = captureLayoutContext(node.parentElement);
  observerPaused = true;
  const clone = fragment.cloneNode(true);
  const insertedRuns = clone.matches?.(".ca-run")
    ? [clone, ...Array.from(clone.querySelectorAll(".ca-run"))]
    : (clone.querySelectorAll ? Array.from(clone.querySelectorAll(".ca-run")) : []);
  parent.replaceChild(clone, node);
  for (const run of insertedRuns) registerRunLayout(run, layoutContext);
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
    const bundledGloss = chooseEnglishGloss(cedictEnglish, pinyin?.title || primary.title || "");
    const custom = response?.customOverrides?.[primary.base] || null;
    const customDefinitions = custom?.definitions || [];
    const englishGloss = custom ? {
      short: customDefinitions[0] || (custom.mode === "replace" ? "" : bundledGloss.short),
      full: custom.mode === "replace" ? customDefinitions.join("; ") : [...customDefinitions, bundledGloss.full].filter(Boolean).join("; ")
    } : bundledGloss;
    const unit = createAnnotatedUnit(primary.base, {
      english: englishGloss.short,
      fullEnglish: englishGloss.full,
      jyutping: custom?.jyutping || jyutping?.reading || "",
      pinyin: custom?.pinyin || pinyin?.reading || "",
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

function restoreAnnotatedTextInClone(clone) {
  clone.querySelectorAll?.(".ca-unit[data-ca-original]").forEach((unit) => {
    unit.replaceWith(document.createTextNode(unit.dataset.caOriginal || ""));
  });
  clone.querySelectorAll?.(".ca-run[data-ca-original]").forEach((run) => {
    run.replaceWith(document.createTextNode(run.dataset.caOriginal || run.textContent || ""));
  });
  return clone;
}

function plainTextForElement(element) {
  if (!element) return "";
  const clone = element.cloneNode(true);
  clone.querySelectorAll("[data-ca-stroke-overlay], .ca-dictionary-popup").forEach((node) => node.remove());
  restoreAnnotatedTextInClone(clone);
  return String(clone.textContent || "").replace(/\s+/g, " ").trim();
}

function extractReaderSelection() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return "";

  const originalSelection = extractOriginalSelection(selection);
  if (CHINESE_RE.test(originalSelection)) return originalSelection;

  const units = getSelectedAnnotationUnits(selection);
  if (units.length) {
    const chinese = units.map((unit) => unit.dataset.caOriginal || "").join("").trim();
    if (CHINESE_RE.test(chinese)) return chinese;
  }

  const holder = document.createElement("div");
  for (let index = 0; index < selection.rangeCount; index++) {
    holder.append(selection.getRangeAt(index).cloneContents());
  }
  return plainTextForElement(holder);
}

function extractOriginalSelection(selection) {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return "";
  const holder = document.createElement("div");
  for (let index = 0; index < selection.rangeCount; index++) {
    holder.append(selection.getRangeAt(index).cloneContents());
  }
  return plainTextForElement(holder);
}

function dictionaryRequestForUnit(unit, characterOffset = 0) {
  const run = unit.closest(".ca-run");
  const units = run ? Array.from(run.querySelectorAll(":scope > .ca-unit")) : [unit];
  let offset = 0;
  for (const candidate of units) {
    if (candidate === unit) break;
    offset += String(candidate.dataset.caOriginal || "").length;
  }
  offset += Math.max(0, Math.min(String(unit.dataset.caOriginal || "").length - 1, Number(characterOffset) || 0));
  const block = unit.closest("p, li, td, th, dd, dt, h1, h2, h3, h4, h5, h6, blockquote, figcaption, article, section, div") || run || unit;
  const blockText = plainTextForElement(block);
  const runText = run?.dataset.caOriginal || unit.dataset.caOriginal || "";
  const blockOffset = blockText.indexOf(runText);
  const sentence = Core.sentenceAround(blockText, Math.max(0, blockOffset) + offset);
  return {
    text: runText,
    offset,
    sentence,
    sourceTitle: document.title,
    sourceUrl: location.href
  };
}

function toggleDictionaryPopup(unit, baseNode, characterOffset = 0) {
  if (globalThis.CombinedAnnotatorUI?.showDictionary) {
    closeDictionaryPopup();
    globalThis.CombinedAnnotatorUI.showDictionary({
      anchor: baseNode,
      unit,
      request: dictionaryRequestForUnit(unit, characterOffset)
    });
    return;
  }
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
      // Annotated text inside a hyperlink must follow the link instead of
      // opening the dictionary popup.
      if (baseNode.closest("a[href]")) {
        closeDictionaryPopup();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const unit = baseNode.closest(".ca-unit");
      let characterOffset = 0;
      const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY);
      if (caret && baseNode.contains(caret.offsetNode)) characterOffset = caret.offset;
      else {
        const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
        if (range && baseNode.contains(range.startContainer)) characterOffset = range.startOffset;
      }
      if (unit) toggleDictionaryPopup(unit, baseNode, characterOffset);
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
    return { text: base, lang: "zh-HK", rate: settings.speechRate, pitch: settings.speechPitch, voiceName: settings.jyutpingVoice, backend: settings.speechBackend };
  }
  if (label === "Pinyin") {
    return { text: base, lang: "zh-CN", rate: settings.speechRate, pitch: settings.speechPitch, voiceName: settings.pinyinVoice, backend: settings.speechBackend };
  }
  return { text: value, lang: "en-US", rate: settings.speechRate, pitch: settings.speechPitch, voiceName: settings.englishVoice, backend: settings.speechBackend };
}

function getSpeechVoices(synth) {
  try {
    return synth.getVoices() || [];
  } catch {
    return [];
  }
}

function waitForSpeechVoices(synth, timeoutMs = SPEECH_VOICE_WAIT_MS) {
  const readyVoices = getSpeechVoices(synth);
  if (readyVoices.length > 0 || typeof synth.addEventListener !== "function") {
    return Promise.resolve(readyVoices);
  }

  return new Promise((resolve) => {
    let settled = false;
    let timer = 0;
    const finish = () => {
      if (settled) return;
      settled = true;
      synth.removeEventListener?.("voiceschanged", finish);
      window.clearTimeout(timer);
      resolve(getSpeechVoices(synth));
    };

    synth.addEventListener("voiceschanged", finish);
    timer = window.setTimeout(finish, timeoutMs);
  });
}

function waitForSpeechQueueReset() {
  return new Promise((resolve) => window.setTimeout(resolve, SPEECH_CANCEL_SETTLE_MS));
}

function isCantoneseLanguage(language) {
  return Core.isCantoneseLanguage(language);
}

function isCantoneseVoice(voice) {
  if (!voice) return false;
  if (isCantoneseLanguage(voice.lang)) return true;
  const description = `${voice.name || ""} ${voice.voiceURI || ""}`.toLowerCase();
  return /cantonese|hong kong|\btracy\b|\bdanny\b/.test(description);
}

function selectSpeechVoice(voices, language, preferredName) {
  const normalizedLang = String(language || "").toLowerCase();
  const normalizedPreferred = String(preferredName || "").toLowerCase();
  const preferred = normalizedPreferred
    ? voices.find((voice) => String(voice.name || "").toLowerCase() === normalizedPreferred)
    : null;
  const bestVoice = (candidates) => Core.rankSpeechVoices(candidates, normalizedLang)[0] || null;

  // Never pass Cantonese text to a Mandarin, Taiwanese Mandarin, or default
  // system voice. It produces fast, breathy gibberish while sounding as if a
  // Cantonese voice was selected successfully.
  if (isCantoneseLanguage(normalizedLang)) {
    if (preferred && isCantoneseVoice(preferred)) return preferred;
    return bestVoice(voices.filter(isCantoneseVoice));
  }

  if (preferred) return preferred;
  let voice = bestVoice(voices.filter((candidate) => candidate.lang && candidate.lang.toLowerCase() === normalizedLang));
  if (voice) return voice;

  const baseLang = normalizedLang.split("-")[0];
  voice = bestVoice(voices.filter((candidate) => candidate.lang && candidate.lang.toLowerCase().startsWith(baseLang)));
  if (!voice && (baseLang === "zh" || baseLang === "cmn")) {
    voice = bestVoice(voices.filter((candidate) => candidate.lang && candidate.lang.toLowerCase().startsWith("zh")));
  }
  return voice || bestVoice(voices.filter((candidate) => candidate.default)) || bestVoice(voices);
}

function showSpeechNotice(message) {
  const existing = document.getElementById("ca-speech-notice");
  existing?.remove();
  const notice = document.createElement("div");
  notice.id = "ca-speech-notice";
  notice.className = "ca-speech-notice";
  notice.setAttribute("role", "status");
  notice.setAttribute("aria-live", "polite");
  notice.textContent = message;
  document.documentElement.append(notice);
  window.setTimeout(() => notice.remove(), 9000);
}

function isCanvasEditorHost(hostname = location.hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "docs.google.com"
    || host === "office.com"
    || host.endsWith(".office.com")
    || host === "microsoft365.com"
    || host.endsWith(".microsoft365.com")
    || host.endsWith(".officeapps.live.com")
    || host === "onedrive.live.com"
    || host.endsWith(".sharepoint.com");
}

function canvasEditorLabel() {
  return location.hostname === "docs.google.com" ? "Google Docs/Slides/Sheets" : "Microsoft Office";
}

function editorCompatibilityDiagnostic(event, detail = {}) {
  if (!isCanvasEditorHost()) return;
  console.info("[Combined Annotator][Google/Office compatibility]", {
    event,
    editor: canvasEditorLabel(),
    frame: window === window.top ? "top" : "child",
    ...detail
  });
}

async function runEditorCompatibilityDiagnostics(reason = "manual-console-request") {
  const selection = window.getSelection();
  let background = null;
  let backgroundError = "";
  try {
    background = await sendMessage({ type: "get-editor-compatibility-diagnostics" }, 1);
  } catch (error) {
    backgroundError = error?.message || String(error);
  }
  const report = {
    reason,
    editorDetected: isCanvasEditorHost(),
    editor: isCanvasEditorHost() ? canvasEditorLabel() : "unsupported host",
    frame: window === window.top ? "top" : "child",
    contentRuntimeVersion: ext.runtime.getManifest()?.version || "unknown",
    compatibilityEnabled: Boolean(settings.clipboardEditorSupport),
    clipboardApiAvailable: typeof navigator.clipboard?.readText === "function",
    liveDomSelectionAvailable: Boolean(selection && !selection.isCollapsed && selection.rangeCount),
    liveDomSelectionLength: selection && !selection.isCollapsed ? selection.toString().length : 0,
    configuredBackend: settings.speechBackend,
    shortcuts: {
      cantonese: settings.readAloudCantoneseShortcut,
      mandarin: settings.readAloudMandarinShortcut,
      english: settings.readAloudEnglishShortcut
    },
    background,
    backgroundError: backgroundError || undefined,
    privacy: "Clipboard contents and Azure keys are not read or printed by this diagnostic snapshot."
  };
  console.info("[Combined Annotator][Google/Office compatibility] diagnostic-snapshot", report);
  return report;
}

function selectionRangeDiagnostic(selection) {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  try {
    const range = selection.getRangeAt(selection.rangeCount - 1);
    const rect = range.getBoundingClientRect?.();
    return {
      root: range.commonAncestorContainer?.getRootNode?.() === document ? "document" : "other",
      rect: rect ? {
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      } : null
    };
  } catch (error) {
    return { error: String(error?.message || error).slice(0, 200) };
  }
}

function runSelectionLogoFrameDiagnostics(reason = "manual-console-request") {
  const selection = window.getSelection();
  const overlay = globalThis.CombinedAnnotatorUI?.getSelectionToolsDiagnostics?.() || {
    apiAvailable: Boolean(globalThis.CombinedAnnotatorUI),
    diagnosticMethodAvailable: false
  };
  const report = {
    reason,
    diagnosticsRevision: SELECTION_LOGO_DIAGNOSTICS_REVISION,
    editor: isCanvasEditorHost() ? canvasEditorLabel() : "unsupported host",
    frame: window === window.top ? "top" : "child",
    runtimeVersion: ext.runtime.getManifest()?.version || "unknown",
    documentReadyState: document.readyState,
    viewport: { width: innerWidth, height: innerHeight },
    documentVisible: document.visibilityState,
    compatibilityEnabled: Boolean(settings.clipboardEditorSupport),
    siteDisabled,
    uiAvailable: Boolean(globalThis.CombinedAnnotatorUI?.showSelectionTools),
    selection: {
      collapsed: selection?.isCollapsed !== false,
      rangeCount: selection?.rangeCount || 0,
      textLength: selection && !selection.isCollapsed ? selection.toString().length : 0,
      detail: selectionRangeDiagnostic(selection)
    },
    pointer: {
      observed: Boolean(lastPointerSelectionAt),
      ageMs: lastPointerSelectionAt ? Math.max(0, Date.now() - lastPointerSelectionAt) : null,
      x: Math.round(lastPointerSelectionX),
      y: Math.round(lastPointerSelectionY)
    },
    copySignal: {
      source: lastEditorCopySignal.source,
      observed: Boolean(lastEditorCopySignal.observedAt),
      ageMs: lastEditorCopySignal.observedAt ? Math.max(0, Date.now() - lastEditorCopySignal.observedAt) : null
    },
    actionState: {
      usesClipboard: selectionActionUsesClipboard,
      hasTrackedText: Boolean(selectionActionText),
      dismissedForScroll: selectionToolsDismissedForScroll
    },
    overlay
  };
  console.info("[Combined Annotator][Google/Office compatibility] selection-logo-frame-snapshot", report);
  return report;
}

function requestSelectionLogoDiagnosticReport(reason = "manual-console-request") {
  return sendMessage({ type: "get-editor-selection-logo-diagnostics" }, 0)
    .then((report) => {
      console.info("[Combined Annotator][Google/Office compatibility] selection-logo-diagnostic-report", {
        diagnosticsRevision: SELECTION_LOGO_DIAGNOSTICS_REVISION,
        reason,
        ...report
      });
      return report;
    })
    .catch((error) => {
      editorCompatibilityDiagnostic("selection-logo-diagnostic-failed", {
        diagnosticsRevision: SELECTION_LOGO_DIAGNOSTICS_REVISION,
        error: String(error?.message || error).slice(0, 300)
      });
      throw error;
    });
}

function logSelectionLogoEvaluation(source, selection = window.getSelection()) {
  if (!isCanvasEditorHost()) return;
  const detail = {
    source,
    collapsed: selection?.isCollapsed !== false,
    rangeCount: selection?.rangeCount || 0,
    selectedLength: selection && !selection.isCollapsed ? selection.toString().length : 0,
    uiAvailable: Boolean(globalThis.CombinedAnnotatorUI?.showSelectionTools),
    compatibilityEnabled: Boolean(settings.clipboardEditorSupport),
    siteDisabled
  };
  const key = JSON.stringify(detail);
  const now = Date.now();
  if (key === lastSelectionLogoEvaluation.key && now - lastSelectionLogoEvaluation.observedAt < 2000) return;
  lastSelectionLogoEvaluation = { key, observedAt: now };
  editorCompatibilityDiagnostic("selection-logo-evaluation", detail);
}

function selectedActionText(text = "") {
  const provided = String(text || "").replace(/\s+/g, " ").trim().slice(0, 25000);
  if (provided) {
    editorCompatibilityDiagnostic("text-resolved", { source: "browser-context-selection", textLength: provided.length });
    return provided;
  }
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) {
    editorCompatibilityDiagnostic("dom-selection-unavailable", { collapsed: Boolean(selection?.isCollapsed), rangeCount: selection?.rangeCount || 0 });
    return "";
  }
  const selected = String(extractOriginalSelection(selection) || selection.toString() || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 25000);
  editorCompatibilityDiagnostic("text-resolved", { source: "live-dom-selection", textLength: selected.length });
  return selected;
}

async function readCopiedEditorText({ allowUnconfirmedChinese = true, allowUnconfirmedNonChinese = false } = {}) {
  const editor = canvasEditorLabel();
  editorCompatibilityDiagnostic("clipboard-read-requested", {
    compatibilityEnabled: Boolean(settings.clipboardEditorSupport),
    clipboardApiAvailable: typeof navigator.clipboard?.readText === "function"
  });
  if (!settings.clipboardEditorSupport) {
    editorCompatibilityDiagnostic("clipboard-read-blocked", { reason: "compatibility-disabled" });
    showSpeechNotice(`${editor} hides its selection from Firefox. Open the extension's Speech settings, enable Google/Office copied-text compatibility, select text, press Ctrl+C, then try again.`);
    return "";
  }
  if (typeof navigator.clipboard?.readText !== "function") {
    editorCompatibilityDiagnostic("clipboard-read-blocked", { reason: "clipboard-api-unavailable" });
    showSpeechNotice(`Clipboard reading is unavailable here. Select text in ${editor}, press Ctrl+C, and check the compatibility permission in the extension's Speech settings.`);
    return "";
  }
  let copyState = null;
  try {
    copyState = await sendMessage({ type: "get-editor-copy-state" }, 0);
  } catch (error) {
    editorCompatibilityDiagnostic("copy-freshness-check-failed", { error: String(error?.message || error).slice(0, 300) });
  }
  const copyAgeMs = copyState?.observedAt ? Number(copyState.ageMs) : Number.NaN;
  const copyConfirmed = Boolean(copyState?.observedAt)
    && Number.isFinite(copyAgeMs)
    && copyAgeMs <= EDITOR_COPY_FRESHNESS_MS;
  if (!copyConfirmed && !allowUnconfirmedChinese) {
    editorCompatibilityDiagnostic("clipboard-read-blocked", {
      reason: "no-recent-editor-copy",
      copyAgeMs: Number.isFinite(copyAgeMs) ? copyAgeMs : null
    });
    showSpeechNotice(`Selecting text in ${editor} is not enough. Click the document, select the text, press Ctrl+C, then immediately use the read-aloud shortcut or Shift+right-click command.`);
    return "";
  }
  if (copyConfirmed) {
    editorCompatibilityDiagnostic("copy-freshness-confirmed", {
      copyAgeMs,
      copyFrameId: Number.isInteger(copyState.frameId) ? copyState.frameId : 0,
      copySource: copyState.source || "copy-event"
    });
  } else {
    // Google editors occasionally consume the copy event before an isolated
    // extension listener sees it. Continue with a Chinese-only fallback: this
    // permits the copied hanzi while still rejecting stale console commands or
    // other non-Chinese clipboard contents.
    editorCompatibilityDiagnostic("copy-freshness-unconfirmed", {
      copyAgeMs: Number.isFinite(copyAgeMs) ? copyAgeMs : null,
      fallback: allowUnconfirmedNonChinese ? "explicit-english-action" : "chinese-only"
    });
  }
  try {
    const copied = String(await navigator.clipboard.readText()).replace(/\s+/g, " ").trim().slice(0, 25000);
    if (!copied) {
      editorCompatibilityDiagnostic("clipboard-read-empty", { textLength: 0 });
      showSpeechNotice(`Nothing is copied. Select text in ${editor}, press Ctrl+C, then try the command again.`);
    } else if (!copyConfirmed && !CHINESE_RE.test(copied) && !allowUnconfirmedNonChinese) {
      editorCompatibilityDiagnostic("clipboard-read-blocked", {
        reason: "unconfirmed-copy-has-no-chinese",
        textLength: copied.length
      });
      showSpeechNotice(`The extension could not confirm the recent Ctrl+C, and the clipboard contains no Chinese text. Select the Chinese text again, press Ctrl+C, then immediately retry.`);
      return "";
    } else {
      editorCompatibilityDiagnostic("clipboard-read-succeeded", {
        textLength: copied.length,
        containsChinese: CHINESE_RE.test(copied),
        copyConfirmed
      });
    }
    return copied;
  } catch (error) {
    console.warn("Combined Annotator: copied-text compatibility could not read the clipboard", error);
    editorCompatibilityDiagnostic("clipboard-read-failed", { error: String(error?.message || error).slice(0, 300) });
    showSpeechNotice(`Firefox blocked clipboard access. Re-enable Google/Office copied-text compatibility in the extension's Speech settings, then select text and press Ctrl+C.`);
    return "";
  }
}

async function resolveActionText(text = "", clipboardOptions = {}) {
  const selected = selectedActionText(text);
  if (selected) return selected;
  if (isCanvasEditorHost()) return readCopiedEditorText(clipboardOptions);
  return "";
}

async function resolveEnglishSpeechText(text = "") {
  const source = String(text || "").replace(/\s+/g, " ").trim();
  if (!source || !CHINESE_RE.test(source)) return source;

  editorCompatibilityDiagnostic("english-gloss-requested", {
    textLength: source.length,
    chineseCharacterCount: extractChineseCharacters(source).length
  });

  try {
    const response = await sendMessage({
      type: "annotate-text",
      text: source,
      settings: { ...settings, showEnglish: true, showJyutping: true, showPinyin: true }
    });
    const fragment = buildAnnotationFragment(source, response);
    const values = Array.from(fragment.querySelectorAll(".ca-english"))
      .map((line) => String(line.dataset.caSpeakValue || line.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const english = values.join("; ");

    editorCompatibilityDiagnostic("english-gloss-resolved", {
      definitionCount: values.length,
      textLength: english.length,
      containsChinese: CHINESE_RE.test(english)
    });
    return english;
  } catch (error) {
    console.warn("Combined Annotator: could not resolve English definitions for speech", error);
    editorCompatibilityDiagnostic("english-gloss-failed", {
      error: String(error?.message || error).slice(0, 300)
    });
    return "";
  }
}

function stopAzureSpeech(notify = true) {
  const current = activeAzureSpeech;
  if (!current) return;
  activeAzureSpeech = null;
  current.audio.pause();
  current.audio.onplay = null;
  current.audio.onended = null;
  current.audio.onerror = null;
  current.audio.removeAttribute("src");
  URL.revokeObjectURL(current.url);
  if (notify) notifySpeechDiagnostic({ id: current.id, state: "canceled", lang: current.lang, backend: "azure" });
}

function pauseActiveSpeech() {
  window.speechSynthesis?.pause();
  if (activeAzureSpeech) {
    activeAzureSpeech.audio.pause();
    notifySpeechDiagnostic({ id: activeAzureSpeech.id, state: "paused", lang: activeAzureSpeech.lang, backend: "azure" });
  }
}

function resumeActiveSpeech() {
  window.speechSynthesis?.resume();
  if (activeAzureSpeech) {
    const current = activeAzureSpeech;
    notifySpeechDiagnostic({ id: current.id, state: "resume-requested", lang: current.lang, backend: "azure" });
    current.audio.play().catch((error) => {
      const message = `Could not resume Azure speech: ${error?.message || String(error)}`;
      notifySpeechDiagnostic({ id: current.id, state: "error", stage: "resume", lang: current.lang, backend: "azure", error: message });
      showSpeechNotice(message);
    });
  }
}

function stopActiveSpeech() {
  speechStartSequence++;
  window.speechSynthesis?.cancel();
  stopAzureSpeech();
}

function decodeBase64Audio(value) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function speakFromAzure(payload, startSequence) {
  stopAzureSpeech();
  window.speechSynthesis?.cancel();
  try {
    const speechText = Core.classifyLanguage("", payload.lang) === "zh"
      ? Core.normalizeChineseSpeechText(payload.text)
      : String(payload.text || "").trim();
    if (!speechText) {
      notifySpeechDiagnostic({ id: payload.id, state: "error", stage: "validation", lang: payload.lang, backend: "azure", error: "There is no text to speak." });
      payload.onError?.("There is no text to speak.");
      return;
    }
    notifySpeechDiagnostic({
      id: payload.id, state: "loading", stage: "request", lang: payload.lang,
      backend: "azure", textLength: speechText.length, rate: payload.rate, pitch: payload.pitch
    });
    const response = await sendMessage({
      type: "synthesize-azure-speech",
      requestId: payload.id,
      text: speechText,
      lang: payload.lang,
      rate: payload.rate,
      pitch: payload.pitch
    }, 0);
    if (startSequence !== speechStartSequence) {
      notifySpeechDiagnostic({ id: payload.id, state: "canceled", stage: "response-discarded", lang: payload.lang, backend: "azure" });
      return;
    }

    notifySpeechDiagnostic({
      id: payload.id, state: "audio-ready", stage: "decode", lang: response.lang || payload.lang,
      backend: "azure", selectedVoice: response.voice, durationMs: response.durationMs,
      audioBytes: response.audioBytes, mimeType: response.mimeType
    });

    const blob = new Blob([decodeBase64Audio(response.audioBase64)], { type: response.mimeType || "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    const current = { audio, url, id: payload.id, lang: response.lang || payload.lang };
    activeAzureSpeech = current;
    const cleanup = () => {
      if (activeAzureSpeech === current) activeAzureSpeech = null;
      URL.revokeObjectURL(url);
    };
    audio.onplay = () => {
      payload.onStart?.();
      notifySpeechDiagnostic({ id: payload.id, state: "start", stage: "playback", lang: current.lang, backend: "azure", selectedVoice: response.voice, audioBytes: response.audioBytes });
    };
    audio.onended = () => {
      payload.onEnd?.();
      notifySpeechDiagnostic({ id: payload.id, state: "end", stage: "playback", lang: current.lang, backend: "azure", selectedVoice: response.voice });
      cleanup();
    };
    audio.onerror = () => {
      const error = "Firefox could not play the audio returned by Azure Speech.";
      notifySpeechDiagnostic({ id: payload.id, state: "error", stage: "playback", lang: current.lang, backend: "azure", error });
      showSpeechNotice(error);
      payload.onError?.(error);
      cleanup();
    };
    await audio.play();
  } catch (error) {
    if (startSequence !== speechStartSequence) return;
    if (activeAzureSpeech?.id === payload.id) stopAzureSpeech(false);
    const message = error?.message || String(error);
    notifySpeechDiagnostic({ id: payload.id, state: "error", stage: "request-or-playback", lang: payload.lang, backend: "azure", error: message });
    showSpeechNotice(message);
    payload.onError?.(message);
  }
}

async function speakFromContentScript(payload) {
  const startSequence = ++speechStartSequence;
  if ((payload.backend || settings.speechBackend) === "azure") {
    return speakFromAzure(payload, startSequence);
  }

  if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
    const error = "Web Speech API is not available in the content script.";
    console.warn(`Combined Annotator: ${error}`);
    notifySpeechDiagnostic({ id: payload.id, state: "error", stage: "availability", backend: "browser", error });
    payload.onError?.(error);
    return;
  }

  const synth = window.speechSynthesis;
  stopAzureSpeech();

  try {
    const voices = await waitForSpeechVoices(synth);
    if (startSequence !== speechStartSequence) return;

    const isChineseSpeech = Core.classifyLanguage("", payload.lang) === "zh";
    const speechText = isChineseSpeech
      ? Core.normalizeChineseSpeechText(payload.text)
      : String(payload.text || "");
    if (!speechText.trim()) return;

    const utterance = new SpeechSynthesisUtterance(speechText);
    utterance.lang = payload.lang;
    const requestedRate = Number(payload.rate) || settings.speechRate || 0.9;
    utterance.rate = Core.speechRateForLanguage(requestedRate, payload.lang);
    utterance.pitch = Number(payload.pitch) || settings.speechPitch || 1;

    const voice = selectSpeechVoice(voices, payload.lang, payload.voiceName);

    if (isCantoneseLanguage(payload.lang) && !voice) {
      const error = "No Cantonese voice is installed. Add Chinese (Traditional, Hong Kong SAR) speech voices in Windows, restart Firefox, then reload this page.";
      console.warn(`Combined Annotator: ${error}`);
      showSpeechNotice(error);
      notifySpeechDiagnostic({ id: payload.id, state: "error", stage: "voice-selection", lang: payload.lang, backend: "browser", error });
      payload.onError?.(error);
      return;
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

    utterance.onstart = () => {
      payload.onStart?.();
      notifySpeechDiagnostic({ id: payload.id, state: "start", stage: "playback", lang: payload.lang, backend: "browser", selectedVoice: voice?.name, selectedVoiceLang: voice?.lang });
    };
    utterance.onboundary = (event) => payload.onBoundary?.({ charIndex: event.charIndex, charLength: event.charLength, name: event.name });
    utterance.onend = () => {
      payload.onEnd?.();
      notifySpeechDiagnostic({ id: payload.id, state: "end", stage: "playback", lang: payload.lang, backend: "browser", selectedVoice: voice?.name });
      cleanup();
    };
    utterance.oncancel = () => {
      notifySpeechDiagnostic({ id: payload.id, state: "canceled", stage: "playback", lang: payload.lang, backend: "browser", selectedVoice: voice?.name });
      cleanup();
    };
    utterance.onerror = (event) => {
      const error = event.error || "Unknown speech error";
      notifySpeechDiagnostic({ id: payload.id, state: "error", stage: "playback", lang: payload.lang, backend: "browser", selectedVoice: voice?.name, error });
      payload.onError?.(error);
      cleanup();
    };

    // Fallback: Firefox occasionally completely drops the onend event for short texts.
    // We estimate duration based on text length and rate, and forcefully clear it.
    const estimatedDurationMs = Math.max(1000, speechText.length * 300 * (1 / utterance.rate));
    window.setTimeout(() => {
      if (window._activeUtterances.has(utterance)) {
        notifySpeechDiagnostic({ id: payload.id, state: "end", stage: "fallback-timer", lang: payload.lang, backend: "browser", selectedVoice: voice?.name, fallback: true });
        cleanup();
      }
    }, estimatedDurationMs + 800);

    const shouldResetQueue = Boolean(synth.speaking || synth.pending || synth.paused);
    if (shouldResetQueue) {
      if (synth.paused) synth.resume();
      synth.cancel();
      await waitForSpeechQueueReset();
      if (startSequence !== speechStartSequence) {
        cleanup();
        return;
      }
    }

    // Diagnostic logging: confirm the exact utterance handed to the engine so
    // voice/rate/pitch regressions can be verified against the runtime voices.
    console.log("[Combined Annotator] speak-request", JSON.stringify({
      textLength: speechText.length,
      requestedLang: payload.lang,
      requestedVoice: payload.voiceName || "(automatic)",
      selectedVoice: voice ? voice.name : null,
      selectedVoiceLang: voice ? voice.lang : null,
      requestedRate,
      rate: utterance.rate,
      pitch: utterance.pitch,
      utteranceSequence: speechStartSequence,
      voiceCount: voices.length,
      voices: voices.map((v) => ({ name: v.name, lang: v.lang, default: v.default, localService: v.localService }))
    }));

    notifySpeechDiagnostic({
      id: payload.id, state: "queued", stage: "request", lang: payload.lang, backend: "browser",
      selectedVoice: voice?.name, selectedVoiceLang: voice?.lang, textLength: speechText.length,
      rate: utterance.rate, pitch: utterance.pitch, voiceCount: voices.length
    });
    synth.speak(utterance);
  } catch (error) {
    notifySpeechDiagnostic({ id: payload.id, state: "error", stage: "request", lang: payload.lang, backend: "browser", error: error?.message || String(error) });
  }
}

function isTerminalSpeechState(state) {
  return state === "end" || state === "error" || state === "warning" || state === "canceled";
}

function notifySpeechDiagnostic(detail) {
  lastSpeechDiagnostic = detail || {};

  editorCompatibilityDiagnostic("speech-state", {
    requestId: String(lastSpeechDiagnostic.id || "").slice(0, 160),
    state: lastSpeechDiagnostic.state || "unknown",
    stage: lastSpeechDiagnostic.stage || "",
    backend: lastSpeechDiagnostic.backend || settings.speechBackend,
    language: lastSpeechDiagnostic.lang || "",
    selectedVoice: lastSpeechDiagnostic.selectedVoice || "",
    textLength: Number(lastSpeechDiagnostic.textLength) || 0,
    error: lastSpeechDiagnostic.error ? String(lastSpeechDiagnostic.error).slice(0, 300) : ""
  });

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

  // Voices may load asynchronously (especially in Chrome).
  const voices = available ? await waitForSpeechVoices(window.speechSynthesis) : [];

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

function pauseAnnotationPipeline() {
  pageVersion++;
  annotationQueue = [];
  scanQueue = [];
  queuedTextNodes = new WeakSet();
  observedElements = new WeakSet();
  pendingVisibleSweeps = new WeakSet();
  viewportObserver.disconnect();
  publishAnnotationDiagnostics();
  observerPaused = true;

  // Clear the annotation cache when annotations are removed — stale cached
  // fragments for text that no longer exists in the DOM just waste memory.
  annotationCache.clear();
}

function clearAnnotations(root = document.body, options = {}) {
  pauseAnnotationPipeline();

  let restoredPageOriginalCount = 0;
  const nodes = root.querySelectorAll("[data-ca-annotation='true']");
  nodes.forEach((node) => {
    if (options.restorePageOriginal && node.dataset.caPageOriginal && node.dataset.caPageOriginal !== node.dataset.caOriginal) {
      restoredPageOriginalCount++;
    }
    const restored = options.restorePageOriginal
      ? node.dataset.caPageOriginal || node.dataset.caOriginal || node.textContent || ""
      : node.dataset.caOriginal || node.textContent || "";
    node.replaceWith(document.createTextNode(restored));
  });
  root.normalize();

  window.setTimeout(() => {
    if (options.resumeObserver !== false) observerPaused = false;
    if (options.reannotate !== false && anyEnabled()) enqueueScan(document.body);
  }, 0);
  return restoredPageOriginalCount;
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
    // Collect unique added subtrees and deduplicate to avoid full-document scans.
    const roots = new Set();
    for (const mutation of mutations) {
      if (mutation.type === "characterData") {
        enqueueScan(mutation.target.parentElement);
      }
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          roots.add(node);
        } else if (node.nodeType === Node.TEXT_NODE && node.parentElement) {
          roots.add(node.parentElement);
        }
      }
    }
    // Remove any root that is a descendant of another root in the set.
    const filtered = [];
    for (const root of roots) {
      let ancestor = root.parentElement;
      let isDescendant = false;
      while (ancestor) {
        if (roots.has(ancestor)) { isDescendant = true; break; }
        ancestor = ancestor.parentElement;
      }
      if (!isDescendant) filtered.push(root);
    }
    for (const root of filtered) {
      enqueueScan(root);
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
  document.body.style.setProperty("--ca-annotation-scale", String(settings.annotationScale / 100));
  document.body.dataset.caSpacing = settings.annotationSpacing;
  document.body.dataset.caPrimaryLayer = settings.primaryLayer;
  document.body.classList.toggle("ca-pronunciation-mode", settings.layoutMode === "pronunciation");
  document.querySelectorAll(".ca-run").forEach((run) => registerRunLayout(run));
  globalThis.CombinedAnnotatorUI?.updateSettings?.(settings);
}

async function refreshFromSettings(nextSettings) {
  const oldSettings = settings;
  const loaded = nextSettings || (await sendMessage({ type: "get-settings", hostname: window.location.hostname }));
  settings = Core.normalizeSettings(loaded?.settings || loaded);
  if (loaded && typeof loaded.enabled === "boolean") siteDisabled = !loaded.enabled;
  applyToneColors(settings);
  applyInjectedTheme();
  refreshPageLanguageHint();

  if (!oldSettings) {
    reannotateVisiblePage();
    return;
  }

  const hoverChanged = Boolean(settings.hoverOnly) !== Boolean(oldSettings.hoverOnly);

  if (settings.hoverOnly) {
    if (hoverChanged) {
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
    if (message?.type === "runtime-ready") {
      return { ok: true, ready: true, version: ext.runtime.getManifest()?.version || "unknown" };
    }
    if (message?.type === "run-selection-logo-diagnostics") {
      return runSelectionLogoFrameDiagnostics(message.reason || "background-cross-frame-request");
    }
    if (message?.type === "settings-updated") {
      await refreshFromSettings(message.settings);
      editorCompatibilityDiagnostic("settings-updated", {
        compatibilityEnabled: Boolean(settings.clipboardEditorSupport),
        backend: settings.speechBackend
      });
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
      editorCompatibilityDiagnostic("context-menu-action-received", {
        action: message.action || "unknown",
        browserSelectionLength: String(message.selectionText || "").length
      });
      await handleContextMenuAction(message.action, message.selectionText);
      return { ok: true };
    }
    if (message?.type === "site-disabled-changed") {
      siteDisabled = Boolean(message.disabled);
      if (siteDisabled) {
        clearAnnotations(document.body, { restorePageOriginal: false });
      } else {
        const effective = await sendMessage({ type: "get-settings", hostname: location.hostname });
        settings = Core.normalizeSettings(effective?.settings || effective);
        siteDisabled = effective?.enabled === false;
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
    if (message?.type === "open-reader") {
      globalThis.CombinedAnnotatorUI?.openReader?.(message.text || extractReaderSelection());
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
    if (message?.type === "run-content-diagnostics") {
      return runContentDiagnostics();
    }
    if (message?.type === "speech-test") {
      if (message.settings) settings = Core.normalizeSettings(message.settings);
      return { ok: true, detail: await runSpeechTest(message.label || "English") };
    }
    if (message?.type === "speak-text") {
      const text = String(message.text || "").trim();
      if (!text) return { ok: false };
      speakFromContentScript({
        id: `popup-${Date.now()}-${++speechRequestCounter}`,
        text,
        lang: message.lang || "zh-CN",
        rate: settings.speechRate,
        pitch: settings.speechPitch,
        backend: settings.speechBackend
      });
      return { ok: true };
    }
    if (message?.type === "custom-dictionary-changed") {
      annotationCache.clear();
      reannotateVisiblePage();
      return { ok: true };
    }
    if (message?.type === "get-health") {
      publishAnnotationDiagnostics();
      return { ok: true, health: document.documentElement.dataset.caHealth || "ready" };
    }
    if (message?.type === "pause-annotations") {
      pauseMode = "page";
      return { ok: true };
    }
    if (message?.type === "pause-annotations-timer") {
      pauseMode = "timer";
      pausedUntil = Date.now() + 10 * 60 * 1000;
      return { ok: true };
    }
    if (message?.type === "pause-annotations-selection") {
      pauseMode = "selection";
      return { ok: true };
    }
    if (message?.type === "resume-annotations") {
      pauseMode = null;
      pausedUntil = 0;
      annotationStopped = false;
      reannotateVisiblePage();
      return { ok: true };
    }
    if (message?.type === "stop-annotations") {
      clearAnnotations();
      annotationStopped = true;
      return { ok: true };
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

function handleEditorCopyObservation(event) {
  if (observedEditorCopyEvents.has(event)) return;
  observedEditorCopyEvents.add(event);
  editorCompatibilityDiagnostic("copy-event-observed", {
    defaultPreventedBeforeHandler: Boolean(event.defaultPrevented),
    clipboardDataAvailable: Boolean(event.clipboardData)
  });
  recordEditorCopySignal("copy-event");
  showEditorCopiedSelectionTools("copy-event");
}

function recordEditorCopySignal(source) {
  if (!isCanvasEditorHost()) return;
  const observedAt = Date.now();
  lastEditorCopySignal = { source, observedAt };
  sendMessage({ type: "editor-copy-observed", observedAt, source }, 0)
    .then((result) => editorCompatibilityDiagnostic("copy-event-recorded", {
      recorded: Boolean(result?.recorded),
      observedAt,
      source
    }))
    .catch((error) => editorCompatibilityDiagnostic("copy-event-record-failed", {
      source,
      error: String(error?.message || error).slice(0, 300)
    }));
}

function handleEditorCopyShortcutObservation(event) {
  if (!isCanvasEditorHost() || event.repeat || event.isComposing || observedEditorCopyEvents.has(event)) return;
  const key = String(event.key || "").toLowerCase();
  const isCopyShortcut = !event.altKey && !event.shiftKey
    && (((event.ctrlKey || event.metaKey) && key === "c") || (event.ctrlKey && key === "insert"));
  if (!isCopyShortcut) return;
  observedEditorCopyEvents.add(event);
  editorCompatibilityDiagnostic("copy-shortcut-observed", {
    key: key === "insert" ? "Ctrl+Insert" : (event.metaKey ? "Meta+C" : "Ctrl+C"),
    defaultPreventedBeforeHandler: Boolean(event.defaultPrevented)
  });
  recordEditorCopySignal("keyboard-shortcut");
  showEditorCopiedSelectionTools("keyboard-shortcut");
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
  const wasDismissedForScroll = selectionToolsDismissedForScroll;
  selectionToolsDismissedForScroll = false;
  scheduleSelectionToolsUpdate();
  document.querySelectorAll(".ca-visually-selected").forEach(el => el.classList.remove("ca-visually-selected"));
  
  const selection = window.getSelection();
  logSelectionLogoEvaluation("selectionchange", selection);
  selectionToolsDiagnostic("selectionchange", {
    wasDismissedForScroll,
    collapsed: selection?.isCollapsed !== false,
    rangeCount: selection?.rangeCount || 0,
    selectedLength: selection?.isCollapsed ? 0 : selection?.toString?.().length || 0
  });
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

function rememberEditorSelectionPointer(event) {
  if (!isCanvasEditorHost() || event.composedPath?.().some((node) => node?.id === "combined-annotator-overlay-host")) return;
  lastPointerSelectionAt = Date.now();
  lastPointerSelectionX = Number(event.clientX) || 0;
  lastPointerSelectionY = Number(event.clientY) || 0;
}

function editorSelectionToolsRect(range = null) {
  const rects = range ? Array.from(range.getClientRects?.() || []).filter((rect) => rect.width > 0 || rect.height > 0) : [];
  const rangeRect = rects.at(-1) || range?.getBoundingClientRect?.();
  if (rangeRect && (rangeRect.width > 0 || rangeRect.height > 0)
      && rangeRect.bottom >= 0 && rangeRect.top <= innerHeight
      && rangeRect.right >= 0 && rangeRect.left <= innerWidth) {
    return {
      left: rangeRect.left,
      right: rangeRect.right,
      top: rangeRect.top,
      bottom: rangeRect.bottom
    };
  }

  const pointerIsRecent = Date.now() - lastPointerSelectionAt < 30000;
  const x = pointerIsRecent ? lastPointerSelectionX : Math.round(innerWidth / 2);
  const y = pointerIsRecent ? lastPointerSelectionY : Math.round(innerHeight / 2);
  const clampedX = Math.max(12, Math.min(innerWidth - 32, x));
  const clampedY = Math.max(12, Math.min(innerHeight - 32, y));
  return { left: clampedX, right: clampedX, top: clampedY, bottom: clampedY };
}

function showEditorCopiedSelectionTools(reason = "canvas-selection") {
  if (!isCanvasEditorHost()) return;
  if (siteDisabled || !settings.clipboardEditorSupport) {
    editorCompatibilityDiagnostic("selection-logo-skipped", {
      reason: siteDisabled ? "site-disabled" : "compatibility-disabled"
    });
    return;
  }
  if (!globalThis.CombinedAnnotatorUI?.showSelectionTools) {
    editorCompatibilityDiagnostic("selection-logo-skipped", { reason: "overlay-api-unavailable" });
    return;
  }
  const selection = window.getSelection();
  const range = selection && !selection.isCollapsed && selection.rangeCount
    ? selection.getRangeAt(selection.rangeCount - 1)
    : null;
  selectionToolsDismissedForScroll = false;
  selectionActionRange = null;
  selectionActionText = "";
  selectionActionUsesClipboard = true;
  const anchor = editorSelectionToolsRect(range);
  globalThis.CombinedAnnotatorUI.showSelectionTools({
    text: "",
    clipboardMode: true,
    rect: anchor
  });
  const overlay = globalThis.CombinedAnnotatorUI.getSelectionToolsDiagnostics?.() || null;
  editorCompatibilityDiagnostic("selection-logo-show-result", {
    reason,
    selectionCollapsed: selection?.isCollapsed !== false,
    selectionRangeCount: selection?.rangeCount || 0,
    anchor: {
      left: Math.round(anchor.left),
      right: Math.round(anchor.right),
      top: Math.round(anchor.top),
      bottom: Math.round(anchor.bottom)
    },
    overlayCreated: Boolean(overlay?.created),
    overlayHidden: overlay?.hidden ?? null,
    overlayConnected: overlay?.connected ?? null,
    renderedWidth: overlay?.rect?.width ?? null,
    renderedHeight: overlay?.rect?.height ?? null
  });
}

function hideSelectionToolsForPage() {
  window.clearTimeout(selectionToolsTimer);
  selectionToolsTimer = 0;
  selectionActionRange = null;
  selectionActionText = "";
  selectionActionUsesClipboard = false;
  globalThis.CombinedAnnotatorUI?.hideSelectionTools?.();
}

function refreshSelectionTools() {
  selectionToolsTimer = 0;
  if (isCanvasEditorHost()) logSelectionLogoEvaluation("refresh", window.getSelection());
  if (selectionToolsDismissedForScroll) {
    hideSelectionToolsForPage();
    return;
  }
  const selection = window.getSelection();
  if (siteDisabled || !selection || selection.isCollapsed || !selection.rangeCount) {
    hideSelectionToolsForPage();
    return;
  }

  const range = selection.getRangeAt(selection.rangeCount - 1);
  const root = range.commonAncestorContainer?.getRootNode?.();
  if (typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot && root.host?.id === "combined-annotator-overlay-host") {
    hideSelectionToolsForPage();
    return;
  }

  if (isCanvasEditorHost()) {
    showEditorCopiedSelectionTools("canvas-selection");
    return;
  }

  const text = (extractOriginalSelection(selection) || selection.toString()).replace(/\s+/g, " ").trim().slice(0, 25000);
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
  const rect = rects.at(-1) || range.getBoundingClientRect();
  if (!text || (!rect.width && !rect.height)) {
    hideSelectionToolsForPage();
    return;
  }

  selectionActionRange = range.cloneRange();
  selectionActionText = text;
  selectionActionUsesClipboard = false;
  globalThis.CombinedAnnotatorUI?.showSelectionTools?.({
    text,
    rect: {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom
    }
  });
}

function scheduleSelectionToolsUpdate() {
  window.clearTimeout(selectionToolsTimer);
  selectionToolsTimer = window.setTimeout(refreshSelectionTools, 90);
}

function selectionToolsDiagnosticsEnabled() {
  return document.documentElement.dataset.caSelectionDiagnostics === "1";
}

function selectionToolsDiagnostic(event, details = {}) {
  if (!selectionToolsDiagnosticsEnabled()) return;
  console.info("[Combined Annotator][Selection tools]", event, {
    ...details,
    trackedSelection: Boolean(selectionActionText || selectionActionUsesClipboard),
    dismissedForScroll: selectionToolsDismissedForScroll
  });
}

function selectionScrollTargetName(target) {
  if (target === document) return "document";
  if (target === window) return "window";
  if (target instanceof Element) {
    const role = target.getAttribute("role");
    return `${target.tagName.toLowerCase()}${role ? `[role=${role}]` : ""}`;
  }
  return target?.constructor?.name || typeof target;
}

function diagnoseCapturedSelectionScroll(event) {
  if (!selectionToolsDiagnosticsEnabled()) return;
  const selection = window.getSelection();
  if ((!selection || selection.isCollapsed) && !selectionActionText && !selectionActionUsesClipboard) return;
  const now = performance.now();
  if (now - selectionScrollDiagnosticAt < 250) return;
  selectionScrollDiagnosticAt = now;
  selectionToolsDiagnostic("captured-scroll", {
    target: selectionScrollTargetName(event.target),
    reachesWindowDismissHandler: event.target === document,
    selectedLength: selection?.isCollapsed ? 0 : selection?.toString?.().length || 0
  });
}

function handleCapturedSelectionScroll(event) {
  diagnoseCapturedSelectionScroll(event);
  const selection = window.getSelection();
  if ((!selection || selection.isCollapsed) && !selectionActionText && !selectionActionUsesClipboard) return;
  dismissSelectionToolsForScroll(event);
}

function dismissSelectionToolsForScroll(event) {
  if (selectionToolsDismissedForScroll) return;
  selectionToolsDiagnostic("scroll-dismiss", {
    target: selectionScrollTargetName(event?.target)
  });
  selectionToolsDismissedForScroll = true;
  hideSelectionToolsForPage();
}

function isPeekEvent(event) {
  if (event.target?.closest?.("input, textarea, select, [contenteditable='true']")) return false;
  if (settings.peekKey === "Backslash") return event.code === "Backslash";
  return event.key === settings.peekKey;
}

function isEditableShortcutTarget(event) {
  if (event.target?.closest?.("input, textarea, select, [contenteditable='true'], [contenteditable='']")) return true;
  return event.composedPath?.().some((node) => node?.id === "combined-annotator-overlay-host") || false;
}

function handleReadAloudShortcut(event) {
  if (event.repeat || event.isComposing || siteDisabled) return;
  if (event.defaultPrevented && !isCanvasEditorHost()) return;
  if (isEditableShortcutTarget(event) && !isCanvasEditorHost()) return;
  const shortcuts = [
    [settings.readAloudCantoneseShortcut, "read-aloud-jyutping"],
    [settings.readAloudMandarinShortcut, "read-aloud-pinyin"],
    [settings.readAloudEnglishShortcut, "read-aloud-english"]
  ];
  const match = shortcuts.find(([shortcut]) => Core.matchesShortcut(event, shortcut));
  if (!match) return;

  const selection = window.getSelection();
  const hasLiveSelection = Boolean(selection && !selection.isCollapsed && selection.rangeCount);
  editorCompatibilityDiagnostic("shortcut-matched", {
    action: match[1],
    shortcut: match[0],
    defaultPreventedBeforeHandler: Boolean(event.defaultPrevented),
    editableTarget: isEditableShortcutTarget(event),
    hasLiveSelection
  });
  if (!hasLiveSelection && !isCanvasEditorHost()) return;
  const selectedText = hasLiveSelection
    ? (extractOriginalSelection(selection) || selection.toString()).replace(/\s+/g, " ").trim().slice(0, 25000)
    : "";
  if (hasLiveSelection && !selectedText) return;

  const preservedRange = hasLiveSelection ? selection.getRangeAt(0).cloneRange() : null;
  event.preventDefault();
  event.stopPropagation();
  handleContextMenuAction(match[1], selectedText, preservedRange).catch((error) => {
    console.warn("Combined Annotator: selected-text shortcut failed", error);
    editorCompatibilityDiagnostic("shortcut-action-failed", { action: match[1], error: String(error?.message || error).slice(0, 300) });
  });
}

function setPeekActive(active) {
  document.body.classList.toggle("ca-peek-active", Boolean(active));
  globalThis.CombinedAnnotatorUI?.setPeekActive?.(Boolean(active));
}

async function init() {
  if (!document.body) return;
  document.getElementById("ca-revert-floating-btn")?.remove();

  // Skip hidden or tiny frames (ads, widgets, hidden iframes) to avoid wasting
  // resources. A parent frame can force annotation by setting the
  // data-ca-force-annotate attribute on the document element.
  if (!document.documentElement.dataset.caForceAnnotate) {
    const style = window.getComputedStyle(document.documentElement);
    const rect = document.documentElement.getBoundingClientRect();
    const area = rect.width * rect.height;
    const isHidden = style.display === "none" || style.visibility === "hidden" || area < 16;
    const isLikelyAd = area < 10000 && !CHINESE_RE.test(document.body.innerText || "");
    if (isHidden || isLikelyAd) return;
  }

  // Chrome MV3 aggressively evicts service workers; sendMessage includes
  // built-in retry with exponential backoff for "message channel closed" errors.
  let loaded = null;
  try {
    loaded = await sendMessage({ type: "get-settings", hostname: window.location.hostname }, 4);
  } catch (error) {
    console.warn("Combined Annotator: init settings load failed, using defaults.", error?.message);
    loaded = Core.normalizeSettings();
  }

  settings = Core.normalizeSettings(loaded?.settings || loaded);
  siteDisabled = loaded?.enabled === false;
  refreshPageLanguageHint();

  document.addEventListener("ca-google-office-diagnostics", () => {
    runEditorCompatibilityDiagnostics().catch((error) => {
      editorCompatibilityDiagnostic("diagnostic-snapshot-failed", { error: String(error?.message || error).slice(0, 300) });
    });
    requestSelectionLogoDiagnosticReport("general-diagnostic-event").catch(() => {});
  });
  document.addEventListener("ca-google-office-selection-diagnostics", () => {
    requestSelectionLogoDiagnosticReport("selection-diagnostic-event").catch(() => {});
  });
  editorCompatibilityDiagnostic("content-runtime-ready", {
    version: ext.runtime.getManifest()?.version || "unknown",
    compatibilityEnabled: Boolean(settings.clipboardEditorSupport),
    clipboardApiAvailable: typeof navigator.clipboard?.readText === "function",
    backend: settings.speechBackend,
    siteDisabled
  });
  runEditorCompatibilityDiagnostics("content-runtime-startup").catch((error) => {
    editorCompatibilityDiagnostic("diagnostic-snapshot-failed", { error: String(error?.message || error).slice(0, 300) });
  });

  installGlobalSpeakerHandlers();
  window.addEventListener("pointerup", rememberEditorSelectionPointer, true);
  window.addEventListener("keydown", handleEditorCopyShortcutObservation, true);
  window.addEventListener("copy", handleEditorCopyObservation, true);
  document.addEventListener("copy", handleEditorCopyObservation, true);
  document.addEventListener("copy", handleAnnotationCopy, true);
  document.addEventListener("selectionchange", handleSelectionChange);
  document.addEventListener("keydown", handleReadAloudShortcut, true);
  document.addEventListener("keydown", (event) => { if (!event.repeat && isPeekEvent(event)) setPeekActive(true); }, true);
  document.addEventListener("keyup", (event) => { if (isPeekEvent(event)) setPeekActive(false); }, true);
  window.addEventListener("blur", () => setPeekActive(false));
  applyToneColors(settings);
  applyInjectedTheme();
  globalThis.CombinedAnnotatorUI?.init?.({ settings, contentApi: globalThis.CombinedAnnotatorContent });
  editorCompatibilityDiagnostic("selection-logo-listeners-ready", {
    selectionChange: true,
    copyEvent: true,
    copyShortcut: true,
    pointerTracking: true,
    overlayApiAvailable: Boolean(globalThis.CombinedAnnotatorUI?.showSelectionTools)
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if ((settings.uiTheme || "auto") === "auto") applyInjectedTheme();
  });
  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });
  document.addEventListener("scroll", handleCapturedSelectionScroll, { capture: true, passive: true });
  window.addEventListener("scroll", scheduleViewportRefresh, { passive: true });
  window.addEventListener("scroll", dismissSelectionToolsForScroll, { passive: true });
  window.addEventListener("resize", scheduleViewportRefresh, { passive: true });
  window.addEventListener("resize", scheduleSelectionToolsUpdate, { passive: true });
  document.addEventListener("mouseover", handleHoverAnnotate, { passive: true });
  scheduleSelectionToolsUpdate();
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

function annotatedUnitOriginal(unit) {
  return unit.dataset.caPageOriginal || unit.dataset.caOriginal || unit.querySelector(".ca-base")?.textContent || "";
}

function updateAnnotatedUnitForConversion(unit, original, nextValue, mode) {
  if (!unit?.isConnected || typeof nextValue !== "string") return false;
  const base = unit.querySelector(":scope > .ca-base");
  if (!base) return false;
  if (mode === "page-original") {
    delete unit.dataset.caPageOriginal;
  } else {
    unit.dataset.caPageOriginal = original;
    rememberConvertedOriginal(original, nextValue);
  }
  unit.dataset.caOriginal = nextValue;
  base.textContent = nextValue;
  unit.hidden = nextValue.length === 0;
  unit.querySelectorAll(":scope > .ca-lines > .ca-line").forEach((line) => {
    line.dataset.caSpeakBase = nextValue;
  });
  return true;
}

function annotatedRunOriginal(run) {
  return run.dataset.caPageOriginal || run.dataset.caOriginal || Array.from(run.childNodes).map((child) => {
    if (child.nodeType === Node.ELEMENT_NODE && child.matches(".ca-unit")) return annotatedUnitOriginal(child);
    return child.textContent || "";
  }).join("");
}

function updateAnnotatedRunForConversion(run, original, nextValue, mode) {
  if (!run?.isConnected || !original || !nextValue) return 0;
  const originalChars = Array.from(original);
  const targetChars = Array.from(nextValue);
  let cursor = 0;
  let changed = 0;
  const alignedUnits = [];
  for (const child of run.childNodes) {
    if (child.nodeType !== Node.ELEMENT_NODE || !child.matches(".ca-unit")) continue;
    const source = annotatedUnitOriginal(child);
    const sourceChars = Array.from(source);
    let sourceStart = -1;
    for (let candidate = cursor; candidate <= originalChars.length - sourceChars.length; candidate++) {
      if (originalChars.slice(candidate, candidate + sourceChars.length).join("") === source) {
        sourceStart = candidate;
        break;
      }
    }
    if (sourceStart < 0) {
      console.warn("Combined Annotator: skipped an annotation unit that could not be aligned with its source phrase.");
      continue;
    }
    cursor = sourceStart + sourceChars.length;
    alignedUnits.push({ child, source, sourceStart, sourceEnd: cursor });
  }

  const targetBoundaries = Core.alignConvertedBoundaries(original, nextValue);
  for (const { child, source, sourceStart, sourceEnd } of alignedUnits) {
    const targetStart = targetBoundaries[sourceStart] ?? 0;
    const targetEnd = targetBoundaries[sourceEnd] ?? targetChars.length;
    const targetSegment = targetChars.slice(targetStart, targetEnd).join("");
    if ((child.dataset.caOriginal !== targetSegment || child.hidden !== (targetSegment.length === 0)) &&
        updateAnnotatedUnitForConversion(child, source, targetSegment, mode)) changed++;
  }

  if (mode === "page-original") {
    delete run.dataset.caPageOriginal;
  } else {
    run.dataset.caPageOriginal = original;
    rememberConvertedOriginal(original, nextValue);
  }
  run.dataset.caOriginal = nextValue;
  return changed;
}

async function performPageConversion(mode) {
  if (!document.body) return 0;
  if (mode !== "page-traditional" && mode !== "page-simplified" && mode !== "page-original") return 0;

  const shouldReannotate = anyEnabled();
  pauseAnnotationPipeline();
  const annotatedRuns = Array.from(document.querySelectorAll(".ca-run[data-ca-annotation='true']"));
  const annotatedOriginals = annotatedRuns.map(annotatedRunOriginal);
  let changed = 0;
  try {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) {
      if (!node.nodeValue || !CHINESE_RE.test(node.nodeValue)) continue;
      if (node.parentElement && ["SCRIPT", "STYLE", "NOSCRIPT"].includes(node.parentElement.tagName)) continue;
      if (node.parentElement?.closest("[data-ca-stroke-overlay]")) continue;
      if (node.parentElement?.closest("[data-ca-annotation], [data-ca-overlay-host]")) continue;
      if (node.parentElement && isNativeCaptionElement(node.parentElement)) continue;
      nodes.push(node);
    }

    // Always convert from the page's restored source text. This makes switching
    // between Simplified, Traditional, and Original idempotent and prevents
    // already-annotated text from being converted a second time.
    const originals = nodes.map((textNode) => {
      const original = originalTextNodes.get(textNode) || textNode.nodeValue;
      if (!originalTextNodes.has(textNode)) originalTextNodes.set(textNode, original);
      return original;
    });

    let nextValues;
    let annotatedNextValues;
    if (mode === "page-original") {
      nextValues = originals;
      annotatedNextValues = annotatedOriginals;
    } else {
      const conversionMode = mode === "page-traditional" ? "traditional" : "simplified";
      [nextValues, annotatedNextValues] = await Promise.all([
        convertManyViaBackground(originals, conversionMode),
        convertManyViaBackground(annotatedOriginals, conversionMode)
      ]);
    }

    for (let index = 0; index < annotatedRuns.length; index++) {
      changed += updateAnnotatedRunForConversion(
        annotatedRuns[index],
        annotatedOriginals[index],
        annotatedNextValues[index],
        mode
      );
    }

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

    return changed;
  } finally {
    window.setTimeout(() => {
      observerPaused = false;
      if (shouldReannotate) {
        coverageSweepCount = 0;
        enqueueVisibleContent({ force: true, bodyWide: true });
        enqueueScan(document.body);
        scheduleCoverageSweep();
      }
    }, 0);
  }
}

function handlePageConversion(mode) {
  const operation = pageConversionChain.then(
    () => performPageConversion(mode),
    () => performPageConversion(mode)
  );
  pageConversionChain = operation.catch(() => {});
  return operation;
}

async function handleContextMenuAction(action, text, preservedRange = null) {
  editorCompatibilityDiagnostic("action-started", {
    action: action || "unknown",
    providedTextLength: String(text || "").length,
    preservedDomRange: Boolean(preservedRange),
    backend: settings.speechBackend
  });
  if (action === "open-reader") {
    const actionText = await resolveActionText(extractReaderSelection() || text || "");
    if (!actionText && isCanvasEditorHost()) {
      editorCompatibilityDiagnostic("action-stopped", { action, reason: "no-text" });
      return;
    }
    editorCompatibilityDiagnostic("reader-opening", { textLength: actionText.length });
    globalThis.CombinedAnnotatorUI?.openReader?.(actionText);
    return;
  } else if (action === "convert-traditional" || action === "convert-simplified") {
    const selection = window.getSelection();
    if (!preservedRange && !selection.rangeCount) return;

    const range = preservedRange?.cloneRange?.() || selection.getRangeAt(0);
    const converted = await convertViaBackground(text, action === "convert-traditional" ? "traditional" : "simplified");

    try {
      range.deleteContents();
      range.insertNode(document.createTextNode(converted));
      selection?.removeAllRanges?.();
      hideSelectionToolsForPage();
    } catch (error) {
      console.warn("Combined Annotator: could not replace selection", error);
    }
  } else if (action === "stroke-order-simplified" || action === "stroke-order-traditional") {
    const actionText = await resolveActionText(text);
    if (!actionText && isCanvasEditorHost()) {
      editorCompatibilityDiagnostic("action-stopped", { action, reason: "no-text" });
      return;
    }
    editorCompatibilityDiagnostic("stroke-order-opening", {
      action,
      textLength: actionText.length,
      chineseCharacterCount: extractChineseCharacters(actionText).length
    });
    showStrokeOrderOverlay(actionText, action === "stroke-order-traditional" ? "traditional" : "simplified");
  } else if (action === "read-aloud-jyutping" || action === "read-aloud-pinyin" || action === "read-aloud-english") {
    let lang = "en-US";
    let voice = settings.englishVoice;
    
    if (action === "read-aloud-jyutping") {
      lang = "zh-HK";
      voice = settings.jyutpingVoice;
    } else if (action === "read-aloud-pinyin") {
      lang = "zh-CN";
      voice = settings.pinyinVoice;
    }
    // Jyutping/Pinyin read the actual Chinese characters aloud in the matching
    // dialect voice (zh-HK / zh-CN) — the TTS engine pronounces the hanzi, so
    // we must NOT feed it the romanization string ("ceon1 min4"). English reads
    // the gloss text instead.
    let kind = action === "read-aloud-english" ? "English" : "Chinese";

    const now = Date.now();
    let extractedText = await resolveActionText(text, {
      allowUnconfirmedNonChinese: action === "read-aloud-english"
    });
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const units = getSelectedAnnotationUnits(selection);
      const originalSelection = extractOriginalSelection(selection);
      if (kind === "Chinese" && CHINESE_RE.test(originalSelection)) {
        // Restore the selected annotated DOM so punctuation and spacing reach
        // the voice as one natural sentence instead of disconnected words.
        extractedText = originalSelection;
      } else if (units.length > 0) {
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
    if (kind === "English" && CHINESE_RE.test(extractedText)) {
      extractedText = await resolveEnglishSpeechText(extractedText);
      if (!extractedText) {
        editorCompatibilityDiagnostic("action-stopped", {
          action,
          reason: "english-gloss-unavailable"
        });
        showSpeechNotice("No English definition was found for the copied Chinese text, so it was not sent to the English voice.");
        return;
      }
    }
    if (kind === "Chinese" && isCanvasEditorHost() && extractedText && !CHINESE_RE.test(extractedText)) {
      editorCompatibilityDiagnostic("action-stopped", {
        action,
        reason: "copied-text-has-no-chinese",
        textLength: String(extractedText).length
      });
      showSpeechNotice(`The copied text contains no Chinese characters, so it was not sent to the ${action === "read-aloud-jyutping" ? "Cantonese" : "Mandarin"} voice. Click the document, select the Chinese text, press Ctrl+C, then try again.`);
      return;
    }
    const normalizedText = String(extractedText).replace(/\s+/g, " ").trim();
    // The shared speech boundary removes invisible separators while preserving
    // meaningful spaces in mixed text such as "Windows 11".
    const speechText = normalizedText;

    // Alternate speaking speed on repeated reads: the 2nd, 4th, … read of the
    // same selection within a short window is slowed down for easier listening.
    const repeatKey = `${action}:${speechText}`;
    const isRepeat = repeatKey === lastContextSpeak.key && (now - lastContextSpeak.time) < 8000;
    const shouldReadSlower = isRepeat && lastContextSpeak.slowNext;
    lastContextSpeak = { key: repeatKey, time: now, slowNext: isRepeat ? !lastContextSpeak.slowNext : true };

    const payload = {
      id: `speech-context-${now}`,
      text: speechText,
      lang: lang,
      rate: shouldReadSlower ? Math.max(0.4, settings.speechRate * 0.5) : settings.speechRate,
      pitch: settings.speechPitch,
      voiceName: voice,
      backend: settings.speechBackend
    };

    if (!payload.text) {
      if (!isCanvasEditorHost()) showSpeechNotice("Select text first, then choose a read-aloud language.");
      editorCompatibilityDiagnostic("action-stopped", { action, reason: "no-text" });
      return;
    }

    editorCompatibilityDiagnostic("speech-dispatched", {
      action,
      backend: payload.backend,
      language: payload.lang,
      requestedVoice: payload.backend === "azure" ? Core.azureSpeechVoiceForLanguage(payload.lang).voice : (payload.voiceName || "automatic"),
      textLength: payload.text.length,
      slowerRepeat: shouldReadSlower
    });
    speakFromContentScript(payload);
  }
}


















function installStrokeOrderContextTracker() {
  document.addEventListener("contextmenu", (event) => {
    const selection = window.getSelection();
    editorCompatibilityDiagnostic("page-contextmenu-observed", {
      shiftKey: Boolean(event.shiftKey),
      liveDomSelectionLength: selection && !selection.isCollapsed ? selection.toString().length : 0
    });
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
    loadSequence: 0,
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
  const state = strokeOverlayState;
  const currentIndex = Math.max(0, state.chars.indexOf(state.currentChar));
  const nextMode = state.mode === "traditional" ? "simplified" : "traditional";
  const chars = await normalizeStrokeCharacters(state.sourceText, nextMode);
  if (!chars.length || strokeOverlayState !== state) return;

  const nextChar = chars[Math.min(currentIndex, chars.length - 1)] || chars[0];
  state.mode = nextMode;
  state.chars = chars;
  state.currentChar = nextChar;
  state.title.textContent = nextMode === "traditional" ? "Stroke Order: Traditional" : "Stroke Order: Simplified";
  state.modeButton.textContent = nextMode === "traditional" ? "Simplified" : "Traditional";
  state.modeButton.title = nextMode === "traditional" ? "Switch to Simplified" : "Switch to Traditional";
  buildStrokeCharacterPicker();
  animateStrokeCharacter(nextChar);
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

async function animateStrokeCharacter(char, options = {}) {
  if (!strokeOverlayState || !char) return;
  const state = strokeOverlayState;
  const { canvas, status, picker } = state;
  const wasPaused = state.isPaused;
  const loadSequence = ++state.loadSequence;
  const previousWriter = state.writer;
  state.writer = null;
  state.currentChar = char;
  try {
    const pauseResult = previousWriter?.pauseAnimation();
    if (pauseResult && typeof pauseResult.catch === "function") pauseResult.catch(() => {});
  } catch (_error) {
    // A failed/unfinished writer must not prevent a different character loading.
  }
  canvas.textContent = "";
  status.textContent = `Loading ${char}...`;
  updateStrokePlaybackControls();

  picker.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("is-active", button.textContent === char);
  });

  if (!globalThis.HanziWriter) {
    status.textContent = "Stroke animation library did not load.";
    return;
  }

  if (!options.skipAnnotations) updateStrokeAnnotations(char);

  let characterData;
  try {
    characterData = await getStrokeCharacterData(char);
  } catch (error) {
    if (strokeOverlayState !== state || state.loadSequence !== loadSequence) return;
    console.warn(`Combined Annotator: stroke data failed for ${char}`, error);
    status.textContent = strokeLoadErrorMessage(char, error);
    updateStrokePlaybackControls();
    return;
  }

  if (strokeOverlayState !== state || state.loadSequence !== loadSequence || state.currentChar !== char) return;

  // Size the character to the canvas box (not the window), so it stays centred
  // and fully inside the panel regardless of viewport width.
  const available = Math.min(canvas.clientWidth, canvas.clientHeight) || 240;
  const size = Math.max(160, Math.min(248, available - 12));
  const darkTheme = document.documentElement.dataset.caTheme === "dark";
  try {
    const writer = globalThis.HanziWriter.create(canvas, char, {
      width: size,
      height: size,
      padding: 8,
      renderer: "canvas",
      showOutline: true,
      showCharacter: false,
      strokeAnimationSpeed: state.speed,
      delayBetweenStrokes: 180,
      delayBetweenLoops: 650,
      drawingWidth: 32,
      drawingColor: darkTheme ? "#f8fafc" : "#111827",
      radicalColor: darkTheme ? "#2dd4bf" : "#0f766e",
      strokeColor: darkTheme ? "#f8fafc" : "#111827",
      outlineColor: darkTheme ? "#475569" : "#cbd5e1",
      // Data is preloaded above. Supplying it synchronously here prevents a
      // permanently blank writer when an extension message stalls mid-load.
      charDataLoader: (_requestedChar, onComplete) => onComplete(characterData)
    });
    state.writer = writer;
    await writer.getCharacterData();
    if (strokeOverlayState !== state || state.loadSequence !== loadSequence || state.writer !== writer) return;
    state.isPaused = wasPaused;
    updateStrokePlaybackControls();
    updateStrokeStatus();
    const animation = writer.loopCharacterAnimation();
    if (animation && typeof animation.catch === "function") {
      animation.catch((error) => {
        if (strokeOverlayState !== state || state.writer !== writer) return;
        console.warn(`Combined Annotator: stroke animation failed for ${char}`, error);
        status.textContent = `Could not animate ${char}.`;
      });
    }
    if (state.isPaused) writer.pauseAnimation();
  } catch (error) {
    if (strokeOverlayState !== state || state.loadSequence !== loadSequence) return;
    state.writer = null;
    console.warn(`Combined Annotator: stroke renderer failed for ${char}`, error);
    status.textContent = `Could not render ${char}: ${error.message || String(error)}`;
    updateStrokePlaybackControls();
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
  const hasWriter = Boolean(strokeOverlayState.writer);
  strokeOverlayState.pauseButton.textContent = strokeOverlayState.isPaused ? "Resume" : "Pause";
  strokeOverlayState.pauseButton.disabled = !hasWriter || strokeOverlayState.isPractice;
  if (strokeOverlayState.practiceButton) {
    strokeOverlayState.practiceButton.textContent = strokeOverlayState.isPractice ? "Stop Practice" : "Practice";
    strokeOverlayState.practiceButton.classList.toggle("is-active", strokeOverlayState.isPractice);
    strokeOverlayState.practiceButton.disabled = !hasWriter;
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
const strokeDataRequests = new Map();
let diagnosticStrokeHost = null;
let diagnosticStrokeWriter = null;

function getStrokeCharacterData(char) {
  if (strokeDataCache.has(char)) return Promise.resolve(strokeDataCache.get(char));
  if (strokeDataRequests.has(char)) return strokeDataRequests.get(char);

  const request = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      callback(value);
    };
    const timeoutId = window.setTimeout(() => {
      finish(reject, new Error(`Stroke data request timed out after ${STROKE_DATA_TIMEOUT_MS / 1000} seconds`));
    }, STROKE_DATA_TIMEOUT_MS);

    sendMessage({ type: "get-stroke-data", char })
      .then((response) => {
        const data = response?.data;
        if (!data || !Array.isArray(data.strokes) || !data.strokes.length) {
          throw new Error(`No stroke data for ${char}`);
        }
        strokeDataCache.set(char, data);
        finish(resolve, data);
      })
      .catch((error) => finish(reject, error));
  }).finally(() => {
    strokeDataRequests.delete(char);
  });

  strokeDataRequests.set(char, request);
  return request;
}

function strokeLoadErrorMessage(char, error) {
  const detail = String(error?.message || error || "");
  if (/timed out/i.test(detail)) return `Stroke data for ${char} timed out. Reload the extension and try again.`;
  if (/No stroke data/i.test(detail)) return `No stroke data found for ${char}.`;
  return `Could not load stroke data for ${char}. Reload the extension and try again.`;
}

function loadStrokeCharacterData(char, onComplete, onError) {
  // Kept as a callback adapter for Hanzi Writer APIs outside the overlay.
  getStrokeCharacterData(char)
    .then((data) => onComplete(data))
    .catch((error) => {
      if (onError) onError(error);
    });
}

async function runContentDiagnostics() {
  const checks = [];
  const add = (status, label, detail) => checks.push({ status, label, detail: String(detail || "") });

  publishAnnotationDiagnostics();
  const root = document.documentElement;
  const health = root.dataset.caHealth || "unknown";
  const failed = Number(root.dataset.caAnnotationFailed || 0);
  const completed = Number(root.dataset.caAnnotationCompleted || 0);
  add(health === "error" ? "fail" : (health === "disabled" ? "info" : "pass"), "Page annotation runtime", `${health}; ${completed} completed, ${failed} failed`);
  add(globalThis.CombinedAnnotatorUI ? "pass" : "fail", "Overlay and selection tools", globalThis.CombinedAnnotatorUI ? "Loaded" : "Missing");

  const writerReady = await ensureHanziWriter();
  add(writerReady ? "pass" : "fail", "Hanzi Writer library", writerReady ? "Loaded in the page" : "Could not load in the page");

  let sampleData = null;
  try {
    sampleData = await getStrokeCharacterData("低");
    add("pass", "Page-to-background stroke request", `低 returned ${sampleData.strokes.length} strokes`);
  } catch (error) {
    add("fail", "Page-to-background stroke request", error?.message || String(error));
  }

  if (writerReady && sampleData) {
    try {
      if (!diagnosticStrokeHost?.isConnected) {
        diagnosticStrokeHost = document.createElement("div");
        diagnosticStrokeHost.className = "ca-stroke-canvas ca-diagnostic-stroke-host";
        diagnosticStrokeHost.dataset.caOverlayHost = "true";
        diagnosticStrokeHost.setAttribute("aria-hidden", "true");
        diagnosticStrokeHost.style.cssText = "position:fixed;left:-10000px;top:0;width:96px;height:96px;min-height:96px;opacity:0;pointer-events:none;";
        document.documentElement.appendChild(diagnosticStrokeHost);
        diagnosticStrokeWriter = null;
      }
      if (!diagnosticStrokeWriter) {
        diagnosticStrokeWriter = globalThis.HanziWriter.create(diagnosticStrokeHost, "低", {
          width: 96,
          height: 96,
          padding: 4,
          renderer: "canvas",
          showOutline: true,
          showCharacter: true,
          strokeColor: "#111827",
          outlineColor: "#94a3b8",
          charDataLoader: (character, onComplete, onError) => {
            getStrokeCharacterData(character).then(onComplete).catch(onError);
          }
        });
      } else {
        await diagnosticStrokeWriter.setCharacter("低");
      }
      await diagnosticStrokeWriter.getCharacterData();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const canvas = diagnosticStrokeHost.querySelector("canvas");
      const context = canvas?.getContext?.("2d");
      if (!canvas || !context) throw new Error("Canvas renderer was not created");
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let paintedPixels = 0;
      for (let index = 3; index < pixels.length; index += 4) {
        if (pixels[index] > 0) paintedPixels++;
      }
      if (!paintedPixels) throw new Error("Canvas was created but no strokes were painted");
      add("pass", "Stroke canvas rendering", `${paintedPixels} painted pixels detected`);
    } catch (error) {
      add("fail", "Stroke canvas rendering", error?.message || String(error));
    }
  }

  const speechAvailable = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  const voices = speechAvailable ? await waitForSpeechVoices(window.speechSynthesis) : [];
  add(!speechAvailable ? "warn" : (voices.length ? "pass" : "warn"), "Browser speech engine", !speechAvailable ? "Unavailable" : `${voices.length} voices exposed by Firefox`);

  return {
    ok: !checks.some((check) => check.status === "fail"),
    health,
    checks
  };
}

function showStrokeOrderNotice(message) {
  closeStrokeOrderOverlay();
  const overlay = document.createElement("div");
  overlay.className = "ca-stroke-overlay ca-stroke-notice-overlay";
  overlay.dataset.caStrokeOverlay = "true";
  const panel = document.createElement("div");
  panel.className = "ca-stroke-panel ca-stroke-notice";
  const msgDiv = document.createElement("div");
  msgDiv.textContent = message;
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", () => overlay.remove());
  panel.appendChild(msgDiv);
  panel.appendChild(closeBtn);
  overlay.appendChild(panel);
  document.documentElement.appendChild(overlay);
  window.setTimeout(() => overlay.remove(), 3500);
}

function closeStrokeOrderOverlay() {
  window.clearTimeout(strokeSpeedRestartTimer);
  if (strokeOverlayState) strokeOverlayState.loadSequence += 1;
  if (strokeOverlayState?.writer) {
    try {
      const pauseResult = strokeOverlayState.writer.pauseAnimation();
      if (pauseResult && typeof pauseResult.catch === "function") pauseResult.catch(() => {});
    } catch (_error) {
      // Closing the overlay should remain safe after a renderer failure.
    }
  }
  if (strokeOverlayState?.overlay) strokeOverlayState.overlay.remove();
  strokeOverlayState = null;
}

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && strokeOverlayState) closeStrokeOrderOverlay();
});
globalThis.CombinedAnnotatorContent = {
  sendMessage,
  getSettings: () => ({ ...settings }),
  updateSettings: refreshFromSettings,
  plainTextForElement,
  dictionaryRequestForUnit,
  async runSelectionAction(action, text) {
    const usesClipboard = selectionActionUsesClipboard;
    const preservedRange = usesClipboard ? null : (selectionActionRange?.cloneRange?.() || null);
    const selectedText = usesClipboard ? "" : (selectionActionText || String(text || ""));
    selectionActionRange = null;
    selectionActionText = "";
    selectionActionUsesClipboard = false;
    globalThis.CombinedAnnotatorUI?.hideSelectionTools?.();
    if (usesClipboard && isCanvasEditorHost()) {
      let copied = false;
      try {
        copied = Boolean(document.execCommand?.("copy"));
      } catch (_error) {
        copied = false;
      }
      editorCompatibilityDiagnostic("selection-logo-copy-attempt", { copied });
      if (copied) recordEditorCopySignal("selection-tools");
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    return handleContextMenuAction(action, selectedText, preservedRange);
  },
  async annotatePlainText(text, overrideSettings = {}) {
    const gen = ++annotatePlainTextGeneration;
    const active = Core.normalizeSettings({ ...settings, ...overrideSettings });
    const response = await sendMessage({ type: "annotate-text", text: String(text || ""), settings: active });
    if (gen !== annotatePlainTextGeneration) return null;
    const previous = settings;
    settings = active;
    try {
      return buildAnnotationFragment(String(text || ""), response);
    } finally {
      settings = previous;
    }
  },
  speakText(text, lang = "zh-CN", handlers = {}) {
    return speakFromContentScript({
      id: `overlay-${Date.now()}-${++speechRequestCounter}`,
      text: String(text || ""),
      lang,
      rate: handlers.rate || settings.speechRate,
      pitch: handlers.pitch || settings.speechPitch,
      voiceName: handlers.voiceName || "",
      backend: settings.speechBackend,
      onStart: handlers.onStart,
      onBoundary: handlers.onBoundary,
      onEnd: handlers.onEnd,
      onError: handlers.onError
    });
  },
  pauseSpeech: pauseActiveSpeech,
  resumeSpeech: resumeActiveSpeech,
  stopSpeech: stopActiveSpeech,
  showStrokeOrder: showStrokeOrderOverlay,
  saveVocabEntry,
  extractSelection: extractReaderSelection,
  extractArticle: () => plainTextForElement(document.querySelector("article, main, [role='main']") || document.body).slice(0, 25000)
};
