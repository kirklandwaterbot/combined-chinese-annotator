(function initCombinedAnnotatorOverlay(global) {
  "use strict";

  const Core = global.CombinedAnnotatorCore;
  const ext = typeof browser !== "undefined" ? browser : chrome;
  let settings = Core.normalizeSettings();
  let host = null;
  let shadow = null;
  let dictionaryCard = null;
  let dictionaryResizeObserver = null;
  let dictionaryPositionFrame = 0;
  let dictionaryDragCleanup = null;
  let dictionaryManualPosition = null;
  let readerDialog = null;
  let activeDictionaryRequest = null;
  let hoveredUnit = null;
  let longPressTimer = null;
  let selectionTools = null;
  let selectionTrigger = null;
  let selectionMenu = null;
  let selectionToolsText = "";
  let selectionToolsClipboardMode = false;
  let selectionAnchorRect = null;

  const OVERLAY_CSS = `
    :host {
      all: initial;
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      pointer-events: none;
      color-scheme: light dark;
      --ca-reader-english: var(--ca-english-color, #374151);
      --ca-reader-pinyin-1: var(--ca-pinyin-tone-1, #e53e3e);
      --ca-reader-pinyin-2: var(--ca-pinyin-tone-2, #38a169);
      --ca-reader-pinyin-3: var(--ca-pinyin-tone-3, #3182ce);
      --ca-reader-pinyin-4: var(--ca-pinyin-tone-4, #805ad5);
      --ca-reader-pinyin-5: var(--ca-pinyin-tone-5, #718096);
      --ca-reader-jyutping-1: var(--ca-jyutping-tone-1, #e53e3e);
      --ca-reader-jyutping-2: var(--ca-jyutping-tone-2, #38a169);
      --ca-reader-jyutping-3: var(--ca-jyutping-tone-3, #3182ce);
      --ca-reader-jyutping-4: var(--ca-jyutping-tone-4, #805ad5);
      --ca-reader-jyutping-5: var(--ca-jyutping-tone-5, #718096);
      --ca-reader-jyutping-6: var(--ca-jyutping-tone-6, #319795);
    }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }
    button, input, select, textarea { font: inherit; }
    button { cursor: pointer; }
    .surface { color: #172033; font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .selection-tools { position: fixed; z-index: 12; width: 20px; height: 20px; pointer-events: auto; }
    .selection-trigger { appearance: none; display: grid; place-items: center; width: 20px; height: 20px; margin: 0; padding: 0; overflow: hidden; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
    .selection-trigger:hover, .selection-trigger[aria-expanded="true"] { border-color: transparent; background: transparent; }
    .selection-trigger:focus-visible { outline: 2px solid rgba(20, 184, 166, .72); outline-offset: 2px; border-radius: 3px; }
    .selection-trigger img { display: block; width: 20px; height: 20px; object-fit: contain; }
    .selection-menu { position: absolute; display: grid; width: min(270px, calc(100vw - 24px)); overflow: hidden; padding: 6px; border: 1px solid #cbd5e1; border-radius: 12px; background: #fff; box-shadow: 0 16px 38px rgba(15, 23, 42, .3); pointer-events: auto; }
    .selection-menu-title { padding: 7px 9px 8px; color: #475569; font-size: 11px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; }
    .selection-menu button { width: 100%; min-height: 34px; padding: 7px 9px; border: 0; border-radius: 7px; background: transparent; color: #1e293b; text-align: left; }
    .selection-menu button:hover, .selection-menu button:focus-visible { background: #e6fffb; color: #115e59; outline: none; }
    .selection-menu-separator { height: 1px; margin: 5px 7px; background: #e2e8f0; }
    .card { position: fixed; display: flex; flex-direction: column; width: min(390px, calc(100vw - 24px)); max-height: min(560px, calc(100dvh - 24px)); overflow: hidden; padding: 16px; border: 1px solid #dbe3ec; border-radius: 14px; background: #fff; box-shadow: 0 20px 55px rgba(15, 23, 42, .24); pointer-events: auto; }
    .dictionary-titlebar { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; margin: -6px -4px 8px; }
    .dictionary-drag-handle { display: flex; flex: 1 1 auto; align-items: center; gap: 7px; min-width: 0; min-height: 34px; padding: 6px 9px; border-radius: 8px; color: #64748b; font-size: 12px; font-weight: 700; cursor: grab; user-select: none; touch-action: none; }
    .dictionary-drag-handle::before { content: "⠿"; color: #0f766e; font-size: 18px; line-height: 1; }
    .dictionary-drag-handle:hover, .dictionary-drag-handle:focus-visible { background: #f0fdfa; color: #115e59; outline: none; }
    .dictionary-drag-handle:focus-visible { box-shadow: 0 0 0 2px rgba(20, 184, 166, .4); }
    .card.is-dragging .dictionary-drag-handle { cursor: grabbing; }
    .close { z-index: 4; display: grid; flex: 0 0 auto; place-items: center; width: 32px; height: 32px; padding: 0; border: 1px solid #cbd5e1; border-radius: 9px; background: #f8fafc; box-shadow: 0 2px 8px rgba(15, 23, 42, .16); color: #334155; font-size: 20px; font-weight: 800; line-height: 1; }
    .close:hover { background: #f1f5f9; color: #0f172a; }
    .loading, .empty { padding: 20px 4px; color: #64748b; text-align: center; }
    .dictionary-content { display: flex; flex: 1 1 auto; min-height: 0; flex-direction: column; }
    .dictionary-scroll { min-height: 0; overflow: auto; overscroll-behavior: contain; padding-right: 4px; scrollbar-gutter: stable; }
    .candidate-list { display: flex; gap: 6px; margin: 0 0 12px; overflow-x: auto; scrollbar-width: thin; }
    .candidate { flex: 0 0 auto; padding: 4px 10px; border: 1px solid #d6e0ea; border-radius: 999px; background: #f8fafc; color: #334155; font-weight: 650; }
    .candidate.active { border-color: #0f766e; background: #ccfbf1; color: #115e59; }
    .word-head { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 12px; }
    .hanzi { font: 700 32px/1.1 "Noto Sans CJK SC", "Microsoft YaHei", sans-serif; color: #0f172a; }
    .variants { color: #64748b; font-size: 12px; }
    .badges { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; }
    .badge { padding: 2px 7px; border-radius: 999px; background: #e2e8f0; color: #475569; font-size: 11px; font-weight: 700; }
    .rows { display: grid; gap: 8px; }
    .row { display: grid; grid-template-columns: 72px minmax(0,1fr); gap: 8px; }
    .label { color: #64748b; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; }
    .value { min-width: 0; overflow-wrap: anywhere; color: #1e293b; }
    .senses { margin: 2px 0 0; padding-left: 19px; }
    .senses li + li { margin-top: 4px; }
    .context { margin-top: 12px; padding: 10px 12px; border-left: 3px solid #14b8a6; border-radius: 5px; background: #f0fdfa; color: #334155; }
    .context-source { display: block; margin-top: 4px; color: #64748b; font-size: 11px; }
    .actions { display: grid; flex: 0 0 auto; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 7px; margin: 12px -16px -16px; padding: 10px 16px 16px; border-top: 1px solid #e2e8f0; background: #fff; }
    .dictionary-speech { display: grid; grid-column: 1 / -1; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 7px; }
    .dictionary-speech-label { color: #64748b; font-size: 11px; font-weight: 800; letter-spacing: .03em; text-transform: uppercase; }
    .dictionary-speech select { min-width: 0; min-height: 34px; padding: 5px 24px 5px 7px; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; color: #334155; }
    .dictionary-listen { min-width: 124px; }
    .action { min-height: 34px; padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 8px; background: #f8fafc; color: #334155; font-weight: 650; }
    .action.primary { border-color: #0f766e; background: #0f766e; color: #fff; }
    .action:disabled { opacity: .65; cursor: default; }
    .editor { display: grid; gap: 8px; margin-top: 14px; padding-top: 12px; border-top: 1px solid #e2e8f0; }
    .editor-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .field { display: grid; gap: 3px; color: #475569; font-size: 11px; font-weight: 700; }
    .field input, .field textarea, .field select { width: 100%; padding: 7px 8px; border: 1px solid #cbd5e1; border-radius: 7px; background: #fff; color: #0f172a; font-size: 13px; font-weight: 400; }
    .field textarea { min-height: 82px; resize: vertical; }
    .field.full { grid-column: 1 / -1; }
    .modal-backdrop { position: fixed; inset: 0; display: grid; place-items: center; padding: 20px; background: rgba(15, 23, 42, .68); backdrop-filter: blur(3px); pointer-events: auto; }
    .reader { position: relative; display: grid; grid-template-rows: auto auto minmax(0,1fr) auto; width: min(1040px, 100%); height: min(820px, 100%); overflow: hidden; border: 1px solid #334155; border-radius: 18px; background: #f8fafc; box-shadow: 0 28px 80px rgba(0,0,0,.4); }
    .reader-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 18px; border-bottom: 1px solid #dbe3ec; background: #fff; }
    .reader-title { margin: 0; color: #0f172a; font-size: 16px; }
    .reader-progress { color: #64748b; font-size: 12px; }
    .reader-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 10px 18px; border-bottom: 1px solid #e2e8f0; background: #fff; }
    .reader-toolbar label { display: inline-flex; align-items: center; gap: 4px; color: #475569; font-size: 12px; }
    .reader-speech-language { font-weight: 700; }
    .reader-speech-language select { min-height: 32px; padding: 4px 28px 4px 8px; border: 1px solid #cbd5e1; border-radius: 7px; background: #fff; color: #0f172a; font: inherit; }
    .reader-speech-status { min-width: 122px; color: #475569; font-size: 12px; font-weight: 700; }
    .reader-toolbar button, .reader-footer button { min-height: 32px; padding: 5px 10px; border: 1px solid #cbd5e1; border-radius: 7px; background: #fff; color: #334155; }
    .reader-toolbar button:disabled { cursor: not-allowed; opacity: .48; }
    .reader-body { overflow: auto; padding: clamp(24px, 6vw, 72px); }
    .reader-sentence { max-width: 820px; margin: 0 auto; color: #111827; font: 400 clamp(24px, 3.2vw, 42px)/2 "Noto Sans CJK SC", "Microsoft YaHei", sans-serif; }
    .reader-sentence .ca-unit { display: inline-block; margin: 0 .06em; text-align: center; vertical-align: baseline; }
    .reader-sentence .ca-lines { display: flex; flex-direction: column; align-items: center; line-height: 1; user-select: none; }
    .reader-sentence .ca-line { display: inline-flex; color: #334155; font: 500 .46em/1.05 Arial, sans-serif; }
    :host([data-ca-english-coloring="true"]) .reader-sentence .ca-english { color: var(--ca-reader-english, #374151); }
    :host([data-ca-pinyin-tone-coloring="true"]) .reader-sentence :is(.ca-line, .ca-tone-token).ca-pinyin-tone-1 { color: var(--ca-reader-pinyin-1, #e53e3e); }
    :host([data-ca-pinyin-tone-coloring="true"]) .reader-sentence :is(.ca-line, .ca-tone-token).ca-pinyin-tone-2 { color: var(--ca-reader-pinyin-2, #38a169); }
    :host([data-ca-pinyin-tone-coloring="true"]) .reader-sentence :is(.ca-line, .ca-tone-token).ca-pinyin-tone-3 { color: var(--ca-reader-pinyin-3, #3182ce); }
    :host([data-ca-pinyin-tone-coloring="true"]) .reader-sentence :is(.ca-line, .ca-tone-token).ca-pinyin-tone-4 { color: var(--ca-reader-pinyin-4, #805ad5); }
    :host([data-ca-pinyin-tone-coloring="true"]) .reader-sentence :is(.ca-line, .ca-tone-token).ca-pinyin-tone-5 { color: var(--ca-reader-pinyin-5, #718096); }
    :host([data-ca-jyutping-tone-coloring="true"]) .reader-sentence :is(.ca-line, .ca-tone-token).ca-jyutping-tone-1 { color: var(--ca-reader-jyutping-1, #e53e3e); }
    :host([data-ca-jyutping-tone-coloring="true"]) .reader-sentence :is(.ca-line, .ca-tone-token).ca-jyutping-tone-2 { color: var(--ca-reader-jyutping-2, #38a169); }
    :host([data-ca-jyutping-tone-coloring="true"]) .reader-sentence :is(.ca-line, .ca-tone-token).ca-jyutping-tone-3 { color: var(--ca-reader-jyutping-3, #3182ce); }
    :host([data-ca-jyutping-tone-coloring="true"]) .reader-sentence :is(.ca-line, .ca-tone-token).ca-jyutping-tone-4 { color: var(--ca-reader-jyutping-4, #805ad5); }
    :host([data-ca-jyutping-tone-coloring="true"]) .reader-sentence :is(.ca-line, .ca-tone-token).ca-jyutping-tone-5 { color: var(--ca-reader-jyutping-5, #718096); }
    :host([data-ca-jyutping-tone-coloring="true"]) .reader-sentence :is(.ca-line, .ca-tone-token).ca-jyutping-tone-6 { color: var(--ca-reader-jyutping-6, #319795); }
    .reader-sentence .ca-base { display: block; color: inherit; font: inherit; line-height: 1.05; }
    .reader-sentence .speech-current .ca-base { border-radius: .12em; background: #fde68a; box-shadow: 0 0 0 .08em #fde68a; }
    .reader-sentence .ca-speak, .reader-sentence .ca-hsk-badge { display: none; }
    .reader-sentence:not(.show-jyutping) .ca-jyutping, .reader-sentence:not(.show-pinyin) .ca-pinyin, .reader-sentence:not(.show-english) .ca-english { display: none; }
    .reader-sentence.speaking { outline: 3px solid rgba(20,184,166,.35); outline-offset: 12px; border-radius: 8px; }
    .reader-footer { display: flex; justify-content: space-between; gap: 10px; padding: 12px 18px; border-top: 1px solid #dbe3ec; background: #fff; }
    @media (prefers-color-scheme: dark) {
      .card, .actions, .reader, .reader-header, .reader-toolbar, .reader-footer { border-color: #334155; background: #111827; color: #e2e8f0; }
      .selection-trigger,
      .selection-trigger:hover,
      .selection-trigger[aria-expanded="true"] { border-color: transparent; background: transparent; }
      .selection-menu { border-color: #475569; background: #111827; }
      .selection-menu-title { color: #94a3b8; }
      .selection-menu button { color: #e2e8f0; }
      .selection-menu button:hover, .selection-menu button:focus-visible { background: #134e4a; color: #ccfbf1; }
      .selection-menu-separator { background: #334155; }
      :host {
        --ca-reader-english: color-mix(in srgb, var(--ca-english-color, #374151) 45%, #f8fafc);
        --ca-reader-pinyin-1: color-mix(in srgb, var(--ca-pinyin-tone-1, #e53e3e) 75%, #fff);
        --ca-reader-pinyin-2: color-mix(in srgb, var(--ca-pinyin-tone-2, #38a169) 75%, #fff);
        --ca-reader-pinyin-3: color-mix(in srgb, var(--ca-pinyin-tone-3, #3182ce) 75%, #fff);
        --ca-reader-pinyin-4: color-mix(in srgb, var(--ca-pinyin-tone-4, #805ad5) 75%, #fff);
        --ca-reader-pinyin-5: color-mix(in srgb, var(--ca-pinyin-tone-5, #718096) 68%, #fff);
        --ca-reader-jyutping-1: color-mix(in srgb, var(--ca-jyutping-tone-1, #e53e3e) 75%, #fff);
        --ca-reader-jyutping-2: color-mix(in srgb, var(--ca-jyutping-tone-2, #38a169) 75%, #fff);
        --ca-reader-jyutping-3: color-mix(in srgb, var(--ca-jyutping-tone-3, #3182ce) 75%, #fff);
        --ca-reader-jyutping-4: color-mix(in srgb, var(--ca-jyutping-tone-4, #805ad5) 75%, #fff);
        --ca-reader-jyutping-5: color-mix(in srgb, var(--ca-jyutping-tone-5, #718096) 68%, #fff);
        --ca-reader-jyutping-6: color-mix(in srgb, var(--ca-jyutping-tone-6, #319795) 75%, #fff);
      }
      .hanzi, .reader-title, .reader-sentence, .value { color: #f8fafc; }
      .reader-sentence .ca-line, .reader-toolbar label, .reader-progress { color: #cbd5e1; }
      .candidate, .action, .dictionary-speech select, .reader-toolbar button, .reader-footer button, .reader-speech-language select { border-color: #475569; background: #1e293b; color: #e2e8f0; }
      .dictionary-drag-handle, .dictionary-speech-label { color: #94a3b8; }
      .dictionary-drag-handle:hover, .dictionary-drag-handle:focus-visible { background: #134e4a; color: #ccfbf1; }
      .reader-speech-status { color: #cbd5e1; }
      .candidate.active { border-color: #2dd4bf; background: #134e4a; color: #ccfbf1; }
      .context { background: #042f2e; color: #cbd5e1; }
      .field input, .field textarea, .field select { border-color: #475569; background: #0f172a; color: #f8fafc; }
      .close { border-color: #475569; background: #1e293b; color: #f8fafc; box-shadow: 0 2px 8px rgba(0, 0, 0, .35); }
      .close:hover { background: #334155; color: #fff; }
    }
  `;

  function syncHostAnnotationPalette() {
    if (!host) return;
    host.dataset.caEnglishColoring = String(Boolean(settings.enableEnglishColoring));
    host.dataset.caPinyinToneColoring = String(Boolean(settings.enablePinyinToneColoring));
    host.dataset.caJyutpingToneColoring = String(Boolean(settings.enableJyutpingToneColoring));
    const palette = {
      "--ca-english-color": settings.englishColor,
      "--ca-pinyin-tone-1": settings.pinyinTone1Color,
      "--ca-pinyin-tone-2": settings.pinyinTone2Color,
      "--ca-pinyin-tone-3": settings.pinyinTone3Color,
      "--ca-pinyin-tone-4": settings.pinyinTone4Color,
      "--ca-pinyin-tone-5": settings.pinyinTone5Color,
      "--ca-jyutping-tone-1": settings.jyutpingTone1Color,
      "--ca-jyutping-tone-2": settings.jyutpingTone2Color,
      "--ca-jyutping-tone-3": settings.jyutpingTone3Color,
      "--ca-jyutping-tone-4": settings.jyutpingTone4Color,
      "--ca-jyutping-tone-5": settings.jyutpingTone5Color,
      "--ca-jyutping-tone-6": settings.jyutpingTone6Color
    };
    for (const [property, value] of Object.entries(palette)) host.style.setProperty(property, value);
  }

  function ensureShadow() {
    if (shadow) return shadow;
    host = document.createElement("div");
    host.id = "combined-annotator-overlay-host";
    host.dataset.caOverlayHost = "true";
    shadow = host.attachShadow({ mode: "open" });
    syncHostAnnotationPalette();
    const style = document.createElement("style");
    style.textContent = OVERLAY_CSS;
    shadow.appendChild(style);
    document.documentElement.appendChild(host);
    return shadow;
  }

  function closeSelectionToolsMenu() {
    if (!selectionMenu || !selectionTrigger) return;
    selectionMenu.hidden = true;
    selectionTrigger.setAttribute("aria-expanded", "false");
  }

  function hideSelectionTools() {
    closeSelectionToolsMenu();
    if (selectionTools) selectionTools.hidden = true;
    selectionToolsText = "";
    selectionToolsClipboardMode = false;
    selectionAnchorRect = null;
  }

  function positionSelectionTools() {
    if (!selectionTools || selectionTools.hidden || !selectionAnchorRect) return;
    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft || 0;
    const viewportTop = viewport?.offsetTop || 0;
    const viewportRight = viewportLeft + (viewport?.width || innerWidth);
    const viewportBottom = viewportTop + (viewport?.height || innerHeight);
    const size = 34;
    const gap = 7;
    let left = selectionAnchorRect.right + gap;
    let top = selectionAnchorRect.bottom + gap;
    if (left + size > viewportRight - 8) left = selectionAnchorRect.left - size - gap;
    if (left < viewportLeft + 8) left = viewportRight - size - 8;
    if (top + size > viewportBottom - 8) top = selectionAnchorRect.top - size - gap;
    if (top < viewportTop + 8) top = viewportTop + 8;
    selectionTools.style.left = `${Math.round(left)}px`;
    selectionTools.style.top = `${Math.round(top)}px`;
  }

  function positionSelectionMenu() {
    if (!selectionTools || !selectionMenu || selectionMenu.hidden) return;
    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft || 0;
    const viewportTop = viewport?.offsetTop || 0;
    const viewportRight = viewportLeft + (viewport?.width || innerWidth);
    const viewportBottom = viewportTop + (viewport?.height || innerHeight);
    selectionMenu.style.left = "0px";
    selectionMenu.style.top = "41px";
    const triggerRect = selectionTrigger.getBoundingClientRect();
    const menuRect = selectionMenu.getBoundingClientRect();
    let left = triggerRect.left;
    let top = triggerRect.bottom + 7;
    if (left + menuRect.width > viewportRight - 8) left = viewportRight - menuRect.width - 8;
    if (left < viewportLeft + 8) left = viewportLeft + 8;
    if (top + menuRect.height > viewportBottom - 8) top = triggerRect.top - menuRect.height - 7;
    if (top < viewportTop + 8) top = viewportTop + 8;
    selectionMenu.style.left = `${Math.round(left - triggerRect.left)}px`;
    selectionMenu.style.top = `${Math.round(top - triggerRect.top)}px`;
  }

  function ensureSelectionTools() {
    if (selectionTools) return selectionTools;
    const root = ensureShadow();
    selectionTools = el("div", "selection-tools surface");
    selectionTools.hidden = true;

    selectionTrigger = button("", "selection-trigger");
    selectionTrigger.title = "Open Combined Chinese Annotator actions";
    selectionTrigger.setAttribute("aria-label", "Open Combined Chinese Annotator actions for selected text");
    selectionTrigger.setAttribute("aria-haspopup", "menu");
    selectionTrigger.setAttribute("aria-expanded", "false");
    const icon = document.createElement("img");
    icon.src = ext.runtime.getURL("pinjyut_logo.png");
    icon.alt = "";
    selectionTrigger.appendChild(icon);

    selectionMenu = el("div", "selection-menu");
    selectionMenu.hidden = true;
    selectionMenu.setAttribute("role", "menu");
    selectionMenu.appendChild(el("div", "selection-menu-title", "Combined Chinese Annotator"));
    const actions = [
      ["convert-traditional", "Convert to Traditional"],
      ["convert-simplified", "Convert to Simplified"],
      null,
      ["read-aloud-jyutping", "Read Selected (Jyutping)"],
      ["read-aloud-pinyin", "Read Selected (Pinyin)"],
      ["read-aloud-english", "Read Selected (English)"],
      null,
      ["open-reader", "Open in Chinese Reader"],
      ["stroke-order-simplified", "Show Stroke Order (Simplified)"],
      ["stroke-order-traditional", "Show Stroke Order (Traditional)"]
    ];
    for (const action of actions) {
      if (!action) {
        selectionMenu.appendChild(el("div", "selection-menu-separator"));
        continue;
      }
      const [id, label] = action;
      const actionButton = button(label, "", () => {
        const selectedText = selectionToolsText;
        hideSelectionTools();
        Promise.resolve(global.CombinedAnnotatorContent?.runSelectionAction?.(id, selectedText)).catch((error) => {
          console.warn("Combined Annotator selection action failed", error);
        });
      });
      actionButton.setAttribute("role", "menuitem");
      selectionMenu.appendChild(actionButton);
    }

    selectionTools.addEventListener("pointerdown", (event) => event.preventDefault());
    selectionTrigger.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const opening = selectionMenu.hidden;
      selectionMenu.hidden = !opening;
      selectionTrigger.setAttribute("aria-expanded", String(opening));
      if (opening) requestAnimationFrame(positionSelectionMenu);
    });
    selectionTools.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeSelectionToolsMenu();
      selectionTrigger.focus();
    });
    selectionTools.append(selectionTrigger, selectionMenu);
    root.appendChild(selectionTools);
    return selectionTools;
  }

  function showSelectionTools({ rect, text, clipboardMode = false } = {}) {
    const cleanText = String(text || "").trim();
    if (!rect || (!cleanText && !clipboardMode)) {
      hideSelectionTools();
      return;
    }
    ensureSelectionTools();
    if (cleanText !== selectionToolsText || Boolean(clipboardMode) !== selectionToolsClipboardMode) closeSelectionToolsMenu();
    selectionToolsText = cleanText;
    selectionToolsClipboardMode = Boolean(clipboardMode);
    selectionTrigger.title = clipboardMode
      ? "Open Combined Chinese Annotator actions for copied editor text"
      : "Open Combined Chinese Annotator actions";
    selectionTrigger.setAttribute("aria-label", selectionTrigger.title);
    selectionAnchorRect = {
      left: Number(rect.left) || 0,
      right: Number(rect.right) || 0,
      top: Number(rect.top) || 0,
      bottom: Number(rect.bottom) || 0
    };
    selectionTools.hidden = false;
    positionSelectionTools();
    if (!selectionMenu.hidden) requestAnimationFrame(positionSelectionMenu);
  }

  function getSelectionToolsDiagnostics() {
    const rect = selectionTools?.getBoundingClientRect?.();
    const style = selectionTools ? getComputedStyle(selectionTools) : null;
    return {
      apiAvailable: true,
      diagnosticMethodAvailable: true,
      created: Boolean(selectionTools),
      connected: Boolean(selectionTools?.isConnected),
      hidden: selectionTools ? Boolean(selectionTools.hidden) : null,
      clipboardMode: selectionToolsClipboardMode,
      hasAnchor: Boolean(selectionAnchorRect),
      anchor: selectionAnchorRect ? { ...selectionAnchorRect } : null,
      inlinePosition: selectionTools ? { left: selectionTools.style.left, top: selectionTools.style.top } : null,
      computed: style ? {
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        pointerEvents: style.pointerEvents
      } : null,
      rect: rect ? {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      } : null
    };
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(label, className, handler) {
    const node = el("button", className, label);
    node.type = "button";
    if (handler) node.addEventListener("click", handler);
    return node;
  }

  function removeNode(node) {
    if (node?.isConnected) node.remove();
  }

  function closeDictionary() {
    if (dictionaryPositionFrame) cancelAnimationFrame(dictionaryPositionFrame);
    dictionaryPositionFrame = 0;
    dictionaryDragCleanup?.();
    dictionaryDragCleanup = null;
    dictionaryManualPosition = null;
    dictionaryResizeObserver?.disconnect();
    dictionaryResizeObserver = null;
    removeNode(dictionaryCard);
    dictionaryCard = null;
    activeDictionaryRequest = null;
  }

  function dictionaryViewport() {
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0;
    const top = viewport?.offsetTop || 0;
    return {
      left,
      top,
      right: left + (viewport?.width || innerWidth),
      bottom: top + (viewport?.height || innerHeight),
      height: viewport?.height || innerHeight
    };
  }

  function moveDictionaryCard(card, requestedLeft, requestedTop) {
    const viewport = dictionaryViewport();
    const bounds = card.getBoundingClientRect();
    const width = bounds.width || 390;
    const height = bounds.height || 300;
    const minimumLeft = viewport.left + 12;
    const minimumTop = viewport.top + 12;
    const maximumLeft = Math.max(minimumLeft, viewport.right - width - 12);
    const maximumTop = Math.max(minimumTop, viewport.bottom - height - 12);
    const left = Math.max(minimumLeft, Math.min(maximumLeft, requestedLeft));
    const top = Math.max(minimumTop, Math.min(maximumTop, requestedTop));
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
    dictionaryManualPosition = { left, top };
  }

  function makeDictionaryCardDraggable(card, handle) {
    let drag = null;
    const finishDrag = (event) => {
      if (!drag || (event?.pointerId != null && event.pointerId !== drag.pointerId)) return;
      try { handle.releasePointerCapture?.(drag.pointerId); } catch (_error) { /* Pointer capture may already be released. */ }
      drag = null;
      card.classList.remove("is-dragging");
    };
    const onPointerDown = (event) => {
      if (event.button != null && event.button !== 0) return;
      const bounds = card.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        originX: event.clientX,
        originY: event.clientY,
        left: bounds.left,
        top: bounds.top
      };
      dictionaryManualPosition = { left: bounds.left, top: bounds.top };
      card.dataset.caManuallyPositioned = "true";
      card.classList.add("is-dragging");
      handle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    };
    const onPointerMove = (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      moveDictionaryCard(card, drag.left + event.clientX - drag.originX, drag.top + event.clientY - drag.originY);
      event.preventDefault();
    };
    const onKeyDown = (event) => {
      const distance = event.shiftKey ? 5 : 20;
      const movement = {
        ArrowLeft: [-distance, 0],
        ArrowRight: [distance, 0],
        ArrowUp: [0, -distance],
        ArrowDown: [0, distance]
      }[event.key];
      if (!movement) return;
      const bounds = card.getBoundingClientRect();
      card.dataset.caManuallyPositioned = "true";
      moveDictionaryCard(card, bounds.left + movement[0], bounds.top + movement[1]);
      event.preventDefault();
    };
    const onViewportChange = () => {
      if (card.dataset.caManuallyPositioned === "true" && dictionaryManualPosition) {
        moveDictionaryCard(card, dictionaryManualPosition.left, dictionaryManualPosition.top);
      } else {
        positionCard(card, activeDictionaryRequest?.anchor);
      }
    };
    handle.addEventListener("pointerdown", onPointerDown);
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", finishDrag);
    handle.addEventListener("pointercancel", finishDrag);
    handle.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onViewportChange);
    window.visualViewport?.addEventListener("resize", onViewportChange);
    window.visualViewport?.addEventListener("scroll", onViewportChange);
    return () => {
      finishDrag();
      handle.removeEventListener("pointerdown", onPointerDown);
      handle.removeEventListener("pointermove", onPointerMove);
      handle.removeEventListener("pointerup", finishDrag);
      handle.removeEventListener("pointercancel", finishDrag);
      handle.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onViewportChange);
      window.visualViewport?.removeEventListener("resize", onViewportChange);
      window.visualViewport?.removeEventListener("scroll", onViewportChange);
    };
  }

  function positionCard(card, anchor) {
    if (dictionaryPositionFrame) cancelAnimationFrame(dictionaryPositionFrame);
    dictionaryPositionFrame = requestAnimationFrame(() => {
      dictionaryPositionFrame = 0;
      if (!card.isConnected) return;
      const viewport = dictionaryViewport();
      const viewportLeft = viewport.left;
      const viewportTop = viewport.top;
      const viewportWidth = viewport.right - viewport.left;
      const viewportHeight = viewport.height;
      const viewportRight = viewport.right;
      const viewportBottom = viewport.bottom;
      const maxHeight = Math.min(560, Math.max(120, viewportHeight - 24));
      card.style.maxHeight = String(maxHeight) + "px";
      if (card.dataset.caManuallyPositioned === "true" && dictionaryManualPosition) {
        moveDictionaryCard(card, dictionaryManualPosition.left, dictionaryManualPosition.top);
        return;
      }
      const rect = anchor?.getBoundingClientRect?.() || {
        left: viewportLeft + viewportWidth / 2,
        right: viewportLeft + viewportWidth / 2,
        top: viewportTop + viewportHeight / 2,
        bottom: viewportTop + viewportHeight / 2,
        width: 0
      };
      const bounds = card.getBoundingClientRect();
      const width = bounds.width || 390;
      const height = bounds.height || 300;
      const left = Math.max(viewportLeft + 12, Math.min(viewportRight - width - 12, rect.left + (rect.width || 0) / 2 - width / 2));
      const below = rect.bottom + 10;
      const above = rect.top - height - 10;
      const top = below + height <= viewportBottom - 12
        ? below
        : above >= viewportTop + 12
          ? above
          : viewportTop + 12;
      card.style.left = String(left) + "px";
      card.style.top = String(top) + "px";
    });
  }

  function trackDictionaryCard(card, anchor) {
    if (typeof ResizeObserver !== "function") return;
    dictionaryResizeObserver = new ResizeObserver(() => positionCard(card, anchor));
    dictionaryResizeObserver.observe(card);
  }
  function addRow(container, label, content) {
    if (!content || (Array.isArray(content) && !content.length)) return;
    const row = el("div", "row");
    row.append(el("span", "label", label));
    const value = el("div", "value");
    if (content instanceof Node) value.append(content);
    else value.textContent = String(content);
    row.append(value);
    container.append(row);
  }

  function defaultDictionarySpeechLanguage() {
    if (settings.primaryLayer === "pinyin") return "mandarin";
    if (settings.primaryLayer === "english") return "english";
    return "cantonese";
  }

  function dictionarySpeech(entry, language) {
    if (language === "mandarin") {
      return { label: "Mandarin", text: entry.headword, lang: "zh-CN", voiceName: settings.pinyinVoice };
    }
    if (language === "english") {
      return { label: "English", text: (entry.senses || []).join(". "), lang: "en-US", voiceName: settings.englishVoice };
    }
    return { label: "Cantonese", text: entry.headword, lang: "zh-HK", voiceName: settings.jyutpingVoice };
  }

  async function saveDictionaryEntry(entry, request, markKnown = false, saveButton = null) {
    if (saveButton) saveButton.disabled = true;
    const response = await global.CombinedAnnotatorContent.sendMessage({
      type: "save-vocab",
      entry: {
        hanzi: entry.headword,
        simplified: entry.simplified,
        traditional: entry.traditional,
        pinyin: entry.pinyin,
        jyutping: entry.jyutping,
        definitions: entry.senses,
        hsk: entry.hsk
      },
      context: {
        sentence: request.sentence,
        sourceTitle: request.sourceTitle,
        sourceUrl: request.sourceUrl
      }
    });
    if (markKnown && response?.saved?.id) {
      await global.CombinedAnnotatorContent.sendMessage({ type: "rate-review", wordId: response.saved.id, rating: "known" });
    }
    if (saveButton) saveButton.textContent = markKnown ? "Known" : "Saved";
    return response;
  }

  function renderCustomEditor(container, entry) {
    const existing = entry.customEntries?.[0] || {};
    const editor = el("div", "editor");
    const grid = el("div", "editor-grid");
    const fields = {};
    const addField = (name, label, value, full = false, textarea = false) => {
      const wrap = el("label", `field${full ? " full" : ""}`, label);
      const input = document.createElement(textarea ? "textarea" : "input");
      input.value = value || "";
      wrap.append(input);
      grid.append(wrap);
      fields[name] = input;
    };
    addField("simplified", "Simplified", existing.simplified || entry.simplified);
    addField("traditional", "Traditional", existing.traditional || entry.traditional);
    addField("pinyin", "Pinyin", existing.pinyin || entry.pinyin);
    addField("jyutping", "Jyutping", existing.jyutping || entry.jyutping);
    addField("definitions", "Definitions — one per line", (existing.definitions || entry.senses || []).join("\n"), true, true);
    addField("note", "Notes", existing.note || "", true, true);
    addField("tags", "Tags — comma separated", (existing.tags || []).join(", "), true);
    const modeWrap = el("label", "field", "Behavior");
    const mode = document.createElement("select");
    for (const value of ["merge", "replace"]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value === "merge" ? "Merge with bundled" : "Replace bundled";
      mode.append(option);
    }
    mode.value = existing.mode || "merge";
    modeWrap.append(mode);
    grid.append(modeWrap);
    editor.append(grid);
    const save = button("Save custom entry", "action primary", async () => {
      save.disabled = true;
      await global.CombinedAnnotatorContent.sendMessage({
        type: "save-custom-entry",
        entry: {
          id: existing.id,
          headword: entry.headword,
          simplified: fields.simplified.value,
          traditional: fields.traditional.value,
          pinyin: fields.pinyin.value,
          jyutping: fields.jyutping.value,
          definitions: fields.definitions.value.split(/\r?\n/).filter(Boolean),
          note: fields.note.value,
          tags: fields.tags.value.split(/\s*[,;]\s*/).filter(Boolean),
          mode: mode.value
        }
      });
      save.textContent = "Saved";
      window.setTimeout(() => showDictionary(activeDictionaryRequest), 250);
    });
    editor.append(save);
    container.append(editor);
  }

  function renderDictionaryEntry(card, entries, index, request) {
    card.querySelector(".dictionary-content")?.remove();
    const entry = entries[index];
    if (!entry) return;
    const content = el("div", "dictionary-content");
    const scroll = el("div", "dictionary-scroll");
    const candidates = el("div", "candidate-list");
    entries.forEach((candidate, candidateIndex) => {
      candidates.append(button(candidate.headword, `candidate${candidateIndex === index ? " active" : ""}`, () => renderDictionaryEntry(card, entries, candidateIndex, request)));
    });
    scroll.append(candidates);
    const head = el("div", "word-head");
    const word = el("div");
    word.append(el("div", "hanzi", entry.headword));
    const variantText = entry.simplified === entry.traditional ? entry.simplified : `${entry.traditional} · ${entry.simplified}`;
    word.append(el("div", "variants", variantText));
    const badges = el("div", "badges");
    if (entry.hsk) badges.append(el("span", "badge", `HSK ${entry.hsk}`));
    if (entry.customEntries?.length) badges.append(el("span", "badge", "Custom"));
    word.append(badges);
    head.append(word);
    scroll.append(head);
    const rows = el("div", "rows");
    addRow(rows, "Pinyin", entry.pinyin);
    addRow(rows, "Jyutping", entry.jyutping);
    if (entry.senses?.length) {
      const list = el("ol", "senses");
      for (const sense of entry.senses) list.append(el("li", "", sense));
      addRow(rows, "Meanings", list);
    }
    if (entry.classifiers?.length) {
      addRow(rows, "Classifiers", entry.classifiers.map((item) => `${item.traditional}${item.simplified !== item.traditional ? `|${item.simplified}` : ""}${item.pinyin ? ` [${item.pinyin}]` : ""}`).join(", "));
    }
    if (entry.references?.length) {
      addRow(rows, "References", entry.references.map((item) => `${item.traditional}${item.simplified !== item.traditional ? `|${item.simplified}` : ""}${item.pinyin ? ` [${item.pinyin}]` : ""}`).join(", "));
    }
    scroll.append(rows);
    if (request.sentence) {
      const context = el("div", "context", request.sentence);
      if (request.sourceTitle) context.append(el("span", "context-source", request.sourceTitle));
      scroll.append(context);
    }
    for (const saved of (entry.savedContexts || []).slice(0, 5)) {
      if (saved.sentence === request.sentence && saved.sourceTitle === request.sourceTitle) continue;
      const context = el("div", "context", saved.sentence);
      const detail = [
        saved.sourceTitle,
        saved.savedAt ? new Date(saved.savedAt).toLocaleDateString() : ""
      ].filter(Boolean).join(" ? ");
      if (detail) context.append(el("span", "context-source", detail));
      scroll.append(context);
    }
    const actions = el("div", "actions");
    const speechControls = el("div", "dictionary-speech");
    speechControls.append(el("span", "dictionary-speech-label", "Read aloud"));
    const speechLanguage = document.createElement("select");
    speechLanguage.setAttribute("aria-label", "Dictionary speech language");
    const speechOptions = [
      ["cantonese", "Cantonese"],
      ["mandarin", "Mandarin"],
      ["english", "English definitions"]
    ];
    for (const [value, label] of speechOptions) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      speechLanguage.append(option);
    }
    speechLanguage.value = card.dataset.caSpeechLanguage || defaultDictionarySpeechLanguage();
    card.dataset.caSpeechLanguage = speechLanguage.value;
    const listen = button("", "action dictionary-listen");
    const syncDictionarySpeechControl = () => {
      const speech = dictionarySpeech(entry, speechLanguage.value);
      listen.textContent = `Listen: ${speech.label}`;
      listen.title = speech.lang === "en-US"
        ? "Read the English definitions aloud"
        : `Read the Chinese word aloud in ${speech.label}`;
      listen.setAttribute("aria-label", listen.title);
      listen.disabled = !speech.text;
    };
    speechLanguage.addEventListener("change", () => {
      card.dataset.caSpeechLanguage = speechLanguage.value;
      global.CombinedAnnotatorContent.stopSpeech();
      syncDictionarySpeechControl();
    });
    listen.addEventListener("click", () => {
      const speech = dictionarySpeech(entry, speechLanguage.value);
      if (!speech.text) return;
      global.CombinedAnnotatorContent.speakText(speech.text, speech.lang, { voiceName: speech.voiceName });
    });
    syncDictionarySpeechControl();
    speechControls.append(speechLanguage, listen);
    actions.append(speechControls);
    const save = button("Save", "action primary", () => saveDictionaryEntry(entry, request, false, save));
    actions.append(save);
    actions.append(button("Strokes", "action", () => global.CombinedAnnotatorContent.showStrokeOrder(entry.headword, "simplified")));
    actions.append(button("Mark known", "action", () => saveDictionaryEntry(entry, request, true)));
    const edit = button("Edit", "action", () => {
      if (scroll.querySelector(".editor")) scroll.querySelector(".editor").remove();
      else renderCustomEditor(scroll, entry);
    });
    actions.append(edit);
    actions.append(button("Reader", "action", () => openReader(request.sentence || entry.headword)));
    content.append(scroll, actions);
    card.append(content);
    scroll.scrollTop = 0;
  }

  async function showDictionary(payload = {}) {
    const request = payload.request || payload;
    activeDictionaryRequest = payload;
    closeDictionary();
    activeDictionaryRequest = payload;
    const root = ensureShadow();
    const card = el("section", "surface card");
    dictionaryCard = card;
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Chinese dictionary");
    const titlebar = el("div", "dictionary-titlebar");
    const dragHandle = el("div", "dictionary-drag-handle", "Drag to move");
    dragHandle.tabIndex = 0;
    dragHandle.setAttribute("role", "button");
    dragHandle.setAttribute("aria-label", "Move dictionary window. Drag, or use the arrow keys.");
    dragHandle.title = "Drag to move this dictionary window; arrow keys also move it";
    const close = button("×", "close", closeDictionary);
    close.setAttribute("aria-label", "Close dictionary");
    close.title = "Close dictionary";
    titlebar.append(dragHandle, close);
    card.append(titlebar);
    card.append(el("div", "loading", "Looking up phrase…"));
    root.append(card);
    dictionaryDragCleanup = makeDictionaryCardDraggable(card, dragHandle);
    trackDictionaryCard(card, payload.anchor);
    positionCard(card, payload.anchor);
    try {
      const response = await global.CombinedAnnotatorContent.sendMessage({ type: "dictionary-lookup", ...request });
      if (dictionaryCard !== card) return;
      card.querySelector(".loading")?.remove();
      if (!response?.entries?.length) card.append(el("div", "empty", "No dictionary entry found."));
      else renderDictionaryEntry(card, response.entries, 0, request);
      positionCard(card, payload.anchor);
    } catch (error) {
      card.querySelector(".loading").textContent = error.message || "Dictionary lookup failed";
    }
  }

  function segmentSentences(text) {
    const value = String(text || "").replace(/\s+/g, " ").trim().slice(0, 25000);
    if (!value) return [];
    let segments = [];
    if (typeof Intl.Segmenter === "function") {
      const segmenter = new Intl.Segmenter("zh", { granularity: "sentence" });
      segments = [...segmenter.segment(value)].map((item) => item.segment.trim()).filter(Boolean);
    }
    if (!segments.length) {
      segments = value.match(/[^。！？!?]+[。！？!?]?/g)?.map((item) => item.trim()).filter(Boolean) || [value];
    }
    return segments.filter((item) => Core.HAN_RE.test(item));
  }
  function focusable(container) {
    return [...container.querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])")];
  }

  function closeReader() {
    if (!readerDialog) return;
    const restore = readerDialog._restore;
    global.CombinedAnnotatorContent.stopSpeech();
    removeNode(readerDialog);
    readerDialog = null;
    document.documentElement.style.overflow = restore?.overflow || "";
    restore?.focus?.focus?.({ preventScroll: true });
    window.scrollTo(restore?.scrollX || 0, restore?.scrollY || 0);
  }

  async function openReader(sourceText = "") {
    closeDictionary();
    closeReader();
    const api = global.CombinedAnnotatorContent;
    const text = String(sourceText || api.extractSelection() || api.extractArticle()).trim().slice(0, 25000);
    const sentences = segmentSentences(text);
    if (!sentences.length) return;
    const root = ensureShadow();
    const backdrop = el("div", "surface modal-backdrop");
    const reader = el("section", "reader");
    reader.setAttribute("role", "dialog");
    reader.setAttribute("aria-modal", "true");
    reader.setAttribute("aria-label", "Focused Chinese reader");
    backdrop._restore = { focus: document.activeElement, scrollX, scrollY, overflow: document.documentElement.style.overflow };
    readerDialog = backdrop;
    document.documentElement.style.overflow = "hidden";
    const header = el("header", "reader-header");
    header.append(el("h2", "reader-title", "Focused Chinese Reader"));
    const progress = el("span", "reader-progress");
    header.append(progress, button("Close", "action", closeReader));
    reader.append(header);
    const toolbar = el("div", "reader-toolbar");
    const speechModes = {
      cantonese: { shortLabel: "Cantonese", optionLabel: "Cantonese (Jyutping voice)", lang: "zh-HK", voiceName: settings.jyutpingVoice },
      mandarin: { shortLabel: "Mandarin", optionLabel: "Mandarin (Pinyin voice)", lang: "zh-CN", voiceName: settings.pinyinVoice },
      english: { shortLabel: "English", optionLabel: "English definitions", lang: "en-US", voiceName: settings.englishVoice }
    };
    const initialSpeechLanguage = settings.primaryLayer === "pinyin"
      ? "mandarin"
      : (settings.primaryLayer === "english" ? "english" : "cantonese");
    const session = {
      showJyutping: false,
      showPinyin: false,
      showEnglish: false,
      speechLanguage: initialSpeechLanguage,
      speechRate: settings.speechRate,
      speechPitch: settings.speechPitch
    };
    for (const [key, label] of [["showJyutping", "Jyutping"], ["showPinyin", "Pinyin"], ["showEnglish", "English"]]) {
      const wrap = el("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = session[key];
      checkbox.addEventListener("change", () => {
        session[key] = checkbox.checked;
        stopReaderSpeech("ready");
        renderSentence();
      });
      wrap.append(checkbox, document.createTextNode(label));
      toolbar.append(wrap);
    }
    const speechLanguageWrap = el("label", "reader-speech-language");
    speechLanguageWrap.append(document.createTextNode("Read aloud"));
    const speechLanguageSelect = document.createElement("select");
    speechLanguageSelect.setAttribute("aria-label", "Reader speech language");
    for (const [value, mode] of Object.entries(speechModes)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = mode.optionLabel;
      speechLanguageSelect.append(option);
    }
    speechLanguageSelect.value = session.speechLanguage;
    speechLanguageSelect.addEventListener("change", () => {
      session.speechLanguage = speechLanguageSelect.value;
      stopReaderSpeech("ready");
    });
    speechLanguageWrap.append(speechLanguageSelect);
    toolbar.append(speechLanguageWrap);
    for (const [key, label, min, max] of [["speechRate", "Rate", .5, 1.75], ["speechPitch", "Pitch", .5, 1.5]]) {
      const wrap = el("label");
      wrap.append(document.createTextNode(label));
      const range = document.createElement("input");
      range.type = "range";
      range.min = String(min);
      range.max = String(max);
      range.step = "0.1";
      range.value = String(session[key]);
      range.addEventListener("input", () => { session[key] = Number(range.value); });
      wrap.append(range); toolbar.append(wrap);
    }
    let readerSpeechState = "ready";
    let readerSpeechSequence = 0;
    const speechStatus = el("span", "reader-speech-status");
    speechStatus.setAttribute("role", "status");
    speechStatus.setAttribute("aria-live", "polite");
    const play = button("", "reader-speech-play", playReaderSpeech);
    const pause = button("", "", () => {
      api.pauseSpeech();
      updateReaderSpeechControls("paused");
    });
    const resume = button("", "", () => {
      api.resumeSpeech();
      updateReaderSpeechControls("playing");
    });
    const stop = button("", "", () => stopReaderSpeech("stopped"));
    toolbar.append(play, pause, resume, stop, speechStatus);
    reader.append(toolbar);
    const body = el("main", "reader-body");
    const sentenceBox = el("div", "reader-sentence");
    body.append(sentenceBox);
    reader.append(body);
    function clearSpeechHighlight() {
      sentenceBox.classList.remove("speaking");
      sentenceBox.querySelectorAll(".speech-current").forEach((unit) => unit.classList.remove("speech-current"));
    }

    function readerEnglishSpeechText() {
      return [...sentenceBox.querySelectorAll(".ca-english")]
        .map((line) => String(line.dataset.caSpeakValue || line.textContent || "").trim())
        .filter(Boolean)
        .join("; ");
    }

    function currentReaderSpeechRequest() {
      const mode = speechModes[session.speechLanguage] || speechModes.cantonese;
      return {
        ...mode,
        text: mode.lang === "en-US" ? readerEnglishSpeechText() : sentences[index]
      };
    }

    function updateReaderSpeechControls(state = readerSpeechState, message = "") {
      readerSpeechState = state;
      const mode = speechModes[session.speechLanguage] || speechModes.cantonese;
      const active = state === "starting" || state === "playing" || state === "paused";
      play.textContent = `Play ${mode.shortLabel}`;
      pause.textContent = `Pause ${mode.shortLabel}`;
      resume.textContent = `Resume ${mode.shortLabel}`;
      stop.textContent = `Stop ${mode.shortLabel}`;
      play.disabled = active;
      pause.disabled = state !== "playing";
      resume.disabled = state !== "paused";
      stop.disabled = !active;
      speechStatus.textContent = message || ({
        ready: `Ready: ${mode.shortLabel}`,
        starting: `Starting: ${mode.shortLabel}`,
        playing: `Playing: ${mode.shortLabel}`,
        paused: `Paused: ${mode.shortLabel}`,
        stopped: `Stopped: ${mode.shortLabel}`,
        error: `Could not play: ${mode.shortLabel}`
      }[state] || `Ready: ${mode.shortLabel}`);
    }

    function stopReaderSpeech(nextState = "stopped") {
      readerSpeechSequence += 1;
      api.stopSpeech();
      clearSpeechHighlight();
      updateReaderSpeechControls(nextState);
    }

    function playReaderSpeech() {
      const request = currentReaderSpeechRequest();
      if (!request.text) {
        updateReaderSpeechControls("error", "No English definitions are available for this sentence.");
        return;
      }
      const sequence = ++readerSpeechSequence;
      updateReaderSpeechControls("starting");
      sentenceBox.classList.add("speaking");
      Promise.resolve(api.speakText(request.text, request.lang, {
        rate: session.speechRate,
        pitch: session.speechPitch,
        voiceName: request.voiceName,
        onStart: () => {
          if (sequence !== readerSpeechSequence) return;
          beginSpeechHighlight();
          updateReaderSpeechControls("playing");
        },
        onBoundary: request.lang === "en-US" ? undefined : ({ charIndex }) => highlightBoundary(charIndex),
        onEnd: () => {
          if (sequence !== readerSpeechSequence) return;
          clearSpeechHighlight();
          updateReaderSpeechControls("ready");
        },
        onError: (error) => {
          if (sequence !== readerSpeechSequence) return;
          clearSpeechHighlight();
          updateReaderSpeechControls("error", `Could not play ${request.shortLabel}: ${error || "Unknown speech error"}`);
        }
      })).catch((error) => {
        if (sequence !== readerSpeechSequence) return;
        clearSpeechHighlight();
        updateReaderSpeechControls("error", `Could not play ${request.shortLabel}: ${error?.message || String(error)}`);
      });
    }

    function beginSpeechHighlight() {
      sentenceBox.querySelectorAll(".speech-current").forEach((unit) => unit.classList.remove("speech-current"));
      sentenceBox.classList.add("speaking");
    }

    function highlightBoundary(charIndex) {
      sentenceBox.querySelectorAll(".speech-current").forEach((unit) => unit.classList.remove("speech-current"));
      const sentence = sentences[index];
      let searchFrom = 0;
      for (const unit of sentenceBox.querySelectorAll(".ca-unit")) {
        const value = unit.dataset.caOriginal || unit.textContent || "";
        const start = sentence.indexOf(value, searchFrom);
        if (start < 0) continue;
        const end = start + value.length;
        if (charIndex >= start && charIndex < end) {
          unit.classList.add("speech-current");
          break;
        }
        searchFrom = end;
      }
    }

    const footer = el("footer", "reader-footer");
    const previous = button("← Previous", "", () => { if (index > 0) { stopReaderSpeech("ready"); index--; renderSentence(); } });
    const next = button("Next →", "", () => { if (index < sentences.length - 1) { stopReaderSpeech("ready"); index++; renderSentence(); } });
    footer.append(previous, button("Look up sentence", "", () => showDictionary({ request: { headword: Array.from(sentences[index]).find((char) => Core.HAN_RE.test(char)) || "", sentence: sentences[index], sourceTitle: document.title, sourceUrl: location.href } })), next);
    reader.append(footer);
    backdrop.append(reader);
    root.append(backdrop);
    let index = 0;
    async function renderSentence() {
      progress.textContent = `${index + 1} of ${sentences.length}`;
      previous.disabled = index === 0;
      next.disabled = index === sentences.length - 1;
      sentenceBox.className = `reader-sentence${session.showJyutping ? " show-jyutping" : ""}${session.showPinyin ? " show-pinyin" : ""}${session.showEnglish ? " show-english" : ""}`;
      sentenceBox.textContent = "Annotating…";
      const fragment = await api.annotatePlainText(sentences[index], session);
      if (!readerDialog || !sentenceBox.isConnected) return;
      sentenceBox.textContent = "";
      sentenceBox.append(fragment);
    }
    sentenceBox.addEventListener("click", (event) => {
      const unit = event.target.closest?.(".ca-unit");
      if (!unit) return;
      showDictionary({ anchor: event.target, request: { headword: unit.dataset.caOriginal, text: sentences[index], offset: sentences[index].indexOf(unit.dataset.caOriginal), sentence: sentences[index], sourceTitle: document.title, sourceUrl: location.href } });
    });
    backdrop.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); closeReader(); return; }
      if (event.key !== "Tab") return;
      const items = focusable(backdrop);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = backdrop.getRootNode()?.activeElement || document.activeElement;
      if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    });
    updateReaderSpeechControls("ready");
    await renderSentence();
    focusable(backdrop)[0]?.focus();
  }

  function updateSettings(next) {
    settings = Core.normalizeSettings(next);
    syncHostAnnotationPalette();
  }


  const api = {
    init({ settings: next } = {}) {
      updateSettings(next || settings);
      if (!this._listenersSetup) {
        this._listenersSetup = true;
        document.addEventListener("mouseover", function (e) {
          const unit = e.target.closest?.(".ca-unit");
          if (unit) hoveredUnit = unit;
        });
        document.addEventListener("mouseout", function (e) {
          const unit = e.target.closest?.(".ca-unit");
          if (unit && hoveredUnit === unit) hoveredUnit = null;
        });
        document.addEventListener("keydown", function (e) {
          if (e.key !== "Enter" && e.key !== " ") return;
          const unit = hoveredUnit || (document.activeElement?.closest?.(".ca-unit") || null);
          if (!unit) return;
          e.preventDefault();
          const parent = unit.closest(".reader-sentence");
          const sentence = parent ? parent.textContent || "" : "";
          showDictionary({ anchor: unit, request: { headword: unit.dataset.caOriginal, text: sentence, sentence: sentence, sourceTitle: document.title, sourceUrl: location.href } });
        });
        document.addEventListener("touchstart", function (e) {
          const unit = e.target.closest?.(".ca-unit");
          if (!unit) return;
          longPressTimer = window.setTimeout(function () {
            longPressTimer = null;
            const parent = unit.closest(".reader-sentence");
            const sentence = parent ? parent.textContent || "" : "";
            showDictionary({ anchor: unit, request: { headword: unit.dataset.caOriginal, text: sentence, sentence: sentence, sourceTitle: document.title, sourceUrl: location.href } });
          }, 500);
        }, { passive: true });
        document.addEventListener("touchend", function () {
          if (longPressTimer) { window.clearTimeout(longPressTimer); longPressTimer = null; }
        });
        document.addEventListener("touchmove", function () {
          if (longPressTimer) { window.clearTimeout(longPressTimer); longPressTimer = null; }
        });
        document.addEventListener("pointerdown", function (event) {
          if (!selectionTools || selectionTools.hidden) return;
          if (event.composedPath?.().includes(selectionTools)) return;
          closeSelectionToolsMenu();
        }, true);
        window.addEventListener("blur", closeSelectionToolsMenu);
      }
    },
    updateSettings,
    showDictionary,
    closeDictionary,
    showSelectionTools,
    hideSelectionTools,
    getSelectionToolsDiagnostics,
    openReader,
    closeReader,
    setPeekActive() {}
  };
  global.CombinedAnnotatorUI = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
