/**
 * IncoBills SAGA Export — registry of the user's own companies.
 *
 * @license MIT
 */

const CompanyRegistry = {
  async getAll() {
    const list = await Storage.getData(SAGA_STORAGE_KEYS.COMPANIES, []);
    return Array.isArray(list) ? list : [];
  },

  async getById(id) {
    return (await this.getAll()).find((c) => c.id === id) || null;
  },

  /** Match by CIF; "RO12345678", "12345678" and "RO 1234 5678" are the same company. */
  async findByCIF(cif) {
    if (!cif) return null;
    return (await this.getAll()).find((c) => Fiscal.sameCompany(c.cif, cif)) || null;
  },

  /**
   * Direction and own company for an invoice.
   * Supplier is ours → iesiri. Client is ours → intrari. Both ours → iesiri (flagged by the validator).
   */
  async resolve(furnizorCif, clientCif) {
    const supplier = await this.findByCIF(furnizorCif);
    const client = await this.findByCIF(clientCif);
    if (supplier) return { direction: SAGA_INVOICE_DIRECTION.IESIRI, company: supplier, intraGroup: Boolean(client) };
    if (client) return { direction: SAGA_INVOICE_DIRECTION.INTRARI, company: client, intraGroup: false };
    return { direction: SAGA_INVOICE_DIRECTION.UNKNOWN, company: null, intraGroup: false };
  },

  async determineDirection(furnizorCif, clientCif) {
    return (await this.resolve(furnizorCif, clientCif)).direction;
  },

  _clean(company) {
    const out = {};
    for (const key of Object.keys(SAGA_COMPANY_TEMPLATE)) {
      if (key === "id") continue;
      out[key] = String(company[key] ?? "").trim();
    }
    out.cif = Fiscal.normalizeCif(out.cif);
    out.iban = out.iban.toUpperCase().replace(/\s+/g, "");
    out.country = (out.country || "RO").toUpperCase();
    return out;
  },

  async add(company) {
    const clean = this._clean(company);
    const check = this.validate(clean);
    if (!check.valid) throw new Error(check.errors.join("; "));
    let created;
    await Storage.update(
      SAGA_STORAGE_KEYS.COMPANIES,
      (list) => {
        if (list.some((c) => Fiscal.sameCompany(c.cif, clean.cif))) throw new Error(t("errCompanyExists", [clean.cif]));
        created = { ...SAGA_COMPANY_TEMPLATE, ...clean, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
        return [...list, created];
      },
      []
    );
    return created;
  },

  async update(id, updates) {
    let updated;
    await Storage.update(
      SAGA_STORAGE_KEYS.COMPANIES,
      (list) => {
        const index = list.findIndex((c) => c.id === id);
        if (index === -1) throw new Error(t("errCompanyNotFound"));
        const clean = this._clean({ ...list[index], ...updates });
        const check = this.validate(clean);
        if (!check.valid) throw new Error(check.errors.join("; "));
        if (list.some((c, i) => i !== index && Fiscal.sameCompany(c.cif, clean.cif))) throw new Error(t("errCompanyExists", [clean.cif]));
        updated = { ...list[index], ...clean, id };
        const copy = list.slice();
        copy[index] = updated;
        return copy;
      },
      []
    );
    return updated;
  },

  async delete(id) {
    let removed = false;
    await Storage.update(
      SAGA_STORAGE_KEYS.COMPANIES,
      (list) => {
        const filtered = list.filter((c) => c.id !== id);
        removed = filtered.length !== list.length;
        return filtered;
      },
      []
    );
    return removed;
  },

  /** Name and CIF are required. Romanian CIF and IBAN must pass their check digits. */
  validate(company) {
    const errors = [];
    if (!company.name) errors.push(t("valCompanyNameRequired"));
    if (!company.cif) errors.push(t("valCompanyCifRequired"));
    else if (Fiscal.isRomanianCif(company.cif) && !Fiscal.isValidRomanianCif(company.cif)) errors.push(t("valCifChecksum", [company.cif]));
    if (company.iban && !Fiscal.isValidIban(company.iban)) errors.push(t("valIbanInvalid", [company.iban]));
    if (company.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(company.email)) errors.push(t("valEmailInvalid", [company.email]));
    return { valid: errors.length === 0, errors };
  },
};
