const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const root = path.resolve(__dirname, "..");
const metadata = JSON.parse(fs.readFileSync(path.join(root, "lexicon-data", "metadata.json"), "utf8"));
const classifiers = JSON.parse(fs.readFileSync(path.join(root, "lexicon-data", "classifiers.json"), "utf8"));
const gzip = fs.readFileSync(path.join(root, "data-sources", "cedict_1_0_ts_utf-8_mdbg.txt.gz"));
const source = zlib.gunzipSync(gzip);

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

assert.strictEqual(hash(gzip), metadata.sourceGzipSha256, "pinned CC-CEDICT gzip checksum changed");
assert.strictEqual(hash(source), metadata.sourceTextSha256, "decompressed CC-CEDICT checksum changed");
assert.strictEqual(metadata.sourceEntries, 124758);
assert.strictEqual(metadata.dataVersion, "2026-08-04.1");
assert.ok(metadata.runtimeProjection?.classifiers.includes("traditional"));

const chunks = [];
const records = [];
for (let index = 1; ; index++) {
  const filename = path.join(root, `ccedict-glosses-${index}.json`);
  if (!fs.existsSync(filename)) break;
  const chunk = JSON.parse(fs.readFileSync(filename, "utf8"));
  assert.strictEqual(chunk._chunk.index, index - 1);
  assert.strictEqual(chunk._chunk.total, 2);
  assert.ok(fs.statSync(filename).size < 5_000_000, `${path.basename(filename)} exceeds the review limit`);
  chunks.push(chunk);
  records.push(...chunk.records);
}
const entries = Object.create(null);
for (const [traditional, simplified, gloss] of records) {
  for (const form of new Set([traditional, simplified])) entries[form] = entries[form] ? `${entries[form]}; ${gloss}` : gloss;
}
assert.strictEqual(chunks.length, 2);
assert.strictEqual(records.length, metadata.records);
assert.strictEqual(Object.keys(entries).length, metadata.entries);
assert.match(entries["书"], /book/u);
assert.match(entries["中國"], /China/u);
assert.deepStrictEqual(classifiers["书"][0], ["本", "本", "ben3"]);
assert.deepStrictEqual(classifiers["書"], classifiers["书"]);

console.log("Lexicon tests passed: pinned source, deterministic chunks, variants, and classifiers.");

