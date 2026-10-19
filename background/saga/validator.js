/**
 * IncoBills SAGA Export — invoice checks before export.
 *
 * errors   → the item needs review and cannot be exported as is.
 * warnings → shown to the user; export is allowed.
 * Messages are { key, args } so the UI can translate them.
 *
 * @license MIT
 */

const InvoiceValidator = {
  FIELD_LABELS: {
    facturaNumar: "fldInvoiceNumber",
    facturaData: "fldInvoiceDate",
    facturaScadenta: "fldDueDate",
    furnizorNume: "fldSupplierName",
    furnizorCif: "fldSupplierCif",
    clientCif: "fldClientCif",
  },

  near(a, b, tolerance) {
    return Math.abs(a - b) <= tolerance;
  },

  sumTolerance(lines) {
    return 0.02 + 0.01 * lines.length;
  },

  /**
   * @param {object} d  normalized invoice
   * @param {object} ctx { direction, intraGroup }
   */
  validate(d, { direction, intraGroup = false, companyCif = "" } = {}) {
    const errors = [];
    const warnings = [];
    const err = (key, ...args) => errors.push({ key, args: args.map(String) });
    const warn = (key, ...args) => warnings.push({ key, args: args.map(String) });
    const label = (field) => t(this.FIELD_LABELS[field] || field);

    if (!direction || direction === SAGA_INVOICE_DIRECTION.UNKNOWN) err("valDirectionUnknown");
    if (intraGroup) warn("valIntraGroup");
    // The chosen company must be the supplier (iesiri) or the client (intrari) on the invoice.
    if (companyCif && direction === SAGA_INVOICE_DIRECTION.IESIRI && !Fiscal.sameCompany(companyCif, d.furnizorCif)) {
      err("valDirectionMismatch", companyCif, label("furnizorCif"));
    }
    if (companyCif && direction === SAGA_INVOICE_DIRECTION.INTRARI && !Fiscal.sameCompany(companyCif, d.clientCif)) {
      err("valDirectionMismatch", companyCif, label("clientCif"));
    }

    if (!d.facturaNumar) err("valFieldRequired", label("facturaNumar"));
    if (!Text.isIsoDate(d.facturaData)) err("valDateInvalid", label("facturaData"), d.facturaData || "-");
    if (d.facturaScadenta && !Text.isIsoDate(d.facturaScadenta)) warn("valDateInvalid", label("facturaScadenta"), d.facturaScadenta);
    if (!d.furnizorNume) err("valFieldRequired", label("furnizorNume"));
    if (!d.furnizorCif) err("valFieldRequired", label("furnizorCif"));
    if (!d.clientCif && direction === SAGA_INVOICE_DIRECTION.IESIRI) warn("valClientCifMissing");

    for (const [field, value] of [["furnizorCif", d.furnizorCif], ["clientCif", d.clientCif]]) {
      if (value && Fiscal.isRomanianCif(value) && !Fiscal.isValidRomanianCif(value)) err("valCifChecksum", value);
      else if (value && !Fiscal.isRomanianCif(value) && !/^[A-Z]{2}[A-Z0-9]{2,13}$/.test(Fiscal.normalizeCif(value))) warn("valCifFormat", label(field), value);
    }
    for (const value of [d.furnizorIBAN, d.clientIBAN]) {
      if (value && !Fiscal.isValidIban(value)) warn("valIbanInvalid", value);
    }

    const lines = Array.isArray(d.linii) ? d.linii : [];
    if (lines.length === 0) err("valNoLines");
    let sumValue = 0;
    let sumVat = 0;
    let missingNumbers = false;
    lines.forEach((line, i) => {
      const n = i + 1;
      if (!Number.isFinite(line.valoare)) {
        err("valLineValueMissing", n);
        missingNumbers = true;
        return;
      }
      sumValue += line.valoare;
      if (Number.isFinite(line.tva)) sumVat += line.tva;
      if (Number.isFinite(line.cantitate) && Number.isFinite(line.pret)) {
        const expected = line.cantitate * line.pret;
        if (!this.near(expected, line.valoare, Math.max(0.05, Math.abs(line.valoare) * 0.005))) {
          warn("valLineMath", n, Fiscal.round2(expected), line.valoare);
        }
      }
      if (Number.isFinite(line.procTVA) && !Fiscal.RO_KNOWN_VAT_RATES.includes(line.procTVA)) warn("valVatRateUnusual", n, line.procTVA);
      if (Number.isFinite(line.procTVA) && Number.isFinite(line.tva)) {
        const expectedVat = (line.valoare * line.procTVA) / 100;
        if (!this.near(expectedVat, line.tva, Math.max(0.05, Math.abs(expectedVat) * 0.01))) warn("valLineVat", n, Fiscal.round2(expectedVat), line.tva);
      }
    });

    const tol = this.sumTolerance(lines);
    if (!missingNumbers && Number.isFinite(d.totalFaraTVA) && !this.near(sumValue, d.totalFaraTVA, tol)) {
      err("valSumMismatch", Fiscal.round2(sumValue), d.totalFaraTVA);
    }
    if (Number.isFinite(d.totalTVA) && lines.every((l) => Number.isFinite(l.tva)) && !this.near(sumVat, d.totalTVA, tol)) {
      err("valVatSumMismatch", Fiscal.round2(sumVat), d.totalTVA);
    }
    if (Number.isFinite(d.totalFaraTVA) && Number.isFinite(d.totalTVA) && Number.isFinite(d.totalCuTVA)) {
      if (!this.near(d.totalFaraTVA + d.totalTVA, d.totalCuTVA, 0.02)) {
        err("valTotalMismatch", Fiscal.round2(d.totalFaraTVA + d.totalTVA), d.totalCuTVA);
      }
    }
    if (!Number.isFinite(d.totalFaraTVA) && !Number.isFinite(d.totalCuTVA)) err("valTotalsMissing");
    if (d.taxareInversa && Number.isFinite(d.totalTVA) && Math.abs(d.totalTVA) > 0.01) warn("valReverseChargeWithVat");

    return { errors, warnings };
  },
};
