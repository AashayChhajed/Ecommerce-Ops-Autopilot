import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE ?? 'ecommerce_ops_autopilot',
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? 'aashay',
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

export const query = (text, values) => pool.query(text, values);
export const closeDatabase = () => pool.end();
