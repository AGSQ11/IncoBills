/**
 * IncoBills — keyword heuristic classifier (offline, zero setup).
 *
 * Text is normalized first (lowercase, no diacritics), so "Factură" matches
 * "factura". Keywords match on letter boundaries, so "vat" does not match
 * "private" and "bic" does not match "public".
 *
 * @license MIT
 */

const KeywordClassifier = {
  _compiled: null,

  _compile() {
    if (this._compiled) return this._compiled;
    const toRegex = (list) => list.map((kw) => ({ kw, re: Text.keywordRegex(kw) }));
    this._compiled = {
      subject: toRegex(INVOICE_KEYWORDS.subject),
      senderPrefixes: toRegex(INVOICE_KEYWORDS.senderPrefixes),
      senderDomains: INVOICE_KEYWORDS.senderDomains.map((kw) => Text.normalize(kw)),
      attachment: toRegex(INVOICE_KEYWORDS.attachmentKeywords),
      body: toRegex(INVOICE_KEYWORDS.body),
      negative: toRegex(INVOICE_KEYWORDS.negative),
      currency: INVOICE_KEYWORDS.currencyPatterns.map((src) => new RegExp(src, "i")),
    };
    return this._compiled;
  },

  classify(metadata) {
    const c = this._compile();
    let score = 0;
    const reasons = [];
    const note = (text) => {
      if (reasons.length < 5) reasons.push(text);
    };

    const subject = Text.normalize(metadata.subject);
    const body = Text.normalize(metadata.bodySnippet);
    const sender = Text.parseAddress(metadata.from);

    // Subject keywords: 0.25 each, max 0.5
    let subjectHits = 0;
    for (const { kw, re } of c.subject) {
      if (re.test(subject)) {
        subjectHits++;
        note(`subject: "${kw}"`);
      }
    }
    score += Math.min(subjectHits * 0.25, 0.5);

    // Sender address (not the display name): 0.15 each, max 0.3
    let senderHits = 0;
    const local = sender.local.replace(/[._+\-]/g, " ");
    for (const { kw, re } of c.senderPrefixes) {
      if (re.test(local)) {
        senderHits++;
        note(`sender: "${kw}"`);
      }
    }
    for (const kw of c.senderDomains) {
      if (sender.domain.includes(kw)) {
        senderHits++;
        note(`sender domain: "${kw}"`);
      }
    }
    score += Math.min(senderHits * 0.15, 0.3);

    // Document attachments with an invoice-like name: 0.3 each, max 0.6
    let attachmentScore = 0;
    for (const name of metadata.attachmentNames || []) {
      if (!/\.(pdf|xlsx?|docx?|odt|ods|csv|xml|zip)$/i.test(name)) continue;
      const normalized = Text.normalize(name).replace(/[_.\-]/g, " ");
      if (c.attachment.some(({ re }) => re.test(normalized))) {
        attachmentScore += 0.3;
        note(`attachment: "${name}"`);
      }
    }
    score += Math.min(attachmentScore, 0.6);

    // Body keywords: 0.1 each, max 0.3
    let bodyHits = 0;
    for (const { kw, re } of c.body) {
      if (re.test(body)) {
        bodyHits++;
        note(`body: "${kw}"`);
      }
    }
    score += Math.min(bodyHits * 0.1, 0.3);

    // A currency amount in the body: 0.15 once
    if (c.currency.some((re) => re.test(body))) {
      score += 0.15;
      note("currency amount in body");
    }

    // Newsletter signals: -0.2 each, max -0.4
    let negative = 0;
    for (const { re } of c.negative) if (re.test(body)) negative += 0.2;
    score -= Math.min(negative, 0.4);

    const confidence = Math.round(Math.max(0, Math.min(1, score)) * 100) / 100;
    return {
      isInvoice: confidence > 0,
      confidence,
      reason: reasons.join("; ") || "no invoice signals detected",
    };
  },
};
