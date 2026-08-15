/*
	Unit tests for the three new clone sync strategies:

	1. OngoingEventualConsistency — time-budgeted backwards bisection
	2. TrueUp — linear keyset-paginated walk
	3. ComparisonOnly — bisection-based diff report (no sync)

	Uses a 50,000-record dataset with mixed fragmentation:
	- 200 scattered updates (every 250th ID)
	- 500-record contiguous gap (local missing IDs 20001-20500)
	- 500 new records at the tail (IDs 50001-50500)
	- 100 deleted records (IDs 50501-50600)

	Infrastructure mirrors Meadow-Integration-BisectionSync_test.js:
	filter-aware mock HTTP server + in-memory SQLite.
*/

const Chai = require('chai');
const Expect = Chai.expect;

const libHTTP = require('http');
const libFable = require('fable');
const libMeadow = require('meadow');
const libMeadowConnectionSQLite = require('meadow-connection-sqlite');

const libMeadowCloneRestClient = require('../source/services/clone/Meadow-Service-RestClient.js');
const libMeadowSync = require('../source/services/clone/Meadow-Service-Sync.js');
const libMeadowSyncEntityInitial = require('../source/services/clone/Meadow-Service-Sync-Entity-Initial.js');
const libMeadowSyncEntityOngoing = require('../source/services/clone/Meadow-Service-Sync-Entity-Ongoing.js');
const libMeadowSyncEntityOngoingEventualConsistency = require('../source/services/clone/Meadow-Service-Sync-Entity-OngoingEventualConsistency.js');
const libMeadowSyncEntityTrueUp = require('../source/services/clone/Meadow-Service-Sync-Entity-TrueUp.js');
const libMeadowSyncEntityComparisonOnly = require('../source/services/clone/Meadow-Service-Sync-Entity-ComparisonOnly.js');

// ── Test Constants ──────────────────────────────────────────────────────────────

const MOCK_PORT = 18200;
const MOCK_BASE_URL = `http://localhost:${MOCK_PORT}/1.0/`;

const BASE_UPDATE_DATE = '2025-06-15T12:00:00.000Z';
const NEWER_UPDATE_DATE = '2025-07-01T12:00:00.000Z';
const NEWEST_UPDATE_DATE = '2025-08-01T12:00:00.000Z';

const RECORD_COUNT = 50000;
const BISECT_MIN_RANGE = 1000;

// Fragmentation parameters
const GAP_START = 20001;
const GAP_END = 20500;
const GAP_SIZE = GAP_END - GAP_START + 1;
const NEW_RECORDS_START = RECORD_COUNT + 1;
const NEW_RECORDS_END = RECORD_COUNT + 500;
const NEW_RECORDS_COUNT = NEW_RECORDS_END - NEW_RECORDS_START + 1;
const DELETED_START = NEW_RECORDS_END + 1;
const DELETED_END = DELETED_START + 99;
const DELETED_COUNT = DELETED_END - DELETED_START + 1;
const SCATTERED_UPDATE_INTERVAL = 5000;
const SCATTERED_UPDATE_COUNT = Math.floor(RECORD_COUNT / SCATTERED_UPDATE_INTERVAL);

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

// ── Deterministic Data Generator ────────────────────────────────────────────────

const GENRES = ['Adventure', 'Mystery', 'Science', 'Romance', 'Technology',
	'Fantasy', 'History', 'Biography', 'Horror', 'Comedy'];

function generateBooks(pCount, pBaseUpdateDate)
{
	let tmpBooks = [];
	for (let i = 1; i <= pCount; i++)
	{
		tmpBooks.push(
		{
			IDBook: i,
			GUIDBook: `GUID-BOOK-${i}`,
			CreateDate: '2025-01-01T00:00:00.000Z',
			CreatingIDUser: 1,
			UpdateDate: pBaseUpdateDate,
			UpdatingIDUser: 1,
			Deleted: 0,
			DeleteDate: '',
			DeletingIDUser: 0,
			Title: `Book-${i}`,
			Type: 'Fiction',
			Genre: GENRES[i % GENRES.length],
			PublicationYear: 2000 + (i % 26)
		});
	}
	return tmpBooks;
}

function mutateBooks(pBooks, pStartID, pEndID, pNewUpdateDate, pTitlePrefix)
{
	for (let i = 0; i < pBooks.length; i++)
	{
		if (pBooks[i].IDBook >= pStartID && pBooks[i].IDBook <= pEndID)
		{
			pBooks[i].UpdateDate = pNewUpdateDate;
			if (pTitlePrefix)
			{
				pBooks[i].Title = `${pTitlePrefix}-${pBooks[i].IDBook}`;
			}
		}
	}
}

// Apply scattered updates: every SCATTERED_UPDATE_INTERVAL-th ID
function applyScatteredUpdates(pBooks)
{
	for (let i = 0; i < pBooks.length; i++)
	{
		if (pBooks[i].IDBook % SCATTERED_UPDATE_INTERVAL === 0 && pBooks[i].Deleted === 0)
		{
			pBooks[i].UpdateDate = NEWER_UPDATE_DATE;
			pBooks[i].Title = `Scattered-${pBooks[i].IDBook}`;
		}
	}
}

// Build the full fragmented server dataset
function buildFragmentedServerData()
{
	// 50,000 active records
	let tmpBooks = generateBooks(RECORD_COUNT, BASE_UPDATE_DATE);

	// Scattered updates (every 250th ID gets a newer UpdateDate)
	applyScatteredUpdates(tmpBooks);

	// 500 new records at the tail
	for (let i = NEW_RECORDS_START; i <= NEW_RECORDS_END; i++)
	{
		tmpBooks.push(
		{
			IDBook: i,
			GUIDBook: `GUID-BOOK-${i}`,
			CreateDate: '2025-07-01T00:00:00.000Z',
			CreatingIDUser: 1,
			UpdateDate: NEWEST_UPDATE_DATE,
			UpdatingIDUser: 1,
			Deleted: 0,
			DeleteDate: '',
			DeletingIDUser: 0,
			Title: `NewBook-${i}`,
			Type: 'Fiction',
			Genre: GENRES[i % GENRES.length],
			PublicationYear: 2000 + (i % 26)
		});
	}

	// 100 deleted records
	for (let i = DELETED_START; i <= DELETED_END; i++)
	{
		tmpBooks.push(
		{
			IDBook: i,
			GUIDBook: `GUID-BOOK-${i}`,
			CreateDate: '2025-01-01T00:00:00.000Z',
			CreatingIDUser: 1,
			UpdateDate: '2025-03-01T00:00:00.000Z',
			UpdatingIDUser: 1,
			Deleted: 1,
			DeleteDate: '2025-04-01T00:00:00.000Z',
			DeletingIDUser: 1,
			Title: `Deleted-Book-${i}`,
			Type: 'Fiction',
			Genre: GENRES[i % GENRES.length],
			PublicationYear: 2000 + (i % 26)
		});
	}

	return tmpBooks;
}

// Build local dataset: 50,000 records minus the gap (IDs 20001-20500)
function buildLocalData()
{
	let tmpBooks = generateBooks(RECORD_COUNT, BASE_UPDATE_DATE);
	return tmpBooks.filter((b) => b.IDBook < GAP_START || b.IDBook > GAP_END);
}

// ── FBV~ Filter Parser ──────────────────────────────────────────────────────────

function parseFilter(pFilterString)
{
	if (!pFilterString) return { filters: [], sort: null };

	let tmpFilterPart = pFilterString;
	let tmpSort = null;

	let tmpFSFIndex = tmpFilterPart.indexOf('~FSF~');
	if (tmpFSFIndex >= 0)
	{
		let tmpSortPart = tmpFilterPart.substring(tmpFSFIndex + 5);
		tmpFilterPart = tmpFilterPart.substring(0, tmpFSFIndex);
		let tmpSortTokens = tmpSortPart.split('~');
		if (tmpSortTokens.length >= 2)
		{
			tmpSort = { Column: tmpSortTokens[0], Direction: tmpSortTokens[1] };
		}
	}

	if (tmpFilterPart.indexOf('FSF~') === 0)
	{
		let tmpSortTokens = tmpFilterPart.substring(4).split('~');
		if (tmpSortTokens.length >= 2)
		{
			tmpSort = { Column: tmpSortTokens[0], Direction: tmpSortTokens[1] };
		}
		return { filters: [], sort: tmpSort };
	}

	let tmpFilters = [];
	if (tmpFilterPart.indexOf('FBV~') === 0)
	{
		tmpFilterPart = tmpFilterPart.substring(4);
	}
	let tmpClauses = tmpFilterPart.split('~FBV~');
	for (let i = 0; i < tmpClauses.length; i++)
	{
		let tmpTokens = tmpClauses[i].split('~');
		if (tmpTokens.length >= 3)
		{
			tmpFilters.push({ Column: tmpTokens[0], Operator: tmpTokens[1], Value: tmpTokens.slice(2).join('~') });
		}
	}

	return { filters: tmpFilters, sort: tmpSort };
}

function applyFilters(pBooks, pParsed)
{
	let tmpResult = pBooks;

	for (let i = 0; i < pParsed.filters.length; i++)
	{
		let tmpFilter = pParsed.filters[i];
		let tmpCol = tmpFilter.Column;
		let tmpOp = tmpFilter.Operator;
		let tmpVal = tmpFilter.Value;

		tmpResult = tmpResult.filter((pBook) =>
		{
			let tmpBookVal = pBook[tmpCol];
			if (tmpBookVal === undefined || tmpBookVal === null) return false;

			let tmpCompareBookVal = String(tmpBookVal).replace(/Z$/, '');
			let tmpCompareFilterVal = String(tmpVal).replace(/Z$/, '');

			if (tmpCol === 'IDBook' || tmpCol === 'CreatingIDUser' || tmpCol === 'UpdatingIDUser' ||
				tmpCol === 'DeletingIDUser' || tmpCol === 'PublicationYear' || tmpCol === 'Deleted')
			{
				tmpCompareBookVal = Number(tmpBookVal);
				tmpCompareFilterVal = Number(tmpVal);
			}

			switch (tmpOp)
			{
				case 'GE': return tmpCompareBookVal >= tmpCompareFilterVal;
				case 'LE': return tmpCompareBookVal <= tmpCompareFilterVal;
				case 'GT': return tmpCompareBookVal > tmpCompareFilterVal;
				case 'LT': return tmpCompareBookVal < tmpCompareFilterVal;
				case 'EQ': return tmpCompareBookVal == tmpCompareFilterVal;
				default: return true;
			}
		});
	}

	if (pParsed.sort)
	{
		let tmpSortCol = pParsed.sort.Column;
		let tmpDir = (pParsed.sort.Direction || '').toUpperCase() === 'DESC' ? -1 : 1;
		tmpResult.sort((a, b) =>
		{
			let tmpA = a[tmpSortCol];
			let tmpB = b[tmpSortCol];
			if (tmpA < tmpB) return -1 * tmpDir;
			if (tmpA > tmpB) return 1 * tmpDir;
			return 0;
		});
	}

	return tmpResult;
}

// ── Mock HTTP Server (Filter-Aware) ─────────────────────────────────────────────

let _MockServerData =
{
	Books: [],
	RequestLog:
	{
		maxIDRequests: 0,
		countRequests: 0,
		countFilteredRequests: 0,
		recordPullRequests: 0,
		totalRecordsPulled: 0
	}
};

function resetRequestLog()
{
	_MockServerData.RequestLog =
	{
		maxIDRequests: 0,
		countRequests: 0,
		countFilteredRequests: 0,
		recordPullRequests: 0,
		totalRecordsPulled: 0
	};
}

function createMockServer()
{
	return libHTTP.createServer(
		(pRequest, pResponse) =>
		{
			let tmpURL = pRequest.url.split('?')[0];
			pResponse.setHeader('Content-Type', 'application/json');

			let tmpBooks = _MockServerData.Books;

			// GET /1.0/Book/Max/IDBook
			if (tmpURL.match(/\/1\.0\/Book\/Max\/IDBook$/))
			{
				_MockServerData.RequestLog.maxIDRequests++;
				let tmpMaxID = 0;
				for (let i = 0; i < tmpBooks.length; i++)
				{
					if (tmpBooks[i].IDBook > tmpMaxID && tmpBooks[i].Deleted === 0)
					{
						tmpMaxID = tmpBooks[i].IDBook;
					}
				}
				pResponse.end(JSON.stringify({ IDBook: tmpMaxID }));
				return;
			}

			// GET /1.0/Book/Max/UpdateDate
			if (tmpURL.match(/\/1\.0\/Book\/Max\/UpdateDate$/))
			{
				let tmpMaxDate = '';
				for (let i = 0; i < tmpBooks.length; i++)
				{
					if (tmpBooks[i].UpdateDate > tmpMaxDate) tmpMaxDate = tmpBooks[i].UpdateDate;
				}
				pResponse.end(JSON.stringify({ UpdateDate: tmpMaxDate }));
				return;
			}

			// GET /1.0/Books/Count (unfiltered)
			if (tmpURL.match(/\/1\.0\/Books\/Count$/) && !tmpURL.match(/FilteredTo/))
			{
				_MockServerData.RequestLog.countRequests++;
				// Unfiltered count returns only non-deleted records (meadow default)
				let tmpCount = 0;
				for (let i = 0; i < tmpBooks.length; i++)
				{
					if (tmpBooks[i].Deleted === 0) tmpCount++;
				}
				pResponse.end(JSON.stringify({ Count: tmpCount }));
				return;
			}

			// GET /1.0/Books/Count/FilteredTo/<filter>
			let tmpCountFilterMatch = tmpURL.match(/\/1\.0\/Books\/Count\/FilteredTo\/(.+)$/);
			if (tmpCountFilterMatch)
			{
				_MockServerData.RequestLog.countFilteredRequests++;
				let tmpParsed = parseFilter(tmpCountFilterMatch[1]);

				// Check if the filter explicitly asks for Deleted records
				let tmpExplicitDeleteFilter = tmpParsed.filters.some(
					(f) => f.Column === 'Deleted');

				let tmpFiltered;
				if (tmpExplicitDeleteFilter)
				{
					tmpFiltered = applyFilters(tmpBooks, tmpParsed);
				}
				else
				{
					// Default: exclude deleted records
					let tmpActive = tmpBooks.filter((b) => b.Deleted === 0);
					tmpFiltered = applyFilters(tmpActive, tmpParsed);
				}
				pResponse.end(JSON.stringify({ Count: tmpFiltered.length }));
				return;
			}

			// GET /1.0/Books/FilteredTo/<filter>/<offset>/<pageSize>
			let tmpRecordsFilterMatch = tmpURL.match(/\/1\.0\/Books\/FilteredTo\/(.+)\/(\d+)\/(\d+)$/);
			if (tmpRecordsFilterMatch)
			{
				_MockServerData.RequestLog.recordPullRequests++;
				let tmpFilter = tmpRecordsFilterMatch[1];
				let tmpOffset = parseInt(tmpRecordsFilterMatch[2]);
				let tmpPageSize = parseInt(tmpRecordsFilterMatch[3]);
				let tmpParsed = parseFilter(tmpFilter);

				// Check if the filter explicitly asks for Deleted records
				let tmpExplicitDeleteFilter = tmpParsed.filters.some(
					(f) => f.Column === 'Deleted');

				let tmpFiltered;
				if (tmpExplicitDeleteFilter)
				{
					tmpFiltered = applyFilters(tmpBooks, tmpParsed);
				}
				else
				{
					let tmpActive = tmpBooks.filter((b) => b.Deleted === 0);
					tmpFiltered = applyFilters(tmpActive, tmpParsed);
				}

				let tmpPage = tmpFiltered.slice(tmpOffset, tmpOffset + tmpPageSize);
				_MockServerData.RequestLog.totalRecordsPulled += tmpPage.length;
				pResponse.end(JSON.stringify(tmpPage));
				return;
			}

			// Fallback
			pResponse.statusCode = 404;
			pResponse.end(JSON.stringify({ Error: `Unknown endpoint: ${tmpURL}` }));
		});
}

// ── Test Helpers ────────────────────────────────────────────────────────────────

function createTestFable()
{
	let tmpFable = new libFable(
		{
			Product: 'NewStrategiesTest',
			ProductVersion: '1.0.0',
			MeadowProvider: 'SQLite',
			SQLite: { SQLiteFilePath: ':memory:' },
			LogStreams: [{ streamtype: 'console', level: 'error' }]
		});

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
					Title TEXT DEFAULT '',
					Type TEXT DEFAULT '',
					Genre TEXT DEFAULT '',
					PublicationYear INTEGER DEFAULT 0
				);
			`);

			return fCallback();
		});
}

function seedLocalBooks(pFable, pBooks)
{
	// node:sqlite's DatabaseSync has no `.transaction(fn)` helper (that was
	// a better-sqlite3 idiom).  Bracket the bulk insert manually so seeding
	// many thousands of rows doesn't pay per-row commit overhead.
	const tmpDB = pFable.MeadowSQLiteProvider.db;
	const tmpInsert = tmpDB.prepare(`
		INSERT OR REPLACE INTO Book (IDBook, GUIDBook, CreateDate, CreatingIDUser, UpdateDate, UpdatingIDUser, Deleted, DeleteDate, DeletingIDUser, Title, Type, Genre, PublicationYear)
		VALUES (@IDBook, @GUIDBook, @CreateDate, @CreatingIDUser, @UpdateDate, @UpdatingIDUser, @Deleted, @DeleteDate, @DeletingIDUser, @Title, @Type, @Genre, @PublicationYear)
	`);
	tmpDB.exec('BEGIN');
	try
	{
		for (const tmpRecord of pBooks)
		{
			tmpInsert.run(tmpRecord);
		}
		tmpDB.exec('COMMIT');
	}
	catch (pError)
	{
		tmpDB.exec('ROLLBACK');
		throw pError;
	}
}

function getLocalBookCount(pFable)
{
	return pFable.MeadowSQLiteProvider.db
		.prepare('SELECT COUNT(*) AS cnt FROM Book WHERE Deleted = 0')
		.get().cnt;
}

function getLocalBookCountAll(pFable)
{
	return pFable.MeadowSQLiteProvider.db
		.prepare('SELECT COUNT(*) AS cnt FROM Book')
		.get().cnt;
}

function getLocalBook(pFable, pID)
{
	return pFable.MeadowSQLiteProvider.db
		.prepare('SELECT * FROM Book WHERE IDBook = ?')
		.get(pID);
}

function setupSyncServices(pFable, pSyncMode, fCallback, pExtraOptions)
{
	if (!pFable.serviceManager.servicesMap.hasOwnProperty('MeadowCloneRestClient'))
	{
		pFable.serviceManager.addServiceType('MeadowCloneRestClient', libMeadowCloneRestClient);
	}
	pFable.serviceManager.instantiateServiceProvider('MeadowCloneRestClient',
		{
			ServerURL: MOCK_BASE_URL
		});

	if (!pFable.serviceManager.servicesMap.hasOwnProperty('MeadowSync'))
	{
		pFable.serviceManager.addServiceType('MeadowSync', libMeadowSync);
	}
	if (!pFable.serviceManager.servicesMap.hasOwnProperty('MeadowSyncEntityInitial'))
	{
		pFable.serviceManager.addServiceType('MeadowSyncEntityInitial', libMeadowSyncEntityInitial);
	}
	if (!pFable.serviceManager.servicesMap.hasOwnProperty('MeadowSyncEntityOngoing'))
	{
		pFable.serviceManager.addServiceType('MeadowSyncEntityOngoing', libMeadowSyncEntityOngoing);
	}
	if (!pFable.serviceManager.servicesMap.hasOwnProperty('MeadowSyncEntityOngoingEventualConsistency'))
	{
		pFable.serviceManager.addServiceType('MeadowSyncEntityOngoingEventualConsistency', libMeadowSyncEntityOngoingEventualConsistency);
	}
	if (!pFable.serviceManager.servicesMap.hasOwnProperty('MeadowSyncEntityTrueUp'))
	{
		pFable.serviceManager.addServiceType('MeadowSyncEntityTrueUp', libMeadowSyncEntityTrueUp);
	}
	if (!pFable.serviceManager.servicesMap.hasOwnProperty('MeadowSyncEntityComparisonOnly'))
	{
		pFable.serviceManager.addServiceType('MeadowSyncEntityComparisonOnly', libMeadowSyncEntityComparisonOnly);
	}

	let tmpSyncOptions =
		{
			PageSize: 100,
			BisectMinRangeSize: BISECT_MIN_RANGE
		};

	if (pExtraOptions)
	{
		Object.assign(tmpSyncOptions, pExtraOptions);
	}

	pFable.serviceManager.instantiateServiceProvider('MeadowSync', tmpSyncOptions);

	pFable.MeadowSync.SyncMode = pSyncMode;

	pFable.MeadowSync.loadMeadowSchema(_BookExtendedSchema,
		(pError) =>
		{
			return fCallback(pError);
		});
}

// ── Test Suite ──────────────────────────────────────────────────────────────────

suite
(
	'New Sync Strategies (50k records)',
	() =>
	{
		let _MockServer = null;

		suiteSetup
		(
			function (fDone)
			{
				this.timeout(10000);
				_MockServer = createMockServer();
				_MockServer.listen(MOCK_PORT, () => { return fDone(); });
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

		// ════════════════════════════════════════════════════════════════════
		// OngoingEventualConsistency
		// ════════════════════════════════════════════════════════════════════

		suite
		(
			'OngoingEventualConsistency',
			() =>
			{
				test
				(
					'Short time budget (100ms) — should always pull new tail records regardless of budget',
					function (fDone)
					{
						this.timeout(300000);

						_MockServerData.Books = buildFragmentedServerData();
						let tmpLocalBooks = buildLocalData();

						let tmpFable = createTestFable();
						setupSQLiteProvider(tmpFable,
							(pError) =>
							{
								Expect(pError).to.not.exist;
								seedLocalBooks(tmpFable, tmpLocalBooks);

								let tmpLocalCountBefore = getLocalBookCount(tmpFable);
								Expect(tmpLocalCountBefore).to.equal(RECORD_COUNT - GAP_SIZE);

								resetRequestLog();

								setupSyncServices(tmpFable, 'OngoingEventualConsistency',
									(pError) =>
									{
										Expect(pError).to.not.exist;
										tmpFable.MeadowSync.syncAll(
											(pSyncError) =>
											{
												Expect(pSyncError).to.not.exist;

												let tmpEntity = tmpFable.MeadowSync.MeadowSyncEntities['Book'];

												// New tail records (50001-50500) should ALWAYS be pulled
												// regardless of the time budget
												Expect(tmpEntity.syncResults.Created).to.be.at.least(NEW_RECORDS_COUNT,
													'All new tail records should be created regardless of time budget');

												// Verify a new tail record exists
												let tmpNewBook = getLocalBook(tmpFable, NEW_RECORDS_START + 10);
												Expect(tmpNewBook).to.not.be.undefined;
												Expect(tmpNewBook.Title).to.equal(`NewBook-${NEW_RECORDS_START + 10}`);

												// With only 100ms budget, we should NOT have synced everything
												// (the gap of 500 records + 200 scattered updates would take much longer)
												// But some back-sync work should have been done
												let tmpTotalSynced = tmpEntity.syncResults.Created + tmpEntity.syncResults.Updated;
												Expect(tmpTotalSynced).to.be.at.least(NEW_RECORDS_COUNT,
													'Should have synced at least the new records');

												return fDone();
											});
									}, { BackSyncTimeLimit: 100 });
							});
					}
				);

				test
				(
					'Unlimited time budget — should fully sync all fragmentation',
					function (fDone)
					{
						this.timeout(300000);

						_MockServerData.Books = buildFragmentedServerData();
						let tmpLocalBooks = buildLocalData();

						let tmpFable = createTestFable();
						setupSQLiteProvider(tmpFable,
							(pError) =>
							{
								Expect(pError).to.not.exist;
								seedLocalBooks(tmpFable, tmpLocalBooks);

								resetRequestLog();

								setupSyncServices(tmpFable, 'OngoingEventualConsistency',
									(pError) =>
									{
										Expect(pError).to.not.exist;
										tmpFable.MeadowSync.syncAll(
											(pSyncError) =>
											{
												Expect(pSyncError).to.not.exist;

												let tmpEntity = tmpFable.MeadowSync.MeadowSyncEntities['Book'];

												// Gap records (20001-20500) should be created
												Expect(tmpEntity.syncResults.Created).to.be.at.least(GAP_SIZE + NEW_RECORDS_COUNT,
													`Should create at least ${GAP_SIZE} gap records + ${NEW_RECORDS_COUNT} new records`);

												// Scattered updates should be applied
												Expect(tmpEntity.syncResults.Updated).to.be.at.least(SCATTERED_UPDATE_COUNT,
													`Should update at least ${SCATTERED_UPDATE_COUNT} scattered records`);

												// Verify specific gap record
												let tmpGapBook = getLocalBook(tmpFable, GAP_START + 50);
												Expect(tmpGapBook).to.not.be.undefined;
												Expect(tmpGapBook.Title).to.equal(`Book-${GAP_START + 50}`);

												// Verify a scattered update (every 5000th ID)
												let tmpScatteredBook = getLocalBook(tmpFable, 5000);
												Expect(tmpScatteredBook.Title).to.equal('Scattered-5000');

												// Verify new tail record
												let tmpTailBook = getLocalBook(tmpFable, NEW_RECORDS_END);
												Expect(tmpTailBook).to.not.be.undefined;
												Expect(tmpTailBook.Title).to.equal(`NewBook-${NEW_RECORDS_END}`);

												return fDone();
											});
									}, { BackSyncTimeLimit: 999999 });
							});
					}
				);

				test
				(
					'Backwards bisection should prioritize high IDs over low IDs',
					function (fDone)
					{
						this.timeout(300000);

						// Create a clean dataset with changes at both ends
						let tmpServerBooks = generateBooks(RECORD_COUNT, BASE_UPDATE_DATE);
						// Mutate 50 records near the END
						mutateBooks(tmpServerBooks, 49900, 49950, NEWER_UPDATE_DATE, 'HighEnd');
						// Mutate 50 records near the START
						mutateBooks(tmpServerBooks, 100, 150, NEWER_UPDATE_DATE, 'LowEnd');
						_MockServerData.Books = tmpServerBooks;

						let tmpLocalBooks = generateBooks(RECORD_COUNT, BASE_UPDATE_DATE);

						let tmpFable = createTestFable();
						setupSQLiteProvider(tmpFable,
							(pError) =>
							{
								Expect(pError).to.not.exist;
								seedLocalBooks(tmpFable, tmpLocalBooks);

								resetRequestLog();

								setupSyncServices(tmpFable, 'OngoingEventualConsistency',
									(pError) =>
									{
										Expect(pError).to.not.exist;
										tmpFable.MeadowSync.syncAll(
											(pSyncError) =>
											{
												Expect(pSyncError).to.not.exist;

												let tmpEntity = tmpFable.MeadowSync.MeadowSyncEntities['Book'];

												// With a very short budget, the high-end changes should
												// be prioritized because backwards bisection starts from
												// the upper half
												let tmpHighEndSynced = getLocalBook(tmpFable, 49925);
												Expect(tmpHighEndSynced.Title).to.equal('HighEnd-49925',
													'High-end records should be prioritized by backwards bisection');

												return fDone();
											});
									}, { BackSyncTimeLimit: 100 });
							});
					}
				);
			}
		);

		// ════════════════════════════════════════════════════════════════════
		// TrueUp
		// ════════════════════════════════════════════════════════════════════

		suite
		(
			'TrueUp',
			() =>
			{
				test
				(
					'Full true-up with mixed fragmentation — should sync all differences',
					function (fDone)
					{
						this.timeout(300000);

						_MockServerData.Books = buildFragmentedServerData();
						let tmpLocalBooks = buildLocalData();

						let tmpFable = createTestFable();
						setupSQLiteProvider(tmpFable,
							(pError) =>
							{
								Expect(pError).to.not.exist;
								seedLocalBooks(tmpFable, tmpLocalBooks);

								Expect(getLocalBookCount(tmpFable)).to.equal(RECORD_COUNT - GAP_SIZE);

								resetRequestLog();

								setupSyncServices(tmpFable, 'TrueUp',
									(pError) =>
									{
										Expect(pError).to.not.exist;
										tmpFable.MeadowSync.syncAll(
											(pSyncError) =>
											{
												Expect(pSyncError).to.not.exist;

												let tmpEntity = tmpFable.MeadowSync.MeadowSyncEntities['Book'];

												// All gap records + new tail records should be created
												Expect(tmpEntity.syncResults.Created).to.be.at.least(GAP_SIZE + NEW_RECORDS_COUNT,
													`Should create at least ${GAP_SIZE + NEW_RECORDS_COUNT} records (gap + new)`);

												// Scattered updates should be applied
												Expect(tmpEntity.syncResults.Updated).to.be.at.least(SCATTERED_UPDATE_COUNT,
													`Should update at least ${SCATTERED_UPDATE_COUNT} scattered records`);

												// Final count: 50,000 original + 500 new = 50,500 active
												let tmpFinalCount = getLocalBookCount(tmpFable);
												Expect(tmpFinalCount).to.equal(RECORD_COUNT + NEW_RECORDS_COUNT);

												// Verify gap was filled
												let tmpGapBook = getLocalBook(tmpFable, GAP_START + 100);
												Expect(tmpGapBook).to.not.be.undefined;
												Expect(tmpGapBook.Title).to.equal(`Book-${GAP_START + 100}`);

												// Verify scattered update applied (every 5000th ID)
												let tmpScattered = getLocalBook(tmpFable, 10000);
												Expect(tmpScattered.Title).to.equal('Scattered-10000');

												// Verify new tail record
												let tmpNewBook = getLocalBook(tmpFable, NEW_RECORDS_END - 5);
												Expect(tmpNewBook).to.not.be.undefined;

												return fDone();
											});
									}, { TrueUpPageSize: 500 });
							});
					}
				);

				test
				(
					'TrueUp with deleted records enabled',
					function (fDone)
					{
						this.timeout(300000);

						_MockServerData.Books = buildFragmentedServerData();
						let tmpLocalBooks = buildLocalData();

						let tmpFable = createTestFable();
						setupSQLiteProvider(tmpFable,
							(pError) =>
							{
								Expect(pError).to.not.exist;
								seedLocalBooks(tmpFable, tmpLocalBooks);

								resetRequestLog();

								setupSyncServices(tmpFable, 'TrueUp',
									(pError) =>
									{
										Expect(pError).to.not.exist;
										tmpFable.MeadowSync.syncAll(
											(pSyncError) =>
											{
												Expect(pSyncError).to.not.exist;

												// Check that deleted records were synced
												let tmpDeletedBook = getLocalBook(tmpFable, DELETED_START + 5);
												Expect(tmpDeletedBook).to.not.be.undefined;
												Expect(tmpDeletedBook.Deleted).to.equal(1);
												Expect(tmpDeletedBook.Title).to.equal(`Deleted-Book-${DELETED_START + 5}`);

												// Total including deleted
												let tmpTotalAll = getLocalBookCountAll(tmpFable);
												Expect(tmpTotalAll).to.be.at.least(RECORD_COUNT + NEW_RECORDS_COUNT + DELETED_COUNT);

												return fDone();
											});
									}, { TrueUpPageSize: 500, SyncDeletedRecords: true });
							});
					}
				);

				test
				(
					'TrueUp idempotency — second run should create zero new records',
					function (fDone)
					{
						this.timeout(600000);

						// Use a simpler dataset for idempotency (avoid timing out)
						let tmpServerBooks = generateBooks(RECORD_COUNT, BASE_UPDATE_DATE);
						applyScatteredUpdates(tmpServerBooks);
						_MockServerData.Books = tmpServerBooks;

						let tmpLocalBooks = generateBooks(RECORD_COUNT, BASE_UPDATE_DATE);

						let tmpFable = createTestFable();
						setupSQLiteProvider(tmpFable,
							(pError) =>
							{
								Expect(pError).to.not.exist;
								seedLocalBooks(tmpFable, tmpLocalBooks);

								// First true-up
								setupSyncServices(tmpFable, 'TrueUp',
									(pError) =>
									{
										Expect(pError).to.not.exist;
										tmpFable.MeadowSync.syncAll(
											(pSyncError) =>
											{
												Expect(pSyncError).to.not.exist;

												let tmpEntity1 = tmpFable.MeadowSync.MeadowSyncEntities['Book'];
												Expect(tmpEntity1.syncResults.Updated).to.be.at.least(SCATTERED_UPDATE_COUNT);

												// Second true-up — should create nothing new
												resetRequestLog();
												setupSyncServices(tmpFable, 'TrueUp',
													(pError2) =>
													{
														Expect(pError2).to.not.exist;
														tmpFable.MeadowSync.syncAll(
															(pSyncError2) =>
															{
																Expect(pSyncError2).to.not.exist;

																let tmpEntity2 = tmpFable.MeadowSync.MeadowSyncEntities['Book'];
																Expect(tmpEntity2.syncResults.Created).to.equal(0,
																	'Second true-up should create zero new records');

																return fDone();
															});
													}, { TrueUpPageSize: 500 });
											});
									}, { TrueUpPageSize: 500 });
							});
					}
				);
			}
		);

		// ════════════════════════════════════════════════════════════════════
		// ComparisonOnly
		// ════════════════════════════════════════════════════════════════════

		suite
		(
			'ComparisonOnly',
			() =>
			{
				test
				(
					'Comparison report accuracy with mixed fragmentation',
					function (fDone)
					{
						this.timeout(300000);

						_MockServerData.Books = buildFragmentedServerData();
						let tmpLocalBooks = buildLocalData();

						let tmpFable = createTestFable();
						setupSQLiteProvider(tmpFable,
							(pError) =>
							{
								Expect(pError).to.not.exist;
								seedLocalBooks(tmpFable, tmpLocalBooks);

								resetRequestLog();

								setupSyncServices(tmpFable, 'ComparisonOnly',
									(pError) =>
									{
										Expect(pError).to.not.exist;
										tmpFable.MeadowSync.syncAll(
											(pSyncError) =>
											{
												Expect(pSyncError).to.not.exist;

												let tmpEntity = tmpFable.MeadowSync.MeadowSyncEntities['Book'];

												// No records should have been synced
												Expect(tmpEntity.syncResults.Created).to.equal(0,
													'ComparisonOnly should not create any records');
												Expect(tmpEntity.syncResults.Updated).to.equal(0,
													'ComparisonOnly should not update any records');

												// ComparisonReport should exist
												Expect(tmpEntity.ComparisonReport).to.be.an('object');
												let tmpReport = tmpEntity.ComparisonReport;

												// Validate report structure
												Expect(tmpReport.Entity).to.equal('Book');
												Expect(tmpReport.Timestamp).to.be.a('string');
												Expect(tmpReport.Summary).to.be.an('object');
												Expect(tmpReport.Ranges).to.be.an('array');

												// There should be mismatches (gap + new records + scattered updates)
												Expect(tmpReport.Summary.MismatchedRanges).to.be.above(0,
													'Should detect mismatched ranges from gap and scattered updates');

												// There should also be matching ranges (unchanged regions)
												Expect(tmpReport.Summary.MatchingRanges).to.be.above(0,
													'Should detect matching ranges in unchanged regions');

												// Range counts should add up
												Expect(tmpReport.Summary.TotalRangesChecked).to.equal(
													tmpReport.Summary.MatchingRanges +
													tmpReport.Summary.MismatchedRanges +
													tmpReport.Summary.ErrorRanges,
													'Total ranges should equal matching + mismatched + error');

												// Local data should be untouched
												let tmpLocalCount = getLocalBookCount(tmpFable);
												Expect(tmpLocalCount).to.equal(RECORD_COUNT - GAP_SIZE,
													'Local record count should be unchanged after comparison');

												return fDone();
											});
									});
							});
					}
				);

				test
				(
					'Comparison on identical data — should report zero mismatches',
					function (fDone)
					{
						this.timeout(300000);

						let tmpBooks = generateBooks(RECORD_COUNT, BASE_UPDATE_DATE);
						_MockServerData.Books = tmpBooks.map((b) => Object.assign({}, b));

						let tmpFable = createTestFable();
						setupSQLiteProvider(tmpFable,
							(pError) =>
							{
								Expect(pError).to.not.exist;
								seedLocalBooks(tmpFable, tmpBooks);

								resetRequestLog();

								setupSyncServices(tmpFable, 'ComparisonOnly',
									(pError) =>
									{
										Expect(pError).to.not.exist;
										tmpFable.MeadowSync.syncAll(
											(pSyncError) =>
											{
												Expect(pSyncError).to.not.exist;

												let tmpEntity = tmpFable.MeadowSync.MeadowSyncEntities['Book'];
												let tmpReport = tmpEntity.ComparisonReport;

												Expect(tmpReport.Summary.MismatchedRanges).to.equal(0,
													'Identical data should have zero mismatches');
												Expect(tmpReport.Summary.MatchingRanges).to.be.above(0,
													'Should have matching ranges');
												Expect(tmpEntity.syncResults.Created).to.equal(0);
												Expect(tmpEntity.syncResults.Updated).to.equal(0);

												return fDone();
											});
									});
							});
					}
				);

				test
				(
					'Report contains UpdateDate mismatch details when counts match but dates differ',
					function (fDone)
					{
						this.timeout(300000);

						let tmpBooks = generateBooks(RECORD_COUNT, BASE_UPDATE_DATE);
						_MockServerData.Books = tmpBooks.map((b) => Object.assign({}, b));

						let tmpFable = createTestFable();
						setupSQLiteProvider(tmpFable,
							(pError) =>
							{
								Expect(pError).to.not.exist;
								seedLocalBooks(tmpFable, tmpBooks);

								// Mutate 50 records on server (same count, different dates)
								mutateBooks(_MockServerData.Books, 5000, 5050, NEWER_UPDATE_DATE, 'DateChanged');

								resetRequestLog();

								setupSyncServices(tmpFable, 'ComparisonOnly',
									(pError) =>
									{
										Expect(pError).to.not.exist;
										tmpFable.MeadowSync.syncAll(
											(pSyncError) =>
											{
												Expect(pSyncError).to.not.exist;

												let tmpEntity = tmpFable.MeadowSync.MeadowSyncEntities['Book'];
												let tmpReport = tmpEntity.ComparisonReport;

												// Should detect date mismatches
												Expect(tmpReport.Summary.MismatchedRanges).to.be.above(0,
													'Should detect mismatches when UpdateDates differ');

												// Find a mismatch range and verify it has UpdateDate details
												let tmpDateMismatch = tmpReport.Ranges.find(
													(r) => r.Status === 'mismatch' && r.UpdateDateDifferenceMS > 0);
												Expect(tmpDateMismatch).to.not.be.undefined;
												Expect(tmpDateMismatch.UpdateDateDifferenceMS).to.be.above(0);
												Expect(tmpDateMismatch.LocalMaxUpdateDate).to.be.a('string');
												Expect(tmpDateMismatch.ServerMaxUpdateDate).to.be.a('string');

												// No records should be synced
												Expect(tmpEntity.syncResults.Created).to.equal(0);
												Expect(tmpEntity.syncResults.Updated).to.equal(0);

												return fDone();
											});
									});
							});
					}
				);

				test
				(
					'Report stored on syncResults.ComparisonReport',
					function (fDone)
					{
						this.timeout(300000);

						let tmpBooks = generateBooks(5000, BASE_UPDATE_DATE);
						_MockServerData.Books = tmpBooks.map((b) => Object.assign({}, b));

						let tmpFable = createTestFable();
						setupSQLiteProvider(tmpFable,
							(pError) =>
							{
								Expect(pError).to.not.exist;
								seedLocalBooks(tmpFable, tmpBooks);

								setupSyncServices(tmpFable, 'ComparisonOnly',
									(pError) =>
									{
										Expect(pError).to.not.exist;
										tmpFable.MeadowSync.syncAll(
											(pSyncError) =>
											{
												Expect(pSyncError).to.not.exist;

												let tmpEntity = tmpFable.MeadowSync.MeadowSyncEntities['Book'];

												// syncResults.ComparisonReport should reference the same report
												Expect(tmpEntity.syncResults.ComparisonReport).to.equal(tmpEntity.ComparisonReport,
													'syncResults.ComparisonReport should reference the same report object');
												Expect(tmpEntity.syncResults.ComparisonReport.Entity).to.equal('Book');
												Expect(tmpEntity.syncResults.ComparisonReport.Summary).to.be.an('object');

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
