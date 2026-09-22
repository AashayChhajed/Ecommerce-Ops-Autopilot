// Unit tests for the Phase 2 HTTP layer: error envelope, body parsing, validation.
process.env.AUTOPILOT_SKIP_START = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, ErrorCodes, validateWith, paginationMeta, parseBody, sendError } from '../src/http.js';
import { z } from 'zod';

// ── Mock response object ─────────────────────────────────────────
function mockRes() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(payload) { this.body = payload ? JSON.parse(payload) : null; },
  };
}

function mockReq(chunks, headers = {}) {
  const dataListeners = [];
  const endListeners = [];
  const errorListeners = [];
  return {
    headers,
    on(event, cb) {
      if (event === 'data') dataListeners.push(cb);
      if (event === 'end') endListeners.push(cb);
      if (event === 'error') errorListeners.push(cb);
    },
    destroy() {},
    // test helpers to simulate the stream
    async emitData() {
      for (const c of chunks) for (const cb of dataListeners) cb(Buffer.from(c));
      for (const cb of endListeners) cb();
    },
    emitError(err) { for (const cb of errorListeners) cb(err); },
  };
}

test('ApiError maps codes to correct HTTP statuses', () => {
  assert.equal(new ApiError(ErrorCodes.VALIDATION_ERROR, 'x').status, 400);
  assert.equal(new ApiError(ErrorCodes.UNAUTHORIZED, 'x').status, 401);
  assert.equal(new ApiError(ErrorCodes.FORBIDDEN, 'x').status, 403);
  assert.equal(new ApiError(ErrorCodes.NOT_FOUND, 'x').status, 404);
  assert.equal(new ApiError(ErrorCodes.CONFLICT, 'x').status, 409);
  assert.equal(new ApiError(ErrorCodes.RATE_LIMITED, 'x').status, 429);
  assert.equal(new ApiError(ErrorCodes.EXTERNAL_SERVICE_ERROR, 'x').status, 502);
  assert.equal(new ApiError(ErrorCodes.INTERNAL_ERROR, 'x').status, 500);
  // explicit status override
  assert.equal(new ApiError(ErrorCodes.VALIDATION_ERROR, 'x', { status: 413 }).status, 413);
});

test('parseBody rejects malformed JSON with a 400 VALIDATION_ERROR', async () => {
  const req = mockReq(['{"broken": ']);
  const promise = parseBody(req);
  await req.emitData();
  await assert.rejects(promise, (err) => err instanceof ApiError
    && err.status === 400
    && err.code === ErrorCodes.VALIDATION_ERROR
    && err.message === 'Malformed JSON body');
});

test('parseBody rejects wrong Content-Type', async () => {
  const req = mockReq(['{"a":1}'], { 'content-type': 'text/plain', 'content-length': '7' });
  const promise = parseBody(req);
  await req.emitData();
  await assert.rejects(promise, (err) => err instanceof ApiError && err.code === ErrorCodes.VALIDATION_ERROR);
});

test('parseBody rejects non-object JSON (arrays and scalars)', async () => {
  for (const raw of ['[1,2,3]', '"just a string"', '42', 'null']) {
    const req = mockReq([raw], { 'content-type': 'application/json', 'content-length': String(raw.length) });
    const promise = parseBody(req);
    await req.emitData();
    await assert.rejects(promise, (err) => err instanceof ApiError
      && err.code === ErrorCodes.VALIDATION_ERROR
      && /must be a JSON object/.test(err.message),
      `raw=${raw}`);
  }
});

test('parseBody rejects oversized bodies', async () => {
  const big = JSON.stringify({ blob: 'x'.repeat(2 * 1024 * 1024) });
  const req = mockReq([big], { 'content-type': 'application/json', 'content-length': String(big.length) });
  const promise = parseBody(req);
  await req.emitData();
  await assert.rejects(promise, (err) => err instanceof ApiError && /too large/.test(err.message));
});

test('parseBody resolves {} for empty bodies', async () => {
  const req = mockReq([], {});
  const promise = parseBody(req);
  await req.emitData();
  assert.deepEqual(await promise, {});
});

test('parseBody accepts valid JSON objects', async () => {
  const raw = '{"channel":"SHOPIFY","items":[]}';
  const req = mockReq([raw], { 'content-type': 'application/json', 'content-length': String(raw.length) });
  const promise = parseBody(req);
  await req.emitData();
  assert.deepEqual(await promise, { channel: 'SHOPIFY', items: [] });
});

test('validateWith returns parsed data on success and safe field errors on failure', () => {
  const schema = z.object({ quantity: z.number().int().min(1) });
  assert.deepEqual(validateWith(schema, { quantity: 3 }), { quantity: 3 });

  try {
    validateWith(schema, { quantity: 'abc' });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 400);
    assert.equal(err.code, ErrorCodes.VALIDATION_ERROR);
    assert.equal(err.message, 'Request validation failed');
    assert.ok(Array.isArray(err.fields));
    assert.deepEqual(err.fields[0].path, 'quantity');
    // No Zod internals leaked
    assert.ok(!JSON.stringify(err.fields).includes('ZodError'));
  }
});

test('paginationMeta produces the documented shape', () => {
  assert.deepEqual(paginationMeta(1, 20, 150), { page: 1, limit: 20, total: 150, totalPages: 8 });
  assert.deepEqual(paginationMeta(3, 20, 0), { page: 3, limit: 20, total: 0, totalPages: 1 });
});

test('production masks unexpected error messages; ApiError stays standardized', () => {
  const prevNodeEnv = process.env.NODE_ENV;
  try {
    // ── Unexpected (non-ApiError) error in production → generic message only ──
    process.env.NODE_ENV = 'production';
    let res = mockRes();
    sendError(res, new Error('connection failed: postgres://user:secret@db internal'));
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error.code, ErrorCodes.INTERNAL_ERROR);
    assert.equal(res.body.error.message, 'Internal server error');
    assert.ok(!JSON.stringify(res.body).includes('secret'));
    assert.ok(!JSON.stringify(res.body).includes('stack'));

    // ── ApiError with a safe static message is still returned verbatim ──
    res = mockRes();
    sendError(res, new ApiError(ErrorCodes.NOT_FOUND, 'Product not found'));
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: { code: ErrorCodes.NOT_FOUND, message: 'Product not found' } });

    // ── Dev mode keeps the helpful message (documented behavior) ──
    process.env.NODE_ENV = 'development';
    res = mockRes();
    sendError(res, new Error('helpful dev detail'));
    assert.equal(res.body.error.message, 'helpful dev detail');
  } finally {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  }
});
