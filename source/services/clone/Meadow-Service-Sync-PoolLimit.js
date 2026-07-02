'use strict';

// Connection providers that expose a connection pool size.  The clone/sync
// engine defaults its fan-out (per-record reconcile, per-table init) to
// whichever of these is the active clone target so it never oversubscribes the
// pool.  Only one is instantiated per clone; SQLite is intentionally absent
// (no pool — single writer).
const POOLED_CONNECTION_PROVIDER_SERVICES = [ 'MeadowMSSQLProvider', 'MeadowMySQLProvider', 'MeadowPostgreSQLProvider' ];

// Fan-out used when no pool size is reported (e.g. SQLite — single writer).
const DEFAULT_CONCURRENCY = 5;

// Ceiling on the AUTO-derived default fan-out.  Sizing to the pool avoids
// oversubscribing a small pool, but a very large pool (say 100) should not make
// the sync fan out 100-wide by default: the concurrency also gates source-API
// reads, and that many in-flight reconciles would hammer the source and balloon
// memory.  An explicit SyncRecordConcurrency / SyncTableInitConcurrency bypasses
// this cap — it only tempers the automatic default.
const MAX_DEFAULT_CONCURRENCY = 16;

/**
 * Resolve the active clone target's connection pool size.
 *
 * Returns the pool size of whichever pooled connection provider is registered on
 * the fable, or 0 when the active provider does not report one (e.g. SQLite) so
 * callers can apply their own default.
 *
 * @param {object} pFable - the fable instance the sync is running on
 * @returns {number} the pool size, or 0 if none is available
 */
function resolveConnectionPoolLimit(pFable)
{
	if (!pFable)
	{
		return 0;
	}
	for (let i = 0; i < POOLED_CONNECTION_PROVIDER_SERVICES.length; i++)
	{
		let tmpProvider = pFable[POOLED_CONNECTION_PROVIDER_SERVICES[i]];
		if (tmpProvider && (typeof(tmpProvider.connectionPoolLimit) === 'number') && tmpProvider.connectionPoolLimit > 0)
		{
			return tmpProvider.connectionPoolLimit;
		}
	}
	return 0;
}

/**
 * Resolve the automatic default fan-out concurrency for the active clone target.
 *
 * Sizes to the connection pool so the sync neither oversubscribes a small pool
 * nor fans out unbounded on a very large one (capped at MAX_DEFAULT_CONCURRENCY),
 * and falls back to DEFAULT_CONCURRENCY when the provider reports no pool (e.g.
 * SQLite).  Callers apply this only when no explicit concurrency is configured;
 * an explicit value is honored as-is and is not subject to the cap.
 *
 * @param {object} pFable - the fable instance the sync is running on
 * @returns {number} a positive default concurrency
 */
function resolveDefaultConcurrency(pFable)
{
	let tmpPoolLimit = resolveConnectionPoolLimit(pFable);
	if (tmpPoolLimit > 0)
	{
		return Math.min(tmpPoolLimit, MAX_DEFAULT_CONCURRENCY);
	}
	return DEFAULT_CONCURRENCY;
}

module.exports = {
	POOLED_CONNECTION_PROVIDER_SERVICES: POOLED_CONNECTION_PROVIDER_SERVICES,
	DEFAULT_CONCURRENCY: DEFAULT_CONCURRENCY,
	MAX_DEFAULT_CONCURRENCY: MAX_DEFAULT_CONCURRENCY,
	resolveConnectionPoolLimit: resolveConnectionPoolLimit,
	resolveDefaultConcurrency: resolveDefaultConcurrency
};
