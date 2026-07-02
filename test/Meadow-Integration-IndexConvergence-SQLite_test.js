'use strict';

/**
 * Live-database smoke test for index convergence.
 *
 * Unlike the stub-provider unit test, this runs the convergence engine against a
 * REAL connector + REAL database (Node's built-in node:sqlite via
 * meadow-connection-sqlite) — exercising the actual introspectTableIndices,
 * generateCreateIndexStatements, createIndex, and the NEW dropIndex end to end.
 * No external server / credentials required.
 */

const Chai = require('chai');
const Expect = Chai.expect;

const libFs = require('fs');
const libPath = require('path');
const libOs = require('os');

const libFable = require('fable');
const libMeadowConnectionSQLite = require('meadow-connection-sqlite');
const libIndexPolicy = require('../source/services/clone/Meadow-Service-IndexPolicy.js');
const libConvergence = require('../source/services/clone/Meadow-Service-IndexConvergence.js');

const _Schema =
{
	TableName: 'Document',
	DefaultIdentifier: 'IDDocument',
	Columns:
	[
		{ Column: 'IDDocument',   DataType: 'ID'   },
		{ Column: 'GUIDDocument', DataType: 'GUID', Size: 36 },
		{ Column: 'Deleted',      DataType: 'Boolean' },
		{ Column: 'Name',         DataType: 'String', Size: 128 }
	]
};

const COMPOSITE = 'IX_M_SYNC_Document_Deleted_IDDocument';
const GUIDIDX = 'IX_M_SYNC_Document_GUIDDocument';

suite('Meadow Integration - IndexConvergence (live SQLite)',
	() =>
	{
		let _Fable = null;
		let _Provider = null;
		let _DbPath = '';

		setup((fDone) =>
		{
			_DbPath = libPath.join(libOs.tmpdir(), `mi-index-converge-${process.pid}-${_Fable ? 1 : 0}.sqlite`);
			if (libFs.existsSync(_DbPath)) { libFs.unlinkSync(_DbPath); }

			_Fable = new libFable({ Product: 'IndexConvergenceSmoke', SQLite: { SQLiteFilePath: _DbPath } });
			_Fable.serviceManager.addServiceType('MeadowSQLiteProvider', libMeadowConnectionSQLite);
			_Fable.serviceManager.instantiateServiceProvider('MeadowSQLiteProvider');

			_Fable.MeadowSQLiteProvider.connectAsync((pError) =>
			{
				if (pError) { return fDone(pError); }
				_Provider = _Fable.MeadowSQLiteProvider;
				// Create the table (real DDL) before each test.
				_Provider.db.exec(_Provider.generateCreateTableStatement(_Schema));
				return fDone();
			});
		});

		let converge = (pOptions, fCallback) =>
		{
			let tmpDesired = libIndexPolicy.resolveDesiredIndexes(_Schema, { StandardOperationalIndexes: true });
			libConvergence.convergeTableIndexes(_Provider, _Schema, tmpDesired,
				Object.assign({ PruneScope: 'managed', log: _Fable.log }, pOptions || {}), fCallback);
		};

		test('fresh table: creates the operational indexes (composite + non-unique GUID), drops nothing',
			(fDone) =>
			{
				converge({}, (pError, pResult) =>
				{
					if (pError) { return fDone(pError); }
					_Provider.introspectTableIndices('Document', (pIntrospectError, pActual) =>
					{
						try {
							if (pIntrospectError) { return fDone(pIntrospectError); }
							let tmpNames = pActual.map((pIndex) => { return pIndex.Name; });
							Expect(tmpNames, 'composite present').to.include(COMPOSITE);
							Expect(tmpNames, 'GUID index present').to.include(GUIDIDX);
							let tmpGUID = pActual.find((pIndex) => { return pIndex.Name === GUIDIDX; });
							Expect(tmpGUID.Unique, 'GUID index is non-unique').to.not.equal(true);
							Expect(pResult.dropped, 'nothing dropped on a fresh table').to.have.length(0);
							fDone();
						} catch (e) { fDone(e); }
					});
				});
			});

		test('managed prune: replaces a precursor [Deleted] index, leaves an unmanaged index alone',
			(fDone) =>
			{
				// Seed a precursor-style single-column index + an external/unmanaged one.
				_Provider.db.exec('CREATE INDEX IF NOT EXISTS "Deleted" ON "Document" ("Deleted")');
				_Provider.db.exec('CREATE INDEX IF NOT EXISTS "IX_dba_custom" ON "Document" ("Name")');

				converge({}, (pError, pResult) =>
				{
					if (pError) { return fDone(pError); }
					_Provider.introspectTableIndices('Document', (pIntrospectError, pActual) =>
					{
						try {
							if (pIntrospectError) { return fDone(pIntrospectError); }
							let tmpNames = pActual.map((pIndex) => { return pIndex.Name; });
							Expect(tmpNames, 'new composite created').to.include(COMPOSITE);
							Expect(tmpNames, 'precursor [Deleted] dropped (managed)').to.not.include('Deleted');
							Expect(tmpNames, 'unmanaged index untouched').to.include('IX_dba_custom');
							Expect(pResult.dropped, 'precursor was dropped').to.include('Deleted');
							fDone();
						} catch (e) { fDone(e); }
					});
				});
			});

		test('idempotent: a second convergence run creates and drops nothing',
			(fDone) =>
			{
				converge({}, (pFirstError) =>
				{
					if (pFirstError) { return fDone(pFirstError); }
					converge({}, (pError, pResult) =>
					{
						try {
							if (pError) { return fDone(pError); }
							Expect(pResult.created, 'nothing created on 2nd run').to.have.length(0);
							Expect(pResult.dropped, 'nothing dropped on 2nd run').to.have.length(0);
							fDone();
						} catch (e) { fDone(e); }
					});
				});
			});

		teardown(() =>
		{
			try { if (_Provider && _Provider.db) { _Provider.db.close(); } } catch (e) {}
			try { if (_DbPath && libFs.existsSync(_DbPath)) { libFs.unlinkSync(_DbPath); } } catch (e) {}
		});
	});
