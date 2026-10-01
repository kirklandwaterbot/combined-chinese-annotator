(function initPopup() {
  "use strict";
  const hasBrowser = typeof browser !== "undefined";
  const ext = hasBrowser ? browser : chrome;
  const Core = globalThis.CombinedAnnotatorCore;
  const status = document.getElementById("status");
  const checkboxIds = ["showJyutping","showPinyin","showEnglish","showHsk","hoverOnly","protectCompactUi","saveSourceUrl","enableEnglishColoring","enablePinyinToneColoring","enableJyutpingToneColoring","clipboardEditorSupport"];
  const annotationLayerIds = ["showJyutping","showPinyin","showEnglish"];

  const selectIds = ["layoutMode","primaryLayer","annotationSpacing","peekKey","uiTheme","copyFormat","speechBackend"];
  const rangeIds = ["annotationScale","speechRate","speechPitch"];
  const voiceIds = ["englishVoice","pinyinVoice","jyutpingVoice"];
  const shortcutIds = ["readAloudCantoneseShortcut","readAloudMandarinShortcut","readAloudEnglishShortcut"];
  const colorIds = ["uiAccent","englishColor","pinyinTone1Color","pinyinTone2Color","pinyinTone3Color","pinyinTone4Color","pinyinTone5Color","jyutpingTone1Color","jyutpingTone2Color","jyutpingTone3Color","jyutpingTone4Color","jyutpingTone5Color","jyutpingTone6Color"];
  const PROFILE_OVERRIDE_KEYS = ["showJyutping","showPinyin","showEnglish","showHsk","hoverOnly","layoutMode","primaryLayer","languageMode"];
  let activeTab = null;
  let hostname = "";
  let settings = Core.normalizeSettings();
  let currentProfile = null;
  let reviewQueue = [];
  let reviewIndex = 0;
  let reviewFlipped = false;
  let saveGeneration = 0;
  let saveQueue = Promise.resolve();
  let lastCheckedIndex = -1;
  let healthTimer = 0;
  let progressTimer = 0;
  let azureSpeechConfig = { configured: false, region: "eastus" };
  let ttsDiagnosticText = "";
  let extensionDiagnosticText = "";
  let popupTestAudioUrl = "";
  let popupTestRequest = null;
  let browserVoiceAvailabilityMessage = "Automatic prefers Microsoft Jenny for English and Microsoft Xiaoxiao for Mainland Mandarin when the browser makes those natural voices available.";
  const panelLoads = new Map();

  function message(payload) {
    if (hasBrowser) return ext.runtime.sendMessage(payload).then((result) => {
      if (result && result.error) throw new Error(result.error);
      return result;
    });
    return new Promise((resolve, reject) => ext.runtime.sendMessage(payload, (result) => {
      const error = ext.runtime.lastError;
      if (error) reject(new Error(error.message));
      else if (result && result.error) reject(new Error(result.error));
      else resolve(result);
    }));
  }
  function permissionOperation(method, descriptor) {
    if (typeof ext.permissions?.[method] !== "function") return Promise.resolve(false);
    if (hasBrowser) return ext.permissions[method](descriptor);
    return new Promise((resolve, reject) => ext.permissions[method](descriptor, (result) => {
      const error = ext.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(Boolean(result));
    }));
  }
  function queryTab() {
    if (hasBrowser) return ext.tabs.query({active:true,currentWindow:true}).then((tabs) => tabs[0]);
    return new Promise((resolve) => ext.tabs.query({active:true,currentWindow:true}, (tabs) => resolve(tabs[0])));
  }
  function tabMessage(payload) {
    if (!activeTab?.id) return Promise.resolve(null);
    return message({
      type:"send-tab-message-with-recovery",
      tabId:activeTab.id,
      frameId:0,
      payload
    }).catch(() => null);
  }
  function setStatus(text) { status.textContent = text; }
  function el(id) { return document.getElementById(id); }
  function allAnnotationLayersSelected() { return annotationLayerIds.every((id) => el(id).checked); }
  function ensureAllSelectedLayersAreVisible() {
    if (!allAnnotationLayersSelected()) return false;
    el("layoutMode").value = "full";
    return true;
  }
  function handleSettingChange(event) {
    if (annotationLayerIds.includes(event.currentTarget?.id)) ensureAllSelectedLayersAreVisible();
    saveSettings();
  }
  function installSpeechShortcutEditors() {
    const labels = {
      readAloudCantoneseShortcut: "Cantonese",
      readAloudMandarinShortcut: "Mandarin",
      readAloudEnglishShortcut: "English"
    };
    shortcutIds.forEach((id) => {
      const input = el(id);
      input.addEventListener("focus", () => {
        input.classList.add("is-recording");
        input.select();
        setStatus(`Press a new ${labels[id]} shortcut`);
      });
      input.addEventListener("blur", () => input.classList.remove("is-recording"));
      input.addEventListener("keydown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") {
          input.blur();
          setStatus("Shortcut unchanged");
          return;
        }
        const shortcut = Core.shortcutFromEvent(event);
        if (!shortcut) {
          if (!["Control", "Alt", "Shift", "Meta", "AltGraph"].includes(event.key)) {
            setStatus("Use Ctrl, Alt, or Meta plus a letter, number, function key, Enter, Space, or Backslash");
          }
          return;
        }
        const conflict = shortcutIds.find((otherId) => otherId !== id && el(otherId).value === shortcut);
        shortcutIds.forEach((shortcutId) => el(shortcutId).classList.remove("has-conflict"));
        if (conflict) {
          input.classList.add("has-conflict");
          el(conflict).classList.add("has-conflict");
          setStatus(`${shortcut} is already assigned to ${labels[conflict]}`);
          return;
        }
        input.value = shortcut;
        input.classList.remove("has-conflict");
        input.blur();
        setStatus(`${labels[id]} shortcut changed to ${shortcut}`);
        saveSettings();
      });
    });
    el("resetSpeechShortcuts").addEventListener("click", () => {
      shortcutIds.forEach((id) => {
        el(id).value = Core.DEFAULT_SETTINGS[id];
        el(id).classList.remove("has-conflict");
      });
      setStatus("Read-aloud shortcuts reset to defaults");
      saveSettings();
    });
  }
  function escapeField(value) { return String(value || "").replace(/[\t\r\n]+/g, " ").trim(); }
  function download(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], {type}));
    const link = document.createElement("a"); link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function applyTheme(theme = settings.uiTheme) {
    const resolved = theme === "auto" ? (matchMedia("(prefers-color-scheme:dark)").matches ? "dark" : "light") : theme;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.setProperty("--accent", settings.uiAccent || "#0f766e");
  }
  function updateOutputs() {
    el("annotationScaleValue").value = `${el("annotationScale").value}%`;
    el("speechRateValue").value = `${Number(el("speechRate").value).toFixed(1)}×`;
    el("speechPitchValue").value = Number(el("speechPitch").value).toFixed(1);
  }
  function readSettings() {
    const next = {};
    checkboxIds.forEach((id) => next[id] = el(id).checked);
    selectIds.forEach((id) => next[id] = el(id).value);
    rangeIds.forEach((id) => next[id] = Number(el(id).value));
    voiceIds.forEach((id) => next[id] = el(id).value);
    shortcutIds.forEach((id) => next[id] = el(id).value);
    colorIds.forEach((id) => next[id] = el(id).value);
    return Core.normalizeSettings({...settings,...next});
  }
  function writeSettings(next) {
    settings = Core.normalizeSettings(next);
    checkboxIds.forEach((id) => el(id).checked = settings[id]);
    selectIds.forEach((id) => el(id).value = settings[id]);
    rangeIds.forEach((id) => { if (el(id)) el(id).value = settings[id]; });
    colorIds.forEach((id) => el(id).value = settings[id]);
    voiceIds.forEach((id) => { el(id).dataset.saved = settings[id] || ""; });
    shortcutIds.forEach((id) => { el(id).value = settings[id]; });
    updateOutputs(); applyTheme(); updateSpeechBackendUi();
  }
  let saveSettingsTimer = 0;
  let saveSettingsPending = null;
  async function saveSettings() {
    const formSettings = readSettings();
    window.clearTimeout(saveSettingsTimer);
    saveSettingsPending = formSettings;
    saveSettingsTimer = window.setTimeout(() => {
      const pending = saveSettingsPending;
      saveSettingsPending = null;
      saveQueue = saveQueue.then(() => actualSave(pending)).catch(() => { /* serialization error */ });
    }, 150);
  }
  async function actualSave(pending) {
    const gen = ++saveGeneration;
    const result = await message({type:"set-settings",settings:pending});
    if (saveGeneration !== gen) return;
    if (result && result.error) { setStatus(result.error); return; }
    settings = Core.normalizeSettings(result || pending);
    writeSettings(settings);
    await tabMessage({type:"settings-updated",settings});
    setStatus("Settings updated");
  }
  function installTabs() {
    const tabs = [...document.querySelectorAll(".tab")];
    const activateTab = (tab, focus = false) => {
      const panelName = tab.dataset.tab;
      tabs.forEach((node) => {
        const active = node === tab;
        node.classList.toggle("active", active);
        node.setAttribute("aria-selected", String(active));
        node.tabIndex = active ? 0 : -1;
      });
      document.querySelectorAll(".panel").forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === panelName));
      ensurePanelHydrated(panelName).catch((error) => setStatus(error.message || String(error)));
      if (focus) tab.focus();
      if (panelName === "settings") loadAutoBackups();
      if (panelName === "tools") { updateProgress(); progressTimer = window.setInterval(updateProgress, 1000); }
      else { window.clearInterval(progressTimer); progressTimer = 0; }
    };
    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => activateTab(tab));
      tab.addEventListener("keydown", (event) => {
        let nextIndex = null;
        if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
        if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = tabs.length - 1;
        if (nextIndex === null) return;
        event.preventDefault();
        activateTab(tabs[nextIndex], true);
      });
    });
  }
  function buildColors() {
    const labels = {uiAccent:"Accent",englishColor:"English",pinyinTone1Color:"Pinyin 1",pinyinTone2Color:"Pinyin 2",pinyinTone3Color:"Pinyin 3",pinyinTone4Color:"Pinyin 4",pinyinTone5Color:"Pinyin neutral",jyutpingTone1Color:"Jyutping 1",jyutpingTone2Color:"Jyutping 2",jyutpingTone3Color:"Jyutping 3",jyutpingTone4Color:"Jyutping 4",jyutpingTone5Color:"Jyutping 5",jyutpingTone6Color:"Jyutping 6"};
    const grid = el("colorGrid");
    colorIds.forEach((id) => { const label = document.createElement("label"); label.textContent = labels[id]; const input = document.createElement("input"); input.type="color"; input.id=id; label.append(input); grid.append(label); });
  }
  const voiceLanguages = {englishVoice:"en-US",pinyinVoice:"zh-CN",jyutpingVoice:"zh-HK"};
  const automaticVoiceLabels = {englishVoice:"Automatic — prefers Microsoft Jenny",pinyinVoice:"Automatic — prefers Microsoft Xiaoxiao",jyutpingVoice:"Automatic — best Cantonese voice"};
  function voiceLabel(voice, id) {
    const language = voiceLanguages[id] || "";
    const tags = [];
    if (Core.isNaturalSpeechVoice(voice, language)) tags.push("natural");
    if (voice.default) tags.push("default");
    return `${voice.name || "Voice"} — ${voice.lang || "unknown"}${tags.length ? ` (${tags.join(", ")})` : ""}`;
  }
  function voiceMatch(id, voice) {
    const lang=(voice.lang||"").toLowerCase();
    if(id==="englishVoice") return lang.startsWith("en");
    if(id==="pinyinVoice") return lang.startsWith("zh")||lang.startsWith("cmn");
    return lang.startsWith("yue")||lang.includes("hk")||lang.includes("mo");
  }
  function populateVoices(voices=[]) {
    voiceIds.forEach((id) => {
      const select=el(id), saved=select.dataset.saved||settings[id]||""; select.textContent="";
      const language=voiceLanguages[id];
      const automatic=document.createElement("option"); automatic.value=""; automatic.textContent=automaticVoiceLabels[id]; select.append(automatic);
      Core.rankSpeechVoices(voices,language).sort((a,b)=>Number(voiceMatch(id,b))-Number(voiceMatch(id,a))||Core.speechVoicePreferenceScore(b,language)-Core.speechVoicePreferenceScore(a,language)||voiceLabel(a,id).localeCompare(voiceLabel(b,id))).forEach((voice)=>{const option=document.createElement("option");option.value=voice.name||"";option.textContent=voiceLabel(voice,id);select.append(option);});
      select.value=saved; if(select.value!==saved) select.value="";
    });
    const preferredAvailable = voices.some((voice) => /\bjenny\b/i.test(`${voice.name || ""} ${voice.voiceURI || ""}`))
      && voices.some((voice) => /\bxiaoxiao\b/i.test(`${voice.name || ""} ${voice.voiceURI || ""}`));
    browserVoiceAvailabilityMessage = preferredAvailable
      ? "Jenny and Xiaoxiao are available. Leave the selectors on Automatic to use them, or choose either voice explicitly."
      : "Jenny and Xiaoxiao are not exposed by this browser. Microsoft Edge normally offers its online natural voices to web speech; Firefox and Chrome may show only installed system voices.";
    updateSpeechBackendUi();
  }
  function updateSpeechBackendUi(backend = el("speechBackend")?.value || settings.speechBackend) {
    const usingAzure = backend === "azure";
    el("browserVoiceSettings").hidden = usingAzure;
    el("azureSpeechSettings").hidden = !usingAzure;
    if (usingAzure) {
      el("voiceAvailability").textContent = "Azure uses the standard neural versions of Jenny, Xiaochen, and HiuGaai.";
    } else {
      el("voiceAvailability").textContent = browserVoiceAvailabilityMessage;
    }
  }
  async function loadAzureSpeechConfig() {
    azureSpeechConfig = await message({type:"get-azure-speech-config"});
    el("azureSpeechRegion").value = azureSpeechConfig.region || "eastus";
    el("azureSpeechKey").value = "";
    el("azureSpeechStatus").textContent = azureSpeechConfig.configured
      ? `Configured for ${azureSpeechConfig.region}. The key is stored locally and excluded from backups.`
      : "Azure is not configured. Paste a Speech resource key to enable it.";
    return azureSpeechConfig;
  }
  async function requestAzureDataPermission() {
    const dataPermissions = ext.runtime.getManifest()?.browser_specific_settings?.gecko?.data_collection_permissions;
    const required = dataPermissions?.required;
    if (Array.isArray(required) && ["authenticationInfo","websiteContent"].every((type) => required.includes(type))) return true;
    const optional = dataPermissions?.optional;
    if (!hasBrowser || !Array.isArray(optional) || typeof ext.permissions?.request !== "function") return true;
    try {
      return await ext.permissions.request({data_collection:["authenticationInfo","websiteContent"]});
    } catch (error) {
      setStatus(error?.message || "Firefox could not request Azure data permission");
      return false;
    }
  }
  function clipboardReadIsRequired() {
    return ext.runtime.getManifest()?.permissions?.includes("clipboardRead") === true;
  }
  async function syncClipboardCompatibilityControl() {
    const input = el("clipboardEditorSupport");
    if (!input) return false;
    let granted = false;
    try {
      granted = clipboardReadIsRequired() || await permissionOperation("contains", {permissions:["clipboardRead"]});
    } catch {
      granted = false;
    }
    input.checked = Boolean(settings.clipboardEditorSupport && granted);
    input.dataset.permissionGranted = String(granted);
    return granted;
  }
  async function handleClipboardCompatibilityChange() {
    const input = el("clipboardEditorSupport");
    input.disabled = true;
    try {
      if (input.checked) {
        const granted = clipboardReadIsRequired() || await permissionOperation("request", {permissions:["clipboardRead"]});
        if (!granted) {
          input.checked = false;
          setStatus("Clipboard permission was not granted");
          return;
        }
        input.dataset.permissionGranted = "true";
        await actualSave(readSettings());
        setStatus("Google/Office copied-text compatibility enabled");
        return;
      }
      await actualSave(readSettings());
      if (!clipboardReadIsRequired()) await permissionOperation("remove", {permissions:["clipboardRead"]}).catch(() => false);
      input.dataset.permissionGranted = String(clipboardReadIsRequired());
      setStatus("Google/Office copied-text compatibility disabled");
    } catch (error) {
      input.checked = false;
      setStatus(error?.message || "Could not change clipboard compatibility");
    } finally {
      input.disabled = false;
    }
  }
  async function handleSpeechBackendChange() {
    const requested = el("speechBackend").value;
    if (requested === "azure" && !(await requestAzureDataPermission())) {
      el("speechBackend").value = settings.speechBackend;
      updateSpeechBackendUi();
      setStatus("Azure permission was not granted");
      return;
    }
    updateSpeechBackendUi(requested);
    if (requested === "azure" && !azureSpeechConfig.configured) {
      setStatus("Enter an Azure Speech key, then choose Save & use Azure");
      return;
    }
    await actualSave(readSettings());
  }
  async function saveAzureSpeechConfig() {
    if (!(await requestAzureDataPermission())) {
      setStatus("Azure permission was not granted");
      return;
    }
    const key = el("azureSpeechKey").value.trim();
    const region = el("azureSpeechRegion").value.trim();
    azureSpeechConfig = await message({type:"set-azure-speech-config",key,region});
    el("azureSpeechKey").value = "";
    el("azureSpeechRegion").value = azureSpeechConfig.region;
    el("azureSpeechStatus").textContent = `Configured for ${azureSpeechConfig.region}. The key is stored locally and excluded from backups.`;
    el("speechBackend").value = "azure";
    updateSpeechBackendUi("azure");
    await actualSave(readSettings());
    setStatus("Azure Neural speech enabled");
  }
  async function clearAzureSpeechConfig() {
    if (!confirm("Remove the locally stored Azure Speech key?")) return;
    azureSpeechConfig = await message({type:"set-azure-speech-config",clear:true});
    el("azureSpeechKey").value = "";
    el("azureSpeechRegion").value = azureSpeechConfig.region;
    el("azureSpeechStatus").textContent = "Azure is not configured. Paste a Speech resource key to enable it.";
    if (el("speechBackend").value === "azure") {
      el("speechBackend").value = "browser";
      updateSpeechBackendUi("browser");
      await actualSave(readSettings());
    }
    setStatus("Azure Speech key removed");
  }
  async function loadTtsDiagnosticLog() {
    const result = await message({type:"get-tts-diagnostic-log"});
    const entries = Array.isArray(result?.entries) ? result.entries : [];
    ttsDiagnosticText = Core.formatTtsDiagnosticLog(entries,{
      extensionVersion:ext.runtime.getManifest()?.version || "unknown",
      browser:navigator.userAgent
    });
    const output = el("ttsDiagnosticOutput");
    output.textContent = ttsDiagnosticText;
    output.scrollTop = output.scrollHeight;
    return entries;
  }
  async function copyTtsDiagnosticLog() {
    if (!ttsDiagnosticText) await loadTtsDiagnosticLog();
    try {
      await navigator.clipboard.writeText(ttsDiagnosticText);
    } catch {
      const field = document.createElement("textarea");
      field.value = ttsDiagnosticText;
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.append(field);
      field.select();
      document.execCommand("copy");
      field.remove();
    }
    setStatus("TTS diagnostic log copied");
  }
  async function clearTtsDiagnosticLog() {
    await message({type:"clear-tts-diagnostic-log"});
    await loadTtsDiagnosticLog();
    setStatus("TTS diagnostic log cleared");
  }
  function formatDiagnosticCheck(check) {
    const labels = {pass:"PASS",fail:"FAIL",warn:"WARN",info:"INFO"};
    const statusLabel = labels[check?.status] || "INFO";
    return `[${statusLabel}] ${check?.label || "Check"}${check?.detail ? ` — ${check.detail}` : ""}`;
  }
  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const field = document.createElement("textarea");
      field.value = value;
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.append(field);
      field.select();
      document.execCommand("copy");
      field.remove();
    }
  }
  async function runExtensionDiagnostics() {
    const button = el("runDiagnostics");
    const output = el("diagnosticOutput");
    const summary = el("diagnosticSummary");
    button.disabled = true;
    button.textContent = "Running…";
    summary.dataset.status = "running";
    summary.textContent = "Running";
    output.textContent = "Checking background and page components…";

    const checks = [{status:"pass",label:"Settings console",detail:"Popup loaded"}];
    let version = ext.runtime.getManifest()?.version || "unknown";
    try {
      const clipboardGranted = clipboardReadIsRequired() || await permissionOperation("contains", {permissions:["clipboardRead"]});
      const clipboardEnabled = Boolean(settings.clipboardEditorSupport);
      checks.push({
        status: clipboardEnabled && clipboardGranted ? "pass" : (clipboardEnabled ? "warn" : "info"),
        label: "Google/Office copied-text compatibility",
        detail: clipboardEnabled
          ? (clipboardGranted ? `Enabled; clipboardRead permission ${clipboardReadIsRequired() ? "included at installation" : "granted"}` : "Enabled in settings, but clipboardRead permission is missing")
          : "Off; regular webpage selections still work"
      });
    } catch (error) {
      checks.push({status:"warn",label:"Google/Office copied-text compatibility",detail:error?.message || String(error)});
    }
    try {
      const background = await message({type:"run-extension-diagnostics"});
      version = background?.version || version;
      checks.push(...(background?.checks || []));
    } catch (error) {
      checks.push({status:"fail",label:"Background connection",detail:error?.message || String(error)});
    }

    try {
      const page = await tabMessage({type:"run-content-diagnostics"});
      if (page?.checks) checks.push(...page.checks);
      else checks.push({status:"warn",label:"Active page connection",detail:"Unavailable on this tab. Open and refresh a normal webpage, then run again."});
    } catch (error) {
      checks.push({status:"warn",label:"Active page connection",detail:error?.message || String(error)});
    }

    const failures = checks.filter((check) => check.status === "fail").length;
    const warnings = checks.filter((check) => check.status === "warn").length;
    const overall = failures ? "fail" : (warnings ? "warn" : "pass");
    const overallLabel = failures ? `${failures} failed` : (warnings ? `${warnings} warning${warnings === 1 ? "" : "s"}` : "All checks passed");
    const lines = [
      "Combined Chinese Annotator diagnostics",
      `Version: ${version}`,
      `Checked: ${new Date().toLocaleString()}`,
      `Overall: ${overallLabel}`,
      "",
      ...checks.map(formatDiagnosticCheck)
    ];
    extensionDiagnosticText = lines.join("\n");
    output.textContent = extensionDiagnosticText;
    output.scrollTop = 0;
    summary.dataset.status = overall;
    summary.textContent = overallLabel;
    console[failures ? "error" : (warnings ? "warn" : "info")]("[Combined Annotator diagnostics]\n" + extensionDiagnosticText);
    setStatus(failures ? "Diagnostics found a problem" : (warnings ? "Diagnostics completed with warnings" : "All diagnostic checks passed"));
    button.disabled = false;
    button.textContent = "Run diagnostics";
    return { checks, failures, warnings };
  }
  async function copyExtensionDiagnostics() {
    if (!extensionDiagnosticText) await runExtensionDiagnostics();
    await copyText(extensionDiagnosticText);
    setStatus("Diagnostic report copied");
  }
  function decodeTtsAudio(value) {
    const binary = atob(String(value || ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  function logPopupSpeechState(detail) {
    return message({type:"speech-state",detail}).catch(() => null);
  }
  function resetPopupTestPlayer(logCancellation = true) {
    const player = el("ttsTestPlayer");
    if (popupTestRequest && logCancellation && !player.ended) {
      logPopupSpeechState({...popupTestRequest,state:"canceled",stage:"popup-test-replaced"});
    }
    player.pause();
    player.onplay = null;
    player.onended = null;
    player.onerror = null;
    player.removeAttribute("src");
    player.load();
    player.hidden = true;
    if (popupTestAudioUrl) URL.revokeObjectURL(popupTestAudioUrl);
    popupTestAudioUrl = "";
    popupTestRequest = null;
  }
  async function runAzurePopupSpeechTest(label) {
    if (!azureSpeechConfig.configured) throw new Error("Save an Azure Speech key and region before testing.");
    resetPopupTestPlayer();
    const tests = {
      English:{text:"This is a test of Microsoft Jenny neural voice.",lang:"en-US",voice:"Jenny Neural"},
      Pinyin:{text:"你好，这是普通话语音测试。",lang:"zh-CN",voice:"Xiaochen Neural"},
      Jyutping:{text:"你好，呢個係廣東話語音測試。",lang:"zh-HK",voice:"HiuGaai"}
    };
    const test = tests[label] || tests.English;
    const requestId = `popup-test-${Date.now()}-${label.toLowerCase()}`;
    const currentSettings = readSettings();
    setStatus(`Requesting ${test.voice} from Azure…`);
    const response = await message({
      type:"synthesize-azure-speech",requestId,text:test.text,lang:test.lang,
      rate:currentSettings.speechRate,pitch:currentSettings.speechPitch
    });
    const blob = new Blob([decodeTtsAudio(response.audioBase64)],{type:response.mimeType || "audio/mpeg"});
    popupTestAudioUrl = URL.createObjectURL(blob);
    popupTestRequest = {id:requestId,backend:"azure",lang:response.lang || test.lang,selectedVoice:response.voice};
    const player = el("ttsTestPlayer");
    player.src = popupTestAudioUrl;
    player.hidden = false;
    player.onplay = () => {
      setStatus(`Playing ${test.voice}`);
      logPopupSpeechState({...popupTestRequest,state:"start",stage:"popup-player",audioBytes:response.audioBytes});
    };
    player.onended = () => {
      setStatus(`${test.voice} test finished`);
      logPopupSpeechState({...popupTestRequest,state:"end",stage:"popup-player"});
      loadTtsDiagnosticLog().catch(() => undefined);
    };
    player.onerror = () => {
      const code = player.error?.code ? ` (media error ${player.error.code})` : "";
      const error = `Firefox could not play the Azure test audio${code}.`;
      setStatus(error);
      logPopupSpeechState({...popupTestRequest,state:"error",stage:"popup-player",error});
      loadTtsDiagnosticLog().catch(() => undefined);
    };
    await logPopupSpeechState({
      ...popupTestRequest,state:"audio-ready",stage:"popup-player",durationMs:response.durationMs,
      audioBytes:response.audioBytes,mimeType:response.mimeType
    });
    try {
      await player.play();
    } catch (error) {
      const detail = error?.message || String(error);
      await logPopupSpeechState({...popupTestRequest,state:"error",stage:"autoplay",error:detail});
      setStatus("Audio is ready—press Play in the audio control.");
    }
    await loadTtsDiagnosticLog();
  }
  async function runPopupSpeechTest(label) {
    if (el("speechBackend").value === "azure") return runAzurePopupSpeechTest(label);
    setStatus(`Testing ${label} on the active page…`);
    const result = await tabMessage({type:"speech-test",label,settings:readSettings()});
    if (!result) throw new Error("Browser-voice tests need a normal webpage. Open one, reload it, and try again.");
    await loadTtsDiagnosticLog();
  }
  async function hydratePanel(panelName) {
    if (panelName === "words") await Promise.all([loadWords(), loadCustom()]);
    if (panelName === "speech") {
      const [diagnostics] = await Promise.all([tabMessage({type:"speech-diagnostics"}),loadAzureSpeechConfig(),loadTtsDiagnosticLog(),syncClipboardCompatibilityControl()]);
      populateVoices(diagnostics?.detail?.voices || []);
    }
  }
  function ensurePanelHydrated(panelName) {
    if (panelName !== "words" && panelName !== "speech") return Promise.resolve();
    if (!panelLoads.has(panelName)) {
      const task = hydratePanel(panelName).catch((error) => { panelLoads.delete(panelName); throw error; });
      panelLoads.set(panelName, task);
    }
    return panelLoads.get(panelName);
  }
  async function loadSiteProfile() {
    if (!hostname) return;
    const result = await message({type:"get-settings",hostname});
    currentProfile = result?.profile || null;
    el("siteEnabled").checked = result?.enabled !== false;
    el("forceChinese").checked = result?.settings?.languageMode === "force";
    el("profileBadge").textContent = currentProfile ? "Custom" : "Global";
    if (currentProfile && result.settings) writeSettings(result.settings);
    updateProfileBadges(currentProfile);
  }
  function updateProfileBadges(profile) {
    PROFILE_OVERRIDE_KEYS.forEach((key) => {
      let elId = key;
      if (key === "languageMode") elId = "forceChinese";
      const input = el(elId);
      if (!input) return;
      const parent = input.closest("label") || input.parentNode;
      const existing = parent.querySelector(".profile-badge");
      if (existing) existing.remove();
      if (!profile) return;
      const badge = document.createElement("span");
      badge.className = "profile-badge";
      if (profile.overrides && key in profile.overrides) {
        badge.textContent = "Overridden";
        badge.style.color = "var(--accent)";
      } else {
        badge.textContent = "Inherited";
      }
      parent.appendChild(badge);
    });
  }
  async function saveProfile() {
    if (!hostname) return setStatus("Site profiles are unavailable on this page");
    const global = readSettings();
    const profile = {enabled:el("siteEnabled").checked,overrides:{showJyutping:global.showJyutping,showPinyin:global.showPinyin,showEnglish:global.showEnglish,showHsk:global.showHsk,hoverOnly:global.hoverOnly,layoutMode:global.layoutMode,primaryLayer:global.primaryLayer,languageMode:el("forceChinese").checked?"force":"auto"}};
    const result = await message({type:"set-site-profile",hostname,profile}); currentProfile = result.profile;
    await tabMessage({type:"settings-updated",settings:result.effective.settings});
    await tabMessage({type:"site-disabled-changed",disabled:!result.effective.enabled});
    el("profileBadge").textContent = "Custom"; setStatus(`Saved profile for ${hostname}`);
    updateProfileBadges(currentProfile);
  }
  async function removeProfile() {
    if (!hostname) return;
    const result = await message({type:"set-site-profile",hostname,profile:null}); currentProfile = null;
    await tabMessage({type:"settings-updated",settings:result.effective.settings}); await tabMessage({type:"site-disabled-changed",disabled:false});
    await loadSiteProfile(); setStatus(`Using global defaults on ${hostname}`);
  }
  async function copyProfile() {
    if (!hostname || !currentProfile) return setStatus("No profile to copy");
    const target = prompt("Copy profile to hostname:", hostname);
    if (!target) return;
    const result = await message({type:"set-site-profile",hostname:target,profile:{enabled:currentProfile.enabled,overrides:{...currentProfile.overrides}}});
    setStatus(result ? `Copied profile to ${target}` : "Failed to copy profile");
  }
  async function loadWords() {
    const result = await message({type:"get-vocab",filter:el("wordFilter").value,search:el("wordSearch").value});
    renderWords(result?.entries||[]); await refreshReviewCount();
  }
  function renderWords(entries) {
    const list = el("vocabList"); list.textContent = ""; el("wordCount").textContent = String(entries.length);
    if (!entries.length) { const empty = document.createElement("p"); empty.className = "hint"; empty.textContent = "No matching saved words."; list.append(empty); updateBulkToolbar(); return; }
    lastCheckedIndex = -1;
    entries.forEach((entry, index) => {
      const row = document.createElement("div"); row.className = "word";
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.className = "word-checkbox"; cb.dataset.id = entry.id; cb.dataset.index = String(index);
      cb.addEventListener("change", updateBulkToolbar);
      cb.addEventListener("click", (event) => {
        if (event.shiftKey && lastCheckedIndex >= 0) {
          const checkboxes = [...list.querySelectorAll(".word-checkbox")];
          const lo = Math.min(lastCheckedIndex, index);
          const hi = Math.max(lastCheckedIndex, index);
          for (let i = lo; i <= hi; i++) checkboxes[i].checked = true;
          updateBulkToolbar();
        }
        lastCheckedIndex = index;
      });
      const main = document.createElement("div"); main.className = "word-main";
      const head = document.createElement("div"); head.className = "word-head"; head.textContent = entry.hanzi;
      const meta = document.createElement("div"); meta.className = "word-meta"; meta.textContent = [[entry.pinyin,entry.jyutping].filter(Boolean).join(" · "),(entry.definitions||[]).join("; ")].filter(Boolean).join(" — ");
      const state = document.createElement("span"); state.className = "word-tags"; state.textContent = entry.review?.state||"new"; meta.append(state); main.append(head,meta);
      const context = entry.contexts?.[0]?.sentence; if (context) { const line = document.createElement("div"); line.className = "word-context"; line.textContent = context; main.append(line); }
      const actions = document.createElement("div"); actions.className = "word-actions"; const edit = document.createElement("button"); edit.textContent = "Edit"; edit.addEventListener("click",() => showVocabEditor(entry)); const remove = document.createElement("button"); remove.textContent = "×"; remove.title = "Remove"; remove.addEventListener("click",async()=>{await message({type:"remove-vocab",id:entry.id});await loadWords();}); actions.append(edit,remove); row.append(cb,main,actions); list.append(row);
    });
    updateBulkToolbar();
  }
  function updateBulkToolbar() {
    const toolbar = el("bulkToolbar");
    const checkboxes = [...document.querySelectorAll(".word-checkbox:checked")];
    const count = checkboxes.length;
    toolbar.style.display = count > 0 ? "" : "none";
    el("bulkCount").textContent = `${count} selected`;
    el("selectAllWords").checked = checkboxes.length > 0 && checkboxes.length === document.querySelectorAll(".word-checkbox").length;
  }
  function getSelectedWordIds() {
    return [...document.querySelectorAll(".word-checkbox:checked")].map((cb) => cb.dataset.id);
  }
  async function bulkTag() {
    const tag = prompt("Tag name:");
    if (!tag) return;
    const ids = getSelectedWordIds();
    for (const id of ids) {
      const result = await message({type:"get-vocab",search:id});
      const entry = result?.entries?.[0];
      if (entry) {
        const tags = [...(entry.tags||[]), tag];
        await message({type:"save-vocab",entry:{...entry,tags}});
      }
    }
    setStatus(`Tagged ${ids.length} words with "${tag}"`);
    await loadWords();
  }
  async function bulkMarkKnown() {
    const ids = getSelectedWordIds();
    for (const id of ids) await message({type:"rate-review",wordId:id,rating:"known"});
    setStatus(`Marked ${ids.length} words as known`);
    await loadWords();
  }
  async function bulkSuspend() {
    const ids = getSelectedWordIds();
    for (const id of ids) {
      const result = await message({type:"get-vocab",search:id});
      const entry = result?.entries?.[0];
      if (entry) await message({type:"save-vocab",entry:{...entry,suspended:true}});
    }
    setStatus(`Suspended ${ids.length} words`);
    await loadWords();
  }
  async function bulkDelete() {
    const ids = getSelectedWordIds();
    if (!confirm(`Delete ${ids.length} selected word${ids.length===1?"":"s"}?`)) return;
    for (const id of ids) await message({type:"remove-vocab",id});
    setStatus(`Deleted ${ids.length} words`);
    await loadWords();
  }
  async function bulkExport() {
    const ids = getSelectedWordIds();
    const result = await message({type:"get-vocab"});
    const entries = (result?.entries||[]).filter((e) => ids.includes(e.id));
    if (!entries.length) return setStatus("No words to export");
    const header = ["Headword","Simplified","Traditional","Pinyin","Jyutping","Definitions","Sentence","Source","Tags","Review status"];
    const rows = entries.map((e) => [e.hanzi,e.simplified,e.traditional,e.pinyin,e.jyutping,(e.definitions||[]).join("; "),e.contexts?.[0]?.sentence||"",e.contexts?.[0]?.sourceUrl||e.contexts?.[0]?.sourceTitle||"",(e.tags||[]).join(", "),e.review?.state||"new"].map(escapeField).join("\t"));
    download("combined-annotator-selected-words.tsv",[header.join("\t"),...rows].join("\n"),"text/tab-separated-values;charset=utf-8");
    setStatus(`Exported ${entries.length} words`);
  }
  function selectAllWords() {
    const checked = el("selectAllWords").checked;
    document.querySelectorAll(".word-checkbox").forEach((cb) => { cb.checked = checked; });
    updateBulkToolbar();
  }
  function showVocabEditor(entry) {
    el("vocabEditor").style.display = "";
    el("editHeadword").value = entry.hanzi || entry.simplified || "";
    el("editPinyin").value = entry.pinyin || "";
    el("editJyutping").value = entry.jyutping || "";
    el("editDefinitions").value = (entry.definitions||[]).join("|");
    el("editNote").value = entry.note || "";
    el("editTags").value = (entry.tags||[]).join(", ");
    el("vocabEditor").dataset.entryId = entry.id;
    el("editPinyin").focus();
  }
  function hideVocabEditor() {
    el("vocabEditor").style.display = "none";
  }
  async function saveVocabEdit() {
    const id = el("vocabEditor").dataset.entryId;
    const result = await message({type:"get-vocab",search:id});
    const entry = result?.entries?.[0];
    if (!entry) return hideVocabEditor();
    const updated = {...entry,
      pinyin: el("editPinyin").value,
      jyutping: el("editJyutping").value,
      definitions: el("editDefinitions").value.split("|").map((v) => v.trim()).filter(Boolean),
      note: el("editNote").value,
      tags: el("editTags").value.split(",").map((v) => v.trim()).filter(Boolean)
    };
    await message({type:"save-vocab",entry:updated});
    hideVocabEditor();
    await loadWords();
    setStatus(`Updated ${entry.hanzi}`);
  }
  async function editVocab(entry) {
    showVocabEditor(entry);
  }
  async function refreshReviewCount() { const result = await message({type:"get-review-queue"}); el("reviewCount").textContent = `${result?.entries?.length||0} due`; }
  function formatInterval(ms) {
    if (ms < 60000) return Math.round(ms/1000) + "s";
    if (ms < 3600000) return (ms/60000).toFixed(1) + "m";
    if (ms < 86400000) return (ms/3600000).toFixed(1) + "h";
    return (ms/86400000).toFixed(1) + "d";
  }
  function computeInterval(entry, rating) {
    try {
      if (Core && Core.rateReview && entry.review) {
        const next = Core.rateReview(entry.review, rating, Date.now());
        if (next && next.dueAt) return next.dueAt - Date.now();
      }
    } catch (e) { /* ignore */ }
    const intervals = {again:600000, hard:43200000, good:86400000, known:604800000};
    return intervals[rating] || 86400000;
  }
  function showReviewCard() {
    const entry = reviewQueue[reviewIndex]; const panel = el("reviewPanel");
    el("reviewProgress").textContent = `${reviewIndex + 1} of ${reviewQueue.length} due`;
    if (!entry) { panel.hidden = true; setStatus("Review complete"); refreshReviewCount(); loadWords(); return; }
    panel.hidden = false; reviewFlipped = false; el("reviewFront").textContent = entry.hanzi; el("reviewBack").hidden = true; el("ratingButtons").hidden = true;
    el("reviewBack").textContent = [entry.traditional&&entry.traditional!==entry.hanzi?`Traditional: ${entry.traditional}`:"",entry.pinyin?`Pinyin: ${entry.pinyin}`:"",entry.jyutping?`Jyutping: ${entry.jyutping}`:"",(entry.definitions||[]).join("; "),entry.contexts?.[0]?.sentence?`\n${entry.contexts[0].sentence}`:""].filter(Boolean).join("\n");
    el("reviewFront").focus();
    // Update rating button labels with intervals
    const ratings = ["again","hard","good","known"];
    ratings.forEach((rating) => {
      const btn = document.querySelector(`[data-rating="${rating}"]`);
      if (btn) {
        const interval = formatInterval(computeInterval(entry, rating));
        const labels = {again:"Again",hard:"Hard",good:"Good",known:"Known"};
        const keys = {again:"1",hard:"2",good:"3",known:"4"};
        btn.textContent = "";
        const shortcut = document.createElement("kbd");
        shortcut.textContent = keys[rating];
        btn.append(shortcut, ` ${labels[rating]} (${interval})`);
      }
    });
  }
  function flipReview() {
    if (!reviewQueue[reviewIndex]) return;
    reviewFlipped = true; el("reviewBack").hidden = false; el("ratingButtons").hidden = false;
    if (el("autoSpeakToggle").checked) {
      const entry = reviewQueue[reviewIndex];
      tabMessage({type:"speak-text",text:entry.hanzi||"",lang:"zh-CN"});
    }
  }
  async function rateReview(rating) { const entry = reviewQueue[reviewIndex]; if (!entry||!reviewFlipped) return; await message({type:"rate-review",wordId:entry.id,rating}); reviewIndex++; showReviewCard(); }
  async function startReview() { const result = await message({type:"get-review-queue"}); reviewQueue = result?.entries||[]; reviewIndex = 0; if (!reviewQueue.length) return setStatus("Nothing is due — nice work"); showReviewCard(); }
  async function undoReview() { const result = await message({type:"undo-review"}); if (result?.result&&reviewIndex>0) { reviewIndex--; showReviewCard(); } setStatus(result?.result?"Last rating undone":"Nothing to undo"); await refreshReviewCount(); }
  function skipReview() { if (!reviewQueue[reviewIndex]) return; reviewIndex++; showReviewCard(); }
  async function suspendReview() {
    const entry = reviewQueue[reviewIndex];
    if (!entry) return;
    await message({type:"save-vocab",entry:{...entry,suspended:true}});
    reviewQueue.splice(reviewIndex, 1);
    if (reviewIndex >= reviewQueue.length) reviewIndex = 0;
    showReviewCard();
    setStatus(`Suspended ${entry.hanzi}`);
  }
  async function exportTsv() {
    const result = await message({type:"get-vocab"}), entries = result?.entries||[]; if (!entries.length) return setStatus("No words to export");
    const header = ["Headword","Simplified","Traditional","Pinyin","Jyutping","Definitions","Sentence","Source","Tags","Review status"];
    const rows = entries.map((e) => [e.hanzi,e.simplified,e.traditional,e.pinyin,e.jyutping,(e.definitions||[]).join("; "),e.contexts?.[0]?.sentence||"",e.contexts?.[0]?.sourceUrl||e.contexts?.[0]?.sourceTitle||"",(e.tags||[]).join(", "),e.review?.state||"new"].map(escapeField).join("\t"));
    download("combined-annotator-words.tsv",[header.join("\t"),...rows].join("\n"),"text/tab-separated-values;charset=utf-8"); setStatus(`Exported ${entries.length} words`);
  }
  async function importWords(file) {
    const text = await file.text();
    const rows = Core.parseDelimited(text);
    const report = el("importReport"); report.hidden = false;
    if (!rows.length) { report.textContent = "No valid vocabulary rows found."; return; }
    const preview = rows.slice(0,5).map(({entry},index) => `${index+1}. ${entry.hanzi} — ${entry.pinyin||entry.jyutping||"no reading"} — ${(entry.definitions||[]).join("; ")||"no definition"}`).join("\n");
    report.textContent = `Preview (${rows.length} row${rows.length===1?"":"s"} detected):\n${preview}`;
    if (!confirm(`Import ${rows.length} detected vocabulary row${rows.length===1?"":"s"}?\n\n${preview}`)) return;
    const result = await message({type:"import-vocabulary",text});
    report.textContent = `Imported ${result.imported}.\n${result.errors?.length?result.errors.map((e) => `Row ${e.row}: ${e.error}`).join("\n"):"No errors."}`;
    await loadWords();
  }
  async function loadCustom() { const result = await message({type:"get-custom-dictionary"}); const list = el("customList"); list.textContent = ""; (result?.entries||[]).forEach((entry) => { const row = document.createElement("div"); row.className = "word"; const main = document.createElement("div"); main.className = "word-main"; main.innerHTML = ""; const head = document.createElement("div"); head.className = "word-head"; head.textContent = entry.headword; const meta = document.createElement("div"); meta.className = "word-meta"; meta.textContent = `${entry.mode} — ${(entry.definitions||[]).join("; ")}`; main.append(head,meta); const actions = document.createElement("div"); actions.className = "word-actions"; const edit = document.createElement("button"); edit.textContent = "Edit"; edit.addEventListener("click",() => fillCustom(entry)); const remove = document.createElement("button"); remove.textContent = "×"; remove.addEventListener("click",async() => { await message({type:"remove-custom-entry",id:entry.id}); loadCustom(); }); actions.append(edit,remove); row.append(main,actions); list.append(row); }); }
  function fillCustom(entry = {}) { el("customId").value = entry.id||""; el("customHeadword").value = entry.headword||""; el("customSimplified").value = entry.simplified||""; el("customTraditional").value = entry.traditional||""; el("customPinyin").value = entry.pinyin||""; el("customJyutping").value = entry.jyutping||""; el("customDefinitions").value = (entry.definitions||[]).join("\n"); el("customNote").value = entry.note||""; el("customTags").value = (entry.tags||[]).join(", "); el("customMode").value = entry.mode||"merge"; }
  async function saveCustom() { const headword = el("customHeadword").value.trim(); if (!headword) { setStatus("A headword is required"); return; } const entry = {id:el("customId").value||undefined,headword,simplified:el("customSimplified").value,traditional:el("customTraditional").value,pinyin:el("customPinyin").value,jyutping:el("customJyutping").value,definitions:el("customDefinitions").value.split(/\r?\n/).filter(Boolean),note:el("customNote").value,tags:el("customTags").value.split(",").map(t=>t.trim()).filter(Boolean),mode:el("customMode").value}; const result = await message({type:"save-custom-entry",entry}); if (result && result.error) { setStatus(result.error); return; } fillCustom(); loadCustom(); setStatus(`Saved custom entry for ${entry.headword}`); }
  async function exportBackup() { const result = await message({type:"export-user-data"}); download(`combined-annotator-backup-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify(result.data,null,2),"application/json"); setStatus("Complete local backup exported"); }
  async function importBackup(file) { const data = JSON.parse(await file.text()); const replace = el("replaceBackup").checked; if (replace&&!confirm("Replace all existing words, contexts, reviews, custom entries, settings, and site profiles?")) return; const result = await message({type:"import-user-data",data,mode:replace?"replace":"merge"}); settings = await message({type:"get-settings"}); writeSettings(settings); await Promise.all([loadWords(),loadCustom(),loadSiteProfile()]); setStatus(`Backup imported (${result.mode})`); }
  async function loadAutoBackups() {
    const list = el("backupList");
    try {
      const result = await message({type:"get-auto-backups"});
      const slots = result?.slots||[];
      list.textContent = "";
      if (!slots.length) { list.textContent = "No auto-backups available."; return; }
      slots.forEach((slot) => {
        const row = document.createElement("div");
        row.className = "backup-row";
        const info = document.createElement("span");
        info.textContent = slot.timestamp ? `Slot ${slot.slot} — ${new Date(slot.timestamp).toLocaleString()}` : `Slot ${slot.slot} — Empty`;
        const restore = document.createElement("button");
        restore.textContent = "Restore";
        restore.disabled = !slot.timestamp;
        restore.addEventListener("click", () => restoreAutoBackup(slot.slot));
        row.append(info, restore);
        list.append(row);
      });
    } catch (e) { list.textContent = "Could not load auto-backups."; }
  }
  async function restoreAutoBackup(slot) {
    if (!confirm(`Restore auto-backup slot ${slot}? This will overwrite current data.`)) return;
    const result = await message({type:"restore-auto-backup",slot});
    if (result && result.error) { setStatus(result.error); return; }
    settings = await message({type:"get-settings"});
    writeSettings(settings);
    await Promise.all([loadWords(),loadCustom(),loadSiteProfile()]);
    setStatus(`Restored auto-backup slot ${slot}`);
  }
  async function updateHealth() {
    const dot = el("healthStatus");
    if (!dot) return;
    try {
      const result = await tabMessage({type:"get-health"});
      dot.className = "health-dot";
      if (!result) { dot.className += " health-waking"; dot.title = "Background waking…"; return; }
      switch (result.health || result.state) {
        case "ready": dot.className += " health-ready"; dot.title = "Ready"; dot.style.cursor = ""; dot.onclick = null; break;
        case "annotating": dot.className += " health-annotating"; dot.title = "Annotating…"; dot.style.cursor = ""; dot.onclick = null; break;
        case "error": dot.className += " health-error"; dot.title = "Error — Click to Repair"; dot.style.cursor = "pointer"; dot.onclick = repair; break;
        case "disabled": dot.className += " health-disabled"; dot.title = "Disabled"; dot.style.cursor = ""; dot.onclick = null; break;
        default: dot.className += " health-ready"; dot.title = result.state || "Ready"; dot.style.cursor = ""; dot.onclick = null;
      }
    } catch (e) { dot.className = "health-dot health-waking"; dot.title = "Background waking…"; }
  }
  async function repair() {
    setStatus("Repairing…");
    try {
      const settingsResult = await message({type:"get-settings"});
      settings = settingsResult;
      writeSettings(settings);
      await tabMessage({type:"settings-updated",settings});
      setStatus("Repair complete");
    } catch (e) { setStatus("Repair failed: " + (e.message||String(e))); }
    updateHealth();
  }
  async function updateProgress() {
    const container = el("annotationProgress");
    if (!container || container.style.display === "none") return;
    try {
      const result = await tabMessage({type:"get-health"});
      if (!result) return;
      const total = result.total||0;
      const completed = result.completed||0;
      const failed = result.failed||0;
      el("progressText").textContent = `${completed} of ${total} text nodes annotated` + (failed ? ` (${failed} failed)` : "");
      const pct = total > 0 ? Math.round((completed/total)*100) : 0;
      el("progressFill").style.width = `${pct}%`;
      if (result.state === "annotating") {
        el("stopAnnotationBtn").style.display = "";
        el("resumeAnnotationBtn").style.display = "none";
      } else {
        el("stopAnnotationBtn").style.display = "none";
        el("resumeAnnotationBtn").style.display = result.state === "paused" ? "" : "none";
      }
    } catch (e) { /* ignore */ }
  }
  function renderCoverage(detail) { el("coverageOutput").hidden = false; el("coverageOutput").textContent = detail?.ok===false?"Could not inspect page":JSON.stringify(detail?.detail||detail||{},null,2); }
  async function init() {
    buildColors(); installTabs(); installSpeechShortcutEditors(); activeTab = await queryTab(); try { hostname = activeTab?.url?new URL(activeTab.url).hostname:""; } catch(e) {}
    el("siteLabel").textContent = hostname||"Offline learning tools";
    const [loadedSettings] = await Promise.all([message({type:"get-settings"}),loadSiteProfile()]);
    settings = loadedSettings;
    writeSettings(settings);
    [...checkboxIds.filter((id) => id!=="clipboardEditorSupport"),...selectIds.filter((id) => id!=="speechBackend"),...rangeIds,...voiceIds,...colorIds].forEach((id) => el(id)?.addEventListener("change",handleSettingChange)); rangeIds.forEach((id) => el(id).addEventListener("input",updateOutputs));
    el("clipboardEditorSupport").addEventListener("change",() => handleClipboardCompatibilityChange());
    el("speechBackend").addEventListener("change",() => handleSpeechBackendChange().catch((error) => setStatus(error.message||String(error))));
    el("saveAzureSpeech").onclick = () => saveAzureSpeechConfig().catch((error) => setStatus(error.message||String(error)));
    el("clearAzureSpeech").onclick = () => clearAzureSpeechConfig().catch((error) => setStatus(error.message||String(error)));
    el("refreshTtsLog").onclick = () => loadTtsDiagnosticLog().then((entries) => setStatus(`Loaded ${entries.length} TTS diagnostic events`)).catch((error) => setStatus(error.message||String(error)));
    el("copyTtsLog").onclick = () => copyTtsDiagnosticLog().catch((error) => setStatus(error.message||String(error)));
    el("clearTtsLog").onclick = () => clearTtsDiagnosticLog().catch((error) => setStatus(error.message||String(error)));
    el("runDiagnostics").onclick = () => runExtensionDiagnostics().catch((error) => {
      el("diagnosticSummary").dataset.status = "fail";
      el("diagnosticSummary").textContent = "Failed";
      el("diagnosticOutput").textContent = error?.stack || error?.message || String(error);
      el("runDiagnostics").disabled = false;
      el("runDiagnostics").textContent = "Run diagnostics";
      setStatus("Diagnostics could not complete");
    });
    el("copyDiagnostics").onclick = () => copyExtensionDiagnostics().catch((error) => setStatus(error.message||String(error)));
    el("selectAll").onclick = () => { annotationLayerIds.forEach((id) => el(id).checked = true); ensureAllSelectedLayersAreVisible(); saveSettings(); }; el("selectNone").onclick = () => { annotationLayerIds.forEach((id) => el(id).checked = false); saveSettings(); }; el("closePopup").onclick = () => window.close();
    el("saveSiteProfile").onclick = saveProfile; el("removeSiteProfile").onclick = removeProfile; el("copyProfileBtn").onclick = copyProfile;
    el("wordFilter").onchange = loadWords; let searchTimer; el("wordSearch").oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadWords,180); };
    el("startReview").onclick = startReview; el("undoReview").onclick = undoReview; el("flipReview").onclick = flipReview; el("reviewFront").onclick = flipReview; document.querySelectorAll("[data-rating]").forEach((b) => b.onclick = () => rateReview(b.dataset.rating));
    el("skipReview").onclick = skipReview; el("suspendReview").onclick = suspendReview;
    el("speakReview").onclick = () => tabMessage({type:"speak-text",text:reviewQueue[reviewIndex]?.hanzi||"",lang:"zh-CN"}); el("editReview").onclick = () => reviewQueue[reviewIndex]&&showVocabEditor(reviewQueue[reviewIndex]); document.addEventListener("keydown",(event) => { if (el("reviewPanel").hidden) return; if (event.key===" ") { event.preventDefault(); flipReview(); } const ratings = {1:"again",2:"hard",3:"good",4:"known"}; if (ratings[event.key]) rateReview(ratings[event.key]); });
    el("exportAnki").onclick = exportTsv; el("importWords").onclick = () => el("importWordsFile").click(); el("importWordsFile").onchange = (event) => event.target.files[0]&&importWords(event.target.files[0]).catch((e) => setStatus(e.message)); el("clearVocab").onclick = async() => { if (confirm("Delete all saved words, contexts, and review history?")) { await message({type:"clear-vocab"}); loadWords(); } };
    el("saveCustom").onclick = () => saveCustom().catch((e) => setStatus(e.message)); el("resetCustom").onclick = () => fillCustom();
    document.querySelectorAll("[data-speech]").forEach((b) => b.onclick = () => {
      runPopupSpeechTest(b.dataset.speech).catch(async(error) => {
        setStatus(error?.message || String(error));
        await loadTtsDiagnosticLog().catch(() => undefined);
      });
    }); el("openReader").onclick = async() => {
      try {
        await message({type:"open-reader-in-tab",tabId:activeTab?.id});
        window.close();
      } catch (error) {
        setStatus(error.message || "Could not open Reader");
      }
    }; document.querySelectorAll("[data-convert]").forEach((b) => b.onclick = async() => { const result = await message({type:"page-conversion-in-tab",tabId:activeTab?.id,action:b.dataset.convert}); setStatus(result?.changed!=null?`Converted ${result.changed} text nodes`:"Conversion sent"); });
    el("exportPage").onclick = () => tabMessage({type:"export-csv"}); el("refreshPage").onclick = async() => renderCoverage(await tabMessage({type:"refresh-visible"})); el("inspectCoverage").onclick = async() => renderCoverage(await tabMessage({type:"annotation-coverage"}));
    el("exportBackup").onclick = exportBackup; el("importBackup").onclick = () => el("importBackupFile").click(); el("importBackupFile").onchange = (event) => event.target.files[0]&&importBackup(event.target.files[0]).catch((e) => setStatus(`Import failed: ${e.message}`));
    el("refreshBackups").onclick = loadAutoBackups;
    // Bulk word actions
    el("selectAllWords").onclick = selectAllWords; el("bulkTag").onclick = bulkTag; el("bulkMarkKnown").onclick = bulkMarkKnown; el("bulkSuspend").onclick = bulkSuspend; el("bulkDelete").onclick = bulkDelete; el("bulkExport").onclick = bulkExport;
    // Vocab editor modal
    el("saveVocabEdit").onclick = saveVocabEdit; el("cancelVocabEdit").onclick = hideVocabEditor;
    el("vocabEditor").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); saveVocabEdit(); } });
    // Pause controls
    el("pausePage").onclick = async() => { await tabMessage({type:"pause-annotations"}); el("pausePage").style.display = "none"; el("pauseTimer").style.display = "none"; el("pauseSelection").style.display = "none"; el("resumeAnnotations").style.display = ""; setStatus("Annotations paused on this page"); };
    el("pauseTimer").onclick = async() => { await tabMessage({type:"pause-annotations-timer"}); el("pausePage").style.display = "none"; el("pauseTimer").style.display = "none"; el("pauseSelection").style.display = "none"; el("resumeAnnotations").style.display = ""; setStatus("Annotations paused for 10 minutes"); };
    el("pauseSelection").onclick = async() => { await tabMessage({type:"pause-annotations-selection"}); el("pausePage").style.display = "none"; el("pauseTimer").style.display = "none"; el("pauseSelection").style.display = "none"; el("resumeAnnotations").style.display = ""; setStatus("Annotating selection only"); };
    el("resumeAnnotations").onclick = async() => { await tabMessage({type:"resume-annotations"}); el("pausePage").style.display = ""; el("pauseTimer").style.display = ""; el("pauseSelection").style.display = ""; el("resumeAnnotations").style.display = "none"; setStatus("Annotations resumed"); };
    // Annotation progress
    el("stopAnnotationBtn").onclick = async() => { await tabMessage({type:"stop-annotations"}); el("stopAnnotationBtn").style.display = "none"; el("resumeAnnotationBtn").style.display = ""; setStatus("Annotation stopped"); };
    el("resumeAnnotationBtn").onclick = async() => { await tabMessage({type:"resume-annotations"}); el("stopAnnotationBtn").style.display = ""; el("resumeAnnotationBtn").style.display = "none"; setStatus("Annotation resumed"); };
    // Health polling
    updateHealth(); healthTimer = window.setInterval(updateHealth, 2000);
  }
  init().catch((error) => setStatus(error.message||String(error)));
})();
