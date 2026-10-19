/**
 * IncoBills — toolbar popup.
 *
 * @license MIT
 */

const $ = (id) => document.getElementById(id);
const send = (type, data = {}) => browser.runtime.sendMessage({ type, ...data });
const DETECTED = ["moved", "copied", "flagged", "already", "move_failed"];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clear(node) {
  while (node.lastChild) node.removeChild(node.lastChild);
}

document.addEventListener("DOMContentLoaded", async () => {
  I18n.localizePage();

  const enableToggle = $("enableToggle");
  enableToggle.checked = (await send("getEnabled")) !== false;
  enableToggle.addEventListener("change", () => send("setEnabled", { enabled: enableToggle.checked }));

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      $(`tab-${btn.dataset.tab}`).classList.add("active");
    });
  });

  $("btnSettings").addEventListener("click", () => {
    browser.runtime.openOptionsPage();
    window.close();
  });
  $("btnSagaReview").addEventListener("click", async () => {
    await browser.tabs.create({ url: browser.runtime.getURL("options/options.html#saga") }).catch(() => browser.runtime.openOptionsPage());
    window.close();
  });
  $("btnSagaExport").addEventListener("click", exportReady);

  await Promise.all([loadStats(), loadRecent(), loadBackendWarning(), loadSaga()]);
});

async function loadStats() {
  const stats = await send("getStats");
  $("todayCount").textContent = stats.today;
  $("monthCount").textContent = stats.thisMonth;
  $("totalCount").textContent = stats.total;
}

async function loadRecent() {
  const recent = (await send("getRecentHistory", { count: 20 })).filter((e) => DETECTED.includes(e.action)).slice(0, 5);
  if (recent.length === 0) return;
  const list = $("recentList");
  clear(list);
  for (const entry of recent) list.appendChild(createRecentItem(entry));
}

async function loadBackendWarning() {
  const status = await send("getBackendStatus");
  const box = $("backendWarning");
  if (status && status.ok === false) {
    const name = t(`backendName_${status.backend}`);
    box.textContent = t("bannerBackendFailing", [name === `backendName_${status.backend}` ? status.backend : name, status.error || ""]);
    box.hidden = false;
  }
}

async function loadSaga() {
  try {
    const [summary, queue] = await Promise.all([send("sagaGetSummary"), send("sagaGetQueue")]);
    const badge = $("sagaBadge");
    badge.textContent = summary.open > 0 ? String(summary.open) : "";
    badge.style.display = summary.open > 0 ? "inline" : "none";
    $("sagaReadyCount").textContent = summary.exportable;
    $("sagaReviewCount").textContent = summary.needsReview;
    $("sagaFailedCount").textContent = summary.failed;
    $("btnSagaExport").disabled = summary.exportable === 0;

    const list = $("sagaRecentList");
    clear(list);
    const open = queue.filter((q) => ["pending", "extracted", "reviewed", "failed"].includes(q.status)).slice(0, 5);
    if (open.length === 0) {
      list.appendChild(el("div", "empty-state", t("queueEmpty")));
      return;
    }
    for (const item of open) list.appendChild(createSagaItem(item));
  } catch (err) {
    console.error("[SAGA popup]", err);
  }
}

function createSagaItem(item) {
  const d = item.data || {};
  const row = el("div", `recent-item${item.status === "failed" ? " is-failed" : ""}`);
  const info = el("div", "recent-info");
  const partner = item.direction === "iesiri" ? d.clientNume : d.furnizorNume;
  info.appendChild(el("div", "recent-from", item.data ? `${d.facturaNumar || "?"} — ${partner || ""}` : item.subject || "?"));
  const total = Number(d.totalCuTVA);
  const direction = t(item.direction === "intrari" ? "dirIntrari" : item.direction === "iesiri" ? "dirIesiri" : "dirUnknown");
  const meta = item.data
    ? [d.facturaData, direction, Number.isFinite(total) ? `${total.toFixed(2)} ${d.moneda || "RON"}` : ""].filter(Boolean).join(" | ")
    : item.status === "pending"
      ? t("status_pending")
      : tMsg(item.error);
  info.appendChild(el("div", "recent-subject", meta));
  row.appendChild(info);
  return row;
}

async function exportReady() {
  const status = $("sagaStatus");
  const button = $("btnSagaExport");
  button.disabled = true;
  const result = await send("sagaExportAll").catch((err) => ({ success: false, error: err.message }));
  if (!result.success) {
    status.textContent = result.error || t("exportFailed");
    status.classList.add("is-error");
  } else {
    const ok = result.results.filter((r) => r.success).length;
    const failed = result.results.length - ok;
    status.textContent = failed ? t("exportPartial", [ok, failed, (result.results.find((r) => !r.success) || {}).error || ""]) : t("exportDone", [ok]);
    status.classList.toggle("is-error", failed > 0);
  }
  await loadSaga();
}

function createRecentItem(entry) {
  const row = el("div", "recent-item");
  const info = el("div", "recent-info");
  info.appendChild(el("div", "recent-from", senderName(entry.from || "")));
  info.appendChild(el("div", "recent-subject", entry.subject || t("noSubject")));
  const meta = el("div", "recent-meta");
  meta.appendChild(el("span", "recent-time", formatTimeAgo(entry.timestamp)));
  const confidence = entry.classification && Number.isFinite(entry.classification.confidence) ? `${Math.round(entry.classification.confidence * 100)}%` : "";
  meta.appendChild(el("span", "recent-confidence", confidence));
  row.appendChild(info);
  row.appendChild(meta);
  return row;
}

function senderName(from) {
  const match = from.match(/^"?([^"<]+)"?\s*</);
  return match ? match[1].trim() : from.split("@")[0] || from;
}

function formatTimeAgo(isoDate) {
  const minutes = Math.floor((Date.now() - new Date(isoDate).getTime()) / 60000);
  if (minutes < 1) return t("timeJustNow");
  if (minutes < 60) return t("timeMinutes", [minutes]);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("timeHours", [hours]);
  return t("timeDays", [Math.floor(hours / 24)]);
}
