/**
 * IncoBills SAGA Export — RO e-Factura (UBL 2.1 / CIUS-RO) reader.
 *
 * Reads the invoice XML, or the ZIP that ANAF SPV produces (invoice XML +
 * signature XML). The data is exact, so no AI call is needed.
 *
 * @license MIT
 */

const Zip = {
  /** Minimal ZIP reader (stored + deflate). Returns [{ name, bytes }]. */
  async read(buffer, { maxEntries = SAGA_LIMITS.maxZipEntries, maxBytes = SAGA_LIMITS.maxXmlBytes } = {}) {
    const bytes = ArrayBuffer.isView(buffer) ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("not a ZIP file");

    const count = view.getUint16(eocd + 10, true);
    let p = view.getUint32(eocd + 16, true);
    const decoder = new TextDecoder("utf-8");
    const entries = [];
    for (let n = 0; n < count && entries.length < maxEntries; n++) {
      if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) break;
      const flags = view.getUint16(p + 8, true);
      const method = view.getUint16(p + 10, true);
      const compressedSize = view.getUint32(p + 20, true);
      const size = view.getUint32(p + 24, true);
      const nameLength = view.getUint16(p + 28, true);
      const extraLength = view.getUint16(p + 30, true);
      const commentLength = view.getUint16(p + 32, true);
      const localOffset = view.getUint32(p + 42, true);
      const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength));
      p += 46 + nameLength + extraLength + commentLength;

      if (name.endsWith("/") || flags & 1 || size > maxBytes) continue;
      if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) continue;
      const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
      const data = bytes.subarray(start, start + compressedSize);
      if (method === 0) entries.push({ name, bytes: data });
      else if (method === 8) entries.push({ name, bytes: await this.inflateRaw(data, maxBytes) });
    }
    return entries;
  },

  async inflateRaw(data, maxBytes) {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("ZIP entry is too large");
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  },
};

const EFactura = {
  NS: {
    cbc: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
    cac: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
  },
  ZERO_RATE_CATEGORIES: ["AE", "E", "Z", "O", "K", "G"],

  /** "xml", "zip" or null for an attachment descriptor { name, contentType }. */
  kind(attachment) {
    const name = String(attachment.name || "").toLowerCase();
    const type = String(attachment.contentType || "").toLowerCase();
    if (name.endsWith(".xml") || type === "application/xml" || type === "text/xml") return "xml";
    if (name.endsWith(".zip") || type === "application/zip" || type === "application/x-zip-compressed") return "zip";
    return null;
  },

  /** Parse an XML or ZIP attachment. Returns [{ invoice }] (empty if none). */
  async parseAttachment({ name, bytes }) {
    const kind = this.kind({ name });
    if (kind === "zip") {
      const entries = await Zip.read(bytes);
      const results = [];
      for (const entry of entries) {
        const base = entry.name.split("/").pop();
        if (!/\.xml$/i.test(base) || /^semnatura/i.test(base)) continue;
        const index = (base.match(/^(\d+)\.xml$/i) || [])[1] || "";
        const invoice = this.parseXml(new TextDecoder("utf-8").decode(entry.bytes), { spvIndex: index });
        if (invoice) results.push({ invoice });
      }
      return results;
    }
    if (kind === "xml") {
      const invoice = this.parseXml(new TextDecoder("utf-8").decode(bytes));
      return invoice ? [{ invoice }] : [];
    }
    return [];
  },

  // ---- DOM helpers (direct children only; nested cbc:ID elements exist everywhere) ----

  _children(el, qname) {
    if (!el) return [];
    const [prefix, local] = qname.split(":");
    const ns = this.NS[prefix];
    const out = [];
    for (let node = el.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 1 && node.localName === local && node.namespaceURI === ns) out.push(node);
    }
    return out;
  },

  _child(el, path) {
    let current = el;
    for (const part of path.split("/")) {
      current = this._children(current, part)[0];
      if (!current) return null;
    }
    return current;
  },

  _text(el, path) {
    const node = this._child(el, path);
    return node ? String(node.textContent || "").trim() : "";
  },

  _num(el, path) {
    const value = this._text(el, path);
    if (!value) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  },

  /** Parse a UBL Invoice or CreditNote. Returns null for other XML documents. */
  parseXml(xmlText, { spvIndex = "" } = {}) {
    let doc;
    try {
      doc = new DOMParser().parseFromString(String(xmlText), "application/xml");
    } catch {
      return null;
    }
    const root = doc && doc.documentElement;
    if (!root || !["Invoice", "CreditNote"].includes(root.localName)) return null;
    if (doc.getElementsByTagName("parsererror").length > 0) return null;

    const isCredit = root.localName === "CreditNote";
    const sign = isCredit ? -1 : 1;
    const currency = this._text(root, "cbc:DocumentCurrencyCode") || "RON";

    const supplier = this._party(this._child(root, "cac:AccountingSupplierParty/cac:Party"));
    const customer = this._party(this._child(root, "cac:AccountingCustomerParty/cac:Party"));
    const payeeAccount = this._child(root, "cac:PaymentMeans/cac:PayeeFinancialAccount");
    if (payeeAccount) {
      supplier.IBAN = this._text(payeeAccount, "cbc:ID");
      supplier.Banca = this._text(payeeAccount, "cac:FinancialInstitutionBranch/cbc:Name") || this._text(payeeAccount, "cbc:Name");
    }

    let reverseCharge = false;
    const lines = [];
    const lineTag = isCredit ? "cac:CreditNoteLine" : "cac:InvoiceLine";
    const qtyTag = isCredit ? "cbc:CreditedQuantity" : "cbc:InvoicedQuantity";
    for (const line of this._children(root, lineTag)) {
      const qtyNode = this._child(line, qtyTag);
      const qty = qtyNode ? Number(String(qtyNode.textContent).trim()) : 1;
      const unitCode = qtyNode ? String(qtyNode.getAttribute("unitCode") || "").toUpperCase() : "";
      const value = this._num(line, "cbc:LineExtensionAmount") ?? 0;
      const priceAmount = this._num(line, "cac:Price/cbc:PriceAmount");
      const baseQty = this._num(line, "cac:Price/cbc:BaseQuantity") || 1;
      const category = this._text(line, "cac:Item/cac:ClassifiedTaxCategory/cbc:ID").toUpperCase();
      if (category === "AE") reverseCharge = true;
      const percent = this._num(line, "cac:Item/cac:ClassifiedTaxCategory/cbc:Percent");
      const rate = percent ?? (this.ZERO_RATE_CATEGORIES.includes(category) ? 0 : null);
      const name = this._text(line, "cac:Item/cbc:Name");
      const description = this._text(line, "cac:Item/cbc:Description");
      lines.push({
        descriere: name && description && description !== name ? `${name} - ${description}` : name || description || "",
        um: SAGA_UNIT_CODES[unitCode] || unitCode || "buc",
        cantitate: Number.isFinite(qty) ? sign * qty : sign,
        pret: priceAmount === null ? null : Fiscal.round2(priceAmount / baseQty),
        valoare: sign * value,
        procTVA: rate,
        tva: rate === null ? null : Fiscal.round2(sign * value * (rate / 100)),
      });
    }

    // Document-level allowances (discounts) and charges become extra lines.
    for (const ac of this._children(root, "cac:AllowanceCharge")) {
      const isCharge = this._text(ac, "cbc:ChargeIndicator") === "true";
      const amount = this._num(ac, "cbc:Amount") ?? 0;
      const rate = this._num(ac, "cac:TaxCategory/cbc:Percent") ?? 0;
      const value = sign * (isCharge ? amount : -amount);
      lines.push({
        descriere: this._text(ac, "cbc:AllowanceChargeReason") || (isCharge ? "Taxă suplimentară" : "Discount"),
        um: "buc",
        cantitate: 1,
        pret: value,
        valoare: value,
        procTVA: rate,
        tva: Fiscal.round2(value * (rate / 100)),
      });
    }

    const taxTotals = this._children(root, "cac:TaxTotal");
    const mainTax =
      taxTotals.find((tt) => {
        const node = this._child(tt, "cbc:TaxAmount");
        return node && node.getAttribute("currencyID") === currency;
      }) || taxTotals[0];
    for (const sub of mainTax ? this._children(mainTax, "cac:TaxSubtotal") : []) {
      if (this._text(sub, "cac:TaxCategory/cbc:ID").toUpperCase() === "AE") reverseCharge = true;
    }

    const exclusive = this._num(root, "cac:LegalMonetaryTotal/cbc:TaxExclusiveAmount");
    const inclusive = this._num(root, "cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount");
    const taxAmount = mainTax ? this._num(mainTax, "cbc:TaxAmount") : null;
    const scale = (n) => (n === null ? null : sign * n);

    return {
      isInvoice: true,
      source: "efactura",
      spvIndex: spvIndex || "",
      tipDocument: "factura",
      furnizorNume: supplier.Nume,
      furnizorCif: supplier.Cif,
      furnizorRegCom: supplier.RegCom,
      furnizorAdresa: supplier.Adresa,
      furnizorLocalitate: supplier.Localitate,
      furnizorJudet: supplier.Judet,
      furnizorTara: supplier.Tara,
      furnizorBanca: supplier.Banca || "",
      furnizorIBAN: supplier.IBAN || "",
      furnizorTelefon: supplier.Telefon,
      furnizorMail: supplier.Mail,
      clientNume: customer.Nume,
      clientCif: customer.Cif,
      clientRegCom: customer.RegCom,
      clientAdresa: customer.Adresa,
      clientLocalitate: customer.Localitate,
      clientJudet: customer.Judet,
      clientTara: customer.Tara,
      clientBanca: "",
      clientIBAN: "",
      clientTelefon: customer.Telefon,
      clientMail: customer.Mail,
      facturaNumar: this._text(root, "cbc:ID"),
      facturaData: this._text(root, "cbc:IssueDate"),
      facturaScadenta: this._text(root, "cbc:DueDate") || this._text(root, "cac:PaymentMeans/cbc:PaymentDueDate"),
      moneda: currency,
      totalFaraTVA: scale(exclusive),
      totalTVA: scale(taxAmount ?? (inclusive !== null && exclusive !== null ? Fiscal.round2(inclusive - exclusive) : null)),
      totalCuTVA: scale(inclusive),
      taxareInversa: reverseCharge,
      tvaIncasare: false,
      linii: lines,
    };
  },

  _party(party) {
    const out = { Nume: "", Cif: "", RegCom: "", Adresa: "", Localitate: "", Judet: "", Tara: "", Telefon: "", Mail: "", Banca: "", IBAN: "" };
    if (!party) return out;
    out.Nume = this._text(party, "cac:PartyLegalEntity/cbc:RegistrationName") || this._text(party, "cac:PartyName/cbc:Name");
    const taxIds = this._children(party, "cac:PartyTaxScheme").map((ts) => this._text(ts, "cbc:CompanyID")).filter(Boolean);
    const legalId = this._text(party, "cac:PartyLegalEntity/cbc:CompanyID");
    const vatId = taxIds.find((id) => /^[A-Z]{2}/i.test(id)) || taxIds[0] || "";
    out.Cif = Fiscal.normalizeCif(vatId || (Fiscal.isRomanianCif(legalId) ? legalId : "") || this._text(party, "cac:PartyIdentification/cbc:ID"));
    out.RegCom = /^[JFC]\s*\d/i.test(legalId) ? legalId : "";

    const address = this._child(party, "cac:PostalAddress");
    if (address) {
      out.Adresa = [this._text(address, "cbc:StreetName"), this._text(address, "cbc:AdditionalStreetName")].filter(Boolean).join(", ");
      out.Localitate = this._text(address, "cbc:CityName");
      out.Judet = this._text(address, "cbc:CountrySubentity").replace(/^RO-/i, "");
      out.Tara = this._text(address, "cac:Country/cbc:IdentificationCode") || "RO";
    }
    out.Telefon = this._text(party, "cac:Contact/cbc:Telephone");
    out.Mail = this._text(party, "cac:Contact/cbc:ElectronicMail");
    return out;
  },
};
