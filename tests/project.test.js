"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { ROOT } = require("./helpers/env");

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const manifest = JSON.parse(read("manifest.json"));

function walk(dir, ext) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(rel, ext));
    else if (rel.endsWith(ext)) out.push(rel);
  }
  return out;
}

const extensionJs = [...walk("background", ".js"), ...walk("shared", ".js"), ...walk("options", ".js"), ...walk("popup", ".js")];
const html = [...walk("options", ".html"), ...walk("popup", ".html")];

test("every manifest background script exists and compiles", () => {
  for (const script of manifest.background.scripts) {
    assert.ok(fs.existsSync(path.join(ROOT, script)), script);
    new vm.Script(read(script), { filename: script });
  }
});

test("every extension script compiles and every HTML script tag resolves", () => {
  for (const file of extensionJs) new vm.Script(read(file), { filename: file });
  for (const file of html) {
    for (const [, src] of read(file).matchAll(/<script src="([^"]+)"/g)) {
      assert.ok(fs.existsSync(path.join(ROOT, path.dirname(file), src)), `${file} → ${src}`);
    }
  }
});

test("no innerHTML, eval or new Function in extension code", () => {
  for (const file of extensionJs) {
    const src = read(file);
    assert.doesNotMatch(src, /\.innerHTML\s*=|\binsertAdjacentHTML\b|\beval\(|new Function\(/, file);
  }
});

test("locales: en and ro have the same keys and placeholders", () => {
  const en = JSON.parse(read("_locales/en/messages.json"));
  const ro = JSON.parse(read("_locales/ro/messages.json"));
  assert.deepEqual(Object.keys(ro).sort(), Object.keys(en).sort());
  for (const key of Object.keys(en)) {
    const placeholders = (m) => [...new Set(m.match(/\$\d/g) || [])].sort().join(",");
    assert.equal(placeholders(ro[key].message), placeholders(en[key].message), key);
  }
});

test("locales: every key used in code and HTML exists", () => {
  const en = JSON.parse(read("_locales/en/messages.json"));
  const used = new Set();
  for (const file of html) for (const [, key] of read(file).matchAll(/data-i18n(?:-placeholder|-title|-aria-label)?="([^"]+)"/g)) used.add(key);
  for (const file of extensionJs) {
    const src = read(file);
    for (const [, key] of src.matchAll(/\bt\(\s*"([A-Za-z0-9_]+)"/g)) used.add(key);
    for (const [, key] of src.matchAll(/(?<!dataset:\s*\{\s*)key:\s*"([A-Za-z0-9_]+)"/g)) used.add(key);
    for (const [, key] of src.matchAll(/\b(?:err|warn)\("(val[A-Za-z0-9_]+)"/g)) used.add(key);
  }
  for (const [, key] of read("manifest.json").matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) used.add(key);
  const missing = [...used].filter((key) => !en[key]);
  assert.deepEqual(missing, []);
});

test("manifest version has a CHANGELOG entry", () => {
  assert.match(read("CHANGELOG.md"), new RegExp(`## \\[${manifest.version.replace(/\./g, "\\.")}\\]`));
});

test("permissions: no <all_urls>; custom hosts are optional", () => {
  assert.ok(!manifest.permissions.includes("<all_urls>"));
  assert.ok(manifest.optional_permissions.includes("*://*/*"));
});
