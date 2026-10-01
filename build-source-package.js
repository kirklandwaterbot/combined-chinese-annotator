"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = __dirname;
const ARTIFACTS = path.join(ROOT, "web-ext-artifacts");
const STAGING = path.join(ARTIFACTS, "firefox-source-review");
const WEB_EXT = path.join(ROOT, "node_modules", "web-ext", "bin", "web-ext.js");

const SOURCE_FILES = [
  "128.png",
  "32.png",
  "48.png",
  "96.png",
  "CHANGELOG.md",
  "LICENSE",
  "PRIVACY.md",
  "README.md",
  "SOURCES.md",
  "THIRD-PARTY.md",
  "annotate-dat.txt",
  "annotation.css",
  "background.js",
  "build-data.js",
  "build-extension.js",
  "build-lexicon.js",
  "build-source-package.js",
  "content.js",
  "converter.js",
  "core.js",
  "hanzi-writer-data.json",
  "hanzi-writer.min.js",
  "hsk-data.json",
  "manifest.firefox.json",
  "manifest.json",
  "opencc.js",
  "overlay.js",
  "package-lock.json",
  "package.json",
  "pinyin-web-engine.js",
  "popup-v2.css",
  "popup-v2.html",
  "popup-v2.js",
  "stroke-codec-v2.js",
  "theme-init.js",
  "user-store.js"
];

const SOURCE_DIRECTORIES = ["data-sources", "tests"];

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function requirePath(relativePath) {
  const absolute = path.join(ROOT, relativePath);
  if (!fs.existsSync(absolute)) throw new Error("Missing source-review input: " + relativePath);
  return absolute;
}

function runWebExt(args) {
  const result = spawnSync(process.execPath, [WEB_EXT, ...args], {
    cwd: ROOT,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
fs.rmSync(STAGING, { recursive: true, force: true });
fs.mkdirSync(STAGING, { recursive: true });

for (const filename of SOURCE_FILES) {
  fs.copyFileSync(requirePath(filename), path.join(STAGING, filename));
}
for (const directory of SOURCE_DIRECTORIES) {
  copyDirectory(requirePath(directory), path.join(STAGING, directory));
}

runWebExt([
  "build",
  "--source-dir", STAGING,
  "--artifacts-dir", ARTIFACTS,
  "--filename", "combined_chinese_annotator-" + packageJson.version + "-source.zip",
  "--overwrite-dest"
]);

fs.rmSync(STAGING, { recursive: true, force: true });