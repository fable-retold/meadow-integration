/**
 * Unit tests for per-record sync fan-out concurrency resolution.
 *
 * The sync strategies fan out record reconcile/upsert work with
 * `eachLimit(records, this.SyncRecordConcurrency, ...)`.  This locks in the
 * resolution rules so a small clone (e.g. a 2-connection pool) never fans out
 * wider than its pool, while remaining explicitly tunable.
 *
 * Pure JS — no DB connection needed; the pool size is read from a stubbed
 * provider exposing `connectionPoolLimit`.
 *
 * @license MIT
 */

'use strict';

const Chai = require('chai');
const Expect = Chai.expect;

const libFable = require('fable');
const libMeadowSyncEntityOngoing = require('../source/services/clone/Meadow-Service-Sync-Entity-Ongoing.js');
const libMeadowSyncEntityInitial = require('../source/services/clone/Meadow-Service-Sync-Entity-Initial.js');
const libSyncPoolLimit = require('../source/services/clone/Meadow-Service-Sync-PoolLimit.js');

const _MinimalEntitySchema =
{
	TableName: 'Book',
	Columns:
	[
		{ Column: 'IDBook',   DataType: 'ID'   },
		{ Column: 'GUIDBook', DataType: 'GUID' },
		{ Column: 'Deleted',  DataType: 'Boolean' },
		{ Column: 'Title',    DataType: 'String' }
	],
	MeadowSchema:
	{
		Scope: 'Book',
		DefaultIdentifier: 'IDBook',
		Domain: 'Default',
		Schema: [],
		DefaultObject: {}
	}
};

// Construct a sync entity directly with the given option overrides and an
// optional stubbed connection pool size on a chosen provider service name
// (defaults to the MSSQL provider).
function makeEntity(pEntityClass, pOptionOverrides, pPoolLimit, pProviderService)
{
	let tmpFable = new libFable({ Product: 'MeadowSyncConcurrencyTest' });
	if (typeof(pPoolLimit) === 'number')
	{
		// Stub the connection provider's pool-size reporter.
		tmpFable[pProviderService || 'MeadowMSSQLProvider'] = { connectionPoolLimit: pPoolLimit };
	}
	let tmpOptions = Object.assign({ MeadowEntitySchema: _MinimalEntitySchema }, pOptionOverrides || {});
	return new pEntityClass(tmpFable, tmpOptions, 'sync-concurrency-test');
}

suite('Meadow Integration - Sync Record Concurrency',
	() =>
	{
		suite('Ongoing (shared base for OEC / TrueUp / ComparisonOnly)',
			() =>
			{
				test('defaults to the DB connection pool size when nothing is configured',
					() =>
					{
						let tmpEntity = makeEntity(libMeadowSyncEntityOngoing, {}, 2);
						Expect(tmpEntity.SyncRecordConcurrency).to.equal(2);
					});

				test('falls back to 5 when no pool-reporting provider is present',
					() =>
					{
						let tmpEntity = makeEntity(libMeadowSyncEntityOngoing, {}, undefined);
						Expect(tmpEntity.SyncRecordConcurrency).to.equal(5);
					});

				test('explicit SyncRecordConcurrency wins over the pool size',
					() =>
					{
						let tmpEntity = makeEntity(libMeadowSyncEntityOngoing, { SyncRecordConcurrency: 7 }, 2);
						Expect(tmpEntity.SyncRecordConcurrency).to.equal(7);
					});

				test('a non-positive configured value is ignored in favor of the pool size',
					() =>
					{
						let tmpEntity = makeEntity(libMeadowSyncEntityOngoing, { SyncRecordConcurrency: 0 }, 4);
						Expect(tmpEntity.SyncRecordConcurrency).to.equal(4);
					});

				test('defaults to the pool size of an active MySQL clone target',
					() =>
					{
						let tmpEntity = makeEntity(libMeadowSyncEntityOngoing, {}, 8, 'MeadowMySQLProvider');
						Expect(tmpEntity.SyncRecordConcurrency).to.equal(8);
					});

				test('defaults to the pool size of an active PostgreSQL clone target',
					() =>
					{
						let tmpEntity = makeEntity(libMeadowSyncEntityOngoing, {}, 6, 'MeadowPostgreSQLProvider');
						Expect(tmpEntity.SyncRecordConcurrency).to.equal(6);
					});

				test('caps the auto-derived default for a very large pool',
					() =>
					{
						let tmpEntity = makeEntity(libMeadowSyncEntityOngoing, {}, 100);
						Expect(tmpEntity.SyncRecordConcurrency).to.equal(libSyncPoolLimit.MAX_DEFAULT_CONCURRENCY);
					});

				test('an explicit concurrency above the cap is honored (the cap only tempers the default)',
					() =>
					{
						let tmpEntity = makeEntity(libMeadowSyncEntityOngoing, { SyncRecordConcurrency: 50 }, 100);
						Expect(tmpEntity.SyncRecordConcurrency).to.equal(50);
					});
			});

		suite('Initial (separate base)',
			() =>
			{
				test('defaults to the DB connection pool size',
					() =>
					{
						let tmpEntity = makeEntity(libMeadowSyncEntityInitial, {}, 3);
						Expect(tmpEntity.SyncRecordConcurrency).to.equal(3);
					});

				test('explicit config wins over the pool size',
					() =>
					{
						let tmpEntity = makeEntity(libMeadowSyncEntityInitial, { SyncRecordConcurrency: 9 }, 3);
						Expect(tmpEntity.SyncRecordConcurrency).to.equal(9);
					});
			});

		// The shared resolver used by all three fan-out sites (both entity bases
		// + the orchestrator's table-init loop).
		suite('resolveConnectionPoolLimit (shared helper)',
			() =>
			{
				test('returns the pool size of the active MSSQL/MySQL/PostgreSQL provider',
					() =>
					{
						Expect(libSyncPoolLimit.resolveConnectionPoolLimit({ MeadowMSSQLProvider: { connectionPoolLimit: 2 } })).to.equal(2);
						Expect(libSyncPoolLimit.resolveConnectionPoolLimit({ MeadowMySQLProvider: { connectionPoolLimit: 8 } })).to.equal(8);
						Expect(libSyncPoolLimit.resolveConnectionPoolLimit({ MeadowPostgreSQLProvider: { connectionPoolLimit: 6 } })).to.equal(6);
					});

				test('returns 0 when no pooled provider is registered (e.g. SQLite)',
					() =>
					{
						Expect(libSyncPoolLimit.resolveConnectionPoolLimit({ MeadowSQLiteProvider: {} })).to.equal(0);
						Expect(libSyncPoolLimit.resolveConnectionPoolLimit({})).to.equal(0);
						Expect(libSyncPoolLimit.resolveConnectionPoolLimit(null)).to.equal(0);
					});

				test('ignores a provider that reports a non-positive or non-numeric pool size',
					() =>
					{
						Expect(libSyncPoolLimit.resolveConnectionPoolLimit({ MeadowMSSQLProvider: { connectionPoolLimit: 0 } })).to.equal(0);
						Expect(libSyncPoolLimit.resolveConnectionPoolLimit({ MeadowMySQLProvider: { connectionPoolLimit: 'lots' } })).to.equal(0);
					});

				test('resolveDefaultConcurrency sizes to the pool but caps very large pools', () =>
					{
						Expect(libSyncPoolLimit.resolveDefaultConcurrency({ MeadowMSSQLProvider: { connectionPoolLimit: 3 } })).to.equal(3);
						Expect(libSyncPoolLimit.resolveDefaultConcurrency({ MeadowMySQLProvider: { connectionPoolLimit: 1000 } })).to.equal(libSyncPoolLimit.MAX_DEFAULT_CONCURRENCY);
					});

				test('resolveDefaultConcurrency falls back to the default when no pool is reported', () =>
					{
						Expect(libSyncPoolLimit.resolveDefaultConcurrency({})).to.equal(libSyncPoolLimit.DEFAULT_CONCURRENCY);
						Expect(libSyncPoolLimit.resolveDefaultConcurrency(null)).to.equal(libSyncPoolLimit.DEFAULT_CONCURRENCY);
					});
			});
	});
