const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).version;
const artifacts = [
  ["Chrome", path.join(root, "web-ext-artifacts", "combined_chinese_annotator-" + version + ".zip")],
  ["Firefox", path.join(root, "web-ext-artifacts", "combined_chinese_annotator-" + version + "-firefox.zip")]
];
const previousBytes = 42_917_354;
const maximumBytes = 38_600_000;

for (const [browser, artifact] of artifacts) {
  const currentBytes = fs.statSync(artifact).size;
  assert.ok(currentBytes <= maximumBytes, browser + " package is " + currentBytes + " bytes; target is " + maximumBytes);
  assert.ok(currentBytes <= previousBytes * 0.9, browser + " package is not at least 10% below " + previousBytes);
  const reduction = (1 - currentBytes / previousBytes) * 100;
  console.log("  ok  " + browser + " package is " + (currentBytes / 1024 / 1024).toFixed(2) + " MiB (" + reduction.toFixed(1) + "% below 0.1.0)");
}
