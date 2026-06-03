const libMeadowSyncEntityOngoing = require('./Meadow-Service-Sync-Entity-Ongoing.js');
const libMeadowDeleteCursorStore = require('./Meadow-Service-DeleteCursorStore.js');

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

		// Optional resumable-delete cursor.  When a state-file path is configured
		// (via options or fable settings), delete reconciliation persists how far
		// it has progressed so each run resumes instead of re-walking from the top.
		// Unset → disabled, and delete sync behaves exactly as the non-cursor path.
		// The file must live on a path that survives between runs to be useful.
		const tmpSettings = this.fable.settings || {};
		this.DeleteCursorStatePath = this.options.DeleteCursorStatePath || tmpSettings.DeleteCursorStatePath || '';
		// Hours between full re-sweeps once caught up (catches deletions of older
		// records that landed in already-swept id ranges).  Default 1 week.
		this.DeleteResweepIntervalHours = (typeof(this.options.DeleteResweepIntervalHours) === 'number')
			? this.options.DeleteResweepIntervalHours
			: (typeof(tmpSettings.DeleteResweepIntervalHours) === 'number') ? tmpSettings.DeleteResweepIntervalHours : 168;
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

		// Opt-in resumable cursor: when a state-file path is configured, persist
		// how far reconciliation has progressed so each run resumes instead of
		// re-walking from the newest record every time.  Unset → this exact path.
		if (this.DeleteCursorStatePath)
		{
			return this._syncDeletedRecordsWithCursor(fCallback);
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
				const tmpCounters = { seen: 0, marked: 0, already: 0, notInClone: 0, errors: 0 };

				const fFinish = (pReason) =>
				{
					const tmpElapsed = Date.now() - tmpStartTime;
					// Surface the real delete count in the structured run report
					// (it was previously hard-coded to 0).
					if (this.syncResults)
					{
						this.syncResults.Deleted = tmpCounters.marked;
					}
					this.fable.log.info(`Delete sync ${pReason} for ${this.EntitySchema.TableName} after ${tmpElapsed}ms: marked ${tmpCounters.marked}, already-deleted ${tmpCounters.already}, not-in-clone ${tmpCounters.notInClone}, errors ${tmpCounters.errors} (examined ${tmpCounters.seen} of ${tmpDeletedCount}).`);
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
									tmpCounters.seen++;
									this._reconcileDeletedRecordByID(pEntityRecord, tmpCounters, fRecordComplete);
								},
								(pRecordSyncError) =>
								{
									// Page complete — heartbeat, then fetch next page.
									const tmpElapsed = Date.now() - tmpStartTime;
									this.fable.log.info(`Delete sync ${this.EntitySchema.TableName}: examined ${tmpCounters.seen}/${tmpDeletedCount} — marked ${tmpCounters.marked}, already ${tmpCounters.already}, not-in-clone ${tmpCounters.notInClone}, errors ${tmpCounters.errors} (${tmpElapsed}ms).`);
									return setImmediate(fFetchDeletedPage);
								});
						});
				};

				fFetchDeletedPage();
			});
	}

	// Reconcile one server-deleted record into the clone, matched by IDENTITY
	// ONLY (never GUID — see the SAFETY note on syncDeletedRecords).  Increments
	// exactly one counter on pCounters: marked / already / notInClone / errors.
	// Shared by both the time-budgeted path and the resumable-cursor path.
	_reconcileDeletedRecordByID(pEntityRecord, pCounters, fDone)
	{
		const tmpRecordID = pEntityRecord[this.DefaultIdentifier];
		if (tmpRecordID === undefined || tmpRecordID === null || tmpRecordID < 1)
		{
			pCounters.notInClone++;
			return setImmediate(fDone);
		}

		// Read by the authoritative, unique identity column.  Delete tracking is
		// disabled on the read so an already-deleted local row is still found
		// (and skipped) rather than re-attempted.
		const tmpQuery = this.Meadow.query;
		tmpQuery.addFilter(this.DefaultIdentifier, tmpRecordID);
		tmpQuery.setDisableDeleteTracking(true);

		this.Meadow.doRead(tmpQuery,
			(pReadError, pReadQuery, pLocalRecord) =>
			{
				if (pReadError)
				{
					pCounters.errors++;
					this.log.error(`Delete sync read error for ${this.EntitySchema.TableName} ${this.DefaultIdentifier}=${tmpRecordID}: ${pReadError}`);
					return setImmediate(fDone);
				}

				// Deleted id not in the clone — deleted before it was ever synced
				// here.  Do NOT create (collides on duplicate GUIDs); leave it for
				// the backfill/de-dup cleanup.
				if (!pLocalRecord)
				{
					pCounters.notInClone++;
					return setImmediate(fDone);
				}

				// Already reconciled — cheap skip.
				if (pLocalRecord.Deleted == 1)
				{
					pCounters.already++;
					return setImmediate(fDone);
				}

				// Flag THIS row — selected by its authoritative, unique id, so we
				// can never touch a different record that shares the GUID.  doDelete
				// is the canonical soft-delete (UPDATE ... SET Deleted=1,
				// DeleteDate=NOW(), DeletingIDUser=... WHERE id=? AND Deleted=0):
				// idempotent, and — unlike doUpdate — it neither strips the
				// delete-tracking columns nor trips the delete-tracking-filtered
				// post-update verify read.  DeleteDate is the local detection time
				// (meadow has no path to set the source's value); fine for the clone.
				const tmpDeleteQuery = this.Meadow.query;
				tmpDeleteQuery.addFilter(this.DefaultIdentifier, tmpRecordID);

				this.Meadow.doDelete(tmpDeleteQuery,
					(pDeleteError) =>
					{
						if (pDeleteError)
						{
							pCounters.errors++;
							this.log.error(`Error marking record deleted ${this.EntitySchema.TableName} ${this.DefaultIdentifier}=${tmpRecordID}: ${pDeleteError}`);
						}
						else
						{
							pCounters.marked++;
						}
						return setImmediate(fDone);
					});
			});
	}

	// Resumable delete reconciliation (opt-in via DeleteCursorStatePath).
	//
	// Persists two id marks per table in a small JSON file so a run resumes
	// rather than re-walking from the newest record (which, with heavy rows and a
	// time budget, never reaches the older backlog):
	//   - HeadID: highest deleted id already covered from the top.
	//   - TailID: resume point of the downward catch-up sweep.
	// Each run does a HEAD pass (id > HeadID — new deletions since last run, cheap)
	// then a TAIL pass (id < TailID — drain older backlog within the remaining
	// budget).  When the tail reaches the bottom, the backlog is drained and only
	// the head pass runs thereafter.  A periodic re-sweep (DeleteResweepIntervalHours)
	// resets the tail to catch deletions that landed in already-swept id ranges.
	// All keyset paging (id < cursor) — no growing OFFSET scan.
	//
	// Safety/behavior is identical to the non-cursor path (same id-only
	// _reconcileDeletedRecordByID); only WHERE paging starts differs.  Missing or
	// unreadable state degrades to a full sweep.
	_syncDeletedRecordsWithCursor(fCallback)
	{
		const tmpTable = this.EntitySchema.TableName;
		const tmpStore = new libMeadowDeleteCursorStore(this.DeleteCursorStatePath, this.fable.log);
		const tmpState = tmpStore.get(tmpTable) || { HeadID: 0, TailID: null, CaughtUp: false, LastSweepEpoch: 0 };

		// Re-sweep: once caught up, periodically reset the tail to re-drain from
		// the top so deletions that landed in already-swept ranges are caught.
		const tmpNow = Date.now();
		if (tmpState.CaughtUp && this.DeleteResweepIntervalHours > 0
			&& (tmpNow - (tmpState.LastSweepEpoch || 0)) >= (this.DeleteResweepIntervalHours * 3600000))
		{
			this.fable.log.info(`Delete cursor for ${tmpTable}: re-sweep interval elapsed; resetting tail to re-drain from the top.`);
			tmpState.TailID = null;
			tmpState.CaughtUp = false;
		}

		this.fable.log.info(`Delete cursor for ${tmpTable}: headID=${tmpState.HeadID}, tailID=${tmpState.TailID === null ? 'top' : tmpState.TailID}, caughtUp=${tmpState.CaughtUp} (matching on ${this.DefaultIdentifier}, ${this.BackSyncTimeLimit}ms budget)...`);

		const tmpStartTime = Date.now();
		const tmpCounters = { seen: 0, marked: 0, already: 0, notInClone: 0, errors: 0 };
		let tmpNewHeadID = tmpState.HeadID;

		const fSaveAndFinish = (pReason) =>
		{
			tmpState.HeadID = tmpNewHeadID;
			tmpStore.set(tmpTable, tmpState);
			const tmpElapsed = Date.now() - tmpStartTime;
			if (this.syncResults)
			{
				this.syncResults.Deleted = tmpCounters.marked;
			}
			this.fable.log.info(`Delete cursor ${pReason} for ${tmpTable} after ${tmpElapsed}ms: marked ${tmpCounters.marked}, already ${tmpCounters.already}, not-in-clone ${tmpCounters.notInClone}, errors ${tmpCounters.errors} (examined ${tmpCounters.seen}); headID=${tmpState.HeadID}, tailID=${tmpState.TailID === null ? 'top' : tmpState.TailID}, caughtUp=${tmpState.CaughtUp}.`);
			return fCallback();
		};

		// HEAD pass — only once a head has been established (not the first run).
		const fRunHeadPass = (fHeadDone) =>
		{
			if (!(tmpState.HeadID > 0))
			{
				return fHeadDone();
			}
			this._fetchDeletedKeysetPass({ floorID: tmpState.HeadID, ceilID: null, startTime: tmpStartTime, counters: tmpCounters, label: 'head' },
				(pResult) =>
				{
					if (pResult.maxID !== null && pResult.maxID > tmpNewHeadID) { tmpNewHeadID = pResult.maxID; }
					return fHeadDone();
				});
		};

		// TAIL pass — drain downward from TailID (null = from the very top, which
		// is the first run and also establishes the head).
		const fRunTailPass = (fTailDone) =>
		{
			if (tmpState.CaughtUp)
			{
				return fTailDone();
			}
			this._fetchDeletedKeysetPass({ floorID: null, ceilID: tmpState.TailID, startTime: tmpStartTime, counters: tmpCounters, label: 'tail' },
				(pResult) =>
				{
					if (pResult.maxID !== null && pResult.maxID > tmpNewHeadID) { tmpNewHeadID = pResult.maxID; }
					if (pResult.minID !== null) { tmpState.TailID = pResult.minID; }
					if (pResult.reachedEnd)
					{
						tmpState.CaughtUp = true;
						tmpState.LastSweepEpoch = Date.now();
					}
					return fTailDone();
				});
		};

		fRunHeadPass(() =>
		{
			fRunTailPass(() =>
			{
				return fSaveAndFinish(tmpState.CaughtUp ? 'caught up (steady state)' : 'progressed');
			});
		});
	}

	// Keyset-paged pass over the deleted set: Deleted=1 [AND id > floorID]
	// [AND id < ceilID], ordered id DESC, advancing the ceiling to each page's
	// lowest id.  Shares the run's time budget (BackSyncTimeLimit) and the global
	// MaxRecordsPerEntity cap.  Calls fComplete({ maxID, minID, reachedEnd }):
	// maxID = highest id seen (first row, establishes head on the first run),
	// minID = lowest id seen (next resume point), reachedEnd = the deleted set was
	// exhausted within this pass.
	_fetchDeletedKeysetPass(pOptions, fComplete)
	{
		const tmpFloorID = (pOptions.floorID === undefined) ? null : pOptions.floorID;
		let tmpCeilID = (pOptions.ceilID === undefined) ? null : pOptions.ceilID;
		const tmpCounters = pOptions.counters;
		let tmpMaxID = null;
		let tmpMinID = null;

		const fFetch = () =>
		{
			if (Date.now() - pOptions.startTime >= this.BackSyncTimeLimit)
			{
				return fComplete({ maxID: tmpMaxID, minID: tmpMinID, reachedEnd: false });
			}
			if (this.MaxRecordsPerEntity > 0 && tmpCounters.seen >= this.MaxRecordsPerEntity)
			{
				return fComplete({ maxID: tmpMaxID, minID: tmpMinID, reachedEnd: false });
			}

			let tmpFilter = 'FBV~Deleted~EQ~1';
			if (tmpFloorID !== null) { tmpFilter += `~FBV~${this.DefaultIdentifier}~GT~${tmpFloorID}`; }
			if (tmpCeilID !== null) { tmpFilter += `~FBV~${this.DefaultIdentifier}~LT~${tmpCeilID}`; }
			tmpFilter += `~FSF~${this.DefaultIdentifier}~DESC~DESC`;
			const tmpURL = this._appendDeletedQueryString(`${this.EntitySchema.TableName}s/FilteredTo/${tmpFilter}/0/${this.PageSize}`);

			this.fable.MeadowCloneRestClient.getJSON(tmpURL,
				(pError, pResponse, pPageBody) =>
				{
					if (pError)
					{
						this.fable.log.warn(`Delete cursor ${this.EntitySchema.TableName} [${pOptions.label}]: page fetch error (${pError}); pausing pass.`);
						return fComplete({ maxID: tmpMaxID, minID: tmpMinID, reachedEnd: false });
					}
					if (!Array.isArray(pPageBody) || pPageBody.length < 1)
					{
						// Empty page = exhausted this id range.
						return fComplete({ maxID: tmpMaxID, minID: tmpMinID, reachedEnd: true });
					}

					if (tmpMaxID === null)
					{
						tmpMaxID = pPageBody[0][this.DefaultIdentifier]; // DESC → first row is the highest id
					}

					this.fable.Utility.eachLimit(pPageBody, 5,
						(pEntityRecord, fRecordComplete) =>
						{
							tmpCounters.seen++;
							this._reconcileDeletedRecordByID(pEntityRecord, tmpCounters, fRecordComplete);
						},
						(pRecordSyncError) =>
						{
							const tmpPageMinID = pPageBody[pPageBody.length - 1][this.DefaultIdentifier];
							tmpMinID = tmpPageMinID;
							tmpCeilID = tmpPageMinID; // keyset: next page is strictly below this page's lowest id
							const tmpElapsed = Date.now() - pOptions.startTime;
							this.fable.log.info(`Delete cursor ${this.EntitySchema.TableName} [${pOptions.label}]: examined ${tmpCounters.seen} — marked ${tmpCounters.marked}, already ${tmpCounters.already}, not-in-clone ${tmpCounters.notInClone}, errors ${tmpCounters.errors}; at id ${tmpPageMinID} (${tmpElapsed}ms).`);
							if (pPageBody.length < this.PageSize)
							{
								return fComplete({ maxID: tmpMaxID, minID: tmpMinID, reachedEnd: true });
							}
							return setImmediate(fFetch);
						});
				});
		};

		fFetch();
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
