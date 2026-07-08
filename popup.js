const hasBrowserApi = typeof browser !== "undefined";
const ext = hasBrowserApi ? browser : chrome;

const annotationCheckboxIds = ["showJyutping", "showPinyin", "showEnglish"];
const optionCheckboxIds = ["enableEnglishColoring", "enablePinyinToneColoring", "enableJyutpingToneColoring"];
const behaviorCheckboxIds = ["hoverOnly", "showHsk"];
const checkboxIds = [...annotationCheckboxIds, ...optionCheckboxIds, ...behaviorCheckboxIds];
const colorIds = [
  "englishColor", "uiAccent",
  "pinyinTone1Color", "pinyinTone2Color", "pinyinTone3Color", "pinyinTone4Color", "pinyinTone5Color",
  "jyutpingTone1Color", "jyutpingTone2Color", "jyutpingTone3Color", "jyutpingTone4Color", "jyutpingTone5Color", "jyutpingTone6Color"
];
const voiceIds = ["jyutpingVoice", "pinyinVoice", "englishVoice"];
const selectIds = ["copyFormat", "uiTheme"];
const settingIds = [...checkboxIds, ...colorIds, ...voiceIds, ...selectIds];
const statusNode = document.getElementById("status");

const paletteColors = [
  "#075985",
  "#0f766e",
  "#166534",
  "#7c2d12",
  "#b45309",
  "#be123c",
  "#7e22ce",
  "#374151",
  "#111827"
];

function resolveTheme(uiTheme) {
  if (uiTheme === "light" || uiTheme === "dark") return uiTheme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyAppearance(settings = {}) {
  document.documentElement.dataset.theme = resolveTheme(settings.uiTheme || "auto");
  document.documentElement.style.setProperty("--accent", settings.uiAccent || "#0f766e");
}

let systemThemeWatched = false;
function watchSystemTheme() {
  if (systemThemeWatched) return;
  systemThemeWatched = true;
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if ((document.getElementById("uiTheme")?.value || "auto") === "auto") {
      applyAppearance(readFormSettings());
    }
  });
}

function sendMessage(message) {
  if (hasBrowserApi) return ext.runtime.sendMessage(message);

  return new Promise((resolve, reject) => {
    ext.runtime.sendMessage(message, (response) => {
      const error = ext.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

function queryActiveTab() {
  if (hasBrowserApi) return ext.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0]);

  return new Promise((resolve) => {
    ext.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0]));
  });
}

function sendTabMessage(tabId, message) {
  if (hasBrowserApi) return ext.tabs.sendMessage(tabId, message).catch(() => undefined);

  return new Promise((resolve) => {
    ext.tabs.sendMessage(tabId, message, (response) => resolve(response));
  });
}

function readFormSettings() {
  return Object.fromEntries(
    settingIds.map((id) => {
      const element = document.getElementById(id);
      return [id, element.type === "checkbox" ? element.checked : element.value];
    })
  );
}

function writeFormSettings(settings) {
  for (const id of checkboxIds) {
    document.getElementById(id).checked = Boolean(settings[id]);
  }
  for (const id of colorIds) {
    document.getElementById(id).value = settings[id];
  }
  for (const id of voiceIds) {
    document.getElementById(id).dataset.savedValue = settings[id] || "";
    document.getElementById(id).value = settings[id] || "";
  }
  for (const id of selectIds) {
    document.getElementById(id).value = settings[id] || "smart";
  }
}

async function sendActiveTabAction(type, action) {
  const tab = await queryActiveTab();
  if (!tab?.id) {
    statusNode.textContent = "No active tab found";
    return;
  }
  const response = await sendTabMessage(tab.id, { type, action });
  if (!response?.ok) {
    statusNode.textContent = "Could not reach this page";
    return;
  }
  statusNode.textContent = typeof response.changed === "number"
    ? `Converted ${response.changed} text nodes`
    : "Page conversion sent";
}
async function notifyActiveTab(type, settings) {
  const tab = await queryActiveTab();
  if (!tab?.id) return undefined;
  return sendTabMessage(tab.id, { type, settings });
}

async function saveSettings() {
  const settings = readFormSettings();
  applyAppearance(settings); // instant visual feedback for theme/accent changes
  const saved = await sendMessage({ type: "set-settings", settings });
  await notifyActiveTab("settings-updated", saved);
  for (const id of voiceIds) {
    document.getElementById(id).dataset.savedValue = saved[id] || "";
  }
  statusNode.textContent = "Updated";
}

function setAllAnnotations(enabled) {
  for (const id of annotationCheckboxIds) {
    document.getElementById(id).checked = enabled;
  }
  return saveSettings();
}

function buildPalettes() {
  document.querySelectorAll(".palette").forEach((palette) => {
    const targetId = palette.dataset.target;
    for (const color of paletteColors) {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "swatch";
      swatch.style.backgroundColor = color;
      swatch.title = color;
      swatch.setAttribute("aria-label", `Set ${targetId} to ${color}`);
      swatch.addEventListener("click", async () => {
        document.getElementById(targetId).value = color;
        await saveSettings();
      });
      palette.appendChild(swatch);
    }
  });
}

function formatVoice(voice) {
  const label = [voice.name, voice.lang].filter(Boolean).join(" - ");
  return voice.default ? `${label} (default)` : label;
}

function voiceMatches(selectId, voice) {
  const lang = (voice.lang || "").toLowerCase();
  if (selectId === "englishVoice") return lang.startsWith("en");
  if (selectId === "pinyinVoice") return lang.startsWith("zh") || lang.startsWith("cmn");
  return lang.startsWith("yue") || lang.includes("hk") || lang.includes("mo") || lang.startsWith("zh");
}

function populateVoiceSelects(voices = []) {
  for (const id of voiceIds) {
    const select = document.getElementById(id);
    const savedValue = select.dataset.savedValue || select.value || "";
    select.textContent = "";

    const automatic = document.createElement("option");
    automatic.value = "";
    automatic.textContent = "Automatic";
    select.appendChild(automatic);

    const sortedVoices = [...voices].sort((a, b) => {
      const aMatch = voiceMatches(id, a) ? 0 : 1;
      const bMatch = voiceMatches(id, b) ? 0 : 1;
      return aMatch - bMatch || formatVoice(a).localeCompare(formatVoice(b));
    });

    for (const voice of sortedVoices) {
      const option = document.createElement("option");
      option.value = voice.name || "";
      option.textContent = formatVoice(voice);
      select.appendChild(option);
    }

    select.disabled = voices.length === 0;
    select.value = savedValue;
    if (select.value !== savedValue) select.value = "";
  }
}

function updateDiagnostics(detail = {}) {
  if (Array.isArray(detail.voices)) populateVoiceSelects(detail.voices);
}

function renderCoverage(detail = {}) {
  const output = document.getElementById("coverageOutput");
  if (!output) return;
  if (!detail || !detail.ok) {
    output.textContent = "No coverage data from this page.";
    return;
  }

  const skipped = Object.entries(detail.skippedByReason || {})
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(", ") || "none";
  const samples = Array.isArray(detail.samples) && detail.samples.length
    ? detail.samples.map((sample) => `- ${sample}`).join("\n")
    : "none";

  output.textContent = [
    `Visible Chinese text nodes: ${detail.visibleChineseTextNodes ?? 0}`,
    `Annotated units: ${detail.annotatedUnits ?? 0}`,
    `Raw visible nodes: ${detail.rawVisible ?? 0}`,
    `Valid raw nodes: ${detail.validRawVisible ?? 0}`,
    `Queued: ${detail.queued ?? 0} | Scan queue: ${detail.scanQueue ?? 0}`,
    `Cache entries: ${detail.cacheEntries ?? 0}`,
    `Skipped: ${skipped}`,
    "Missed samples:",
    samples
  ].join("\n");
}
async function runSpeechTest(label) {
  statusNode.textContent = `Testing ${label} speech`;
  const tab = await queryActiveTab();
  if (!tab?.id) return;
  const response = await sendTabMessage(tab.id, { type: "speech-test", label, settings: readFormSettings() });
  if (response?.detail) updateDiagnostics(response.detail);
}

async function loadSpeechDiagnostics() {
  const tab = await queryActiveTab();
  if (!tab?.id) return;
  const response = await sendTabMessage(tab.id, { type: "speech-diagnostics" });
  if (response?.detail) updateDiagnostics(response.detail);
}

function installRuntimeListener() {
  ext.runtime.onMessage.addListener((message) => {
    if (message?.type === "speech-state") updateDiagnostics(message.detail);
  });
}

async function loadVocab() {
  const response = await sendMessage({ type: "get-vocab" });
  renderVocab(response?.entries || []);
}

function renderVocab(entries) {
  const list = document.getElementById("vocabList");
  if (!list) return;
  list.textContent = "";

  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "vocab-empty";
    empty.textContent = "No saved words yet. Click a character on a page, then “☆ Save”.";
    list.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "vocab-item";

    const info = document.createElement("div");
    info.className = "vocab-info";
    const hanzi = document.createElement("span");
    hanzi.className = "vocab-hanzi";
    hanzi.textContent = entry.hanzi;
    const meta = document.createElement("span");
    meta.className = "vocab-meta";
    const reading = [entry.pinyin, entry.jyutping].filter(Boolean).join(" · ");
    meta.textContent = [reading, entry.english].filter(Boolean).join(" — ");
    info.append(hanzi, meta);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "vocab-remove";
    remove.textContent = "×";
    remove.title = "Remove";
    remove.addEventListener("click", async () => {
      const response = await sendMessage({ type: "remove-vocab", hanzi: entry.hanzi });
      renderVocab(response?.entries || []);
    });

    row.append(info, remove);
    list.appendChild(row);
  }
}

function toAnkiField(value) {
  return String(value || "").replace(/[\t\r\n]+/g, " ").trim();
}

async function exportAnki() {
  const response = await sendMessage({ type: "get-vocab" });
  const entries = response?.entries || [];
  if (!entries.length) {
    statusNode.textContent = "No saved words to export";
    return;
  }
  // One card per word: front = characters, back = readings + English.
  const lines = entries.map((entry) => {
    const readings = [entry.pinyin, entry.jyutping].filter(Boolean).join(" / ");
    const back = [readings, entry.fullEnglish || entry.english].filter(Boolean).join(" — ");
    return `${toAnkiField(entry.hanzi)}\t${toAnkiField(back)}`;
  });
  const blob = new Blob([lines.join("\n")], { type: "text/tab-separated-values;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "combined-annotator-anki.txt";
  a.click();
  URL.revokeObjectURL(url);
  statusNode.textContent = `Exported ${entries.length} words`;
}

function installTabs() {
  const tabs = Array.from(document.querySelectorAll(".tab"));
  const panels = Array.from(document.querySelectorAll(".tab-panel"));

  function activateTab(target) {
    const tab = typeof target === "string" ? tabs.find((t) => t.dataset.tab === target) : target;
    if (!tab) return;
    const name = tab.dataset.tab;
    tabs.forEach((t) => t.classList.toggle("is-active", t === tab));
    panels.forEach((p) => p.classList.toggle("is-active", p.dataset.panel === name));
    tab.focus({ preventScroll: true });
  }

  function switchTabBy(direction) {
    const activeIndex = tabs.findIndex((t) => t.classList.contains("is-active"));
    const nextIndex = (activeIndex + direction + tabs.length) % tabs.length;
    activateTab(tabs[nextIndex]);
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => activateTab(tab));
  }

  // Keyboard support for cycling tabs.
  document.querySelector(".tabs").addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      switchTabBy(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      switchTabBy(-1);
    }
  });
}

async function init() {
  installTabs();
  buildPalettes();
  installRuntimeListener();
  populateVoiceSelects([]);

  const settings = await sendMessage({ type: "get-settings" });
  writeFormSettings(settings);
  applyAppearance(settings);
  watchSystemTheme();

  // Load available TTS voices from the active page.
  await loadSpeechDiagnostics().catch(() => undefined);

  for (const id of settingIds) {
    document.getElementById(id).addEventListener("change", saveSettings);
  }

  document.getElementById("selectAll").addEventListener("click", () => setAllAnnotations(true));
  document.getElementById("selectNone").addEventListener("click", () => setAllAnnotations(false));
  document.getElementById("popupClose")?.addEventListener("click", () => window.close());

  document.querySelectorAll("[data-speech-label]").forEach((button) => {
    button.addEventListener("click", () => runSpeechTest(button.dataset.speechLabel));
  });

  document.getElementById("convert-page-traditional")?.addEventListener("click", () => sendActiveTabAction("page-conversion-action", "page-traditional"));
  document.getElementById("convert-page-simplified")?.addEventListener("click", () => sendActiveTabAction("page-conversion-action", "page-simplified"));
  document.getElementById("convert-page-original")?.addEventListener("click", () => sendActiveTabAction("page-conversion-action", "page-original"));

  document.getElementById("refreshVisible").addEventListener("click", async () => {
    const response = await notifyActiveTab("refresh-visible", readFormSettings());
    renderCoverage(response?.detail);
    statusNode.textContent = "Re-annotating visible content";
  });

  document.getElementById("inspectCoverage")?.addEventListener("click", async () => {
    const response = await notifyActiveTab("annotation-coverage", readFormSettings());
    renderCoverage(response?.detail);
    statusNode.textContent = response?.ok ? "Coverage checked" : "Could not inspect this page";
  });

  // Export Settings
  document.getElementById("export-settings")?.addEventListener("click", async () => {
    const allSettings = await ext.storage.local.get(null);
    const blob = new Blob([JSON.stringify(allSettings, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "combined-annotator-settings.json";
    a.click();
    URL.revokeObjectURL(url);
    statusNode.textContent = "Settings exported";
  });

  // Import Settings
  const fileInput = document.getElementById("import-settings-file");
  document.getElementById("import-settings")?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const imported = JSON.parse(event.target.result);
        if (!imported || typeof imported !== "object" || Array.isArray(imported)) {
          throw new Error("Not a settings object");
        }
        // Route through set-settings so only recognized, validated fields are
        // stored (colors, voices, toggles) — arbitrary keys are discarded.
        const saved = await sendMessage({ type: "set-settings", settings: imported });
        // Preserve the per-site disable list separately, validated to strings.
        if (Array.isArray(imported.disabledSites)) {
          const disabledSites = imported.disabledSites.filter((entry) => typeof entry === "string");
          await ext.storage.local.set({ disabledSites });
        }
        writeFormSettings(saved);
        statusNode.textContent = "Settings imported";
        await notifyActiveTab("settings-updated", saved);
      } catch (err) {
        statusNode.textContent = "Failed to import settings";
      }
    };
    reader.readAsText(file);
    e.target.value = ""; // reset
  });

  // Export Vocabulary to CSV
  document.getElementById("export-vocabulary")?.addEventListener("click", () => {
    sendActiveTabAction("export-csv");
  });

  // Saved words (flashcards)
  loadVocab();
  document.getElementById("export-anki")?.addEventListener("click", exportAnki);
  document.getElementById("clear-vocab")?.addEventListener("click", async () => {
    const response = await sendMessage({ type: "clear-vocab" });
    renderVocab(response?.entries || []);
    statusNode.textContent = "Saved words cleared";
  });

  // Disable on this site
  const disableCheck = document.getElementById("disableOnSite");
  if (disableCheck) {
    const tab = await queryActiveTab();
    if (tab && tab.url) {
      try {
        const hostname = new URL(tab.url).hostname;
        const storage = await ext.storage.local.get("disabledSites");
        const disabledSites = storage.disabledSites || [];
        disableCheck.checked = disabledSites.includes(hostname);

        disableCheck.addEventListener("change", async (e) => {
          const currentStorage = await ext.storage.local.get("disabledSites");
          let currentList = currentStorage.disabledSites || [];
          if (e.target.checked) {
            if (!currentList.includes(hostname)) currentList.push(hostname);
          } else {
            currentList = currentList.filter(s => s !== hostname);
          }
          await ext.storage.local.set({ disabledSites: currentList });
          // Apply the change to the open page immediately instead of on reload.
          await sendTabMessage(tab.id, { type: "site-disabled-changed", disabled: e.target.checked });
          statusNode.textContent = e.target.checked ? `Disabled on ${hostname}` : `Enabled on ${hostname}`;
        });
      } catch (e) {
        disableCheck.disabled = true;
      }
    }
  }

}

init().catch((error) => {
  statusNode.textContent = error.message || String(error);
});