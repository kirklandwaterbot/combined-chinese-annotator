# Privacy Policy — Combined Chinese Annotator

_Last updated: 2026-09-26_

Combined Chinese Annotator does not collect, sell, or share personal data with the extension developer. Annotation, dictionary lookup, review, conversion, and stroke practice run locally in the browser. Speech behavior is described below. The extension includes no analytics, trackers, advertising, or cookies.

## Data stored locally

- Global settings and hostname-based site profiles are stored in extension local storage.
- Vocabulary, up to five saved sentence contexts per word, review history, notes, tags, and custom dictionary entries are stored in a versioned extension IndexedDB database.
- Source page URLs are stored only when the user enables that option. URL storage is off by default.
- Bundled dictionaries, compact stroke shards, annotation caches, and rebuildable indexes are local extension data. Caches and rebuildable indexes are not included in user backups.
- Complete backups contain the user's settings, site profiles, vocabulary, contexts, reviews, and custom dictionary entries. Export occurs only when the user explicitly requests it.
- If the user enables Azure Neural speech, the Azure resource key and region are stored in extension-local storage. The key is never displayed after saving and is excluded from manual and automatic extension backups.
- The Speech panel keeps a rolling local diagnostic log of at most 200 TTS events so intermittent failures can be inspected. It records timestamps, request identifiers, selected engine/voice/region, text length, timing, HTTP status, audio size/type, playback states, and sanitized errors. It never records spoken text, page addresses, Azure keys, SSML, or returned audio. The user can copy or clear this log at any time, and it is excluded from extension backups.

All of this data remains on the user's device unless the user manually exports a backup, TSV/Anki file, or page content.

## Page access

The extension reads visible page text to render annotations and Reader mode locally. It leaves provider caption and subtitle nodes unchanged. Page content is not uploaded or retained as browsing history.

Google Docs, Slides, Sheets, and Microsoft Office web editors render selections in canvas-based surfaces that do not expose selected text to ordinary browser extensions. Copied-text compatibility is enabled by default and lets the user explicitly copy a selection and then invoke an extension action. The extension reads clipboard text only after the user invokes a read-aloud, Reader, or stroke-order action. Clipboard text is not stored, logged, or read in the background. The user can disable compatibility in the Speech panel to stop clipboard reads. If Azure speech is selected, the requested copied text is handled under the Azure speech terms below.

## Permissions

- `<all_urls>` and content scripts: read and annotate eligible Chinese text on pages the user visits.
- `storage`: keep settings, site profiles, caches, and migration state locally.
- `scripting`: load the bundled stroke-order viewer only when requested.
- `contextMenus`: provide Reader, conversion, speech, and stroke-order actions.
- `clipboardRead`: support text the user explicitly copied from Google or Microsoft canvas editors. Compatibility is enabled by default but can be disabled in the Speech panel; the extension never reads the clipboard until the user invokes a supported action.

## Speech and optional Azure Neural voices

- The default Browser / Windows engine uses the Web Speech API. Local voices stay on the device. Browser-provided online voices may process spoken text under the browser vendor's privacy terms.
- Azure Neural speech is the default selected engine. It remains inactive and sends nothing until the user saves an Azure Speech resource key and region, grants Firefox's optional data-transmission permission, and explicitly requests speech.
- When Azure Neural speech is enabled, only the text the user explicitly asks the extension to read, the Azure resource key, and the synthesis options are sent directly to the regional Microsoft Azure Speech endpoint. The returned audio is held temporarily in browser memory for playback and is not saved by the extension.
- The extension does not send the page URL, browsing history, saved vocabulary, annotations, or other page content with an Azure speech request.
- The Azure resource owner controls the Speech resource, billing, retention, and applicable Microsoft terms. Clearing the key in the Speech panel removes it from extension-local storage.

Questions can be directed to the extension's store listing.
