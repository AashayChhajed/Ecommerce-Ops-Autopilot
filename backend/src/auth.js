/**
 * Lightweight API-key authentication middleware.
 *
 * - The key is configured via AUTOPILOT_API_KEY (never hardcoded, never logged,
 *   never returned in responses).
 * - Comparison uses crypto.timingSafeEqual to avoid leaking the key through
 *   response-time side channels.
 * - When AUTOPILOT_API_KEY is not set, protection is disabled and a one-time
 *   warning is printed — this keeps local dev / existing test suites working
 *   without changing their bootstrap flow.
 * - Tests can inject a key with configureApiKey() / resetApiKeyState().
 */

import { timingSafeEqual } from 'node:crypto';
import { ApiError, ErrorCodes } from './http.js';

let configuredKey = process.env.AUTOPILOT_API_KEY || null;
let warnedDisabled = false;

/** Precompute buffers so the hot path only does timingSafeEqual. */
let keyBuffer = configuredKey ? Buffer.from(configuredKey, 'utf8') : null;

/**
 * Re-read the key from the environment (used by tests after they set env vars).
 * Also resets the one-time warning so each suite sees accurate behavior.
 */
export function configureApiKey() {
  configuredKey = process.env.AUTOPILOT_API_KEY || null;
  keyBuffer = configuredKey ? Buffer.from(configuredKey, 'utf8') : null;
  warnedDisabled = false;
}

/** Reset auth state entirely (test teardown). */
export function resetApiKeyState() {
  configuredKey = null;
  keyBuffer = null;
  warnedDisabled = false;
}

/** True when auth is active (a key is configured). Exposed for tests/docs. */
export function authEnabled() {
  return Boolean(keyBuffer);
}

/**
 * Timing-safe string comparison. Pads both inputs to the same length so the
 * buffer lengths themselves don't leak how much of the key matched.
 * @param {string} a
 * @param {string} b
 */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  // Compare against fixed-length buffers derived from both inputs.
  const maxLen = Math.max(bufA.length, bufB.length, 1);
  const padA = Buffer.alloc(maxLen);
  const padB = Buffer.alloc(maxLen);
  bufA.copy(padA, 0, 0, Math.min(bufA.length, maxLen));
  bufB.copy(padB, 0, 0, Math.min(bufB.length, maxLen));
  const lengthMatches = bufA.length === bufB.length;
  return timingSafeEqual(padA, padB) && lengthMatches;
}

/**
 * Express-style guard for raw http.createServer routing.
 * Throws ApiError(UNAUTHORIZED, 401) when the request fails authentication.
 *
 * @param {import('node:http').IncomingMessage} req
 */
export function requireApiKey(req) {
  if (!keyBuffer) {
    // FAIL CLOSED in production: a missing key is a deployment misconfiguration,
    // never a reason to serve an unprotected request. (start() also refuses to
    // boot in this state — this is defense in depth.)
    if (process.env.NODE_ENV === 'production') {
      throw new ApiError(
        ErrorCodes.INTERNAL_ERROR,
        'API authentication is not configured on this server'
      );
    }
    if (!warnedDisabled) {
      warnedDisabled = true;
      console.warn(
        '[Auth] AUTOPILOT_API_KEY is not configured — API authentication is DISABLED. ' +
        'Set AUTOPILOT_API_KEY in production to protect mutation/admin endpoints.'
      );
    }
    return; // dev/test convenience: open access when no key is configured
  }

  const provided = req.headers['x-api-key'];
  if (typeof provided !== 'string' || provided.length === 0) {
    throw new ApiError(ErrorCodes.UNAUTHORIZED, 'Missing API key');
  }

  // Constant-time compare regardless of input length/content.
  const providedBuffer = Buffer.from(provided, 'utf8');
  const padLen = Math.max(keyBuffer.length, providedBuffer.length, 1);
  const paddedConfigured = Buffer.alloc(padLen);
  const paddedProvided = Buffer.alloc(padLen);
  keyBuffer.copy(paddedConfigured, 0, 0, Math.min(keyBuffer.length, padLen));
  providedBuffer.copy(paddedProvided, 0, 0, Math.min(providedBuffer.length, padLen));
  const equal = timingSafeEqual(paddedConfigured, paddedProvided) && providedBuffer.length === keyBuffer.length;

  if (!equal) {
    throw new ApiError(ErrorCodes.UNAUTHORIZED, 'Invalid API key');
  }
}

/**
 * Startup guard: refuse to boot an unprotected API in production.
 * Called by server.js start() BEFORE any traffic is accepted.
 *
 * Local development (NODE_ENV !== 'production') may run without a key — the
 * documented dev behavior — but production must never deploy open.
 *
 * @throws {Error} when NODE_ENV=production and no AUTOPILOT_API_KEY is set.
 *   The error message never contains key material (there is none to leak).
 */
export function assertProductionAuth() {
  if (process.env.NODE_ENV === 'production' && !keyBuffer) {
    throw new Error(
      '[Auth] AUTOPILOT_API_KEY is not configured. Refusing to start with '
      + 'NODE_ENV=production — production must not run with an unprotected API. '
      + 'Set AUTOPILOT_API_KEY in the environment (see render.yaml / backend/.env.example).'
    );
  }
}

/**
 * Endpoint classification — the single source of truth for what is protected.
 *
 * PUBLIC (explicit allowlist — read-only, non-mutating, non-sensitive):
 *   GET  /health, GET /actuator/health      — health/readiness probes
 *        (also Render's healthCheckPath; must answer without a key)
 *   GET  /api/products, /api/orders, /api/inventory, /api/inventory/unified,
 *        /api/inventory/safety-buffer, /api/activity-logs,
 *        /api/descriptions, /api/descriptions/pending,
 *        /api/descriptions/settings, /api/descriptions/metrics
 *        — read-only dashboard data
 *   GET  /api/shopify/products, /api/shopify/orders, /api/shopify/inventory
 *        — aliases of the primary read endpoints above; classified
 *          identically to /api/products, /api/orders, /api/inventory
 *   GET  /api/products/:id, /api/products/:id/description, /api/orders/:id,
 *        /api/mock-channels/:channel/inventory — read-only detail views
 *   POST /api/orders/check                 — non-mutating availability lookup
 *   POST /api/webhooks/shopify             — Shopify webhooks, authenticated by
 *        Shopify HMAC over the raw body (NOT X-API-Key); the receiver fails
 *        closed on a missing/invalid signature or an unconfigured secret
 *
 * PROTECTED (everything else — every mutation, admin action, and the
 * operationally/sensitive reads):
 *   Shopify sync, order intake/release/fulfill/notify, inventory operations,
 *   AI generation, description approval/update/publish, settings changes,
 *   channel operations, email testing,
 *   GET /api/kpis (business metrics incl. revenue),
 *   GET /api/scheduler/status + /api/scheduler/runs (job state and internal
 *     error messages).
 */

// Non-mutating read endpoints that stay open (exact method+path matches).
// Decisions (Phase 2 final):
//  - /api/kpis and /api/scheduler/* are PROTECTED: they expose business
//    metrics and internal job error details (operational data). The frontend
//    reaches them through the proxy, which attaches the API key server-side.
//  - /api/shopify/* GET aliases are PUBLIC, consistently with their primary
//    equivalents (/api/products, /api/orders, /api/inventory) — same data,
//    same classification.
const PUBLIC_GET_PATHS = new Set([
  '/health',
  '/actuator/health',
  '/api/products',
  '/api/shopify/products',
  '/api/orders',
  '/api/shopify/orders',
  '/api/inventory',
  '/api/shopify/inventory',
  '/api/inventory/unified',
  '/api/inventory/safety-buffer',
  '/api/activity-logs',
  '/api/descriptions',
  '/api/descriptions/pending',
  '/api/descriptions/settings',
  '/api/descriptions/metrics',
]);

// Regex allowlist for public GET routes with dynamic segments.
const PUBLIC_GET_PATTERNS = [
  /^\/api\/products\/\d+$/,
  /^\/api\/products\/\d+\/description$/,
  /^\/api\/orders\/\d+$/,
  /^\/api\/mock-channels\/(amazon_mock|myntra_mock|flipkart_mock)\/inventory$/i,
];

// Non-mutating POST endpoint that stays open.
const PUBLIC_POST_PATHS = new Set(['/api/orders/check']);

// Shopify webhooks are deliberately OUTSIDE the X-API-Key scheme: Shopify
// authenticates them with its own HMAC signature (verified by the webhook
// receiver against the raw body). The receiver still FAILS CLOSED when the
// signature is missing/invalid or SHOPIFY_WEBHOOK_SECRET is unset, so this is
// not an unauthenticated endpoint — just a different authentication mechanism.
// X-API-Key is never accepted as a substitute for the HMAC.
const SHOPIFY_WEBHOOK_PATH = '/api/webhooks/shopify';

/**
 * Decide whether a request needs authentication. Exported for tests and docs.
 * @param {string} method
 * @param {string} path
 */
export function isProtected(method, path) {
  if (method === 'GET') {
    if (PUBLIC_GET_PATHS.has(path)) return false;
    if (PUBLIC_GET_PATTERNS.some((re) => re.test(path))) return false;
    return true;
  }
  if (method === 'POST' && PUBLIC_POST_PATHS.has(path)) return false;
  if (method === 'POST' && path === SHOPIFY_WEBHOOK_PATH) return false;
  return true;
}

/**
 * Combined guard used by the router: classify first, then verify the key.
 * @param {import('node:http').IncomingMessage} req
 * @param {string} method
 * @param {string} path
 */
export function authenticate(req, method, path) {
  if (!isProtected(method, path)) return;
  requireApiKey(req);
}
