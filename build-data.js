// Reproducible compact stroke-data build for the store artifact.
// Run with Node.js from this directory: node build-data.js
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const codec = require("./stroke-codec-v2.js");

const ROOT = __dirname;
const STROKE_SOURCE = path.join(ROOT, "hanzi-writer-data.json");
const STROKE_OUTPUT = path.join(ROOT, "stroke-data");
const SHARD_COUNT = 64;
const OPCODES = { M: 0, Q: 1, L: 2, C: 3, Z: 4 };
const ARITY = { M: 2, Q: 4, L: 2, C: 6, Z: 0 };
const VERIFY_TOLERANCE = 0.000501;

function writeUnsigned(bytes, raw) {
  let value = raw >>> 0;
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
}

function pathSegments(pathData) {
  const tokens = String(pathData).match(/[MLQCZ]|-?\d+(?:\.\d+)?/g) || [];
  const segments = [];
  let command = "";
  for (let index = 0; index < tokens.length;) {
    if (tokens[index] in OPCODES) command = tokens[index++];
    if (!(command in OPCODES)) throw new Error(`Unsupported path token ${tokens[index]}`);
    const segment = [command];
    for (let count = 0; count < ARITY[command]; count++) {
      if (index >= tokens.length || tokens[index] in OPCODES) throw new Error(`Missing coordinate for ${command}`);
      segment.push(Number(tokens[index++]));
    }
    segments.push(segment);
    if (command === "M") command = "L";
    if (command === "Z") command = "";
  }
  return segments;
}

function normalizedPath(pathData) {
  return pathSegments(pathData).flat().join(" ");
}

function shardName(character) {
  return (character.codePointAt(0) % SHARD_COUNT).toString(16).padStart(2, "0");
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function numericTokens(value) {
  return (String(value).match(/[MLQCZ]|-?\d+(?:\.\d+)?/g) || []).map((token) => token in OPCODES ? token : Number(token));
}

function pathMatches(decoded, source) {
  const left = numericTokens(decoded);
  const right = numericTokens(normalizedPath(source));
  return left.length === right.length && left.every((value, index) => typeof value === "string" ? value === right[index] : Math.abs(value - right[index]) <= VERIFY_TOLERANCE);
}

function mediansMatch(left, right) {
  return left.length === right.length && left.every((points, stroke) => points.length === right[stroke].length && points.every((point, index) =>
    Math.abs(point[0] - right[stroke][index][0]) <= VERIFY_TOLERANCE &&
    Math.abs(point[1] - right[stroke][index][1]) <= VERIFY_TOLERANCE
  ));
}

function encodeShard(entries) {
  const bytes = [3];
  writeUnsigned(bytes, entries.length);
  for (const [character, record] of entries) {
    writeUnsigned(bytes, character.codePointAt(0));
    writeUnsigned(bytes, record[0].length);
    for (const stroke of record[0]) {
      writeUnsigned(bytes, stroke.length);
      bytes.push(...stroke);
    }
    writeUnsigned(bytes, record[1].length);
    bytes.push(...record[1]);
  }
  return Buffer.from(bytes);
}

function buildStrokes() {
  const source = JSON.parse(fs.readFileSync(STROKE_SOURCE, "utf8"));
  const shards = Array.from({ length: SHARD_COUNT }, () => []);
  let verified = 0;
  for (const [character, value] of Object.entries(source)) {
    const record = codec.encodeSourceRecord(value);
    const roundTrip = codec.decodeRecord(record);
    if (roundTrip.strokes.length !== value.strokes.length || roundTrip.medians.length !== value.medians.length) throw new Error(`Stroke count mismatch for ${character}`);
    for (let index = 0; index < value.strokes.length; index++) {
      if (!pathMatches(roundTrip.strokes[index], value.strokes[index])) throw new Error(`Path mismatch for ${character} stroke ${index}`);
      if (!mediansMatch([roundTrip.medians[index]], [value.medians[index]])) throw new Error(`Median mismatch for ${character} stroke ${index}`);
    }
    shards[parseInt(shardName(character), 16)].push([character, record]);
    verified++;
  }
  fs.mkdirSync(STROKE_OUTPUT, { recursive: true });
  for (const filename of fs.readdirSync(STROKE_OUTPUT)) {
    if (/\.(?:json|bin)$/u.test(filename)) fs.unlinkSync(path.join(STROKE_OUTPUT, filename));
  }
  for (let index = 0; index < shards.length; index++) {
    fs.writeFileSync(path.join(STROKE_OUTPUT, `${index.toString(16).padStart(2, "0")}.bin`), encodeShard(shards[index]));
  }
  const metadata = {
    version: 3,
    source: "hanzi-writer-data.json",
    sourceSha256: sha256(STROKE_SOURCE),
    characters: verified,
    shards: SHARD_COUNT,
    encoding: "Binary shards with SVG command opcodes and ZigZag delta-varint coordinates at millith-unit precision (maximum 0.0005-unit error)"
  };
  fs.writeFileSync(path.join(STROKE_OUTPUT, "metadata.json"), JSON.stringify(metadata, null, 2));
  return metadata;
}

const result = buildStrokes();
console.log(`Built ${result.characters} compact stroke records in ${result.shards} shards.`);
console.log(`Source SHA-256: ${result.sourceSha256}`);

