const libMeadowSyncEntityOngoing = require('./Meadow-Service-Sync-Entity-Ongoing.js');

class MeadowSyncEntityTrueUp extends libMeadowSyncEntityOngoing
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'MeadowSyncEntityTrueUp';

		// Page size for the linear keyset-paginated walk.  Larger than the normal
		// PageSize because there is no bisection overhead -- we just walk every record.
		this.TrueUpPageSize = (typeof(this.options.TrueUpPageSize) === 'number')
			? this.options.TrueUpPageSize
			: 500;
	}

	_syncInternal(fCallback)
	{
		this.operation.createTimeStamp('EntityTrueUpSync');

		this._totalSyncedThisSync = 0;
		this._recordsCreated = 0;
		this._recordsUpdated = 0;

		const tmpSyncState = (
			{
				Server: { MaxIDEntity: -1, RecordCount: 0 },
			});

		this._hasDeletedColumn = false;

		if (this.EntitySchema && this.EntitySchema.MeadowSchema && Array.isArray(this.EntitySchema.MeadowSchema.Schema))
		{
			for (let i = 0; i < this.EntitySchema.MeadowSchema.Schema.length; i++)
			{
				const tmpColumn = this.EntitySchema.MeadowSchema.Schema[i];
				if (tmpColumn.Type == 'Deleted' || tmpColumn.Column == 'Deleted')
				{
					this._hasDeletedColumn = true;
				}
			}
		}

		this.fable.log.info(`Syncing with TRUE-UP STRATEGY entity ${this.EntitySchema.TableName} (TrueUpPageSize: ${this.TrueUpPageSize})...`);

		this.fable.Utility.waterfall(
			[
				// ---- Stage 1: Gather server stats ----
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

				// ---- Stage 2: Linear keyset-paginated walk ----
				(fStageComplete) =>
				{
					if (tmpSyncState.Server.MaxIDEntity < 1)
					{
						this.fable.log.info(`${this.EntitySchema.TableName}: no records on server; nothing to true-up.`);
						return fStageComplete();
					}

					const tmpIDCol = this.DefaultIdentifier;
					let tmpCursorID = 0;
					let tmpTotalProcessed = 0;

					const fFetchPage = () =>
					{
						// Global record cap check
						if (this.MaxRecordsPerEntity > 0 && this._totalSyncedThisSync >= this.MaxRecordsPerEntity)
						{
							this.fable.log.info(`${this.EntitySchema.TableName}: global record cap reached (${this._totalSyncedThisSync}/${this.MaxRecordsPerEntity}); stopping true-up.`);
							return fStageComplete();
						}

						const tmpFilter = `FBV~${tmpIDCol}~GT~${tmpCursorID}~FSF~${tmpIDCol}~ASC~ASC`;

						this._getServerRecords(tmpFilter, 0, this.TrueUpPageSize,
							(pError, pRecords) =>
							{
								if (pError)
								{
									this.fable.log.error(`Error fetching ${this.EntitySchema.TableName} true-up page at cursor ${tmpCursorID}: ${pError}`);
									return fStageComplete(pError);
								}
								if (!pRecords || pRecords.length < 1)
								{
									this.fable.log.info(`${this.EntitySchema.TableName}: true-up walk complete (${tmpTotalProcessed} records processed).`);
									return fStageComplete();
								}

								this.fable.Utility.eachLimit(pRecords, this.SyncRecordConcurrency,
									(pRecord, fRecordDone) =>
									{
										this._upsertRecord(pRecord,
											() =>
											{
												tmpTotalProcessed++;
												this._totalSyncedThisSync++;
												return setImmediate(fRecordDone);
											});
									},
									(pUpsertError) =>
									{
										this._incrementProgress(pRecords.length);

										// Advance cursor to max ID seen in this page
										tmpCursorID = pRecords[pRecords.length - 1][tmpIDCol];

										if (pRecords.length < this.TrueUpPageSize)
										{
											this.fable.log.info(`${this.EntitySchema.TableName}: true-up walk complete (${tmpTotalProcessed} records processed).`);
											return fStageComplete();
										}

										this.fable.log.info(`${this.EntitySchema.TableName}: true-up progress ${tmpTotalProcessed} of ~${tmpSyncState.Server.RecordCount} records (cursor at ID ${tmpCursorID})...`);
										return setImmediate(fFetchPage);
									});
							});
					};

					fFetchPage();
				},
			],
			(pError) =>
			{
				if (pError)
				{
					this.fable.log.error(`Error performing true-up sync ${this.EntitySchema.TableName}: ${pError}`, { Error: pError });
				}

				let tmpTracker = this.operation.progressTrackers[`FullSync-${this.EntitySchema.TableName}`];
				if (tmpTracker)
				{
					tmpTracker.CurrentCount = tmpTracker.TotalCount;
				}

				this.fable.log.info(`${this.EntitySchema.TableName}: true-up sync complete.`);

				this.syncResults = {
					Created: this._recordsCreated,
					Updated: this._recordsUpdated,
					Deleted: 0,
					ServerRecordCount: tmpSyncState.Server.RecordCount,
					LocalRecordCount: 0
				};

				if (this.SyncDeletedRecords)
				{
					return this.syncDeletedRecords(() => { return fCallback(); });
				}

				return fCallback();
			});
	}
}

module.exports = MeadowSyncEntityTrueUp;
