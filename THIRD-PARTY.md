# Third-Party Components and Attribution

Combined Chinese Annotator bundles the following libraries and datasets. Their upstream licenses continue to apply.

| Component | Source | License |
|---|---|---|
| OpenCC-JS (`opencc.js`) | `https://github.com/nk2028/opencc-js`, using OpenCC data from `https://github.com/BYVoid/OpenCC` | Apache License 2.0 |
| HanziWriter (`hanzi-writer.min.js`) | `https://github.com/chanind/hanzi-writer` | MIT |
| Stroke graphics (`hanzi-writer-data.json`, generated `stroke-data/*.bin`) | `https://github.com/chanind/hanzi-writer-data`, derived from Make Me a Hanzi `https://github.com/skishore/makemeahanzi` | Data retains Arphic Public License/LGPL-3.0 terms; package code MIT |
| CC-CEDICT (`ccedict-glosses-*.json`, `lexicon-data/*`) | `https://cc-cedict.org/` and the MDBG official export | CC BY-SA 4.0 |
| Annotator Generator output (`pinyin-web-engine.js`, `annotate-dat.txt`) | `https://ssb22.user.srcf.net/adjuster/annogen.html` | Apache License 2.0 for the upstream generator; generated-data terms remain those of its included sources |
| HSK labels (`hsk-data.json`) | HSK 3.0 / Chinese Proficiency Grading Standards-derived word list | Retain the source list's applicable terms; this extension makes no authorship claim over the standard |

## CC-CEDICT notice

CC-CEDICT is community-maintained dictionary data published by MDBG under Creative Commons Attribution-ShareAlike 4.0. The pinned snapshot, hashes, deterministic projection process, and download location are documented in `SOURCES.md`. Generated runtime projections remain under CC BY-SA 4.0.

## Store review

`opencc.js`, `hanzi-writer.min.js`, and `pinyin-web-engine.js` are bundled third-party releases. Their readable upstream sources are listed in `SOURCES.md`. First-party files are shipped unminified.
