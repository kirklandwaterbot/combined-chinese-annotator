# Combined Chinese Annotator

Combined Chinese Annotator 0.2.4 is a local-first Firefox, Chrome, and Microsoft Edge extension for reading and learning Chinese. It adds Pinyin, Jyutping, English glosses, HSK labels, dictionary lookup, saved contexts, review, speech, and stroke practice. Annotation and learning data remain local. Speech can use local/browser voices or an optional user-configured Azure Speech resource.

## What is new in 0.2.4

- Added Azure Neural speech as the default engine in Firefox with per-language voices, explicit configuration, test controls, and privacy-safe diagnostic logs. It sends nothing until the user supplies a key and requests speech.
- Added a compact 20-by-20 high-resolution quick-action icon and menu beside selected text; scrolling dismisses it until text is selected again.
- Clarified Reader speech with an explicit Cantonese, Mandarin, or English selector, language-labelled playback controls, live playback status, and valid Pause/Resume/Stop states.
- Made dictionary windows freely draggable within the browser viewport and replaced the ambiguous Listen action with explicit Cantonese, Mandarin, and English-definition playback choices.
- Added editable selected-text read-aloud shortcuts: `Ctrl+Alt+C` for Cantonese, `Ctrl+Alt+M` for Mandarin, and `Ctrl+Alt+E` for English definitions. Change or reset them in the Speech settings.
- Added a default-on copied-text bridge for Google Docs, Slides, Sheets, and Microsoft Office web editors, whose canvas selections are hidden from Firefox extensions.
- Improved stroke-order loading and diagnostics, kept the active character selected when switching Simplified/Traditional, and fixed dark-mode speed labels.
- Made page actions recover immediately after an extension reload instead of requiring a delay.
- Removed the unsupported Firefox Android manifest ID that caused a temporary-install warning.

## Highlights from 0.2.1

- Adaptive annotations prevent narrow sidebars from becoming tall, crammed stacks. Under 320 px, text keeps its native inline flow and annotations move to a floating preview; 320–559 px shows only the selected primary layer; three-layer stacks require 720 px. Compact titles, links, cards, menus, overlays, ellipsized text, and line-clamped UI are protected by a pre-layout popup-only guard.
- Explicitly non-Chinese blocks are skipped by default using BCP-47 `lang` metadata, with kana/Hangul, mixed-script, fragmented-title, and surrounding-text safeguards when metadata is absent. Chinese varieties such as Mandarin, Cantonese, Wu, and Hakka remain eligible, nested Chinese `lang` blocks override a non-Chinese parent, and site profiles can force annotation.
- Layout can be set to Adaptive, Full stack, Primary only, or Popup only, with annotation scale, spacing, primary-layer, and peek-key controls.
- The dictionary runs in an isolated Shadow DOM surface, expands overlapping phrases longest-first, and shows variants, both readings, separate senses, classifiers, references, HSK, saved contexts, and custom overrides.
- Saved words use a versioned IndexedDB database with up to five local contexts per word, optional source URLs, notes, tags, custom entries, and merge-safe migration from the 0.1 storage format.
- The popup includes searchable New, Due, Learning, Known, and All word views plus offline review with `1`–`4` ratings and undo.
- Reader mode, sentence navigation, speech rate/pitch controls, and word-boundary highlighting are included.
- Complete backup/restore, CSV/TSV preview/import, richer Anki/TSV export, and hostname-based site profiles replace the older settings-only backup and disabled-site list.
- Stroke data is encoded into 64 on-demand binary shards. All 9,574 source characters are retained and round-trip tested; decoded characters are cached individually.

Difficulty-aware/HSK-threshold hiding and frequency indicators are intentionally not included.

## Install from source

Firefox: run `npm run prepare:firefox`, open `about:debugging`, choose **This Firefox**, then **Load Temporary Add-on** and select `web-ext-artifacts/firefox-unpacked/manifest.json`.

Chrome: open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this directory.

Microsoft Edge: open `edge://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this directory. Edge's online SpeechSynthesis voices provide the most reliable access to Microsoft Jenny and Xiaoxiao; in the extension popup, open **Speech** and leave English and Mandarin on **Automatic**, or choose either voice explicitly.

## Azure Neural speech in Firefox

Firefox does not expose Windows Narrator-only natural voices through the Web Speech API. Azure is the default selected engine and provides `en-US-JennyNeural`, `zh-CN-XiaochenNeural`, and `zh-HK-HiuGaaiNeural`. It remains inactive until a key is configured, and these voices can use the Azure F0 neural text-to-speech allowance.

1. Create an Azure AI Speech resource and copy its key and region from **Keys and Endpoint**.
2. Reload the temporary extension after rebuilding it.
3. Open the extension popup, choose **Speech**, and select **Azure Neural voices**.
4. Approve Firefox's optional data-transmission prompt.
5. Enter the resource region, paste the key, and select **Save & use Azure**.
6. Use the three test buttons before reading page text.

The key is stored only in extension-local storage and is excluded from extension backups. Azure mode sends only text explicitly requested for speech plus the key and synthesis options to the selected regional Microsoft endpoint. Azure pricing and quota apply.

If speech works intermittently, reopen **Speech**, expand **TTS diagnostic log**, and select **Refresh**. The latest 200 request and playback events are retained locally across popup closes. **Copy log** produces a shareable report containing timings, HTTP status, error category, voice, audio size, and playback state, but never the spoken text, page address, Azure key, SSML, or audio. Use **Clear** to remove the retained events.

## Google Docs and Microsoft Office web editors

Canvas-based editors do not provide their selected text to normal Firefox selection APIs. To use speech, Reader, or stroke order there:

1. Open the extension popup and choose **Speech**.
2. Confirm **Google/Office copied-text compatibility (on by default)** remains enabled.
3. Select text in the editor and press `Ctrl+C`.
4. Press `Ctrl+Alt+C` for Cantonese, `Ctrl+Alt+M` for Mandarin, or `Ctrl+Alt+E` for English; alternatively Shift+right-click and choose a **Read Selected/Copied** command.

The clipboard is read only when an action is invoked, and its contents are never stored or added to diagnostic logs. Disable the option at any time to stop clipboard reads. In-place Simplified/Traditional replacement is still unavailable inside these canvas editors because they do not expose an editable browser selection.

Selecting text alone is not sufficient: the extension requires a recent `Ctrl+C` observed inside the same editor tab before it reads the clipboard. This prevents an older copied console command or unrelated text from being spoken. Cantonese and Mandarin actions also stop with a visible explanation when the copied text contains no Chinese characters.

Some Google editor surfaces swallow the normal browser `copy` event. The extension therefore observes both the copy event and the `Ctrl+C` keyboard signal. If neither reaches the extension, it may still use the clipboard only when the value contains Chinese; stale console commands and other non-Chinese values remain blocked.

The explicit English read-aloud command is the exception: it may speak copied English text directly even when Google hides the copy signal. This exception does not apply to Mandarin, Cantonese, Reader, or stroke-order commands.

The 20-by-20 PinJyut logo also appears near a Google/Office canvas selection when the editor exposes its hidden selection signal or when `Ctrl+C` is pressed. Clicking it opens the same quick-action menu used on ordinary pages. The extension attempts to copy the hidden editor selection automatically before running the chosen action; if the editor blocks that attempt, the most recently copied selection is used.

For the English command, copied Chinese is looked up locally first and the matching English definitions are sent to the configured English voice. The console records `english-gloss-requested` and `english-gloss-resolved` without logging the copied text; if no definition is available, the command stops instead of asking an English voice to pronounce raw hanzi.

For a complete F12 diagnostic snapshot, open the editor's developer console and run:

    document.dispatchEvent(new Event("ca-google-office-diagnostics"))

The console reports editor detection, frame, content/background readiness, clipboard API and permission state, compatibility setting, live DOM selection availability, active shortcuts, Azure configuration/permission state, fixed Azure voice names, and subsequent action/speech lifecycle events. It records text length only—never copied text or Azure credentials.

For a dedicated cross-frame selection-logo report, run:

    document.documentElement.dataset.caSelectionLogoDiagnosticsRevision
    document.dispatchEvent(new Event("ca-google-office-selection-diagnostics"))

The first line must return `cross-frame-v2`; `undefined` means the updated content script is not active in that tab. The established general command, `document.dispatchEvent(new Event("ca-google-office-diagnostics"))`, also emits the same cross-frame logo report. Inspect the `selection-logo-diagnostic-report` entry: it lists every reachable Google editor frame and reports listener delivery, selection state, last pointer anchor, copy signal, overlay creation, hidden/connected state, computed visibility, and rendered dimensions without exposing selected or copied text.

## Mozilla source-review build

The AMO source submission contains readable first-party source plus the pinned raw dictionary and stroke snapshots. Generated first-party runtime outputs (ccedict-glosses-*.json, lexicon-data/*, and stroke-data/*) are intentionally omitted and recreated by the review build.

Required build environment:

- Operating system: Windows 11 x64 (verified) or Ubuntu 24.04 x64/ARM64.
- Node.js: exactly 22.14.0, available from https://nodejs.org/download/release/v22.14.0/.
- npm: exactly 10.9.2, bundled with Node.js 22.14.0.
- No globally installed npm packages, compilers, transpilers, or platform-specific utilities are required.
- Internet access is needed only for npm ci; all extension data generation is offline from the pinned files included in the source archive.

From the extracted source archive, run:

    node --version
    npm --version
    npm ci
    npm run build:firefox-review

The first two commands must report v22.14.0 and 10.9.2. Do not run npm update; npm ci installs the exact dependency graph in package-lock.json, including web-ext 8.10.0.

npm run build:firefox-review executes every technical build step:

1. build-lexicon.js verifies and projects the pinned CC-CEDICT gzip.
2. build-data.js encodes and round-trip verifies all 9,574 pinned stroke records.
3. build-extension.js --build-firefox stages manifest.firefox.json as the runtime manifest.json.
4. Mozilla web-ext creates web-ext-artifacts/combined_chinese_annotator-0.2.4-firefox.zip.

First-party JavaScript, HTML, and CSS are copied without transpilation, concatenation, minification, or obfuscation. opencc.js, hanzi-writer.min.js, pinyin-web-engine.js, and annotate-dat.txt are unmodified open-source third-party components documented in THIRD-PARTY.md and SOURCES.md.

Optional verification commands:

    npm test
    npm run lint

For normal development, npm run build:data regenerates data, npm test runs all pure and contract tests, and npm run build produces both browser packages. The distributables are written under web-ext-artifacts/; each runtime ZIP must remain below 38,600,000 bytes.
## Offline data architecture

- `annotate-dat.txt` and `pinyin-web-engine.js` provide offline Pinyin/Jyutping annotation.
- `ccedict-glosses-*.json` and `lexicon-data/classifiers.json` are deterministic runtime projections of the pinned CC-CEDICT snapshot. The background boundary returns normalized structured entries.
- `hsk-data.json` provides bundled HSK labels.
- `stroke-data/*.bin` contains on-demand opcode/delta-encoded HanziWriter data. The original `hanzi-writer-data.json` remains source-only.
- User settings stay in extension local storage. Vocabulary, contexts, reviews, and custom dictionary entries stay in the extension's user IndexedDB database.

Annotation, dictionaries, review, conversion, and stroke practice do not require runtime network requests. Azure Neural speech is the only extension-initiated network feature and remains off until the user configures it. Annotation caches and rebuildable indexes are excluded from backups.

## Privacy and licensing

Page text, saved sentences, review history, and optional source URLs remain local to the browser. URL storage is disabled by default. See [PRIVACY.md](PRIVACY.md), [THIRD-PARTY.md](THIRD-PARTY.md), and [SOURCES.md](SOURCES.md).

First-party code is MIT licensed; bundled libraries and datasets retain their respective licenses and attribution.
