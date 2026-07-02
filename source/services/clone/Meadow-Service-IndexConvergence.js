'use strict';

/**
 * Index convergence for a clone table.
 *
 * Given a table's DESIRED index set (from Meadow-Service-IndexPolicy) and a
 * connection provider, bring the table's actual indexes in line with the
 * desired set:
 *
 *   introspect actual → diff by name → create missing → drop undeclared
 *
 * Two safety properties:
 *   1. Create-before-drop: new indexes are built BEFORE any old one is removed,
 *      so there is never a window with no covering index (matters because the
 *      sync's range-count walk runs right after).
 *   2. No-loss-on-failure: if any desired index fails to build this run, NO
 *      drops happen — we never remove a still-needed index whose replacement is
 *      not yet in place.  The drop is retried next run once the create succeeds.
 *
 * Prune scope controls what may be dropped:
 *   - 'none'    : additive only (never drop).
 *   - 'managed' : drop only indexes the policy owns or legacy artifacts
 *                 (see IndexPolicy.isManagedIndexName) — a truly external,
 *                 hand-authored index is left alone.  DEFAULT.
 *   - 'all'     : drop any undeclared index.  (introspectTableIndices already
 *                 excludes the primary key, so the PK is never a drop target.)
 *
 * @license MIT
 */

const libIndexPolicy = require('./Meadow-Service-IndexPolicy.js');

const PRUNE_NONE = 'none';
const PRUNE_MANAGED = 'managed';
const PRUNE_ALL = 'all';

const NOOP_LOG = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * Converge a single table's indexes to the desired set.
 *
 * @param {object} pProvider - connection provider exposing introspectTableIndices,
 *                             generateCreateIndexStatements, createIndex, dropIndex
 * @param {object} pTableSchema - { TableName, Columns[] }
 * @param {Array}  pDesiredIndexes - desired defs ({ Name, TableName, Columns[], Unique, Strategy })
 * @param {object} [pOptions] - { PruneScope?: string, log?: object }
 * @param {Function} fCallback - callback(pError, { table, created[], dropped[], skipped[] })
 */
function convergeTableIndexes(pProvider, pTableSchema, pDesiredIndexes, pOptions, fCallback)
{
	let tmpOptions = pOptions || {};
	let tmpLog = tmpOptions.log || NOOP_LOG;
	let tmpPruneScope = tmpOptions.PruneScope || PRUNE_MANAGED;
	let tmpTableName = pTableSchema.TableName;
	let tmpDesired = Array.isArray(pDesiredIndexes) ? pDesiredIndexes : [];

	if (!pProvider
		|| typeof(pProvider.introspectTableIndices) !== 'function'
		|| typeof(pProvider.generateCreateIndexStatements) !== 'function'
		|| typeof(pProvider.createIndex) !== 'function'
		|| typeof(pProvider.dropIndex) !== 'function')
	{
		return fCallback(new Error('IndexConvergence requires a provider with introspectTableIndices / generateCreateIndexStatements / createIndex / dropIndex'));
	}

	pProvider.introspectTableIndices(tmpTableName,
		(pIntrospectError, pActualIndices) =>
		{
			if (pIntrospectError)
			{
				return fCallback(pIntrospectError);
			}

			let tmpActual = Array.isArray(pActualIndices) ? pActualIndices : [];
			let tmpActualNames = new Set(tmpActual.map((pIndex) => { return pIndex.Name; }));
			let tmpDesiredNames = new Set(tmpDesired.map((pIndex) => { return pIndex.Name; }));

			// Missing desired indexes to create.
			let tmpToCreate = tmpDesired.filter((pIndex) => { return !tmpActualNames.has(pIndex.Name); });

			// Undeclared actual indexes to drop, scoped by prune policy.
			let tmpToDrop = [];
			if (tmpPruneScope !== PRUNE_NONE)
			{
				tmpToDrop = tmpActual.filter((pIndex) =>
					{
						if (tmpDesiredNames.has(pIndex.Name))
						{
							return false;
						}
						if (tmpPruneScope === PRUNE_ALL)
						{
							return true;
						}
						return libIndexPolicy.isManagedIndexName(pIndex.Name, pTableSchema);
					});
			}

			let tmpResult = { table: tmpTableName, created: [], dropped: [], skipped: [] };

			// Render CREATE statements for exactly the to-create set.  Passing
			// Columns:[] means the connector's per-column auto-derivation (GUID /
			// FK / Indexed) contributes nothing — only the explicit Indices[] we
			// hand it are rendered.
			let tmpCreateStatements = pProvider.generateCreateIndexStatements(
				{ TableName: tmpTableName, Columns: [], Indices: tmpToCreate });

			// -- Phase B: drop (runs after all creates) --
			let fDropPhase = (pCreateFailures) =>
			{
				if (tmpToDrop.length < 1)
				{
					return fCallback(null, tmpResult);
				}
				if (pCreateFailures > 0)
				{
					tmpLog.warn(`IndexConvergence: ${pCreateFailures} create(s) failed on ${tmpTableName}; skipping ${tmpToDrop.length} drop(s) this run to preserve coverage.`);
					for (let i = 0; i < tmpToDrop.length; i++)
					{
						tmpResult.skipped.push(tmpToDrop[i].Name);
					}
					return fCallback(null, tmpResult);
				}

				let fDropNext = (pIndex) =>
				{
					if (pIndex >= tmpToDrop.length)
					{
						return fCallback(null, tmpResult);
					}
					let tmpDropName = tmpToDrop[pIndex].Name;
					pProvider.dropIndex(tmpTableName, tmpDropName,
						(pDropError) =>
						{
							if (pDropError)
							{
								tmpLog.warn(`IndexConvergence: drop ${tmpDropName} on ${tmpTableName} failed: ${pDropError}`);
								tmpResult.skipped.push(tmpDropName);
							}
							else
							{
								tmpResult.dropped.push(tmpDropName);
							}
							return fDropNext(pIndex + 1);
						});
				};
				fDropNext(0);
			};

			// -- Phase A: create --
			let fCreateNext = (pIndex, pCreateFailures) =>
			{
				if (pIndex >= tmpCreateStatements.length)
				{
					return fDropPhase(pCreateFailures);
				}
				let tmpStatement = tmpCreateStatements[pIndex];
				pProvider.createIndex(tmpStatement,
					(pCreateError) =>
					{
						if (pCreateError)
						{
							tmpLog.warn(`IndexConvergence: create ${tmpStatement.Name} on ${tmpTableName} failed: ${pCreateError}`);
							tmpResult.skipped.push(tmpStatement.Name);
							return fCreateNext(pIndex + 1, pCreateFailures + 1);
						}
						tmpResult.created.push(tmpStatement.Name);
						return fCreateNext(pIndex + 1, pCreateFailures);
					});
			};

			fCreateNext(0, 0);
		});
}

module.exports = {
	PRUNE_NONE: PRUNE_NONE,
	PRUNE_MANAGED: PRUNE_MANAGED,
	PRUNE_ALL: PRUNE_ALL,
	convergeTableIndexes: convergeTableIndexes
};
