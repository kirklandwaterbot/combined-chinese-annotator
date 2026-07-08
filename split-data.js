// Splits large JSON data files into chunks under 5MB for Mozilla Add-on validation.
// Uses actual byte counting to ensure chunks stay under the limit.
// Run: node split-data.js

const fs = require("fs");

const MAX_SIZE = 4.5 * 1024 * 1024; // 4.5MB max per chunk

function splitByByteSize(filePath, chunkPrefix, keyToSplit) {
  const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  const entries = data[keyToSplit];
  const keys = Object.keys(entries);

  // Build meta (everything except the entries)
  const meta = { ...data };
  delete meta[keyToSplit];
  const metaBytes = JSON.stringify(meta).length;

  const chunks = [];
  let currentChunk = {};
  let currentBytes = metaBytes + 50; // overhead for _chunk field

  for (const key of keys) {
    const entryBytes = JSON.stringify(key).length + JSON.stringify(entries[key]).length + 8;
    if (currentBytes + entryBytes > MAX_SIZE && Object.keys(currentChunk).length > 0) {
      chunks.push(currentChunk);
      currentChunk = {};
      currentBytes = metaBytes + 50;
    }
    currentChunk[key] = entries[key];
    currentBytes += entryBytes;
  }
  if (Object.keys(currentChunk).length > 0) chunks.push(currentChunk);

  console.log(`${filePath}: ${keys.length} entries → ${chunks.length} chunks`);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = { ...meta, [keyToSplit]: chunks[i], _chunk: { index: i, total: chunks.length } };
    const chunkPath = filePath.replace(".json", `-${i + 1}.json`);
    fs.writeFileSync(chunkPath, JSON.stringify(chunk));
    const sizeMB = (fs.statSync(chunkPath).size / (1024 * 1024)).toFixed(2);
    console.log(`  → ${chunkPath} (${sizeMB} MB, ${Object.keys(chunks[i]).length} entries)`);
  }
}

function splitHanziWriterByByteSize(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  const keys = Object.keys(data);

  const chunks = [];
  let currentChunk = {};
  let currentBytes = 50; // overhead for _chunk field

  for (const key of keys) {
    const entryBytes = JSON.stringify(key).length + JSON.stringify(data[key]).length + 8;
    if (currentBytes + entryBytes > MAX_SIZE && Object.keys(currentChunk).length > 0) {
      chunks.push(currentChunk);
      currentChunk = {};
      currentBytes = 50;
    }
    currentChunk[key] = data[key];
    currentBytes += entryBytes;
  }
  if (Object.keys(currentChunk).length > 0) chunks.push(currentChunk);

  console.log(`\n${filePath}: ${keys.length} entries → ${chunks.length} chunks`);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = { ...chunks[i], _chunk: { index: i, total: chunks.length } };
    const chunkPath = filePath.replace(".json", `-${i + 1}.json`);
    fs.writeFileSync(chunkPath, JSON.stringify(chunk));
    const sizeMB = (fs.statSync(chunkPath).size / (1024 * 1024)).toFixed(2);
    console.log(`  → ${chunkPath} (${sizeMB} MB, ${Object.keys(chunks[i]).length} entries)`);
  }
}

// Split ccedict-glosses.json
splitByByteSize("ccedict-glosses.json", "ccedict-glosses", "entries");

// Split hanzi-writer-data.json
splitHanziWriterByByteSize("hanzi-writer-data.json");

console.log("\nDone. Update background.js to load chunks and merge them.");