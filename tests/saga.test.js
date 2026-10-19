"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createEnv, jsonResponse, ROOT } = require("./helpers/env");
const { makeZip } = require("./helpers/zip");

const UBL = fs.readFileSync(path.join(__dirname, "fixtures", "efactura-invoice.xml"), "utf8");
const PDF = new Uint8Array(fs.readFileSync(path.join(__dirname, "fixtures", "invoice-ro.pdf")));
const MY_COMPANY = { name: "Firma Mea SRL", cif: "RO18547290", regCom: "J08/1234/2020", city: "Brașov", county: "BV", country: "RO" };

/** An AI extraction result for a foreign reverse-charge invoice (OVH-like). */
function foreignInvoice(overrides = {}) {
  return {
    tipDocument: "factura",
    motiv: null,
    furnizorNume: "OVH SAS",
    furnizorCif: "FR22424761419",
    furnizorRegCom: null,
    furnizorAdresa: "2 rue Kellermann",
    furnizorLocalitate: "Roubaix",
    furnizorJudet: null,
    furnizorTara: "FR",
    furnizorBanca: null,
    furnizorIBAN: null,
    furnizorTelefon: null,
    furnizorMail: null,
    clientNume: "Firma Mea SRL",
    clientCif: "18547290",
    clientRegCom: null,
    clientAdresa: null,
    clientLocalitate: "Brașov",
    clientJudet: "BV",
    clientTara: "RO",
    clientBanca: null,
    clientIBAN: null,
    clientTelefon: null,
    clientMail: null,
    facturaNumar: "FR123456",
    facturaData: "2026-10-01",
    facturaScadenta: "2026-10-01",
    moneda: "EUR",
    totalFaraTVA: 100,
    totalTVA: 0,
    totalCuTVA: 100,
    taxareInversa: true,
    tvaIncasare: false,
    linii: [{ descriere: "Dedicated server", um: "luna", cantitate: 1, pret: 100, valoare: 100, procTVA: 0, tva: 0 }],
    ...overrides,
  };
}

async function setup({ backend = "claude", consent = true, anaf = false } = {}) {
  const env = createEnv();
  await env.browser.storage.local.set({ aiBackend: backend, claudeApiKey: "k", openaiApiKey: "k" });
  await env.get("SAGAExport").saveSettings({ cloudConsent: consent, anafLookup: anaf });
  await env.get("CompanyRegistry").add(MY_COMPANY);
  return env;
}

function pdfMessage(env, id = 1) {
  return env.addMessage(
    { id, subject: "Invoice FR123456", author: "OVH <billing@ovh.com>" },
    { body: "Your invoice", attachments: [{ name: "invoice.pdf", contentType: "application/pdf", partName: "1.2", size: PDF.length }], files: { "1.2": PDF } }
  );
}

test("e-Factura UBL: exact data incl. document-level discount and unit codes", async () => {
  const env = createEnv();
  const inv = env.get("EFactura").parseXml(UBL);
  assert.equal(inv.facturaNumar, "FCT0042");
  assert.equal(inv.furnizorCif, "RO14399840");
  assert.equal(inv.furnizorRegCom, "J40/372/2002");
  assert.equal(inv.furnizorJudet, "B");
  assert.equal(inv.furnizorIBAN, "RO49AAAA1B31007593840000");
  assert.equal(inv.clientCif, "RO18547290");
  assert.equal(inv.linii.length, 2);
  assert.equal(inv.linii[0].um, "buc");
  assert.equal(inv.linii[0].pret, 100);
  assert.equal(inv.linii[1].valoare, -10);
  assert.equal(inv.totalFaraTVA, 190);
  assert.equal(inv.totalTVA, 39.9);
  const v = env.get("InvoiceValidator").validate(inv, { direction: "intrari" });
  assert.equal(v.errors.length, 0, JSON.stringify(v.errors));
});

test("e-Factura CreditNote becomes negative amounts (storno)", async () => {
  const env = createEnv();
  const credit = UBL.replace(/<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"/, '<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"')
    .replace("</Invoice>", "</CreditNote>")
    .replace(/InvoiceLine>/g, "CreditNoteLine>")
    .replace(/InvoicedQuantity/g, "CreditedQuantity");
  const inv = env.get("EFactura").parseXml(credit);
  assert.equal(inv.totalFaraTVA, -190);
  assert.equal(inv.linii[0].cantitate, -2);
  assert.equal(inv.linii[0].valoare, -200);
});

test("SPV ZIP: invoice XML is read, signature XML ignored, SPV index kept", async () => {
  const env = createEnv();
  const zip = makeZip({ "4123456789.xml": UBL, "semnatura_4123456789.xml": "<Signature/>" });
  const results = await env.get("EFactura").parseAttachment({ name: "4987654321.zip", bytes: zip });
  assert.equal(results.length, 1);
  assert.equal(results[0].invoice.spvIndex, "4123456789");
});

test("pipeline: e-Factura attachment is queued without any AI call (keywords backend)", async () => {
  const env = await setup({ backend: "keywords" });
  const zip = makeZip({ "4123456789.xml": UBL, "semnatura_4123456789.xml": "<Signature/>" });
  const msg = env.addMessage(
    { id: 7, subject: "Factură FCT0042", author: "Facturare <facturare@exemplu.ro>" },
    { body: "Total de plată 229,90 lei", attachments: [{ name: "4987654321.zip", contentType: "application/zip", partName: "1.3", size: zip.length }, { name: "factura.pdf", contentType: "application/pdf", partName: "1.2", size: PDF.length }], files: { "1.3": zip, "1.2": PDF } }
  );
  await env.get("SAGAExport").processEmail(msg);
  const queue = env.store.sagaQueue;
  assert.equal(queue.length, 1);
  assert.equal(queue[0].source, "efactura");
  assert.equal(queue[0].direction, "intrari");
  assert.equal(queue[0].needsReview, false);
  assert.equal(env.fetchCalls.length, 0);
});

test("pipeline: foreign PDF invoice keeps FR VAT ID and 0% VAT (reverse charge)", async () => {
  const env = await setup();
  env.respond({ content: [{ type: "tool_use", name: "invoice_data", input: foreignInvoice() }] });
  const msg = pdfMessage(env);
  await env.get("SAGAExport").processEmail(msg);
  const call = env.fetchCalls[0];
  assert.equal(call.body.model, "claude-sonnet-5-5", "extraction model");
  assert.equal(call.body.messages[0].content[0].type, "document");
  const item = env.store.sagaQueue[0];
  assert.equal(item.data.furnizorCif, "FR22424761419");
  assert.equal(item.direction, "intrari", "client CIF 18547290 matches RO18547290");
  assert.equal(item.needsReview, false, JSON.stringify(item.validation));

  const company = await env.get("CompanyRegistry").getById(item.companyId);
  const { xml } = env.get("SAGAXMLGenerator").generate(item.data, company, item.direction);
  assert.match(xml, /<ProcTVA>0<\/ProcTVA>/);
  assert.match(xml, /<FurnizorCIF>FR22424761419<\/FurnizorCIF>/);
  assert.match(xml, /<FacturaTaxareInversa>Da<\/FacturaTaxareInversa>/);
  assert.match(xml, /<FacturaMoneda>EUR<\/FacturaMoneda>/);
});

test("pipeline: keywords backend → visible failed item, retry works after switching backend", async () => {
  const env = await setup({ backend: "keywords" });
  const msg = pdfMessage(env);
  await env.get("SAGAExport").processEmail(msg);
  let queue = env.store.sagaQueue;
  assert.equal(queue.length, 1);
  assert.equal(queue[0].status, "failed");
  assert.equal(queue[0].error.key, "errSagaNeedsAi");

  await env.browser.storage.local.set({ aiBackend: "claude" });
  env.respond({ content: [{ type: "tool_use", name: "invoice_data", input: foreignInvoice() }] });
  await env.get("SAGAExport").retry(queue[0].id);
  queue = env.store.sagaQueue;
  assert.equal(queue.length, 1);
  assert.equal(queue[0].status, "extracted");
});

test("pipeline: no cloud consent → no PDF upload", async () => {
  const env = await setup({ consent: false });
  await env.get("SAGAExport").processEmail(pdfMessage(env));
  assert.equal(env.fetchCalls.length, 0);
  assert.equal(env.store.sagaQueue[0].error.key, "errSagaNoConsent");
});

test("duplicates: same supplier + number + date from a second email is skipped", async () => {
  const env = await setup();
  env.respond({ content: [{ type: "tool_use", name: "invoice_data", input: foreignInvoice() }] });
  env.respond({ content: [{ type: "tool_use", name: "invoice_data", input: foreignInvoice({ furnizorCif: "fr 22424761419" }) }] });
  await env.get("SAGAExport").processEmail(pdfMessage(env, 1));
  await env.get("SAGAExport").processEmail(pdfMessage(env, 2));
  assert.equal(env.store.sagaQueue.length, 1);
});

test("unknown direction blocks export until review sets it", async () => {
  const env = await setup();
  env.respond({ content: [{ type: "tool_use", name: "invoice_data", input: foreignInvoice({ clientCif: "RO14399840", clientNume: "Other SRL" }) }] });
  await env.get("SAGAExport").processEmail(pdfMessage(env));
  const SAGA = env.get("SAGAExport");
  let item = env.store.sagaQueue[0];
  assert.equal(item.direction, "unknown");
  assert.equal(item.needsReview, true);
  const blocked = await SAGA.exportItems([item.id]);
  assert.equal(blocked[0].success, false);
  assert.equal(env.downloads.length, 0);

  const company = (await env.get("CompanyRegistry").getAll())[0];
  const result = await SAGA.updateItem(item.id, { data: { ...item.data, clientCif: "RO18547290" }, direction: "intrari", companyId: company.id }, { markReviewed: true });
  assert.equal(result.reviewed, true, JSON.stringify(result.validation));
  item = env.store.sagaQueue[0];
  assert.equal(item.status, "reviewed");

  const exported = await SAGA.exportAll();
  assert.equal(exported[0].success, true);
  assert.equal(env.downloads[0].filename, "SAGA-Import/F_RO18547290_FR123456_20261001.xml");
  assert.equal(env.downloads[0].conflictAction, "uniquify");
  assert.equal(env.store.sagaQueue[0].status, "exported");
});

test("validator: totals that do not add up need review", async () => {
  const env = createEnv();
  const v = env.get("InvoiceValidator").validate(
    { facturaNumar: "1", facturaData: "2026-10-01", furnizorNume: "X", furnizorCif: "RO14399840", totalFaraTVA: 200, totalTVA: 21, totalCuTVA: 121, linii: [{ valoare: 100, tva: 21, procTVA: 21, cantitate: 1, pret: 100 }] },
    { direction: "intrari" }
  );
  const keys = v.errors.map((e) => e.key);
  assert.ok(keys.includes("valSumMismatch"));
  assert.ok(keys.includes("valTotalMismatch"));
});

test("validator: misread Romanian CIF is an error", async () => {
  const env = createEnv();
  const v = env.get("InvoiceValidator").validate(
    { facturaNumar: "1", facturaData: "2026-10-01", furnizorNume: "X", furnizorCif: "RO14399841", totalFaraTVA: 100, totalTVA: 21, totalCuTVA: 121, linii: [{ valoare: 100, tva: 21, procTVA: 21 }] },
    { direction: "intrari" }
  );
  assert.ok(v.errors.some((e) => e.key === "valCifChecksum"));
});

test("XML: VAT rate fallback uses the invoice date; escaping drops control characters", async () => {
  const env = createEnv();
  const G = env.get("SAGAXMLGenerator");
  const company = { ...MY_COMPANY, capital: "200" };
  const base = { isInvoice: true, facturaNumar: "A&B<1>", furnizorNume: "Bad\u0001Name", furnizorCif: "RO14399840", totalFaraTVA: 100, totalTVA: null, totalCuTVA: null, linii: [{ descriere: "x", valoare: 100, cantitate: 1, pret: 100 }] };
  const before = G.generate({ ...base, facturaData: "2025-07-15" }, company, "intrari").xml;
  const after = G.generate({ ...base, facturaData: "2025-08-15" }, company, "intrari").xml;
  assert.match(before, /<ProcTVA>19<\/ProcTVA>/);
  assert.match(after, /<ProcTVA>21<\/ProcTVA>/);
  assert.match(after, /<FacturaNumar>A&amp;B&lt;1&gt;<\/FacturaNumar>/);
  assert.match(after, /<FurnizorNume>BadName<\/FurnizorNume>/);
  assert.throws(() => G.generate(base, company, "unknown"), /direction/);
});

test("company registry: CIF check digit, IBAN, duplicates with/without RO", async () => {
  const env = createEnv();
  const R = env.get("CompanyRegistry");
  await assert.rejects(R.add({ name: "X", cif: "RO12345678" }), /check digit/);
  await assert.rejects(R.add({ name: "X", cif: "RO14399840", iban: "RO00XXXX" }), /IBAN/);
  await R.add({ name: "X", cif: "RO14399840" });
  await assert.rejects(R.add({ name: "Y", cif: "14399840" }), /already exists/);
  const resolved = await R.resolve("RO 1439 9840", "FR22424761419");
  assert.equal(resolved.direction, "iesiri");
});

test("company save errors reach the options page as { success: false }", async () => {
  const env = createEnv();
  const result = await env.sendMessage({ type: "sagaAddCompany", data: { name: "", cif: "" } });
  assert.equal(result.success, false);
  assert.match(result.error, /required/);
});

test("export response shape: { success, results[] }", async () => {
  const env = await setup();
  const result = await env.sendMessage({ type: "sagaExportAll" });
  assert.equal(result.success, true);
  assert.ok(Array.isArray(result.results));
});

test("clear queue keeps exported items (as the confirmation says)", async () => {
  const env = await setup();
  await env.browser.storage.local.set({
    sagaQueue: [
      { id: "a", status: "exported", exportedAt: "2026-10-01T00:00:00Z" },
      { id: "b", status: "extracted" },
      { id: "c", status: "failed" },
    ],
  });
  await env.get("SAGAExport").clearQueue();
  assert.equal(JSON.stringify(env.store.sagaQueue.map((q) => q.id)), '["a"]');
});

test("SAGA settings: saving keeps other keys and sanitizes the folder", async () => {
  const env = createEnv();
  const S = env.get("SAGAExport");
  await S.saveSettings({ exportSubdirectory: "../../etc/SAGA" });
  await S.saveSettings({ cloudConsent: true });
  const settings = await S.getSettings();
  assert.equal(settings.exportSubdirectory, "etc/SAGA");
  assert.equal(settings.cloudConsent, true);
});

test("ANAF: fills partner data, sets RO by VAT status, flags VAT on collection and inactive", async () => {
  const env = await setup({ anaf: true });
  env.respond({ content: [{ type: "tool_use", name: "invoice_data", input: foreignInvoice({ furnizorCif: "14399840", furnizorNume: "", furnizorTara: "", taxareInversa: false, moneda: "RON", totalTVA: 21, totalCuTVA: 121, linii: [{ descriere: "x", um: "buc", cantitate: 1, pret: 100, valoare: 100, procTVA: 21, tva: 21 }] }) }] });
  env.respond((url, init) => {
    assert.equal(url, "https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva");
    assert.equal(JSON.parse(init.body)[0].cui, 14399840);
    return jsonResponse({
      found: [
        {
          date_generale: { cui: 14399840, denumire: "EXEMPLU FURNIZOR SRL", nrRegCom: "J40/372/2002", telefon: "0210000000", adresa: "MUN. BUCUREŞTI" },
          inregistrare_scop_Tva: { scpTVA: true },
          inregistrare_RTVAI: { statusTvaIncasare: true },
          stare_inactiv: { statusInactivi: true },
          adresa_sediu_social: { sdenumire_Strada: "Şos. Virtuţii", snumar_Strada: "148", sdenumire_Localitate: "Mun. Bucureşti", scod_JudetAuto: "B" },
        },
      ],
      notFound: [],
    });
  });
  await env.get("SAGAExport").processEmail(pdfMessage(env));
  const item = env.store.sagaQueue[0];
  assert.equal(item.data.furnizorNume, "EXEMPLU FURNIZOR SRL");
  assert.equal(item.data.furnizorCif, "RO14399840");
  assert.equal(item.data.furnizorJudet, "B");
  assert.equal(item.data.tvaIncasare, true);
  assert.ok(item.validation.warnings.some((w) => w.key === "valPartnerInactive"));
});

test("pdf.js (vendored) reads compressed PDFs with Romanian diacritics", async () => {
  const env = createEnv();
  const lib = await import(path.join(ROOT, "node_modules/pdfjs-dist/legacy/build/pdf.mjs"));
  const extractor = env.get("PDFExtractor");
  extractor._pdfjs = lib;
  const text = await extractor.extractText(PDF);
  assert.match(text, /FACTURĂ FISCALĂ/);
  assert.match(text, /Total de plată: 121,00 lei/);
  assert.match(text, /RO14399840/);
});

test("Ollama extraction sends extracted text, not the PDF", async () => {
  const env = await setup({ backend: "ollama" });
  const lib = await import(path.join(ROOT, "node_modules/pdfjs-dist/legacy/build/pdf.mjs"));
  env.get("PDFExtractor")._pdfjs = lib;
  env.respond({ message: { content: JSON.stringify(foreignInvoice()) } });
  await env.get("SAGAExport").processEmail(pdfMessage(env));
  const prompt = env.fetchCalls[0].body.messages[1].content;
  assert.match(prompt, /<document>[\s\S]*FACTURĂ FISCALĂ/);
  assert.equal(env.store.sagaQueue[0].status, "extracted");
});

test("vendored pdf.js files are unmodified copies of pdfjs-dist", () => {
  for (const file of ["pdf.min.mjs", "pdf.worker.min.mjs"]) {
    const vendored = fs.readFileSync(path.join(ROOT, "vendor/pdfjs", file));
    const upstream = fs.readFileSync(path.join(ROOT, "node_modules/pdfjs-dist/legacy/build", file));
    assert.ok(vendored.equals(upstream), `${file} differs from pdfjs-dist`);
  }
});

// ---- Regression tests for the independent review ----

test("AI-read PDF invoice is not exportable until a person reviews it", async () => {
  const env = await setup();
  env.respond({ content: [{ type: "tool_use", name: "invoice_data", input: foreignInvoice() }] });
  await env.get("SAGAExport").processEmail(pdfMessage(env));
  const SAGA = env.get("SAGAExport");
  const item = env.store.sagaQueue[0];
  assert.equal(item.needsReview, false);
  assert.equal(SAGA.isExportable(item), false);
  assert.equal((await SAGA.exportAll()).length, 0);
  await SAGA.updateItem(item.id, {}, { markReviewed: true });
  assert.equal(SAGA.isExportable(env.store.sagaQueue[0]), true);
});

test("e-Factura invoice without errors is exportable at once", async () => {
  const env = await setup({ backend: "keywords" });
  await env.get("SAGAExport").ingest(env.get("EFactura").parseXml(UBL), { headerMessageId: "m@x" });
  assert.equal(env.get("SAGAExport").isExportable(env.store.sagaQueue[0]), true);
});

test("review: wrong direction for the company is an error (no own company on both sides)", async () => {
  const env = await setup();
  env.respond({ content: [{ type: "tool_use", name: "invoice_data", input: foreignInvoice() }] });
  await env.get("SAGAExport").processEmail(pdfMessage(env));
  const item = env.store.sagaQueue[0];
  const result = await env.get("SAGAExport").updateItem(item.id, { data: item.data, direction: "iesiri", companyId: item.companyId }, { markReviewed: true });
  assert.equal(result.reviewed, false);
  assert.ok(result.validation.errors.some((e) => e.key === "valDirectionMismatch"));
});

test("review: fixing the client CIF resolves an unknown direction", async () => {
  const env = await setup();
  env.respond({ content: [{ type: "tool_use", name: "invoice_data", input: foreignInvoice({ clientCif: "RO14399840" }) }] });
  await env.get("SAGAExport").processEmail(pdfMessage(env));
  const item = env.store.sagaQueue[0];
  assert.equal(item.direction, "unknown");
  const result = await env.get("SAGAExport").updateItem(item.id, { data: { ...item.data, clientCif: "RO 18547290" }, direction: undefined, companyId: null }, { markReviewed: true });
  assert.equal(result.item.direction, "intrari");
  assert.equal(result.reviewed, true, JSON.stringify(result.validation.errors));
});

test("double export click downloads the invoice once", async () => {
  const env = await setup({ backend: "keywords" });
  await env.get("SAGAExport").ingest(env.get("EFactura").parseXml(UBL), { headerMessageId: "m@x" });
  const SAGA = env.get("SAGAExport");
  const [a, b] = await Promise.all([SAGA.exportAll(), SAGA.exportItems([env.store.sagaQueue[0].id])]);
  assert.equal(env.downloads.length, 1);
  assert.equal([...a, ...b].filter((r) => r.success).length, 1);
});

test("interrupted download puts the invoice back in the queue", async () => {
  const env = await setup({ backend: "keywords" });
  await env.get("SAGAExport").ingest(env.get("EFactura").parseXml(UBL), { headerMessageId: "m@x" });
  const [result] = await env.get("SAGAExport").exportAll();
  assert.equal(env.store.sagaQueue[0].status, "exported");
  for (const listener of env.listeners.downloadsChanged) listener({ id: result.downloadId, state: { current: "interrupted" } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(env.store.sagaQueue[0].status, "extracted");
  assert.equal(env.store.sagaQueue[0].error, "The download was interrupted. Export the invoice again.");
});

test("pending job survives a restart: marker saved, resumed by Message-ID", async () => {
  const env = await setup();
  const msg = pdfMessage(env);
  // Simulate a marker left by a job that was running when Thunderbird closed.
  await env.get("SAGAExport").addPending(env.get("EmailMonitor").messageMeta(msg));
  assert.equal(env.store.sagaQueue[0].status, "pending");
  env.respond({ content: [{ type: "tool_use", name: "invoice_data", input: foreignInvoice() }] });
  await env.get("SAGAExport").resumePending();
  await env.get("SAGAExport")._jobs;
  const statuses = env.store.sagaQueue.map((q) => q.status);
  assert.equal(JSON.stringify(statuses), '["extracted"]');
});

test("enqueue keeps a pending marker until the job ends", async () => {
  const env = await setup();
  const msg = pdfMessage(env);
  let release;
  env.respond(() => new Promise((resolve) => (release = () => resolve(jsonResponse({ content: [{ type: "tool_use", name: "invoice_data", input: foreignInvoice() }] })))));
  const SAGA = env.get("SAGAExport");
  const attachments = await SAGA.collectAttachments(msg);
  const job = SAGA.enqueue(env.get("EmailMonitor").messageMeta(msg), attachments);
  while (!release) await new Promise((r) => setTimeout(r, 5));
  assert.ok(env.store.sagaQueue.some((q) => q.status === "pending"));
  release();
  await job;
  await SAGA._jobs;
  assert.equal(JSON.stringify(env.store.sagaQueue.map((q) => q.status)), '["extracted"]');
});

test("remote Ollama needs consent too; local Ollama does not", async () => {
  const env = createEnv();
  const LLM = env.get("LLM");
  assert.equal(LLM.isRemote({ backend: "ollama", baseUrl: "http://127.0.0.1:11434" }), false);
  assert.equal(LLM.isRemote({ backend: "ollama", baseUrl: "http://[::1]:11434" }), false);
  assert.equal(LLM.isRemote({ backend: "ollama", baseUrl: "http://192.168.1.20:11434" }), true);
  assert.equal(LLM.isRemote({ backend: "claude", baseUrl: "https://api.anthropic.com" }), true);
});

test("Ollama extraction sets a large context window", async () => {
  const env = await setup({ backend: "ollama" });
  const lib = await import(path.join(ROOT, "node_modules/pdfjs-dist/legacy/build/pdf.mjs"));
  env.get("PDFExtractor")._pdfjs = lib;
  env.respond({ message: { content: JSON.stringify(foreignInvoice()) } });
  await env.get("SAGAExport").processEmail(pdfMessage(env));
  assert.equal(env.fetchCalls[0].body.options.num_ctx, 16384);
});

test("e-Factura unit price keeps 4 decimals (kWh prices)", async () => {
  const env = createEnv();
  const xml = UBL.replace("<cbc:PriceAmount currencyID=\"RON\">100.00</cbc:PriceAmount>", "<cbc:PriceAmount currencyID=\"RON\">0.7859</cbc:PriceAmount>");
  const inv = env.get("EFactura").parseXml(xml);
  assert.equal(inv.linii[0].pret, 0.7859);
  const company = { name: "Firma Mea SRL", cif: "RO18547290" };
  assert.match(env.get("SAGAXMLGenerator").generate(inv, company, "intrari").xml, /<Pret>0\.7859<\/Pret>/);
});

test("ZIP attachment without .zip name is read by content type", async () => {
  const env = createEnv();
  const zip = makeZip({ "4123456789.xml": UBL });
  const results = await env.get("EFactura").parseAttachment({ name: "download", contentType: "application/zip", kind: "zip", bytes: zip });
  assert.equal(results.length, 1);
});
