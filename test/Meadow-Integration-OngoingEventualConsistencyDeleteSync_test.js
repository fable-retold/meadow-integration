/*
	Unit tests for OngoingEventualConsistency delete reconciliation.

	Focused on the correctness fix: deleted server rows are matched to local
	rows by GUID (not identity), so a cloned database that holds a record under
	a DIFFERENT auto-increment id (the real-world failure mode) still gets the
	row flagged deleted instead of attempting a CREATE that collides on the GUID
	unique index.

	Also covers: already-deleted rows are skipped, rows never synced live are
	skipped (not created), and the structured report receives the real count.

	Uses a mock HTTP server for the deleted-record API and an in-memory SQLite
	database as the local clone destination.  Calls syncDeletedRecords() directly
	so the forward-sync phases don't need mocking.
*/

const Chai = require('chai');
const Expect = Chai.expect;

const libHTTP = require('http');
const libFable = require('fable');
const libMeadowConnectionSQLite = require('meadow-connection-sqlite');

const libMeadowCloneRestClient = require('../source/services/clone/Meadow-Service-RestClient.js');
const libMeadowSync = require('../source/services/clone/Meadow-Service-Sync.js');

const MOCK_PORT = 18097;
const MOCK_BASE_URL = `http://localhost:${MOCK_PORT}/1.0/`;

const _BookSchema =
{
	TableName: 'Book',
	Columns:
	[
		{ Column: 'IDBook',          DataType: 'int' },
		{ Column: 'GUIDBook',        DataType: 'GUID' },
		{ Column: 'CreateDate',      DataType: 'DateTime' },
		{ Column: 'CreatingIDUser',  DataType: 'int' },
		{ Column: 'UpdateDate',      DataType: 'DateTime' },
		{ Column: 'UpdatingIDUser',  DataType: 'int' },
		{ Column: 'Deleted',         DataType: 'int' },
		{ Column: 'DeleteDate',      DataType: 'DateTime' },
		{ Column: 'DeletingIDUser',  DataType: 'int' },
		{ Column: 'Title',           DataType: 'String' }
	],
	MeadowSchema:
	{
		Scope: 'Book',
		DefaultIdentifier: 'IDBook',
		Domain: 'Default',
		Schema:
		[
			{ Column: 'IDBook',          Type: 'AutoIdentity', Size: 'Default' },
			{ Column: 'GUIDBook',        Type: 'AutoGUID',     Size: '128'     },
			{ Column: 'CreateDate',      Type: 'CreateDate',   Size: 'Default' },
			{ Column: 'CreatingIDUser',  Type: 'CreateIDUser', Size: 'int'     },
			{ Column: 'UpdateDate',      Type: 'UpdateDate',   Size: 'Default' },
			{ Column: 'UpdatingIDUser',  Type: 'UpdateIDUser', Size: 'int'     },
			{ Column: 'Deleted',         Type: 'Deleted',      Size: 'Default' },
			{ Column: 'DeleteDate',      Type: 'DeleteDate',   Size: 'Default' },
			{ Column: 'DeletingIDUser',  Type: 'DeleteIDUser', Size: 'int'     },
			{ Column: 'Title',           Type: 'String',       Size: '200'     }
		],
		DefaultObject:
		{
			IDBook: 0, GUIDBook: '', CreateDate: null, CreatingIDUser: 0,
			UpdateDate: null, UpdatingIDUser: 0, Deleted: 0,
			DeleteDate: null, DeletingIDUser: 0, Title: ''
		},
		JsonSchema:
		{
			title: 'Book', type: 'object',
			properties:
			{
				IDBook: { type: 'integer' }, GUIDBook: { type: 'string' },
				CreateDate: { type: 'string' }, CreatingIDUser: { type: 'integer' },
				UpdateDate: { type: 'string' }, UpdatingIDUser: { type: 'integer' },
				Deleted: { type: 'boolean' }, DeleteDate: { type: 'string' },
				DeletingIDUser: { type: 'integer' }, Title: { type: 'string' }
			},
			required: ['IDBook']
		}
	}
};

// Server-side deleted set (ids 100-103).  Returned newest-id-first.
function makeServerDeleted(pID)
{
	return {
		IDBook: pID,
		GUIDBook: `GUID-BOOK-${pID}`,
		CreateDate: '2025-01-01T00:00:00.000Z',
		CreatingIDUser: 1,
		UpdateDate: '2025-06-15T12:00:00.000Z',
		UpdatingIDUser: 1,
		Deleted: 1,
		DeleteDate: '2025-07-01T00:00:00.000Z',
		DeletingIDUser: 7,
		Title: `Server-Deleted-${pID}`
	};
}
const SERVER_DELETED = [ makeServerDeleted(100), makeServerDeleted(101), makeServerDeleted(102), makeServerDeleted(103) ];

function createMockServer()
{
	return libHTTP.createServer(
		(pRequest, pResponse) =>
		{
			const tmpURL = pRequest.url;
			pResponse.setHeader('Content-Type', 'application/json');

			// Count of deleted records
			if (tmpURL.match(/\/1\.0\/Books\/Count\/FilteredTo\/FBV~Deleted~EQ~1/))
			{
				pResponse.end(JSON.stringify({ Count: SERVER_DELETED.length }));
				return;
			}

			// Deleted page, newest-id first (DESC) — this is the new ordering.
			if (tmpURL.match(/\/1\.0\/Books\/FilteredTo\/FBV~Deleted~EQ~1~FSF~IDBook~DESC~DESC/))
			{
				const tmpParts = tmpURL.split('?')[0].split('/');
				const tmpOffset = parseInt(tmpParts[tmpParts.length - 2], 10) || 0;
				const tmpPageSize = parseInt(tmpParts[tmpParts.length - 1], 10) || 100;
				const tmpSortedDesc = SERVER_DELETED.slice().sort((a, b) => b.IDBook - a.IDBook);
				pResponse.end(JSON.stringify(tmpSortedDesc.slice(tmpOffset, tmpOffset + tmpPageSize)));
				return;
			}

			pResponse.statusCode = 404;
			pResponse.end(JSON.stringify({ Error: `Unknown endpoint: ${tmpURL}` }));
		});
}

function createTestFable()
{
	const tmpFable = new libFable(
		{
			Product: 'OECDeleteSyncTest',
			ProductVersion: '1.0.0',
			MeadowProvider: 'SQLite',
			SQLite: { SQLiteFilePath: ':memory:' },
			LogStreams: [{ streamtype: 'console', level: 'error' }]
		});
	tmpFable.ProgramConfiguration = {};
	return tmpFable;
}

function setupSQLite(pFable, fCallback)
{
	pFable.serviceManager.addServiceType('MeadowSQLiteProvider', libMeadowConnectionSQLite);
	pFable.serviceManager.instantiateServiceProvider('MeadowSQLiteProvider');
	pFable.MeadowSQLiteProvider.connectAsync(
		(pError) =>
		{
			if (pError) return fCallback(pError);
			pFable.MeadowSQLiteProvider.db.exec(`
				CREATE TABLE IF NOT EXISTS Book (
					IDBook INTEGER PRIMARY KEY AUTOINCREMENT,
					GUIDBook TEXT DEFAULT '',
					CreateDate TEXT DEFAULT '',
					CreatingIDUser INTEGER DEFAULT 0,
					UpdateDate TEXT DEFAULT '',
					UpdatingIDUser INTEGER DEFAULT 0,
					Deleted INTEGER DEFAULT 0,
					DeleteDate TEXT DEFAULT '',
					DeletingIDUser INTEGER DEFAULT 0,
					Title TEXT DEFAULT ''
				);
			`);
			return fCallback();
		});
}

function seedBook(pFable, pID, pGUID, pDeleted, pTitle)
{
	pFable.MeadowSQLiteProvider.db.prepare(
		'INSERT INTO Book (IDBook, GUIDBook, Deleted, DeleteDate, Title) VALUES (?, ?, ?, ?, ?)')
		.run(pID, pGUID, pDeleted, pDeleted ? '2025-07-01T00:00:00.000Z' : '', pTitle);
}

function allBooks(pFable)
{
	return pFable.MeadowSQLiteProvider.db.prepare('SELECT * FROM Book ORDER BY IDBook').all();
}
function bookByGUID(pFable, pGUID)
{
	return pFable.MeadowSQLiteProvider.db.prepare('SELECT * FROM Book WHERE GUIDBook = ?').all(pGUID);
}
function bookByID(pFable, pID)
{
	return pFable.MeadowSQLiteProvider.db.prepare('SELECT * FROM Book WHERE IDBook = ?').get(pID);
}

suite
(
	'OngoingEventualConsistency delete reconciliation',
	() =>
	{
		let _MockServer = null;

		suiteSetup((fDone) => { _MockServer = createMockServer(); _MockServer.listen(MOCK_PORT, fDone); });
		suiteTeardown((fDone) => { if (_MockServer) { _MockServer.close(fDone); } else { return fDone(); } });

		let _Fable = null;
		let _Entity = null;

		setup
		(
			(fDone) =>
			{
				_Fable = createTestFable();
				setupSQLite(_Fable,
					(pError) =>
					{
						if (pError) return fDone(pError);

						_Fable.serviceManager.addServiceType('MeadowCloneRestClient', libMeadowCloneRestClient);
						_Fable.serviceManager.instantiateServiceProvider('MeadowCloneRestClient', { ServerURL: MOCK_BASE_URL });

						// Wire through MeadowSync so fable.Meadow is established and the
						// entity is built/initialized exactly as in production.
						_Fable.serviceManager.addServiceType('MeadowSync', libMeadowSync);
						_Fable.serviceManager.instantiateServiceProvider('MeadowSync',
							{ PageSize: 100, SyncDeletedRecords: true, BackSyncTimeLimit: 999999 });
						_Fable.MeadowSync.SyncMode = 'OngoingEventualConsistency';
						_Fable.MeadowSync.SyncDeletedRecords = true;
						_Fable.MeadowSync.BackSyncTimeLimit = 999999;

						_Fable.MeadowSync.loadMeadowSchema({ Tables: { Book: _BookSchema } },
							(pSchemaError) =>
							{
								if (pSchemaError) return fDone(pSchemaError);
								_Entity = _Fable.MeadowSync.MeadowSyncEntities['Book'];
								_Entity.syncResults = { Created: 0, Updated: 0, Deleted: 0 };

								// Seed local clone state AFTER the table exists. Server has
								// deleted ids 100, 101, 102, 103.
								//   id 101 active            -> matches a deleted id -> mark deleted
								//   id 102 already deleted   -> skip
								//   id 100 absent            -> not in clone -> skip (no create)
								//   id 777 active, GUID twin -> shares GUID-BOOK-103 with the deleted
								//                               id 103 but under a DIFFERENT id. MUST
								//                               NOT be touched (the duplicate-GUID trap).
								//   id 50  unrelated active  -> untouched
								seedBook(_Fable, 101, 'GUID-BOOK-101', 0, 'Normal-101');
								seedBook(_Fable, 102, 'GUID-BOOK-102', 1, 'Already-102');
								seedBook(_Fable, 777, 'GUID-BOOK-103', 0, 'GuidTwin-of-deleted-103');
								seedBook(_Fable, 50,  'GUID-BOOK-50',  0, 'Untouched-50');

								return fDone();
							});
					});
			}
		);

		test
		(
			'flags the row whose id matches the server-deleted id, and NEVER a GUID twin under a different id',
			(fDone) =>
			{
				_Entity.syncDeletedRecords(
					() =>
					{
						// id 101 matched a server-deleted id -> flagged deleted, DeleteDate stamped
						const tmp101 = bookByID(_Fable, 101);
						Expect(tmp101.Deleted).to.equal(1, 'id 101 flagged deleted');
						Expect(tmp101.DeleteDate).to.be.a('string').and.not.equal('', 'DeleteDate stamped on delete');

						// THE SAFETY CASE: id 777 shares GUID-BOOK-103 with the server-deleted id
						// 103, but is a DIFFERENT, active record. It must be left untouched —
						// deleting it would be data corruption from a duplicate GUID.
						const tmp777 = bookByID(_Fable, 777);
						Expect(tmp777.Deleted).to.equal(0, 'GUID twin under a different id MUST NOT be deleted');

						// No local row at the server-deleted ids 100 or 103 was created.
						Expect(bookByID(_Fable, 100)).to.be.undefined;
						Expect(bookByID(_Fable, 103)).to.be.undefined;
						return fDone();
					});
			}
		);

		test
		(
			'skips already-deleted and not-in-clone rows; creates nothing; reports the real count',
			(fDone) =>
			{
				_Entity.syncDeletedRecords(
					() =>
					{
						// id 102 already deleted — still exactly one row, still deleted
						const tmp102 = bookByGUID(_Fable, 'GUID-BOOK-102');
						Expect(tmp102.length).to.equal(1);
						Expect(tmp102[0].Deleted).to.equal(1);

						// Unrelated active row untouched
						Expect(bookByID(_Fable, 50).Deleted).to.equal(0);

						// No rows created at all — total stays at the 4 seeded (101, 102, 777, 50)
						Expect(allBooks(_Fable).length).to.equal(4, 'no ghost rows created');

						// Only id 101 was newly flagged (102 already; 100/103 not in clone)
						Expect(_Entity.syncResults.Deleted).to.equal(1, 'reports exactly the newly-flagged count');
						return fDone();
					});
			}
		);
	}
);
