import cron from 'node-cron';
import { query } from './database.js';

/**
 * Wraps a job function with:
 * - scheduler_runs record (started, finished, status, duration)
 * - Independent error isolation (one job crash never stops others)
 */
async function runJob(jobName, fn, { logActivity }) {
  const startTime = Date.now();
  let runId;

  try {
    const { rows } = await query(
      `INSERT INTO scheduler_runs (job_name, started, status) VALUES ($1, NOW(), 'RUNNING') RETURNING id`,
      [jobName]
    );
    runId = rows[0]?.id;
  } catch (err) {
    console.error(`[Scheduler] Failed to create run record for ${jobName}:`, err.message);
  }

  try {
    console.log(`[Scheduler] ▶ ${jobName} started`);
    await fn();
    const durationMs = Date.now() - startTime;

    if (runId) {
      await query(
        `UPDATE scheduler_runs SET finished = NOW(), status = 'SUCCESS', duration = $1 WHERE id = $2`,
        [durationMs, runId]
      );
    }
    console.log(`[Scheduler] ✔ ${jobName} completed in ${durationMs}ms`);
  } catch (err) {
    const durationMs = Date.now() - startTime;
    console.error(`[Scheduler] ✖ ${jobName} failed:`, err.message);

    if (runId) {
      await query(
        `UPDATE scheduler_runs SET finished = NOW(), status = 'FAILURE', duration = $1, error_message = $2 WHERE id = $3`,
        [durationMs, err.message, runId]
      ).catch(() => {});
    }

    await logActivity(
      `SCHEDULER_${jobName.toUpperCase().replace(/\s/g, '_')}`,
      `Job "${jobName}" failed: ${err.message}`,
      'ERROR'
    ).catch(() => {});
  }
}

export function startScheduler({ fullSync, auditInventory, logActivity }) {
  console.log('[Scheduler] Starting background job engine...');

  // ── Job 1: Full Shopify Sync — every 5 minutes ──────────────────────────
  cron.schedule('*/5 * * * *', () => {
    runJob('ShopifySyncJob', () => fullSync(), { logActivity });
  });

  // ── Job 2: Inventory Audit — every 5 minutes (offset 30s) ───────────────
  // We stagger by 30s inside the handler to avoid race conditions
  cron.schedule('*/5 * * * *', async () => {
    await new Promise((r) => setTimeout(r, 30_000)); // 30s stagger
    runJob('InventoryAuditJob', () => auditInventory(), { logActivity });
  });

  // ── Job 3: Log Cleanup — daily at 02:00 ─────────────────────────────────
  cron.schedule('0 2 * * *', () => {
    runJob('LogCleanupJob', async () => {
      const { rowCount } = await query(
        `DELETE FROM activity_logs WHERE created_at < NOW() - INTERVAL '30 days'`
      );
      await logActivity('LOG_CLEANUP', `Purged ${rowCount} activity log(s) older than 30 days.`, 'INFO');
    }, { logActivity });
  });

  console.log('[Scheduler] ✔ Jobs registered: ShopifySyncJob (*/5m), InventoryAuditJob (*/5m+30s), LogCleanupJob (daily 02:00)');
}
