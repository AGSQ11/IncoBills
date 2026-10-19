"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createEnv, jsonResponse } = require("./helpers/env");

function claudeToolResponse(input) {
  return { content: [{ type: "tool_use", name: "classify_email", input }] };
}

test("keywords: diacritics match ('Factură fiscală')", () => {
  const env = createEnv();
  const K = env.get("KeywordClassifier");
  const withDiacritics = K.classify({ subject: "Factură fiscală nr. 123", from: "Office <office@firma.ro>", bodySnippet: "", attachmentNames: [] });
  const without = K.classify({ subject: "Factura fiscala nr. 123", from: "Office <office@firma.ro>", bodySnippet: "", attachmentNames: [] });
  assert.ok(withDiacritics.confidence > 0);
  assert.equal(withDiacritics.confidence, without.confidence);
});

test("keywords: no substring false positives (vat/bic/swift, noreply)", () => {
  const env = createEnv();
  const r = env.get("KeywordClassifier").classify({
    subject: "Your private public cubic notes",
    from: "Team <noreply@news.example.com>",
    bodySnippet: "private data, public cubic view, activate now, swiftly",
    attachmentNames: [],
  });
  assert.equal(r.confidence, 0);
});

test("keywords: Romanian invoice email scores high", () => {
  const env = createEnv();
  const r = env.get("KeywordClassifier").classify({
    subject: "Factură FCT0042",
    from: "Facturare <facturare@exemplu.ro>",
    bodySnippet: "Total de plată: 1.234,56 lei. Cota TVA 21%. Termen de plată 30.10.2026",
    attachmentNames: ["Factura_FCT0042.pdf"],
  });
  assert.ok(r.confidence >= 0.9, JSON.stringify(r));
});

test("hybrid mode: no AI call for zero-signal and very clear emails", async () => {
  const env = createEnv();
  await env.browser.storage.local.set({ aiBackend: "claude", claudeApiKey: "k", hybridMode: true });
  const C = env.get("Classifier");
  const none = await C.classify({ subject: "Lunch on Friday?", from: "Ana <ana@example.com>", bodySnippet: "See you there", attachmentNames: [] });
  assert.equal(none.isInvoice, false);
  assert.equal(none.source, "keywords");
  const clear = await C.classify({
    subject: "Factură FCT0042",
    from: "Facturare <facturare@exemplu.ro>",
    bodySnippet: "Total de plată: 121,00 lei. Cota TVA 21%",
    attachmentNames: ["Factura_FCT0042.pdf"],
  });
  assert.equal(clear.source, "keywords");
  assert.equal(env.fetchCalls.length, 0);
});

test("AI call uses forced tool use and the configured model", async () => {
  const env = createEnv();
  await env.browser.storage.local.set({ aiBackend: "claude", claudeApiKey: "k", claudeModel: "claude-haiku-5-5", hybridMode: false });
  env.respond(claudeToolResponse({ isInvoice: true, confidence: 0.93, reason: "invoice" }));
  const r = await env.get("Classifier").classify({ subject: "Your receipt", from: "a@b.c", bodySnippet: "Total $12.00", attachmentNames: [] });
  assert.deepEqual({ isInvoice: r.isInvoice, confidence: r.confidence, source: r.source }, { isInvoice: true, confidence: 0.93, source: "claude" });
  const body = env.fetchCalls[0].body;
  assert.equal(body.model, "claude-haiku-5-5");
  assert.equal(body.tool_choice.name, "classify_email");
  assert.match(body.messages[0].content[0].text, /<email>/);
});

test("AI failure: retries 429, then falls back to keywords and marks the result", async () => {
  const env = createEnv();
  await env.browser.storage.local.set({ aiBackend: "claude", claudeApiKey: "k", hybridMode: false });
  for (let i = 0; i < 4; i++) env.respond(() => jsonResponse({ error: "rate limited" }, 429));
  const r = await env.get("Classifier").classify({ subject: "Invoice 5", from: "a@b.c", bodySnippet: "", attachmentNames: [] });
  assert.equal(env.fetchCalls.length, 4, "1 call + 3 retries");
  assert.equal(r.fallback, true);
  assert.equal(r.source, "keywords");
  assert.match(r.reason, /\[fallback\]/);
  assert.equal(env.store.backendStatus.ok, false);
});

test("backend failing 3 times in a row shows one notification", async () => {
  const env = createEnv();
  await env.browser.storage.local.set({ aiBackend: "openai", openaiApiKey: "k", hybridMode: false });
  const C = env.get("Classifier");
  for (let i = 0; i < 4; i++) {
    env.respond(() => jsonResponse({ error: { message: "bad key" } }, 401));
    await C.classify({ subject: "Invoice", from: "a@b.c", bodySnippet: "", attachmentNames: [] });
  }
  assert.equal(env.notifications.filter((n) => n.id === "incobills-backend-failing").length, 1);
});

test("sender rule wins without keywords or AI", async () => {
  const env = createEnv();
  await env.browser.storage.local.set({ aiBackend: "claude", claudeApiKey: "k" });
  await env.get("SenderRules").set("Shop <orders@shop.example>", "notInvoice");
  const r = await env.get("Classifier").classify({ subject: "Invoice 5 attached", from: "orders@shop.example", bodySnippet: "", attachmentNames: ["invoice.pdf"] });
  assert.equal(r.isInvoice, false);
  assert.equal(r.source, "rule");
  assert.equal(env.fetchCalls.length, 0);
});

test("OpenAI: official API gets json_schema + max_completion_tokens; PDF as file part", async () => {
  const env = createEnv();
  const LLM = env.get("LLM");
  env.respond({ choices: [{ message: { content: '{"ok":true}' } }] });
  await LLM.completeJson({
    provider: { backend: "openai", baseUrl: "https://api.openai.com", apiKey: "k", model: "gpt-6-luna" },
    system: "s",
    prompt: "p",
    schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
    pdf: new Uint8Array([37, 80, 68, 70]),
    pdfName: "f.pdf",
  });
  const body = env.fetchCalls[0].body;
  assert.equal(body.response_format.type, "json_schema");
  assert.ok(body.max_completion_tokens > 0);
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.temperature, undefined);
  assert.equal(body.messages[1].content[0].type, "file");
  assert.match(body.messages[1].content[0].file.file_data, /^data:application\/pdf;base64,JVBERg==$/);
});

test("OpenAI-compatible server: falls back when json_schema is not supported", async () => {
  const env = createEnv();
  env.respond(() => jsonResponse({ error: "response_format json_schema not supported" }, 400));
  env.respond({ choices: [{ message: { content: 'Sure: {"ok": true}' } }] });
  const out = await env.get("LLM").completeJson({
    provider: { backend: "openai", baseUrl: "http://litellm.lan:4000", apiKey: "k", model: "x" },
    system: "s",
    prompt: "p",
    schema: { type: "object" },
  });
  assert.equal(out.ok, true);
  assert.equal(env.fetchCalls[0].body.max_tokens > 0, true);
  assert.equal(env.fetchCalls[1].body.response_format.type, "json_object");
});

test("Ollama: schema format first, plain json on older servers", async () => {
  const env = createEnv();
  env.respond(() => jsonResponse({ error: "invalid format" }, 400));
  env.respond({ message: { content: '{"isInvoice":false,"confidence":0.1,"reason":"x"}' } });
  const out = await env.get("LLM").completeJson({
    provider: { backend: "ollama", baseUrl: "http://127.0.0.1:11434", model: "llama3.2:3b" },
    system: "s",
    prompt: "p",
    schema: { type: "object" },
  });
  assert.equal(out.confidence, 0.1);
  assert.equal(typeof env.fetchCalls[0].body.format, "object");
  assert.equal(env.fetchCalls[1].body.format, "json");
});

test("network timeout is retried and reported as retryable", async () => {
  const env = createEnv();
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  for (let i = 0; i < 4; i++) env.respond(timeout);
  await assert.rejects(
    env.get("Http").json("https://api.anthropic.com/v1/messages", {}, { timeoutMs: 10, retries: 3, label: "Claude API" }),
    (err) => err.retryable === true && /no response/.test(err.message)
  );
  assert.equal(env.fetchCalls.length, 4);
});

test("connection test uses the configured model", async () => {
  const env = createEnv();
  env.respond(claudeToolResponse({ ok: true }));
  await env.get("Classifier").testBackend("claude", { apiKey: "k", apiUrl: "", model: "claude-sonnet-5-5" });
  assert.equal(env.fetchCalls[0].body.model, "claude-sonnet-5-5");
});
