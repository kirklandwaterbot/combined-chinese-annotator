const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const codec = require("../stroke-codec-v2.js");

const root = path.join(__dirname, "..");
const source = JSON.parse(fs.readFileSync(path.join(root, "hanzi-writer-data.json"), "utf8"));
const compact = new Map();
let compactBytes = 0;
for (let index = 0; index < 64; index++) {
  const filename = path.join(root, "stroke-data", `${index.toString(16).padStart(2,"0")}.bin`);
  const buffer = fs.readFileSync(filename);
  compactBytes += buffer.length;
  const shard = codec.decodeShard(buffer);
  for(const [character,record] of shard) {
    assert.equal(character.codePointAt(0)%64,index,`wrong shard for ${character}`);
    compact.set(character,record);
  }
}

const tolerance = 0.000501;
function pathTokens(value){return String(value).match(/[MLQCZ]|-?\d+(?:\.\d+)?/g)||[];}
function assertRecord(character) {
  const expected=source[character],actual=codec.decodeRecord(compact.get(character));
  assert.ok(actual,`missing ${character}`);assert.equal(actual.strokes.length,expected.strokes.length);assert.equal(actual.medians.length,expected.medians.length);
  expected.strokes.forEach((stroke,index)=>{
    const left=pathTokens(actual.strokes[index]),right=pathTokens(stroke);assert.equal(left.length,right.length,`${character} path length`);
    left.forEach((token,part)=>/[MLQCZ]/.test(token)?assert.equal(token,right[part]):assert.ok(Math.abs(Number(token)-Number(right[part]))<=tolerance,`${character} coordinate`));
  });
  expected.medians.forEach((median,index)=>median.forEach((point,pointIndex)=>{
    assert.ok(Math.abs(actual.medians[index][pointIndex][0]-point[0])<=tolerance,`${character} median x`);
    assert.ok(Math.abs(actual.medians[index][pointIndex][1]-point[1])<=tolerance,`${character} median y`);
  }));
}

assert.equal(compact.size,Object.keys(source).length,"compact coverage differs from source");
for(const character of Object.keys(source)) assertRecord(character);
for(const representative of ["汉","漢","學","龙","龘","⺀"]) if(source[representative]) assertRecord(representative);
assert.ok(compactBytes < fs.statSync(path.join(root,"hanzi-writer-data.json")).size*.65,"compact stroke data did not shrink enough");
console.log(`  ok  ${compact.size} stroke records round-tripped from 64 shards`);
console.log(`  ok  compact data is ${(compactBytes/1024/1024).toFixed(2)} MiB`);
