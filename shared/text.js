/**
 * IncoBills — text and date helpers (no DOM needed).
 *
 * @license MIT
 */

const Text = {
  /** Lowercase and remove diacritics: "Factură" → "factura", "ș"/"ş" → "s". */
  normalize(value) {
    return String(value ?? "")
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase();
  },

  /** Decode HTML entities: named (common ones), decimal and hex. */
  decodeEntities(value) {
    const named = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    return String(value ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
      if (code[0] === "#") {
        const num = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        if (!Number.isFinite(num) || num <= 0 || num > 0x10ffff) return match;
        try {
          return String.fromCodePoint(num);
        } catch {
          return match;
        }
      }
      const key = code.toLowerCase();
      return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : match;
    });
  },

  /** Convert HTML to plain text without a DOM (background scripts). */
  stripHtml(html) {
    const withoutBlocks = String(html ?? "")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " ");
    return this.decodeEntities(withoutBlocks)
      .replace(/[ \t\f\v ]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();
  },

  /**
   * Fill {{name}} placeholders in one pass. Values are inserted literally:
   * "$&" or "{{x}}" inside a value is not expanded.
   */
  fillTemplate(template, values) {
    return String(template).replace(/\{\{(\w+)\}\}/g, (match, key) =>
      Object.prototype.hasOwnProperty.call(values, key) ? String(values[key] ?? "") : match
    );
  },

  escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  },

  /**
   * Regex that finds a normalized keyword with letter boundaries.
   * A boundary is used only on a side where the keyword starts/ends with a letter,
   * so "inv-" still matches "inv-2026" and "vat" does not match "private".
   */
  keywordRegex(keyword) {
    const kw = this.normalize(keyword);
    const lead = /^[a-z]/.test(kw) ? "(?<![a-z])" : "";
    const trail = /[a-z]$/.test(kw) ? "(?![a-z])" : "";
    return new RegExp(lead + this.escapeRegExp(kw) + trail);
  },

  /** Parse "Name <user@example.com>" (or a bare address). */
  parseAddress(header) {
    const raw = String(header ?? "").trim();
    const angle = raw.match(/<([^<>\s]+@[^<>\s]+)>/);
    const bare = raw.match(/[^\s<>"',;]+@[^\s<>"',;]+/);
    const email = ((angle && angle[1]) || (bare && bare[0]) || "").toLowerCase();
    const at = email.lastIndexOf("@");
    let name = raw.replace(/<[^>]*>/, "").replace(/^["'\s]+|["'\s]+$/g, "").trim();
    if (!name || name.toLowerCase() === email) name = at > 0 ? email.slice(0, at) : raw;
    return {
      name,
      email,
      local: at > 0 ? email.slice(0, at) : "",
      domain: at > 0 ? email.slice(at + 1) : "",
    };
  },

  /** Local calendar date as YYYY-MM-DD (not UTC). */
  localDateString(date = new Date()) {
    const d = new Date(date);
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
  },

  /** "YYYY-MM-DD" → local Date at 00:00:00.000, or at 23:59:59.999 when endOfDay. */
  parseLocalDate(value, endOfDay = false) {
    const m = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const d = endOfDay
      ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999)
      : new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
  },

  /** "YYYY-MM" in local time. */
  monthKey(date) {
    const d = date ? new Date(date) : new Date();
    const safe = Number.isNaN(d.getTime()) ? new Date() : d;
    return safe.getFullYear() + "-" + String(safe.getMonth() + 1).padStart(2, "0");
  },

  /** True if the value is a real calendar date in YYYY-MM-DD form. */
  isIsoDate(value) {
    const d = this.parseLocalDate(value);
    return Boolean(d) && this.localDateString(d) === value;
  },

  /** Short, single-line version of an error message (for history and UI). */
  shortError(err, max = 160) {
    const msg = String((err && err.message) || err || "").replace(/\s+/g, " ").trim();
    return msg.length > max ? msg.slice(0, max - 1) + "…" : msg;
  },

  /** Parse amounts like 1234.56, "1.234,56", "1,234.56", "1 234,56 lei". */
  parseAmount(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (value == null) return null;
    let s = String(value).replace(/[^\d.,\-]/g, "");
    if (!s || !/\d/.test(s)) return null;
    const commas = (s.match(/,/g) || []).length;
    const dots = (s.match(/\./g) || []).length;
    if (commas && dots) {
      // Both present: the last one is the decimal separator.
      s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
    } else if (commas) {
      // "1,234,567" or "12,345" (thousands) vs "12,5" / "0,123" (decimal comma).
      s = /^-?[1-9]\d{0,2}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(/,(?=.*,)/g, "").replace(",", ".");
    } else if (dots > 1) {
      s = s.replace(/\./g, ""); // "1.234.567"
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  },
};
