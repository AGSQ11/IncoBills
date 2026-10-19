# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-10-19

### Fixed
- **SAGA export did not run at all in 1.1.0**: a typo (`(a) =` instead of `(a) =>`) and a call to a missing `Storage.getSettings()` stopped the pipeline, and the error was hidden. The pipeline is rebuilt and covered by tests.
- SAGA with the default "Keywords only" backend failed silently. Now the queue shows a clear error with a **Retry** button.
- OpenAI PDF extraction sent the PDF as `image_url` (rejected by OpenAI). It now uses the `file` content part.
- A 0% VAT line (reverse charge, exempt) became 19% in the XML. Missing rates now come from the line, then from the standard rate for the invoice date (21% since 2025-08-01, 19% before).
- Foreign VAT IDs were changed to Romanian ones (`FR123…` → `RO123…`), and every CIF got an `RO` prefix. CIFs are now kept as printed; `RO12345678` and `12345678` match the same company.
- Invoices with an unknown direction were exported with the first company as client. They now need review before export.
- Duplicate detection used the email instead of the invoice. It now uses supplier CIF + invoice number + date.
- Popup and options showed an error after a successful export (wrong response shape).
- Adding/editing a company with an error closed the form and saved nothing, without a message.
- SAGA settings were never loaded into the form, so every "Save" reset them.
- "Clear queue" said exported invoices stay, but deleted them. Now they stay.
- Parallel writes (two folders receiving mail at once) lost history and queue entries. Writes are now serialized per key.
- A rescan in copy mode duplicated every copy again; scans also touched Sent, Drafts, Trash and Junk. These folders and the invoice folder are now skipped.
- Already-processed detection used the Thunderbird message id (it changes when a message moves) and the 500-entry history. It now uses the Message-ID header and a separate list.
- Scan dates were shifted by the UTC offset; mail received later today was not scanned.
- Two parallel requests could fail to create the monthly folder and drop mail into the root folder.
- Keyword matching: "Factură" did not match "factura"; "vat" matched "private", "bic" matched "public"; `noreply` counted as an invoice signal.
- Placeholders in the AI prompt: `$&` / `$'` in an email corrupted the prompt.
- Stats counted only moved emails (copy and notify-only modes showed 0); unchecking every account meant "monitor all".
- The batch notification always said "moved"; two invoices produced one single and one batch notification.
- The move fallback (copy + delete) always failed at delete (no permission) and left duplicates. Removed: `messages.move()` handles cross-account moves itself.
- An "Invoices" folder inside Trash/Junk (e.g. after the user deleted it) was reused, so new invoices went to Trash. Such folders are now ignored. The "inside Inbox" fallback works again (it used a property that Thunderbird 128 does not have).

### Added
- **e-Factura (UBL 2.1 / CIUS-RO)**: XML attachments and ANAF SPV ZIP files are read exactly, without AI. Document-level discounts, credit notes and unit codes are supported.
- **ANAF lookup** (public registry, only the CIF is sent): fills partner data, sets the correct `RO` prefix from VAT status, sets "TVA la încasare" for suppliers in RTVAI, and warns about inactive partners.
- **Review editor** for queued invoices: edit header, parties and lines, see validation results, then mark as reviewed. Data read by the AI from a PDF must be reviewed before export; e-Factura data without errors is ready at once. The chosen direction must match the company CIF on the invoice.
- SAGA jobs are saved as "pending" first and resume after a Thunderbird restart. Exports run one at a time (no duplicate XML on a double click); an interrupted download puts the invoice back in the queue.
- **Validation** before export: line sums, VAT sums, totals, CIF check digit, IBAN mod-97, dates, VAT rates.
- Local PDF text extraction with the bundled, unmodified **pdf.js** (Ollama backend). Scanned PDFs without text get a clear message.
- Separate **extraction model** setting per backend (default: a Sonnet-class model for Claude).
- **Hybrid mode** (default on): no AI call for emails with no invoice signal and for very clear invoices.
- **Right-click menu** "IncoBills: Mark as invoice / Not an invoice", with sender rules and undo of the move.
- **Backend health**: notification and banner when AI calls keep failing (instead of a silent keyword fallback).
- **Scan**: count and token estimate before start, live progress, cancel, "forget processed emails".
- Timeouts and retries with backoff for all AI and ANAF calls; structured output (Claude tool use, OpenAI `json_schema`, Ollama schema).
- English and Romanian UI (`_locales`).
- Tests (`npm test`), lint, CI and an automatic release workflow that builds the `.xpi`.

### Changed
- **Privacy**: SAGA sends full PDFs to Claude/OpenAI (or a remote Ollama) only after explicit consent. README updated.
- History entries from 1.0/1.1 are kept for display only: their Thunderbird message ids are valid for one session and could hide new mail. The first scan after the upgrade checks older emails again.
- **Permissions**: `<all_urls>` replaced by the fixed API hosts; a custom API URL asks for its host permission when you save. New `menus` permission.
- Local Folders fallback is now opt-in (it moves mail off the server).
- Default models: `claude-haiku-5-5` / `claude-sonnet-5-5`, `gpt-6-luna` (the old defaults are retired or deprecated). Saved old defaults are migrated.
- Ollama setup: use `OLLAMA_ORIGINS="moz-extension://*"`, not `"*"`.

## [1.1.0] - 2026-04-25

### Added
- **SAGA Export Module** (Romania-specific) — Extracts invoice data from PDF attachments and generates SAGA XML import files
  - Company Registry: Define your Romanian companies with full fiscal data (CIF, RegCom, address, bank, IBAN)
  - AI-powered PDF parsing via Claude 3.5 Sonnet, OpenAI GPT-4o, or local Ollama
  - Automatic direction detection (Intrări/Ieșiri) based on CIF matching
  - Invoice review queue with status tracking and manual export
  - XML generation conforming to SAGA import schema
  - Export to `Downloads/SAGA-Import/` via `browser.downloads` API
  - Dedicated SAGA tab in popup for quick access
  - Fully optional module — only activates when companies are configured
- New `downloads` permission for XML file export
- Design document: `docs/plans/2026-04-25-saga-export-design.md`

## [1.0.1] - 2026-04-25

### Fixed
- Resolved Thunderbird Add-on Validator security warnings by replacing all DOM `innerHTML` assignments with safe `createElement`/`textContent` construction in:
  - `popup/popup.js` — `createRecentItem()` and recent-list clearing
  - `options/options.js` — account list, history table rendering, and sort-button arrow updates
- Reduced validator warnings from 31 to 27 (remaining warnings are Thunderbird-specific MailExtension API permissions that are expected for Thunderbird-only add-ons)

## [1.0.0] - 2026-04-25

### Added
- Initial release of IncoBills
- AI-powered invoice detection using keyword, Claude, OpenAI, and Ollama backends
- Automatic email organization (move/copy/flag) across all Thunderbird accounts
- Per-account or unified folder modes
- Classification history with CSV export
- Manual scan of existing emails
- Options page for backend configuration, thresholds, and account selection
