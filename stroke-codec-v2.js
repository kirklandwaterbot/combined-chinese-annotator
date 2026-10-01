(function initCompactStrokeCodec(global) {
  "use strict";
  const COMMANDS = ["M", "Q", "L", "C", "Z"];
  const OPCODES = { M: 0, Q: 1, L: 2, C: 3, Z: 4 };
  const ARITY = [2, 4, 2, 6, 0];

  function asBytes(value) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new Error("Stroke payload must be binary");
  }

  function writeUnsigned(bytes, raw) {
    let value = raw >>> 0;
    do {
      let byte = value & 0x7f;
      value >>>= 7;
      if (value) byte |= 0x80;
      bytes.push(byte);
    } while (value);
  }

  function readUnsigned(bytes, cursor) {
    let value = 0;
    let shift = 0;
    while (cursor.index < bytes.length) {
      const byte = bytes[cursor.index++];
      value |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) return value >>> 0;
      shift += 7;
      if (shift > 28) throw new Error("Invalid stroke varint");
    }
    throw new Error("Truncated stroke varint");
  }

  function writeSigned(bytes, value) {
    writeUnsigned(bytes, ((value << 1) ^ (value >> 31)) >>> 0);
  }

  function readSigned(bytes, cursor) {
    const value = readUnsigned(bytes, cursor);
    return (value >>> 1) ^ -(value & 1);
  }

  function decimalPlaces(value) {
    const text = String(value).toLowerCase();
    if (!text.includes("e")) return (text.split(".")[1] || "").length;
    const [coefficient, exponentText] = text.split("e");
    return Math.max(0, (coefficient.split(".")[1] || "").length - Number(exponentText));
  }

  function scaleFor(values) {
    const exponent = Math.min(3, values.reduce((maximum, value) => Math.max(maximum, decimalPlaces(value)), 0));
    return { exponent, value: 10 ** exponent };
  }

  function pathSegments(pathData) {
    const tokens = String(pathData).match(/[MLQCZ]|-?\d+(?:\.\d+)?/g) || [];
    const segments = [];
    let command = "";
    for (let index = 0; index < tokens.length;) {
      if (tokens[index] in OPCODES) command = tokens[index++];
      if (!(command in OPCODES)) throw new Error(`Unsupported path token ${tokens[index]}`);
      const values = [];
      for (let count = 0; count < ARITY[OPCODES[command]]; count++) {
        if (index >= tokens.length || tokens[index] in OPCODES) throw new Error(`Missing coordinate for ${command}`);
        values.push(Number(tokens[index++]));
      }
      segments.push([command, values]);
      if (command === "M") command = "L";
      if (command === "Z") command = "";
    }
    return segments;
  }

  function encodePath(pathData) {
    const bytes = [];
    const segments = pathSegments(pathData);
    const scale = scaleFor(segments.flatMap((segment) => segment[1]));
    writeUnsigned(bytes, scale.exponent);
    let previous = 0;
    for (const [command, values] of segments) {
      bytes.push(OPCODES[command]);
      for (const value of values) {
        const coordinate = Math.round(value * scale.value);
        writeSigned(bytes, coordinate - previous);
        previous = coordinate;
      }
    }
    return Uint8Array.from(bytes);
  }

  function decodePath(input) {
    const bytes = asBytes(input);
    const cursor = { index: 0 };
    const scale = 10 ** readUnsigned(bytes, cursor);
    const parts = [];
    let previous = 0;
    while (cursor.index < bytes.length) {
      const opcode = bytes[cursor.index++];
      const command = COMMANDS[opcode];
      if (!command) throw new Error(`Unknown stroke opcode ${opcode}`);
      parts.push(command);
      for (let index = 0; index < ARITY[opcode]; index++) {
        previous += readSigned(bytes, cursor);
        parts.push(String(previous / scale));
      }
    }
    return parts.join(" ");
  }

  function encodeMedians(medians) {
    const bytes = [];
    const scale = scaleFor(medians.flat(2));
    writeUnsigned(bytes, scale.exponent);
    for (const stroke of medians) {
      writeUnsigned(bytes, stroke.length);
      let previous = 0;
      for (const [rawX, rawY] of stroke) {
        const x = Math.round(rawX * scale.value);
        const y = Math.round(rawY * scale.value);
        writeSigned(bytes, x - previous);
        writeSigned(bytes, y - x);
        previous = y;
      }
    }
    return Uint8Array.from(bytes);
  }

  function decodeMedians(input, strokeCount) {
    const bytes = asBytes(input);
    const cursor = { index: 0 };
    const scale = 10 ** readUnsigned(bytes, cursor);
    const result = [];
    for (let stroke = 0; stroke < strokeCount; stroke++) {
      const count = readUnsigned(bytes, cursor);
      const points = [];
      let previous = 0;
      for (let point = 0; point < count; point++) {
        const x = previous + readSigned(bytes, cursor);
        const y = x + readSigned(bytes, cursor);
        previous = y;
        points.push([x / scale, y / scale]);
      }
      result.push(points);
    }
    return result;
  }

  function encodeSourceRecord(source) {
    return [source.strokes.map(encodePath), encodeMedians(source.medians)];
  }

  function decodeRecord(record) {
    if (!Array.isArray(record) || !Array.isArray(record[0])) return null;
    const strokes = record[0].map(decodePath);
    return { strokes, medians: decodeMedians(record[1], strokes.length) };
  }

  function decodeShard(input) {
    const bytes = asBytes(input);
    const cursor = { index: 0 };
    const version = bytes[cursor.index++];
    if (version !== 3) throw new Error(`Unsupported stroke shard version ${version}`);
    const count = readUnsigned(bytes, cursor);
    const entries = new Map();
    for (let entryIndex = 0; entryIndex < count; entryIndex++) {
      const character = String.fromCodePoint(readUnsigned(bytes, cursor));
      const strokeCount = readUnsigned(bytes, cursor);
      const strokes = [];
      for (let stroke = 0; stroke < strokeCount; stroke++) {
        const length = readUnsigned(bytes, cursor);
        strokes.push(bytes.slice(cursor.index, cursor.index + length));
        cursor.index += length;
      }
      const medianLength = readUnsigned(bytes, cursor);
      const medians = bytes.slice(cursor.index, cursor.index + medianLength);
      cursor.index += medianLength;
      entries.set(character, [strokes, medians]);
    }
    return entries;
  }

  const api = { encodeSourceRecord, decodePath, decodeMedians, decodeRecord, decodeShard };
  global.CombinedAnnotatorStrokeCodec = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

