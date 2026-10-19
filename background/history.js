/**
 * IncoBills — classification history and the "already processed" set.
 *
 * History is for display (capped, newest first). The processed set is keyed
 * by the Message-ID header, which stays the same when a message moves
 * (the Thunderbird message id does not).
 *
 * @license MIT
 */

const History = {
  _processed: null, // Map<key, timestamp>
  _dirty: false,
  _flushTimer: null,

  // ---- Processed set ----

  processedKey(message) {
    if (message && message.headerMessageId) return `h:${message.headerMessageId}`;
    return message && message.id != null ? `i:${message.id}` : null;
  },

  async _loadProcessed() {
    if (!this._processed) {
      const stored = await Storage.getData(DATA_KEYS.PROCESSED, {});
      this._processed = new Map(Object.entries(stored && typeof stored === "object" ? stored : {}));
    }
    return this._processed;
  },

  async isProcessed(message) {
    const key = this.processedKey(message);
    const set = await this._loadProcessed();
    return Boolean(key && set.has(key));
  },

  async markProcessed(message) {
    const key = this.processedKey(message);
    if (!key) return;
    const set = await this._loadProcessed();
    set.delete(key);
    set.set(key, Date.now());
    while (set.size > PROCESSED_MAX_ENTRIES) set.delete(set.keys().next().value);
    this._dirty = true;
    this._scheduleFlush();
  },

  async unmarkProcessed(message) {
    const key = this.processedKey(message);
    const set = await this._loadProcessed();
    if (key && set.delete(key)) {
      this._dirty = true;
      this._scheduleFlush();
    }
  },

  _scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush().catch((err) => console.error("IncoBills: saving processed set failed", err));
    }, 2000);
    if (this._flushTimer && this._flushTimer.unref) this._flushTimer.unref(); // Node (tests) only
  },

  async flush() {
    if (!this._dirty || !this._processed) return;
    this._dirty = false;
    await Storage.set({ [DATA_KEYS.PROCESSED]: Object.fromEntries(this._processed) });
  },

  async resetProcessed() {
    this._processed = new Map();
    this._dirty = false;
    await Storage.set({ [DATA_KEYS.PROCESSED]: {} });
  },

  // ---- History ----

  async log(entry) {
    const settings = await Storage.getSettings();
    const max = settings.historyMaxEntries || DEFAULTS.historyMaxEntries;
    const record = { id: crypto.randomUUID(), timestamp: new Date().toISOString(), ...entry };
    await Storage.update(
      DATA_KEYS.HISTORY,
      (list) => {
        const next = Array.isArray(list) ? list : [];
        next.unshift(record);
        return next.slice(0, max);
      },
      []
    );
    return record;
  },

  async getAll() {
    const list = await Storage.getData(DATA_KEYS.HISTORY, []);
    return Array.isArray(list) ? list : [];
  },

  async getRecent(count) {
    return (await this.getAll()).slice(0, count);
  },

  async findByHeaderId(headerMessageId) {
    if (!headerMessageId) return null;
    return (await this.getAll()).find((e) => e.headerMessageId === headerMessageId) || null;
  },

  async getStats() {
    const history = await this.getAll();
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    let today = 0;
    let thisMonth = 0;
    let total = 0;
    for (const entry of history) {
      if (!DETECTED_ACTIONS.includes(entry.action) || entry.userOverride === "notInvoice") continue;
      total++;
      if (entry.timestamp >= monthStart) thisMonth++;
      if (entry.timestamp >= todayStart) today++;
    }
    return { today, thisMonth, total };
  },

  async updateOverride(historyId, override) {
    await Storage.update(
      DATA_KEYS.HISTORY,
      (list) => list.map((e) => (e.id === historyId ? { ...e, userOverride: override } : e)),
      []
    );
  },

  async updateEntry(historyId, changes) {
    await Storage.update(
      DATA_KEYS.HISTORY,
      (list) => list.map((e) => (e.id === historyId ? { ...e, ...changes } : e)),
      []
    );
  },

  async clear() {
    await Storage.set({ [DATA_KEYS.HISTORY]: [] });
  },

  /** CSV with a UTF-8 BOM (Excel), escaped fields, and formula-injection guard. */
  async exportCSV() {
    const history = await this.getAll();
    const cell = (value) => {
      let s = String(value ?? "");
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const headers = ["Date", "From", "Subject", "Confidence", "Source", "Action", "Override", "Reason"];
    const rows = history.map((e) =>
      [
        e.timestamp,
        e.from,
        e.subject,
        e.classification ? e.classification.confidence : "",
        (e.classification && e.classification.source) || e.backend || "",
        e.action,
        e.userOverride || "",
        e.classification ? e.classification.reason : "",
      ].map(cell)
    );
    return "﻿" + [headers.map(cell).join(","), ...rows.map((r) => r.join(","))].join("\r\n");
  },
};
