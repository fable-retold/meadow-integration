/*
	Unit tests for clone reconciliation of records UN-DELETED at the source.

	A record that was synced as deleted (local Deleted=1) and is later restored
	upstream must come back to life in the clone: Deleted=0, current field
	values, its own GUID, and no second row.  The forward phases are the only
	path that can do this — the delete phases only ever walk the source's
	Deleted=1 set — so the existence check in _upsertRecord has to be able to
	see soft-deleted local rows.

	Both source dialects are exercised, because the deleted set is retrieved
	differently on each:
	  - meadow-endpoints 4.x   : FBV~Deleted~EQ~1 overrides the automatic filter
	  - meadow-endpoints 2.x   : it does not; the clone appends the configured
	                             SyncDeletedRecordsQueryString (includeDeleted=true)

	Uses a delete-tracking-aware mock source API and an in-memory SQLite clone.
*/

const Chai = require('chai');
const Expect = Chai.expect;

const libHTTP = require('http');
const libFable = require('fable');
const libMeadowConnectionSQLite = require('meadow-connection-sqlite');

const libMeadowCloneRestClient = require('../source/services/clone/Meadow-Service-RestClient.js');
const libMeadowSync = require('../source/services/clone/Meadow-Service-Sync.js');

const MOCK_PORT = 18099;
const MOCK_BASE_URL = `http://localhost:${MOCK_PORT}/1.0/`;

const _BookSchema =
{
	TableName: 'Book',
	Columns:
	[
		{ Column: 'IDBook',          DataType: 'ID'       },
		{ Column: 'GUIDBook',        DataType: 'GUID'     },
		{ Column: 'CreateDate',      DataType: 'DateTime' },
		{ Column: 'CreatingIDUser',  DataType: 'Numeric'  },
		{ Column: 'UpdateDate',      DataType: 'DateTime' },
		{ Column: 'UpdatingIDUser',  DataType: 'Numeric'  },
		{ Column: 'Deleted',         DataType: 'Boolean'  },
		{ Column: 'DeleteDate',      DataType: 'DateTime' },
		{ Column: 'DeletingIDUser',  DataType: 'Numeric'  },
		{ Column: 'Title',           DataType: 'String'   }
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

// ── Mock source API ─────────────────────────────────────────────────────────
//
// Holds the authoritative record set and applies delete tracking the way
// meadow-endpoints does: deleted rows are withheld unless the request opts in.

const _Source =
{
	Books: [],
	// 'FilterOverride' (4.x): an explicit FBV~Deleted~EQ~1 wins.
	// 'QueryStringOnly' (2.x): only ?includeDeleted=true exposes deleted rows.
	DeletedMode: 'FilterOverride'
};

function makeSourceBook(pID, pTitle, pUpdateDate)
{
	return {
		IDBook: pID,
		GUIDBook: `GUID-BOOK-${pID}`,
		CreateDate: '2026-01-01T00:00:00.000Z',
		CreatingIDUser: 1,
		UpdateDate: pUpdateDate || '2026-01-01T00:00:00.000Z',
		UpdatingIDUser: 1,
		Deleted: 0,
		DeleteDate: null,
		DeletingIDUser: 0,
		Title: pTitle
	};
}

function parseFilter(pFilterString)
{
	const tmpParsed = { filters: [], sort: false };
	if (!pFilterString)
	{
		return tmpParsed;
	}

	const tmpSegments = pFilterString.split('~FSF~');
	if (tmpSegments.length > 1)
	{
		const tmpSortTokens = tmpSegments[1].split('~');
		if (tmpSortTokens.length >= 2)
		{
			tmpParsed.sort = { Column: tmpSortTokens[0], Direction: tmpSortTokens[1] };
		}
	}

	let tmpFilterPart = tmpSegments[0];
	if (tmpFilterPart.indexOf('FBV~') === 0)
	{
		tmpFilterPart = tmpFilterPart.substring(4);
	}
	if (tmpFilterPart.length < 1)
	{
		return tmpParsed;
	}

	const tmpClauses = tmpFilterPart.split('~FBV~');
	for (let i = 0; i < tmpClauses.length; i++)
	{
		const tmpTokens = tmpClauses[i].split('~');
		if (tmpTokens.length >= 3)
		{
			tmpParsed.filters.push({ Column: tmpTokens[0], Operator: tmpTokens[1], Value: tmpTokens.slice(2).join('~') });
		}
	}

	return tmpParsed;
}

function applyFilters(pBooks, pParsed)
{
	let tmpResult = pBooks.slice();

	for (let i = 0; i < pParsed.filters.length; i++)
	{
		const tmpFilter = pParsed.filters[i];
		tmpResult = tmpResult.filter((pBook) =>
		{
			let tmpBookValue = pBook[tmpFilter.Column];
			let tmpFilterValue = tmpFilter.Value;
			if (tmpBookValue === undefined || tmpBookValue === null)
			{
				return false;
			}
			if (tmpFilter.Column === 'IDBook' || tmpFilter.Column === 'Deleted')
			{
				tmpBookValue = Number(tmpBookValue);
				tmpFilterValue = Number(tmpFilterValue);
			}
			else
			{
				tmpBookValue = String(tmpBookValue).replace(/Z$/, '');
				tmpFilterValue = String(tmpFilterValue).replace(/Z$/, '');
			}

			switch (tmpFilter.Operator)
			{
				case 'GE': return tmpBookValue >= tmpFilterValue;
				case 'LE': return tmpBookValue <= tmpFilterValue;
				case 'GT': return tmpBookValue > tmpFilterValue;
				case 'LT': return tmpBookValue < tmpFilterValue;
				case 'EQ': return tmpBookValue == tmpFilterValue;
				default: return true;
			}
		});
	}

	if (pParsed.sort)
	{
		const tmpDirection = (pParsed.sort.Direction || '').toUpperCase() === 'DESC' ? -1 : 1;
		tmpResult.sort((pLeft, pRight) =>
		{
			if (pLeft[pParsed.sort.Column] < pRight[pParsed.sort.Column]) return -1 * tmpDirection;
			if (pLeft[pParsed.sort.Column] > pRight[pParsed.sort.Column]) return 1 * tmpDirection;
			return 0;
		});
	}

	return tmpResult;
}

/**
 * Apply source-side delete tracking, mirroring meadow-endpoints.
 */
function applyDeleteTracking(pBooks, pParsed, pIncludeDeletedQueryString)
{
	if (pIncludeDeletedQueryString)
	{
		return pBooks;
	}

	const tmpHasExplicitDeletedFilter = pParsed.filters.some((pFilter) => { return pFilter.Column === 'Deleted'; });
	if (tmpHasExplicitDeletedFilter && _Source.DeletedMode === 'FilterOverride')
	{
		return pBooks;
	}

	return pBooks.filter((pBook) => { return Number(pBook.Deleted) !== 1; });
}

function selectRecords(pFilterString, pQueryString)
{
	const tmpParsed = parseFilter(pFilterString);
	const tmpIncludeDeleted = (pQueryString || '').indexOf('includeDeleted=true') > -1;
	const tmpVisible = applyDeleteTracking(_Source.Books, tmpParsed, tmpIncludeDeleted);
	return applyFilters(tmpVisible, tmpParsed);
}

function createMockServer()
{
	return libHTTP.createServer(
		(pRequest, pResponse) =>
		{
			const tmpURLParts = pRequest.url.split('?');
			const tmpURL = tmpURLParts[0];
			const tmpQueryString = tmpURLParts[1] || '';
			pResponse.setHeader('Content-Type', 'application/json');

			// GET /1.0/Book/Max/IDBook
			if (tmpURL.match(/\/1\.0\/Book\/Max\/IDBook$/))
			{
				const tmpVisible = selectRecords('', tmpQueryString);
				let tmpMax = 0;
				for (let i = 0; i < tmpVisible.length; i++)
				{
					if (tmpVisible[i].IDBook > tmpMax) tmpMax = tmpVisible[i].IDBook;
				}
				return pResponse.end(JSON.stringify({ IDBook: tmpMax }));
			}

			// GET /1.0/Books/Count/FilteredTo/<filter>
			const tmpCountFiltered = tmpURL.match(/\/1\.0\/Books\/Count\/FilteredTo\/(.+)$/);
			if (tmpCountFiltered)
			{
				return pResponse.end(JSON.stringify({ Count: selectRecords(tmpCountFiltered[1], tmpQueryString).length }));
			}

			// GET /1.0/Books/Count
			if (tmpURL.match(/\/1\.0\/Books\/Count$/))
			{
				return pResponse.end(JSON.stringify({ Count: selectRecords('', tmpQueryString).length }));
			}

			// GET /1.0/Books/FilteredTo/<filter>/<offset>/<pageSize>
			const tmpRecordsFiltered = tmpURL.match(/\/1\.0\/Books\/FilteredTo\/(.+)\/(\d+)\/(\d+)$/);
			if (tmpRecordsFiltered)
			{
				const tmpOffset = parseInt(tmpRecordsFiltered[2], 10);
				const tmpPageSize = parseInt(tmpRecordsFiltered[3], 10);
				const tmpRecords = selectRecords(tmpRecordsFiltered[1], tmpQueryString);
				return pResponse.end(JSON.stringify(tmpRecords.slice(tmpOffset, tmpOffset + tmpPageSize)));
			}

			pResponse.statusCode = 404;
			return pResponse.end(JSON.stringify({ Error: `Unknown endpoint: ${tmpURL}` }));
		});
}

// ── Local clone helpers ─────────────────────────────────────────────────────

function createTestFable()
{
	const tmpFable = new libFable(
		{
			Product: 'CloneUndeleteSyncTest',
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
			if (pError)
			{
				return fCallback(pError);
			}
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

function seedClone(pFable, pID, pGUID, pDeleted, pTitle, pUpdateDate)
{
	pFable.MeadowSQLiteProvider.db.prepare(
		'INSERT INTO Book (IDBook, GUIDBook, CreateDate, UpdateDate, Deleted, DeleteDate, Title) VALUES (?, ?, ?, ?, ?, ?, ?)')
		.run(pID, pGUID, '2026-01-01 00:00:00.000', pUpdateDate || '2026-01-01 00:00:00.000', pDeleted, pDeleted ? '2026-02-01 00:00:00.000' : '', pTitle);
}

function cloneRows(pFable)
{
	return pFable.MeadowSQLiteProvider.db.prepare('SELECT * FROM Book ORDER BY IDBook').all();
}
function cloneRowByID(pFable, pID)
{
	return pFable.MeadowSQLiteProvider.db.prepare('SELECT * FROM Book WHERE IDBook = ?').get(pID);
}

// ── Suite ───────────────────────────────────────────────────────────────────

suite
(
	'Clone un-delete reconciliation',
	() =>
	{
		let _MockServer = null;

		suiteSetup((fDone) => { _MockServer = createMockServer(); _MockServer.listen(MOCK_PORT, fDone); });
		suiteTeardown((fDone) => { if (_MockServer) { return _MockServer.close(fDone); } return fDone(); });

		let _Fable = null;
		let _Entity = null;

		const buildEntity = (pDeletedMode, fCallback) =>
		{
			_Source.DeletedMode = pDeletedMode;
			_Fable = createTestFable();

			setupSQLite(_Fable,
				(pError) =>
				{
					if (pError)
					{
						return fCallback(pError);
					}

					_Fable.serviceManager.addServiceType('MeadowCloneRestClient', libMeadowCloneRestClient);
					_Fable.serviceManager.instantiateServiceProvider('MeadowCloneRestClient', { ServerURL: MOCK_BASE_URL });

					// The 2.x source only exposes its deleted set behind the
					// query-string workaround, exactly as the Headlight API does.
					if (pDeletedMode === 'QueryStringOnly')
					{
						_Fable.ProgramConfiguration.SyncDeletedRecordsQueryString = 'includeDeleted=true';
					}

					_Fable.serviceManager.addServiceType('MeadowSync', libMeadowSync);
					_Fable.serviceManager.instantiateServiceProvider('MeadowSync',
						{ PageSize: 100, SyncDeletedRecords: true, BackSyncTimeLimit: 999999 });
					_Fable.MeadowSync.SyncMode = 'OngoingEventualConsistency';
					_Fable.MeadowSync.SyncDeletedRecords = true;
					_Fable.MeadowSync.BackSyncTimeLimit = 999999;

					_Fable.MeadowSync.loadMeadowSchema({ Tables: { Book: _BookSchema } },
						(pSchemaError) =>
						{
							if (pSchemaError)
							{
								return fCallback(pSchemaError);
							}
							_Entity = _Fable.MeadowSync.MeadowSyncEntities['Book'];
							return fCallback();
						});
				});
		};

		// Source holds five live books; the clone holds all five but id 3 was
		// flagged deleted by an earlier delete-sync pass and has since been
		// restored at the source (its title moved on while it was away).
		const seedUndeleteScenario = () =>
		{
			_Source.Books =
			[
				makeSourceBook(1, 'Book-1', '2026-01-01T00:00:00.000Z'),
				makeSourceBook(2, 'Book-2', '2026-01-01T00:00:00.000Z'),
				makeSourceBook(3, 'Book-3-RestoredAtSource', '2026-03-01T00:00:00.000Z'),
				makeSourceBook(4, 'Book-4', '2026-01-01T00:00:00.000Z'),
				makeSourceBook(5, 'Book-5', '2026-01-01T00:00:00.000Z')
			];

			seedClone(_Fable, 1, 'GUID-BOOK-1', 0, 'Book-1');
			seedClone(_Fable, 2, 'GUID-BOOK-2', 0, 'Book-2');
			seedClone(_Fable, 3, 'GUID-BOOK-3', 1, 'Book-3');
			seedClone(_Fable, 4, 'GUID-BOOK-4', 0, 'Book-4');
			seedClone(_Fable, 5, 'GUID-BOOK-5', 0, 'Book-5');
		};

		const assertRestored = (pLabel) =>
		{
			const tmpRow = cloneRowByID(_Fable, 3);
			Expect(tmpRow, `${pLabel}: row 3 present`).to.be.an('object');
			Expect(tmpRow.Deleted, `${pLabel}: row 3 is live again`).to.equal(0);
			Expect(tmpRow.GUIDBook, `${pLabel}: GUID preserved (never collision-renamed)`).to.equal('GUID-BOOK-3');
			Expect(tmpRow.Title, `${pLabel}: field values caught up with the source`).to.equal('Book-3-RestoredAtSource');
			Expect(cloneRows(_Fable).length, `${pLabel}: no duplicate row created`).to.equal(5);

			const tmpRenamed = cloneRows(_Fable).filter((pRow) => { return String(pRow.GUIDBook).indexOf('__mdsd_') === 0; });
			Expect(tmpRenamed.length, `${pLabel}: no GUID was collision-renamed`).to.equal(0);
		};

		suite
		(
			'source on meadow-endpoints 4.x (explicit Deleted filter honored)',
			() =>
			{
				setup((fDone) => { buildEntity('FilterOverride', fDone); });

				test
				(
					'restores a record that was un-deleted at the source',
					(fDone) =>
					{
						seedUndeleteScenario();
						Expect(cloneRowByID(_Fable, 3).Deleted).to.equal(1, 'precondition: clone has it deleted');

						_Entity.sync(
							() =>
							{
								assertRestored('after sync');
								return fDone();
							});
					}
				);

				test
				(
					'a second sync pass leaves the restored record alone',
					(fDone) =>
					{
						seedUndeleteScenario();
						_Entity.sync(
							() =>
							{
								_Entity.sync(
									() =>
									{
										assertRestored('after second sync');
										return fDone();
									});
							});
					}
				);

				test
				(
					'un-deleted record is updated in place, not created',
					(fDone) =>
					{
						seedUndeleteScenario();
						_Entity._hasUpdateDate = true;
						_Entity._hasDeletedColumn = true;
						_Entity._totalSyncedThisSync = 0;
						_Entity._recordsCreated = 0;
						_Entity._recordsUpdated = 0;

						_Entity._upsertRecord(_Source.Books[2],
							() =>
							{
								Expect(_Entity._recordsUpdated, 'counted as an update').to.equal(1);
								Expect(_Entity._recordsCreated, 'no create attempted').to.equal(0);
								assertRestored('after direct upsert');
								return fDone();
							});
					}
				);

				test
				(
					'delete then un-delete then delete again converges each time',
					(fDone) =>
					{
						seedUndeleteScenario();

						// Round 1: source deletes id 3 again.
						_Source.Books[2].Deleted = 1;
						_Source.Books[2].DeleteDate = '2026-04-01T00:00:00.000Z';

						_Entity.sync(
							() =>
							{
								Expect(cloneRowByID(_Fable, 3).Deleted, 'stays deleted while the source says deleted').to.equal(1);

								// Round 2: source restores it once more.
								_Source.Books[2].Deleted = 0;
								_Source.Books[2].DeleteDate = null;
								_Source.Books[2].Title = 'Book-3-RestoredAtSource';
								_Source.Books[2].UpdateDate = '2026-05-01T00:00:00.000Z';

								_Entity.sync(
									() =>
									{
										assertRestored('after the second restore');
										return fDone();
									});
							});
					}
				);

				// ── Base behaviors, unchanged by the un-delete fix ───────────

				test
				(
					'still creates records that are not in the clone yet',
					(fDone) =>
					{
						seedUndeleteScenario();
						_Source.Books.push(makeSourceBook(6, 'Book-6-New', '2026-03-02T00:00:00.000Z'));

						_Entity.sync(
							() =>
							{
								const tmpRow = cloneRowByID(_Fable, 6);
								Expect(tmpRow, 'new record created locally').to.be.an('object');
								Expect(tmpRow.Deleted).to.equal(0);
								Expect(tmpRow.Title).to.equal('Book-6-New');
								return fDone();
							});
					}
				);

				test
				(
					'still updates live records whose source values changed',
					(fDone) =>
					{
						seedUndeleteScenario();
						_Source.Books[0].Title = 'Book-1-EditedAtSource';
						_Source.Books[0].UpdateDate = '2026-03-03T00:00:00.000Z';

						_Entity.sync(
							() =>
							{
								Expect(cloneRowByID(_Fable, 1).Title).to.equal('Book-1-EditedAtSource');
								Expect(cloneRowByID(_Fable, 1).Deleted).to.equal(0);
								return fDone();
							});
					}
				);

				test
				(
					'still flags locally-live records that the source deleted',
					(fDone) =>
					{
						seedUndeleteScenario();
						_Source.Books[3].Deleted = 1;
						_Source.Books[3].DeleteDate = '2026-03-04T00:00:00.000Z';

						_Entity.sync(
							() =>
							{
								Expect(cloneRowByID(_Fable, 4).Deleted, 'source deletion reconciled into the clone').to.equal(1);
								return fDone();
							});
					}
				);

				test
				(
					'still refuses to create rows for source-deleted ids absent from the clone',
					(fDone) =>
					{
						seedUndeleteScenario();
						const tmpNeverSynced = makeSourceBook(99, 'Book-99-DeletedBeforeSync', '2026-03-05T00:00:00.000Z');
						tmpNeverSynced.Deleted = 1;
						tmpNeverSynced.DeleteDate = '2026-03-05T00:00:00.000Z';
						_Source.Books.push(tmpNeverSynced);

						_Entity.sync(
							() =>
							{
								Expect(cloneRowByID(_Fable, 99), 'not backfilled into the clone').to.be.undefined;
								Expect(cloneRows(_Fable).length).to.equal(5);
								return fDone();
							});
					}
				);
			}
		);

		suite
		(
			'source on meadow-endpoints 2.x (deleted set only via includeDeleted)',
			() =>
			{
				setup((fDone) => { buildEntity('QueryStringOnly', fDone); });

				test
				(
					'restores a record that was un-deleted at the source',
					(fDone) =>
					{
						seedUndeleteScenario();
						Expect(cloneRowByID(_Fable, 3).Deleted).to.equal(1, 'precondition: clone has it deleted');

						_Entity.sync(
							() =>
							{
								assertRestored('after sync against a 2.x source');
								return fDone();
							});
					}
				);

				test
				(
					'still flags locally-live records that the source deleted',
					(fDone) =>
					{
						seedUndeleteScenario();
						_Source.Books[3].Deleted = 1;
						_Source.Books[3].DeleteDate = '2026-03-04T00:00:00.000Z';

						_Entity.sync(
							() =>
							{
								Expect(cloneRowByID(_Fable, 4).Deleted, 'delete sync works through the 2.x workaround').to.equal(1);
								return fDone();
							});
					}
				);
			}
		);
	}
);
