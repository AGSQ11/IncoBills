/**
 * IncoBills — HTTP helper with timeout and retry.
 *
 * @license MIT
 */

class HttpError extends Error {
  constructor(message, { status = 0, retryable = false, body = "" } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.retryable = retryable;
    this.body = body;
  }
}

const Http = {
  RETRY_STATUS: [408, 409, 425, 429, 500, 502, 503, 504, 529],

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  /** Delay before the next attempt: Retry-After if present, else exponential + jitter. */
  backoffMs(attempt, response) {
    const header = response && response.headers && response.headers.get ? response.headers.get("retry-after") : null;
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds)) return Math.min(30000, Math.max(0, seconds * 1000));
      const date = Date.parse(header);
      if (Number.isFinite(date)) return Math.min(30000, Math.max(0, date - Date.now()));
    }
    return Math.min(20000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250);
  },

  /**
   * fetch() + JSON with a timeout for each attempt and retries on
   * network errors, timeouts and HTTP 408/409/425/429/5xx/529.
   */
  async json(url, init = {}, { timeoutMs = 30000, retries = 3, label = "HTTP" } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let response;
      try {
        response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        const timedOut = err && (err.name === "TimeoutError" || err.name === "AbortError");
        lastError = new HttpError(
          timedOut ? `${label}: no response after ${Math.round(timeoutMs / 1000)} s` : `${label}: network error (${err.message})`,
          { retryable: true }
        );
        if (attempt < retries) {
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        throw lastError;
      }

      if (response.ok) {
        try {
          return await response.json();
        } catch (err) {
          throw new HttpError(`${label}: invalid JSON response (${err.message})`, { status: response.status });
        }
      }

      const body = await response.text().catch(() => "");
      const retryable = this.RETRY_STATUS.includes(response.status);
      lastError = new HttpError(`${label} ${response.status}: ${body.slice(0, 300)}`, {
        status: response.status,
        retryable,
        body,
      });
      if (retryable && attempt < retries) {
        await this.sleep(this.backoffMs(attempt, response));
        continue;
      }
      throw lastError;
    }
    throw lastError;
  },
};
