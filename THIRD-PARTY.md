# Third-Party Components & Attribution

Combined Chinese Annotator bundles the following third-party libraries and data
sets. Their respective licenses apply to those files. **Verify the two items
marked ⚠️ against their upstream sources before publishing**, as their exact
license/provenance should be confirmed by the maintainer.

| Component (file) | Source | License |
|---|---|---|
| OpenCC-JS (`opencc.js`, `converter.js`) | https://github.com/nk2028/opencc-js — bundles data from https://github.com/BYVoid/OpenCC | Apache License 2.0 |
| HanziWriter (`hanzi-writer.min.js`) | https://github.com/chanind/hanzi-writer | MIT License |
| Stroke-order graphics (`hanzi-writer-data.json`) | Derived from *Make Me a Hanzi* — https://github.com/skishore/makemeahanzi (via the `hanzi-writer-data` package) | Graphics data: **Arphic Public License** (characters derived from Arphic fonts) and **LGPL-3.0**; packaging code MIT |
| CC-CEDICT glosses (`ccedict-glosses.json`) | CC-CEDICT — https://www.mdbg.net/chinese/dictionary?page=cc-cedict | **Creative Commons Attribution-ShareAlike 4.0** (CC BY-SA 4.0) |
| ⚠️ Phonetic annotation engine (`pinyin-web-engine.js`, `annotate-dat.txt`) | Believed to originate from Silas S. Brown's *Annotator Generator* (annogen) — https://ssb22.user.srcf.net/adjuster/annogen.html | **Verify upstream license** (annogen is distributed under the Apache License 2.0; confirm the generated data's terms) |
| ⚠️ HSK 3.0 word list (`hsk-data.json`) | HSK 3.0 / *Chinese Proficiency Grading Standards* word list | **Verify source & terms** for the specific list used |

## Notes for store submission

- **CC-CEDICT is share-alike (CC BY-SA).** Attribution above satisfies the
  attribution requirement; keep this file shipped with the extension. If you
  modify the gloss data, the modifications must also be shared under CC BY-SA.
- **Stroke data** originates from Arphic fonts via Make Me a Hanzi; the Arphic
  Public License and LGPL attribution above must be preserved.
- The minified/bundled libraries (`opencc.js`, `hanzi-writer.min.js`,
  `pinyin-web-engine.js`) are unmodified third-party releases — see
  `SOURCES.md` for upstream/build details required by addons.mozilla.org.
