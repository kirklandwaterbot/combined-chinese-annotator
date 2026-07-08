# Source Code Disclosure (for addons.mozilla.org review)

addons.mozilla.org requires human-readable source (or upstream references +
build steps) for any minified, concatenated, or machine-generated code. This
extension's own code (`background.js`, `content.js`, `popup.js`, `converter.js`,
`annotation.css`, `popup.css`, `popup.html`, `manifest.json`) is hand-written and
already human-readable — no build step is applied to it.

The following bundled files are **unmodified third-party releases**; their
readable source lives upstream:

| Bundled file | Upstream project | How to obtain the readable source |
|---|---|---|
| `opencc.js` | opencc-js | https://github.com/nk2028/opencc-js — released build; source + build (`npm run build`) in the repo |
| `converter.js` | (first-party wrapper) | Already human-readable in this repo |
| `hanzi-writer.min.js` | hanzi-writer | https://github.com/chanind/hanzi-writer — `dist/hanzi-writer.js` (unminified) and build in the repo |
| `pinyin-web-engine.js` | Annotator Generator (annogen) output | https://ssb22.user.srcf.net/adjuster/annogen.html — generator source and instructions |

## Generated data files (not code)
These are data, not executable source; they are consumed as-is:

- `annotate-dat.txt` — phonetic index consumed by `pinyin-web-engine.js`.
- `ccedict-glosses.json` — pre-processed CC-CEDICT lookup table.
- `hsk-data.json` — HSK 3.0 word→level lookup table.
- `hanzi-writer-data.json` — the ~9,574 per-character stroke files from the
  `hanzi-writer-data` package, concatenated into one `{ "字": {...} }` map. To
  reproduce: take the `hanzi-writer-data/` directory (one JSON per character) and
  build `{ filename-without-.json : file-contents }`.

> This file is excluded from the packaged extension (see `.web-extignore`); it is
> for reviewers and is uploaded as the "source code" attachment during AMO review.
