/*
	Unit tests for Clone Delete Sync

	Validates that the clone sync correctly synchronizes deleted records
	(Deleted=1) from a source API to the local database.

	Uses a mock HTTP server to simulate meadow-endpoints API responses
	and an in-memory SQLite database as the local clone destination.
*/

const Chai = require('chai');
const Expect = Chai.expect;

const libHTTP = require('http');
const libFable = require('fable');
const libMeadow = require('meadow');
const libMeadowConnectionSQLite = require('meadow-connection-sqlite');

const libMeadowCloneRestClient = require('../source/services/clone/Meadow-Service-RestClient.js');
const libMeadowSync = require('../source/services/clone/Meadow-Service-Sync.js');
const libMeadowSyncEntityOngoing = require('../source/services/clone/Meadow-Service-Sync-Entity-Ongoing.js');

// ── Test Constants ──────────────────────────────────────────────────────────────

const MOCK_PORT = 18099;
const MOCK_BASE_URL = `http://localhost:${MOCK_PORT}/1.0/`;

// ── Book Entity Schema (Extended Format) ────────────────────────────────────────

const _BookExtendedSchema =
{
	Tables:
	{
		Book:
		{
			TableName: 'Book',
			Columns:
			[
				{ Column: 'IDBook',          DataType: 'ID' },
				{ Column: 'GUIDBook',        DataType: 'GUID' },
				{ Column: 'CreateDate',      DataType: 'DateTime' },
				{ Column: 'CreatingIDUser',  DataType: 'Numeric' },
				{ Column: 'UpdateDate',      DataType: 'DateTime' },
				{ Column: 'UpdatingIDUser',  DataType: 'Numeric' },
				{ Column: 'Deleted',         DataType: 'Boolean' },
				{ Column: 'DeleteDate',      DataType: 'DateTime' },
				{ Column: 'DeletingIDUser',  DataType: 'Numeric' },
				{ Column: 'Title',           DataType: 'String' },
				{ Column: 'Type',            DataType: 'String' },
				{ Column: 'Genre',           DataType: 'String' },
				{ Column: 'PublicationYear', DataType: 'Numeric' }
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
					{ Column: 'Title',           Type: 'String',       Size: '200'     },
					{ Column: 'Type',            Type: 'String',       Size: '32'      },
					{ Column: 'Genre',           Type: 'String',       Size: '128'     },
					{ Column: 'PublicationYear', Type: 'Integer',      Size: 'int'     }
				],
				DefaultObject:
				{
					IDBook: 0, GUIDBook: '', CreateDate: null, CreatingIDUser: 0,
					UpdateDate: null, UpdatingIDUser: 0, Deleted: 0,
					DeleteDate: null, DeletingIDUser: 0,
					Title: '', Type: '', Genre: '', PublicationYear: 0
				},
				JsonSchema:
				{
					title: 'Book',
					type: 'object',
					properties:
					{
						IDBook:          { type: 'integer' },
						GUIDBook:        { type: 'string'  },
						CreateDate:      { type: 'string'  },
						CreatingIDUser:  { type: 'integer' },
						UpdateDate:      { type: 'string'  },
						UpdatingIDUser:  { type: 'integer' },
						Deleted:         { type: 'boolean' },
						DeleteDate:      { type: 'string'  },
						DeletingIDUser:  { type: 'integer' },
						Title:           { type: 'string'  },
						Type:            { type: 'string'  },
						Genre:           { type: 'string'  },
						PublicationYear: { type: 'integer' }
					},
					required: ['IDBook']
				}
			}
		}
	}
};

// ── Test Data ───────────────────────────────────────────────────────────────────

function makeBookRecord(pID, pTitle, pGenre, pDeleted)
{
	return {
		IDBook: pID,
		GUIDBook: `GUID-BOOK-${pID}`,
		CreateDate: '2025-01-01T00:00:00.000Z',
		CreatingIDUser: 1,
		UpdateDate: '2025-06-15T12:00:00.000Z',
		UpdatingIDUser: 1,
		Deleted: pDeleted ? 1 : 0,
		DeleteDate: pDeleted ? '2025-07-01T00:00:00.000Z' : '',
		DeletingIDUser: pDeleted ? 1 : 0,
		Title: pTitle,
		Type: 'Fiction',
		Genre: pGenre,
		PublicationYear: 2020 + pID
	};
}

// 5 active records, 3 deleted records
const ACTIVE_BOOKS =
[
	makeBookRecord(1, 'The Great Adventure', 'Adventure', false),
	makeBookRecord(2, 'Mystery at Midnight', 'Mystery', false),
	makeBookRecord(3, 'Science Frontiers', 'Science', false),
	makeBookRecord(4, 'Love in Paris', 'Romance', false),
	makeBookRecord(5, 'Code Warriors', 'Technology', false)
];

const DELETED_BOOKS =
[
	makeBookRecord(6, 'Forgotten Tales', 'Fantasy', true),
	makeBookRecord(7, 'Lost Horizons', 'Travel', true),
	makeBookRecord(8, 'Discontinued Edition', 'Reference', true)
];

const ALL_BOOKS = ACTIVE_BOOKS.concat(DELETED_BOOKS);

// ── Mock HTTP Server ────────────────────────────────────────────────────────────
// Simulates meadow-endpoints API responses for the Book entity.

let _MockServerData =
{
	ActiveBooks: ACTIVE_BOOKS,
	DeletedBooks: DELETED_BOOKS,
	// When true, simulate old API: FBV~Deleted~EQ~1 returns 0 unless ?includeDeleted=true is present
	SimulateOldAPI: false
};

function createMockServer()
{
	return libHTTP.createServer(
		(pRequest, pResponse) =>
		{
			let tmpURL = pRequest.url;
			let tmpBody = '';

			pResponse.setHeader('Content-Type', 'application/json');

			// GET /1.0/Book/Max/IDBook
			if (tmpURL.match(/\/1\.0\/Book\/Max\/IDBook/))
			{
				let tmpAllBooks = _MockServerData.ActiveBooks.concat(_MockServerData.DeletedBooks);
				let tmpMaxID = 0;
				for (let i = 0; i < tmpAllBooks.length; i++)
				{
					if (tmpAllBooks[i].IDBook > tmpMaxID)
					{
						tmpMaxID = tmpAllBooks[i].IDBook;
					}
				}
				pResponse.end(JSON.stringify({ IDBook: tmpMaxID }));
				return;
			}

			// GET /1.0/Book/Max/UpdateDate
			if (tmpURL.match(/\/1\.0\/Book\/Max\/UpdateDate/))
			{
				pResponse.end(JSON.stringify({ UpdateDate: '2025-06-15T12:00:00.000Z' }));
				return;
			}

			// GET /1.0/Books/Count/FilteredTo/FBV~Deleted~EQ~1
			if (tmpURL.match(/\/1\.0\/Books\/Count\/FilteredTo\/FBV~Deleted~EQ~1/))
			{
				// Simulate old API: return 0 unless ?includeDeleted=true is present
				if (_MockServerData.SimulateOldAPI && tmpURL.indexOf('includeDeleted=true') < 0)
				{
					pResponse.end(JSON.stringify({ Count: 0 }));
					return;
				}
				pResponse.end(JSON.stringify({ Count: _MockServerData.DeletedBooks.length }));
				return;
			}

			// GET /1.0/Books/Count/FilteredTo/<other filter>
			if (tmpURL.match(/\/1\.0\/Books\/Count\/FilteredTo\//))
			{
				// For UpdateDate-based filters, return the count of all active records
				pResponse.end(JSON.stringify({ Count: _MockServerData.ActiveBooks.length }));
				return;
			}

			// GET /1.0/Books/Count
			if (tmpURL.match(/\/1\.0\/Books\/Count$/))
			{
				pResponse.end(JSON.stringify({ Count: _MockServerData.ActiveBooks.length }));
				return;
			}

			// GET /1.0/Books/FilteredTo/FBV~Deleted~EQ~1~FSF~IDBook~ASC~ASC/{offset}/{pageSize}
			if (tmpURL.match(/\/1\.0\/Books\/FilteredTo\/FBV~Deleted~EQ~1~FSF~IDBook~ASC~ASC/))
			{
				// Simulate old API: return empty unless ?includeDeleted=true is present
				if (_MockServerData.SimulateOldAPI && tmpURL.indexOf('includeDeleted=true') < 0)
				{
					pResponse.end(JSON.stringify([]));
					return;
				}
				let tmpParts = tmpURL.split('?')[0].split('/');
				let tmpOffset = parseInt(tmpParts[tmpParts.length - 2]) || 0;
				let tmpPageSize = parseInt(tmpParts[tmpParts.length - 1]) || 100;
				let tmpPage = _MockServerData.DeletedBooks.slice(tmpOffset, tmpOffset + tmpPageSize);
				pResponse.end(JSON.stringify(tmpPage));
				return;
			}

			// GET /1.0/Books/FilteredTo/FBV~IDBook~GT~{id}~FSF~IDBook~ASC~ASC/{offset}/{pageSize}
			// Also handles FBV~UpdateDate~GT~ filter patterns
			if (tmpURL.match(/\/1\.0\/Books\/FilteredTo\//))
			{
				let tmpParts = tmpURL.split('/');
				let tmpOffset = parseInt(tmpParts[tmpParts.length - 2]) || 0;
				let tmpPageSize = parseInt(tmpParts[tmpParts.length - 1]) || 100;

				// Extract the filter to determine what records to return
				let tmpFilter = tmpParts[4] || '';

				// Check if it's an ID-based filter
				let tmpIDMatch = tmpFilter.match(/FBV~IDBook~GT~(\d+)/);
				let tmpFilteredBooks;

				if (tmpIDMatch)
				{
					let tmpMinID = parseInt(tmpIDMatch[1]);
					tmpFilteredBooks = _MockServerData.ActiveBooks.filter(
						(pBook) => { return pBook.IDBook > tmpMinID; });
				}
				else
				{
					// Default: return active books (e.g. for UpdateDate filters)
					tmpFilteredBooks = _MockServerData.ActiveBooks;
				}

				let tmpPage = tmpFilteredBooks.slice(tmpOffset, tmpOffset + tmpPageSize);
				pResponse.end(JSON.stringify(tmpPage));
				return;
			}

			// Fallback — 404
			pResponse.statusCode = 404;
			pResponse.end(JSON.stringify({ Error: `Unknown endpoint: ${tmpURL}` }));
		});
}

// ── Test Helpers ────────────────────────────────────────────────────────────────

function createTestFable()
{
	let tmpFable = new libFable(
		{
			Product: 'CloneDeleteSyncTest',
			ProductVersion: '1.0.0',
			MeadowProvider: 'SQLite',
			SQLite: { SQLiteFilePath: ':memory:' },
			LogStreams: [{ streamtype: 'console', level: 'error' }]
		});

	// MeadowSync expects ProgramConfiguration to exist (normally set by CLI utility)
	tmpFable.ProgramConfiguration = {};

	return tmpFable;
}

function setupSQLiteProvider(pFable, fCallback)
{
	pFable.serviceManager.addServiceType('MeadowSQLiteProvider', libMeadowConnectionSQLite);
	pFable.serviceManager.instantiateServiceProvider('MeadowSQLiteProvider');
	pFable.MeadowSQLiteProvider.connectAsync(
		(pError) =>
		{
			if (pError)
			{
				return fCallback(pError);
			}

			// Create the Book table manually so the sync has somewhere to write
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
					Title TEXT DEFAULT '',
					Type TEXT DEFAULT '',
					Genre TEXT DEFAULT '',
					PublicationYear INTEGER DEFAULT 0
				);
			`);

			return fCallback();
		});
}

function setupSyncServices(pFable, pSyncMode, pSyncDeletedRecords, fCallback, pSyncEntityOptions)
{
	pFable.serviceManager.addServiceType('MeadowCloneRestClient', libMeadowCloneRestClient);
	pFable.serviceManager.instantiateServiceProvider('MeadowCloneRestClient',
		{
			ServerURL: MOCK_BASE_URL
		});

	let tmpSyncOptions =
		{
			PageSize: 100,
			SyncDeletedRecords: pSyncDeletedRecords
		};

	if (pSyncEntityOptions)
	{
		tmpSyncOptions.SyncEntityOptions = pSyncEntityOptions;
	}

	pFable.serviceManager.addServiceType('MeadowSync', libMeadowSync);
	pFable.serviceManager.instantiateServiceProvider('MeadowSync', tmpSyncOptions);

	pFable.MeadowSync.SyncMode = pSyncMode;

	pFable.MeadowSync.loadMeadowSchema(_BookExtendedSchema,
		(pError) =>
		{
			return fCallback(pError);
		});
}

function getLocalBooks(pFable)
{
	return pFable.MeadowSQLiteProvider.db
		.prepare('SELECT * FROM Book ORDER BY IDBook')
		.all();
}

function getLocalDeletedBooks(pFable)
{
	return pFable.MeadowSQLiteProvider.db
		.prepare('SELECT * FROM Book WHERE Deleted = 1 ORDER BY IDBook')
		.all();
}

function getLocalActiveBooks(pFable)
{
	return pFable.MeadowSQLiteProvider.db
		.prepare('SELECT * FROM Book WHERE Deleted = 0 ORDER BY IDBook')
		.all();
}

// ── Test Suite ──────────────────────────────────────────────────────────────────

suite
(
	'Clone Delete Sync',
	() =>
	{
		let _MockServer = null;

		suiteSetup
		(
			(fDone) =>
			{
				_MockServer = createMockServer();
				_MockServer.listen(MOCK_PORT,
					() =>
					{
						return fDone();
					});
			}
		);

		suiteTeardown
		(
			(fDone) =>
			{
				if (_MockServer)
				{
					_MockServer.close(fDone);
				}
				else
				{
					return fDone();
				}
			}
		);

		// ── Initial Sync with SyncDeletedRecords=true ───────────────────────

		suite
		(
			'Initial Sync with SyncDeletedRecords=true',
			() =>
			{
				let _Fable = null;

				setup
				(
					(fDone) =>
					{
						// Reset mock data to full set
						_MockServerData.ActiveBooks = ACTIVE_BOOKS.slice();
						_MockServerData.DeletedBooks = DELETED_BOOKS.slice();

						_Fable = createTestFable();
						setupSQLiteProvider(_Fable,
							(pError) =>
							{
								if (pError) return fDone(pError);
								setupSyncServices(_Fable, 'Initial', true, fDone);
							});
					}
				);

				test
				(
					'should sync active and deleted records',
					(fDone) =>
					{
						_Fable.MeadowSync.syncAll(
							(pError) =>
							{
								Expect(pError).to.not.exist;

								let tmpAllLocal = getLocalBooks(_Fable);
								let tmpDeletedLocal = getLocalDeletedBooks(_Fable);
								let tmpActiveLocal = getLocalActiveBooks(_Fable);

								Expect(tmpAllLocal.length).to.equal(8,
									`Expected 8 total records, got ${tmpAllLocal.length}`);
								Expect(tmpActiveLocal.length).to.equal(5,
									`Expected 5 active records, got ${tmpActiveLocal.length}`);
								Expect(tmpDeletedLocal.length).to.equal(3,
									`Expected 3 deleted records, got ${tmpDeletedLocal.length}`);

								// Verify deleted record IDs
								let tmpDeletedIDs = tmpDeletedLocal.map((r) => r.IDBook);
								Expect(tmpDeletedIDs).to.include(6);
								Expect(tmpDeletedIDs).to.include(7);
								Expect(tmpDeletedIDs).to.include(8);

								// Verify deleted records have correct data
								let tmpBook6 = tmpDeletedLocal.find((r) => r.IDBook === 6);
								Expect(tmpBook6.Title).to.equal('Forgotten Tales');
								Expect(tmpBook6.Deleted).to.equal(1);

								return fDone();
							});
					}
				);
			}
		);

		// ── Initial Sync with SyncDeletedRecords=false ──────────────────────

		suite
		(
			'Initial Sync with SyncDeletedRecords=false',
			() =>
			{
				let _Fable = null;

				setup
				(
					(fDone) =>
					{
						_MockServerData.ActiveBooks = ACTIVE_BOOKS.slice();
						_MockServerData.DeletedBooks = DELETED_BOOKS.slice();

						_Fable = createTestFable();
						setupSQLiteProvider(_Fable,
							(pError) =>
							{
								if (pError) return fDone(pError);
								setupSyncServices(_Fable, 'Initial', false, fDone);
							});
					}
				);

				test
				(
					'should only sync active records when SyncDeletedRecords is false',
					(fDone) =>
					{
						_Fable.MeadowSync.syncAll(
							(pError) =>
							{
								Expect(pError).to.not.exist;

								let tmpAllLocal = getLocalBooks(_Fable);
								let tmpDeletedLocal = getLocalDeletedBooks(_Fable);

								Expect(tmpAllLocal.length).to.equal(5,
									`Expected 5 total records (no deleted), got ${tmpAllLocal.length}`);
								Expect(tmpDeletedLocal.length).to.equal(0,
									`Expected 0 deleted records, got ${tmpDeletedLocal.length}`);

								return fDone();
							});
					}
				);
			}
		);

		// ── Ongoing Sync with SyncDeletedRecords=true ───────────────────────

		suite
		(
			'Ongoing Sync with SyncDeletedRecords=true',
			() =>
			{
				let _Fable = null;

				setup
				(
					(fDone) =>
					{
						_MockServerData.ActiveBooks = ACTIVE_BOOKS.slice();
						_MockServerData.DeletedBooks = DELETED_BOOKS.slice();

						_Fable = createTestFable();
						setupSQLiteProvider(_Fable,
							(pError) =>
							{
								if (pError) return fDone(pError);
								setupSyncServices(_Fable, 'Ongoing', true, fDone);
							});
					}
				);

				test
				(
					'should sync active and deleted records via ongoing strategy',
					(fDone) =>
					{
						_Fable.MeadowSync.syncAll(
							(pError) =>
							{
								Expect(pError).to.not.exist;

								let tmpAllLocal = getLocalBooks(_Fable);
								let tmpDeletedLocal = getLocalDeletedBooks(_Fable);
								let tmpActiveLocal = getLocalActiveBooks(_Fable);

								Expect(tmpAllLocal.length).to.equal(8,
									`Expected 8 total records, got ${tmpAllLocal.length}`);
								Expect(tmpActiveLocal.length).to.equal(5,
									`Expected 5 active records, got ${tmpActiveLocal.length}`);
								Expect(tmpDeletedLocal.length).to.equal(3,
									`Expected 3 deleted records, got ${tmpDeletedLocal.length}`);

								// Verify deleted record data
								let tmpBook7 = tmpDeletedLocal.find((r) => r.IDBook === 7);
								Expect(tmpBook7.Title).to.equal('Lost Horizons');
								Expect(tmpBook7.Deleted).to.equal(1);

								return fDone();
							});
					}
				);
			}
		);

		// ── Ongoing Sync: records deleted after initial sync ────────────────

		suite
		(
			'Records deleted after initial sync are picked up on ongoing sync',
			() =>
			{
				let _Fable = null;

				test
				(
					'should detect and sync newly-deleted records',
					function (fDone)
					{
						// Use a generous timeout for the two-phase sync
						this.timeout(10000);

						// Phase 1: Initial sync with no deleted records
						_MockServerData.ActiveBooks = ALL_BOOKS.slice(0, 8).map(
							(pBook) =>
							{
								return Object.assign({}, pBook, { Deleted: 0, DeleteDate: '', DeletingIDUser: 0 });
							});
						_MockServerData.DeletedBooks = [];

						_Fable = createTestFable();
						setupSQLiteProvider(_Fable,
							(pSetupError) =>
							{
								if (pSetupError) return fDone(pSetupError);
								setupSyncServices(_Fable, 'Initial', false,
									(pSchemaError) =>
									{
										if (pSchemaError) return fDone(pSchemaError);

										_Fable.MeadowSync.syncAll(
											(pSyncError) =>
											{
												Expect(pSyncError).to.not.exist;

												let tmpAfterInitial = getLocalBooks(_Fable);
												Expect(tmpAfterInitial.length).to.equal(8,
													`Expected 8 records after initial sync, got ${tmpAfterInitial.length}`);

												let tmpDeletedAfterInitial = getLocalDeletedBooks(_Fable);
												Expect(tmpDeletedAfterInitial.length).to.equal(0,
													`Expected 0 deleted after initial, got ${tmpDeletedAfterInitial.length}`);

												// Phase 2: Now mark records 3 and 5 as deleted on the source
												_MockServerData.ActiveBooks = [
													ACTIVE_BOOKS[0], // ID 1
													ACTIVE_BOOKS[1], // ID 2
													ACTIVE_BOOKS[3], // ID 4
													makeBookRecord(6, 'Forgotten Tales', 'Fantasy', false),
													makeBookRecord(7, 'Lost Horizons', 'Travel', false),
													makeBookRecord(8, 'Discontinued Edition', 'Reference', false)
												];
												_MockServerData.DeletedBooks = [
													makeBookRecord(3, 'Science Frontiers', 'Science', true),
													makeBookRecord(5, 'Code Warriors', 'Technology', true)
												];

												// Create an Ongoing sync entity directly, reusing the
												// same Fable/Meadow/SQLite context so local data persists.
												_Fable.serviceManager.addServiceType('MeadowSyncEntityOngoing', libMeadowSyncEntityOngoing);
												let tmpOngoingEntity = _Fable.serviceManager.instantiateServiceProviderWithoutRegistration(
													'MeadowSyncEntityOngoing',
													{
														MeadowEntitySchema: _BookExtendedSchema.Tables.Book,
														PageSize: 100,
														SyncDeletedRecords: true
													});

												tmpOngoingEntity.initialize(
													(pInitError) =>
													{
														// Init error from duplicate createTable is expected; continue
														tmpOngoingEntity.sync(
															(pOngoingError) =>
															{
																Expect(pOngoingError).to.not.exist;

																let tmpAfterOngoing = getLocalBooks(_Fable);
																let tmpDeletedAfterOngoing = getLocalDeletedBooks(_Fable);
																let tmpActiveAfterOngoing = getLocalActiveBooks(_Fable);

																Expect(tmpAfterOngoing.length).to.equal(8,
																	`Expected 8 total after ongoing, got ${tmpAfterOngoing.length}`);
																Expect(tmpDeletedAfterOngoing.length).to.equal(2,
																	`Expected 2 deleted after ongoing, got ${tmpDeletedAfterOngoing.length}`);
																Expect(tmpActiveAfterOngoing.length).to.equal(6,
																	`Expected 6 active after ongoing, got ${tmpActiveAfterOngoing.length}`);

																// Verify the right records are deleted
																let tmpDeletedIDs = tmpDeletedAfterOngoing.map((r) => r.IDBook);
																Expect(tmpDeletedIDs).to.include(3);
																Expect(tmpDeletedIDs).to.include(5);

																return fDone();
															});
													});
											});
									});
							});
					}
				);
			}
		);

		// ── Old API workaround: SyncDeletedRecordsQueryString ───────────

		suite
		(
			'Old API workaround with SyncDeletedRecordsQueryString',
			() =>
			{
				let _Fable = null;

				setup
				(
					(fDone) =>
					{
						_MockServerData.ActiveBooks = ACTIVE_BOOKS.slice();
						_MockServerData.DeletedBooks = DELETED_BOOKS.slice();
						// Simulate old API: FBV~Deleted~EQ~1 returns 0 unless ?includeDeleted=true
						_MockServerData.SimulateOldAPI = true;

						_Fable = createTestFable();
						setupSQLiteProvider(_Fable,
							(pError) =>
							{
								if (pError) return fDone(pError);

								// Configure with the query string workaround for the Book entity
								let tmpEntityOptions =
									{
										Book: { SyncDeletedRecordsQueryString: 'includeDeleted=true' }
									};

								setupSyncServices(_Fable, 'Initial', true, fDone, tmpEntityOptions);
							});
					}
				);

				teardown
				(
					() =>
					{
						_MockServerData.SimulateOldAPI = false;
					}
				);

				test
				(
					'should sync deleted records via ?includeDeleted=true on old API',
					(fDone) =>
					{
						_Fable.MeadowSync.syncAll(
							(pError) =>
							{
								Expect(pError).to.not.exist;

								let tmpAllLocal = getLocalBooks(_Fable);
								let tmpDeletedLocal = getLocalDeletedBooks(_Fable);
								let tmpActiveLocal = getLocalActiveBooks(_Fable);

								Expect(tmpAllLocal.length).to.equal(8,
									`Expected 8 total records, got ${tmpAllLocal.length}`);
								Expect(tmpActiveLocal.length).to.equal(5,
									`Expected 5 active records, got ${tmpActiveLocal.length}`);
								Expect(tmpDeletedLocal.length).to.equal(3,
									`Expected 3 deleted records, got ${tmpDeletedLocal.length}`);

								return fDone();
							});
					}
				);

				test
				(
					'should get 0 deleted records without the query string workaround on old API',
					(fDone) =>
					{
						// Re-setup WITHOUT the query string workaround
						let tmpFable2 = createTestFable();
						setupSQLiteProvider(tmpFable2,
							(pError) =>
							{
								if (pError) return fDone(pError);

								// No SyncEntityOptions — standard FBV approach only
								setupSyncServices(tmpFable2, 'Initial', true, (pSetupError) =>
									{
										if (pSetupError) return fDone(pSetupError);

										tmpFable2.MeadowSync.syncAll(
											(pSyncError) =>
											{
												Expect(pSyncError).to.not.exist;

												let tmpDeletedLocal = tmpFable2.MeadowSQLiteProvider.db
													.prepare('SELECT COUNT(*) as cnt FROM Book WHERE Deleted = 1').get();

												Expect(tmpDeletedLocal.cnt).to.equal(0,
													'Without workaround, old API returns 0 deleted records');

												return fDone();
											});
									});
							});
					}
				);
			}
		);
	}
);
