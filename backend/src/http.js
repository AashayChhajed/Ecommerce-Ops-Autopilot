/**
 * HTTP layer utilities — shared by server.js routes.
 *
 * Phase 2 additions:
 *  - ApiError: single error type that maps to the standardized API error format
 *  - parseBody: hardened JSON body parsing (size limit, content-type check, clear 400s)
 *  - validateWith(schema, data): central Zod validation → 400 VALIDATION_ERROR
 *  - sendError: the only place raw error details are ever serialized
 */

import { ZodError } from 'zod';

// CORS origin is configured once here (moved from server.js send()).
const allowedOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:3000';

// ──────────────────────────────────────────────
// Standardized API error codes
// ──────────────────────────────────────────────
export const ErrorCodes = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  EXTERNAL_SERVICE_ERROR: 'EXTERNAL_SERVICE_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
};

const STATUS_BY_CODE = {
  [ErrorCodes.VALIDATION_ERROR]: 400,
  [ErrorCodes.UNAUTHORIZED]: 401,
  [ErrorCodes.FORBIDDEN]: 403,
  [ErrorCodes.NOT_FOUND]: 404,
  [ErrorCodes.CONFLICT]: 409,
  [ErrorCodes.RATE_LIMITED]: 429,
  [ErrorCodes.EXTERNAL_SERVICE_ERROR]: 502,
  [ErrorCodes.INTERNAL_ERROR]: 500,
};

/**
 * The one error type routes throw. `details` stays server-side (it is logged
 * but never serialized into the response).
 */
export class ApiError extends Error {
  /**
   * @param {string} code - one of ErrorCodes
   * @param {string} message - safe, human-readable message (no internals)
   * @param {object} [opts]
   * @param {number} [opts.status] - override the status mapped from code
   * @param {Array<{path:string, message:string}>} [opts.fields] - optional field-level validation info
   * @param {unknown} [opts.cause] - original error, logged server-side only
   */
  constructor(code, message, { status, fields, cause } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status ?? STATUS_BY_CODE[code] ?? 500;
    this.fields = fields;
    if (cause) this.cause = cause;
  }
}

// ──────────────────────────────────────────────
// Response helpers
// ──────────────────────────────────────────────
function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
  });
  res.end(JSON.stringify(body));
}

export function send(res, status, body) {
  json(res, status, body);
}

/**
 * Serialize an error into the standardized API error envelope.
 * Raw internals are NEVER exposed; they only go to server logs.
 */
export function sendError(res, error) {
  if (error instanceof ApiError) {
    if (error.status >= 500) {
      console.error('[API Error]', error.code, error.message, error.cause ?? '');
    }
    return send(res, error.status, {
      error: {
        code: error.code,
        message: error.message,
        ...(error.fields ? { fields: error.fields } : {}),
      },
    });
  }

  // Unexpected error — log everything server-side, expose nothing.
  console.error('[API Error] UNEXPECTED', error);
  const isDev = process.env.NODE_ENV !== 'production';
  return send(res, 500, {
    error: {
      code: ErrorCodes.INTERNAL_ERROR,
      message: isDev ? String(error?.message ?? 'Internal server error') : 'Internal server error',
    },
  });
}

// ──────────────────────────────────────────────
// Body parsing
// ──────────────────────────────────────────────
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 1 * 1024 * 1024); // 1 MiB

/**
 * Hardenened JSON body parser.
 * - rejects oversized bodies (413 → VALIDATION_ERROR-style payload)
 * - requires application/json content type when a body is present
 * - malformed / empty-but-required JSON → ApiError VALIDATION_ERROR 400
 * - never throws for empty bodies; returns {} (many routes take optional bodies)
 */
export function parseBody(req) {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers['content-type'] ?? '');
    const contentLengthHeader = req.headers['content-length'];
    // null when the header is absent (chunked encoding / unknown length)
    const contentLength = contentLengthHeader != null ? Number(contentLengthHeader) : null;

    // Explicit empty body (content-length: 0): resolve with an empty object.
    if (contentLength === 0) {
      resolve({});
      return;
    }

    if (contentType && !/application\/(json|.*\+json)/i.test(contentType)) {
      reject(new ApiError(ErrorCodes.VALIDATION_ERROR, 'Content-Type must be application/json'));
      return;
    }

    if (contentLength != null && contentLength > MAX_BODY_BYTES) {
      reject(new ApiError(ErrorCodes.VALIDATION_ERROR, `Request body too large (max ${Math.round(MAX_BODY_BYTES / 1024)} KB)`));
      return;
    }

    let raw = '';
    let received = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        aborted = true;
        reject(new ApiError(ErrorCodes.VALIDATION_ERROR, `Request body too large (max ${Math.round(MAX_BODY_BYTES / 1024)} KB)`));
        try { req.destroy(); } catch { /* socket already gone */ }
        return;
      }
      raw += chunk;
    });
    // No content-length AND no body arrived: end-of-stream means empty body → {}.
    // (Chunked encodings and unknown lengths are handled by accumulating chunks.)
    req.on('end', () => {
      if (aborted) return;
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        // Unexpected JSON types (arrays, scalars) are legal JSON but almost
        // always a client bug — the Zod object schemas will reject them, but
        // we fail fast here with a clear message.
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new ApiError(ErrorCodes.VALIDATION_ERROR, 'Request body must be a JSON object'));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new ApiError(ErrorCodes.VALIDATION_ERROR, 'Malformed JSON body'));
      }
    });
    req.on('error', () => {
      if (aborted) return;
      aborted = true;
      reject(new ApiError(ErrorCodes.VALIDATION_ERROR, 'Could not read request body'));
    });
  });
}

// ──────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────
/**
 * Validate `data` against a Zod schema.
 * Throws ApiError(VALIDATION_ERROR, 400) with safe field-level messages on failure.
 * Raw Zod internals are never returned to clients.
 *
 * @template T
 * @param {import('zod').ZodType<T>} schema
 * @param {unknown} data
 * @returns {T}
 */
export function validateWith(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    }));
    throw new ApiError(ErrorCodes.VALIDATION_ERROR, 'Request validation failed', { fields });
  }
  return result.data;
}

/** Extract pagination params from a URL with safe defaults + clamping. */
export function paginationFromUrl(url) {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
  const rawLimit = Number(url.searchParams.get('limit') ?? 20) || 20;
  const limit = Math.min(100, Math.max(1, rawLimit));
  return { page, limit, offset: (page - 1) * limit };
}

/** Build the standard pagination metadata block for list responses. */
export function paginationMeta(page, limit, total) {
  return {
    page,
    limit,
    total: Number(total),
    totalPages: Math.max(1, Math.ceil(Number(total) / limit)),
  };
}
