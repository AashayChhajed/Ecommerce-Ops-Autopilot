/**
 * Resilient Shopify REST Admin API client.
 *
 * Phase 2 reliability features (Phase 1's SHOPIFY_FETCH_TIMEOUT_MS is kept):
 *  - Automatic pagination via Shopify's `page_info` Link-header cursor
 *  - 429 handling: honors Retry-After, else exponential backoff with jitter
 *  - Retries ONLY transient failures (429, 500/502/503/504, network, timeout)
 *  - Permanent 4xx errors fail fast — no blind retry
 *  - Sync-level cooldown (SHOPIFY_SYNC_BACKOFF_MS) is preserved in server.js
 *  - Per-record failures never abort the whole sync (partial failure support)
 *
 * Environment:
 *   SHOPIFY_FETCH_TIMEOUT_MS   request timeout (default 30000)
 *   SHOPIFY_MAX_RETRIES        attempts per request (default 3)
 *   SHOPIFY_MAX_PAGES          pagination safety cap (default 20)
 *   SHOPIFY_PAGE_LIMIT         page size (default 250, Shopify max)
 */

const SHOP_TIMEOUT_MS = Number(process.env.SHOPIFY_FETCH_TIMEOUT_MS ?? 30_000);
const SHOP_MAX_RETRIES = Math.max(1, Number(process.env.SHOPIFY_MAX_RETRIES ?? 3));
const SHOP_MAX_PAGES = Math.max(1, Number(process.env.SHOPIFY_MAX_PAGES ?? 20));
const SHOP_PAGE_LIMIT = Math.min(250, Math.max(1, Number(process.env.SHOPIFY_PAGE_LIMIT ?? 250)));

// Backoff: base 1000ms doubling per attempt with ±30% jitter, capped at 30s.
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt) {
  const exponential = BACKOFF_BASE_MS * 2 ** (attempt - 1);
  const jitter = exponential * 0.3 * (Math.random() * 2 - 1); // ±30%
  return Math.min(BACKOFF_MAX_MS, Math.max(0, Math.round(exponential + jitter)));
}

/**
 * Errors thrown by shopifyFetch — carries enough context for callers to log
 * safely (never includes tokens).
 */
export class ShopifyFetchError extends Error {
  constructor(message, { status = null, retryable = false, cause } = {}) {
    super(message);
    this.name = 'ShopifyFetchError';
    this.status = status;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Single Shopify request with timeout + selective retry.
 *
 * @param {string} url absolute Admin API URL
 * @param {string} token access token (never logged)
 * @returns {Promise<{body: object, linkHeader: string|null}>}
 */
async function requestWithRetry(url, token) {
  let lastError;

  for (let attempt = 1; attempt <= SHOP_MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SHOP_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: { 'X-Shopify-Access-Token': token },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const body = await response.json().catch(() => {
          throw new ShopifyFetchError('Shopify returned a non-JSON response', { status: response.status });
        });
        return { body, linkHeader: response.headers.get('link') };
      }

      const status = response.status;
      const errBody = await response.text().catch(() => '');

      // Retry only transient statuses; 4xx (auth, permission, malformed) fail fast.
      if (isRetryableStatus(status) && attempt < SHOP_MAX_RETRIES) {
        const retryAfterHeader = response.headers.get('retry-after');
        const retryAfterSec = retryAfterHeader != null ? Number(retryAfterHeader) : NaN;
        const delayMs = Number.isFinite(retryAfterSec) && retryAfterSec >= 0
          ? Math.min(BACKOFF_MAX_MS, Math.round(retryAfterSec * 1000))
          : backoffDelay(attempt);
        lastError = new ShopifyFetchError(`Shopify returned ${status}`, { status, retryable: true });
        await sleep(delayMs);
        continue;
      }

      throw new ShopifyFetchError(`Shopify returned ${status} ${response.statusText}`, {
        status,
        retryable: isRetryableStatus(status),
      });
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof ShopifyFetchError) throw error;

      // Timeouts and network failures are transient → retry.
      const isTimeout = error.name === 'AbortError' || controller.signal.aborted;
      lastError = isTimeout
        ? new ShopifyFetchError(`Shopify fetch timed out after ${SHOP_TIMEOUT_MS}ms`, { retryable: true, cause: error })
        : new ShopifyFetchError(`Shopify network failure: ${error.message}`, { retryable: true, cause: error });

      if (attempt < SHOP_MAX_RETRIES) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      // Retries exhausted on a network/timeout failure.
      throw new ShopifyFetchError(
        `Shopify fetch failed after ${SHOP_MAX_RETRIES} attempts: ${lastError.message}`,
        { retryable: true, cause: lastError }
      );
    }
  }

  // Unreachable: every loop iteration either returns, continues, or throws.
  throw new ShopifyFetchError(`Shopify fetch failed after ${SHOP_MAX_RETRIES} attempts`, { retryable: true });
}

/**
 * Parse Shopify's RFC-5988 Link header for the next page cursor.
 * Example: <https://shop/admin/api/2024-04/products.json?page_info=abc&limit=250>; rel="next"
 */
export function parseNextPageUrl(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/i);
    if (match) return match[1];
  }
  return null;
}

/**
 * Fetch ALL pages of a Shopify resource using the Link-header cursor.
 * Returns the accumulated records. Hard-capped at SHOPIFY_MAX_PAGES to
 * prevent runaway loops.
 *
 * @param {(path: string) => string} buildUrl — turns a path into an absolute URL
 * @param {string} basePath — e.g. '/products.json?limit=250&status=active'
 * @param {'products'|'orders'} resource — top-level collection key
 * @returns {Promise<Array<object>>}
 */
export async function shopifyFetchAllPages(buildUrl, basePath, resource) {
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!token) {
    throw new ShopifyFetchError('SHOPIFY_ACCESS_TOKEN is not configured');
  }

  const all = [];
  let nextUrl = buildUrl(basePath);
  let pages = 0;

  while (nextUrl) {
    pages += 1;
    if (pages > SHOP_MAX_PAGES) {
      throw new ShopifyFetchError(
        `Shopify pagination exceeded the safety cap of ${SHOP_MAX_PAGES} pages — aborting to avoid an infinite loop`
      );
    }

    const { body, linkHeader } = await requestWithRetry(nextUrl, token);
    const records = Array.isArray(body?.[resource]) ? body[resource] : [];
    all.push(...records);

    nextUrl = parseNextPageUrl(linkHeader);
  }

  return all;
}

/**
 * Backward-compatible single-request helper (kept for callers/tests that fetch
 * one page). Uses the same timeout + retry semantics.
 */
export async function shopifyFetch(path, buildUrl) {
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!token) {
    throw new ShopifyFetchError('SHOPIFY_ACCESS_TOKEN is not configured');
  }
  const { body } = await requestWithRetry(buildUrl ? buildUrl(path) : path, token);
  return body;
}

export function getShopifyConfig() {
  return {
    timeoutMs: SHOP_TIMEOUT_MS,
    maxRetries: SHOP_MAX_RETRIES,
    maxPages: SHOP_MAX_PAGES,
    pageLimit: SHOP_PAGE_LIMIT,
  };
}
