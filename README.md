# Combined Chinese Annotator

A browser extension (Firefox & Chrome, Manifest V3) that adds **Jyutping,
Pinyin, and offline English gloss** annotations on top of Chinese text on any
web page — plus stroke-order practice, read-aloud, Simplified/Traditional
conversion, a saved-word list, and HSK 3.0 levels. Everything runs **offline**;
no data ever leaves your browser.

## Features
- Toggle **Pinyin**, **Jyutping**, and **English** annotations per page (keyboard shortcuts `Alt+Shift+P/J/E`).
- Tone coloring with customizable colors, and a light/dark/auto **theme** with a custom accent color.
- **Dictionary popup** on click (English/Jyutping/Pinyin) with a **Save** button that builds a flashcard list (export to **Anki** or CSV).
- **Stroke-order viewer** with animation, practice mode, and speed control.
- **Read aloud** selected text in Cantonese, Mandarin, or English.
- **Simplified ⇄ Traditional** page conversion (OpenCC).
- **HSK 3.0** level display.
- **Annotate-on-hover** mode and per-site disable.

## Install (from source)
**Firefox:** `about:debugging` → This Firefox → Load Temporary Add-on → pick `manifest.json`.
**Chrome:** `chrome://extensions` → Developer mode → Load unpacked → select this folder.

## Build for Review (Mozilla Add-on Source Code Submission)

### Build environment
- **Operating system:** Windows, macOS, or Linux
- **Node.js:** v22.14.0 or later ([download](https://nodejs.org/))
- **npm:** v10.x (bundled with Node.js)

### Build steps
```bash
# 1. Install the build tool (web-ext)
npm install

# 2. Split large data files into chunks under 5 MB
#    (Mozilla's validator cannot parse files larger than 5 MB)
node split-data.js

# 3. Build the extension package
npm run build
```

The built extension will be at `web-ext-artifacts/combined_chinese_annotator-0.1.0.zip`.

### What the build does
1. **`npm install`** — installs `web-ext` (the Mozilla build/lint tool) into `node_modules/`. The `package-lock.json` ensures reproducible installs.
2. **`node split-data.js`** — reads the original data files (`ccedict-glosses.json`, `hanzi-writer-data.json`) and splits them into chunks under 5 MB each. The chunk files are what ship in the extension; the originals are excluded via `--ignore-files` in the build script.
3. **`npm run build`** — runs `web-ext build` which creates the ZIP. It respects `.web-extignore` (excluding `node_modules/`, tests, dev tools, and the original unsplit data files).

### Source code notes
- **All extension source files are plain, unminified JavaScript** — `content.js`, `background.js`, `popup.js`, `converter.js`, `opencc.js`, `pinyin-web-engine.js`, `theme-init.js`, `test-page.js`.
- **`hanzi-writer.min.js`** is the only minified file. It is the standard distribution of [HanziWriter](https://github.com/chanind/hanzi-writer) (MIT license, open source). The unminified source is available at that repository.
- **Data chunk files** (`ccedict-glosses-*.json`, `hanzi-writer-data-*.json`) are machine-generated from the original data files by `split-data.js`. The originals are included in this source package for verification.

## Development
```bash
npm install        # installs web-ext (dev only)
npm test           # runs the engine/dictionary regression tests
npm run lint       # web-ext lint (store validation)
npm run build      # builds a distributable package (respects .web-extignore)
```

## Data & performance
Large dictionaries (CC-CEDICT, HSK) and stroke-order data are imported once into
**IndexedDB** and queried on demand, so they don't sit in the service-worker
heap. The original data files are split into chunks under 5 MB for Mozilla
validator compliance; `background.js` uses `loadChunkedJSON()` to transparently
load and merge them at runtime.

## Privacy & licensing
- **Privacy:** no data is collected or transmitted — see [PRIVACY.md](PRIVACY.md).
- **This code:** MIT — see [LICENSE](LICENSE).
- **Bundled third-party libraries and data** (OpenCC, HanziWriter, CC-CEDICT,
  stroke data, HSK list, phonetic engine): each under its own license — see
  [THIRD-PARTY.md](THIRD-PARTY.md).
