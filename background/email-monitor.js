/**
 * IncoBills — email monitor: new mail, scans of existing mail, metadata.
 *
 * @license MIT
 */

const EmailMonitor = {
  scanState: {
    running: false,
    cancelRequested: false,
    processed: 0,
    total: 0,
    found: 0,
    errors: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
    cancelled: false,
  },
  _listeners: new Set(),
  _lastEmit: 0,

  isAccountMonitored(settings, accountId) {
    if (settings.monitorMode !== "selected") return true;
    return (settings.monitoredAccounts || []).includes(accountId);
  },

  /** Walk all pages of a MessageList. */
  async *iterate(messageList) {
    let page = messageList;
    while (page) {
      for (const message of page.messages || []) yield message;
      if (!page.id) break;
      page = await browser.messages.continueList(page.id);
    }
  },

  // ---------------------------------------------------------------
  //  New mail
  // ---------------------------------------------------------------

  async handleNewMail(folder, messageList) {
    const settings = await Storage.getSettings();
    if (!settings.enabled || !this.isAccountMonitored(settings, folder.accountId)) return;

    const detected = [];
    for await (const message of this.iterate(messageList)) {
      try {
        const result = await this.processMessage(message, settings, { accountId: folder.accountId, folder });
        if (result && result.isMatch) detected.push({ message, action: result.action });
      } catch (err) {
        console.error("IncoBills: error processing message", message.id, err);
      }
    }
    await History.flush();
    if (settings.showNotification && detected.length > 0) await this.notifyDetected(detected, settings);
  },

  async notifyDetected(detected, settings) {
    const folderName = settings.folderName || DEFAULTS.folderName;
    if (detected.length === 1) {
      const { message } = detected[0];
      await browser.notifications
        .create(`incobills-${message.id}`, {
          type: "basic",
          iconUrl: "icons/icon-96.svg",
          title: t("notifDetectedTitle"),
          message: `${message.author || ""}\n${message.subject || ""}`,
        })
        .catch(() => {});
      return;
    }
    const actions = new Set(detected.map((d) => d.action));
    const only = actions.size === 1 ? [...actions][0] : null;
    const key = only === "moved" ? "notifBatchMoved" : only === "copied" ? "notifBatchCopied" : "notifBatchDetected";
    await browser.notifications
      .create(`incobills-batch-${Date.now()}`, {
        type: "basic",
        iconUrl: "icons/icon-96.svg",
        title: "IncoBills",
        message: t(key, [detected.length, folderName]),
      })
      .catch(() => {});
  },

  // ---------------------------------------------------------------
  //  One message
  // ---------------------------------------------------------------

  /**
   * Classify one message and act on it.
   * @returns {Promise<null|{isMatch: boolean, action: string, classification: object}>}
   *          null when the message was processed before.
   */
  async processMessage(message, settings, { accountId, folder } = {}) {
    if (await History.isProcessed(message)) return null;

    const sourceFolder = message.folder || folder || null;
    const sourceAccountId = (sourceFolder && sourceFolder.accountId) || accountId;
    const metadata = await this.extractMetadata(message);
    const classification = await Classifier.classify(metadata, settings);
    const isMatch = classification.isInvoice && classification.confidence >= settings.confidenceThreshold;

    let action = "skipped";
    let error = null;
    let targetFolderId = null;

    if (isMatch) {
      // Read invoice attachments before the move: afterwards the message id may change.
      let sagaAttachments = [];
      try {
        sagaAttachments = await SAGAExport.collectAttachments(message, metadata.attachments);
      } catch (err) {
        console.error("[SAGA] cannot read attachments:", err);
      }

      if (settings.autoMove && !settings.notifyOnly) {
        try {
          const moved = await FolderManager.moveToInvoices(message, sourceAccountId, settings);
          action = moved.action;
          targetFolderId = moved.folderId;
        } catch (err) {
          action = "move_failed";
          error = Text.shortError(err);
          console.error("IncoBills: move/copy failed for", message.id, err);
        }
      } else {
        action = "flagged";
      }

      if (sagaAttachments.length > 0) SAGAExport.enqueue(this.messageMeta(message), sagaAttachments);
    }

    await History.log({
      messageId: message.id,
      headerMessageId: message.headerMessageId || null,
      from: message.author || "",
      subject: message.subject || "",
      accountId: sourceAccountId || null,
      sourceFolderId: (sourceFolder && sourceFolder.id) || null,
      targetFolderId,
      classification,
      backend: settings.aiBackend,
      action,
      error,
      userOverride: null,
    });

    // An AI failure that led to "skipped" is not final: a later scan retries it.
    if (!(classification.fallback && action === "skipped")) await History.markProcessed(message);
    return { isMatch, action, classification };
  },

  messageMeta(message) {
    return {
      messageId: message.id,
      headerMessageId: message.headerMessageId || null,
      subject: message.subject || "",
      from: message.author || "",
      date: message.date ? new Date(message.date).toISOString() : null,
    };
  },

  // ---------------------------------------------------------------
  //  Metadata
  // ---------------------------------------------------------------

  async extractMetadata(message) {
    const [full, attachments] = await Promise.all([browser.messages.getFull(message.id), this.listAttachments(message.id)]);
    const body = this.extractBodyText(full);
    return {
      subject: message.subject || "",
      from: message.author || "",
      date: message.date,
      bodySnippet: body.slice(0, BODY_MAX_LENGTH),
      attachmentNames: attachments.map((a) => a.name).filter(Boolean),
      attachments,
    };
  },

  async listAttachments(messageId) {
    try {
      return (await browser.messages.listAttachments(messageId)) || [];
    } catch (err) {
      console.warn("IncoBills: listAttachments failed", err);
      return [];
    }
  },

  /** Prefer a real text/plain body; use stripped HTML when plain text is only a stub. */
  extractBodyText(root) {
    let plain = "";
    let html = "";
    const walk = (part) => {
      if (!part || (plain && html)) return;
      const isAttachment = Boolean(part.name) || /attachment/i.test(String((part.headers && part.headers["content-disposition"]) || ""));
      if (!isAttachment && part.body) {
        const type = String(part.contentType || "").toLowerCase();
        if (type === "text/plain" && !plain) plain = part.body;
        else if (type === "text/html" && !html) html = Text.stripHtml(part.body);
      }
      for (const sub of part.parts || []) walk(sub);
    };
    walk(root);
    const plainUseful = plain.replace(/\s+/g, " ").trim().length >= 40;
    return (plainUseful ? plain : html || plain).trim();
  },

  // ---------------------------------------------------------------
  //  Scan existing mail
  // ---------------------------------------------------------------

  shouldSkipFolder(folder, settings) {
    if (!folder) return false;
    const specialUse = [].concat(folder.specialUse || [], folder.type ? [folder.type] : []);
    if (specialUse.some((use) => SCAN_EXCLUDED_SPECIAL_USE.includes(use))) return true;
    return FolderManager.isInvoicesFolder(folder, settings.folderName);
  },

  async collectScanMessages({ accountId, fromDate, toDate }, settings) {
    const query = {};
    if (accountId) query.accountId = accountId;
    const from = Text.parseLocalDate(fromDate);
    const to = Text.parseLocalDate(toDate, true);
    if (from) query.fromDate = from;
    if (to) query.toDate = to;

    const messages = [];
    const first = await browser.messages.query(query);
    for await (const message of this.iterate(first)) {
      const folder = message.folder;
      if (this.shouldSkipFolder(folder, settings)) continue;
      if (!accountId && folder && !this.isAccountMonitored(settings, folder.accountId)) continue;
      messages.push(message);
    }
    return messages;
  },

  async estimateScan(params) {
    const settings = await Storage.getSettings();
    const messages = await this.collectScanMessages(params, settings);
    let pending = 0;
    for (const message of messages) if (!(await History.isProcessed(message))) pending++;
    return {
      total: messages.length,
      pending,
      backend: settings.aiBackend,
      hybrid: Boolean(settings.hybridMode),
      approxInputTokens: settings.aiBackend === "keywords" ? 0 : pending * 700,
    };
  },

  getScanState() {
    return { ...this.scanState };
  },

  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  },

  _emit(force = false) {
    const now = Date.now();
    if (!force && now - this._lastEmit < 250) return;
    this._lastEmit = now;
    const state = this.getScanState();
    for (const listener of this._listeners) {
      try {
        listener(state);
      } catch {
        /* a closed port */
      }
    }
  },

  /** Start a scan in the background. Progress goes to subscribers. */
  startScan(params) {
    if (this.scanState.running) throw new Error(t("errScanRunning"));
    Object.assign(this.scanState, {
      running: true,
      cancelRequested: false,
      cancelled: false,
      processed: 0,
      total: 0,
      found: 0,
      errors: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    });
    this._emit(true);
    this._runScan(params)
      .catch((err) => {
        this.scanState.error = Text.shortError(err);
        console.error("IncoBills: scan failed", err);
      })
      .finally(async () => {
        this.scanState.running = false;
        this.scanState.finishedAt = new Date().toISOString();
        await History.flush().catch(() => {});
        this._emit(true);
      });
    return this.getScanState();
  },

  cancelScan() {
    if (this.scanState.running) this.scanState.cancelRequested = true;
    return this.getScanState();
  },

  async _runScan(params) {
    const settings = await Storage.getSettings();
    const messages = await this.collectScanMessages(params, settings);
    this.scanState.total = messages.length;
    this._emit(true);

    for (const message of messages) {
      if (this.scanState.cancelRequested) {
        this.scanState.cancelled = true;
        break;
      }
      try {
        const result = await this.processMessage(message, settings, { accountId: message.folder && message.folder.accountId });
        if (result && result.isMatch) this.scanState.found++;
      } catch (err) {
        this.scanState.errors++;
        console.error("IncoBills: error scanning message", message.id, err);
        await History.log({
          messageId: message.id,
          headerMessageId: message.headerMessageId || null,
          from: message.author || "",
          subject: message.subject || "",
          accountId: (message.folder && message.folder.accountId) || null,
          classification: { isInvoice: false, confidence: 0, reason: `scan error: ${Text.shortError(err)}` },
          backend: settings.aiBackend,
          action: "error",
          userOverride: null,
        }).catch(() => {});
      }
      this.scanState.processed++;
      this._emit();
    }
  },
};
