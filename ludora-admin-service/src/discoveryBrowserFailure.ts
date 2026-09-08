import type { SessionDatabase } from './db.js';
import type { DiscoveryBrowserFailure } from './localDiscoveryOperationsClient.js';

// Runtime terminal-state update for one owned discovery run; no schema migration.
export const DISCOVERY_BROWSER_FAILURE_SQL = `
with failed_job as (
  update job_store_item_discovery_log
  set status = $3, error = $4, completed_at = now(), updated_at = now()
  where run_id = $1 and store_id = $2 and status = 'running'
  returning run_id
)
insert into store_item_discovery_trace_log (run_id, source, event, payload, created_at)
select run_id, 'admin-service', $5, $6::jsonb, now() from failed_job
`;

export function createDiscoveryBrowserFailureRecorder(database: SessionDatabase): (failure: DiscoveryBrowserFailure) => Promise<void> {
  return async (failure) => {
    await database.withSession(async (session) => {
      await session.query('begin');
      try {
        await session.query("set local statement_timeout = '5s'");
        await session.query("set local lock_timeout = '2s'");
        await session.query(DISCOVERY_BROWSER_FAILURE_SQL, [
          failure.runId, failure.storeId, failure.reason === 'timeout' ? 'failed' : 'cancelled', failure.error,
          `item_discovery.browser.${failure.reason}`,
          JSON.stringify({
            error: failure.error, phase: failure.phase, store_id: failure.storeId,
            timeout_seconds: failure.timeoutSeconds, url: failure.url
          })
        ]);
        await session.query('commit');
      } catch (error) {
        try { await session.query('rollback'); }
        catch { await session.close?.(); }
        throw error;
      }
    });
  };
}
