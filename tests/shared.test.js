"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createEnv } = require("./helpers/env");

const env = createEnv();
const Text = env.get("Text");
const Fiscal = env.get("Fiscal");

test("normalize removes Romanian diacritics (comma and cedilla forms)", () => {
  assert.equal(Text.normalize("Factură Fiscală"), "factura fiscala");
  assert.equal(Text.normalize("Șoseaua Ţării ș ş ț ţ Î Â"), "soseaua tarii s s t t i a");
});

test("fillTemplate inserts values literally ($& and {{x}} are not expanded)", () => {
  const out = Text.fillTemplate("A {{subject}} B {{body}}", { subject: "Total: $' due $& {{body}}", body: "X" });
  assert.equal(out, "A Total: $' due $& {{body}} B X");
});

test("stripHtml decodes numeric entities (Romanian HTML mail)", () => {
  assert.equal(Text.stripHtml("<p>Factur&#259; nr. 5</p><style>p{}</style>&#x219;i &amp; &nbsp;x"), "Factură nr. 5\nși & x");
});

test("parseAddress uses the address, not the display name", () => {
  const a = Text.parseAddress('"Billing Team" <noreply@shop.example.com>');
  assert.equal(a.email, "noreply@shop.example.com");
  assert.equal(a.local, "noreply");
  assert.equal(a.domain, "shop.example.com");
  assert.equal(a.name, "Billing Team");
});

test("local dates do not shift to UTC", () => {
  const start = Text.parseLocalDate("2026-10-01");
  const end = Text.parseLocalDate("2026-10-19", true);
  assert.equal(start.getDate(), 1);
  assert.equal(start.getHours(), 0);
  assert.equal(end.getDate(), 19);
  assert.equal(end.getHours(), 23);
  assert.equal(Text.localDateString(new Date(2026, 9, 1, 0, 30)), "2026-10-01");
});

test("parseAmount handles RO and EN number formats", () => {
  const cases = { "1.234,56": 1234.56, "1,234.56": 1234.56, "1234.56": 1234.56, "1 234,56 lei": 1234.56, "12,5": 12.5, "-1.234,56": -1234.56, "0,123": 0.123, "1.234.567": 1234567, "": null, abc: null };
  for (const [input, expected] of Object.entries(cases)) assert.equal(Text.parseAmount(input), expected, input);
  assert.equal(Text.parseAmount(42), 42);
});

test("isIsoDate rejects impossible dates", () => {
  assert.equal(Text.isIsoDate("2026-02-28"), true);
  assert.equal(Text.isIsoDate("2026-02-30"), false);
  assert.equal(Text.isIsoDate("15.10.2026"), false);
});

test("Romanian CIF: digits, RO prefix, check digit", () => {
  assert.equal(Fiscal.cifDigits("RO 1439 9840"), "14399840");
  assert.equal(Fiscal.cifDigits("FR12345678901"), null);
  assert.equal(Fiscal.isValidRomanianCif("RO14399840"), true);
  assert.equal(Fiscal.isValidRomanianCif("18547290"), true);
  assert.equal(Fiscal.isValidRomanianCif("12345678"), false);
  assert.equal(Fiscal.sameCompany("RO14399840", "14399840"), true);
  assert.equal(Fiscal.sameCompany("FR12345678901", "fr 12345678901"), true);
  assert.equal(Fiscal.sameCompany("RO14399840", "FR14399840"), false);
  assert.equal(Fiscal.formatRomanianCif("RO14399840", false), "14399840");
  assert.equal(Fiscal.formatRomanianCif("14399840", true), "RO14399840");
});

test("IBAN mod-97", () => {
  assert.equal(Fiscal.isValidIban("RO49 AAAA 1B31 0075 9384 0000"), true);
  assert.equal(Fiscal.isValidIban("RO49AAAA1B31007593840001"), false);
  assert.equal(Fiscal.isValidIban("not an iban"), false);
});

test("standard VAT rate follows the invoice date (21% since 2025-08-01)", () => {
  assert.equal(Fiscal.standardVatRate("2025-07-31"), 19);
  assert.equal(Fiscal.standardVatRate("2025-08-01"), 21);
  assert.equal(Fiscal.standardVatRate("2026-10-15"), 21);
  assert.equal(Fiscal.snapVatRate(20.96), 21);
  assert.equal(Fiscal.snapVatRate(0.2), 0);
});
