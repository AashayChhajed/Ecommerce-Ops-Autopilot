import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE ?? 'ecommerce_ops_autopilot',
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? 'aashay',
  // Cloud Postgres (Render, etc.) requires TLS. DATABASE_URL presence means
  // we're on a hosted database, so enable SSL with the standard
  // `rejectUnauthorized: false` pattern for Render-managed certificates.
  // Local dev (no DATABASE_URL) stays plain TCP, exactly as before.
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB Pool] Unexpected error:', err.message);
});

export async function initializeDatabase() {
  // Core tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id BIGSERIAL PRIMARY KEY,
      shopify_product_id BIGINT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT,
      vendor TEXT,
      status TEXT,
      inventory INTEGER NOT NULL DEFAULT 0,
      price NUMERIC(12, 2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      shopify_order_id BIGINT NOT NULL UNIQUE,
      customer_name TEXT,
      email TEXT,
      status TEXT,
      total NUMERIC(12, 2) NOT NULL DEFAULT 0,
      notification_status TEXT NOT NULL DEFAULT 'UNNOTIFIED',
      notification_retries INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory_alerts (
      id BIGSERIAL PRIMARY KEY,
      product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      current_stock INTEGER NOT NULL DEFAULT 0,
      threshold INTEGER NOT NULL DEFAULT 5,
      resolved BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id BIGSERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'INFO',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduler_runs (
      id BIGSERIAL PRIMARY KEY,
      job_name TEXT NOT NULL,
      started TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'RUNNING',
      duration INTEGER,
      error_message TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS descriptions (
      id BIGSERIAL PRIMARY KEY,
      product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      generated_description TEXT,
      approved BOOLEAN NOT NULL DEFAULT FALSE,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Idempotent column additions for existing databases
  const additions = [
    [`ALTER TABLE orders ADD COLUMN IF NOT EXISTS notification_status TEXT NOT NULL DEFAULT 'UNNOTIFIED'`],
    [`ALTER TABLE orders ADD COLUMN IF NOT EXISTS notification_retries INTEGER NOT NULL DEFAULT 0`],
    [`ALTER TABLE scheduler_runs ADD COLUMN IF NOT EXISTS error_message TEXT`],
  ];
  for (const [sql] of additions) {
    await pool.query(sql).catch(() => {}); // ignore if already exists (older PG versions)
  }

  // ── Description settings (brand voice) ──────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS description_settings (
      id BIGSERIAL PRIMARY KEY,
      tone TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT '',
      brand_phrases TEXT,
      style_notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Seed an empty brand voice row if none exists (no prefilled values —
  // the user starts with a blank configuration and fills it in themselves)
  const { rowCount: settingsCount } = await pool.query('SELECT 1 FROM description_settings LIMIT 1');
  if (settingsCount === 0) {
    await pool.query(`
      INSERT INTO description_settings (tone, language, brand_phrases, style_notes)
      VALUES ('', '', '', '')
    `);
    console.log('[DB] Seeded empty brand voice settings');
  }

  // Clear legacy prefilled brand voice defaults (rows that exactly match the
  // old seed values) so the configuration starts blank. Rows that a user has
  // actually customized are never touched.
  await pool.query(`
    UPDATE description_settings SET
      tone = '',
      language = '',
      brand_phrases = '',
      style_notes = ''
    WHERE tone = 'professional' AND language = 'English'
      AND (brand_phrases IS NULL OR brand_phrases = '')
      AND style_notes = 'Focus on quality, craftsmanship, and customer satisfaction.'
  `).catch(() => {});

  // ── Add columns to descriptions table (idempotent) ───────────────
  const descAdditions = [
    `ALTER TABLE descriptions ADD COLUMN IF NOT EXISTS description_status TEXT NOT NULL DEFAULT 'generated'`,
    `ALTER TABLE descriptions ADD COLUMN IF NOT EXISTS review_notes TEXT`,
  ];
  for (const sql of descAdditions) {
    await pool.query(sql).catch(() => {});
  }

  // Set default status for existing rows
  await pool.query(`
    UPDATE descriptions SET description_status = CASE
      WHEN approved = TRUE THEN 'approved'
      ELSE 'generated'
    END WHERE description_status IS NULL OR description_status = ''
  `).catch(() => {});

  // ── Multi-Channel Inventory ────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS channels (
      id BIGSERIAL PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      is_mock BOOLEAN NOT NULL DEFAULT FALSE,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS channel_products (
      id BIGSERIAL PRIMARY KEY,
      product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      channel_sku TEXT NOT NULL,
      external_id TEXT,
      title TEXT NOT NULL,
      available_quantity INTEGER NOT NULL DEFAULT 0,
      last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(product_id, channel_id)
    )
  `);

  // Add warehouse_quantity to products (separate from Shopify inventory)
  const productAdditions = [
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS warehouse_quantity INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS sku TEXT`,
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT`,
  ];
  for (const sql of productAdditions) {
    await pool.query(sql).catch(() => {});
  }

  // Indexes for channel tables
  const channelIndexes = [
    `CREATE INDEX IF NOT EXISTS idx_channel_products_channel ON channel_products(channel_id)`,
    `CREATE INDEX IF NOT EXISTS idx_channel_products_product ON channel_products(product_id)`,
    `CREATE INDEX IF NOT EXISTS idx_channel_products_sku ON channel_products(channel_sku)`,
  ];
  for (const sql of channelIndexes) {
    await pool.query(sql).catch(() => {});
  }

  // ── Seed channels if none exist ──────────────────────
  const { rowCount: channelCount } = await pool.query('SELECT 1 FROM channels LIMIT 1');
  if (channelCount === 0) {
    await pool.query(`
      INSERT INTO channels (code, display_name, is_mock, enabled) VALUES
        ('SHOPIFY', 'Shopify', FALSE, TRUE),
        ('AMAZON_MOCK', 'Amazon (Mock)', TRUE, TRUE),
        ('MYNTRA_MOCK', 'Myntra (Mock)', TRUE, TRUE),
        ('FLIPKART_MOCK', 'Flipkart (Mock)', TRUE, TRUE)
    `);
    console.log('[DB] Seeded 4 sales channels');
  }

  // ── Seed mock channel product data ───────────────────
  const { rowCount: cpCount } = await pool.query('SELECT 1 FROM channel_products LIMIT 1');
  if (cpCount === 0) {
    // Get channel IDs
    const { rows: chs } = await pool.query('SELECT id, code FROM channels');
    const chMap = Object.fromEntries(chs.map(c => [c.code, c.id]));

    // Create internal SKUs for existing products if they don't have one
    // Also set warehouse_quantity based on current inventory
    await pool.query(`
      UPDATE products SET
        sku = COALESCE(sku, 'SKU-' || LPAD(shopify_product_id::text, 6, '0')),
        warehouse_quantity = CASE WHEN warehouse_quantity = 0 THEN inventory ELSE warehouse_quantity END
      WHERE sku IS NULL OR warehouse_quantity = 0
    `).catch(() => {});

    const { rows: products } = await pool.query('SELECT id, title, sku, inventory, warehouse_quantity FROM products ORDER BY id');

    if (products.length > 0) {
      // Build seed data: assign products to channels with realistic quantities
      // Some products oversell, some match, some have channel mismatch
      const seedData = [];
      const channelCodes = ['AMAZON_MOCK', 'MYNTRA_MOCK', 'FLIPKART_MOCK'];

      products.forEach((p, idx) => {
        const baseQty = p.warehouse_quantity || p.inventory;
        const pIdx = idx + 1;

        // Each product goes to at least 1 mock channel, some to all 3
        const channelsForProduct = pIdx <= 2 ? channelCodes : // First 2 products: all 3 channels
          pIdx <= 5 ? channelCodes.slice(0, 2) : // Next 3: 2 channels
          channelCodes.slice(0, 1); // Rest: 1 channel

        channelsForProduct.forEach((chCode, chIdx) => {
          let qty;
          const scenario = (pIdx - 1) % 5 + 1;

          switch (scenario) {
            case 1: // Normal: channel qty <= warehouse
              qty = Math.max(1, Math.floor(baseQty * 0.4));
              break;
            case 2: // Oversell risk: channel qty > warehouse
              qty = baseQty + Math.floor(Math.random() * 10) + 5;
              break;
            case 3: // Channel mismatch: warehouse=0 but channel has stock
              qty = Math.max(5, Math.floor(Math.random() * 20));
              break;
            case 4: // Normal: channels share stock
              qty = Math.max(1, Math.floor(baseQty / 3));
              break;
            case 5: // Out of stock on channel
              qty = 0;
              break;
            default:
              qty = Math.max(1, Math.floor(baseQty * 0.3));
          }

          seedData.push({
            productId: p.id,
            channelId: chMap[chCode],
            channelSku: `${chCode.substring(0, 3)}-${p.sku || `SKU-${String(pIdx).padStart(4, '0')}`}`,
            externalId: `${chCode.substring(0, 3)}-${p.id}`,
            title: p.title,
            availableQuantity: qty,
          });
        });
      });

      if (seedData.length > 0) {
        const values = seedData.map((_, i) => {
          const b = i * 6 + 1;
          return `($${b},$${b+1},$${b+2},$${b+3},$${b+4},$${b+5},NOW(),NOW())`;
        });
        const flat = seedData.flatMap(d => [
          d.productId, d.channelId, d.channelSku, d.externalId,
          d.title, d.availableQuantity,
        ]);
        await pool.query(`
          INSERT INTO channel_products (product_id, channel_id, channel_sku, external_id, title, available_quantity, last_synced_at, updated_at)
          VALUES ${values.join(',')}
          ON CONFLICT (product_id, channel_id) DO UPDATE SET
            available_quantity = EXCLUDED.available_quantity,
            updated_at = NOW()
        `, flat);
        console.log(`[DB] Seeded ${seedData.length} mock channel product records`);
      }
    } else {
      console.log('[DB] No products found to seed mock channel data');
    }
  }

  // ── Over-Order Guard: order line items & stock allocation ───────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      channel_sku TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Track which channel an order came from + its allocation lifecycle
  const orderAllocationAdditions = [
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS channel_code TEXT NOT NULL DEFAULT 'SHOPIFY'`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_reference TEXT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS allocation_status TEXT NOT NULL DEFAULT 'UNCHECKED'`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS allocation_notes TEXT`,
    `ALTER TABLE orders ALTER COLUMN shopify_order_id DROP NOT NULL`,
    // Reserved (allocated) stock — the amount committed to accepted orders
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS allocated_quantity INTEGER NOT NULL DEFAULT 0`,
  ];
  for (const sql of orderAllocationAdditions) {
    await pool.query(sql).catch(() => {});
  }

  // Backfill channel_code for pre-existing rows
  await pool.query(`UPDATE orders SET channel_code = 'SHOPIFY' WHERE channel_code IS NULL`).catch(() => {});

  const allocationIndexes = [
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_channel_ref ON orders(channel_code, order_reference) WHERE order_reference IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_orders_allocation ON orders(allocation_status)`,
    `CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id)`,
  ];
  for (const sql of allocationIndexes) {
    await pool.query(sql).catch(() => {});
  }

  // ── Safety settings (over-order guard buffer) ─────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS safety_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      buffer_percent INTEGER NOT NULL DEFAULT 100,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Seed the default safety buffer: sellable % of warehouse stock.
  // Env override: SAFETY_BUFFER_PERCENT (clamped to 1..100).
  const seedBuffer = Math.min(100, Math.max(1, Number(process.env.SAFETY_BUFFER_PERCENT ?? 100) || 100));
  await pool.query(`
    INSERT INTO safety_settings (id, buffer_percent)
    VALUES (1, $1)
    ON CONFLICT (id) DO NOTHING
  `, [seedBuffer]);
  console.log(`[DB] Safety buffer seeded at ${seedBuffer}% of warehouse stock`);

  // Indexes
  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_products_shopify_id ON products(shopify_product_id)`,
    `CREATE INDEX IF NOT EXISTS idx_products_inventory ON products(inventory)`,
    `CREATE INDEX IF NOT EXISTS idx_products_updated_at ON products(updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_shopify_id ON orders(shopify_order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_notification ON orders(notification_status)`,
    `CREATE INDEX IF NOT EXISTS idx_alerts_product_resolved ON inventory_alerts(product_id, resolved)`,
    `CREATE INDEX IF NOT EXISTS idx_logs_created ON activity_logs(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_sched_job_started ON scheduler_runs(job_name, started DESC)`,
  ];
  for (const sql of indexes) {
    await pool.query(sql).catch(() => {});
  }

  console.log('[DB] Schema initialized successfully');
}

/**
 * Mark any scheduler runs left RUNNING by a previous process as failed.
 * This is called during startup so the UI never shows a phantom active job after a restart.
 *
 * @returns {Promise<number>} Number of rows updated.
 */
export async function markOrphanedSchedulerRunsFailed() {
  const { rowCount } = await pool.query(`
    UPDATE scheduler_runs
    SET
      finished = COALESCE(finished, NOW()),
      status = 'FAILURE',
      duration = COALESCE(duration, ROUND(EXTRACT(EPOCH FROM (NOW() - started)) * 1000)::int),
      error_message = COALESCE(error_message, 'Marked failed during startup recovery after a process restart.')
    WHERE status = 'RUNNING' AND finished IS NULL
  `);

  return rowCount;
}

export const query = (text, values) => pool.query(text, values);

/**
 * Run a callback inside a DB transaction (BEGIN / COMMIT / ROLLBACK).
 * The callback receives a connected client and may run multiple queries.
 *
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Fetch channel product data needed to seed the mock data store */
export async function fetchMockChannelSeedData() {
  const { rows } = await query(`
    SELECT
      cp.channel_sku,
      cp.external_id,
      cp.title,
      cp.available_quantity,
      cp.product_id,
      c.code AS channel_code
    FROM channel_products cp
    JOIN channels c ON c.id = cp.channel_id
    WHERE c.is_mock = TRUE
  `);
  return rows;
}
export const closeDatabase = () => pool.end();
