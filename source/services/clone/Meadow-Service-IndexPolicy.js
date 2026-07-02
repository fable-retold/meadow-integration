'use strict';

/**
 * Index policy for the clone/sync workload.
 *
 * This is the single source of truth for which indexes a synced table SHOULD
 * have, independent of any one execution flow.  Both the headless DataCloner
 * pipeline and the standalone CLI clone tool resolve their desired index set
 * from here so they converge to the same shape.
 *
 * The desired set for a table is the union of:
 *   1. Standard operational indexes (applied to every eligible table):
 *        - (Deleted, ID<Table>) composite  — makes the OngoingEventualConsistency
 *          range-count / delete-reconcile walk a seek instead of a scan.
 *        - a GUID lookup index             — speeds meadow's app-side GUID
 *          precheck on insert.  NON-UNIQUE by policy: the clone is a derived
 *          replica of data with known duplicate GUIDs at the source, and a
 *          unique index would fail to build on a table that holds a dup pair.
 *   2. Caller-declared per-table indexes (the "observed required" extras):
 *        config.TableIndexes[<TableName>] = [ { Columns, Unique?, Name?, Strategy? } ]
 *
 * Every policy-produced index carries the IX_M_SYNC_ prefix so the convergence
 * pass can recognize the set it manages.  Definitions match the shape the
 * connectors' generateCreateIndexStatements consumes:
 *   { Name, TableName, Columns[], Unique, Strategy }
 *
 * @license MIT
 */

// All policy-managed indexes share this prefix so convergence can scope itself.
const INDEX_POLICY_PREFIX = 'IX_M_SYNC_';

/**
 * Resolve the identity/PK column for a table.
 * Prefers the schema's DefaultIdentifier, then an AutoIdentity/ID column, then
 * the ID<Table> naming convention.
 *
 * @param {object} pTableSchema
 * @param {Set<string>} pColumnNames
 * @returns {string}
 */
function resolveIdentityColumn(pTableSchema, pColumnNames)
{
	let tmpIdentity = pTableSchema.DefaultIdentifier;
	if (tmpIdentity && pColumnNames.has(tmpIdentity))
	{
		return tmpIdentity;
	}
	let tmpColumns = Array.isArray(pTableSchema.Columns) ? pTableSchema.Columns : [];
	let tmpIdentityCol = tmpColumns.find((pColumn) => { return (pColumn.DataType === 'AutoIdentity' || pColumn.DataType === 'ID'); });
	return tmpIdentityCol ? tmpIdentityCol.Column : `ID${pTableSchema.TableName}`;
}

/**
 * Resolve the desired index definitions for a single table.
 *
 * @param {object} pTableSchema - Meadow table schema ({ TableName, Columns[], DefaultIdentifier })
 * @param {object} [pIndexConfig] - { StandardOperationalIndexes?: boolean, TableIndexes?: { [table]: Array } }
 * @returns {Array<{Name:string,TableName:string,Columns:string[],Unique:boolean,Strategy:string}>}
 */
function resolveDesiredIndexes(pTableSchema, pIndexConfig)
{
	let tmpConfig = pIndexConfig || {};
	let tmpTableName = pTableSchema.TableName;
	let tmpColumns = Array.isArray(pTableSchema.Columns) ? pTableSchema.Columns : [];
	let tmpColumnNames = new Set(tmpColumns.map((pColumn) => { return pColumn.Column; }));
	let tmpIndices = [];

	// -- 1. Standard operational indexes (all eligible tables) --
	// Enabled by default; set StandardOperationalIndexes:false to opt a run out.
	if (tmpConfig.StandardOperationalIndexes !== false)
	{
		let tmpIdentity = resolveIdentityColumn(pTableSchema, tmpColumnNames);

		// (Deleted, ID) composite — equality on Deleted then range on the identity.
		if (tmpColumnNames.has('Deleted') && tmpColumnNames.has(tmpIdentity))
		{
			tmpIndices.push(
				{
					Name: `${INDEX_POLICY_PREFIX}${tmpTableName}_Deleted_${tmpIdentity}`,
					TableName: tmpTableName,
					Columns: [ 'Deleted', tmpIdentity ],
					Unique: false,
					Strategy: ''
				});
		}

		// GUID lookup — NON-UNIQUE by policy (see file header).
		let tmpGUIDColumn = tmpColumns.find((pColumn) => { return pColumn.DataType === 'GUID'; });
		if (tmpGUIDColumn)
		{
			tmpIndices.push(
				{
					Name: `${INDEX_POLICY_PREFIX}${tmpTableName}_${tmpGUIDColumn.Column}`,
					TableName: tmpTableName,
					Columns: [ tmpGUIDColumn.Column ],
					Unique: false,
					Strategy: ''
				});
		}
	}

	// -- 2. Caller-declared per-table extras --
	let tmpTableExtras = (tmpConfig.TableIndexes && Array.isArray(tmpConfig.TableIndexes[tmpTableName]))
		? tmpConfig.TableIndexes[tmpTableName]
		: [];
	for (let i = 0; i < tmpTableExtras.length; i++)
	{
		let tmpExtra = tmpTableExtras[i];
		let tmpCols = Array.isArray(tmpExtra.Columns) ? tmpExtra.Columns : [ tmpExtra.Columns ];
		// Skip a declared index whose columns are not all present on the table.
		if (!tmpCols.every((pCol) => { return tmpColumnNames.has(pCol); }))
		{
			continue;
		}
		tmpIndices.push(
			{
				Name: tmpExtra.Name || `${INDEX_POLICY_PREFIX}${tmpTableName}_${tmpCols.join('_')}`,
				TableName: tmpTableName,
				Columns: tmpCols,
				Unique: !!tmpExtra.Unique,
				Strategy: tmpExtra.Strategy || ''
			});
	}

	return tmpIndices;
}

/**
 * Whether an index name is one this policy manages — used by convergence's
 * "managed" prune scope so it only ever drops indexes it owns.  Recognizes:
 *   - policy-created indexes (IX_M_SYNC_ prefix),
 *   - meadow schema-managed indexes (AK_M / IX_M prefixes),
 *   - the legacy precursor / MeadowConnectionManager artifacts, which name a
 *     single-column index after the column itself (e.g. [Deleted], [GUIDDocument]).
 * A truly external, hand-authored index (unusual here, but possible) is NOT
 * managed and is left untouched.
 *
 * @param {string} pIndexName
 * @param {object} pTableSchema
 * @returns {boolean}
 */
function isManagedIndexName(pIndexName, pTableSchema)
{
	if (!pIndexName)
	{
		return false;
	}
	if (pIndexName.indexOf(INDEX_POLICY_PREFIX) === 0
		|| pIndexName.indexOf('AK_M') === 0
		|| pIndexName.indexOf('IX_M') === 0)
	{
		return true;
	}
	// Legacy artifact: index named exactly after one of the table's columns.
	let tmpColumns = Array.isArray(pTableSchema && pTableSchema.Columns) ? pTableSchema.Columns : [];
	return tmpColumns.some((pColumn) => { return pColumn.Column === pIndexName; });
}

module.exports = {
	INDEX_POLICY_PREFIX: INDEX_POLICY_PREFIX,
	resolveIdentityColumn: resolveIdentityColumn,
	resolveDesiredIndexes: resolveDesiredIndexes,
	isManagedIndexName: isManagedIndexName
};
