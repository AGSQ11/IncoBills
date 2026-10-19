/**
 * IncoBills — i18n helpers (messages live in _locales/<lang>/messages.json).
 *
 * @license MIT
 */

/** Translate a message key. Falls back to the key itself. */
function t(key, substitutions) {
  const subs = substitutions === undefined ? undefined : [].concat(substitutions).map((s) => String(s ?? ""));
  try {
    return browser.i18n.getMessage(key, subs) || key;
  } catch {
    return key;
  }
}

/** Translate a stored message object { key, args } or plain string. */
function tMsg(message) {
  if (!message) return "";
  if (typeof message === "string") return message;
  return t(message.key, message.args);
}

const I18n = {
  /** Fill elements that carry data-i18n* attributes. */
  localizePage(root = document) {
    for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
    for (const el of root.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
    for (const el of root.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
    for (const el of root.querySelectorAll("[data-i18n-aria-label]")) el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel));
    try {
      document.documentElement.lang = browser.i18n.getUILanguage();
    } catch {
      /* ignore */
    }
  },
};
