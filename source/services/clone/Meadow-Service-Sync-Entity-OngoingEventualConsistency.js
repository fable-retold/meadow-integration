const libMeadowSyncEntityOngoing = require('./Meadow-Service-Sync-Entity-Ongoing.js');

class MeadowSyncEntityOngoingEventualConsistency extends libMeadowSyncEntityOngoing
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'MeadowSyncEntityOngoingEventualConsistency';

		// Milliseconds devoted to backwards bisection of existing records before
		// moving on to pull new records.  Default 30 seconds.
		this.BackSyncTimeLimit = (typeof(this.options.BackSyncTimeLimit) === 'number')
			? this.options.BackSyncTimeLimit
			: 30000;
	}

	// Bisect an ID range with a time budget.  Checks the budget at the start of
	// each recursive call and stops when time is exhausted.  Otherwise identical
	// to the inherited _bisectRange, except it subdivides upper-half-first so
	// that the most recently created records (high IDs) are prioritized.
	_bisectRangeWithTimeBudget(pMinID, pMaxID, pDepth, pStartTime, pTimeLimit, fCallback)
	{
		// Time budget check
		if (Date.now() - pStartTime >= pTimeLimit)
		{
			return fCallback();
		}

		// Global record cap check
		if (this.MaxRecordsPerEntity > 0 && this._totalSyncedThisSync >= this.MaxRecordsPerEntity)
		{
			return fCallback();
		}

		const tmpRangeSize = pMaxID - pMinID + 1;
		const tmpIDCol = this.DefaultIdentifier;
		const tmpRangeFilter = `FBV~${tmpIDCol}~GE~${pMinID}~FBV~${tmpIDCol}~LE~${pMaxID}`;

		this._getLocalCount(pMinID, pMaxID,
			(pLocalCountError, pLocalCount) =>
			{
				if (pLocalCountError)
				{
					this.fable.log.warn(`${this.EntitySchema.TableName}: bisect local count error for range ${pMinID}-${pMaxID}: ${pLocalCountError}`);
					return fCallback();
				}

				this._getServerCount(tmpRangeFilter,
					(pServerCountError, pServerCount) =>
					{
						if (pServerCountError)
						{
							this.fable.log.warn(`${this.EntitySchema.TableName}: bisect server count error for range ${pMinID}-${pMaxID}: ${pServerCountError}`);
							return fCallback();
						}

						if (pLocalCount === pServerCount)
						{
							if (!this._hasUpdateDate)
							{
								this._incrementProgress(pServerCount);
								return fCallback();
							}

							this._getLocalMaxUpdateDate(pMinID, pMaxID,
								(pLocalMaxErr, pLocalMaxDate) =>
								{
									if (pLocalMaxErr || !pLocalMaxDate)
									{
										return fCallback();
									}

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
												this._incrementProgress(pServerCount);
												return fCallback();
											}

											this.fable.log.info(`${this.EntitySchema.TableName}: date mismatch in range ${pMinID}-${pMaxID} (local max: ${pLocalMaxDate}, server max: ${tmpServerMaxDate})`);
											if (tmpRangeSize <= this.BisectMinRangeSize)
											{
												return this._pullRangeFromServer(pMinID, pMaxID, fCallback);
											}
											return this._subdivideRangeReversed(pMinID, pMaxID, pDepth, pStartTime, pTimeLimit, fCallback);
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

						return this._subdivideRangeReversed(pMinID, pMaxID, pDepth, pStartTime, pTimeLimit, fCallback);
					});
			});
	}

	// Split a range in half and bisect the UPPER half first so that recently
	// created/modified records (high IDs) are checked before older records.
	_subdivideRangeReversed(pMinID, pMaxID, pDepth, pStartTime, pTimeLimit, fCallback)
	{
		const tmpMidID = Math.floor((pMinID + pMaxID) / 2);

		this.fable.log.info(`${this.EntitySchema.TableName}: subdividing range ${pMinID}-${pMaxID} at ID ${tmpMidID} (depth ${pDepth}, upper half first)`);

		// Upper half first (reversed from standard bisection)
		// Use setImmediate to break the recursive call chain for synchronous
		// database providers (e.g. better-sqlite3).
		setImmediate(() =>
		{
			this._bisectRangeWithTimeBudget(tmpMidID + 1, pMaxID, pDepth + 1, pStartTime, pTimeLimit,
				() =>
				{
					// Then lower half (if time remains -- checked at entry of next call)
					setImmediate(() =>
					{
						this._bisectRangeWithTimeBudget(pMinID, tmpMidID, pDepth + 1, pStartTime, pTimeLimit, fCallback);
					});
				});
		});
	}

	// Override deleted record sync with a time-budgeted version.
	//
	// The server does not return deleted rows through the normal endpoints, so
	// we page the deleted set explicitly and flag the matching LOCAL row deleted.
	//
	// SAFETY — match on IDENTITY, never on GUID.  This is a database clone: the
	// identity column is authoritative and equals the origin's (joins and FKs
	// depend on it), while GUIDs are NOT guaranteed unique in this data.  Acting
	// on a GUID match could soft-delete the WRONG row (a different, possibly
	// active, record that happens to share the GUID).  So we read and delete only
	// by the row whose id equals the server's deleted row's id.
	//
	// A deleted server row whose id is not present locally was deleted before it
	// was ever cloned here.  We do NOT create it: with duplicate GUIDs a create
	// collides on the GUID unique index (the old "...already exists!" log storm),
	// and backfilling those rows + de-duplicating GUIDs is a separate cleanup.
	// We count them so the remaining backlog is visible.
	//
	// Ordering: newest-first by the indexed identity column.  Sorting by
	// DeleteDate is honored by the API but is an unindexed filesort (10-150x
	// slower on large tables — Observation: 87s for one page), so we order by the
	// PK and stay within budget.  DeleteDate is present in the payload, so a
	// future steady-state cursor can track the server's delete high-water mark
	// without paying for the sort.  Processing is time-budgeted to BackSyncTimeLimit.
	syncDeletedRecords(fCallback)
	{
		const tmpDeletedColumn = this.EntitySchema.Columns.find((c) => c.Column == 'Deleted');
		if (!tmpDeletedColumn)
		{
			this.fable.log.info(`No Deleted column for ${this.EntitySchema.TableName}; skipping delete sync.`);
			return fCallback();
		}

		this.fable.log.info(`Checking for deleted records on server for ${this.EntitySchema.TableName} (time-budgeted, matching on ${this.DefaultIdentifier})...`);

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

				const tmpDeleteCap = (this.MaxRecordsPerEntity > 0)
					? Math.min(tmpDeletedCount, this.MaxRecordsPerEntity)
					: tmpDeletedCount;

				this.fable.log.info(`Found ${tmpDeletedCount} deleted records on server for ${this.EntitySchema.TableName}; reconciling newest-first with ${this.BackSyncTimeLimit}ms budget...`);

				const tmpStartTime = Date.now();
				let tmpOffset = 0;
				let tmpSeen = 0;       // server rows examined
				let tmpMarked = 0;     // local rows (matched by id) newly flagged deleted
				let tmpAlready = 0;    // local rows already deleted
				let tmpNotInClone = 0; // deleted id not present locally (backlog — needs backfill cleanup)
				let tmpErrors = 0;     // read/delete failures

				const fFinish = (pReason) =>
				{
					const tmpElapsed = Date.now() - tmpStartTime;
					// Surface the real delete count in the structured run report
					// (it was previously hard-coded to 0).
					if (this.syncResults)
					{
						this.syncResults.Deleted = tmpMarked;
					}
					this.fable.log.info(`Delete sync ${pReason} for ${this.EntitySchema.TableName} after ${tmpElapsed}ms: marked ${tmpMarked}, already-deleted ${tmpAlready}, not-in-clone ${tmpNotInClone}, errors ${tmpErrors} (examined ${tmpSeen} of ${tmpDeletedCount}).`);
					return fCallback();
				};

				// Fetch deleted record pages one at a time using a recursive
				// fetcher.  Newest-first by the indexed identity column so recent
				// deletions are reconciled within budget even when the historical
				// backlog is large.
				const fFetchDeletedPage = () =>
				{
					if (Date.now() - tmpStartTime >= this.BackSyncTimeLimit)
					{
						return fFinish('time budget exhausted');
					}
					if (tmpOffset >= tmpDeleteCap)
					{
						return fFinish('complete');
					}

					const tmpURL = this._appendDeletedQueryString(`${this.EntitySchema.TableName}s/FilteredTo/FBV~Deleted~EQ~1~FSF~${this.DefaultIdentifier}~DESC~DESC/${tmpOffset}/${this.PageSize}`);
					tmpOffset += this.PageSize;

					this.fable.MeadowCloneRestClient.getJSON(tmpURL,
						(pDownloadError, pResponse, pPageBody) =>
						{
							if (pDownloadError || !pPageBody || !Array.isArray(pPageBody) || pPageBody.length < 1)
							{
								return fFinish('complete');
							}

							this.fable.Utility.eachLimit(pPageBody, 5,
								(pEntityRecord, fRecordComplete) =>
								{
									tmpSeen++;

									const tmpRecordID = pEntityRecord[this.DefaultIdentifier];
									if (tmpRecordID === undefined || tmpRecordID === null || tmpRecordID < 1)
									{
										tmpNotInClone++;
										return setImmediate(fRecordComplete);
									}

									// Read by IDENTITY only (the authoritative, unique key).  We
									// never look up or act on the GUID — see the SAFETY note above.
									const tmpQuery = this.Meadow.query;
									tmpQuery.addFilter(this.DefaultIdentifier, tmpRecordID);
									tmpQuery.setDisableDeleteTracking(true);

									this.Meadow.doRead(tmpQuery,
										(pReadError, pReadQuery, pLocalRecord) =>
										{
											if (pReadError)
											{
												tmpErrors++;
												this.log.error(`Delete sync read error for ${this.EntitySchema.TableName} ${this.DefaultIdentifier}=${tmpRecordID}: ${pReadError}`);
												return setImmediate(fRecordComplete);
											}

											// Deleted id not in the clone — deleted before it was ever
											// synced here.  Do NOT create (collides on duplicate GUIDs);
											// leave it for the backfill/de-dup cleanup.
											if (!pLocalRecord)
											{
												tmpNotInClone++;
												return setImmediate(fRecordComplete);
											}

											// Already reconciled — cheap skip.
											if (pLocalRecord.Deleted == 1)
											{
												tmpAlready++;
												return setImmediate(fRecordComplete);
											}

											// Flag THIS row — selected by its authoritative, unique id,
											// so we can never touch a different record that shares the
											// GUID.  doDelete is the canonical soft-delete (UPDATE ... SET
											// Deleted=1, DeleteDate=NOW(), DeletingIDUser=... WHERE id=?
											// AND Deleted=0): idempotent, and — unlike doUpdate — it
											// neither strips the delete-tracking columns nor trips the
											// delete-tracking-filtered post-update verify read.  DeleteDate
											// is stamped to the local detection time (meadow has no path
											// to set the source's value); adequate for the clone.
											const tmpDeleteQuery = this.Meadow.query;
											tmpDeleteQuery.addFilter(this.DefaultIdentifier, tmpRecordID);

											this.Meadow.doDelete(tmpDeleteQuery,
												(pDeleteError) =>
												{
													if (pDeleteError)
													{
														tmpErrors++;
														this.log.error(`Error marking record deleted ${this.EntitySchema.TableName} ${this.DefaultIdentifier}=${tmpRecordID}: ${pDeleteError}`);
													}
													else
													{
														tmpMarked++;
													}
													return setImmediate(fRecordComplete);
												});
										});
								},
								(pRecordSyncError) =>
								{
									// Page complete — heartbeat, then fetch next page.
									const tmpElapsed = Date.now() - tmpStartTime;
									this.fable.log.info(`Delete sync ${this.EntitySchema.TableName}: examined ${tmpSeen}/${tmpDeletedCount} — marked ${tmpMarked}, already ${tmpAlready}, not-in-clone ${tmpNotInClone}, errors ${tmpErrors} (${tmpElapsed}ms).`);
									return setImmediate(fFetchDeletedPage);
								});
						});
				};

				fFetchDeletedPage();
			});
	}

	_syncInternal(fCallback)
	{
		this.operation.createTimeStamp('EntityOngoingEventualConsistencySync');

		this._totalSyncedThisSync = 0;
		this._recordsCreated = 0;
		this._recordsUpdated = 0;

		const tmpSyncState = (
			{
				Local: { MaxIDEntity: -1, RecordCount: 0 },
				Server: { MaxIDEntity: -1, RecordCount: 0 },
			});

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

		this.fable.log.info(`Syncing with ONGOING EVENTUAL CONSISTENCY STRATEGY entity ${this.EntitySchema.TableName} (BackSyncTimeLimit: ${this.BackSyncTimeLimit}ms, UpdateDate: ${this._hasUpdateDate}, Deleted: ${this._hasDeletedColumn})...`);

		this.fable.Utility.waterfall(
			[
				// ---- Stage 1: Gather local stats ----
				(fStageComplete) =>
				{
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
							return fStageComplete();
						});
				},
				(fStageComplete) =>
				{
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

				// Create progress tracker
				(fStageComplete) =>
				{
					let tmpTrackerTotal = (this.MaxRecordsPerEntity > 0)
						? Math.min(tmpSyncState.Server.RecordCount, this.MaxRecordsPerEntity)
						: tmpSyncState.Server.RecordCount;
					this.operation.createProgressTracker(tmpTrackerTotal, `FullSync-${this.EntitySchema.TableName}`);
					return fStageComplete();
				},

				// ---- Stage 3: Time-budgeted backwards bisection ----
				(fStageComplete) =>
				{
					if (tmpSyncState.Local.MaxIDEntity < 1)
					{
						this.fable.log.info(`${this.EntitySchema.TableName}: no local records; skipping backwards bisection.`);
						return fStageComplete();
					}

					const tmpBackSyncStartTime = Date.now();
					this.fable.log.info(`${this.EntitySchema.TableName}: starting backwards bisection with ${this.BackSyncTimeLimit}ms time budget (ID range 1-${tmpSyncState.Local.MaxIDEntity})...`);

					this._bisectRangeWithTimeBudget(1, tmpSyncState.Local.MaxIDEntity, 0, tmpBackSyncStartTime, this.BackSyncTimeLimit,
						() =>
						{
							const tmpElapsed = Date.now() - tmpBackSyncStartTime;
							const tmpExhausted = tmpElapsed >= this.BackSyncTimeLimit;
							this.fable.log.info(`${this.EntitySchema.TableName}: backwards bisection ${tmpExhausted ? 'time budget exhausted' : 'complete'} after ${tmpElapsed}ms.`);
							return fStageComplete();
						});
				},

				// ---- Stage 4: Pull new records by ID ----
				(fStageComplete) =>
				{
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
							return fStageComplete();
						});
				},
			],
			(pError) =>
			{
				if (pError)
				{
					this.fable.log.error(`Error performing ongoing eventual consistency sync ${this.EntitySchema.TableName}: ${pError}`, { Error: pError });
				}

				let tmpTracker = this.operation.progressTrackers[`FullSync-${this.EntitySchema.TableName}`];
				if (tmpTracker)
				{
					tmpTracker.CurrentCount = tmpTracker.TotalCount;
				}

				this.fable.log.info(`${this.EntitySchema.TableName}: ongoing eventual consistency sync complete.`);

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

module.exports = MeadowSyncEntityOngoingEventualConsistency;
