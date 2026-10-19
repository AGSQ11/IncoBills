/**
 * IncoBills — fiscal helpers for Romania (CIF, IBAN, VAT rates).
 *
 * @license MIT
 */

const Fiscal = {
  /** Standard Romanian VAT rate by start date (Law 141/2025 raised it to 21%). */
  RO_STANDARD_VAT: [
    { from: "2017-01-01", rate: 19 },
    { from: "2025-08-01", rate: 21 },
  ],

  /** Rates that appear on Romanian invoices (standard, reduced, zero). */
  RO_KNOWN_VAT_RATES: [0, 5, 9, 11, 19, 21],

  /** Remove spaces, dots, dashes and slashes; uppercase. */
  normalizeCif(raw) {
    return String(raw ?? "").toUpperCase().replace(/[\s.\-\/]/g, "");
  },

  /**
   * Digits of a Romanian CIF ("RO12345678" or "12345678" → "12345678").
   * Returns null for foreign VAT IDs (e.g. "FR12345678901") and empty values.
   */
  cifDigits(raw) {
    const n = this.normalizeCif(raw);
    const m = n.match(/^(?:RO)?(\d{2,10})$/);
    return m ? m[1].replace(/^0+(?=\d)/, "") : null;
  },

  isRomanianCif(raw) {
    return this.cifDigits(raw) !== null;
  },

  /** Check the control digit of a Romanian CIF/CUI (key 753217532). */
  isValidRomanianCif(raw) {
    const digits = this.cifDigits(raw);
    if (!digits || digits.length < 2 || digits.length > 10) return false;
    const body = digits.slice(0, -1).padStart(9, "0");
    const key = "753217532";
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += Number(body[i]) * Number(key[i]);
    let control = (sum * 10) % 11;
    if (control === 10) control = 0;
    return control === Number(digits[digits.length - 1]);
  },

  /** Same company? Romanian CIFs compare by digits; others by normalized value. */
  sameCompany(a, b) {
    if (!a || !b) return false;
    const da = this.cifDigits(a);
    const db = this.cifDigits(b);
    if (da && db) return da === db;
    return this.normalizeCif(a) === this.normalizeCif(b);
  },

  /** Key used to detect duplicate invoices from the same supplier. */
  partyKey(raw) {
    return this.cifDigits(raw) || this.normalizeCif(raw);
  },

  /** Format a CIF for SAGA: Romanian VAT payers get "RO", others digits only. */
  formatRomanianCif(raw, vatPayer) {
    const digits = this.cifDigits(raw);
    if (!digits) return this.normalizeCif(raw);
    return vatPayer ? "RO" + digits : digits;
  },

  /** IBAN check (ISO 13616, mod 97). */
  isValidIban(raw) {
    const iban = String(raw ?? "").toUpperCase().replace(/\s+/g, "");
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
    const rearranged = iban.slice(4) + iban.slice(0, 4);
    let remainder = 0;
    for (const ch of rearranged) {
      const code = ch.charCodeAt(0);
      const chunk = code >= 65 ? String(code - 55) : ch;
      for (const digit of chunk) remainder = (remainder * 10 + Number(digit)) % 97;
    }
    return remainder === 1;
  },

  /** Standard Romanian VAT rate that applies on a date (YYYY-MM-DD). */
  standardVatRate(dateIso) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(dateIso ?? "")) ? dateIso : Text.localDateString(new Date());
    let rate = this.RO_STANDARD_VAT[0].rate;
    for (const entry of this.RO_STANDARD_VAT) if (date >= entry.from) rate = entry.rate;
    return rate;
  },

  /** Round a computed rate to a known rate when it is very close (rounding noise). */
  snapVatRate(rate) {
    if (!Number.isFinite(rate)) return null;
    let best = null;
    for (const known of this.RO_KNOWN_VAT_RATES) {
      if (Math.abs(known - rate) <= 0.6 && (best === null || Math.abs(known - rate) < Math.abs(best - rate))) best = known;
    }
    return best === null ? Math.round(rate * 100) / 100 : best;
  },

  round2(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  },
};
