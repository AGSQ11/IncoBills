/**
 * IncoBills — storage layer.
 *
 * - Settings are cached in memory and refreshed by storage.onChanged.
 * - update() serializes read-modify-write per key, so parallel writers
 *   (two folders receiving mail at the same time) never lose data.
 *
 * @license MIT
 */

const Storage = {
  _settings: null,
  _locks: new Map(),
  _listening: false,

  _clone(value) {
    return value === undefined ? undefined : structuredClone(value);
  },

  _listen() {
    if (this._listening || !browser.storage.onChanged) return;
    this._listening = true;
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !this._settings) return;
      for (const [key, change] of Object.entries(changes)) {
        if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) continue;
        this._settings[key] = change.newValue === undefined ? this._clone(DEFAULTS[key]) : change.newValue;
      }
    });
  },

  /** All settings merged with defaults (a copy; safe to modify). */
  async getSettings() {
    if (!this._settings) {
      this._listen();
      const stored = await browser.storage.local.get(Object.keys(DEFAULTS));
      this._settings = { ...this._clone(DEFAULTS), ...stored };
    }
    return this._clone(this._settings);
  },

  /** One setting, or one data key with a fallback. */
  async get(key, fallback) {
    if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
      return (await this.getSettings())[key];
    }
    return this.getData(key, fallback);
  },

  async getData(key, fallback) {
    const result = await browser.storage.local.get(key);
    return result[key] === undefined ? this._clone(fallback) : result[key];
  },

  /** Write keys. Unknown setting keys are written as data. */
  async set(data) {
    await browser.storage.local.set(data);
    if (this._settings) {
      for (const [key, value] of Object.entries(data)) {
        if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) this._settings[key] = this._clone(value);
      }
    }
  },

  /** Save only known setting keys, with basic type checks. */
  async saveSettings(partial) {
    const clean = {};
    for (const [key, value] of Object.entries(partial || {})) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) continue;
      const expected = Array.isArray(DEFAULTS[key]) ? "array" : typeof DEFAULTS[key];
      const actual = Array.isArray(value) ? "array" : typeof value;
      if (expected === actual) clean[key] = value;
    }
    if (typeof clean.confidenceThreshold === "number") {
      clean.confidenceThreshold = Math.min(1, Math.max(0.05, clean.confidenceThreshold));
    }
    await this.set(clean);
    return clean;
  },

  async remove(keys) {
    await browser.storage.local.remove(keys);
    if (this._settings) {
      for (const key of [].concat(keys)) {
        if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) this._settings[key] = this._clone(DEFAULTS[key]);
      }
    }
  },

  /**
   * Atomic read-modify-write for one key.
   * mutator(current) returns the new value (or undefined to keep `current`).
   */
  update(key, mutator, fallback) {
    const previous = this._locks.get(key) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const current = await this.getData(key, fallback);
        const result = await mutator(current);
        const value = result === undefined ? current : result;
        await this.set({ [key]: value });
        return value;
      });
    this._locks.set(key, next);
    next.finally(() => {
      if (this._locks.get(key) === next) this._locks.delete(key);
    }).catch(() => {});
    return next;
  },

  /** One-time data migrations between versions. */
  async migrate() {
    const version = (await this.getData(DATA_KEYS.SCHEMA, 1)) || 1;
    if (version >= SCHEMA_VERSION) return;

    const stored = await browser.storage.local.get(null);
    const changes = {};

    // Old defaults that were saved by the options page → new defaults.
    for (const [key, oldValues] of Object.entries(LEGACY_DEFAULT_VALUES)) {
      if (oldValues.includes(stored[key])) changes[key] = DEFAULTS[key];
    }

    // [] used to mean "all accounts". Keep that meaning with an explicit mode.
    if (stored.monitorMode === undefined) {
      const list = Array.isArray(stored.monitoredAccounts) ? stored.monitoredAccounts : [];
      changes.monitorMode = list.length > 0 ? "selected" : "all";
    }

    // SAGA settings that are no longer used.
    if (stored.sagaSettings && typeof stored.sagaSettings === "object") {
      const { defaultTVARate, defaultCurrency, skipNonInvoices, ...rest } = stored.sagaSettings;
      changes.sagaSettings = rest;
    }

    // The 1.1.0 queue could not hold items (the pipeline never ran); normalize anyway.
    if (Array.isArray(stored.sagaQueue)) {
      changes.sagaQueue = stored.sagaQueue.map((item) => ({
        ...item,
        status: item.status === "extragereEsuata" ? "failed" : item.status === "nonFactura" ? "nonInvoice" : item.status,
        data: item.data || item.rawData || null,
      }));
    }

    changes[DATA_KEYS.SCHEMA] = SCHEMA_VERSION;
    await this.set(changes);
    this._settings = null;
  },
};
