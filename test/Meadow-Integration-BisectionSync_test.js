/*
	Unit tests for Ongoing Sync Bisection Algorithm

	Validates that the bisection-based ongoing sync correctly:
	- Skips unchanged ranges (no record pulls)
	- Detects and syncs changed ranges efficiently
	- Handles count mismatches (missing local records)
	- Scales efficiently with large datasets

	Uses a filter-aware mock HTTP server to simulate meadow-endpoints API
	responses and an in-memory SQLite database as the local clone destination.
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
const libMeadowSyncEntityInitial = require('../source/services/clone/Meadow-Service-Sync-Entity-Initial.js');

// ── Test Constants ──────────────────────────────────────────────────────────────

const MOCK_PORT = 18100;
const MOCK_BASE_URL = `http://localhost:${MOCK_PORT}/1.0/`;

const BASE_UPDATE_DATE = '2025-06-15T12:00:00.000Z';
const NEWER_UPDATE_DATE = '2025-07-01T12:00:00.000Z';
const NEWEST_UPDATE_DATE = '2025-08-01T12:00:00.000Z';

const RECORD_COUNT = 5000;
const BISECT_MIN_RANGE = 1000;

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

// ── FBV~ Filter Parser ──────────────────────────────────────────────────────────
// Parses meadow filter expressions like:
//   FBV~IDBook~GE~100~FBV~IDBook~LE~200~FSF~UpdateDate~DESC~DESC

function parseFilter(pFilterString)
{
	if (!pFilterString) return { filters: [], sort: null };

	let tmpFilterPart = pFilterString;
	let tmpSort = null;

	// Split off the FSF sort clause
	let tmpFSFIndex = tmpFilterPart.indexOf('~FSF~');
	if (tmpFSFIndex >= 0)
	{
		let tmpSortPart = tmpFilterPart.substring(tmpFSFIndex + 5); // after ~FSF~
		tmpFilterPart = tmpFilterPart.substring(0, tmpFSFIndex);
		let tmpSortTokens = tmpSortPart.split('~');
		if (tmpSortTokens.length >= 2)
		{
			tmpSort = { Column: tmpSortTokens[0], Direction: tmpSortTokens[1] };
		}
	}

	// Also handle leading FSF~ (no filter, just sort)
	if (tmpFilterPart.indexOf('FSF~') === 0)
	{
		let tmpSortTokens = tmpFilterPart.substring(4).split('~');
		if (tmpSortTokens.length >= 2)
		{
			tmpSort = { Column: tmpSortTokens[0], Direction: tmpSortTokens[1] };
		}
		return { filters: [], sort: tmpSort };
	}

	// Parse FBV~ filter clauses
	let tmpFilters = [];
	// Remove leading FBV~ then split on ~FBV~
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

			// Normalize dates: strip trailing Z for comparison
			let tmpCompareBookVal = String(tmpBookVal).replace(/Z$/, '');
			let tmpCompareFilterVal = String(tmpVal).replace(/Z$/, '');

			// Use numeric comparison for integer columns
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

	// Apply sort
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
			let tmpURL = pRequest.url.split('?')[0]; // strip query string
			pResponse.setHeader('Content-Type', 'application/json');

			let tmpBooks = _MockServerData.Books;

			// GET /1.0/Book/Max/IDBook
			if (tmpURL.match(/\/1\.0\/Book\/Max\/IDBook$/))
			{
				_MockServerData.RequestLog.maxIDRequests++;
				let tmpMaxID = 0;
				for (let i = 0; i < tmpBooks.length; i++)
				{
					if (tmpBooks[i].IDBook > tmpMaxID) tmpMaxID = tmpBooks[i].IDBook;
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
				pResponse.end(JSON.stringify({ Count: tmpBooks.length }));
				return;
			}

			// GET /1.0/Books/Count/FilteredTo/<filter>
			let tmpCountFilterMatch = tmpURL.match(/\/1\.0\/Books\/Count\/FilteredTo\/(.+)$/);
			if (tmpCountFilterMatch)
			{
				_MockServerData.RequestLog.countFilteredRequests++;
				let tmpParsed = parseFilter(tmpCountFilterMatch[1]);
				let tmpFiltered = applyFilters(tmpBooks, tmpParsed);
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
				let tmpFiltered = applyFilters(tmpBooks, tmpParsed);
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
			Product: 'BisectionSyncTest',
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
	'Bisection Sync',
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

		// ── Initial Sync Baseline ───────────────────────────────────────────

		suite
		(
			'Initial Sync Baseline',
			() =>
			{
				test
				(
					`Should sync ${RECORD_COUNT} records via Initial mode`,
					function (fDone)
					{
						this.timeout(120000);

						_MockServerData.Books = generateBooks(RECORD_COUNT, BASE_UPDATE_DATE);

						let tmpFable = createTestFable();
						setupSQLiteProvider(tmpFable,
							(pError) =>
							{
								Expect(pError).to.not.exist;
								setupSyncServices(tmpFable, 'Initial',
									(pError) =>
									{
										Expect(pError).to.not.exist;
										tmpFable.MeadowSync.syncAll(
											(pSyncError) =>
											{
												Expect(pSyncError).to.not.exist;
												let tmpCount = getLocalBookCount(tmpFable);
												Expect(tmpCount).to.equal(RECORD_COUNT);
												return fDone();
											});
									});
							});
					}
				);
			}
		);

		// ── Ongoing Sync — No Changes ───────────────────────────────────────

		suite
		(
			'Ongoing Sync - No Changes',
			() =>
			{
				test
				(
					'Should pull zero records when server and local are identical',
					function (fDone)
					{
						this.timeout(120000);

						let tmpBooks = generateBooks(RECORD_COUNT, BASE_UPDATE_DATE);
						_MockServerData.Books = tmpBooks.map((b) => Object.assign({}, b));

						let tmpFable = createTestFable();
						setupSQLiteProvider(tmpFable,
							(pError) =>
							{
								Expect(pError).to.not.exist;

								// Seed local DB directly with the same data
								seedLocalBooks(tmpFable, tmpBooks);
								Expect(getLocalBookCount(tmpFable)).to.equal(RECORD_COUNT);

								resetRequestLog();

								setupSyncServices(tmpFable, 'Ongoing',
									(pError) =>
									{
										Expect(pError).to.not.exist;
										tmpFable.MeadowSync.syncAll(
											(pSyncError) =>
											{
												Expect(pSyncError).to.not.exist;

												let tmpEntity = tmpFable.MeadowSync.MeadowSyncEntities['Book'];
												Expect(tmpEntity.syncResults.Created).to.equal(0);
												Expect(tmpEntity.syncResults.Updated).to.equal(0);

												// Key assertion: bisection should NOT pull records
												Expect(_MockServerData.RequestLog.totalRecordsPulled).to.equal(0,
													'No records should be pulled when data is identical');

												return fDone();
											});
									});
							});
					}
				);
			}
		);

		// ── Ongoing Sync — Targeted Updates (UpdateDate Fast-Sync) ───────────

		suite
		(
			'Ongoing Sync - Targeted Updates via UpdateDate',
			() =>
			{
				test
				(
					'Should pull only modified records when 50 records are updated',
					function (fDone)
					{
						this.timeout(120000);

						let tmpBooks = generateBooks(RECORD_COUNT, BASE_UPDATE_DATE);
						_MockServerData.Books = tmpBooks.map((b) => Object.assign({}, b));

						let tmpFable = createTestFable();
						setupSQLiteProvider(tmpFable,
							(pError) =>
							{
								Expect(pError).to.not.exist;

								// Seed local with original data
								seedLocalBooks(tmpFable, tmpBooks);

								// Now mutate 50 records on the server (IDs 2001-2050)
								mutateBooks(_MockServerData.Books, 2001, 2050, NEWER_UPDATE_DATE, 'Updated');

								resetRequestLog();

								setupSyncServices(tmpFable, 'Ongoing',
									(pError) =>
									{
										Expect(pError).to.not.exist;
										tmpFable.MeadowSync.syncAll(
											(pSyncError) =>
											{
												Expect(pSyncError).to.not.exist;

												let tmpEntity = tmpFable.MeadowSync.MeadowSyncEntities['Book'];
												Expect(tmpEntity.syncResults.Updated).to.equal(50);
												Expect(tmpEntity.syncResults.Created).to.equal(0);

												// Verify the updated records are correct locally
												let tmpLocal2025 = getLocalBook(tmpFable, 2025);
												Expect(tmpLocal2025.Title).to.equal('Updated-2025');

												// An unchanged record should NOT have been touched
												let tmpLocal1000 = getLocalBook(tmpFable, 1000);
												Expect(tmpLocal1000.Title).to.equal('Book-1000');

												// Efficiency: should pull only ~50 records, not all 5000
												Expect(_MockServerData.RequestLog.totalRecordsPulled).to.be.below(200,
													'Should pull far fewer records than the full dataset');

												return fDone();
											});
									});
							});
					}
				);
			}
		);

		// ── Ongoing Sync — New Records Appended ─────────────────────────────

		suite
		(
			'Ongoing Sync - New Records Appended',
			() =>
			{
				test
				(
					'Should pull only new records when 200 records are added at the end',
					function (fDone)
					{
						this.timeout(120000);

						let tmpLocalBooks = generateBooks(RECORD_COUNT, BASE_UPDATE_DATE);
						let tmpServerBooks = generateBooks(RECORD_COUNT + 200, BASE_UPDATE_DATE);
						// Give the new records a newer UpdateDate
						mutateBooks(tmpServerBooks, RECORD_COUNT + 1, RECORD_COUNT + 200, NEWER_UPDATE_DATE);

						_MockServerData.Books = tmpServerBooks;

						let tmpFable = createTestFable();
						setupSQLiteProvider(tmpFable,
							(pError) =>
							{
								Expect(pError).to.not.exist;
								seedLocalBooks(tmpFable, tmpLocalBooks);

								resetRequestLog();

								setupSyncServices(tmpFable, 'Ongoing',
									(pError) =>
									{
										Expect(pError).to.not.exist;
										tmpFable.MeadowSync.syncAll(
											(pSyncError) =>
											{
												Expect(pSyncError).to.not.exist;

												let tmpEntity = tmpFable.MeadowSync.MeadowSyncEntities['Book'];
												Expect(tmpEntity.syncResults.Created).to.equal(200);

												let tmpFinalCount = getLocalBookCount(tmpFable);
												Expect(tmpFinalCount).to.equal(RECORD_COUNT + 200);

												// Efficiency: should pull ~200 new records, not re-pull existing
												Expect(_MockServerData.RequestLog.totalRecordsPulled).to.be.below(400,
													'Should pull only the new records plus minimal overhead');

												return fDone();
											});
									});
							});
					}
				);
			}
		);

		// ── Ongoing Sync — Small Recent Changes ─────────────────────────────

		suite
		(
			'Ongoing Sync - Small Recent Changes (tail of dataset)',
			() =>
			{
				test
				(
					'Should efficiently handle 10 recently-updated records near the end',
					function (fDone)
					{
						this.timeout(120000);

						let tmpBooks = generateBooks(RECORD_COUNT, BASE_UPDATE_DATE);
						_MockServerData.Books = tmpBooks.map((b) => Object.assign({}, b));

						let tmpFable = createTestFable();
						setupSQLiteProvider(tmpFable,
							(pError) =>
							{
								Expect(pError).to.not.exist;
								seedLocalBooks(tmpFable, tmpBooks);

								// Mutate just 10 records near the end (IDs 4990-4999)
								mutateBooks(_MockServerData.Books, 4990, 4999, NEWER_UPDATE_DATE, 'Recent');

								resetRequestLog();

								setupSyncServices(tmpFable, 'Ongoing',
									(pError) =>
									{
										Expect(pError).to.not.exist;
										tmpFable.MeadowSync.syncAll(
											(pSyncError) =>
											{
												Expect(pSyncError).to.not.exist;

												let tmpEntity = tmpFable.MeadowSync.MeadowSyncEntities['Book'];
												Expect(tmpEntity.syncResults.Updated).to.equal(10);
												Expect(tmpEntity.syncResults.Created).to.equal(0);

												// Verify correct records updated
												Expect(getLocalBook(tmpFable, 4995).Title).to.equal('Recent-4995');
												Expect(getLocalBook(tmpFable, 4989).Title).to.equal('Book-4989');

												// Efficiency: should pull very few records
												Expect(_MockServerData.RequestLog.totalRecordsPulled).to.be.below(100,
													'Small tail changes should require very few record pulls');

												return fDone();
											});
									});
							});
					}
				);
			}
		);

		// ── Ongoing Sync — Large Changeset ──────────────────────────────────

		suite
		(
			'Ongoing Sync - Large Changeset (half the dataset)',
			() =>
			{
				test
				(
					'Should handle updating 2500 of 5000 records',
					function (fDone)
					{
						this.timeout(120000);

						let tmpBooks = generateBooks(RECORD_COUNT, BASE_UPDATE_DATE);
						_MockServerData.Books = tmpBooks.map((b) => Object.assign({}, b));

						let tmpFable = createTestFable();
						setupSQLiteProvider(tmpFable,
							(pError) =>
							{
								Expect(pError).to.not.exist;
								seedLocalBooks(tmpFable, tmpBooks);

								// Update the entire second half of the dataset
								mutateBooks(_MockServerData.Books, 2501, 5000, NEWER_UPDATE_DATE, 'Bulk');

								resetRequestLog();

								setupSyncServices(tmpFable, 'Ongoing',
									(pError) =>
									{
										Expect(pError).to.not.exist;
										tmpFable.MeadowSync.syncAll(
											(pSyncError) =>
											{
												Expect(pSyncError).to.not.exist;

												let tmpEntity = tmpFable.MeadowSync.MeadowSyncEntities['Book'];
												Expect(tmpEntity.syncResults.Updated).to.equal(2500);
												Expect(tmpEntity.syncResults.Created).to.equal(0);

												// Verify boundary records
												Expect(getLocalBook(tmpFable, 2500).Title).to.equal('Book-2500');
												Expect(getLocalBook(tmpFable, 2501).Title).to.equal('Bulk-2501');
												Expect(getLocalBook(tmpFable, 5000).Title).to.equal('Bulk-5000');

												// Even with 2500 changes, should still be more efficient
												// than pulling all 5000 (the UpdateDate fast-sync
												// handles this without bisection)
												Expect(_MockServerData.RequestLog.totalRecordsPulled).to.be.below(3000,
													'Large changeset should not require pulling the entire dataset');

												return fDone();
											});
									});
							});
					}
				);
			}
		);

		// ── Ongoing Sync — Scattered Small Changes ──────────────────────────

		suite
		(
			'Ongoing Sync - Scattered Small Changes',
			() =>
			{
				test
				(
					'Should handle 5 records changed at different positions',
					function (fDone)
					{
						this.timeout(120000);

						let tmpBooks = generateBooks(RECORD_COUNT, BASE_UPDATE_DATE);
						_MockServerData.Books = tmpBooks.map((b) => Object.assign({}, b));

						let tmpFable = createTestFable();
						setupSQLiteProvider(tmpFable,
							(pError) =>
							{
								Expect(pError).to.not.exist;
								seedLocalBooks(tmpFable, tmpBooks);

								// Scatter changes across the dataset
								_MockServerData.Books[9].UpdateDate = NEWER_UPDATE_DATE;     // ID 10
								_MockServerData.Books[9].Title = 'Scattered-10';
								_MockServerData.Books[999].UpdateDate = NEWER_UPDATE_DATE;   // ID 1000
								_MockServerData.Books[999].Title = 'Scattered-1000';
								_MockServerData.Books[2499].UpdateDate = NEWER_UPDATE_DATE;  // ID 2500
								_MockServerData.Books[2499].Title = 'Scattered-2500';
								_MockServerData.Books[3999].UpdateDate = NEWER_UPDATE_DATE;  // ID 4000
								_MockServerData.Books[3999].Title = 'Scattered-4000';
								_MockServerData.Books[4999].UpdateDate = NEWER_UPDATE_DATE;  // ID 5000
								_MockServerData.Books[4999].Title = 'Scattered-5000';

								resetRequestLog();

								setupSyncServices(tmpFable, 'Ongoing',
									(pError) =>
									{
										Expect(pError).to.not.exist;
										tmpFable.MeadowSync.syncAll(
											(pSyncError) =>
											{
												Expect(pSyncError).to.not.exist;

												let tmpEntity = tmpFable.MeadowSync.MeadowSyncEntities['Book'];
												Expect(tmpEntity.syncResults.Updated).to.equal(5);
												Expect(tmpEntity.syncResults.Created).to.equal(0);

												// Verify all scattered changes applied
												Expect(getLocalBook(tmpFable, 10).Title).to.equal('Scattered-10');
												Expect(getLocalBook(tmpFable, 1000).Title).to.equal('Scattered-1000');
												Expect(getLocalBook(tmpFable, 2500).Title).to.equal('Scattered-2500');
												Expect(getLocalBook(tmpFable, 4000).Title).to.equal('Scattered-4000');
												Expect(getLocalBook(tmpFable, 5000).Title).to.equal('Scattered-5000');

												return fDone();
											});
									});
							});
					}
				);
			}
		);

		// ── Direct Bisection — Unchanged Data ───────────────────────────────

		suite
		(
			'Direct Bisection - Unchanged Data',
			() =>
			{
				test
				(
					'Should skip all ranges when data is identical (zero record pulls)',
					function (fDone)
					{
						this.timeout(120000);

						let tmpBooks = generateBooks(RECORD_COUNT, BASE_UPDATE_DATE);
						_MockServerData.Books = tmpBooks.map((b) => Object.assign({}, b));

						let tmpFable = createTestFable();
						setupSQLiteProvider(tmpFable,
							(pError) =>
							{
								Expect(pError).to.not.exist;
								seedLocalBooks(tmpFable, tmpBooks);

								resetRequestLog();

								setupSyncServices(tmpFable, 'Ongoing',
									(pError) =>
									{
										Expect(pError).to.not.exist;

										let tmpEntity = tmpFable.MeadowSync.MeadowSyncEntities['Book'];

										// Initialize internal state that _syncInternal normally sets
										tmpEntity._recordsCreated = 0;
										tmpEntity._recordsUpdated = 0;
										tmpEntity._totalSyncedThisSync = 0;
										tmpEntity._hasUpdateDate = true;
										tmpEntity._hasDeletedColumn = true;
										tmpEntity.operation.createProgressTracker(RECORD_COUNT, 'FullSync-Book');

										// Call _bisectRange directly
										tmpEntity._bisectRange(1, RECORD_COUNT, 0,
											() =>
											{
												// The bisection checks max UpdateDate by requesting 1 record
											// (sorted DESC, limit 1) which counts as a record pull request.
											// But no actual range pulls should occur.
											Expect(_MockServerData.RequestLog.totalRecordsPulled).to.be.at.most(1,
												'Bisection should pull at most 1 record (date-check metadata) when data is identical');

											// Should have minimal count queries (ideally just 1 at top level
											// if counts+dates match immediately)
											Expect(_MockServerData.RequestLog.countFilteredRequests).to.be.at.most(2,
												'Should require very few count queries when data matches at top level');

												return fDone();
											});
									});
							});
					}
				);
			}
		);

		// ── Direct Bisection — Changed Range ────────────────────────────────

		suite
		(
			'Direct Bisection - Changed Range',
			() =>
			{
				test
				(
					'Should only pull records from the range containing changes',
					function (fDone)
					{
						this.timeout(120000);

						let tmpBooks = generateBooks(RECORD_COUNT, BASE_UPDATE_DATE);
						_MockServerData.Books = tmpBooks.map((b) => Object.assign({}, b));

						let tmpFable = createTestFable();
						setupSQLiteProvider(tmpFable,
							(pError) =>
							{
								Expect(pError).to.not.exist;
								seedLocalBooks(tmpFable, tmpBooks);

								// Mutate 50 records in the server (IDs 2001-2050)
								mutateBooks(_MockServerData.Books, 2001, 2050, NEWER_UPDATE_DATE, 'Bisect-Changed');

								resetRequestLog();

								setupSyncServices(tmpFable, 'Ongoing',
									(pError) =>
									{
										Expect(pError).to.not.exist;

										let tmpEntity = tmpFable.MeadowSync.MeadowSyncEntities['Book'];

										// Initialize internal state that _syncInternal normally sets
										tmpEntity._recordsCreated = 0;
										tmpEntity._recordsUpdated = 0;
										tmpEntity._totalSyncedThisSync = 0;
										tmpEntity._hasUpdateDate = true;
										tmpEntity._hasDeletedColumn = true;
										tmpEntity.operation.createProgressTracker(RECORD_COUNT, 'FullSync-Book');

										tmpEntity._bisectRange(1, RECORD_COUNT, 0,
											() =>
											{
												// Bisection operates at the range level: it pulls the entire
												// leaf range containing the changed records, then upserts all
												// records in that range (unconditional update for existing).
												// With BisectMinRangeSize=1000 and 5000 records, the affected
												// leaf range is ~625 records.
												Expect(tmpEntity._recordsUpdated).to.be.at.least(50,
													'Should update at least the 50 changed records');
												Expect(tmpEntity._recordsUpdated).to.be.below(1500,
													'Should not update the entire dataset');

												// Efficiency: only the affected leaf range(s) should be pulled
												Expect(_MockServerData.RequestLog.totalRecordsPulled).to.be.below(1500,
													'Should pull only the affected range, not the entire dataset');
												Expect(_MockServerData.RequestLog.totalRecordsPulled).to.be.above(49,
													'Must pull at least the 50 changed records');

												// Verify the changed records
												Expect(getLocalBook(tmpFable, 2025).Title).to.equal('Bisect-Changed-2025');
												// Verify an unchanged record was NOT re-fetched
												Expect(getLocalBook(tmpFable, 1000).Title).to.equal('Book-1000');

												return fDone();
											});
									});
							});
					}
				);
			}
		);

		// ── Direct Bisection — Count Mismatch (Missing Local Records) ───────

		suite
		(
			'Direct Bisection - Count Mismatch',
			() =>
			{
				test
				(
					'Should pull missing records when local is missing a contiguous range',
					function (fDone)
					{
						this.timeout(120000);

						let tmpBooks = generateBooks(RECORD_COUNT, BASE_UPDATE_DATE);
						_MockServerData.Books = tmpBooks.map((b) => Object.assign({}, b));

						let tmpFable = createTestFable();
						setupSQLiteProvider(tmpFable,
							(pError) =>
							{
								Expect(pError).to.not.exist;

								// Seed local with all EXCEPT IDs 3001-3050 (50 missing records)
								let tmpLocalBooks = tmpBooks.filter(
									(b) => b.IDBook < 3001 || b.IDBook > 3050);
								seedLocalBooks(tmpFable, tmpLocalBooks);
								Expect(getLocalBookCount(tmpFable)).to.equal(RECORD_COUNT - 50);

								resetRequestLog();

								setupSyncServices(tmpFable, 'Ongoing',
									(pError) =>
									{
										Expect(pError).to.not.exist;

										let tmpEntity = tmpFable.MeadowSync.MeadowSyncEntities['Book'];

										// Initialize internal state that _syncInternal normally sets
										tmpEntity._recordsCreated = 0;
										tmpEntity._recordsUpdated = 0;
										tmpEntity._totalSyncedThisSync = 0;
										tmpEntity._hasUpdateDate = true;
										tmpEntity._hasDeletedColumn = true;
										tmpEntity.operation.createProgressTracker(RECORD_COUNT, 'FullSync-Book');

										tmpEntity._bisectRange(1, RECORD_COUNT, 0,
											() =>
											{
												Expect(tmpEntity._recordsCreated).to.equal(50,
													'Should create exactly 50 missing records');

												// The 50 missing records should now exist locally
												Expect(getLocalBookCount(tmpFable)).to.equal(RECORD_COUNT);
												Expect(getLocalBook(tmpFable, 3025)).to.not.be.undefined;
												Expect(getLocalBook(tmpFable, 3025).Title).to.equal('Book-3025');

												// Efficiency: should not pull the entire dataset
												Expect(_MockServerData.RequestLog.totalRecordsPulled).to.be.below(1500,
													'Should only pull the range containing the missing records');

												return fDone();
											});
									});
							});
					}
				);
			}
		);

		// ── Idempotency ─────────────────────────────────────────────────────

		suite
		(
			'Idempotency',
			() =>
			{
				test
				(
					'Should pull zero records on a second ongoing sync after changes are applied',
					function (fDone)
					{
						this.timeout(120000);

						let tmpBooks = generateBooks(RECORD_COUNT, BASE_UPDATE_DATE);
						_MockServerData.Books = tmpBooks.map((b) => Object.assign({}, b));

						let tmpFable = createTestFable();
						setupSQLiteProvider(tmpFable,
							(pError) =>
							{
								Expect(pError).to.not.exist;
								seedLocalBooks(tmpFable, tmpBooks);

								// Mutate 50 records on server
								mutateBooks(_MockServerData.Books, 2001, 2050, NEWER_UPDATE_DATE, 'Idempotent');

								// First ongoing sync — should pull the changes
								setupSyncServices(tmpFable, 'Ongoing',
									(pError) =>
									{
										Expect(pError).to.not.exist;
										tmpFable.MeadowSync.syncAll(
											(pSyncError) =>
											{
												Expect(pSyncError).to.not.exist;

												let tmpEntity1 = tmpFable.MeadowSync.MeadowSyncEntities['Book'];
												Expect(tmpEntity1.syncResults.Updated).to.equal(50);

												// Verify the sync actually applied changes locally
												Expect(getLocalBook(tmpFable, 2025).Title).to.equal('Idempotent-2025');

												// Diagnostic: check what the local UpdateDate looks like
												// vs what the server has -- a mismatch here is the root cause
												// of the "walks all records" bug
												let tmpLocalDate = getLocalBook(tmpFable, 2025).UpdateDate;
												let tmpServerDate = _MockServerData.Books[2024].UpdateDate;
												// marshalRecord formats dates with space separator
												// (YYYY-MM-DD HH:mm:ss.SSS) while server uses ISO T separator.
												// Normalize both for comparison.
												let tmpNormLocal = tmpLocalDate.replace(/Z$/, '').replace('T', ' ');
												let tmpNormServer = tmpServerDate.replace(/Z$/, '').replace('T', ' ');
												Expect(tmpNormLocal).to.equal(tmpNormServer,
													'Local UpdateDate should match server UpdateDate after sync');

												// Second ongoing sync — should find nothing to do
												resetRequestLog();

												// Re-instantiate MeadowSync on the same Fable to get
												// a fresh sync entity but reuse the same DB connection
												setupSyncServices(tmpFable, 'Ongoing',
													(pError2) =>
													{
														Expect(pError2).to.not.exist;
														tmpFable.MeadowSync.syncAll(
															(pSyncError2) =>
															{
																Expect(pSyncError2).to.not.exist;

																let tmpEntity2 = tmpFable.MeadowSync.MeadowSyncEntities['Book'];
																Expect(tmpEntity2.syncResults.Created).to.equal(0,
																	'Second sync should create zero records');
																Expect(tmpEntity2.syncResults.Updated).to.equal(0,
																	'Second sync should update zero records');
																Expect(_MockServerData.RequestLog.totalRecordsPulled).to.equal(0,
																	'Second sync should pull zero records');

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

		// ── Deleted Records — Late Enable ───────────────────────────────────

		suite
		(
			'Deleted Records - Late Enable of SyncDeletedRecords',
			() =>
			{
				test
				(
					'Should create-as-deleted records that were never synced locally',
					function (fDone)
					{
						this.timeout(120000);

						// Server has 5000 active + 100 deleted records
						let tmpActiveBooks = generateBooks(RECORD_COUNT, BASE_UPDATE_DATE);
						let tmpDeletedBooks = [];
						for (let i = RECORD_COUNT + 1; i <= RECORD_COUNT + 100; i++)
						{
							tmpDeletedBooks.push(
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
						_MockServerData.Books = tmpActiveBooks.concat(tmpDeletedBooks);

						let tmpFable = createTestFable();
						setupSQLiteProvider(tmpFable,
							(pError) =>
							{
								Expect(pError).to.not.exist;

								// Seed local with only the active records (simulating
								// an older version that never synced deleted records)
								seedLocalBooks(tmpFable, tmpActiveBooks);
								Expect(getLocalBookCount(tmpFable)).to.equal(RECORD_COUNT);

								resetRequestLog();

								// Now run ongoing sync WITH SyncDeletedRecords enabled
								setupSyncServices(tmpFable, 'Ongoing',
									(pError) =>
									{
										Expect(pError).to.not.exist;
										tmpFable.MeadowSync.syncAll(
											(pSyncError) =>
											{
												Expect(pSyncError).to.not.exist;

												// The 100 deleted records should now exist locally
												let tmpDeletedLocal = tmpFable.MeadowSQLiteProvider.db
													.prepare('SELECT COUNT(*) AS cnt FROM Book WHERE Deleted = 1')
													.get().cnt;
												Expect(tmpDeletedLocal).to.equal(100,
													'All 100 deleted server records should be created locally');

												// Verify a specific deleted record
												let tmpDeletedBook = getLocalBook(tmpFable, RECORD_COUNT + 50);
												Expect(tmpDeletedBook).to.not.be.undefined;
												Expect(tmpDeletedBook.Deleted).to.equal(1);
												Expect(tmpDeletedBook.Title).to.equal(`Deleted-Book-${RECORD_COUNT + 50}`);

												// Active records should still be intact
												Expect(getLocalBookCount(tmpFable)).to.equal(RECORD_COUNT);

												return fDone();
											});
									},
									{ SyncDeletedRecords: true });
							});
					}
				);

				test
				(
					'Should mark existing active records as deleted when server has them deleted',
					function (fDone)
					{
						this.timeout(120000);

						// Start with 5000 active records on both sides
						let tmpBooks = generateBooks(RECORD_COUNT, BASE_UPDATE_DATE);
						_MockServerData.Books = tmpBooks.map((b) => Object.assign({}, b));

						let tmpFable = createTestFable();
						setupSQLiteProvider(tmpFable,
							(pError) =>
							{
								Expect(pError).to.not.exist;
								seedLocalBooks(tmpFable, tmpBooks);

								// Now delete 20 records on the server (IDs 100-119)
								for (let i = 99; i < 119; i++)
								{
									_MockServerData.Books[i].Deleted = 1;
									_MockServerData.Books[i].DeleteDate = '2025-08-01T00:00:00.000Z';
									_MockServerData.Books[i].DeletingIDUser = 1;
									_MockServerData.Books[i].UpdateDate = NEWER_UPDATE_DATE;
								}

								resetRequestLog();

								// Run ongoing sync with SyncDeletedRecords
								setupSyncServices(tmpFable, 'Ongoing',
									(pError) =>
									{
										Expect(pError).to.not.exist;
										tmpFable.MeadowSync.syncAll(
											(pSyncError) =>
											{
												Expect(pSyncError).to.not.exist;

												// The 20 records should now be marked deleted locally
												let tmpDeletedLocal = tmpFable.MeadowSQLiteProvider.db
													.prepare('SELECT COUNT(*) AS cnt FROM Book WHERE Deleted = 1')
													.get().cnt;
												Expect(tmpDeletedLocal).to.equal(20,
													'20 records should be marked as deleted locally');

												// Verify a specific record was soft-deleted
												let tmpDeletedBook = getLocalBook(tmpFable, 110);
												Expect(tmpDeletedBook.Deleted).to.equal(1);

												// Non-deleted records should be untouched
												let tmpActiveBook = getLocalBook(tmpFable, 200);
												Expect(tmpActiveBook.Deleted).to.equal(0);

												return fDone();
											});
									},
									{ SyncDeletedRecords: true });
							});
					}
				);

				test
				(
					'Should handle mixed scenario: new deleted records + existing records to mark deleted',
					function (fDone)
					{
						this.timeout(120000);

						let tmpActiveBooks = generateBooks(RECORD_COUNT, BASE_UPDATE_DATE);

						// Server: 5000 active, 50 soft-deleted within the range (IDs 500-549),
						// plus 50 deleted-only records at the end (IDs 5001-5050) never synced
						let tmpServerBooks = tmpActiveBooks.map((b) => Object.assign({}, b));

						// Mark 500-549 as deleted on server
						for (let i = 499; i < 549; i++)
						{
							tmpServerBooks[i].Deleted = 1;
							tmpServerBooks[i].DeleteDate = '2025-08-01T00:00:00.000Z';
							tmpServerBooks[i].DeletingIDUser = 1;
							tmpServerBooks[i].UpdateDate = NEWER_UPDATE_DATE;
						}

						// Add 50 deleted-only records at the end
						for (let i = RECORD_COUNT + 1; i <= RECORD_COUNT + 50; i++)
						{
							tmpServerBooks.push(
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

						_MockServerData.Books = tmpServerBooks;

						let tmpFable = createTestFable();
						setupSQLiteProvider(tmpFable,
							(pError) =>
							{
								Expect(pError).to.not.exist;

								// Local only has the 5000 active records (old version, never synced deletes)
								seedLocalBooks(tmpFable, tmpActiveBooks);

								resetRequestLog();

								setupSyncServices(tmpFable, 'Ongoing',
									(pError) =>
									{
										Expect(pError).to.not.exist;
										tmpFable.MeadowSync.syncAll(
											(pSyncError) =>
											{
												Expect(pSyncError).to.not.exist;

												let tmpDeletedLocal = tmpFable.MeadowSQLiteProvider.db
													.prepare('SELECT COUNT(*) AS cnt FROM Book WHERE Deleted = 1')
													.get().cnt;
												// 50 existing records marked deleted + 50 new deleted records created
												Expect(tmpDeletedLocal).to.equal(100,
													'Should have 100 total deleted records locally');

												// Verify a record that was active but now deleted
												let tmpMarkedDeleted = getLocalBook(tmpFable, 525);
												Expect(tmpMarkedDeleted.Deleted).to.equal(1);

												// Verify a created-as-deleted record
												let tmpCreatedDeleted = getLocalBook(tmpFable, RECORD_COUNT + 25);
												Expect(tmpCreatedDeleted).to.not.be.undefined;
												Expect(tmpCreatedDeleted.Deleted).to.equal(1);
												Expect(tmpCreatedDeleted.Title).to.equal(`Deleted-Book-${RECORD_COUNT + 25}`);

												// Active records outside the deleted range should be fine
												let tmpStillActive = getLocalBook(tmpFable, 600);
												Expect(tmpStillActive.Deleted).to.equal(0);

												return fDone();
											});
									},
									{ SyncDeletedRecords: true });
							});
					}
				);
			}
		);

		// ── Efficiency — Verify bisection scales logarithmically ─────────────

		suite
		(
			'Bisection Efficiency',
			() =>
			{
				test
				(
					'Unchanged data should require O(1) API calls regardless of dataset size',
					function (fDone)
					{
						this.timeout(120000);

						let tmpBooks = generateBooks(RECORD_COUNT, BASE_UPDATE_DATE);
						_MockServerData.Books = tmpBooks.map((b) => Object.assign({}, b));

						let tmpFable = createTestFable();
						setupSQLiteProvider(tmpFable,
							(pError) =>
							{
								Expect(pError).to.not.exist;
								seedLocalBooks(tmpFable, tmpBooks);

								resetRequestLog();

								setupSyncServices(tmpFable, 'Ongoing',
									(pError) =>
									{
										Expect(pError).to.not.exist;
										tmpFable.MeadowSync.syncAll(
											(pSyncError) =>
											{
												Expect(pSyncError).to.not.exist;

												let tmpLog = _MockServerData.RequestLog;

												// For unchanged data:
												// - Stage 3 (UpdateDate fast-sync): 1 count request (filtered)
												//   → counts match → ExistingRecordsInSync=true
												//   → 1 count for UpdateDate GT → 0 new records
												// - No bisection, no record pulls
												// Total filtered count requests should be very small
												Expect(tmpLog.countFilteredRequests).to.be.at.most(5,
													'Unchanged data should need very few filtered count queries');
												Expect(tmpLog.recordPullRequests).to.equal(0,
													'Unchanged data should not trigger any record pull requests');
												Expect(tmpLog.totalRecordsPulled).to.equal(0,
													'Unchanged data should pull zero records');

												return fDone();
											});
									});
							});
					}
				);

				test
				(
					'Small changes should require far fewer API calls than dataset size',
					function (fDone)
					{
						this.timeout(120000);

						let tmpBooks = generateBooks(RECORD_COUNT, BASE_UPDATE_DATE);
						_MockServerData.Books = tmpBooks.map((b) => Object.assign({}, b));

						let tmpFable = createTestFable();
						setupSQLiteProvider(tmpFable,
							(pError) =>
							{
								Expect(pError).to.not.exist;
								seedLocalBooks(tmpFable, tmpBooks);

								// Change just 10 records
								mutateBooks(_MockServerData.Books, 100, 109, NEWER_UPDATE_DATE, 'Efficiency');

								resetRequestLog();

								setupSyncServices(tmpFable, 'Ongoing',
									(pError) =>
									{
										Expect(pError).to.not.exist;
										tmpFable.MeadowSync.syncAll(
											(pSyncError) =>
											{
												Expect(pSyncError).to.not.exist;

												let tmpEntity = tmpFable.MeadowSync.MeadowSyncEntities['Book'];
												Expect(tmpEntity.syncResults.Updated).to.equal(10);

												let tmpLog = _MockServerData.RequestLog;

												// With 10 changes out of 5000, the UpdateDate fast-sync
												// should pull just the 10 changed records directly.
												// Total API calls should be well under 50 (vs 5000/100 = 50 pages for full scan)
												let tmpTotalAPICalls = tmpLog.countRequests + tmpLog.countFilteredRequests
													+ tmpLog.recordPullRequests + tmpLog.maxIDRequests;
												Expect(tmpTotalAPICalls).to.be.below(20,
													'10 changes out of 5000 should need very few API calls');
												Expect(tmpLog.totalRecordsPulled).to.be.below(50,
													'Should pull close to just the 10 changed records');

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
