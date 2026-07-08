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
heap. Stroke data ships as a single bundle (`hanzi-writer-data.json`); to
regenerate it from the per-character source files in `hanzi-writer-data/`:

```bash
node -e 'const fs=require("fs"),p=require("path");const d="hanzi-writer-data";const o=fs.createWriteStream("hanzi-writer-data.json");o.write("{");let f=1;for(const x of fs.readdirSync(d).filter(n=>n.endsWith(".json")&&n!=="package.json")){o.write((f?"":",")+JSON.stringify(x.slice(0,-5))+":"+fs.readFileSync(p.join(d,x),"utf8").trim());f=0}o.end(()=>o.write("}"))'
```

## Privacy & licensing
- **Privacy:** no data is collected or transmitted — see [PRIVACY.md](PRIVACY.md).
- **This code:** MIT — see [LICENSE](LICENSE).
- **Bundled third-party libraries and data** (OpenCC, HanziWriter, CC-CEDICT,
  stroke data, HSK list, phonetic engine): each under its own license — see
  [THIRD-PARTY.md](THIRD-PARTY.md).
