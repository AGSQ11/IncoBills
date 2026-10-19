/**
 * IncoBills SAGA Export — orchestrator and review queue.
 *
 * Pipeline per detected invoice email:
 *   attachments (read before the move)
 *   → e-Factura XML/ZIP (exact data)  or  PDF → AI extraction
 *   → company match + direction → ANAF data → validation → queue
 *   → user review → XML export (generated at export time from reviewed data)
 *
 * @license MIT
 */

const SAGAExport = {
  _jobs: Promise.resolve(),
  _pending: 0,
  _queuedBytes: 0,
  _exportChain: Promise.resolve(),

  // ---------------------------------------------------------------
  //  Settings
  // ---------------------------------------------------------------

  async getSettings() {
    const stored = await Storage.getData(SAGA_STORAGE_KEYS.SETTINGS, {});
    return { ...SAGA_DEFAULT_SETTINGS, ...(stored && typeof stored === "object" ? stored : {}) };
  },

  sanitizeSubdirectory(value) {
    const clean = String(value || "")
      .replace(/\\/g, "/")
      .split("/")
      .filter((segment) => segment && segment !== "." && segment !== "..")
      .map((segment) => segment.replace(/[<>:"|?*\u0000-\u001F]/g, "_").trim())
      .filter(Boolean)
      .join("/");
    return clean || SAGA_DEFAULT_SETTINGS.exportSubdirectory;
  },

  async saveSettings(partial) {
    const clean = {};
    for (const [key, value] of Object.entries(partial || {})) {
      if (!Object.prototype.hasOwnProperty.call(SAGA_DEFAULT_SETTINGS, key)) continue;
      if (typeof value !== typeof SAGA_DEFAULT_SETTINGS[key]) continue;
      clean[key] = value;
    }
    if ("exportSubdirectory" in clean) clean.exportSubdirectory = this.sanitizeSubdirectory(clean.exportSubdirectory);
    return Storage.update(SAGA_STORAGE_KEYS.SETTINGS, (current) => ({ ...SAGA_DEFAULT_SETTINGS, ...current, ...clean }), {});
  },

  async isActive() {
    return (await CompanyRegistry.getAll()).length > 0;
  },

  // ---------------------------------------------------------------
  //  Attachments
  // ---------------------------------------------------------------

  isPdf(attachment) {
    return String(attachment.contentType || "").toLowerCase() === "application/pdf" || /\.pdf$/i.test(String(attachment.name || ""));
  },

  /**
   * Read invoice attachments (PDF, e-Factura XML/ZIP) of a message.
   * Call this before the message moves.
   */
  async collectAttachments(message, attachmentList, { force = false } = {}) {
    if (!(await this.isActive())) return [];
    const settings = await this.getSettings();
    if (!settings.autoExtractPDFs && !force) return [];

    const list = attachmentList || (await EmailMonitor.listAttachments(message.id));
    const picked = [];
    for (const att of list) {
      if (picked.length >= SAGA_LIMITS.maxAttachmentsPerEmail) break;
      const kind = EFactura.kind(att) || (this.isPdf(att) ? "pdf" : null);
      if (!kind) continue;
      const limit = kind === "pdf" ? SAGA_LIMITS.maxPdfBytes : SAGA_LIMITS.maxXmlBytes;
      if (Number.isFinite(att.size) && att.size > limit) {
        picked.push({ name: att.name, contentType: att.contentType, kind, bytes: null, error: t("errAttachmentTooLarge", [att.name]) });
        continue;
      }
      try {
        const file = await browser.messages.getAttachmentFile(message.id, att.partName);
        picked.push({ name: att.name, contentType: att.contentType, kind, bytes: new Uint8Array(await file.arrayBuffer()) });
      } catch (err) {
        console.warn("[SAGA] cannot read attachment", att.name, err);
      }
    }
    return picked;
  },

  /**
   * Process attachments in the background, one email at a time (rate limits).
   * A "pending" queue item is saved first, so an interrupted job (Thunderbird
   * closed, add-on reloaded) resumes at the next start. Attachment bytes stay in
   * memory only up to SAGA_LIMITS.maxQueuedBytes; above that the job reads the
   * email again when it runs.
   */
  async enqueue(meta, attachments) {
    const marker = await this.addPending(meta).catch(() => null);
    const size = (attachments || []).reduce((sum, a) => sum + (a.bytes ? a.bytes.byteLength : 0), 0);
    let payload = attachments;
    if (!payload || this._queuedBytes + size > SAGA_LIMITS.maxQueuedBytes) payload = null;
    else this._queuedBytes += size;

    this._pending++;
    this._jobs = this._jobs
      .catch(() => {})
      .then(async () => {
        const list = payload || (await this.reloadAttachments(meta.headerMessageId));
        return this.processAttachments(meta, list);
      })
      .catch((err) => {
        console.error("[SAGA] processing failed:", err);
        return this.addFailure(meta, Text.shortError(err));
      })
      .finally(async () => {
        this._pending--;
        if (payload) this._queuedBytes -= size;
        if (marker) await this.removeFromQueue(marker.id).catch(() => {});
      });
    return this._jobs;
  },

  /** Find the email again (by Message-ID) and read its invoice attachments. */
  async reloadAttachments(headerMessageId) {
    if (!headerMessageId) throw new Error(t("errRetryNoMessage"));
    const list = await browser.messages.query({ headerMessageId });
    const message = list && list.messages && list.messages[0];
    if (!message) throw new Error(t("errRetryNoMessage"));
    return this.collectAttachments(message, undefined, { force: true });
  },

  async addPending(meta) {
    if (!meta.headerMessageId) return null;
    const item = {
      id: crypto.randomUUID(),
      status: SAGA_QUEUE_STATUS.PENDING,
      direction: SAGA_INVOICE_DIRECTION.UNKNOWN,
      data: null,
      messageId: meta.messageId ?? null,
      headerMessageId: meta.headerMessageId,
      subject: meta.subject || "",
      from: meta.from || "",
      date: meta.date || null,
      extractedAt: new Date().toISOString(),
    };
    await Storage.update(SAGA_STORAGE_KEYS.QUEUE, (queue) => [item, ...queue], []);
    return item;
  },

  /** At startup: jobs that were pending when Thunderbird closed run again. */
  async resumePending() {
    const queue = await this.getQueue();
    const pending = queue.filter((q) => q.status === SAGA_QUEUE_STATUS.PENDING);
    const jobs = [];
    for (const item of pending) {
      await this.removeFromQueue(item.id);
      jobs.push(this.enqueue({ messageId: item.messageId, headerMessageId: item.headerMessageId, subject: item.subject, from: item.from, date: item.date }, null));
    }
    await Promise.all(jobs);
    return pending.length;
  },

  /** Kept for callers of the 1.1 API. */
  async processEmail(message) {
    const attachments = await this.collectAttachments(message);
    if (attachments.length === 0) return [];
    return this.processAttachments(EmailMonitor.messageMeta(message), attachments);
  },

  async processAttachments(meta, attachments) {
    const added = [];

    // 1. e-Factura XML / SPV ZIP: exact data, no AI needed.
    let structured = false;
    for (const att of attachments.filter((a) => (a.kind === "xml" || a.kind === "zip") && a.bytes)) {
      try {
        for (const { invoice } of await EFactura.parseAttachment(att)) {
          structured = true;
          const item = await this.ingest(invoice, meta);
          if (item) added.push(item);
        }
      } catch (err) {
        console.warn("[SAGA] e-Factura parse failed:", att.name, err);
      }
    }
    if (structured) return added; // The PDF is the visual copy of the same invoice.

    // 2. PDFs: AI extraction.
    const pdfs = attachments.filter((a) => a.kind === "pdf");
    if (pdfs.length === 0) return added;

    const mainSettings = await Storage.getSettings();
    const sagaSettings = await this.getSettings();
    const provider = LLM.providerFor(mainSettings, "extract");
    if (!provider) {
      await this.addFailure(meta, { key: "errSagaNeedsAi" });
      return added;
    }
    if (LLM.isRemote(provider) && !sagaSettings.cloudConsent) {
      await this.addFailure(meta, { key: "errSagaNoConsent" });
      return added;
    }

    let foundInvoice = false;
    const errors = [];
    const notInvoices = [];
    for (const pdf of pdfs) {
      if (!pdf.bytes) {
        if (pdf.error) errors.push(pdf.error);
        continue;
      }
      try {
        const data = await PDFExtractor.extract(pdf.bytes, provider, pdf.name);
        if (!data.isInvoice) {
          notInvoices.push(`${pdf.name}: ${data.reason}`);
          continue;
        }
        foundInvoice = true;
        const item = await this.ingest(data, meta);
        if (item) added.push(item);
      } catch (err) {
        errors.push(`${pdf.name}: ${Text.shortError(err)}`);
      }
    }
    if (!foundInvoice && errors.length > 0) await this.addFailure(meta, errors.join(" | "));
    else if (!foundInvoice && notInvoices.length > 0) await this.addFailure(meta, notInvoices.join(" | "), SAGA_QUEUE_STATUS.NON_INVOICE);
    return added;
  },

  // ---------------------------------------------------------------
  //  Queue items
  // ---------------------------------------------------------------

  normalizeNumber(value) {
    return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  },

  dedupeKey(data, meta = {}) {
    const party = Fiscal.partyKey(data.furnizorCif);
    const number = this.normalizeNumber(data.facturaNumar);
    if (party && number) return `${party}|${number}|${data.facturaData || ""}`;
    return `msg:${meta.headerMessageId || meta.messageId || crypto.randomUUID()}|${number}|${data.facturaData || ""}`;
  },

  /** Fill empty partner fields and VAT status from ANAF. Returns a summary or null. */
  async enrichFromAnaf(data, direction) {
    const prefix = direction === SAGA_INVOICE_DIRECTION.IESIRI ? "client" : "furnizor";
    const cif = data[`${prefix}Cif`];
    if (!Fiscal.isRomanianCif(cif)) return null;
    let info;
    try {
      info = await ANAF.lookup(cif, data.facturaData);
    } catch (err) {
      console.warn("[SAGA] ANAF lookup failed:", err);
      return { found: false, error: Text.shortError(err) };
    }
    if (!info) return { found: false };
    const fill = (field, value) => {
      if (value && !data[prefix + field]) data[prefix + field] = value;
    };
    fill("Nume", info.name);
    fill("RegCom", info.regCom);
    fill("Adresa", info.address);
    fill("Localitate", info.city);
    fill("Judet", info.county);
    fill("Telefon", info.phone);
    if (!data[`${prefix}Tara`]) data[`${prefix}Tara`] = "RO";
    data[`${prefix}Cif`] = Fiscal.formatRomanianCif(cif, info.vatPayer);
    if (prefix === "furnizor" && info.vatOnCollection && !data.tvaIncasare) data.tvaIncasare = true;
    return { found: true, party: prefix, vatPayer: info.vatPayer, vatOnCollection: info.vatOnCollection, inactive: info.inactive };
  },

  /** Add an extracted invoice to the queue (skips duplicates). */
  async ingest(invoice, meta = {}, { manual = false } = {}) {
    const sagaSettings = await this.getSettings();
    const data = structuredClone(invoice);
    const { direction, company, intraGroup } = await CompanyRegistry.resolve(data.furnizorCif, data.clientCif);

    if (sagaSettings.skipDomesticSuppliers && !manual && direction === SAGA_INVOICE_DIRECTION.INTRARI && Fiscal.isRomanianCif(data.furnizorCif)) {
      console.log(`[SAGA] skipped domestic supplier invoice ${data.facturaNumar} (setting)`);
      return null;
    }

    const anaf = sagaSettings.anafLookup ? await this.enrichFromAnaf(data, direction) : null;
    const validation = InvoiceValidator.validate(data, { direction, intraGroup, companyCif: company ? company.cif : "" });
    if (anaf && anaf.inactive) validation.warnings.push({ key: "valPartnerInactive", args: [data[`${anaf.party}Cif`]] });
    const dedupeKey = this.dedupeKey(data, meta);

    let created = null;
    await Storage.update(
      SAGA_STORAGE_KEYS.QUEUE,
      (queue) => {
        const duplicate = queue.find(
          (q) => q.dedupeKey === dedupeKey && q.status !== SAGA_QUEUE_STATUS.FAILED && q.status !== SAGA_QUEUE_STATUS.NON_INVOICE
        );
        if (duplicate) {
          console.log(`[SAGA] duplicate invoice skipped: ${dedupeKey}`);
          return queue;
        }
        // A successful extraction replaces an older failure for the same email.
        const rest = queue.filter(
          (q) =>
            !((q.status === SAGA_QUEUE_STATUS.FAILED || q.status === SAGA_QUEUE_STATUS.NON_INVOICE) &&
              meta.headerMessageId &&
              q.headerMessageId === meta.headerMessageId)
        );
        created = {
          id: crypto.randomUUID(),
          dedupeKey,
          status: SAGA_QUEUE_STATUS.EXTRACTED,
          direction,
          companyId: company ? company.id : null,
          data,
          validation,
          needsReview: validation.errors.length > 0,
          anaf,
          source: data.source || "pdf",
          messageId: meta.messageId ?? null,
          headerMessageId: meta.headerMessageId || null,
          subject: meta.subject || "",
          from: meta.from || "",
          extractedAt: new Date().toISOString(),
          exportedAt: null,
          filename: null,
          error: null,
        };
        return [created, ...rest];
      },
      []
    );
    return created;
  },

  /** One failed/non-invoice entry per email (replaces an older one for the same email). */
  async addFailure(meta, error, status = SAGA_QUEUE_STATUS.FAILED) {
    const item = {
      id: crypto.randomUUID(),
      dedupeKey: null,
      status,
      direction: SAGA_INVOICE_DIRECTION.UNKNOWN,
      companyId: null,
      data: null,
      validation: null,
      needsReview: false,
      source: null,
      messageId: meta.messageId ?? null,
      headerMessageId: meta.headerMessageId || null,
      subject: meta.subject || "",
      from: meta.from || "",
      extractedAt: new Date().toISOString(),
      exportedAt: null,
      filename: null,
      error,
    };
    await Storage.update(
      SAGA_STORAGE_KEYS.QUEUE,
      (queue) => [
        item,
        ...queue.filter(
          (q) => !((q.status === SAGA_QUEUE_STATUS.FAILED || q.status === SAGA_QUEUE_STATUS.NON_INVOICE) && meta.headerMessageId && q.headerMessageId === meta.headerMessageId)
        ),
      ],
      []
    );
    return item;
  },

  async getQueue() {
    const queue = await Storage.getData(SAGA_STORAGE_KEYS.QUEUE, []);
    return Array.isArray(queue) ? queue : [];
  },

  /**
   * e-Factura data is exact: exportable when all checks pass.
   * Data read by an AI from a PDF must be reviewed by a person first.
   */
  isExportable(item) {
    const reviewedOrExact = item.status === SAGA_QUEUE_STATUS.REVIEWED || (item.status === SAGA_QUEUE_STATUS.EXTRACTED && item.source === "efactura");
    return (
      reviewedOrExact &&
      !item.needsReview &&
      item.direction !== SAGA_INVOICE_DIRECTION.UNKNOWN &&
      Boolean(item.companyId) &&
      Boolean(item.data)
    );
  },

  async getSummary() {
    const queue = await this.getQueue();
    const open = queue.filter((q) => q.status === SAGA_QUEUE_STATUS.EXTRACTED || q.status === SAGA_QUEUE_STATUS.REVIEWED);
    return {
      open: open.length,
      exportable: open.filter((q) => this.isExportable(q)).length,
      needsReview: open.filter((q) => !this.isExportable(q)).length,
      failed: queue.filter((q) => q.status === SAGA_QUEUE_STATUS.FAILED).length,
      processing: queue.filter((q) => q.status === SAGA_QUEUE_STATUS.PENDING).length,
    };
  },

  /** Clean values from the review form (numbers may arrive as strings). */
  sanitizeEdited(data) {
    const out = PDFExtractor.normalize({ ...data, tipDocument: "factura" });
    out.source = data.source || "pdf";
    out.spvIndex = String(data.spvIndex || "");
    out.linii = out.linii.filter((l) => l.descriere || Number.isFinite(l.valoare));
    return out;
  },

  /**
   * Save edits from the review form.
   * @returns {{ success: boolean, item?: object, validation?: object, reviewed?: boolean }}
   */
  async updateItem(id, { data, direction, companyId } = {}, { markReviewed = false } = {}) {
    const queue = await this.getQueue();
    const current = queue.find((q) => q.id === id);
    if (!current) throw new Error(t("errQueueItemNotFound"));
    if (current.status === SAGA_QUEUE_STATUS.EXPORTED) throw new Error(t("errQueueItemExported"));
    if (!current.data && !data) throw new Error(t("errQueueItemNoData"));

    const newData = data ? this.sanitizeEdited(data) : current.data;
    const resolved = await CompanyRegistry.resolve(newData.furnizorCif, newData.clientCif);
    const company = (companyId ? await CompanyRegistry.getById(companyId) : null) || resolved.company;
    const chosen = direction === SAGA_INVOICE_DIRECTION.INTRARI || direction === SAGA_INVOICE_DIRECTION.IESIRI ? direction : null;
    // No direction chosen: derive it from the company and the CIFs on the invoice.
    let newDirection = chosen;
    if (!newDirection && company) {
      if (Fiscal.sameCompany(company.cif, newData.furnizorCif)) newDirection = SAGA_INVOICE_DIRECTION.IESIRI;
      else if (Fiscal.sameCompany(company.cif, newData.clientCif)) newDirection = SAGA_INVOICE_DIRECTION.INTRARI;
    }
    if (!newDirection) newDirection = resolved.direction;
    const validation = InvoiceValidator.validate(newData, {
      direction: newDirection,
      intraGroup: resolved.intraGroup,
      companyCif: company ? company.cif : "",
    });
    if (!company) validation.errors.push({ key: "valCompanyMissing", args: [] });
    const reviewed = markReviewed && validation.errors.length === 0;

    let updated = null;
    await Storage.update(
      SAGA_STORAGE_KEYS.QUEUE,
      (list) =>
        list.map((q) => {
          if (q.id !== id) return q;
          updated = {
            ...q,
            data: newData,
            direction: newDirection,
            companyId: company ? company.id : null,
            validation,
            needsReview: validation.errors.length > 0,
            status: reviewed ? SAGA_QUEUE_STATUS.REVIEWED : q.status === SAGA_QUEUE_STATUS.REVIEWED ? SAGA_QUEUE_STATUS.EXTRACTED : q.status,
            dedupeKey: this.dedupeKey(newData, q),
            reviewedAt: reviewed ? new Date().toISOString() : q.reviewedAt || null,
          };
          return updated;
        }),
      []
    );
    return { success: true, item: updated, validation, reviewed };
  },

  async removeFromQueue(id) {
    let removed = false;
    await Storage.update(
      SAGA_STORAGE_KEYS.QUEUE,
      (queue) => {
        const filtered = queue.filter((q) => q.id !== id);
        removed = filtered.length < queue.length;
        return filtered;
      },
      []
    );
    return removed;
  },

  /** Remove open and failed items. Exported items stay (duplicate detection), up to keepExported. */
  async clearQueue() {
    const settings = await this.getSettings();
    await Storage.update(
      SAGA_STORAGE_KEYS.QUEUE,
      (queue) =>
        queue
          .filter((q) => q.status === SAGA_QUEUE_STATUS.EXPORTED)
          .sort((a, b) => String(b.exportedAt || "").localeCompare(String(a.exportedAt || "")))
          .slice(0, settings.keepExported),
      []
    );
  },

  /** Process the email of a failed item again (e.g. after choosing an AI backend). */
  async retry(id) {
    const item = (await this.getQueue()).find((q) => q.id === id);
    if (!item) throw new Error(t("errQueueItemNotFound"));
    if (!item.headerMessageId) throw new Error(t("errRetryNoMessage"));
    const list = await browser.messages.query({ headerMessageId: item.headerMessageId });
    const message = list && list.messages && list.messages[0];
    if (!message) throw new Error(t("errRetryNoMessage"));
    const attachments = await this.collectAttachments(message, undefined, { force: true });
    if (attachments.length === 0) throw new Error(t("errRetryNoAttachments"));
    await this.removeFromQueue(id);
    return this.processAttachments(EmailMonitor.messageMeta(message), attachments);
  },

  // ---------------------------------------------------------------
  //  Export
  // ---------------------------------------------------------------

  /** Revoke the blob URL when the download ends; call onInterrupted if it fails. */
  _watchDownload(url, downloadId, onInterrupted) {
    let done = false;
    const finish = (state) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      if (browser.downloads.onChanged) browser.downloads.onChanged.removeListener(listener);
      if (state === "interrupted" && onInterrupted) onInterrupted().catch(() => {});
    };
    const listener = (delta) => {
      if (delta.id === downloadId && delta.state && ["complete", "interrupted"].includes(delta.state.current)) finish(delta.state.current);
    };
    if (browser.downloads.onChanged) browser.downloads.onChanged.addListener(listener);
    const timer = setTimeout(() => finish("timeout"), 120000);
    if (timer && timer.unref) timer.unref(); // Node (tests) only
  },

  /** Exports run one at a time, so a double click cannot export an invoice twice. */
  exportItems(itemIds) {
    const run = this._exportChain.catch(() => {}).then(() => this._exportItems(itemIds));
    this._exportChain = run;
    return run;
  },

  async _exportItems(itemIds) {
    const ids = Array.isArray(itemIds) ? itemIds : [];
    const settings = await this.getSettings();
    const results = [];
    for (const id of ids) {
      const item = (await this.getQueue()).find((q) => q.id === id); // fresh read for each item
      if (!item) {
        results.push({ id, success: false, error: t("errQueueItemNotFound") });
        continue;
      }
      if (!this.isExportable(item)) {
        results.push({ id, success: false, error: item.status === SAGA_QUEUE_STATUS.EXPORTED ? t("errQueueItemExported") : t("errNotExportable") });
        continue;
      }
      try {
        const company = await CompanyRegistry.getById(item.companyId);
        if (!company) throw new Error(t("valCompanyMissing"));
        const { xml, filename } = SAGAXMLGenerator.generate(item.data, company, item.direction);
        const url = URL.createObjectURL(new Blob([xml], { type: "application/xml" }));
        const path = `${this.sanitizeSubdirectory(settings.exportSubdirectory)}/${filename}`;
        const downloadId = await browser.downloads.download({ url, filename: path, saveAs: false, conflictAction: "uniquify" });
        const previousStatus = item.status;
        const exportedAt = new Date().toISOString();
        await Storage.update(
          SAGA_STORAGE_KEYS.QUEUE,
          (list) => list.map((q) => (q.id === id ? { ...q, status: SAGA_QUEUE_STATUS.EXPORTED, exportedAt, filename, downloadId, error: null } : q)),
          []
        );
        // A failed download puts the invoice back, so it can be exported again.
        this._watchDownload(url, downloadId, () =>
          Storage.update(
            SAGA_STORAGE_KEYS.QUEUE,
            (list) => list.map((q) => (q.id === id && q.downloadId === downloadId ? { ...q, status: previousStatus, exportedAt: null, filename: null, error: t("errDownloadInterrupted") } : q)),
            []
          )
        );
        results.push({ id, success: true, downloadId, filename: path });
      } catch (err) {
        results.push({ id, success: false, error: Text.shortError(err) });
      }
    }
    return results;
  },

  async exportAll() {
    const queue = await this.getQueue();
    return this.exportItems(queue.filter((q) => this.isExportable(q)).map((q) => q.id));
  },
};
