/**
 * IncoBills — one provider layer for all AI calls (classification + extraction).
 *
 * Every call: timeout, retry with backoff, structured output
 * (Claude forced tool use, OpenAI json_schema, Ollama format schema),
 * and a tolerant JSON parser as the last resort.
 *
 * @license MIT
 */

const LLM = {
  trimUrl(url) {
    return String(url || "").trim().replace(/\/+$/, "");
  },

  /** Provider settings for the active backend, or null for "keywords". */
  providerFor(settings, purpose = "classify") {
    const extract = purpose === "extract";
    switch (settings.aiBackend) {
      case "claude":
        return {
          backend: "claude",
          baseUrl: this.trimUrl(settings.claudeApiUrl || DEFAULTS.claudeApiUrl),
          apiKey: settings.claudeApiKey,
          model: (extract && settings.claudeExtractModel) || settings.claudeModel || DEFAULTS.claudeModel,
        };
      case "openai":
        return {
          backend: "openai",
          baseUrl: this.trimUrl(settings.openaiApiUrl || DEFAULTS.openaiApiUrl),
          apiKey: settings.openaiApiKey,
          model: (extract && settings.openaiExtractModel) || settings.openaiModel || DEFAULTS.openaiModel,
        };
      case "ollama":
        return {
          backend: "ollama",
          baseUrl: this.trimUrl(settings.ollamaUrl || DEFAULTS.ollamaUrl),
          apiKey: "",
          model: (extract && settings.ollamaExtractModel) || settings.ollamaModel || DEFAULTS.ollamaModel,
        };
      default:
        return null;
    }
  },

  /** Claude and OpenAI send data to a third party; Ollama stays local. */
  isCloud(backend) {
    return backend === "claude" || backend === "openai";
  },

  isOfficialOpenAI(baseUrl) {
    try {
      return new URL(baseUrl).hostname === "api.openai.com";
    } catch {
      return false;
    }
  },

  bytesToBase64(bytes) {
    const view = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < view.length; i += chunk) {
      binary += String.fromCharCode.apply(null, view.subarray(i, i + chunk));
    }
    return btoa(binary);
  },

  /** Find and parse a JSON object in model text (fences, prose around it). */
  parseLoose(text) {
    const raw = String(text ?? "").trim();
    if (!raw) throw new Error("empty AI response");
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1].trim() : raw;
    try {
      return JSON.parse(candidate);
    } catch {
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
      throw new Error(`AI response is not JSON: ${raw.slice(0, 200)}`);
    }
  },

  /**
   * Ask the model for a JSON object that matches `schema`.
   * @param {object} opts
   * @param {object} opts.provider  result of providerFor()
   * @param {string} opts.system
   * @param {string} opts.prompt
   * @param {object} opts.schema    JSON schema (strict-mode compatible)
   * @param {string} [opts.schemaName]
   * @param {ArrayBuffer|Uint8Array} [opts.pdf]  Claude/OpenAI only
   * @param {string} [opts.pdfName]
   */
  async completeJson(opts) {
    const provider = opts.provider;
    if (!provider) throw new HttpError("No AI backend selected", { retryable: false });
    const call = { schemaName: "result", maxTokens: LLM_LIMITS.classifyMaxTokens, timeoutMs: LLM_LIMITS.classifyTimeoutMs, retries: LLM_LIMITS.maxRetries, ...opts };
    switch (provider.backend) {
      case "claude":
        return this._claude(call);
      case "openai":
        return this._openai(call);
      case "ollama":
        if (call.pdf) throw new HttpError("Ollama cannot read PDF files directly", { retryable: false });
        return this._ollama(call);
      default:
        throw new HttpError(`Unknown backend: ${provider.backend}`, { retryable: false });
    }
  },

  async _claude({ provider, system, prompt, schema, schemaName, pdf, maxTokens, timeoutMs, retries }) {
    if (!provider.apiKey) throw new HttpError("Claude API key is not set", { retryable: false });
    const content = [];
    if (pdf) {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: this.bytesToBase64(pdf) } });
    }
    content.push({ type: "text", text: prompt });
    const data = await Http.json(
      `${provider.baseUrl}/v1/messages`,
      {
        method: "POST",
        headers: {
          "x-api-key": provider.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: provider.model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content }],
          tools: [{ name: schemaName, description: "Return the result.", input_schema: schema }],
          tool_choice: { type: "tool", name: schemaName },
        }),
      },
      { timeoutMs, retries, label: "Claude API" }
    );
    const blocks = Array.isArray(data.content) ? data.content : [];
    const tool = blocks.find((b) => b.type === "tool_use");
    if (tool && tool.input && typeof tool.input === "object") return tool.input;
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    return this.parseLoose(text);
  },

  async _openai({ provider, system, prompt, schema, schemaName, pdf, pdfName, maxTokens, timeoutMs, retries }) {
    if (!provider.apiKey) throw new HttpError("OpenAI API key is not set", { retryable: false });
    const official = this.isOfficialOpenAI(provider.baseUrl);
    const userContent = pdf
      ? [
          { type: "file", file: { filename: pdfName || "document.pdf", file_data: `data:application/pdf;base64,${this.bytesToBase64(pdf)}` } },
          { type: "text", text: prompt },
        ]
      : prompt;
    const base = {
      model: provider.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
    };
    // Current OpenAI models want max_completion_tokens and the default temperature.
    // OpenAI-compatible servers (LiteLLM, vLLM, LM Studio...) mostly expect max_tokens.
    if (official) base.max_completion_tokens = maxTokens;
    else Object.assign(base, { max_tokens: maxTokens, temperature: 0 });

    const formats = [
      { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } },
      { type: "json_object" },
      null,
    ];
    let lastError = null;
    for (const format of formats) {
      const body = format ? { ...base, response_format: format } : base;
      try {
        const data = await Http.json(
          `${provider.baseUrl}/v1/chat/completions`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
          { timeoutMs, retries, label: "OpenAI API" }
        );
        const message = data.choices && data.choices[0] && data.choices[0].message;
        if (message && message.refusal) throw new HttpError(`OpenAI refused: ${message.refusal}`, { retryable: false });
        return this.parseLoose(message && message.content);
      } catch (err) {
        lastError = err;
        const formatProblem = err.status === 400 && /response_format|json_schema|json_object/i.test(err.body || "");
        if (!formatProblem) throw err;
      }
    }
    throw lastError;
  },

  async _ollama({ provider, system, prompt, schema, maxTokens, timeoutMs, retries }) {
    const formats = [schema, "json"];
    let lastError = null;
    for (const format of formats) {
      try {
        const data = await Http.json(
          `${provider.baseUrl}/api/chat`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: provider.model,
              stream: false,
              format,
              options: { temperature: 0, num_predict: Math.min(maxTokens, 4096) },
              messages: [
                { role: "system", content: system },
                { role: "user", content: prompt },
              ],
            }),
          },
          { timeoutMs, retries, label: "Ollama" }
        );
        return this.parseLoose(data.message && data.message.content);
      } catch (err) {
        lastError = err;
        // Ollama < 0.5 accepts only format: "json".
        if (!(err.status === 400 && format !== "json")) throw err;
      }
    }
    throw lastError;
  },

  /** Test a backend with the same request type that real calls use. */
  async testConnection(backend, options = {}) {
    if (backend === "keywords") return true;
    if (backend === "ollama") return this._testOllama(options.url, options.model);
    const provider = {
      backend,
      baseUrl: this.trimUrl(options.apiUrl || (backend === "claude" ? DEFAULTS.claudeApiUrl : DEFAULTS.openaiApiUrl)),
      apiKey: String(options.apiKey || "").trim(),
      model: String(options.model || "").trim() || (backend === "claude" ? DEFAULTS.claudeModel : DEFAULTS.openaiModel),
    };
    const result = await this.completeJson({
      provider,
      system: "You are a connection test.",
      prompt: 'Return {"ok": true}.',
      schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
      schemaName: "connection_test",
      maxTokens: backend === "openai" && this.isOfficialOpenAI(provider.baseUrl) ? 1000 : 50,
      retries: 0,
    });
    if (!result || typeof result !== "object") throw new Error("Unexpected response");
    return true;
  },

  async _testOllama(url, model) {
    const baseUrl = this.trimUrl(url || DEFAULTS.ollamaUrl);
    let response;
    try {
      response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(10000) });
    } catch (err) {
      throw new Error(t("errOllamaUnreachable", [baseUrl, err.message]));
    }
    if (response.status === 403) throw new Error(t("errOllamaForbidden"));
    if (!response.ok) throw new Error(`Ollama ${response.status} (${baseUrl})`);
    const tags = await response.json();
    const models = (tags.models || []).map((m) => m.name);
    const wanted = String(model || "").trim();
    if (wanted && !models.some((name) => name === wanted || name === `${wanted}:latest` || name.startsWith(`${wanted}:`))) {
      throw new Error(t("errOllamaModelMissing", [wanted, models.join(", ") || "-"]));
    }
    return true;
  },
};
