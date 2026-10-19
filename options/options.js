/**
 * IncoBills — options page.
 *
 * @license MIT
 */

const HISTORY_PAGE_SIZE = 50;
let historyOffset = 0;
let allHistory = [];
let historySortDesc = true;
let accounts = [];
let companies = [];
let queue = [];
let currentSettings = null;
let currentSagaSettings = null;
let currentReview = null;
let lastScanFinishedAt = null;

const $ = (id) => document.getElementById(id);
const send = (type, data = {}) => browser.runtime.sendMessage({ type, ...data });

/** Create an element without innerHTML. */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === "className") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key in node && typeof value !== "string") node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function clear(node) {
  while (node.lastChild) node.removeChild(node.lastChild);
}

function flash(node, text, isError = false, ms = 6000) {
  node.textContent = text;
  node.classList.toggle("is-error", isError);
  if (ms) setTimeout(() => {
    if (node.textContent === text) node.textContent = "";
  }, ms);
}

function senderName(from) {
  const match = String(from || "").match(/^"?([^"<]+)"?\s*</);
  return match ? match[1].trim() : String(from || "").split("@")[0] || from;
}

function backendLabel(backend) {
  return t(`backendName_${backend}`) || backend;
}

document.addEventListener("DOMContentLoaded", async () => {
  I18n.localizePage();
  $("sortDate").textContent = `${t("colDate")} ▼`;
  await loadSettings();
  await Promise.all([loadAccounts(), loadSagaSettings(), loadHistory(), loadRules(), loadBackendStatus()]);
  await loadSagaCompanies();
  await loadSagaQueue();
  bindEvents();
  bindSagaEvents();
  bindReview();
  setDefaultScanDates();
  connectScanPort();
  updateSagaWarnings();
  if (location.hash === "#saga") $("saga").scrollIntoView();
});

// ============================================================
//  Settings
// ============================================================

async function loadSettings() {
  const s = await send("getSettings");
  currentSettings = s;
  const radio = document.querySelector(`input[name="aiBackend"][value="${s.aiBackend}"]`);
  if (radio) radio.checked = true;
  for (const id of ["claudeApiUrl", "claudeApiKey", "claudeModel", "claudeExtractModel", "openaiApiUrl", "openaiApiKey", "openaiModel", "openaiExtractModel", "ollamaUrl", "ollamaModel", "ollamaExtractModel", "folderName"]) {
    $(id).value = s[id] || "";
  }
  $("confidenceThreshold").value = s.confidenceThreshold;
  $("thresholdValue").textContent = Number(s.confidenceThreshold).toFixed(2);
  const folderMode = document.querySelector(`input[name="folderMode"][value="${s.folderMode || "perAccount"}"]`);
  if (folderMode) folderMode.checked = true;
  const mailAction = document.querySelector(`input[name="mailAction"][value="${s.mailAction || "move"}"]`);
  if (mailAction) mailAction.checked = true;
  $("hybridMode").checked = s.hybridMode !== false;
  $("autoMove").checked = s.autoMove !== false;
  $("showNotification").checked = s.showNotification !== false;
  $("notifyOnly").checked = s.notifyOnly === true;
  $("allowLocalFoldersFallback").checked = s.allowLocalFoldersFallback === true;
}

async function loadSagaSettings() {
  const s = await send("sagaGetSettings");
  currentSagaSettings = s;
  $("sagaExportSubdir").value = s.exportSubdirectory || "";
  $("sagaAutoExtract").checked = s.autoExtractPDFs !== false;
  $("sagaCloudConsent").checked = s.cloudConsent === true;
  $("sagaAnafLookup").checked = s.anafLookup !== false;
  $("sagaSkipDomestic").checked = s.skipDomesticSuppliers === true;
}

async function loadAccounts() {
  accounts = await send("getAccounts");
  const settings = currentSettings || (await send("getSettings"));
  const monitored = settings.monitoredAccounts || [];
  const all = settings.monitorMode !== "selected";

  const listEl = $("accountsList");
  const scanSelect = $("scanAccount");
  const unifiedSelect = $("unifiedAccount");
  clear(listEl);
  scanSelect.length = 1;
  unifiedSelect.length = 1;

  for (const account of accounts) {
    const checkbox = el("input", { type: "checkbox", className: "account-check", value: account.id, checked: all || monitored.includes(account.id) });
    checkbox.addEventListener("change", updateAccountsWarning);
    listEl.appendChild(el("label", { className: "account-item" }, [checkbox, el("span", { text: account.name || account.id }), el("span", { className: "account-type", text: account.type || "" })]));
    scanSelect.appendChild(el("option", { value: account.id, text: account.name || account.id }));
    unifiedSelect.appendChild(el("option", { value: account.id, text: account.name || account.id, selected: settings.unifiedAccountId === account.id }));
  }
  if (accounts.length === 0) listEl.appendChild(el("div", { className: "loading", text: t("noAccounts") }));
  updateAccountsWarning();
}

function updateAccountsWarning() {
  const checks = [...document.querySelectorAll(".account-check")];
  $("accountsWarning").hidden = !(checks.length > 0 && checks.every((cb) => !cb.checked));
}

/** Origins of custom API URLs that need an optional host permission. */
function customOrigins() {
  const patterns = new Set();
  for (const id of ["claudeApiUrl", "openaiApiUrl", "ollamaUrl"]) {
    const value = $(id).value.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      const origin = `${url.protocol}//${url.hostname}`;
      if (!BUILTIN_HOST_ORIGINS.includes(origin)) patterns.add(`${url.protocol}//${url.hostname}/*`);
    } catch {
      /* invalid URL: the test button reports it */
    }
  }
  return [...patterns];
}

async function saveSettings() {
  const status = $("saveStatus");
  // permissions.request() must run first, inside the click handler.
  const origins = customOrigins();
  let permissionNote = "";
  if (origins.length > 0) {
    try {
      const granted = await browser.permissions.request({ origins });
      if (!granted) permissionNote = " " + t("warnPermissionDenied", [origins.join(", ")]);
    } catch (err) {
      permissionNote = " " + t("warnPermissionDenied", [origins.join(", ")]);
    }
  }

  const backend = document.querySelector('input[name="aiBackend"]:checked');
  const checks = [...document.querySelectorAll(".account-check")];
  const allChecked = checks.length === 0 || checks.every((cb) => cb.checked);

  const data = {
    aiBackend: backend ? backend.value : "keywords",
    claudeApiUrl: $("claudeApiUrl").value.trim() || DEFAULTS.claudeApiUrl,
    claudeApiKey: $("claudeApiKey").value.trim(),
    claudeModel: $("claudeModel").value.trim() || DEFAULTS.claudeModel,
    claudeExtractModel: $("claudeExtractModel").value.trim(),
    openaiApiUrl: $("openaiApiUrl").value.trim() || DEFAULTS.openaiApiUrl,
    openaiApiKey: $("openaiApiKey").value.trim(),
    openaiModel: $("openaiModel").value.trim() || DEFAULTS.openaiModel,
    openaiExtractModel: $("openaiExtractModel").value.trim(),
    ollamaUrl: $("ollamaUrl").value.trim() || DEFAULTS.ollamaUrl,
    ollamaModel: $("ollamaModel").value.trim() || DEFAULTS.ollamaModel,
    ollamaExtractModel: $("ollamaExtractModel").value.trim(),
    confidenceThreshold: parseFloat($("confidenceThreshold").value),
    hybridMode: $("hybridMode").checked,
    folderName: $("folderName").value.trim() || DEFAULTS.folderName,
    folderMode: (document.querySelector('input[name="folderMode"]:checked') || {}).value || "perAccount",
    unifiedAccountId: $("unifiedAccount").value || "",
    mailAction: (document.querySelector('input[name="mailAction"]:checked') || {}).value || "move",
    allowLocalFoldersFallback: $("allowLocalFoldersFallback").checked,
    autoMove: $("autoMove").checked,
    showNotification: $("showNotification").checked,
    notifyOnly: $("notifyOnly").checked,
    monitorMode: allChecked ? "all" : "selected",
    monitoredAccounts: allChecked ? [] : checks.filter((cb) => cb.checked).map((cb) => cb.value),
  };
  const sagaData = {
    exportSubdirectory: $("sagaExportSubdir").value.trim(),
    autoExtractPDFs: $("sagaAutoExtract").checked,
    cloudConsent: $("sagaCloudConsent").checked,
    anafLookup: $("sagaAnafLookup").checked,
    skipDomesticSuppliers: $("sagaSkipDomestic").checked,
  };

  const [r1, r2] = await Promise.all([send("saveSettings", { data }), send("sagaSaveSettings", { data: sagaData })]);
  if (!r1.success || !r2.success) {
    flash(status, t("saveFailed", [(r1.error || r2.error || "").toString()]), true);
    return;
  }
  currentSettings = await send("getSettings");
  await loadSagaSettings();
  updateSagaWarnings();
  flash(status, t("saved") + permissionNote, Boolean(permissionNote), permissionNote ? 12000 : 3000);
}

async function testBackend(backend) {
  const button = $(`test${backend.charAt(0).toUpperCase()}${backend.slice(1)}`);
  const original = button.textContent;
  const options =
    backend === "ollama"
      ? { url: $("ollamaUrl").value, model: $("ollamaModel").value }
      : { apiKey: $(`${backend}ApiKey`).value, apiUrl: $(`${backend}ApiUrl`).value, model: $(`${backend}Model`).value };
  button.textContent = t("testing");
  button.disabled = true;
  const result = await send("testBackend", { backend, options }).catch((err) => ({ success: false, error: err.message }));
  button.textContent = result.success ? t("testOk") : t("testFailed");
  button.classList.toggle("btn-ok", Boolean(result.success));
  button.classList.toggle("btn-fail", !result.success);
  if (!result.success) alert(t("testFailedDetail", [result.error || "?"]));
  setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
    button.classList.remove("btn-ok", "btn-fail");
  }, 3000);
}

async function loadBackendStatus() {
  const status = await send("getBackendStatus");
  const banner = $("backendBanner");
  if (status && status.ok === false) {
    banner.textContent = t("bannerBackendFailing", [backendLabel(status.backend), status.error || ""]);
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

function updateSagaWarnings() {
  const box = $("sagaBackendWarning");
  const backend = currentSettings && currentSettings.aiBackend;
  let text = "";
  if (companies.length > 0 && backend === "keywords") text = t("warnSagaNeedsAi");
  else if (companies.length > 0 && (backend === "claude" || backend === "openai") && !(currentSagaSettings && currentSagaSettings.cloudConsent)) text = t("warnSagaConsent");
  box.textContent = text;
  box.hidden = !text;
}

// ============================================================
//  Events
// ============================================================

function bindEvents() {
  $("confidenceThreshold").addEventListener("input", () => {
    $("thresholdValue").textContent = Number($("confidenceThreshold").value).toFixed(2);
  });
  const updateUnified = () => {
    $("unifiedAccountGroup").hidden = document.querySelector('input[name="folderMode"]:checked').value !== "unified";
  };
  document.querySelectorAll('input[name="folderMode"]').forEach((radio) => radio.addEventListener("change", updateUnified));
  updateUnified();

  $("btnSave").addEventListener("click", saveSettings);
  for (const backend of ["claude", "openai", "ollama"]) {
    $(`test${backend.charAt(0).toUpperCase()}${backend.slice(1)}`).addEventListener("click", (e) => {
      e.preventDefault();
      testBackend(backend);
    });
  }

  $("sortDate").addEventListener("click", () => {
    historySortDesc = !historySortDesc;
    $("sortDate").textContent = `${t("colDate")} ${historySortDesc ? "▼" : "▲"}`;
    sortAndRender();
  });
  $("btnLoadMore").addEventListener("click", renderHistoryPage);
  $("btnExportCSV").addEventListener("click", exportCSV);
  $("btnClearHistory").addEventListener("click", async () => {
    if (!confirm(t("confirmClearHistory"))) return;
    await send("clearHistory");
    await loadHistory();
  });

  $("btnScan").addEventListener("click", startScan);
  $("btnCancelScan").addEventListener("click", () => send("cancelScan"));
  $("btnResetProcessed").addEventListener("click", async () => {
    if (!confirm(t("confirmResetProcessed"))) return;
    const result = await send("resetProcessed");
    flash($("scanStatus"), result.success ? t("resetProcessedDone") : result.error, !result.success);
    $("scanProgress").hidden = false;
  });
}

// ============================================================
//  Scan
// ============================================================

function setDefaultScanDates() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  $("scanFrom").value = iso(first);
  $("scanTo").value = iso(now);
}

function connectScanPort() {
  const port = browser.runtime.connect({ name: "scan" });
  port.onMessage.addListener((message) => {
    if (message && message.type === "progress") renderScanState(message.state);
  });
}

function renderScanState(state) {
  if (!state || (!state.running && !state.finishedAt)) return;
  $("scanProgress").hidden = false;
  $("btnScan").disabled = state.running;
  $("btnCancelScan").hidden = !state.running;
  const percent = state.total ? Math.round((state.processed / state.total) * 100) : state.running ? 0 : 100;
  $("scanFill").style.width = `${percent}%`;
  let text;
  if (state.running) text = state.total ? t("scanProgress", [state.processed, state.total, state.found]) : t("scanPreparing");
  else if (state.error) text = t("scanFailed", [state.error]);
  else if (state.cancelled) text = t("scanCancelled", [state.processed, state.total, state.found]);
  else text = t("scanDone", [state.processed, state.total, state.found]);
  $("scanStatus").textContent = text;
  $("scanStatus").classList.toggle("is-error", Boolean(state.error));
  if (!state.running && state.finishedAt && state.finishedAt !== lastScanFinishedAt) {
    lastScanFinishedAt = state.finishedAt;
    loadHistory();
    loadSagaQueue();
    loadBackendStatus();
  }
}

async function startScan() {
  const params = {
    accountId: $("scanAccount").value || undefined,
    fromDate: $("scanFrom").value || undefined,
    toDate: $("scanTo").value || undefined,
  };
  $("scanProgress").hidden = false;
  $("scanStatus").textContent = t("scanCounting");
  $("btnScan").disabled = true;
  const result = await send("estimateScan", { params });
  $("btnScan").disabled = false;
  if (!result.success) {
    flash($("scanStatus"), t("scanFailed", [result.error]), true, 0);
    return;
  }
  const est = result.estimate;
  if (est.pending === 0) {
    $("scanStatus").textContent = t("scanNothing", [est.total]);
    return;
  }
  const question =
    est.backend === "keywords"
      ? t("scanConfirmLocal", [est.pending, est.total])
      : t("scanConfirmAi", [est.pending, est.total, backendLabel(est.backend), est.approxInputTokens.toLocaleString(), est.hybrid ? t("scanHybridNote") : ""]);
  if (!confirm(question)) {
    $("scanStatus").textContent = "";
    return;
  }
  const started = await send("startScan", { params });
  if (!started.success) flash($("scanStatus"), t("scanFailed", [started.error]), true, 0);
}

// ============================================================
//  History
// ============================================================

async function loadHistory() {
  allHistory = await send("getHistory");
  sortAndRender();
}

function sortAndRender() {
  allHistory.sort((a, b) => (historySortDesc ? -1 : 1) * String(a.timestamp || "").localeCompare(String(b.timestamp || "")));
  historyOffset = 0;
  renderHistoryPage();
}

function actionLabel(action) {
  const label = t(`action_${action}`);
  return label === `action_${action}` ? action : label;
}

function renderHistoryPage() {
  const tbody = $("historyBody");
  const page = allHistory.slice(0, historyOffset + HISTORY_PAGE_SIZE);
  clear(tbody);
  if (page.length === 0) {
    tbody.appendChild(el("tr", {}, el("td", { colSpan: 6, className: "empty-cell", text: t("noHistory") })));
    $("btnLoadMore").hidden = true;
    return;
  }
  for (const entry of page) {
    const date = new Date(entry.timestamp);
    const dateStr = `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    const c = entry.classification || {};
    const confidence = Number.isFinite(c.confidence) ? `${Math.round(c.confidence * 100)}%` : "-";
    const source = c.source || entry.backend || "-";
    const action = entry.action || "skipped";
    const actionText = actionLabel(action) + (entry.userOverride ? ` (${t(entry.userOverride === "invoice" ? "overrideInvoice" : "overrideNotInvoice")})` : "");
    tbody.appendChild(
      el("tr", {}, [
        el("td", { title: entry.timestamp, text: dateStr }),
        el("td", { title: entry.from || "", text: senderName(entry.from || "") }),
        el("td", { title: entry.subject || "", text: entry.subject || t("noSubject") }),
        el("td", { title: c.reason || "", text: confidence }),
        el("td", { text: c.fallback ? `${source} ⚠` : source, title: c.fallback ? c.reason : "" }),
        el("td", { className: `action-${action}`, title: entry.error || "", text: actionText }),
      ])
    );
  }
  historyOffset = page.length;
  $("btnLoadMore").hidden = historyOffset >= allHistory.length;
}

async function exportCSV() {
  const csv = await send("exportCSV");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = el("a", { href: url, download: `incobills-history-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ============================================================
//  Sender rules
// ============================================================

async function loadRules() {
  const rules = await send("getSenderRules");
  const list = $("rulesList");
  clear(list);
  const entries = Object.entries(rules || {}).sort((a, b) => String(b[1].createdAt || "").localeCompare(String(a[1].createdAt || "")));
  if (entries.length === 0) {
    list.appendChild(el("div", { className: "loading", text: t("noRules") }));
    return;
  }
  for (const [key, rule] of entries) {
    const remove = el("button", { className: "btn btn-sm btn-danger", text: t("btnDelete") });
    remove.addEventListener("click", async () => {
      await send("removeSenderRule", { key });
      await loadRules();
    });
    list.appendChild(
      el("div", { className: "rule-item" }, [
        el("span", { className: "rule-sender", text: key.replace(/^(addr|domain):/, "") }),
        el("span", { className: `badge ${rule.verdict === "invoice" ? "badge-free" : "badge-danger"}`, text: t(rule.verdict === "invoice" ? "ruleInvoice" : "ruleNotInvoice") }),
        remove,
      ])
    );
  }
}

// ============================================================
//  SAGA — companies
// ============================================================

async function loadSagaCompanies() {
  companies = (await send("sagaGetCompanies")) || [];
  const listEl = $("sagaCompaniesList");
  clear(listEl);
  if (companies.length === 0) {
    listEl.appendChild(el("div", { className: "loading", text: t("noCompanies") }));
  }
  for (const company of companies) {
    const edit = el("button", { className: "btn btn-sm", text: t("btnEdit") });
    edit.addEventListener("click", () => showCompanyForm(company));
    const del = el("button", { className: "btn btn-sm btn-danger", text: t("btnDelete") });
    del.addEventListener("click", () => deleteSagaCompany(company.id));
    listEl.appendChild(
      el("div", { className: "saga-company-item" }, [
        el("div", { className: "saga-company-info" }, [
          el("div", { className: "saga-company-name", text: company.name }),
          el("div", { className: "saga-company-cif", text: `CIF: ${company.cif}${company.county ? ` | ${t("fldCountyShort")}: ${company.county}` : ""}` }),
        ]),
        el("div", { className: "saga-company-actions" }, [edit, del]),
      ])
    );
  }
  updateSagaWarnings();
}

const COMPANY_FIELDS = {
  sagaCompName: "name",
  sagaCompCif: "cif",
  sagaCompRegCom: "regCom",
  sagaCompCapital: "capital",
  sagaCompCountry: "country",
  sagaCompCounty: "county",
  sagaCompCity: "city",
  sagaCompAddress: "address",
  sagaCompBank: "bank",
  sagaCompIban: "iban",
  sagaCompPhone: "phone",
  sagaCompEmail: "email",
};

function showCompanyForm(company) {
  $("sagaFormTitle").textContent = t(company ? "titleEditCompany" : "titleAddCompany");
  $("sagaCompanyId").value = company ? company.id : "";
  for (const [id, key] of Object.entries(COMPANY_FIELDS)) {
    $(id).value = company ? company[key] || "" : key === "country" ? "RO" : key === "county" ? "B" : "";
  }
  $("sagaCompanyError").hidden = true;
  $("sagaCompanyForm").hidden = false;
  $("sagaCompCif").focus();
}

function hideCompanyForm() {
  $("sagaCompanyForm").hidden = true;
}

async function saveSagaCompany() {
  const id = $("sagaCompanyId").value;
  const data = {};
  for (const [field, key] of Object.entries(COMPANY_FIELDS)) data[key] = $(field).value.trim();
  const result = id ? await send("sagaUpdateCompany", { id, data }) : await send("sagaAddCompany", { data });
  if (!result || !result.success) {
    const box = $("sagaCompanyError");
    box.textContent = (result && result.error) || t("saveFailed", [""]);
    box.hidden = false;
    return;
  }
  hideCompanyForm();
  await loadSagaCompanies();
}

async function anafFill() {
  const button = $("btnAnafFill");
  const cif = $("sagaCompCif").value.trim();
  if (!cif) return;
  button.disabled = true;
  const result = await send("sagaAnafLookup", { cif });
  button.disabled = false;
  const box = $("sagaCompanyError");
  if (!result.success) {
    box.textContent = result.error || t("errAnafNotFound");
    box.hidden = false;
    return;
  }
  box.hidden = true;
  const info = result.info;
  $("sagaCompCif").value = info.vatPayer ? `RO${info.cui}` : info.cui;
  if (info.name) $("sagaCompName").value = info.name;
  if (info.regCom) $("sagaCompRegCom").value = info.regCom;
  if (info.address) $("sagaCompAddress").value = info.address;
  if (info.city) $("sagaCompCity").value = info.city;
  if (info.county && [...$("sagaCompCounty").options].some((o) => o.value === info.county)) $("sagaCompCounty").value = info.county;
  if (info.phone && !$("sagaCompPhone").value) $("sagaCompPhone").value = info.phone;
  if (info.iban && !$("sagaCompIban").value) $("sagaCompIban").value = info.iban;
  $("sagaCompCountry").value = "RO";
}

async function deleteSagaCompany(id) {
  if (!confirm(t("confirmDeleteCompany"))) return;
  const result = await send("sagaDeleteCompany", { id });
  if (!result.success && result.error) alert(result.error);
  await loadSagaCompanies();
}

// ============================================================
//  SAGA — queue
// ============================================================

function isExportable(item) {
  return (item.status === "extracted" || item.status === "reviewed") && !item.needsReview && item.direction !== "unknown" && Boolean(item.companyId) && Boolean(item.data);
}

function statusLabel(item) {
  if (item.status === "extracted") return isExportable(item) ? t("statusReady") : t("statusNeedsReview");
  return t(`status_${item.status}`);
}

function directionLabel(direction) {
  return t(direction === "intrari" ? "dirIntrari" : direction === "iesiri" ? "dirIesiri" : "dirUnknown");
}

function formatAmount(value, currency) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)} ${currency || "RON"}` : "";
}

async function loadSagaQueue() {
  queue = (await send("sagaGetQueue")) || [];
  const listEl = $("sagaQueueList");
  clear(listEl);
  const open = queue.filter((q) => q.status === "extracted" || q.status === "reviewed");
  $("sagaQueueCount").textContent = String(open.length);
  if (queue.length === 0) {
    listEl.appendChild(el("div", { className: "loading", text: t("queueEmpty") }));
    return;
  }
  for (const item of queue) listEl.appendChild(renderQueueItem(item));
}

function renderQueueItem(item) {
  const d = item.data || {};
  const partner = item.direction === "iesiri" ? d.clientNume : d.furnizorNume;
  const title = item.data ? `${d.facturaNumar || t("unknown")} — ${partner || ""}` : item.subject || t("unknown");
  const meta = item.data
    ? [d.facturaData, directionLabel(item.direction), formatAmount(d.totalCuTVA, d.moneda), statusLabel(item)].filter(Boolean).join(" | ")
    : [senderName(item.from), statusLabel(item)].filter(Boolean).join(" | ");

  const info = el("div", { className: "saga-queue-info" }, [
    el("div", { className: "saga-queue-numar" }, [title, item.source ? el("span", { className: "badge badge-source", text: item.source === "efactura" ? "e-Factura" : "PDF" }) : null]),
    el("div", { className: "saga-queue-meta", text: meta }),
  ]);
  if (item.validation && (item.validation.errors.length || item.validation.warnings.length) && item.status !== "exported") {
    info.appendChild(
      el("div", { className: "saga-queue-validation" }, [
        item.validation.errors.length ? el("span", { className: "val-error", text: t("valErrorsCount", [item.validation.errors.length]) }) : null,
        item.validation.warnings.length ? el("span", { className: "val-warn", text: t("valWarningsCount", [item.validation.warnings.length]) }) : null,
      ])
    );
  }
  if (item.error) info.appendChild(el("div", { className: "saga-queue-error", text: tMsg(item.error) }));
  if (item.filename) info.appendChild(el("div", { className: "saga-queue-meta", text: item.filename }));

  const actions = el("div", { className: "saga-queue-actions" });
  if ((item.status === "extracted" || item.status === "reviewed") && item.data) {
    actions.appendChild(el("button", { className: "btn btn-sm", text: t("btnReview"), onclick: () => openReview(item) }));
    if (isExportable(item)) actions.appendChild(el("button", { className: "btn btn-sm btn-primary", text: t("btnExportXml"), onclick: () => exportSagaItems([item.id]) }));
  }
  if ((item.status === "failed" || item.status === "nonInvoice") && item.headerMessageId) {
    actions.appendChild(el("button", { className: "btn btn-sm", text: t("btnRetry"), onclick: () => retrySagaItem(item.id) }));
  }
  actions.appendChild(el("button", { className: "btn btn-sm btn-danger", text: t("btnDelete"), onclick: () => removeSagaQueueItem(item.id) }));

  return el("div", { className: `saga-queue-item saga-status-${item.status}${item.needsReview ? " needs-review" : ""}` }, [info, actions]);
}

function reportExport(result) {
  const status = $("sagaQueueStatus");
  if (!result.success) {
    flash(status, result.error || t("exportFailed"), true, 0);
    return;
  }
  const ok = result.results.filter((r) => r.success).length;
  const failed = result.results.filter((r) => !r.success);
  if (result.results.length === 0) flash(status, t("exportNothing"));
  else flash(status, failed.length ? t("exportPartial", [ok, failed.length, failed[0].error]) : t("exportDone", [ok]), failed.length > 0, 10000);
}

async function exportSagaItems(itemIds) {
  reportExport(await send("sagaExportItems", { itemIds }));
  await loadSagaQueue();
}

async function retrySagaItem(id) {
  flash($("sagaQueueStatus"), t("retrying"), false, 0);
  const result = await send("sagaRetryQueueItem", { id });
  flash($("sagaQueueStatus"), result.success ? t("retryDone", [result.added]) : result.error, !result.success);
  await loadSagaQueue();
}

async function removeSagaQueueItem(id) {
  if (!confirm(t("confirmRemoveQueueItem"))) return;
  await send("sagaRemoveQueueItem", { id });
  await loadSagaQueue();
}

function bindSagaEvents() {
  $("btnAddCompany").addEventListener("click", () => showCompanyForm(null));
  $("btnSaveCompany").addEventListener("click", saveSagaCompany);
  $("btnCancelCompany").addEventListener("click", hideCompanyForm);
  $("btnAnafFill").addEventListener("click", anafFill);
  $("btnSagaExportAll").addEventListener("click", async () => {
    reportExport(await send("sagaExportAll"));
    await loadSagaQueue();
  });
  $("btnSagaClearQueue").addEventListener("click", async () => {
    if (!confirm(t("confirmClearQueue"))) return;
    await send("sagaClearQueue");
    await loadSagaQueue();
  });
}

// ============================================================
//  SAGA — review dialog
// ============================================================

const PARTY_FIELDS = ["Nume", "Cif", "RegCom", "Adresa", "Localitate", "Judet", "Tara", "IBAN", "Banca", "Telefon", "Mail"];
const NUMBER_FIELDS = ["totalFaraTVA", "totalTVA", "totalCuTVA"];

function field(label, input) {
  return el("label", { className: "review-field" }, [el("span", { text: label }), input]);
}

function textInput(key, value, type = "text") {
  const input = el("input", { type, dataset: { key } });
  input.value = value == null ? "" : String(value);
  if (NUMBER_FIELDS.includes(key)) input.inputMode = "decimal";
  return input;
}

function openReview(item) {
  currentReview = structuredClone(item);
  const d = currentReview.data;
  $("reviewSource").textContent = [item.source === "efactura" ? "e-Factura" : "PDF", item.subject, senderName(item.from)].filter(Boolean).join(" • ");
  $("reviewStatus").textContent = "";

  const header = $("reviewHeaderFields");
  clear(header);
  const direction = el("select", { id: "reviewDirection" }, ["intrari", "iesiri", "unknown"].map((v) => el("option", { value: v, text: directionLabel(v), selected: item.direction === v })));
  const company = el("select", { id: "reviewCompany" }, [
    el("option", { value: "", text: t("optAutoCompany") }),
    ...companies.map((c) => el("option", { value: c.id, text: `${c.name} (${c.cif})`, selected: item.companyId === c.id })),
  ]);
  header.append(
    field(t("fldDirection"), direction),
    field(t("fldCompany"), company),
    field(t("fldInvoiceNumber"), textInput("facturaNumar", d.facturaNumar)),
    field(t("fldInvoiceDate"), textInput("facturaData", d.facturaData, "date")),
    field(t("fldDueDate"), textInput("facturaScadenta", d.facturaScadenta, "date")),
    field(t("fldCurrency"), textInput("moneda", d.moneda)),
    field(t("fldTotalNet"), textInput("totalFaraTVA", d.totalFaraTVA)),
    field(t("fldTotalVat"), textInput("totalTVA", d.totalTVA)),
    field(t("fldTotalGross"), textInput("totalCuTVA", d.totalCuTVA)),
    field(t("fldReverseCharge"), el("input", { type: "checkbox", dataset: { key: "taxareInversa" }, checked: Boolean(d.taxareInversa) })),
    field(t("fldVatOnCollection"), el("input", { type: "checkbox", dataset: { key: "tvaIncasare" }, checked: Boolean(d.tvaIncasare) }))
  );

  for (const [prefix, containerId] of [["furnizor", "reviewSupplierFields"], ["client", "reviewClientFields"]]) {
    const box = $(containerId);
    clear(box);
    for (const name of PARTY_FIELDS) box.appendChild(field(t(`fldParty${name}`), textInput(prefix + name, d[prefix + name])));
  }

  const tbody = $("reviewLines");
  clear(tbody);
  for (const line of d.linii || []) tbody.appendChild(lineRow(line));
  renderValidation(item.validation);
  $("reviewDialog").showModal();
}

function lineRow(line = {}) {
  const cell = (key, numeric) => {
    const input = el("input", { type: "text", dataset: { line: key } });
    input.value = line[key] == null ? "" : String(line[key]);
    if (numeric) input.inputMode = "decimal";
    return el("td", {}, input);
  };
  const remove = el("button", { type: "button", className: "btn btn-sm btn-danger", text: "×", title: t("btnRemoveLine") });
  const row = el("tr", {}, [cell("descriere"), cell("um"), cell("cantitate", true), cell("pret", true), cell("valoare", true), cell("procTVA", true), cell("tva", true), el("td", {}, remove)]);
  remove.addEventListener("click", () => row.remove());
  return row;
}

function parseLocalNumber(value) {
  const s = String(value || "").trim().replace(/\s/g, "");
  if (!s) return null;
  const n = Number(s.includes(",") && !s.includes(".") ? s.replace(",", ".") : s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function collectReview() {
  const data = { ...currentReview.data };
  for (const input of $("reviewForm").querySelectorAll("[data-key]")) {
    data[input.dataset.key] = input.type === "checkbox" ? input.checked : input.value.trim();
  }
  data.linii = [...$("reviewLines").querySelectorAll("tr")].map((row) => {
    const line = {};
    for (const input of row.querySelectorAll("[data-line]")) line[input.dataset.line] = input.value.trim();
    return line;
  });
  return { data, direction: $("reviewDirection").value, companyId: $("reviewCompany").value || null };
}

function renderValidation(validation) {
  const box = $("reviewValidation");
  clear(box);
  if (!validation) return;
  for (const e of validation.errors || []) box.appendChild(el("div", { className: "val-error", text: tMsg(e) }));
  for (const w of validation.warnings || []) box.appendChild(el("div", { className: "val-warn", text: tMsg(w) }));
  if (!(validation.errors || []).length && !(validation.warnings || []).length) box.appendChild(el("div", { className: "val-ok", text: t("valAllGood") }));
}

async function saveReview(markReviewed) {
  const changes = collectReview();
  const result = await send("sagaUpdateQueueItem", { id: currentReview.id, changes, markReviewed });
  if (!result.success) {
    flash($("reviewStatus"), result.error || t("saveFailed", [""]), true, 0);
    return;
  }
  currentReview = structuredClone(result.item);
  renderValidation(result.validation);
  await loadSagaQueue();
  if (markReviewed && result.reviewed) {
    $("reviewDialog").close();
    flash($("sagaQueueStatus"), t("reviewApproved"));
  } else if (markReviewed) {
    flash($("reviewStatus"), t("reviewHasErrors"), true, 0);
  } else {
    flash($("reviewStatus"), t("saved"));
  }
}

function recalcTotals() {
  let net = 0;
  let vat = 0;
  for (const row of $("reviewLines").querySelectorAll("tr")) {
    net += parseLocalNumber(row.querySelector('[data-line="valoare"]').value) || 0;
    vat += parseLocalNumber(row.querySelector('[data-line="tva"]').value) || 0;
  }
  const set = (key, value) => {
    $("reviewForm").querySelector(`[data-key="${key}"]`).value = (Math.round(value * 100) / 100).toFixed(2);
  };
  set("totalFaraTVA", net);
  set("totalTVA", vat);
  set("totalCuTVA", net + vat);
}

function bindReview() {
  $("btnAddLine").addEventListener("click", () => $("reviewLines").appendChild(lineRow({ um: "buc", cantitate: 1 })));
  $("btnRecalcTotals").addEventListener("click", recalcTotals);
  $("btnReviewCancel").addEventListener("click", () => $("reviewDialog").close());
  $("btnReviewSave").addEventListener("click", () => saveReview(false));
  $("btnReviewApprove").addEventListener("click", () => saveReview(true));
}
