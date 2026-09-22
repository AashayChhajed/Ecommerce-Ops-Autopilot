process.env.AUTOPILOT_SKIP_START = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeDatabase, markOrphanedSchedulerRunsFailed, closeDatabase, query } from '../src/database.js';

test('startup recovery marks orphaned RUNNING scheduler rows as failed', async () => {
  await initializeDatabase();

  const { rows: inserted } = await query(`
    INSERT INTO scheduler_runs (job_name, started, status)
    VALUES ('DescriptionGenerationJob', NOW() - INTERVAL '1 hour', 'RUNNING')
    RETURNING id
  `);

  const recovered = await markOrphanedSchedulerRunsFailed();
  assert.ok(recovered >= 1, 'At least one orphaned run should be recovered');

  const { rows: [run] } = await query(
    'SELECT status, finished, duration, error_message FROM scheduler_runs WHERE id = $1',
    [inserted[0].id]
  );

  assert.equal(run.status, 'FAILURE');
  assert.ok(run.finished, 'Recovered run must be stamped finished');
  assert.ok(Number(run.duration) > 0, 'Recovered run must have a duration');
  assert.match(run.error_message, /startup recovery/i);

  await query('DELETE FROM scheduler_runs WHERE id = $1', [inserted[0].id]);
  await closeDatabase();
});