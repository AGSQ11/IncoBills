/**
 * IncoBills — folder manager. Finds or creates "<Invoices>/YYYY-MM" per
 * account (or in one unified account) and moves/copies messages there.
 *
 * @license MIT
 */

const FolderManager = {
  _cache: {}, // cacheKey → folderId
  _inflight: new Map(), // cacheKey → Promise<folderId>

  /** Run `factory` once per key at a time; parallel callers share the promise. */
  _once(key, factory) {
    if (this._inflight.has(key)) return this._inflight.get(key);
    const promise = factory().finally(() => this._inflight.delete(key));
    this._inflight.set(key, promise);
    return promise;
  },

  async _cachedFolder(key) {
    const id = this._cache[key];
    if (!id) return null;
    try {
      await browser.folders.get(id);
      return id;
    } catch {
      delete this._cache[key];
      return null;
    }
  },

  /** True if the folder is inside the invoices tree (any path segment equals the name). */
  isInvoicesFolder(folder, folderName) {
    if (!folder || !folder.path) return false;
    const target = String(folderName || DEFAULTS.folderName).toLowerCase();
    return folder.path.split("/").some((segment) => segment.toLowerCase() === target);
  },

  /**
   * Move or copy one message into the invoices tree.
   * @returns {Promise<{action: "moved"|"copied"|"already", folderId: string}>}
   */
  async moveToInvoices(message, sourceAccountId, settingsArg) {
    const settings = settingsArg || (await Storage.getSettings());
    const folderId = await this.getTargetFolder(sourceAccountId, message.date, settings);
    if (message.folder && message.folder.id === folderId) return { action: "already", folderId };

    if (settings.mailAction === "copy") {
      await browser.messages.copy([message.id], folderId);
      return { action: "copied", folderId };
    }
    // messages.move() handles cross-account moves itself (copy + delete inside Thunderbird).
    await browser.messages.move([message.id], folderId);
    return { action: "moved", folderId };
  },

  async getTargetFolder(sourceAccountId, messageDate, settingsArg) {
    const settings = settingsArg || (await Storage.getSettings());
    const folderName = settings.folderName || DEFAULTS.folderName;

    let accountId = sourceAccountId;
    if (settings.folderMode === "unified") {
      accountId = settings.unifiedAccountId;
      if (!accountId) {
        const accounts = await browser.accounts.list();
        accountId = accounts.length > 0 ? accounts[0].id : sourceAccountId;
      }
    }

    const parentId = await this.ensureParentFolder(accountId, folderName, settings);
    const monthKey = Text.monthKey(messageDate);
    const key = `${accountId}:${folderName}:${monthKey}`;

    const cached = await this._cachedFolder(key);
    if (cached) return cached;

    return this._once(key, async () => {
      try {
        const subFolders = await browser.folders.getSubFolders(parentId, false);
        const existing = subFolders.find((f) => f.name === monthKey);
        if (existing) return (this._cache[key] = existing.id);
      } catch {
        /* fall through to create */
      }
      try {
        const created = await browser.folders.create(parentId, monthKey);
        console.log(`IncoBills: created "${folderName}/${monthKey}" in account ${accountId}`);
        return (this._cache[key] = created.id);
      } catch (err) {
        // Another client may have created it in the meantime: look again.
        try {
          const again = await browser.folders.getSubFolders(parentId, false);
          const found = again.find((f) => f.name === monthKey);
          if (found) return (this._cache[key] = found.id);
        } catch {
          /* ignore */
        }
        console.warn(`IncoBills: cannot create monthly folder "${monthKey}":`, err.message);
        return parentId;
      }
    });
  },

  async ensureParentFolder(accountId, folderName, settingsArg) {
    const settings = settingsArg || (await Storage.getSettings());
    const key = `${accountId}:${folderName}`;
    const cached = await this._cachedFolder(key);
    if (cached) return cached;

    return this._once(key, async () => {
      const existing = await browser.folders.query({ accountId, name: folderName });
      // Prefer the top-most folder with this name ("/Invoices" over "/Archive/Invoices").
      // Never use one inside Trash or Junk (e.g. after the user deleted the folder).
      const depth = (f) => (f.path || "").split("/").length;
      existing.sort((a, b) => depth(a) - depth(b));
      for (const candidate of existing) {
        if (!(await this._insideTrashOrJunk(candidate))) return (this._cache[key] = candidate.id);
      }

      const account = await browser.accounts.get(accountId);
      if (account && account.rootFolder) {
        try {
          const created = await browser.folders.create(account.rootFolder.id, folderName);
          console.log(`IncoBills: created "${folderName}" in account ${accountId}`);
          return (this._cache[key] = created.id);
        } catch (err) {
          console.warn(`IncoBills: cannot create "${folderName}" under the root of ${accountId}:`, err.message);
        }
      }

      try {
        // Some IMAP servers allow new folders only inside the INBOX namespace (INBOX.Invoices).
        const inbox = await browser.folders.query({ accountId, specialUse: ["inbox"] });
        if (inbox.length > 0) {
          const created = await browser.folders.create(inbox[0].id, folderName);
          return (this._cache[key] = created.id);
        }
      } catch (err) {
        console.warn(`IncoBills: cannot create "${folderName}" inside the inbox of ${accountId}:`, err.message);
      }

      // Local Folders keeps mail only on this computer, so it is opt-in.
      if (settings.allowLocalFoldersFallback) {
        const localId = await this._findLocalFoldersFolder(folderName);
        if (localId) return (this._cache[key] = localId);
      }

      throw new Error(t("errCannotCreateFolder", [folderName]));
    });
  },

  TRASH_NAMES: ["trash", "junk", "spam", "deleted items", "deleted messages", "bin", "cos de gunoi", "gunoi"],

  /** True if the folder or one of its parents is Trash/Junk. */
  async _insideTrashOrJunk(folder) {
    const isBad = (f) =>
      [].concat(f.specialUse || [], f.type ? [f.type] : []).some((use) => use === "trash" || use === "junk") ||
      this.TRASH_NAMES.includes(Text.normalize(f.name || ""));
    if (isBad(folder)) return true;
    try {
      const parents = await browser.folders.getParentFolders(folder.id, false);
      return parents.some(isBad);
    } catch {
      // Fallback on the path when getParentFolders is not available.
      return String(folder.path || "")
        .split("/")
        .slice(0, -1)
        .some((segment) => this.TRASH_NAMES.includes(Text.normalize(segment)));
    }
  },

  async _findLocalFoldersFolder(folderName) {
    const accounts = await browser.accounts.list();
    for (const account of accounts) {
      if (account.type !== "none" && account.type !== "local") continue;
      const existing = await browser.folders.query({ accountId: account.id, name: folderName });
      if (existing.length > 0) return existing[0].id;
      try {
        const created = await browser.folders.create(account.rootFolder.id, folderName);
        console.log(`IncoBills: created "${folderName}" in Local Folders`);
        return created.id;
      } catch (err) {
        console.warn("IncoBills: cannot create the folder in Local Folders:", err.message);
      }
    }
    return null;
  },

  clearCache() {
    this._cache = {};
  },
};
