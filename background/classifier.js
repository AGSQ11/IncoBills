/**
 * IncoBills — classifier dispatcher.
 *
 * Order: sender rule → keywords → (hybrid: skip AI for clear cases) → AI → keyword fallback.
 * Tracks AI failures and warns the user when the backend keeps failing.
 *
 * @license MIT
 */

const Classifier = {
  _consecutiveFailures: 0,
  _lastAlertAt: 0,

  buildPrompt(metadata) {
    return Text.fillTemplate(CLASSIFICATION_USER_PROMPT, {
      from: metadata.from || "unknown",
      subject: metadata.subject || "(no subject)",
      attachments: (metadata.attachmentNames || []).join(", ") || "none",
      body: metadata.bodySnippet || "(empty)",
    });
  },

  normalizeAiResult(raw) {
    const confidence = Number(raw && raw.confidence);
    return {
      isInvoice: Boolean(raw && raw.isInvoice),
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
      reason: String((raw && raw.reason) || "").slice(0, 300),
    };
  },

  async classify(metadata, settingsArg) {
    const settings = settingsArg || (await Storage.getSettings());

    const rule = await SenderRules.match(metadata.from);
    if (rule) {
      const invoice = rule.verdict === "invoice";
      return { isInvoice: invoice, confidence: invoice ? 1 : 0, reason: `sender rule (${rule.key.slice(5)})`, source: "rule" };
    }

    const keywords = KeywordClassifier.classify(metadata);
    const provider = LLM.providerFor(settings, "classify");
    if (!provider) return { ...keywords, source: "keywords" };

    if (settings.hybridMode) {
      if (keywords.confidence <= HYBRID_BOUNDS.low) {
        return { ...keywords, isInvoice: false, source: "keywords", reason: `[hybrid] ${keywords.reason}` };
      }
      if (keywords.confidence >= HYBRID_BOUNDS.high) {
        return { ...keywords, source: "keywords", reason: `[hybrid] ${keywords.reason}` };
      }
    }

    try {
      const raw = await LLM.completeJson({
        provider,
        system: CLASSIFICATION_SYSTEM_PROMPT,
        prompt: this.buildPrompt(metadata),
        schema: CLASSIFICATION_SCHEMA,
        schemaName: "classify_email",
      });
      await this._recordSuccess();
      return { ...this.normalizeAiResult(raw), source: provider.backend };
    } catch (err) {
      await this._recordFailure(provider.backend, err);
      return {
        ...keywords,
        source: "keywords",
        fallback: true,
        reason: `[fallback] ${keywords.reason} (${provider.backend}: ${Text.shortError(err, 120)})`,
      };
    }
  },

  _storedOk: null, // cached copy of backendStatus.ok (null = not read yet)

  async _recordSuccess() {
    this._consecutiveFailures = 0;
    if (this._storedOk === null) {
      const status = await Storage.getData(DATA_KEYS.BACKEND_STATUS, { ok: true });
      this._storedOk = status.ok !== false;
    }
    if (this._storedOk) return;
    this._storedOk = true;
    await Storage.set({ [DATA_KEYS.BACKEND_STATUS]: { ok: true, updatedAt: new Date().toISOString() } });
  },

  /** Forget old failures (e.g. after the user changes the backend). */
  async resetStatus() {
    this._consecutiveFailures = 0;
    this._storedOk = true;
    await Storage.set({ [DATA_KEYS.BACKEND_STATUS]: { ok: true, updatedAt: new Date().toISOString() } });
  },

  async _recordFailure(backend, err) {
    this._consecutiveFailures++;
    const status = {
      ok: false,
      backend,
      error: Text.shortError(err, 240),
      failures: this._consecutiveFailures,
      updatedAt: new Date().toISOString(),
    };
    this._storedOk = false;
    await Storage.set({ [DATA_KEYS.BACKEND_STATUS]: status }).catch(() => {});
    console.warn(`IncoBills: ${backend} failed (${this._consecutiveFailures}x), using keywords:`, status.error);

    const now = Date.now();
    if (this._consecutiveFailures >= BACKEND_FAILURE_ALERT_AFTER && now - this._lastAlertAt > BACKEND_ALERT_INTERVAL_MS) {
      this._lastAlertAt = now;
      await browser.notifications
        .create("incobills-backend-failing", {
          type: "basic",
          iconUrl: "icons/icon-96.svg",
          title: t("notifBackendFailingTitle"),
          message: t("notifBackendFailingBody", [backend, status.error]),
        })
        .catch(() => {});
    }
  },

  async testBackend(backend, options) {
    return LLM.testConnection(backend, options || {});
  },
};
