/**
 * IncoBills SAGA Export — SAGA XML generator.
 *
 * @license MIT
 */

const SAGAXMLGenerator = {
  /**
   * @param {object} d  normalized invoice
   * @param {object} company  the user's company (registry)
   * @param {string} direction  "intrari" | "iesiri"
   * @returns {{ xml: string, filename: string }}
   */
  generate(d, company, direction) {
    if (!d || !d.isInvoice) throw new Error("Invalid or non-invoice data");
    if (!company) throw new Error("No company selected");
    if (direction !== SAGA_INVOICE_DIRECTION.INTRARI && direction !== SAGA_INVOICE_DIRECTION.IESIRI) {
      throw new Error("Invoice direction is unknown");
    }
    const isIesiri = direction === SAGA_INVOICE_DIRECTION.IESIRI;
    const supplier = isIesiri ? company : this.mapPartyToSaga(d, "furnizor");
    const client = isIesiri ? this.mapPartyToSaga(d, "client") : company;

    let xml = SAGA_XML_TEMPLATE.XML_HEADER + "\n";
    xml += SAGA_XML_TEMPLATE.ROOT_OPEN + "\n";
    xml += SAGA_XML_TEMPLATE.INVOICE_OPEN + "\n";
    xml += this.buildAntet(supplier, client, d);
    xml += this.buildDetalii(d);
    xml += SAGA_XML_TEMPLATE.INVOICE_CLOSE + "\n";
    xml += SAGA_XML_TEMPLATE.ROOT_CLOSE + "\n";
    this.validateXML(xml);

    const cif = (company.cif || "UNKNOWN").replace(/[^a-zA-Z0-9]/g, "");
    const number = (d.facturaNumar || "UNKNOWN").replace(/[^a-zA-Z0-9_-]/g, "_");
    const date = (d.facturaData || "00000000").replace(/-/g, "");
    return { xml, filename: `F_${cif}_${number}_${date}.xml` };
  },

  buildAntet(supplier, client, d) {
    let xml = "    <Antet>\n";
    xml += this.buildPartyXml(supplier, "Furnizor");
    xml += this.buildPartyXml(client, "Client");
    xml += this.buildTag("FacturaNumar", d.facturaNumar);
    xml += this.buildTag("FacturaData", d.facturaData);
    xml += this.buildTag("FacturaScadenta", d.facturaScadenta || d.facturaData);
    xml += this.buildTag("FacturaTaxareInversa", d.taxareInversa ? "Da" : "Nu");
    xml += this.buildTag("FacturaTVAIncasare", d.tvaIncasare ? "Da" : "Nu");
    xml += this.buildTag("FacturaInformatiiSuplimentare", "Importat prin IncoBills");
    xml += this.buildTag("FacturaMoneda", d.moneda && d.moneda !== "RON" ? d.moneda : "");
    xml += this.buildTag("FacturaGreutate", "0");
    xml += this.buildTag("FacturaAccize", "");
    xml += this.buildTag("FacturaIndexSPV", d.spvIndex || "");
    xml += this.buildTag("FacturaIndexDescarcareSPV", "");
    xml += this.buildTag("Cod", "");
    xml += "    </Antet>\n";
    return xml;
  },

  buildPartyXml(party, prefix) {
    let xml = "";
    xml += this.buildTag(`${prefix}Nume`, party.name);
    xml += this.buildTag(`${prefix}CIF`, party.cif);
    xml += this.buildTag(`${prefix}NrRegCom`, party.regCom);
    xml += this.buildTag(`${prefix}Capital`, party.capital);
    xml += this.buildTag(`${prefix}Tara`, party.country || "RO");
    xml += this.buildTag(`${prefix}Localitate`, party.city);
    xml += this.buildTag(`${prefix}Judet`, party.county);
    xml += this.buildTag(`${prefix}Adresa`, party.address);
    xml += this.buildTag(`${prefix}Telefon`, party.phone);
    xml += this.buildTag(`${prefix}Mail`, party.email);
    xml += this.buildTag(`${prefix}Banca`, party.bank);
    xml += this.buildTag(`${prefix}IBAN`, party.iban);
    xml += this.buildTag(`${prefix}InformatiiSuplimentare`, "");
    return xml;
  },

  /** VAT rate of a line: as printed → from line VAT/value → standard rate for the invoice date. */
  lineVatRate(line, d) {
    if (Number.isFinite(line.procTVA)) return line.procTVA;
    if (Number.isFinite(line.tva) && Number.isFinite(line.valoare) && line.valoare !== 0) {
      return Fiscal.snapVatRate((line.tva / line.valoare) * 100);
    }
    if (d.taxareInversa) return 0;
    return Fiscal.standardVatRate(d.facturaData);
  },

  buildDetalii(d) {
    let xml = "    <Detalii>\n      <Continut>\n";
    const lines = Array.isArray(d.linii) && d.linii.length > 0 ? d.linii : [this.totalsLine(d)];
    lines.forEach((line, index) => {
      const rate = this.lineVatRate(line, d);
      const value = Number.isFinite(line.valoare) ? line.valoare : 0;
      const quantity = Number.isFinite(line.cantitate) ? line.cantitate : 1;
      const price = Number.isFinite(line.pret) ? line.pret : quantity !== 0 ? value / quantity : value;
      const vat = Number.isFinite(line.tva) ? line.tva : Fiscal.round2((value * rate) / 100);
      xml += this.buildLinie({
        nrCrt: index + 1,
        descriere: line.descriere || "Servicii conform factura",
        um: line.um || "buc",
        cantitate: quantity,
        pret: price,
        valoare: value,
        procTVA: rate,
        tva: vat,
      });
    });
    xml += "      </Continut>\n    </Detalii>\n";
    return xml;
  },

  /** One line from the invoice totals, for invoices without detail lines. */
  totalsLine(d) {
    const base = Number.isFinite(d.totalFaraTVA) ? d.totalFaraTVA : Number.isFinite(d.totalCuTVA) && Number.isFinite(d.totalTVA) ? d.totalCuTVA - d.totalTVA : 0;
    const vat = Number.isFinite(d.totalTVA) ? d.totalTVA : null;
    return {
      descriere: "Servicii conform factura",
      um: "serviciu",
      cantitate: 1,
      pret: base,
      valoare: base,
      procTVA: vat !== null && base !== 0 ? Fiscal.snapVatRate((vat / base) * 100) : null,
      tva: vat,
    };
  },

  buildLinie(line) {
    let xml = "        <Linie>\n";
    xml += this.buildTag("LinieNrCrt", line.nrCrt);
    xml += this.buildTag("Gestiune", "");
    xml += this.buildTag("Activitate", "");
    xml += this.buildTag("Descriere", line.descriere);
    xml += this.buildTag("CodArticolFurnizor", "");
    xml += this.buildTag("CodArticolClient", "");
    xml += this.buildTag("GUID_cod_articol", "");
    xml += this.buildTag("CodBare", "");
    xml += this.buildTag("InformatiiSuplimentare", "");
    xml += this.buildTag("UM", line.um);
    xml += this.buildTag("Cantitate", this.formatNumber(line.cantitate, 4));
    xml += this.buildTag("Pret", this.formatNumber(line.pret, 4));
    xml += this.buildTag("Valoare", this.formatNumber(line.valoare));
    xml += this.buildTag("ProcTVA", String(line.procTVA));
    xml += this.buildTag("TVA", this.formatNumber(line.tva));
    xml += this.buildTag("Cont", "");
    xml += this.buildTag("TipDeducere", "");
    xml += this.buildTag("PretVanzare", "");
    xml += "        </Linie>\n";
    return xml;
  },

  buildTag(tagName, value) {
    return `      <${tagName}>${this.escapeXml(value)}</${tagName}>\n`;
  },

  /** Escape XML and drop characters that XML 1.0 does not allow. */
  escapeXml(text) {
    if (text == null) return "";
    return String(text)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  },

  /** Numbers with a dot separator; up to `maxDecimals` (min 2) decimals. */
  formatNumber(num, maxDecimals = 2) {
    const n = Number(num);
    if (!Number.isFinite(n)) return "0.00";
    const fixed = n.toFixed(maxDecimals);
    return maxDecimals > 2 ? fixed.replace(/(\.\d\d\d*?)0+$/, "$1") : fixed;
  },

  mapPartyToSaga(d, prefix) {
    return {
      name: d[`${prefix}Nume`] || "",
      cif: d[`${prefix}Cif`] || "",
      regCom: d[`${prefix}RegCom`] || "",
      address: d[`${prefix}Adresa`] || "",
      city: d[`${prefix}Localitate`] || "",
      county: d[`${prefix}Judet`] || "",
      country: d[`${prefix}Tara`] || "RO",
      bank: d[`${prefix}Banca`] || "",
      iban: d[`${prefix}IBAN`] || "",
      phone: d[`${prefix}Telefon`] || "",
      email: d[`${prefix}Mail`] || "",
      capital: "0",
    };
  },

  validateXML(xmlString) {
    if (typeof DOMParser === "undefined") return true;
    const doc = new DOMParser().parseFromString(xmlString, "application/xml");
    const error = doc.getElementsByTagName("parsererror")[0];
    if (error) throw new Error(`Generated XML is invalid: ${error.textContent}`);
    return true;
  },
};
