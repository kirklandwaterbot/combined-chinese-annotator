# Privacy Policy — Combined Chinese Annotator

_Last updated: 2026-07-07_

**Combined Chinese Annotator does not collect, transmit, or sell any personal
data.** Everything the extension does happens locally in your browser.

## What the extension stores (locally only)
- **Your settings** (which annotations are shown, colors, theme, voices, copy
  format, per-site disable list) — kept in the browser's local extension storage.
- **Saved words** — the flashcard list you build with the "Save" button, kept in
  local extension storage.
- **Dictionaries and stroke data** — CC-CEDICT glosses, the HSK word list, and
  stroke-order data are imported once into the browser's local IndexedDB purely
  as a cache for performance.
- **An annotation cache** — recently computed annotations, cached locally to
  avoid recomputation.

All of the above stays on your device. None of it is sent anywhere.

## What the extension does NOT do
- It makes **no network requests to any server**. All dictionary, phonetic, and
  stroke data is bundled with the extension and processed offline.
- It does **not** use analytics, tracking, cookies, or third-party services.
- It does **not** read or exfiltrate page content beyond what is needed to render
  annotations locally in your browser.

## Permissions
- **Host access (`<all_urls>`)** and **content scripts** — required to read
  Chinese text on the pages you visit so it can be annotated in place. Text is
  processed locally and never leaves your browser.
- **`storage`** — to save your settings and word list on your device.
- **`scripting`** — to load the stroke-order library into a page only when you
  open the stroke-order viewer.
- **`contextMenus`** — to add the right-click actions (convert, read aloud,
  stroke order).

## Contact
Questions about this policy can be directed to the extension's listing page.
