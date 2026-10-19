/**
 * IncoBills SAGA Export — public ANAF registry lookup (no authentication).
 *
 * POST https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva
 * Body: [{ "cui": 12345678, "data": "YYYY-MM-DD" }]
 * Only the CUI number and a date leave the computer. ANAF allows max 1 request/second.
 *
 * @license MIT
 */

const ANAF = {
  ENDPOINT: "https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva",
  MIN_INTERVAL_MS: 1100,
  CACHE_TTL_MS: 7 * 24 * 60 * 60 * 1000,
  _cache: new Map(),
  _queue: Promise.resolve(),
  _lastCall: 0,

  /**
   * @param {string} cif  Romanian CIF (with or without "RO")
   * @param {string} [date]  YYYY-MM-DD (default: today)
   * @returns {Promise<null|object>} null if not Romanian, invalid, or not found
   */
  async lookup(cif, date) {
    const digits = Fiscal.cifDigits(cif);
    if (!digits || !Fiscal.isValidRomanianCif(digits)) return null;
    const day = Text.isIsoDate(date) ? date : Text.localDateString(new Date());
    const key = `${digits}:${day}`;
    const cached = this._cache.get(key);
    if (cached && Date.now() - cached.at < this.CACHE_TTL_MS) return cached.value;

    const value = await this._serialized(() => this._fetch(digits, day));
    this._cache.set(key, { at: Date.now(), value });
    return value;
  },

  /** Run requests one after another with the ANAF rate limit. */
  _serialized(task) {
    const run = this._queue.catch(() => {}).then(async () => {
      const wait = this._lastCall + this.MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await Http.sleep(wait);
      try {
        return await task();
      } finally {
        this._lastCall = Date.now();
      }
    });
    this._queue = run;
    return run;
  },

  async _fetch(digits, day) {
    const data = await Http.json(
      this.ENDPOINT,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([{ cui: Number(digits), data: day }]),
      },
      { timeoutMs: 15000, retries: 2, label: "ANAF" }
    );
    const found = Array.isArray(data && data.found) ? data.found[0] : null;
    return found ? this.parse(found) : null;
  },

  /** Map one ANAF v9 record to the fields IncoBills uses. */
  parse(record) {
    const general = record.date_generale || {};
    const vat = record.inregistrare_scop_Tva || {};
    const rtvai = record.inregistrare_RTVAI || {};
    const inactive = record.stare_inactiv || {};
    const seat = record.adresa_sediu_social || {};

    const streetParts = [];
    if (seat.sdenumire_Strada) streetParts.push(seat.sdenumire_Strada);
    if (seat.snumar_Strada) streetParts.push(`nr. ${seat.snumar_Strada}`);
    if (seat.sdetalii_Adresa) streetParts.push(seat.sdetalii_Adresa);
    const city = String(seat.sdenumire_Localitate || "").replace(/^(Mun\.|Municipiul|Oraș|Oras|Com\.|Comuna|Sat)\s+/i, "").trim();

    return {
      cui: String(general.cui || ""),
      name: String(general.denumire || "").trim(),
      regCom: String(general.nrRegCom || "").trim(),
      address: streetParts.join(" ").trim() || String(general.adresa || "").trim(),
      city,
      county: String(seat.scod_JudetAuto || "").trim(),
      country: "RO",
      phone: String(general.telefon || "").trim(),
      postalCode: String(general.codPostal || seat.scod_Postal || "").trim(),
      iban: String(general.iban || "").trim(),
      vatPayer: Boolean(vat.scpTVA),
      vatOnCollection: Boolean(rtvai.statusTvaIncasare),
      inactive: Boolean(inactive.statusInactivi),
      eFactura: Boolean(general.statusRO_e_Factura),
    };
  },
};
