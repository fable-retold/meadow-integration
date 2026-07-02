const libFableServiceProviderBase = require('fable-serviceproviderbase');
const libMeadowOperation = require('./Meadow-Service-Operation.js');
const libSyncPoolLimit = require('./Meadow-Service-Sync-PoolLimit.js');

class MeadowSyncEntityOngoing extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'MeadowSyncEntityOngoing';

		if (!this.options.hasOwnProperty('MeadowEntitySchema'))
		{
			throw new Error('MeadowSyncEntityOngoing requires a valid MeadowEntitySchema option.');
		}
		if (typeof(this.options.MeadowEntitySchema) != 'object')
		{
			throw new Error(`MeadowSyncEntityOngoing requires MeadowEntitySchema to be an object; got ${typeof(this.options.MeadowEntitySchema)}.`);
		}
		if (!this.options.MeadowEntitySchema.hasOwnProperty('TableName') ||
			typeof(this.options.MeadowEntitySchema.TableName) != 'string' ||
			this.options.MeadowEntitySchema.TableName.length < 1)
		{
			throw new Error('MeadowSyncEntityOngoing requires a valid MeadowEntitySchema.TableName.');
		}
		if (!this.options.MeadowEntitySchema.hasOwnProperty('Columns') ||
			!Array.isArray(this.options.MeadowEntitySchema.Columns) ||
			this.options.MeadowEntitySchema.Columns.length < 1)
		{
			throw new Error('MeadowSyncEntityOngoing requires a valid MeadowEntitySchema.Columns array.');
		}

		this.EntitySchema = JSON.parse(JSON.stringify(this.options.MeadowEntitySchema));

		if (!this.EntitySchema.hasOwnProperty('MeadowSchema'))
		{
			throw new Error('MeadowSyncEntityOngoing requires MeadowEntitySchema.MeadowSchema; please update stricture and recompile the extended JSON.');
		}

		this.DefaultIdentifier = this.EntitySchema.MeadowSchema.DefaultIdentifier;
		this.PageSize = this.options.PageSize || 100;
		this.SyncDeletedRecords = this.options.SyncDeletedRecords || false;
		this.MaxRecordsPerEntity = this.options.MaxRecordsPerEntity || 0;

		// Optional query string appended to deleted record API requests.
		// Used to work around older APIs where FBV~Deleted~EQ~1 does not
		// override the automatic Deleted=0 filter (e.g. "includeDeleted=true").
		this.SyncDeletedRecordsQueryString = this.options.SyncDeletedRecordsQueryString || '';

		// Minimum range size for bisection -- when a range is this small or smaller,
		// pull all records in the range from the server instead of subdividing further.
		this.BisectMinRangeSize = this.options.BisectMinRangeSize || 1000;

		// Tolerance window in milliseconds for cross-database timestamp precision differences.
		// MySQL DATETIME stores whole seconds, MSSQL DATETIME rounds to ~3.33ms increments,
		// PostgreSQL TIMESTAMP stores microseconds, and SQLite stores as TEXT.  When comparing
		// timestamps across systems, the maximum rounding error is 1000ms (MySQL second-level
		// truncation).  Default 1000ms covers all supported provider combinations.
		this.DateTimePrecisionMS = (typeof(this.options.DateTimePrecisionMS) === 'number')
			? this.options.DateTimePrecisionMS
			: 1000;

		// How many records to reconcile/upsert concurrently within a table.
		// Defaults to the DB connection pool size (capped) so fan-out never
		// oversubscribes the pool (a 2-connection clone must not fan out 5-wide)
		// nor runs unbounded on a very large pool.  Overridable globally or
		// per-table via SyncEntityOptions.SyncRecordConcurrency.
		this.SyncRecordConcurrency = this._resolveSyncRecordConcurrency(this.options.SyncRecordConcurrency);

		this.Meadow = false;

		this.operation = new libMeadowOperation(this.fable);

		this.skipSync = false;
	}

	/**
	 * Resolve the per-record fan-out concurrency for this entity.
	 *
	 * Precedence: an explicit configured value (global or per-table) wins and is
	 * used as-is; otherwise fall back to the automatic default (pool size, capped)
	 * — see resolveDefaultConcurrency in Meadow-Service-Sync-PoolLimit.js.
	 *
	 * @param {number|string} pConfigured - configured concurrency, if any
	 * @returns {number} a positive integer concurrency
	 */
	_resolveSyncRecordConcurrency(pConfigured)
	{
		let tmpConfigured = parseInt(pConfigured, 10);
		if (!isNaN(tmpConfigured) && tmpConfigured > 0)
		{
			return tmpConfigured;
		}

		return libSyncPoolLimit.resolveDefaultConcurrency(this.fable);
	}

	initialize(fCallback)
	{
		if (this.fable.hasOwnProperty('Meadow'))
		{
			this.Meadow = this.fable.Meadow.loadFromPackageObject(this.EntitySchema.MeadowSchema);
		}

		this.log.info(`Sync for ${this.EntitySchema.TableName} creating table if it doesn't exist...`);

		if (this.Meadow && this.Meadow.provider)
		{
			// Init only ensures the table exists.  Index provisioning is handled
			// separately and authoritatively by the index-convergence step
			// (Meadow-Service-IndexConvergence), so indexes have a single writer —
			// the legacy per-column MeadowConnectionManager.createIndex path was
			// retired to avoid two mechanisms fighting over the same indexes.
			return this.Meadow.provider.getProvider().createTable(this.EntitySchema, (pCreateError) =>
			{
				return fCallback(pCreateError);
			});
		}
		return fCallback();
	}

	marshalRecord(pSourceRecord)
	{
		const tmpRecordToCommit = {};

		for (const tmpColumn of this.EntitySchema.Columns)
		{
			if (pSourceRecord.hasOwnProperty(tmpColumn.Column))
			{
				switch (typeof(pSourceRecord[tmpColumn.Column]))
				{
					case 'null':
					case 'undefined':
						break;
					case 'object':
						if (pSourceRecord[tmpColumn.Column])
						{
							tmpRecordToCommit[tmpColumn.Column] = JSON.stringify(pSourceRecord[tmpColumn.Column]);
						}
						break;
					default:
						if (tmpColumn.DataType == 'DateTime')
						{
							if ((typeof(pSourceRecord[tmpColumn.Column]) == 'string') && (pSourceRecord[tmpColumn.Column].length > 0))
							{
								tmpRecordToCommit[tmpColumn.Column] = this.fable.Dates.dayJS.utc(pSourceRecord[tmpColumn.Column]).format('YYYY-MM-DD HH:mm:ss.SSS');
							}
						}
						else if (pSourceRecord[tmpColumn.Column] !== '')
						{
							tmpRecordToCommit[tmpColumn.Column] = pSourceRecord[tmpColumn.Column];
						}
						break;
				}
			}
			else if (tmpColumn.Column.endsWith('JSON') && typeof pSourceRecord[tmpColumn.Column.substring(0, tmpColumn.Column.length - 4)] === 'object')
			{
				tmpRecordToCommit[tmpColumn.Column] = JSON.stringify(pSourceRecord[tmpColumn.Column.substring(0, tmpColumn.Column.length - 4)]);
			}
		}

		return tmpRecordToCommit;
	}

	// ---- REST / Local query helpers ----

	// Normalize a date value to a UTC dayJS instance.
	//
	// Local dates stored in SQLite are in UTC but formatted without a timezone
	// indicator (e.g. "2022-05-10 22:50:26.000").  When the driver or ORM wraps
	// them in a JavaScript Date object, JS interprets them as local time, shifting
	// the value by the machine's UTC offset.  To recover the original naive UTC
	// time, we format through local time (which undoes the offset) then re-parse
	// as UTC.  Server dates already carry a "Z" suffix and are parsed correctly.
	_normalizeDateUTC(pDate)
	{
		if (typeof(pDate) === 'string')
		{
			// String dates — strip any trailing Z or timezone so dayJS.utc() treats as UTC
			return this.fable.Dates.dayJS.utc(pDate);
		}
		// Date objects (from SQLite via ORM) — format as local time string to recover
		// the naive stored value, then re-parse as UTC
		let tmpNaiveStr = this.fable.Dates.dayJS(pDate).format('YYYY-MM-DD HH:mm:ss.SSS');
		return this.fable.Dates.dayJS.utc(tmpNaiveStr);
	}

	// Format a date value for use in Meadow REST filter expressions (FBV).
	_formatDateForFilter(pDate)
	{
		return this._normalizeDateUTC(pDate).format('YYYY-MM-DDTHH:mm:ss.SSS');
	}

	// Get a count from the remote server, optionally filtered.
	_getServerCount(pFilter, fCallback)
	{
		const tmpURL = pFilter
			? `${this.EntitySchema.TableName}s/Count/FilteredTo/${pFilter}`
			: `${this.EntitySchema.TableName}s/Count`;
		this.fable.MeadowCloneRestClient.getJSON(tmpURL,
			(pError, pResponse, pBody) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				if (pBody && pBody.hasOwnProperty('Count'))
				{
					return fCallback(null, pBody.Count);
				}
				return fCallback(null, 0);
			});
	}

	// Get a page of records from the remote server with a Meadow filter expression.
	_getServerRecords(pFilter, pOffset, pPageSize, fCallback)
	{
		const tmpURL = `${this.EntitySchema.TableName}s/FilteredTo/${pFilter}/${pOffset}/${pPageSize}`;
		this.fable.MeadowCloneRestClient.getJSON(tmpURL,
			(pError, pResponse, pBody) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				if (pBody && Array.isArray(pBody))
				{
					return fCallback(null, pBody);
				}
				return fCallback(null, []);
			});
	}

	// Get a count from the local database with optional ID range filters.
	_getLocalCount(pMinID, pMaxID, fCallback)
	{
		const tmpQuery = this.Meadow.query;
		if (pMinID > 0)
		{
			tmpQuery.addFilter(this.DefaultIdentifier, pMinID, '>=');
		}
		if (pMaxID > 0)
		{
			tmpQuery.addFilter(this.DefaultIdentifier, pMaxID, '<=');
		}
		if (!this._hasDeletedColumn)
		{
			tmpQuery.setDisableDeleteTracking(true);
		}
		this.Meadow.doCount(tmpQuery,
			(pError, pQuery, pCount) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				return fCallback(null, pCount);
			});
	}

	// Get the max UpdateDate from local records in an ID range.
	_getLocalMaxUpdateDate(pMinID, pMaxID, fCallback)
	{
		const tmpQuery = this.Meadow.query;
		if (pMinID > 0)
		{
			tmpQuery.addFilter(this.DefaultIdentifier, pMinID, '>=');
		}
		if (pMaxID > 0)
		{
			tmpQuery.addFilter(this.DefaultIdentifier, pMaxID, '<=');
		}
		tmpQuery.setSort({ Column: 'UpdateDate', Direction: 'Descending' });
		tmpQuery.setCap(1);
		if (!this._hasDeletedColumn)
		{
			tmpQuery.setDisableDeleteTracking(true);
		}
		this.Meadow.doRead(tmpQuery,
			(pError, pQuery, pRecord) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				if (!pRecord || !pRecord.UpdateDate)
				{
					return fCallback(null, false);
				}
				return fCallback(null, pRecord.UpdateDate);
			});
	}

	// Get the min UpdateDate from local records in an ID range.
	_getLocalMinUpdateDate(pMinID, pMaxID, fCallback)
	{
		const tmpQuery = this.Meadow.query;
		if (pMinID > 0)
		{
			tmpQuery.addFilter(this.DefaultIdentifier, pMinID, '>=');
		}
		if (pMaxID > 0)
		{
			tmpQuery.addFilter(this.DefaultIdentifier, pMaxID, '<=');
		}
		tmpQuery.setSort({ Column: 'UpdateDate', Direction: 'Ascending' });
		tmpQuery.setCap(1);
		if (!this._hasDeletedColumn)
		{
			tmpQuery.setDisableDeleteTracking(true);
		}
		this.Meadow.doRead(tmpQuery,
			(pError, pQuery, pRecord) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				if (!pRecord || !pRecord.UpdateDate)
				{
					return fCallback(null, false);
				}
				return fCallback(null, pRecord.UpdateDate);
			});
	}

	// Upsert a single record from the server into the local database.
	_upsertRecord(pServerRecord, fCallback)
	{
		const tmpRecordToCommit = this.marshalRecord(pServerRecord);

		const tmpQuery = this.Meadow.query;
		tmpQuery.addFilter(this.DefaultIdentifier, pServerRecord[this.DefaultIdentifier]);
		if (!this._hasDeletedColumn)
		{
			tmpQuery.setDisableDeleteTracking(true);
		}

		this.Meadow.doRead(tmpQuery,
			(pReadError, pQuery, pLocalRecord) =>
			{
				if (pReadError)
				{
					this.fable.log.error(`Error reading local record ${this.EntitySchema.TableName} ID ${pServerRecord[this.DefaultIdentifier]}: ${pReadError}`);
					return fCallback();
				}

				const tmpSyncQuery = this.Meadow.query.addRecord(tmpRecordToCommit);
				tmpSyncQuery.setDisableAutoIdentity(true);
				tmpSyncQuery.setDisableAutoDateStamp(true);
				tmpSyncQuery.setDisableAutoUserStamp(true);
				tmpSyncQuery.setDisableDeleteTracking(true);

				if (!pLocalRecord)
				{
					// Record does not exist locally -- create
					tmpSyncQuery.AllowIdentityInsert = true;
					this.Meadow.doCreate(tmpSyncQuery,
						(pCreateError) =>
						{
							if (pCreateError)
							{
								let tmpErrorStr = (typeof(pCreateError) === 'string') ? pCreateError : JSON.stringify(pCreateError);
								if (tmpErrorStr.toLowerCase().indexOf('duplicate') > -1 || tmpErrorStr.toLowerCase().indexOf('unique') > -1)
								{
									// GUID conflict -- fall back to update
									this.log.warn(`Duplicate key on create for ${this.EntitySchema.TableName} ID ${pServerRecord[this.DefaultIdentifier]}; falling back to update.`);
									const tmpFallbackQuery = this.Meadow.query.addRecord(tmpRecordToCommit);
									tmpFallbackQuery.setDisableAutoIdentity(true);
									tmpFallbackQuery.setDisableAutoDateStamp(true);
									tmpFallbackQuery.setDisableAutoUserStamp(true);
									tmpFallbackQuery.setDisableDeleteTracking(true);
									this.Meadow.doUpdate(tmpFallbackQuery,
										(pUpdateError) =>
										{
											if (pUpdateError)
											{
												this.log.error(`Fallback update also failed for ${this.EntitySchema.TableName} ID ${pServerRecord[this.DefaultIdentifier]}: ${pUpdateError}`);
											}
											else
											{
												this._recordsUpdated++;
											}
											return fCallback();
										});
									return;
								}
								this.log.error(`Error creating record ${this.EntitySchema.TableName}: ${pCreateError}`, pCreateError);
								return fCallback();
							}
							else
							{
								this._recordsCreated++;
							}
							return fCallback();
						});
				}
				else
				{
					// Record exists locally -- update
					this.Meadow.doUpdate(tmpSyncQuery,
						(pUpdateError) =>
						{
							if (pUpdateError)
							{
								this.log.error(`Error updating record ${this.EntitySchema.TableName}: ${pUpdateError}`, pUpdateError);
							}
							else
							{
								this._recordsUpdated++;
							}
							return fCallback();
						});
				}
			});
	}

	// Pull all records from server matching a filter expression and upsert them locally.
	// Fetches in pages of this.PageSize.
	_pullServerRecords(pFilter, pEstimatedCount, fCallback)
	{
		if (pEstimatedCount < 1)
		{
			return fCallback(null, 0);
		}

		// Check the global cap before starting -- if we have already synced
		// MaxRecordsPerEntity records across all stages, stop immediately.
		if (this.MaxRecordsPerEntity > 0 && this._totalSyncedThisSync >= this.MaxRecordsPerEntity)
		{
			this.fable.log.info(`${this.EntitySchema.TableName}: global record cap reached (${this._totalSyncedThisSync}/${this.MaxRecordsPerEntity}); skipping pull.`);
			return fCallback(null, 0);
		}

		let tmpSyncedCount = 0;
		let tmpOffset = 0;
		let tmpDone = false;

		// Apply per-call cap based on estimated count, then further limit by
		// how many records remain before hitting the global MaxRecordsPerEntity.
		let tmpRecordCap = (this.MaxRecordsPerEntity > 0)
			? Math.min(pEstimatedCount, this.MaxRecordsPerEntity - this._totalSyncedThisSync)
			: pEstimatedCount;

		const fFetchPage = () =>
		{
			if (tmpDone || tmpOffset >= tmpRecordCap)
			{
				return fCallback(null, tmpSyncedCount);
			}

			this._getServerRecords(pFilter, tmpOffset, this.PageSize,
				(pError, pRecords) =>
				{
					if (pError)
					{
						this.fable.log.error(`Error fetching ${this.EntitySchema.TableName} page at offset ${tmpOffset}: ${pError}`);
						return fCallback(pError, tmpSyncedCount);
					}
					if (!pRecords || pRecords.length < 1)
					{
						tmpDone = true;
						return fCallback(null, tmpSyncedCount);
					}

					this.fable.Utility.eachLimit(pRecords, this.SyncRecordConcurrency,
						(pRecord, fRecordDone) =>
						{
							this._upsertRecord(pRecord,
								() =>
								{
									tmpSyncedCount++;
									this._totalSyncedThisSync++;
									// Use setImmediate to yield the event loop and prevent
									// stack overflow when SQLite callbacks complete synchronously
									return setImmediate(fRecordDone);
								});
						},
						(pUpsertError) =>
						{
							// Increment per-page progress so the UI reflects sync in real-time
							this._incrementProgress(pRecords.length);
							tmpOffset += this.PageSize;
							if (pRecords.length < this.PageSize)
							{
								tmpDone = true;
								return fCallback(null, tmpSyncedCount);
							}
							this.fable.log.info(`${this.EntitySchema.TableName}: pulled ${tmpSyncedCount} of ~${tmpRecordCap} records...`);
							// Use setImmediate to break the recursive call chain across pages
							return setImmediate(fFetchPage);
						});
				});
		};

		fFetchPage();
	}

	// Increment the FullSync progress tracker by pCount records checked/synced.
	_incrementProgress(pCount)
	{
		let tmpTracker = this.operation.progressTrackers[`FullSync-${this.EntitySchema.TableName}`];
		if (tmpTracker && pCount > 0)
		{
			tmpTracker.CurrentCount = Math.min(tmpTracker.CurrentCount + pCount, tmpTracker.TotalCount);
		}
	}

	// ---- Bisection logic ----

	// Compare a local ID range against the server.  If counts or date boundaries
	// differ, subdivide until the range is small enough, then pull all records in
	// the range from the server to bring local in sync.
	_bisectRange(pMinID, pMaxID, pDepth, fCallback)
	{
		// If the global record cap has been reached, stop bisecting
		if (this.MaxRecordsPerEntity > 0 && this._totalSyncedThisSync >= this.MaxRecordsPerEntity)
		{
			return fCallback();
		}

		const tmpRangeSize = pMaxID - pMinID + 1;
		const tmpIDCol = this.DefaultIdentifier;
		const tmpRangeFilter = `FBV~${tmpIDCol}~GE~${pMinID}~FBV~${tmpIDCol}~LE~${pMaxID}`;

		// Get local stats for this range
		this._getLocalCount(pMinID, pMaxID,
			(pLocalCountError, pLocalCount) =>
			{
				if (pLocalCountError)
				{
					this.fable.log.warn(`${this.EntitySchema.TableName}: bisect local count error for range ${pMinID}-${pMaxID}: ${pLocalCountError}`);
					return fCallback();
				}

				// Get server count for this range
				this._getServerCount(tmpRangeFilter,
					(pServerCountError, pServerCount) =>
					{
						if (pServerCountError)
						{
							this.fable.log.warn(`${this.EntitySchema.TableName}: bisect server count error for range ${pMinID}-${pMaxID}: ${pServerCountError}`);
							return fCallback();
						}

						// If counts match, check UpdateDate boundaries for this range
						if (pLocalCount === pServerCount)
						{
							if (!this._hasUpdateDate)
							{
								// No UpdateDate column -- counts match, assume in sync
								this._incrementProgress(pServerCount);
								return fCallback();
							}

							// Compare max and min UpdateDate for this range
							this._getLocalMaxUpdateDate(pMinID, pMaxID,
								(pLocalMaxErr, pLocalMaxDate) =>
								{
									if (pLocalMaxErr || !pLocalMaxDate)
									{
										return fCallback();
									}

									// Get server max UpdateDate for this range (1 record, sorted desc)
									const tmpMaxDateFilter = `${tmpRangeFilter}~FSF~UpdateDate~DESC~DESC`;
									this._getServerRecords(tmpMaxDateFilter, 0, 1,
										(pServerMaxErr, pServerMaxRecords) =>
										{
											if (pServerMaxErr || !pServerMaxRecords || pServerMaxRecords.length < 1)
											{
												return fCallback();
											}

											const tmpServerMaxDate = pServerMaxRecords[0].UpdateDate;
											const tmpMaxDateDiff = Math.abs(this._normalizeDateUTC(pLocalMaxDate).diff(this._normalizeDateUTC(tmpServerMaxDate)));

											if (tmpMaxDateDiff <= this.DateTimePrecisionMS)
											{
												// Max dates match and counts match -- this range is in sync
												this._incrementProgress(pServerCount);
												return fCallback();
											}

											// Dates differ even though counts match -- records have been modified.
											// If range is small enough, pull all records; otherwise subdivide.
											this.fable.log.info(`${this.EntitySchema.TableName}: date mismatch in range ${pMinID}-${pMaxID} (local max: ${pLocalMaxDate}, server max: ${tmpServerMaxDate})`);
											if (tmpRangeSize <= this.BisectMinRangeSize)
											{
												return this._pullRangeFromServer(pMinID, pMaxID, fCallback);
											}
											return this._subdivideRange(pMinID, pMaxID, pDepth, fCallback);
										});
								});
							return;
						}

						// Counts differ
						this.fable.log.info(`${this.EntitySchema.TableName}: count mismatch in range ${pMinID}-${pMaxID} (local: ${pLocalCount}, server: ${pServerCount})`);

						if (tmpRangeSize <= this.BisectMinRangeSize)
						{
							return this._pullRangeFromServer(pMinID, pMaxID, fCallback);
						}

						return this._subdivideRange(pMinID, pMaxID, pDepth, fCallback);
					});
			});
	}

	// Split an ID range in half and bisect each half.
	_subdivideRange(pMinID, pMaxID, pDepth, fCallback)
	{
		const tmpMidID = Math.floor((pMinID + pMaxID) / 2);

		this.fable.log.info(`${this.EntitySchema.TableName}: subdividing range ${pMinID}-${pMaxID} at ID ${tmpMidID} (depth ${pDepth})`);

		// Bisect lower half, then upper half
		this._bisectRange(pMinID, tmpMidID, pDepth + 1,
			() =>
			{
				this._bisectRange(tmpMidID + 1, pMaxID, pDepth + 1, fCallback);
			});
	}

	// Pull all records from the server in an ID range and upsert them locally.
	_pullRangeFromServer(pMinID, pMaxID, fCallback)
	{
		const tmpIDCol = this.DefaultIdentifier;
		const tmpFilter = `FBV~${tmpIDCol}~GE~${pMinID}~FBV~${tmpIDCol}~LE~${pMaxID}~FSF~${tmpIDCol}~ASC~ASC`;
		const tmpEstimatedCount = pMaxID - pMinID + 1;

		this.fable.log.info(`${this.EntitySchema.TableName}: pulling range ${pMinID}-${pMaxID} from server (~${tmpEstimatedCount} records)`);

		this._pullServerRecords(tmpFilter, tmpEstimatedCount,
			(pError, pSyncedCount) =>
			{
				if (pError)
				{
					this.fable.log.warn(`${this.EntitySchema.TableName}: error pulling range ${pMinID}-${pMaxID}: ${pError}`);
				}
				else
				{
					this.fable.log.info(`${this.EntitySchema.TableName}: synced ${pSyncedCount} records in range ${pMinID}-${pMaxID}`);
				}
				// Per-page progress is now tracked inside _pullServerRecords()
				return fCallback();
			});
	}

	// ---- Deleted records sync ----

	_appendDeletedQueryString(pURL)
	{
		if (!this.SyncDeletedRecordsQueryString) return pURL;
		return pURL + (pURL.indexOf('?') > -1 ? '&' : '?') + this.SyncDeletedRecordsQueryString;
	}

	syncDeletedRecords(fCallback)
	{
		const tmpDeletedColumn = this.EntitySchema.Columns.find((c) => c.Column == 'Deleted');
		if (!tmpDeletedColumn)
		{
			this.fable.log.info(`No Deleted column for ${this.EntitySchema.TableName}; skipping delete sync.`);
			return fCallback();
		}

		this.fable.log.info(`Checking for deleted records on server for ${this.EntitySchema.TableName}...`);

		// The explicit FBV~Deleted~EQ~1 filter overrides foxhound's automatic Deleted=0 filter.
		// On older APIs where this doesn't work, SyncDeletedRecordsQueryString provides a
		// fallback (e.g. "includeDeleted=true") that disables server-side delete tracking.
		this.fable.MeadowCloneRestClient.getJSON(this._appendDeletedQueryString(`${this.EntitySchema.TableName}s/Count/FilteredTo/FBV~Deleted~EQ~1`),
			(pError, pResponse, pBody) =>
			{
				if (pError || !pBody || !pBody.hasOwnProperty('Count'))
				{
					this.fable.log.warn(`Could not get deleted record count for ${this.EntitySchema.TableName}; skipping delete sync.`);
					return fCallback();
				}

				const tmpDeletedCount = pBody.Count;
				if (tmpDeletedCount < 1)
				{
					this.fable.log.info(`No deleted records on server for ${this.EntitySchema.TableName}.`);
					return fCallback();
				}

				this.fable.log.info(`Found ${tmpDeletedCount} deleted records on server for ${this.EntitySchema.TableName}; syncing deletions...`);

				let tmpDeleteCap = (this.MaxRecordsPerEntity > 0)
					? Math.min(tmpDeletedCount, this.MaxRecordsPerEntity)
					: tmpDeletedCount;

				let tmpOffset = 0;
				let tmpProcessed = 0;

				// Fetch deleted record pages one at a time rather than
				// pre-generating all URL partials.  With millions of deleted
				// records this avoids allocating hundreds of thousands of
				// URL strings and prevents stack overflow in the iterator.
				const fFetchDeletedPage = () =>
				{
					if (tmpOffset >= tmpDeleteCap)
					{
						this.fable.log.info(`Delete sync complete for ${this.EntitySchema.TableName} (${tmpProcessed} of ${tmpDeletedCount} deleted records processed).`);
						return fCallback();
					}

					const tmpURL = this._appendDeletedQueryString(`${this.EntitySchema.TableName}s/FilteredTo/FBV~Deleted~EQ~1~FSF~${this.DefaultIdentifier}~ASC~ASC/${tmpOffset}/${this.PageSize}`);
					tmpOffset += this.PageSize;

					this.fable.MeadowCloneRestClient.getJSON(tmpURL,
						(pDownloadError, pResponse, pBody) =>
						{
							if (pDownloadError || !pBody || !Array.isArray(pBody) || pBody.length < 1)
							{
								this.fable.log.info(`Delete sync complete for ${this.EntitySchema.TableName} (${tmpProcessed} of ${tmpDeletedCount} deleted records processed).`);
								return fCallback();
							}

							this.fable.Utility.eachLimit(pBody, this.SyncRecordConcurrency,
								(pEntityRecord, fRecordComplete) =>
								{
									const tmpRecordID = pEntityRecord[this.DefaultIdentifier];
									if (!tmpRecordID || tmpRecordID < 1)
									{
										return setImmediate(fRecordComplete);
									}

									// Read local record with delete tracking disabled so we can see all records
									const tmpQuery = this.Meadow.query;
									tmpQuery.addFilter(this.DefaultIdentifier, tmpRecordID);
									tmpQuery.setDisableDeleteTracking(true);

									this.Meadow.doRead(tmpQuery,
										(pReadError, pQuery, pRecord) =>
										{
											if (pReadError || !pRecord)
											{
												// Record doesn't exist locally -- create it as deleted
												const tmpRecordToCommit = this.marshalRecord(pEntityRecord);

												const tmpCreateQuery = this.Meadow.query.addRecord(tmpRecordToCommit);
												tmpCreateQuery.setDisableAutoIdentity(true);
												tmpCreateQuery.setDisableAutoDateStamp(true);
												tmpCreateQuery.setDisableAutoUserStamp(true);
												tmpCreateQuery.setDisableDeleteTracking(true);
												tmpCreateQuery.AllowIdentityInsert = true;

												this.Meadow.doCreate(tmpCreateQuery,
													(pCreateError) =>
													{
														if (pCreateError)
														{
															this.log.error(`Error creating deleted record ${this.EntitySchema.TableName} ID ${tmpRecordID}: ${pCreateError}`);
														}
														tmpProcessed++;
														return setImmediate(fRecordComplete);
													});
												return;
											}

											if (pRecord.Deleted == 1)
											{
												// Already marked deleted locally
												tmpProcessed++;
												return setImmediate(fRecordComplete);
											}

											// Record exists locally but is not deleted -- update it
											const tmpRecordToCommit = this.marshalRecord(pEntityRecord);

											const tmpUpdateQuery = this.Meadow.query.addRecord(tmpRecordToCommit);
											tmpUpdateQuery.setDisableAutoIdentity(true);
											tmpUpdateQuery.setDisableAutoDateStamp(true);
											tmpUpdateQuery.setDisableAutoUserStamp(true);
											tmpUpdateQuery.setDisableDeleteTracking(true);

											this.Meadow.doUpdate(tmpUpdateQuery,
												(pUpdateError) =>
												{
													if (pUpdateError)
													{
														this.log.error(`Error marking record as deleted ${this.EntitySchema.TableName} ID ${tmpRecordID}: ${pUpdateError}`);
													}
													tmpProcessed++;
													return setImmediate(fRecordComplete);
												});
										});
								},
								(pRecordSyncError) =>
								{
									return setImmediate(fFetchDeletedPage);
								});
						});
				};

				fFetchDeletedPage();
			});
	}

	// ---- Main sync entry point ----

	sync(fCallback)
	{
		if (this.skipSync)
		{
			this.log.warn(`Skipping sync for ${this.EntitySchema.TableName} -- local table schema does not match expected schema.`);
			return fCallback();
		}

		// Validate local table schema with a lightweight read before syncing
		const tmpValidationQuery = this.Meadow.query;
		tmpValidationQuery.setSort({ Column: this.DefaultIdentifier, Direction: 'Descending' });
		tmpValidationQuery.setCap(1);
		tmpValidationQuery.setDisableDeleteTracking(true);
		this.Meadow.doRead(tmpValidationQuery,
			(pReadError) =>
			{
				if (pReadError)
				{
					let tmpErrorStr = (typeof(pReadError) === 'string') ? pReadError : String(pReadError);
					if (tmpErrorStr.indexOf('Invalid column') > -1 || tmpErrorStr.indexOf('Invalid object') > -1 || tmpErrorStr.indexOf('no such column') > -1 || tmpErrorStr.indexOf('no such table') > -1)
					{
						this.log.warn(`${this.EntitySchema.TableName}: local table schema mismatch (${pReadError}); skipping sync.`);
						return fCallback();
					}
				}
				return this._syncInternal(fCallback);
			});
	}

	_syncInternal(fCallback)
	{
		this.operation.createTimeStamp('EntityOngoingSync');

		// Track total records synced across all stages to enforce MaxRecordsPerEntity globally
		this._totalSyncedThisSync = 0;

		// Track per-record create vs update counts for the sync report
		this._recordsCreated = 0;
		this._recordsUpdated = 0;

		const tmpSyncState = (
			{
				Local: { MaxIDEntity: -1, RecordCount: 0 },
				Server: { MaxIDEntity: -1, RecordCount: 0 },
			});

		// Detect schema capabilities
		this._hasUpdateDate = false;
		this._hasDeletedColumn = false;

		if (this.EntitySchema && this.EntitySchema.MeadowSchema && Array.isArray(this.EntitySchema.MeadowSchema.Schema))
		{
			for (let i = 0; i < this.EntitySchema.MeadowSchema.Schema.length; i++)
			{
				const tmpColumn = this.EntitySchema.MeadowSchema.Schema[i];
				if (tmpColumn.Column == 'UpdateDate')
				{
					this._hasUpdateDate = true;
				}
				if (tmpColumn.Type == 'Deleted' || tmpColumn.Column == 'Deleted')
				{
					this._hasDeletedColumn = true;
				}
			}
		}

		this.fable.log.info(`Syncing with ONGOING STRATEGY entity ${this.EntitySchema.TableName} (UpdateDate: ${this._hasUpdateDate}, Deleted: ${this._hasDeletedColumn})...`);

		this.fable.Utility.waterfall(
			[
				// ---- Stage 1: Gather local stats ----
				(fStageComplete) =>
				{
					// Local max ID
					const tmpQuery = this.Meadow.query;
					tmpQuery.setSort({ Column: this.DefaultIdentifier, Direction: 'Descending' });
					tmpQuery.setCap(1);
					if (!this._hasDeletedColumn)
					{
						tmpQuery.setDisableDeleteTracking(true);
					}
					this.Meadow.doRead(tmpQuery,
						(pReadError, pQuery, pRecord) =>
						{
							if (pReadError)
							{
								this.fable.log.error(`Error reading local max entity ID ${this.EntitySchema.TableName}: ${pReadError}`);
								return fStageComplete(`Error reading local max entity ID ${this.EntitySchema.TableName}: ${pReadError}`);
							}
							if (pRecord)
							{
								tmpSyncState.Local.MaxIDEntity = pRecord[this.DefaultIdentifier];
								this.fable.log.info(`Found local max entity ID ${this.EntitySchema.TableName}: ${tmpSyncState.Local.MaxIDEntity}`);
							}
							else
							{
								this.fable.log.info(`No local records for ${this.EntitySchema.TableName}.`);
							}
							return fStageComplete();
						});
				},
				(fStageComplete) =>
				{
					// Local max UpdateDate
					if (!this._hasUpdateDate)
					{
						return fStageComplete();
					}
					const tmpQuery = this.Meadow.query;
					tmpQuery.setSort({ Column: 'UpdateDate', Direction: 'Descending' });
					tmpQuery.setCap(1);
					if (!this._hasDeletedColumn)
					{
						tmpQuery.setDisableDeleteTracking(true);
					}
					this.Meadow.doRead(tmpQuery,
						(pReadError, pQuery, pRecord) =>
						{
							if (pReadError)
							{
								this.fable.log.error(`Error reading local max UpdateDate ${this.EntitySchema.TableName}: ${pReadError}`);
								return fStageComplete(`Error reading local max UpdateDate ${this.EntitySchema.TableName}: ${pReadError}`);
							}
							if (pRecord && pRecord.UpdateDate)
							{
								tmpSyncState.Local.MaxUpdateDate = pRecord.UpdateDate;
								this.fable.log.info(`Found local max UpdateDate ${this.EntitySchema.TableName}: ${tmpSyncState.Local.MaxUpdateDate}`);
							}
							return fStageComplete();
						});
				},
				(fStageComplete) =>
				{
					// Local count
					const tmpQuery = this.Meadow.query;
					if (!this._hasDeletedColumn)
					{
						tmpQuery.setDisableDeleteTracking(true);
					}
					this.Meadow.doCount(tmpQuery,
						(pCountError, pQuery, pCount) =>
						{
							if (pCountError)
							{
								this.fable.log.error(`Error getting local count of ${this.EntitySchema.TableName}: ${pCountError}`);
								return fStageComplete(`Error getting local count of ${this.EntitySchema.TableName}: ${pCountError}`);
							}
							tmpSyncState.Local.RecordCount = pCount;
							this.fable.log.info(`Local count ${this.EntitySchema.TableName}: ${tmpSyncState.Local.RecordCount}`);
							return fStageComplete();
						});
				},

				// ---- Stage 2: Gather server stats ----
				(fStageComplete) =>
				{
					// Server max ID
					this.fable.MeadowCloneRestClient.getJSON(`${this.EntitySchema.TableName}/Max/${this.DefaultIdentifier}`,
						(pError, pResponse, pBody) =>
						{
							if (pError)
							{
								this.fable.log.warn(`Could not get server max entity ID for ${this.EntitySchema.TableName} (${pError}); continuing sync.`);
								return fStageComplete();
							}
							if (pBody && pBody.hasOwnProperty(this.DefaultIdentifier))
							{
								tmpSyncState.Server.MaxIDEntity = pBody[this.DefaultIdentifier];
								this.fable.log.info(`Found server max entity ID ${this.EntitySchema.TableName}: ${tmpSyncState.Server.MaxIDEntity}`);
							}
							else
							{
								this.fable.log.warn(`No records found in server for max entity ID of ${this.EntitySchema.TableName}.`);
							}
							return fStageComplete();
						});
				},
				(fStageComplete) =>
				{
					// Server count
					this._getServerCount(null,
						(pError, pCount) =>
						{
							if (pError)
							{
								this.fable.log.warn(`Could not get server count for ${this.EntitySchema.TableName} (${pError}); estimating from max ID.`);
								tmpSyncState.Server.RecordCount = tmpSyncState.Server.MaxIDEntity > 0 ? tmpSyncState.Server.MaxIDEntity : 0;
								return fStageComplete();
							}
							tmpSyncState.Server.RecordCount = pCount;
							this.fable.log.info(`Server count ${this.EntitySchema.TableName}: ${tmpSyncState.Server.RecordCount}`);
							return fStageComplete();
						});
				},

					// Create a progress tracker so callers (e.g. data-cloner UI) can see Total/Synced
				(fStageComplete) =>
				{
					let tmpTrackerTotal = (this.MaxRecordsPerEntity > 0)
					? Math.min(tmpSyncState.Server.RecordCount, this.MaxRecordsPerEntity)
					: tmpSyncState.Server.RecordCount;
				this.operation.createProgressTracker(tmpTrackerTotal, `FullSync-${this.EntitySchema.TableName}`);
					return fStageComplete();
				},

				// ---- Stage 3: UpdateDate-based fast sync ----
				// If we have UpdateDate, compare server record count up to our local
				// max UpdateDate.  If it matches local count, existing records are in
				// sync and we only need to pull records newer than that date.
				(fStageComplete) =>
				{
					if (!this._hasUpdateDate || !tmpSyncState.Local.MaxUpdateDate)
					{
						this.fable.log.info(`${this.EntitySchema.TableName}: no UpdateDate available; skipping UpdateDate fast-sync.`);
						tmpSyncState.UpdateDateSyncDone = false;
						return fStageComplete();
					}

					const tmpDateStr = this._formatDateForFilter(tmpSyncState.Local.MaxUpdateDate);
					const tmpIDCol = this.DefaultIdentifier;
					const tmpBeforeFilter = `FBV~UpdateDate~LE~${tmpDateStr}`;

					this.fable.log.info(`${this.EntitySchema.TableName}: checking server count with UpdateDate <= ${tmpDateStr}...`);

					this._getServerCount(tmpBeforeFilter,
						(pError, pServerCountBefore) =>
						{
							if (pError)
							{
								this.fable.log.warn(`${this.EntitySchema.TableName}: could not get server count before UpdateDate (${pError}); falling back to bisection.`);
								tmpSyncState.UpdateDateSyncDone = false;
								return fStageComplete();
							}

							this.fable.log.info(`${this.EntitySchema.TableName}: server has ${pServerCountBefore} records with UpdateDate <= ${tmpDateStr} (local has ${tmpSyncState.Local.RecordCount})`);

							if (pServerCountBefore === tmpSyncState.Local.RecordCount)
							{
								// Record counts match up to our max UpdateDate -- existing records are in sync.
								this.fable.log.info(`${this.EntitySchema.TableName}: counts match up to local max UpdateDate; existing records appear in sync.`);
								tmpSyncState.ExistingRecordsInSync = true;
								this._incrementProgress(pServerCountBefore);
							}
							else
							{
								this.fable.log.info(`${this.EntitySchema.TableName}: count mismatch before max UpdateDate (local: ${tmpSyncState.Local.RecordCount}, server: ${pServerCountBefore}); will bisect existing records.`);
								tmpSyncState.ExistingRecordsInSync = false;
							}

							// Now pull records with UpdateDate > local max UpdateDate (new + modified on server)
							const tmpAfterFilter = `FBV~UpdateDate~GT~${tmpDateStr}~FSF~${tmpIDCol}~ASC~ASC`;

							this._getServerCount(`FBV~UpdateDate~GT~${tmpDateStr}`,
								(pAfterError, pServerCountAfter) =>
								{
									if (pAfterError)
									{
										this.fable.log.warn(`${this.EntitySchema.TableName}: could not get server count after UpdateDate (${pAfterError}).`);
										tmpSyncState.UpdateDateSyncDone = false;
										return fStageComplete();
									}

									this.fable.log.info(`${this.EntitySchema.TableName}: ${pServerCountAfter} records on server with UpdateDate > ${tmpDateStr}; pulling...`);

									if (pServerCountAfter < 1)
									{
										tmpSyncState.UpdateDateSyncDone = true;
										// No new records -- nothing additional to count
										return fStageComplete();
									}

									this._pullServerRecords(tmpAfterFilter, pServerCountAfter,
										(pPullError, pSyncedCount) =>
										{
											if (pPullError)
											{
												this.fable.log.warn(`${this.EntitySchema.TableName}: error pulling new records: ${pPullError}`);
											}
											else
											{
												this.fable.log.info(`${this.EntitySchema.TableName}: pulled ${pSyncedCount} new/modified records via UpdateDate.`);
											}
											// Per-page progress is now tracked inside _pullServerRecords()
											tmpSyncState.UpdateDateSyncDone = true;
											return fStageComplete();
										});
								});
						});
				},

				// ---- Stage 4: Bisect existing records if counts did not match ----
				(fStageComplete) =>
				{
					// If UpdateDate sync found existing records in sync, or if we have
					// no local data yet, skip bisection.
					if (tmpSyncState.ExistingRecordsInSync)
					{
						this.fable.log.info(`${this.EntitySchema.TableName}: existing records in sync; skipping bisection.`);
						return fStageComplete();
					}

					// If we have no local records, there is nothing to bisect
					if (tmpSyncState.Local.MaxIDEntity < 1)
					{
						this.fable.log.info(`${this.EntitySchema.TableName}: no local records; skipping bisection.`);
						return fStageComplete();
					}

					// If the UpdateDate fast-sync already ran and pulled new records,
					// refresh local count to see if we are now in sync
					if (tmpSyncState.UpdateDateSyncDone)
					{
						return this._getLocalCount(0, 0,
							(pError, pNewLocalCount) =>
							{
								if (pError || pNewLocalCount === tmpSyncState.Server.RecordCount)
								{
									this.fable.log.info(`${this.EntitySchema.TableName}: counts now match after UpdateDate pull (${pNewLocalCount} local, ${tmpSyncState.Server.RecordCount} server); skipping bisection.`);
									return fStageComplete();
								}

								this.fable.log.info(`${this.EntitySchema.TableName}: counts still differ after UpdateDate pull (${pNewLocalCount} local, ${tmpSyncState.Server.RecordCount} server); bisecting existing records...`);
								return this._bisectRange(1, tmpSyncState.Local.MaxIDEntity, 0, fStageComplete);
							});
					}

					// No UpdateDate available -- bisect the full ID range
					this.fable.log.info(`${this.EntitySchema.TableName}: bisecting full ID range 1-${tmpSyncState.Local.MaxIDEntity}...`);
					return this._bisectRange(1, tmpSyncState.Local.MaxIDEntity, 0, fStageComplete);
				},

				// ---- Stage 5: Pull any remaining new records by ID ----
				// If no UpdateDate sync ran (table lacks UpdateDate), pull records
				// with ID > local max ID.
				(fStageComplete) =>
				{
					if (tmpSyncState.UpdateDateSyncDone)
					{
						// UpdateDate sync already handled new records
						return fStageComplete();
					}

					if (tmpSyncState.Server.MaxIDEntity <= tmpSyncState.Local.MaxIDEntity)
					{
						this.fable.log.info(`${this.EntitySchema.TableName}: no new records by ID (server max ${tmpSyncState.Server.MaxIDEntity} <= local max ${tmpSyncState.Local.MaxIDEntity}).`);
						return fStageComplete();
					}

					const tmpIDCol = this.DefaultIdentifier;
					const tmpFilter = `FBV~${tmpIDCol}~GT~${tmpSyncState.Local.MaxIDEntity}~FSF~${tmpIDCol}~ASC~ASC`;
					const tmpEstimated = tmpSyncState.Server.MaxIDEntity - tmpSyncState.Local.MaxIDEntity;

					this.fable.log.info(`${this.EntitySchema.TableName}: pulling new records with ID > ${tmpSyncState.Local.MaxIDEntity} (~${tmpEstimated} estimated)...`);

					this._pullServerRecords(tmpFilter, tmpEstimated,
						(pError, pSyncedCount) =>
						{
							if (pError)
							{
								this.fable.log.warn(`${this.EntitySchema.TableName}: error pulling new records by ID: ${pError}`);
							}
							else
							{
								this.fable.log.info(`${this.EntitySchema.TableName}: pulled ${pSyncedCount} new records by ID.`);
							}
							// Per-page progress is now tracked inside _pullServerRecords()
							return fStageComplete();
						});
				},
			],
			(pError) =>
			{
				if (pError)
				{
					this.fable.log.error(`Error performing ongoing sync ${this.EntitySchema.TableName}: ${pError}`, { Error: pError });
				}

				// Mark progress tracker as complete so the UI shows the correct totals
				let tmpTracker = this.operation.progressTrackers[`FullSync-${this.EntitySchema.TableName}`];
				if (tmpTracker)
				{
					tmpTracker.CurrentCount = tmpTracker.TotalCount;
				}

				this.fable.log.info(`${this.EntitySchema.TableName}: ongoing sync complete.`);

		// Store sync results so callers can inspect the breakdown
		this.syncResults = {
			Created: this._recordsCreated,
			Updated: this._recordsUpdated,
			Deleted: 0,
			ServerRecordCount: tmpSyncState.Server.RecordCount,
			LocalRecordCount: tmpSyncState.Local.RecordCount
		};

				if (this.SyncDeletedRecords)
				{
					return this.syncDeletedRecords(() => { return fCallback(); });
				}

				return fCallback();
			});
	}
}

module.exports = MeadowSyncEntityOngoing;
