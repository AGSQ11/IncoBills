/**
 * IncoBills — background entry point: listeners and messages from popup/options.
 *
 * @license MIT
 */

const ready = Storage.migrate().catch((err) => console.error("IncoBills: migration failed", err));

browser.messages.onNewMailReceived.addListener((folder, messages) => {
  ready.then(() => EmailMonitor.handleNewMail(folder, messages)).catch((err) => console.error("IncoBills: new mail handler failed", err));
});

browser.notifications.onClicked.addListener((notificationId) => {
  browser.notifications.clear(notificationId);
  if (String(notificationId).startsWith("incobills")) browser.runtime.openOptionsPage().catch(() => {});
});

ready.then(() => Menus.init()).catch((err) => console.error("IncoBills: menu setup failed", err));
ready.then(() => SAGAExport.resumePending()).catch((err) => console.error("[SAGA] resume failed", err));

// Live scan progress for the options page.
browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "scan" || (port.sender && port.sender.id !== browser.runtime.id)) return;
  const unsubscribe = EmailMonitor.subscribe((state) => port.postMessage({ type: "progress", state }));
  port.postMessage({ type: "progress", state: EmailMonitor.getScanState() });
  port.onDisconnect.addListener(unsubscribe); // The scan continues when the page closes.
});

/** Run a handler; errors become { success: false, error }. */
async function respond(fn) {
  try {
    return await fn();
  } catch (err) {
    console.error("IncoBills:", err);
    return { success: false, error: Text.shortError(err, 500) };
  }
}

async function handleMessage(message) {
  await ready;
  switch (message.type) {
    // ---- General ----
    case "getStats":
      return History.getStats();
    case "getHistory":
      return History.getAll();
    case "getRecentHistory":
      return History.getRecent(message.count || 5);
    case "clearHistory":
      return respond(async () => (await History.clear(), { success: true }));
    case "exportCSV":
      return History.exportCSV();
    case "getSettings":
      return Storage.getSettings();
    case "saveSettings":
      return respond(async () => {
        const before = await Storage.getSettings();
        const saved = await Storage.saveSettings(message.data);
        FolderManager.clearCache();
        const backendKeys = ["aiBackend", "claudeApiUrl", "claudeApiKey", "openaiApiUrl", "openaiApiKey", "ollamaUrl"];
        if (backendKeys.some((key) => key in saved && saved[key] !== before[key])) await Classifier.resetStatus();
        return { success: true };
      });
    case "getAccounts":
      return (await browser.accounts.list()).map((a) => ({ id: a.id, name: a.name, type: a.type }));
    case "testBackend":
      return respond(async () => (await Classifier.testBackend(message.backend, message.options), { success: true }));
    case "getEnabled":
      return Storage.get("enabled");
    case "setEnabled":
      return respond(async () => (await Storage.saveSettings({ enabled: Boolean(message.enabled) }), { success: true }));
    case "getBackendStatus": {
      // Only report failures of the backend that is selected now.
      const [status, settings] = await Promise.all([Storage.getData(DATA_KEYS.BACKEND_STATUS, { ok: true }), Storage.getSettings()]);
      return status.ok === false && status.backend !== settings.aiBackend ? { ok: true } : status;
    }

    // ---- Scan ----
    case "estimateScan":
      return respond(async () => ({ success: true, estimate: await EmailMonitor.estimateScan(message.params || {}) }));
    case "startScan":
      return respond(async () => ({ success: true, state: EmailMonitor.startScan(message.params || {}) }));
    case "cancelScan":
      return { success: true, state: EmailMonitor.cancelScan() };
    case "getScanState":
      return EmailMonitor.getScanState();
    case "resetProcessed":
      return respond(async () => (await History.resetProcessed(), { success: true }));

    // ---- Sender rules ----
    case "getSenderRules":
      return SenderRules.getAll();
    case "removeSenderRule":
      return respond(async () => (await SenderRules.remove(message.key), { success: true }));

    // ---- SAGA ----
    case "sagaGetCompanies":
      return CompanyRegistry.getAll();
    case "sagaAddCompany":
      return respond(async () => ({ success: true, company: await CompanyRegistry.add(message.data) }));
    case "sagaUpdateCompany":
      return respond(async () => ({ success: true, company: await CompanyRegistry.update(message.id, message.data) }));
    case "sagaDeleteCompany":
      return respond(async () => ({ success: await CompanyRegistry.delete(message.id) }));
    case "sagaAnafLookup":
      return respond(async () => {
        const info = await ANAF.lookup(message.cif, message.date);
        return info ? { success: true, info } : { success: false, error: t("errAnafNotFound") };
      });
    case "sagaGetQueue":
      return SAGAExport.getQueue();
    case "sagaGetSummary":
      return SAGAExport.getSummary();
    case "sagaUpdateQueueItem":
      return respond(() => SAGAExport.updateItem(message.id, message.changes || {}, { markReviewed: Boolean(message.markReviewed) }));
    case "sagaRemoveQueueItem":
      return respond(async () => ({ success: await SAGAExport.removeFromQueue(message.id) }));
    case "sagaClearQueue":
      return respond(async () => (await SAGAExport.clearQueue(), { success: true }));
    case "sagaRetryQueueItem":
      return respond(async () => ({ success: true, added: (await SAGAExport.retry(message.id)).length }));
    case "sagaExportItems":
      return respond(async () => ({ success: true, results: await SAGAExport.exportItems(message.itemIds) }));
    case "sagaExportAll":
      return respond(async () => ({ success: true, results: await SAGAExport.exportAll() }));
    case "sagaGetSettings":
      return SAGAExport.getSettings();
    case "sagaSaveSettings":
      return respond(async () => (await SAGAExport.saveSettings(message.data), { success: true }));

    default:
      return { success: false, error: `Unknown message type: ${message.type}` };
  }
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message.type !== "string") return undefined;
  if (sender && sender.id && sender.id !== browser.runtime.id) return undefined;
  return handleMessage(message);
});

console.log("IncoBills: extension loaded.");
