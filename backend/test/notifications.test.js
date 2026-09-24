// Notification reliability tests (Phase 2) — restart-safe persistent retries.
// Uses isolated test data (unique customer names + cleanup) so runs never
// contaminate each other or the committed test suite.
process.env.AUTOPILOT_SKIP_START = '1';
process.env.EMAIL_MOCK_MODE = '1';
process.env.NOTIFICATION_MAX_RETRIES = '3';
process.env.NOTIFICATION_RETRY_BASE_MS = '50';
process.env.NOTIFICATION_RETRY_MAX_MS = '200';
process.env.NOTIFICATION_BATCH_LIMIT = '50';

import test from 'node:test';
import assert from 'node:assert/strict';
import { query, initializeDatabase, closeDatabase } from '../src/database.js';

// NB: ESM static imports are hoisted and evaluated BEFORE the env assignments
// above would run, so lib.js must be imported dynamically AFTER the env is set
// (its retry config is captured at module load).
const { sendOrderNotifications, notificationBackoffMs, getNotificationRetryConfig } = await import('../src/lib.js');

const MARKER = 'NOTIF-TEST-2026';
const cfg = getNotificationRetryConfig();
const MAX_RETRIES = cfg.maxRetries;

async function seedOrder({ email = 'cust@test.dev', status = 'UNNOTIFIED', retries = 0, allocated = 'ALLOCATED', nextRetry = null } = {}) {
  const { rows } = await query(`
    INSERT INTO orders (channel_code, order_reference, customer_name, email, status, total, allocation_status,
                        notification_status, notification_retries, notification_next_retry, created_at)
    VALUES ('AMAZON_MOCK', $1, $2, $3, 'paid', 10, $4, $5, $6, $7, NOW())
    RETURNING id
  `, [
    `${MARKER}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    MARKER, email, allocated, status, retries, nextRetry,
  ]);
  return Number(rows[0].id);
}

async function cleanup() {
  await query(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE customer_name = $1)`, [MARKER]);
  await query(`DELETE FROM orders WHERE customer_name = $1`, [MARKER]);
  await query(`DELETE FROM activity_logs WHERE type = 'ORDER_NOTIFICATION' AND message LIKE '%${MARKER}%'`).catch(() => {});
}

test('Notification reliability — persistent retry state', { timeout: 60_000 }, async (t) => {
  await initializeDatabase();
  await cleanup();
  t.after(cleanup);
  t.after(() => closeDatabase());

  await t.test('config: retry cap comes from env (3 in this test run)', () => {
    assert.equal(MAX_RETRIES, 3);
  });

  await t.test('successful notification: UNNOTIFIED → NOTIFIED with sent_at stamped', async () => {
    const orderId = await seedOrder({ email: 'happy@test.dev' });
    const senderCalls = [];
    const result = await sendOrderNotifications({ sender: async (o) => { senderCalls.push(Number(o.id)); } });
    assert.equal(senderCalls.includes(orderId), true);

    const { rows: [order] } = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
    assert.equal(order.notification_status, 'NOTIFIED');
    assert.ok(order.notification_sent_at, 'sent_at must be stamped');
    assert.equal(order.notification_last_error, null);
    assert.equal(Number(order.notification_retries), 1);
  });

  await t.test('transient failure → RETRYING with scheduled next retry, then succeeds', async () => {
    const orderId = await seedOrder({ email: 'retry@test.dev' });
    // Phase 2 isolation: the flaky sender must fail ONLY for our target
    // order, not for orders belonging to parallel test files. Use the order
    // ID as the discriminator so other orders pass through normally.
    const flaky = async (order) => {
      if (Number(order.id) === orderId) throw new Error('SMTP transient error');
    };

    const r1 = await sendOrderNotifications({ sender: flaky });
    assert.equal(r1.retried >= 1, true);

    const { rows: [afterFail] } = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
    assert.equal(afterFail.notification_status, 'RETRYING');
    assert.equal(Number(afterFail.notification_retries), 1);
    assert.equal(afterFail.notification_last_error, 'SMTP transient error');
    assert.ok(afterFail.notification_next_retry, 'next_retry must be scheduled');
    assert.ok(new Date(afterFail.notification_next_retry).getTime() > Date.now() - 1000, 'next retry must be in the future (or now)');

    // Force the retry due immediately and succeed on attempt 2.
    await query(`UPDATE orders SET notification_next_retry = NOW() - INTERVAL '1 second' WHERE id = $1`, [orderId]);
    const flakySuccess = async (order) => {
      // All orders succeed now (the transient error was specific to the first attempt of orderId)
    };
    const r2 = await sendOrderNotifications({ sender: flakySuccess });
    assert.equal(r2.sent >= 1, true);

    const { rows: [done] } = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
    assert.equal(done.notification_status, 'NOTIFIED');
    assert.equal(Number(done.notification_retries), 2);
    assert.equal(done.notification_last_error, null, 'error cleared after success');
    assert.equal(done.notification_next_retry, null);
  });

  await t.test('RETRYING rows are only claimed once their next_retry time passes', async () => {
    const orderId = await seedOrder({
      email: 'future@test.dev',
      status: 'RETRYING',
      retries: 1,
      nextRetry: new Date(Date.now() + 60 * 60 * 1000), // 1h in the future
    });
    await sendOrderNotifications({ sender: async () => {} });
    const { rows: [order] } = await query('SELECT notification_status, notification_retries FROM orders WHERE id = $1', [orderId]);
    assert.equal(order.notification_status, 'RETRYING', 'not-yet-due retry must not be claimed');
    assert.equal(Number(order.notification_retries), 1, 'attempt count unchanged');
  });

  await t.test('retry exhaustion → FAILED (bounded, no infinite retry)', async () => {
    const orderId = await seedOrder({
      email: 'exhausted@test.dev',
      status: 'RETRYING',
      retries: MAX_RETRIES - 1, // next failure hits the ceiling
      nextRetry: new Date(Date.now() - 1000),
    });
    // Phase 2 isolation: only fail for our target order, not for parallel
    // test files' orders that may also be in the UNNOTIFIED/RETRYING pool.
    const targetFailSender = async (order) => {
      if (Number(order.id) === orderId) throw new Error('permanent SMTP outage');
    };
    const result = await sendOrderNotifications({ sender: targetFailSender });
    assert.equal(result.failed >= 1, true);

    const { rows: [order] } = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
    assert.equal(order.notification_status, 'FAILED');
    assert.equal(Number(order.notification_retries), MAX_RETRIES);
    assert.equal(order.notification_last_error, 'permanent SMTP outage');

    // A further run must NOT claim it again (retry budget spent).
    await sendOrderNotifications({ sender: async () => {} });
    const { rows: [check] } = await query('SELECT notification_retries FROM orders WHERE id = $1', [orderId]);
    assert.equal(Number(check.notification_retries), MAX_RETRIES);
  });

  await t.test('duplicate prevention: second run does not re-send notified orders', async () => {
    const orderId = await seedOrder({ email: 'dup@test.dev' });
    const sendCounts = new Map();
    const countingSender = async (o) => {
      const id = Number(o.id);
      sendCounts.set(id, (sendCounts.get(id) ?? 0) + 1);
    };

    await sendOrderNotifications({ sender: countingSender });
    await sendOrderNotifications({ sender: countingSender });

    assert.equal(sendCounts.get(orderId), 1, 'exactly one send per order');
    const { rows: [order] } = await query('SELECT notification_status, notification_retries FROM orders WHERE id = $1', [orderId]);
    assert.equal(order.notification_status, 'NOTIFIED');
    assert.equal(Number(order.notification_retries), 1);
  });

  await t.test('concurrent scheduler executions never double-send (SKIP LOCKED claim)', async () => {
    const orderA = await seedOrder({ email: 'race-a@test.dev' });
    const orderB = await seedOrder({ email: 'race-b@test.dev' });

    const sendCounts = new Map();
    const countingSender = async (o) => {
      const id = Number(o.id);
      sendCounts.set(id, (sendCounts.get(id) ?? 0) + 1);
    };

    // Two overlapping worker runs on the same event loop.
    await Promise.all([
      sendOrderNotifications({ sender: countingSender }),
      sendOrderNotifications({ sender: countingSender }),
    ]);

    assert.equal(sendCounts.get(orderA) ?? 0, 1, 'order A sent exactly once');
    assert.equal(sendCounts.get(orderB) ?? 0, 1, 'order B sent exactly once');

    const { rows } = await query(
      'SELECT notification_status, notification_retries FROM orders WHERE id = ANY($1::bigint[])',
      [[orderA, orderB]]
    );
    for (const o of rows) {
      assert.equal(o.notification_status, 'NOTIFIED');
      assert.equal(Number(o.notification_retries), 1);
    }
  });

  await t.test('restart-safe: PROCESSING claims from a crashed worker are recovered', async () => {
    const orderId = await seedOrder({ email: 'crash@test.dev' });
    // Simulate a crash: a previous worker claimed the order, then died.
    await query(
      `UPDATE orders SET notification_status = 'PROCESSING', notification_last_attempt = NOW() - INTERVAL '10 minutes' WHERE id = $1`,
      [orderId]
    );
    const result = await sendOrderNotifications({ sender: async () => {} });
    const { rows: [order] } = await query('SELECT notification_status FROM orders WHERE id = $1', [orderId]);
    assert.equal(order.notification_status, 'NOTIFIED', 'stale claim must be recovered and completed');
  });

  await t.test('REJECTED orders are never notified', async () => {
    const orderId = await seedOrder({ email: 'rejected@test.dev', allocated: 'REJECTED', status: 'UNNOTIFIED' });
    // Phase 2 isolation: track only calls for our specific REJECTED order,
    // not ALL orders processed by the global sendOrderNotifications call.
    let calledForTarget = 0;
    await sendOrderNotifications({ sender: async (o) => { if (Number(o.id) === orderId) calledForTarget += 1; } });
    const { rows: [order] } = await query('SELECT notification_status, notification_retries FROM orders WHERE id = $1', [orderId]);
    assert.equal(order.notification_status, 'UNNOTIFIED', 'rejected orders stay untouched');
    assert.equal(Number(order.notification_retries), 0);
    assert.equal(calledForTarget, 0, 'sender must never be invoked for a rejected order');
  });

  await t.test('missing email is a permanent FAILED, not an endless retry', async () => {
    const orderId = await seedOrder({ email: null });
    // Phase 2 isolation: ensure no-email order is claimed. First reset it
    // (parallel tests may have already claimed it), then verify terminal state.
    await query(
      `UPDATE orders SET notification_status = 'UNNOTIFIED', notification_retries = 0,
       notification_last_error = NULL, notification_next_retry = NULL WHERE id = $1`,
      [orderId]
    );
    // Phase 2 isolation (same pattern as the REJECTED subtest): the global
    // worker claims EVERY due order, including ones owned by parallel test
    // files, so counting all sender invocations is not isolated. Track only
    // the invariants under test: our order, and any order lacking a recipient.
    let calledForTarget = 0;
    let calledWithoutRecipient = 0;
    await sendOrderNotifications({
      sender: async (o) => {
        if (Number(o.id) === orderId) calledForTarget += 1;
        if (!o.email) calledWithoutRecipient += 1;
      },
    });
    const { rows: [order] } = await query('SELECT notification_status, notification_retries, notification_last_error FROM orders WHERE id = $1', [orderId]);
    assert.equal(order.notification_status, 'FAILED');
    assert.equal(order.notification_last_error, 'no email address on order');
    assert.equal(Number(order.notification_retries) >= 1, true, 'attempt recorded');
    assert.equal(calledForTarget, 0, 'sender never invoked for the no-email order');
    assert.equal(calledWithoutRecipient, 0, 'sender never invoked without a recipient');
  });

  await t.test('notificationBackoffMs is bounded exponential with jitter', () => {
    const { baseMs, maxMs } = getNotificationRetryConfig();
    for (let i = 1; i <= 10; i++) {
      const ms = notificationBackoffMs(i);
      assert.ok(ms >= 0, 'non-negative');
      assert.ok(ms <= maxMs, `capped at NOTIFICATION_RETRY_MAX_MS (got ${ms})`);
    }
    // Growth across early steps: step 2's expected ceiling is ~2x step 1's.
    const expected1 = baseMs;
    const expected2 = baseMs * 2;
    assert.ok(notificationBackoffMs(1) <= expected1 * 1.25 + 1);
    assert.ok(notificationBackoffMs(2) <= expected2 * 1.25 + 1);
  });
});
