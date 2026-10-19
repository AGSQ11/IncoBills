/**
 * Copy the unmodified pdf.js legacy build from node_modules into vendor/pdfjs.
 * Run after changing the pdfjs-dist version in package.json:  npm run vendor:pdfjs
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const src = path.join(root, "node_modules", "pdfjs-dist");
const dest = path.join(root, "vendor", "pdfjs");
const version = require(path.join(src, "package.json")).version;

fs.mkdirSync(dest, { recursive: true });
for (const file of ["pdf.min.mjs", "pdf.worker.min.mjs"]) {
  fs.copyFileSync(path.join(src, "legacy", "build", file), path.join(dest, file));
}
fs.copyFileSync(path.join(src, "LICENSE"), path.join(dest, "LICENSE"));
fs.writeFileSync(
  path.join(dest, "README.md"),
  `# pdf.js (vendored)\n\nUnmodified copy of \`pdfjs-dist@${version}\` (legacy build, minified), from\nhttps://www.npmjs.com/package/pdfjs-dist — Apache-2.0, see LICENSE.\n\nUsed only to read text from PDF invoices locally (Ollama backend).\nUpdate: change the version in package.json, run \`npm install\`, then \`npm run vendor:pdfjs\`.\n`
);
console.log(`vendored pdfjs-dist ${version} into vendor/pdfjs`);
