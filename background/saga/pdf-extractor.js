/**
 * IncoBills SAGA Export — invoice data from PDF attachments.
 *
 * Claude / OpenAI: the PDF goes to the API (native PDF input).
 * Ollama: text is extracted locally with the bundled pdf.js, then sent to the model.
 *
 * @license MIT
 */

const PDFExtractor = {
  _pdfjs: null,

  /**
   * @param {ArrayBuffer|Uint8Array} pdfBytes
   * @param {object} provider  LLM.providerFor(settings, "extract")
   * @param {string} [fileName]
   * @returns {Promise<object>} normalized invoice ({ isInvoice: false, reason } for other documents)
   */
  async extract(pdfBytes, provider, fileName = "invoice.pdf") {
    if (!pdfBytes || pdfBytes.byteLength === 0) throw new Error("PDF is empty");
    if (!provider) throw new Error(t("errSagaNeedsAi"));

    let raw;
    if (provider.backend === "ollama") {
      const text = await this.extractText(pdfBytes);
      if (text.replace(/\s+/g, "").length < 50) throw new Error(t("errPdfNoText"));
      raw = await LLM.completeJson({
        provider,
        system: SAGA_EXTRACTION_SYSTEM_PROMPT,
        prompt: `${SAGA_EXTRACTION_PROMPT}\n\n<document>\n${text.slice(0, SAGA_LIMITS.maxTextChars)}\n</document>`,
        schema: SAGA_INVOICE_SCHEMA,
        schemaName: "invoice_data",
        maxTokens: LLM_LIMITS.extractMaxTokens,
        timeoutMs: LLM_LIMITS.extractTimeoutMs,
        numCtx: SAGA_LIMITS.ollamaExtractContext,
      });
    } else {
      raw = await LLM.completeJson({
        provider,
        system: SAGA_EXTRACTION_SYSTEM_PROMPT,
        prompt: SAGA_EXTRACTION_PROMPT,
        schema: SAGA_INVOICE_SCHEMA,
        schemaName: "invoice_data",
        pdf: pdfBytes,
        pdfName: fileName,
        maxTokens: LLM_LIMITS.extractMaxTokens,
        timeoutMs: LLM_LIMITS.extractTimeoutMs,
      });
    }
    return this.normalize(raw);
  },

  /** Clean the model output: types, dates, CIF format (kept as printed). */
  normalize(raw) {
    const data = raw && typeof raw === "object" ? raw : {};
    if (data.tipDocument === "non-factura") {
      return { isInvoice: false, reason: String(data.motiv || "not an invoice") };
    }
    const str = (v) => (v == null ? "" : String(v).trim());
    const num = (v) => Text.parseAmount(v);
    const date = (v) => {
      const s = str(v);
      if (Text.isIsoDate(s)) return s;
      const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
      if (m) {
        const iso = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
        if (Text.isIsoDate(iso)) return iso;
      }
      return s;
    };
    const out = { isInvoice: true, source: "pdf", spvIndex: "" };
    for (const prefix of ["furnizor", "client"]) {
      for (const field of ["Nume", "RegCom", "Adresa", "Localitate", "Judet", "Tara", "Banca", "Telefon", "Mail"]) {
        out[prefix + field] = str(data[prefix + field]);
      }
      out[`${prefix}Cif`] = Fiscal.normalizeCif(data[`${prefix}Cif`]);
      out[`${prefix}IBAN`] = str(data[`${prefix}IBAN`]).toUpperCase().replace(/\s+/g, "");
      if (!out[`${prefix}Tara`]) out[`${prefix}Tara`] = Fiscal.isRomanianCif(out[`${prefix}Cif`]) ? "RO" : "";
    }
    out.facturaNumar = str(data.facturaNumar);
    out.facturaData = date(data.facturaData);
    out.facturaScadenta = date(data.facturaScadenta);
    out.moneda = (str(data.moneda) || "RON").toUpperCase();
    out.totalFaraTVA = num(data.totalFaraTVA);
    out.totalTVA = num(data.totalTVA);
    out.totalCuTVA = num(data.totalCuTVA);
    out.taxareInversa = Boolean(data.taxareInversa);
    out.tvaIncasare = Boolean(data.tvaIncasare);
    out.linii = (Array.isArray(data.linii) ? data.linii : []).map((line) => ({
      descriere: str(line && line.descriere),
      um: str(line && line.um) || "buc",
      cantitate: num(line && line.cantitate),
      pret: num(line && line.pret),
      valoare: num(line && line.valoare),
      procTVA: num(line && line.procTVA),
      tva: num(line && line.tva),
    }));
    return out;
  },

  // ---- Local text extraction (pdf.js, bundled unmodified in vendor/pdfjs) ----

  async _loadPdfJs() {
    if (this._pdfjs) return this._pdfjs;
    const lib = await import(browser.runtime.getURL("vendor/pdfjs/pdf.min.mjs"));
    lib.GlobalWorkerOptions.workerSrc = browser.runtime.getURL("vendor/pdfjs/pdf.worker.min.mjs");
    this._pdfjs = lib;
    return lib;
  },

  async extractText(pdfBytes) {
    const lib = await this._loadPdfJs();
    const source = ArrayBuffer.isView(pdfBytes) ? new Uint8Array(pdfBytes.buffer, pdfBytes.byteOffset, pdfBytes.byteLength) : new Uint8Array(pdfBytes);
    const data = source.slice(); // pdf.js may transfer (detach) the buffer it gets.
    const task = lib.getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, stopAtErrors: false, verbosity: 0 });
    const doc = await task.promise;
    try {
      const pages = Math.min(doc.numPages, SAGA_LIMITS.maxPdfPagesForText);
      const parts = [];
      for (let i = 1; i <= pages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        let text = "";
        for (const item of content.items) {
          if (typeof item.str !== "string") continue;
          text += item.str + (item.hasEOL ? "\n" : " ");
        }
        parts.push(text.replace(/[ \t]+/g, " ").trim());
        page.cleanup();
        if (parts.join("\n").length > SAGA_LIMITS.maxTextChars) break;
      }
      return parts.join("\n\n");
    } finally {
      await Promise.resolve(task.destroy()).catch(() => {});
    }
  },
};
