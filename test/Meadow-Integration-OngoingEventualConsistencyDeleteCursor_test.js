/*
	Unit tests for the resumable (head/tail) delete cursor.

	Drives OngoingEventualConsistency.syncDeletedRecords with DeleteCursorStatePath
	set, simulating successive "runs" (each call re-reads the JSON state file, as a
	fresh container would). Verifies the tail drains across runs, the head pass
	picks up new high-id deletions, the caught-up steady state, and that state
	persists in the JSON file.

	Mock server serves the keyset deleted-page queries
	(FBV~Deleted~EQ~1[~FBV~IDBook~GT~N][~FBV~IDBook~LT~M]~FSF~IDBook~DESC~DESC).
*/

const Chai = require('chai');
const Expect = Chai.expect;

const libHTTP = require('http');
const libFS = require('fs');
const libOS = require('os');
const libPath = require('path');
const libFable = require('fable');
const libMeadowConnectionSQLite = require('meadow-connection-sqlite');

const libMeadowCloneRestClient = require('../source/services/clone/Meadow-Service-RestClient.js');
const libMeadowSync = require('../source/services/clone/Meadow-Service-Sync.js');

const MOCK_PORT = 18095;
const MOCK_BASE_URL = `http://localhost:${MOCK_PORT}/1.0/`;
const STATE_PATH = libPath.join(libOS.tmpdir(), `oec-delete-cursor-${process.pid}.json`);

const _BookSchema =
{
	TableName: 'Book',
	Columns:
	[
		{ Column: 'IDBook', DataType: 'int' },
		{ Column: 'GUIDBook', DataType: 'GUID' },
		{ Column: 'CreateDate', DataType: 'DateTime' },
		{ Column: 'CreatingIDUser', DataType: 'int' },
		{ Column: 'UpdateDate', DataType: 'DateTime' },
		{ Column: 'UpdatingIDUser', DataType: 'int' },
		{ Column: 'Deleted', DataType: 'int' },
		{ Column: 'DeleteDate', DataType: 'DateTime' },
		{ Column: 'DeletingIDUser', DataType: 'int' },
		{ Column: 'Title', DataType: 'String' }
	],
	MeadowSchema:
	{
		Scope: 'Book', DefaultIdentifier: 'IDBook', Domain: 'Default',
		Schema:
		[
			{ Column: 'IDBook', Type: 'AutoIdentity', Size: 'Default' },
			{ Column: 'GUIDBook', Type: 'AutoGUID', Size: '128' },
			{ Column: 'CreateDate', Type: 'CreateDate', Size: 'Default' },
			{ Column: 'CreatingIDUser', Type: 'CreateIDUser', Size: 'int' },
			{ Column: 'UpdateDate', Type: 'UpdateDate', Size: 'Default' },
			{ Column: 'UpdatingIDUser', Type: 'UpdateIDUser', Size: 'int' },
			{ Column: 'Deleted', Type: 'Deleted', Size: 'Default' },
			{ Column: 'DeleteDate', Type: 'DeleteDate', Size: 'Default' },
			{ Column: 'DeletingIDUser', Type: 'DeleteIDUser', Size: 'int' },
			{ Column: 'Title', Type: 'String', Size: '200' }
		],
		DefaultObject: { IDBook: 0, GUIDBook: '', CreateDate: null, CreatingIDUser: 0, UpdateDate: null, UpdatingIDUser: 0, Deleted: 0, DeleteDate: null, DeletingIDUser: 0, Title: '' },
		JsonSchema: { title: 'Book', type: 'object', properties: { IDBook: { type: 'integer' } }, required: ['IDBook'] }
	}
};

// Server-deleted ids: 10,20,...,100 (mutable so a test can add a new one).
let _ServerDeletedIDs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
function serverDeletedRecord(pID)
{
	return { IDBook: pID, GUIDBook: `GUID-${pID}`, Deleted: 1, DeleteDate: '2025-07-01T00:00:00.000Z', DeletingIDUser: 1, Title: `Deleted-${pID}` };
}

function createMockServer()
{
	return libHTTP.createServer((pRequest, pResponse) =>
	{
		const tmpURL = pRequest.url;
		pResponse.setHeader('Content-Type', 'application/json');

		const tmpMatch = tmpURL.match(/\/1\.0\/Books\/FilteredTo\/(.+?)\/(\d+)\/(\d+)(\?|$)/);
		if (tmpMatch && tmpMatch[1].indexOf('FBV~Deleted~EQ~1') > -1)
		{
			const tmpFilter = tmpMatch[1];
			const tmpOffset = parseInt(tmpMatch[2], 10) || 0;
			const tmpPageSize = parseInt(tmpMatch[3], 10) || 100;
			const tmpGT = tmpFilter.match(/FBV~IDBook~GT~(\d+)/);
			const tmpLT = tmpFilter.match(/FBV~IDBook~LT~(\d+)/);

			let tmpIDs = _ServerDeletedIDs.slice();
			if (tmpGT) { const n = parseInt(tmpGT[1], 10); tmpIDs = tmpIDs.filter((id) => id > n); }
			if (tmpLT) { const n = parseInt(tmpLT[1], 10); tmpIDs = tmpIDs.filter((id) => id < n); }
			tmpIDs.sort((a, b) => b - a); // DESC
			const tmpPage = tmpIDs.slice(tmpOffset, tmpOffset + tmpPageSize).map(serverDeletedRecord);
			pResponse.end(JSON.stringify(tmpPage));
			return;
		}

		pResponse.statusCode = 404;
		pResponse.end(JSON.stringify({ Error: `Unknown endpoint: ${tmpURL}` }));
	});
}

function createTestFable()
{
	const tmpFable = new libFable({ Product: 'OECDeleteCursorTest', MeadowProvider: 'SQLite', SQLite: { SQLiteFilePath: ':memory:' }, LogStreams: [{ streamtype: 'console', level: 'error' }] });
	tmpFable.ProgramConfiguration = {};
	return tmpFable;
}

function readState() { try { return JSON.parse(libFS.readFileSync(STATE_PATH, 'utf8')); } catch (e) { return {}; } }
function deletedCount(pFable) { return pFable.MeadowSQLiteProvider.db.prepare('SELECT COUNT(*) c FROM Book WHERE Deleted=1').get().c; }

suite
(
	'OngoingEventualConsistency resumable delete cursor',
	() =>
	{
		let _MockServer = null;
		let _Fable = null;
		let _Entity = null;

		suiteSetup((fDone) => { _MockServer = createMockServer(); _MockServer.listen(MOCK_PORT, fDone); });
		suiteTeardown((fDone) => { try { libFS.unlinkSync(STATE_PATH); } catch (e) {} if (_MockServer) { _MockServer.close(fDone); } else { return fDone(); } });

		setup((fDone) =>
		{
			_ServerDeletedIDs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
			try { libFS.unlinkSync(STATE_PATH); } catch (e) {}

			_Fable = createTestFable();
			_Fable.serviceManager.addServiceType('MeadowSQLiteProvider', libMeadowConnectionSQLite);
			_Fable.serviceManager.instantiateServiceProvider('MeadowSQLiteProvider');
			_Fable.MeadowSQLiteProvider.connectAsync((pErr) =>
			{
				if (pErr) return fDone(pErr);
				_Fable.MeadowSQLiteProvider.db.exec(`CREATE TABLE IF NOT EXISTS Book (
					IDBook INTEGER PRIMARY KEY AUTOINCREMENT, GUIDBook TEXT DEFAULT '', CreateDate TEXT DEFAULT '',
					CreatingIDUser INTEGER DEFAULT 0, UpdateDate TEXT DEFAULT '', UpdatingIDUser INTEGER DEFAULT 0,
					Deleted INTEGER DEFAULT 0, DeleteDate TEXT DEFAULT '', DeletingIDUser INTEGER DEFAULT 0, Title TEXT DEFAULT '');`);

				_Fable.serviceManager.addServiceType('MeadowCloneRestClient', libMeadowCloneRestClient);
				_Fable.serviceManager.instantiateServiceProvider('MeadowCloneRestClient', { ServerURL: MOCK_BASE_URL });
				_Fable.serviceManager.addServiceType('MeadowSync', libMeadowSync);
				// PageSize 3 + MaxRecordsPerEntity 3 => one page per "run" so we can watch it resume.
				_Fable.serviceManager.instantiateServiceProvider('MeadowSync',
					{ PageSize: 3, SyncDeletedRecords: true, BackSyncTimeLimit: 999999, MaxRecordsPerEntity: 3, DeleteCursorStatePath: STATE_PATH });
				_Fable.MeadowSync.SyncMode = 'OngoingEventualConsistency';
				_Fable.MeadowSync.SyncDeletedRecords = true;
				_Fable.MeadowSync.BackSyncTimeLimit = 999999;
				_Fable.MeadowSync.loadMeadowSchema({ Tables: { Book: _BookSchema } }, (pSchemaErr) =>
				{
					if (pSchemaErr) return fDone(pSchemaErr);
					_Entity = _Fable.MeadowSync.MeadowSyncEntities['Book'];
					_Entity.syncResults = { Created: 0, Updated: 0, Deleted: 0 };
					// Seed all 10 as ACTIVE so each can be flagged when the cursor reaches it.
					const tmpIns = _Fable.MeadowSQLiteProvider.db.prepare('INSERT INTO Book (IDBook, GUIDBook, Deleted, Title) VALUES (?, ?, 0, ?)');
					for (const id of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) { tmpIns.run(id, `GUID-${id}`, `Active-${id}`); }
					return fDone();
				});
			});
		});

		// Helper: run syncDeletedRecords once (a "run").
		function run(fNext) { _Entity.syncResults = { Created: 0, Updated: 0, Deleted: 0 }; _Entity.syncDeletedRecords(fNext); }

		test('drains the backlog across runs, resuming each time (no re-walk)', function (fDone)
		{
			this.timeout(20000);
			// 10 deleted, 3 per run → ~4 runs to drain.
			run(() =>
			{
				// Run 1: newest 3 (100,90,80) flagged; cursor advanced, not caught up.
				Expect(deletedCount(_Fable)).to.equal(3, 'run 1 flags newest 3');
				const s1 = readState().Book;
				Expect(s1).to.be.an('object');
				Expect(s1.HeadID).to.equal(100, 'head established at the top');
				Expect(s1.TailID).to.equal(80, 'tail advanced to lowest examined');
				Expect(s1.CaughtUp).to.equal(false);

				run(() =>
				{
					Expect(deletedCount(_Fable)).to.equal(6, 'run 2 resumes: +3 (70,60,50)');
					Expect(readState().Book.TailID).to.equal(50);
					run(() =>
					{
						Expect(deletedCount(_Fable)).to.equal(9, 'run 3 resumes: +3 (40,30,20)');
						run(() =>
						{
							// Run 4: only 10 left → flagged, then exhausted → caught up.
							Expect(deletedCount(_Fable)).to.equal(10, 'run 4 flags the last one');
							const s4 = readState().Book;
							Expect(s4.CaughtUp).to.equal(true, 'tail reached the bottom → caught up');
							return fDone();
						});
					});
				});
			});
		});

		test('once caught up, the head pass picks up a new high-id deletion cheaply', function (fDone)
		{
			this.timeout(20000);
			// Drain fully first (4 runs).
			run(() => run(() => run(() => run(() =>
			{
				Expect(deletedCount(_Fable)).to.equal(10);
				Expect(readState().Book.CaughtUp).to.equal(true);
				const tmpHeadBefore = readState().Book.HeadID;
				Expect(tmpHeadBefore).to.equal(100);

				// A new record (id 110) is created and deleted on the server; seed it locally as active.
				_ServerDeletedIDs.push(110);
				_Fable.MeadowSQLiteProvider.db.prepare('INSERT INTO Book (IDBook, GUIDBook, Deleted, Title) VALUES (110, ?, 0, ?)').run('GUID-110', 'Active-110');

				run(() =>
				{
					// Head pass (id > 100) catches 110; tail stays caught up.
					Expect(_Fable.MeadowSQLiteProvider.db.prepare('SELECT Deleted FROM Book WHERE IDBook=110').get().Deleted).to.equal(1, 'new high-id deletion flagged by head pass');
					Expect(readState().Book.HeadID).to.equal(110, 'head advanced to the new max');
					Expect(readState().Book.CaughtUp).to.equal(true, 'still caught up');
					return fDone();
				});
			}))));
		});
	}
);
