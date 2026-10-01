"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = __dirname;
const ARTIFACTS = path.join(ROOT, "web-ext-artifacts");
const FIREFOX_UNPACKED = path.join(ARTIFACTS, "firefox-unpacked");
const WEB_EXT = path.join(ROOT, "node_modules", "web-ext", "bin", "web-ext.js");

const EXCLUDED_ROOT_ENTRIES = new Set([
  ".claude",
  ".extension-build",
  ".git",
  ".gitignore",
  ".web-extignore",
  "build-data.js",
  "build-extension.js",
  "build-lexicon.js",
  "build-source-package.js",
  "ccedict-glosses.json",
  "data-sources",
  "hanzi-writer-data",
  "hanzi-writer-data.json",
  "manifest.firefox.json",
  "manifest.json",
  "new.png",
  "node_modules",
  "package-lock.json",
  "package.json",
  "popup.css",
  "popup.html",
  "popup.js",
  "source-code.zip",
  "SOURCES.md",
  "split-data.js",
  "test-page.html",
  "test-page.js",
  "test_engine.js",
  "test_opencc.js",
  "tests",
  "web-ext-artifacts"
]);

const CHROME_IGNORE_FILES = [
  "hanzi-writer-data",
  "data-sources",
  "tests",
  "node_modules",
  ".claude",
  "new.png",
  "popup.html",
  "popup.js",
  "popup.css",
  "test-page.html",
  "test-page.js",
  "test_engine.js",
  "test_opencc.js",
  "split-data.js",
  "package.json",
  "package-lock.json",
  "build-data.js",
  "build-extension.js",
  "build-lexicon.js",
  "build-source-package.js",
  "manifest.firefox.json",
  ".web-extignore",
  ".git",
  ".gitignore",
  "web-ext-artifacts",
  "source-code.zip",
  "SOURCES.md",
  "ccedict-glosses.json",
  "hanzi-writer-data.json",
  "hanzi-writer-data-1.json",
  "hanzi-writer-data-2.json",
  "hanzi-writer-data-3.json",
  "hanzi-writer-data-4.json",
  "hanzi-writer-data-5.json",
  "hanzi-writer-data-6.json",
  "hanzi-writer-data-7.json"
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
}

function validateManifests() {
  const chrome = readJson("manifest.json");
  const firefox = readJson("manifest.firefox.json");

  if (chrome.manifest_version !== 3 || chrome.background?.service_worker !== "background.js") {
    throw new Error("Chrome manifest must use a Manifest V3 service worker");
  }
  if (chrome.background?.scripts || chrome.browser_specific_settings) {
    throw new Error("Chrome manifest contains Firefox-only keys");
  }
  if (firefox.manifest_version !== 3 || !Array.isArray(firefox.background?.scripts)) {
    throw new Error("Firefox manifest must use background.scripts");
  }
  if (firefox.background?.service_worker || !firefox.browser_specific_settings?.gecko) {
    throw new Error("Firefox manifest contains an invalid background or is missing Gecko settings");
  }
  if (JSON.stringify(chrome.content_scripts) !== JSON.stringify(firefox.content_scripts)) {
    throw new Error("Browser manifests have drifted in their content scripts");
  }
  return { chrome, firefox };
}

function shouldExclude(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  const first = normalized.split("/")[0];
  const base = path.basename(normalized);
  return EXCLUDED_ROOT_ENTRIES.has(first)
    || /^hanzi-writer-data-\d+\.json$/.test(base)
    || base.endsWith(".zip");
}

function copyRuntimeTree(source, destination, relativePath = "") {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const childRelative = relativePath ? path.join(relativePath, entry.name) : entry.name;
    if (shouldExclude(childRelative)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyRuntimeTree(from, to, childRelative);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function prepareFirefox() {
  fs.rmSync(FIREFOX_UNPACKED, { recursive: true, force: true });
  copyRuntimeTree(ROOT, FIREFOX_UNPACKED);
  fs.copyFileSync(path.join(ROOT, "manifest.firefox.json"), path.join(FIREFOX_UNPACKED, "manifest.json"));
  return FIREFOX_UNPACKED;
}

function runWebExt(args) {
  const result = spawnSync(process.execPath, [WEB_EXT, ...args], {
    cwd: ROOT,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

function buildFirefox(version) {
  runWebExt([
    "build",
    "--source-dir", prepareFirefox(),
    "--artifacts-dir", ARTIFACTS,
    "--filename", "combined_chinese_annotator-" + version + "-firefox.zip",
    "--overwrite-dest"
  ]);
}

const { chrome, firefox } = validateManifests();
if (chrome.version !== firefox.version) throw new Error("Chrome and Firefox versions must match");
const mode = process.argv[2] || "build";
fs.mkdirSync(ARTIFACTS, { recursive: true });

if (mode === "--prepare-firefox") {
  console.log("Firefox unpacked build: " + prepareFirefox());
} else if (mode === "--lint") {
  runWebExt(["lint", "--source-dir", prepareFirefox()]);
} else if (mode === "--build-firefox") {
  buildFirefox(firefox.version);
} else if (mode === "build") {
  runWebExt([
    "build",
    "--source-dir", ROOT,
    "--artifacts-dir", ARTIFACTS,
    "--filename", "combined_chinese_annotator-" + chrome.version + ".zip",
    "--overwrite-dest",
    "--ignore-files", ...CHROME_IGNORE_FILES
  ]);
  buildFirefox(firefox.version);
} else {
  throw new Error("Unknown build mode: " + mode);
}
