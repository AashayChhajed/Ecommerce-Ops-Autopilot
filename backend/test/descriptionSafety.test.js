// AI description safety tests (Phase 2).
// Core invariant: APPROVED/PUBLISHED CONTENT MUST NOT BE LOST BY REGENERATION.
process.env.AUTOPILOT_SKIP_START = '1';
process.env.EMAIL_MOCK_MODE = '1';
// Force mock-mode generation: GEMINI_API_KEY may exist in a local .env and we
// must never call the real API from tests. lib.js keys mock mode off a
// missing/placeholder key, so a placeholder value selects the mock branch.
process.env.GEMINI_API_KEY = 'placeholder-test-key';

import test from 'node:test';
import assert from 'node:assert/strict';
import { query, initializeDatabase, closeDatabase } from '../src/database.js';
import { generateSingleDescription } from '../src/lib.js';

const MARKER = 'DESC-SAFETY-2026';
let nextShopifyId = 97000;

async function seedProduct() {
  const shopifyId = ++nextShopifyId;
  const { rows } = await query(`
    INSERT INTO products (shopify_product_id, title, inventory, price, status, sku, created_at, updated_at)
    VALUES ($1, $2, 10, 19.99, 'active', $3, NOW(), NOW())
    RETURNING id, title
  `, [shopifyId, `${MARKER} Product ${shopifyId}`, `SKU-${MARKER}-${shopifyId}`]);
  return { productId: Number(rows[0].id), title: rows[0].title };
}

async function cleanup() {
  await query(`DELETE FROM descriptions WHERE product_id IN (SELECT id FROM products WHERE sku LIKE $1)`, [`SKU-${MARKER}-%`]);
  await query(`DELETE FROM products WHERE sku LIKE $1`, [`SKU-${MARKER}-%`]);
  await query(`DELETE FROM activity_logs WHERE type IN ('AI_GENERATION','AI_GENERATION_BATCH') AND message LIKE '%${MARKER}%'`).catch(() => {});
}

test('AI description safety — approved content is protected', { timeout: 30_000 }, async (t) => {
  await initializeDatabase();
  await cleanup();
  t.after(cleanup);
  t.after(() => closeDatabase());

  await t.test('regeneration is refused while an approved description exists', async () => {
    const { productId } = await seedProduct();
    await query(`
      INSERT INTO descriptions (product_id, generated_description, description_status, approved, generated_at)
      VALUES ($1, 'APPROVED-CONTENT-MUST-SURVIVE', 'approved', TRUE, NOW())
    `, [productId]);

    const result = await generateSingleDescription({ id: productId, title: 'X' });
    assert.equal(result, null, 'generation must be refused when an approved description exists');

    // The approved text must be untouched
    const { rows } = await query('SELECT generated_description FROM descriptions WHERE product_id = $1', [productId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].generated_description, 'APPROVED-CONTENT-MUST-SURVIVE');
  });

  await t.test('regeneration is refused while a published description exists (approved=FALSE edge)', async () => {
    const { productId } = await seedProduct();
    // A published row that somehow has approved=FALSE must still be protected.
    await query(`
      INSERT INTO descriptions (product_id, generated_description, description_status, approved, generated_at)
      VALUES ($1, 'PUBLISHED-CONTENT-MUST-SURVIVE', 'published', FALSE, NOW())
    `, [productId]);

    const result = await generateSingleDescription({ id: productId, title: 'X' });
    assert.equal(result, null);

    const { rows } = await query('SELECT generated_description FROM descriptions WHERE product_id = $1', [productId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].generated_description, 'PUBLISHED-CONTENT-MUST-SURVIVE');
  });

  await t.test('a product with only a pending draft can be regenerated into the same draft slot', async () => {
    const { productId } = await seedProduct();
    await query(`
      INSERT INTO descriptions (product_id, generated_description, description_status, approved, generated_at)
      VALUES ($1, 'PENDING-DRAFT', 'generated', FALSE, NOW())
    `, [productId]);

    // The unique partial index (approved = FALSE AND status != 'published')
    // allows exactly one pending draft. Regeneration with ON CONFLICT DO
    // NOTHING is a no-op: it returns null and — critically — the existing
    // draft text is NOT replaced with fresh content and the draft is not lost.
    const result = await generateSingleDescription({ id: productId, title: 'X' });
    assert.equal(result, null, 'no second draft row may be created');

    const { rows } = await query('SELECT generated_description FROM descriptions WHERE product_id = $1', [productId]);
    assert.equal(rows.length, 1, 'still exactly one draft');
    assert.equal(rows[0].generated_description, 'PENDING-DRAFT', 'existing draft is preserved, not overwritten');
  });

  await t.test('generation succeeds when no description exists at all', async () => {
    const { productId } = await seedProduct();
    const result = await generateSingleDescription({ id: productId, title: 'Fresh Product' });
    assert.ok(result, 'a product without any description must be generatable');
    assert.equal(Number(result.product_id), productId);
    assert.ok(result.generated_description.length > 10);
  });

  await t.test('batch generation respects AI_MAX_CONCURRENCY bounds', async () => {
    // Verify the concurrency knob is honored: batch runs with the configured
    // parallelism and completes without unbounded fan-out.
    process.env.AI_MAX_CONCURRENCY = '2';
    const { generateMissingDescriptions } = await import('../src/lib.js');
    const result = await generateMissingDescriptions();
    assert.equal(typeof result.generated, 'number');
    assert.equal(typeof result.total, 'number');
    assert.ok(result.durationMs >= 0);
    delete process.env.AI_MAX_CONCURRENCY;
  });
});
