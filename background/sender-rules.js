/**
 * IncoBills — sender rules learned from "Mark as invoice / Not an invoice".
 *
 * Stored as { "addr:billing@x.com": { verdict: "invoice"|"notInvoice", createdAt } }.
 *
 * @license MIT
 */

const SenderRules = {
  async getAll() {
    return Storage.getData(DATA_KEYS.SENDER_RULES, {});
  },

  keyFor(fromHeader) {
    const { email } = Text.parseAddress(fromHeader);
    return email ? `addr:${email}` : null;
  },

  async set(fromHeader, verdict) {
    const key = this.keyFor(fromHeader);
    if (!key || !["invoice", "notInvoice"].includes(verdict)) return null;
    await Storage.update(
      DATA_KEYS.SENDER_RULES,
      (rules) => ({ ...rules, [key]: { verdict, createdAt: new Date().toISOString() } }),
      {}
    );
    return key;
  },

  async remove(key) {
    await Storage.update(
      DATA_KEYS.SENDER_RULES,
      (rules) => {
        const copy = { ...rules };
        delete copy[key];
        return copy;
      },
      {}
    );
  },

  /** Exact address first, then a domain rule ("domain:x.com") if one exists. */
  async match(fromHeader) {
    const { email, domain } = Text.parseAddress(fromHeader);
    if (!email) return null;
    const rules = await this.getAll();
    for (const key of [`addr:${email}`, `domain:${domain}`]) {
      if (rules[key]) return { key, verdict: rules[key].verdict };
    }
    return null;
  },
};
