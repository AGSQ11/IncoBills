/**
 * Print the CHANGELOG.md section for one version (release notes).
 * Usage: node scripts/changelog-section.js 1.2.0
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const version = process.argv[2];
if (!version) {
  console.error("usage: node scripts/changelog-section.js <version>");
  process.exit(2);
}
const text = fs.readFileSync(path.join(__dirname, "..", "CHANGELOG.md"), "utf8");
const lines = text.split(/\r?\n/);
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (start === -1) {
  console.error(`CHANGELOG.md has no section for ${version}`);
  process.exit(1);
}
let end = lines.findIndex((line, i) => i > start && line.startsWith("## ["));
if (end === -1) end = lines.length;
process.stdout.write(lines.slice(start + 1, end).join("\n").trim() + "\n");
