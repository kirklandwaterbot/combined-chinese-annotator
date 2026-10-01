// Reproducibly builds the extension's compact CC-CEDICT runtime projection.
// The pinned upstream gzip is retained for source review and excluded from the
// package. Runtime files are plain JSON and need no decompression library.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const ROOT = __dirname;
const SOURCE = path.join(ROOT, "data-sources", "cedict_1_0_ts_utf-8_mdbg.txt.gz");
const OUTPUT = path.join(ROOT, "lexicon-data");
const CHUNK_TARGET = 4_500_000;

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function hasHan(value) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(value);
}

function parseClassifier(value) {
  const match = String(value).trim().match(/^([^|[\]]+)(?:\|([^\[\]]+))?\[([^\]]+)\]$/u);
  if (!match) return [String(value).trim(), "", ""];
  return match[2] ? [match[1], match[2], match[3]] : [match[1], match[1], match[3]];
}

function parseEntry(line) {
  const match = line.match(/^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+\/(.*)\/$/u);
  if (!match) return null;
  const senses = [];
  const classifiers = [];
  for (const definition of match[4].split("/").map((value) => value.trim()).filter(Boolean)) {
    if (definition.startsWith("CL:")) classifiers.push(...definition.slice(3).split(",").map(parseClassifier));
    else senses.push(definition);
  }
  return { traditional: match[1], simplified: match[2], senses, classifiers };
}

function writeRecordChunks(records, metadata) {
  const chunks = [];
  let current = [];
  let estimated = 2;
  for (const record of records) {
    const addition = Buffer.byteLength(JSON.stringify(record)) + 1;
    if (current.length && estimated + addition > CHUNK_TARGET) {
      chunks.push(current);
      current = [];
      estimated = 2;
    }
    current.push(record);
    estimated += addition;
  }
  if (current.length) chunks.push(current);
  chunks.forEach((chunk, index) => {
    const payload = { _meta: metadata, _chunk: { index, total: chunks.length }, records: chunk };
    fs.writeFileSync(path.join(ROOT, `ccedict-glosses-${index + 1}.json`), JSON.stringify(payload));
  });
  for (let index = chunks.length + 1; fs.existsSync(path.join(ROOT, `ccedict-glosses-${index}.json`)); index++) {
    fs.unlinkSync(path.join(ROOT, `ccedict-glosses-${index}.json`));
  }
  return chunks.length;
}

function build() {
  const compressed = fs.readFileSync(SOURCE);
  const source = zlib.gunzipSync(compressed);
  const lines = source.toString("utf8").split(/\r?\n/u);
  const byVariantPair = new Map();
  const classifierForms = Object.create(null);
  let sourceDate = "";
  let declaredEntries = 0;
  let parsedEntries = 0;

  for (const line of lines) {
    if (line.startsWith("#! date=")) sourceDate = line.slice(8).trim();
    if (line.startsWith("#! entries=")) declaredEntries = Number(line.slice(11)) || 0;
    if (!line || line.startsWith("#")) continue;
    const entry = parseEntry(line);
    if (!entry) throw new Error(`Could not parse CC-CEDICT entry: ${line}`);
    if (hasHan(entry.traditional) || hasHan(entry.simplified)) {
      const pairKey = `${entry.traditional}\u0000${entry.simplified}`;
      const existing = byVariantPair.get(pairKey) || { traditional: entry.traditional, simplified: entry.simplified, senses: [] };
      existing.senses = unique([...existing.senses, ...entry.senses]);
      byVariantPair.set(pairKey, existing);
      for (const form of new Set([entry.traditional, entry.simplified])) {
        if (!entry.classifiers.length) continue;
        const known = classifierForms[form] || [];
        classifierForms[form] = unique([...known.map(JSON.stringify), ...entry.classifiers.map(JSON.stringify)]).map(JSON.parse);
      }
    }
    parsedEntries++;
  }
  if (declaredEntries && parsedEntries !== declaredEntries) throw new Error(`Expected ${declaredEntries} entries, parsed ${parsedEntries}`);

  const records = [...byVariantPair.values()]
    .sort((left, right) => left.simplified.localeCompare(right.simplified, "zh-Hans-CN") || left.traditional.localeCompare(right.traditional, "zh-Hant-TW"))
    .map((entry) => [entry.traditional, entry.simplified, entry.senses.join("; ")]);
  const forms = new Set(records.flatMap((record) => [record[0], record[1]]));
  let maxKeyLength = 1;
  for (const form of forms) maxKeyLength = Math.max(maxKeyLength, Array.from(form).length);
  const metadata = {
    dataVersion: "2026-08-04.1",
    source: "CC-CEDICT",
    format: "v1 ts UTF-8",
    license: "CC BY-SA 4.0",
    sourceDate,
    sourceUrl: "https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz",
    sourceGzipSha256: sha256(compressed),
    sourceTextSha256: sha256(source),
    sourceEntries: parsedEntries,
    records: records.length,
    entries: forms.size,
    maxKeyLength,
    recordSchema: ["traditional", "simplified", "semicolon-delimited senses"],
    runtimeProjection: {
      definitions: "separate senses parsed at the background boundary",
      classifiers: "compact [traditional, simplified, Mandarin] arrays",
      variants: "traditional and simplified forms are indexed transactionally during local import",
      mandarin: "resolved by the bundled offline phonetic engine"
    }
  };
  fs.mkdirSync(OUTPUT, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT, "classifiers.json"), JSON.stringify(classifierForms));
  fs.writeFileSync(path.join(OUTPUT, "metadata.json"), JSON.stringify(metadata, null, 2));
  const chunks = writeRecordChunks(records, metadata);
  return { ...metadata, chunks, classifierForms: Object.keys(classifierForms).length };
}

const result = build();
console.log(`Built ${result.records} records / ${result.entries} lookup forms from ${result.sourceEntries} CC-CEDICT entries in ${result.chunks} chunks.`);
console.log(`Classifier data covers ${result.classifierForms} forms.`);
console.log(`Source gzip SHA-256: ${result.sourceGzipSha256}`);

