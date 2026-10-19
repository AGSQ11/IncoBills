/**
 * Test environment: loads the background scripts (in manifest order) into a
 * vm context with a mocked Thunderbird `browser` API.
 */
"use strict";

const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { DOMParser } = require("@xmldom/xmldom");

const ROOT = path.resolve(__dirname, "..", "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const messagesEn = JSON.parse(fs.readFileSync(path.join(ROOT, "_locales", "en", "messages.json"), "utf8"));

function getMessage(key, subs) {
  const entry = messagesEn[key];
  if (!entry) return "";
  const list = subs === undefined ? [] : [].concat(subs);
  return entry.message.replace(/\$(\d)/g, (m, n) => (list[Number(n) - 1] !== undefined ? String(list[Number(n) - 1]) : ""));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal Response-like object for fetch mocks. */
function jsonResponse(body, status = 200, headers = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function createEnv({ storageLatencyMs = 0, scripts, quiet = true } = {}) {
  const store = {};
  const listeners = { storage: [], newMail: [], message: [], connect: [], menus: [], downloadsChanged: [], notificationClicked: [] };
  const notifications = [];
  const downloads = [];
  const moved = [];
  const copied = [];
  const createdFolders = [];
  const fetchCalls = [];
  const logs = [];
  const fetchQueue = [];

  const mail = {
    accounts: [{ id: "account1", name: "Work", type: "imap", rootFolder: { id: "account1://", accountId: "account1", path: "/" } }],
    folders: [
      { id: "account1://INBOX", accountId: "account1", name: "Inbox", path: "/INBOX", specialUse: ["inbox"], parentFolderId: "account1://" },
    ],
    messages: [],
    full: {},
    attachments: {},
    attachmentFiles: {},
  };

  // Thunderbird 128 MailFolder objects have no parentFolderId; the mock keeps it internally.
  const pub = (folder) => {
    if (!folder) return folder;
    const { parentFolderId, ...rest } = folder;
    return structuredClone(rest);
  };

  const later = async () => {
    if (storageLatencyMs) await sleep(storageLatencyMs);
  };

  const browser = {
    storage: {
      local: {
        async get(keys) {
          await later();
          if (keys === null || keys === undefined) return structuredClone(store);
          const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
          const out = {};
          for (const key of list) if (key in store) out[key] = structuredClone(store[key]);
          return out;
        },
        async set(data) {
          await later();
          const changes = {};
          for (const [key, value] of Object.entries(data)) {
            changes[key] = { oldValue: store[key], newValue: structuredClone(value) };
            store[key] = structuredClone(value);
          }
          for (const fn of listeners.storage) fn(changes, "local");
        },
        async remove(keys) {
          await later();
          for (const key of [].concat(keys)) delete store[key];
        },
      },
      onChanged: { addListener: (fn) => listeners.storage.push(fn) },
    },
    i18n: { getMessage, getUILanguage: () => "en" },
    runtime: {
      id: "incobills@serverspan.com",
      getURL: (p) => `moz-extension://test/${p}`,
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onConnect: { addListener: (fn) => listeners.connect.push(fn) },
      openOptionsPage: async () => {},
    },
    notifications: {
      async create(id, options) {
        notifications.push({ id, ...options });
        return id;
      },
      async clear() {},
      onClicked: { addListener: (fn) => listeners.notificationClicked.push(fn) },
    },
    menus: {
      created: [],
      create(props) {
        this.created.push(props);
      },
      async removeAll() {
        this.created = [];
      },
      onClicked: { addListener: (fn) => listeners.menus.push(fn) },
    },
    downloads: {
      async download(options) {
        downloads.push(options);
        return downloads.length;
      },
      onChanged: { addListener: (fn) => listeners.downloadsChanged.push(fn), removeListener() {} },
    },
    accounts: {
      async list() {
        return structuredClone(mail.accounts);
      },
      async get(id) {
        return structuredClone(mail.accounts.find((a) => a.id === id) || null);
      },
    },
    folders: {
      async get(id) {
        const folder = mail.folders.find((f) => f.id === id);
        if (!folder) throw new Error("folder not found");
        return pub(folder);
      },
      async getSubFolders(id) {
        return mail.folders.filter((f) => f.parentFolderId === id).map(pub);
      },
      async getParentFolders(id) {
        const out = [];
        let current = mail.folders.find((f) => f.id === id);
        while (current && current.parentFolderId) {
          current = mail.folders.find((f) => f.id === current.parentFolderId);
          if (current) out.push(pub(current));
        }
        return out;
      },
      async create(parentId, name) {
        await sleep(5);
        if (mail.folders.some((f) => f.parentFolderId === parentId && f.name === name)) throw new Error(`folder ${name} exists`);
        const parent = mail.folders.find((f) => f.id === parentId) || mail.accounts.map((a) => a.rootFolder).find((r) => r.id === parentId);
        const folder = {
          id: `${parentId.replace(/\/$/, "")}/${name}`,
          accountId: parent.accountId,
          name,
          path: `${parent.path === "/" ? "" : parent.path}/${name}`,
          parentFolderId: parentId,
        };
        mail.folders.push(folder);
        createdFolders.push(folder);
        return pub(folder);
      },
      async query({ accountId, name, specialUse }) {
        return mail.folders
          .filter((f) => (!accountId || f.accountId === accountId) && (!name || f.name === name) && (!specialUse || (f.specialUse || []).some((s) => specialUse.includes(s))))
          .map(pub);
      },
    },
    messages: {
      onNewMailReceived: { addListener: (fn) => listeners.newMail.push(fn) },
      async getFull(id) {
        return structuredClone(mail.full[id] || { contentType: "text/plain", body: "" });
      },
      async listAttachments(id) {
        return structuredClone(mail.attachments[id] || []);
      },
      async getAttachmentFile(id, partName) {
        const bytes = mail.attachmentFiles[`${id}:${partName}`];
        if (!bytes) throw new Error("attachment not found");
        return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
      },
      async move(ids, folderId) {
        moved.push({ ids, folderId });
        for (const id of ids) {
          const m = mail.messages.find((x) => x.id === id);
          if (m) m.folder = pub(mail.folders.find((f) => f.id === folderId));
        }
      },
      async copy(ids, folderId) {
        copied.push({ ids, folderId });
      },
      async query(q) {
        let list = mail.messages.filter((m) => {
          if (q.accountId && m.folder.accountId !== q.accountId) return false;
          if (q.headerMessageId && m.headerMessageId !== q.headerMessageId) return false;
          const d = new Date(m.date);
          if (q.fromDate && d < q.fromDate) return false;
          if (q.toDate && d > q.toDate) return false;
          return true;
        });
        return { id: null, messages: structuredClone(list) };
      },
      async continueList() {
        return { id: null, messages: [] };
      },
    },
  };

  const env = {
    store,
    mail,
    browser,
    listeners,
    notifications,
    downloads,
    moved,
    copied,
    createdFolders,
    fetchCalls,
    fetchQueue,
    logs,
    /** Queue a fetch response (object → JSON 200, or a function(url, init)). */
    respond(handler) {
      fetchQueue.push(handler);
    },
    get(name) {
      return vm.runInContext(name, context);
    },
    run(code) {
      return vm.runInContext(code, context);
    },
    addMessage(message, { body = "", html, attachments = [], files = {} } = {}) {
      const full = html
        ? { contentType: "multipart/alternative", parts: [{ contentType: "text/plain", body }, { contentType: "text/html", body: html }] }
        : { contentType: "text/plain", body };
      const folder = message.folder || mail.folders[0];
      const record = { date: new Date().toISOString(), author: "Sender <sender@example.com>", subject: "", headerMessageId: `${message.id}@test`, ...message, folder: pub(folder) };
      mail.messages.push(record);
      mail.full[record.id] = full;
      mail.attachments[record.id] = attachments;
      for (const [part, bytes] of Object.entries(files)) mail.attachmentFiles[`${record.id}:${part}`] = bytes;
      return record;
    },
    async sendMessage(message) {
      return listeners.message[0](message, { id: browser.runtime.id });
    },
  };

  async function fakeFetch(url, init = {}) {
    const call = { url: String(url), init, body: init.body ? safeJson(init.body) : undefined };
    fetchCalls.push(call);
    const handler = fetchQueue.shift();
    if (!handler) throw new Error(`unexpected fetch: ${url}`);
    if (typeof handler === "function") return handler(String(url), init, call);
    if (handler instanceof Error) throw handler;
    return jsonResponse(handler);
  }

  const context = {
    browser,
    console: quiet
      ? { log: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: (...a) => logs.push(a), info() {}, debug() {} }
      : console,
    crypto: globalThis.crypto,
    fetch: fakeFetch,
    AbortSignal,
    TextDecoder,
    TextEncoder,
    Blob,
    DecompressionStream,
    Response,
    Headers,
    URL,
    structuredClone,
    setTimeout,
    clearTimeout,
    btoa,
    atob,
    DOMParser,
  };
  vm.createContext(context);
  for (const script of scripts || manifest.background.scripts) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, script), "utf8"), context, { filename: script });
  }
  // Make retries instant in tests.
  vm.runInContext("Http.sleep = () => Promise.resolve();", context);
  return env;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

module.exports = { createEnv, jsonResponse, ROOT, getMessage, sleep };
