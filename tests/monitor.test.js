"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createEnv, sleep } = require("./helpers/env");

const INVOICE = {
  subject: "Factură FCT0042",
  author: "Facturare <facturare@exemplu.ro>",
};
const INVOICE_BODY = "Total de plată: 121,00 lei. Cota TVA 21%. Termen de plată 30.10.2026";

test("parallel history writes keep every entry (storage lock)", async () => {
  const env = createEnv({ storageLatencyMs: 5 });
  await env.browser.storage.local.set({ classificationHistory: [{ messageId: 0 }] });
  const History = env.get("History");
  await Promise.all([1, 2, 3, 4, 5].map((i) => History.log({ messageId: i, action: "moved" })));
  assert.equal(env.store.classificationHistory.length, 6);
});

test("history log does not mutate DEFAULTS", async () => {
  const env = createEnv();
  await env.get("History").log({ messageId: 1, action: "moved" });
  assert.equal(env.run("DEFAULTS.classificationHistory"), undefined);
  assert.equal(env.run("JSON.stringify(DEFAULTS.monitoredAccounts)"), "[]");
});

test("stats count moved, copied and flagged invoices", async () => {
  const env = createEnv();
  const History = env.get("History");
  for (const action of ["moved", "copied", "flagged", "skipped"]) await History.log({ messageId: action, action });
  const stats = await History.getStats();
  assert.equal(stats.total, 3);
  assert.equal(stats.today, 3);
});

test("new mail: detected invoice is moved to Invoices/YYYY-MM, one notification", async () => {
  const env = createEnv();
  const msg = env.addMessage({ id: 1, ...INVOICE, date: "2026-10-15T09:00:00Z" }, { body: INVOICE_BODY });
  await env.get("EmailMonitor").handleNewMail(msg.folder, { id: null, messages: [msg] });
  assert.equal(env.moved.length, 1);
  assert.ok(env.createdFolders.some((f) => f.path === "/Invoices"));
  assert.ok(env.createdFolders.some((f) => f.path === "/Invoices/2026-10"));
  assert.equal(env.notifications.length, 1);
  assert.equal(env.notifications[0].title, "IncoBills: invoice detected");
  const entry = env.store.classificationHistory[0];
  assert.equal(entry.action, "moved");
  assert.equal(entry.headerMessageId, "1@test");
  assert.equal(entry.sourceFolderId, "account1://INBOX");
});

test("new mail batch: one notification with the right verb (copy mode)", async () => {
  const env = createEnv();
  await env.browser.storage.local.set({ mailAction: "copy" });
  const a = env.addMessage({ id: 1, ...INVOICE }, { body: INVOICE_BODY });
  const b = env.addMessage({ id: 2, ...INVOICE, subject: "Factură FCT0043" }, { body: INVOICE_BODY });
  await env.get("EmailMonitor").handleNewMail(a.folder, { id: null, messages: [a, b] });
  assert.equal(env.copied.length, 2);
  assert.equal(env.notifications.length, 1);
  assert.match(env.notifications[0].message, /2 invoices detected and copied to "Invoices"/);
});

test("processed messages are skipped by Message-ID even after the Thunderbird id changes", async () => {
  const env = createEnv();
  const msg = env.addMessage({ id: 1, ...INVOICE }, { body: INVOICE_BODY });
  const monitor = env.get("EmailMonitor");
  await monitor.handleNewMail(msg.folder, { id: null, messages: [msg] });
  const again = { ...msg, id: 99 }; // same Message-ID, new folder → new id
  const result = await monitor.processMessage(again, await env.get("Storage").getSettings(), {});
  assert.equal(result, null);
});

test("AI fallback that skipped a message is not marked processed (a scan retries it)", async () => {
  const env = createEnv();
  await env.browser.storage.local.set({ aiBackend: "claude", claudeApiKey: "k", hybridMode: false });
  const err = new TypeError("offline");
  for (let i = 0; i < 4; i++) env.respond(err);
  const msg = env.addMessage({ id: 5, subject: "Hello", author: "a@b.c" }, { body: "see you" });
  const monitor = env.get("EmailMonitor");
  const settings = await env.get("Storage").getSettings();
  const result = await monitor.processMessage(msg, settings, {});
  assert.equal(result.action, "skipped");
  assert.equal(await env.get("History").isProcessed(msg), false);
});

test("scan skips Sent/Trash/Junk and the Invoices tree, and uses local end of day", async () => {
  const env = createEnv();
  env.mail.folders.push(
    { id: "account1://Sent", accountId: "account1", name: "Sent", path: "/Sent", specialUse: ["sent"] },
    { id: "account1://Trash", accountId: "account1", name: "Trash", path: "/Trash", specialUse: ["trash"] },
    { id: "account1://Invoices/2026-10", accountId: "account1", name: "2026-10", path: "/Invoices/2026-10" }
  );
  const today = new Date();
  today.setHours(20, 0, 0, 0); // late today, local time
  env.addMessage({ id: 1, ...INVOICE, date: today.toISOString() }, { body: INVOICE_BODY });
  env.addMessage({ id: 2, ...INVOICE, folder: env.mail.folders.find((f) => f.id === "account1://Sent") }, { body: INVOICE_BODY });
  env.addMessage({ id: 3, ...INVOICE, folder: env.mail.folders.find((f) => f.id === "account1://Trash") }, { body: INVOICE_BODY });
  env.addMessage({ id: 4, ...INVOICE, folder: env.mail.folders.find((f) => f.id === "account1://Invoices/2026-10") }, { body: INVOICE_BODY });

  const Text = env.get("Text");
  const monitor = env.get("EmailMonitor");
  const settings = await env.get("Storage").getSettings();
  const list = await monitor.collectScanMessages({ fromDate: Text.localDateString(new Date(today.getFullYear(), today.getMonth(), 1)), toDate: Text.localDateString(today) }, settings);
  assert.equal(JSON.stringify(list.map((m) => m.id)), "[1]");
});

test("scan runs in the background with progress and can be cancelled", async () => {
  const env = createEnv();
  for (let i = 1; i <= 30; i++) env.addMessage({ id: i, subject: `Note ${i}`, author: "a@b.c" }, { body: "hello" });
  const monitor = env.get("EmailMonitor");
  const states = [];
  monitor.subscribe((s) => states.push(s));
  monitor.startScan({});
  assert.throws(() => monitor.startScan({}), /already running/);
  monitor.cancelScan();
  while (monitor.getScanState().running) await sleep(5);
  const final = monitor.getScanState();
  assert.equal(final.cancelled, true);
  assert.ok(final.processed < 30);
  assert.ok(states.length >= 2);
});

test("monitorMode 'selected' with no account processes nothing", async () => {
  const env = createEnv();
  await env.browser.storage.local.set({ monitorMode: "selected", monitoredAccounts: [] });
  const msg = env.addMessage({ id: 1, ...INVOICE }, { body: INVOICE_BODY });
  await env.get("EmailMonitor").handleNewMail(msg.folder, { id: null, messages: [msg] });
  assert.equal(env.moved.length, 0);
});

test("migration: [] meant 'all accounts'; old default model is replaced", async () => {
  const env = createEnv({ scripts: undefined });
  await env.browser.storage.local.set({ schemaVersion: 1, monitoredAccounts: [], claudeModel: "claude-haiku-4-5-20251001", monitorMode: undefined });
  delete env.store.monitorMode;
  delete env.store.schemaVersion;
  await env.get("Storage").migrate();
  assert.equal(env.store.monitorMode, "all");
  assert.equal(env.store.claudeModel, "claude-haiku-5-5");
  assert.equal(env.store.schemaVersion, 2);
});

test("folders: parallel requests create the monthly folder once", async () => {
  const env = createEnv();
  const FM = env.get("FolderManager");
  const ids = await Promise.all([1, 2, 3].map(() => FM.getTargetFolder("account1", "2026-10-15T09:00:00Z")));
  assert.equal(new Set(ids).size, 1);
  assert.equal(env.createdFolders.filter((f) => f.name === "2026-10").length, 1);
  assert.ok(ids[0].endsWith("/Invoices/2026-10"));
});

test("folders: no silent Local Folders fallback", async () => {
  const env = createEnv();
  env.browser.folders.create = async () => {
    throw new Error("server refused");
  };
  env.mail.accounts.push({ id: "local", name: "Local Folders", type: "none", rootFolder: { id: "local://", accountId: "local", path: "/" } });
  await assert.rejects(env.get("FolderManager").ensureParentFolder("account1", "Invoices"), /Cannot create the "Invoices" folder/);
});

test("context menu: 'Not an invoice' moves the message back and creates a rule", async () => {
  const env = createEnv();
  const msg = env.addMessage({ id: 1, ...INVOICE }, { body: INVOICE_BODY });
  await env.get("EmailMonitor").handleNewMail(msg.folder, { id: null, messages: [msg] });
  const movedMsg = env.mail.messages[0];
  assert.match(movedMsg.folder.path, /^\/Invoices\//);
  await env.get("Menus").apply({ id: null, messages: [structuredClone(movedMsg)] }, "notInvoice");
  assert.equal(env.moved.at(-1).folderId, "account1://INBOX");
  assert.equal(env.store.senderRules["addr:facturare@exemplu.ro"].verdict, "notInvoice");
  assert.equal(env.store.classificationHistory.at(-1).userOverride, "notInvoice");
});

test("CSV export: BOM, escaping and formula guard", async () => {
  const env = createEnv();
  await env.get("History").log({ from: '=HYPERLINK("x")', subject: 'say "hi"', action: "moved", classification: { confidence: 1, reason: "r" } });
  const csv = await env.get("History").exportCSV();
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
  assert.match(csv, /"say ""hi"""/);
});

test("message router: unknown type and settings filter", async () => {
  const env = createEnv();
  const unknown = await env.sendMessage({ type: "nope" });
  assert.equal(unknown.success, false);
  await env.sendMessage({ type: "saveSettings", data: { folderName: "Facturi", classificationHistory: [], confidenceThreshold: "high" } });
  const settings = await env.sendMessage({ type: "getSettings" });
  assert.equal(settings.folderName, "Facturi");
  assert.equal(settings.confidenceThreshold, 0.7);
  assert.equal(settings.classificationHistory, undefined);
});
