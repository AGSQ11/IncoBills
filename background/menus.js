/**
 * IncoBills — message list context menu: "Mark as invoice" / "Not an invoice".
 * Each choice creates a sender rule, so the next email from that sender is
 * classified the same way without an AI call.
 *
 * @license MIT
 */

const Menus = {
  IDS: { invoice: "incobills-mark-invoice", notInvoice: "incobills-mark-not-invoice" },

  async init() {
    if (!browser.menus) return;
    await browser.menus.removeAll().catch(() => {});
    browser.menus.create({ id: this.IDS.invoice, title: t("menuMarkInvoice"), contexts: ["message_list"] });
    browser.menus.create({ id: this.IDS.notInvoice, title: t("menuMarkNotInvoice"), contexts: ["message_list"] });
    browser.menus.onClicked.addListener((info) => {
      const verdict = info.menuItemId === this.IDS.invoice ? "invoice" : info.menuItemId === this.IDS.notInvoice ? "notInvoice" : null;
      if (!verdict || !info.selectedMessages) return;
      this.apply(info.selectedMessages, verdict).catch((err) => console.error("IncoBills: menu action failed", err));
    });
  },

  async apply(messageList, verdict) {
    const settings = await Storage.getSettings();
    let count = 0;
    for await (const message of EmailMonitor.iterate(messageList)) {
      await SenderRules.set(message.author, verdict);
      if (verdict === "invoice") await this.markInvoice(message, settings);
      else await this.markNotInvoice(message, settings);
      count++;
    }
    await History.flush();
    await browser.notifications
      .create(`incobills-menu-${Date.now()}`, {
        type: "basic",
        iconUrl: "icons/icon-96.svg",
        title: "IncoBills",
        message: t(verdict === "invoice" ? "notifMarkedInvoice" : "notifMarkedNotInvoice", [count]),
      })
      .catch(() => {});
  },

  async markInvoice(message, settings) {
    const previous = await History.findByHeaderId(message.headerMessageId);
    const folder = message.folder || null;
    const alreadyInFolder = FolderManager.isInvoicesFolder(folder, settings.folderName);
    let action = alreadyInFolder ? "already" : "flagged";
    let targetFolderId = null;
    let error = null;
    const attachments = await EmailMonitor.listAttachments(message.id);
    const sagaAttachments = await SAGAExport.collectAttachments(message, attachments).catch(() => []);

    if (settings.autoMove && !settings.notifyOnly && !alreadyInFolder) {
      try {
        const moved = await FolderManager.moveToInvoices(message, folder && folder.accountId, settings);
        action = moved.action;
        targetFolderId = moved.folderId;
      } catch (err) {
        action = "move_failed";
        error = Text.shortError(err);
      }
    }
    if (sagaAttachments.length > 0) SAGAExport.enqueue(EmailMonitor.messageMeta(message), sagaAttachments);

    const classification = { isInvoice: true, confidence: 1, reason: "marked by user", source: "user" };
    if (previous) {
      // Update the existing entry, so one message is counted once.
      const keepAction = DETECTED_ACTIONS.includes(previous.action) && (action === "already" || action === "flagged");
      await History.updateEntry(previous.id, {
        userOverride: "invoice",
        classification,
        action: keepAction ? previous.action : action,
        targetFolderId: targetFolderId || previous.targetFolderId || null,
        sourceFolderId: previous.sourceFolderId || (folder && folder.id) || null,
        error,
      });
    } else {
      await History.log({
        messageId: message.id,
        headerMessageId: message.headerMessageId || null,
        from: message.author || "",
        subject: message.subject || "",
        accountId: (folder && folder.accountId) || null,
        sourceFolderId: (folder && folder.id) || null,
        targetFolderId,
        classification,
        backend: "user",
        action,
        error,
        userOverride: "invoice",
      });
    }
    await History.markProcessed(message);
  },

  async markNotInvoice(message, settings) {
    const previous = await History.findByHeaderId(message.headerMessageId);
    if (previous) await History.updateOverride(previous.id, "notInvoice");

    // Undo our move: put the message back where it came from.
    const folder = message.folder || null;
    const source = previous && previous.sourceFolderId;
    if (source && FolderManager.isInvoicesFolder(folder, settings.folderName) && previous.action === "moved") {
      try {
        await browser.messages.move([message.id], source);
      } catch (err) {
        console.warn("IncoBills: cannot move the message back", err);
      }
    }
    await History.markProcessed(message);
  },
};
