# Source Code and Generated Data Disclosure

This document is intended for addons.mozilla.org source review. First-party extension code is plain, readable JavaScript, HTML, and CSS. No bundler, transpiler, obfuscator, or minifier is applied to first-party code.

## Reproducible build

Use Node.js 22.14 or newer and npm 10.x:

```bash
npm install
npm run build:data
npm test
npm run lint
npm run build
```

`manifest.json` is the Chrome Manifest V3 source and uses `background.service_worker`. `manifest.firefox.json` is the Firefox 140+ source and uses `background.scripts`; `build-extension.js` stages it as `web-ext-artifacts/firefox-unpacked/manifest.json` and builds separate Chrome and Firefox ZIPs.

`build-lexicon.js` reads the pinned CC-CEDICT gzip in `data-sources/`, verifies/parses its declared entry count, and deterministically writes review-safe gloss chunks plus compact classifier arrays and metadata. `build-data.js` reads `hanzi-writer-data.json`, writes 64 compact binary shards, and verifies every decoded record against the source within the documented 0.0005-unit coordinate tolerance.

The pinned source snapshots and build scripts are included in the source submission but excluded from the runtime ZIP through `.web-extignore`.

## Pinned data versions

### CC-CEDICT

- Runtime data version: `2026-08-04.1`
- Upstream format: CC-CEDICT v1 `ts`, UTF-8
- Snapshot timestamp: `2026-08-04T08:01:42Z`
- Declared entries: 124,758
- Download: `https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz`
- Gzip SHA-256: `ec2770cf2002b7b877b16c0273d310d6856d57cabd5d4dc252308a91d536c7d7`
- Text SHA-256: `f3183b6d6b2b976736639002daf756e9e9be2837a44b1d0ea5d80b27a9892e1f`
- License: CC BY-SA 4.0

The runtime projection indexes Traditional and Simplified forms independently, retains separate senses at the background API boundary, and stores classifiers as `[Traditional, Simplified, Mandarin]` arrays. The bundled phonetic engine supplies offline word readings; the background returns normalized structured entries with variants, Pinyin, Jyutping, senses, classifiers, references, and HSK where available.

### Stroke data

- Source: `hanzi-writer-data.json`
- Source SHA-256: `ee4a5f07cb959819c3457511fed69748bf50ab3c9dfb61037f074746376fe604`
- Characters: 9,574
- Runtime shards: 64
- Encoding: SVG command opcodes plus ZigZag delta-varint coordinates at millith-unit precision (maximum 0.0005-unit error)

## Bundled third-party code

| Runtime file | Readable upstream source |
|---|---|
| `opencc.js` | `https://github.com/nk2028/opencc-js` |
| `hanzi-writer.min.js` | `https://github.com/chanind/hanzi-writer` |
| `pinyin-web-engine.js`, `annotate-dat.txt` | Annotator Generator: `https://ssb22.user.srcf.net/adjuster/annogen.html` |

`converter.js`, `core.js`, `user-store.js`, `background.js`, `content.js`, `overlay.js`, `popup-v2.js`, and all CSS/HTML are readable first-party source in this repository.
