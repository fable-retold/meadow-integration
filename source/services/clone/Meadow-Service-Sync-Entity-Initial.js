const libFableServiceProviderBase = require('fable-serviceproviderbase');
const libMeadowOperation = require('./Meadow-Service-Operation.js');
const libSyncPoolLimit = require('./Meadow-Service-Sync-PoolLimit.js');
const libMeadowDeleteStamp = require('./Meadow-Service-Sync-DeleteStamp.js');

class MeadowSyncEntityInitial extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'MeadowSyncEntityInitial';

		if (!this.options.hasOwnProperty('MeadowEntitySchema'))
		{
			throw new Error('MeadowSyncEntityInitial requires a valid MeadowEntitySchema option.');
		}
		if (typeof(this.options.MeadowEntitySchema) != 'object')
		{
			throw new Error(`MeadowSyncEntityInitial requires MeadowEntitySchema to be an object; got ${typeof(this.options.MeadowEntitySchema)}.`);
		}
		if (!this.options.MeadowEntitySchema.hasOwnProperty('TableName') ||
			typeof(this.options.MeadowEntitySchema.TableName) != 'string' ||
			this.options.MeadowEntitySchema.TableName.length < 1)
		{
			throw new Error('MeadowSyncEntityInitial requires a valid MeadowEntitySchema.TableName.');
		}
		if (!this.options.MeadowEntitySchema.hasOwnProperty('Columns') ||
			!Array.isArray(this.options.MeadowEntitySchema.Columns) ||
			this.options.MeadowEntitySchema.Columns.length < 1)
		{
			throw new Error('MeadowSyncEntityInitial requires a valid MeadowEntitySchema.Columns array.');
		}

		this.EntitySchema = JSON.parse(JSON.stringify(this.options.MeadowEntitySchema));

		if (!this.EntitySchema.hasOwnProperty('MeadowSchema'))
		{
			throw new Error('MeadowSyncEntityInitial requires MeadowEntitySchema.MeadowSchema; please update stricture and recompile the extended JSON.');
		}

		this.DefaultIdentifier = this.EntitySchema.MeadowSchema.DefaultIdentifier;
		this.PageSize = this.options.PageSize || 100;
		this.SyncDeletedRecords = this.options.SyncDeletedRecords || false;
		this.MaxRecordsPerEntity = this.options.MaxRecordsPerEntity || 0;
		this.UseAdvancedIDPagination = this.options.UseAdvancedIDPagination || false;

		// Optional query string appended to deleted record API requests.
		// Used to work around older APIs where FBV~Deleted~EQ~1 does not
		// override the automatic Deleted=0 filter (e.g. "includeDeleted=true").
		this.SyncDeletedRecordsQueryString = this.options.SyncDeletedRecordsQueryString || '';

		// How many records to upsert concurrently within a table.  Defaults to the
		// DB connection pool size (capped) so fan-out never oversubscribes the pool
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

		if (this.Meadow && this.Meadow.provider)
		{
			let tmpProvider = this.Meadow.provider.getProvider();

			if (!tmpProvider)
			{
				this.log.error(`No provider returned by getProvider() for ${this.EntitySchema.TableName}`);
				return fCallback(new Error(`No provider returned by getProvider() for ${this.EntitySchema.TableName}`));
			}

			if (!tmpProvider.createTable)
			{
				this.log.error(`Provider for ${this.EntitySchema.TableName} has no createTable method.`);
				return fCallback(new Error(`Provider for ${this.EntitySchema.TableName} has no createTable method`));
			}

			return tmpProvider.createTable(this.EntitySchema, (pCreateError) =>
			{
				if (pCreateError)
				{
					this.log.warn(`${this.EntitySchema.TableName}: createTable returned error: ${pCreateError}`);
				}

				// Init only ensures the table exists.  Index provisioning is
				// handled separately and authoritatively by the index-convergence
				// step (Meadow-Service-IndexConvergence), so indexes have a single
				// writer — the legacy per-column MeadowConnectionManager.createIndex
				// path was retired to avoid two mechanisms fighting over the same
				// indexes.
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

		// Get the count of deleted records from the server.
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

				// Generate paginated URLs for deleted records
				let tmpDeleteCap = (this.MaxRecordsPerEntity > 0)
					? Math.min(tmpDeletedCount, this.MaxRecordsPerEntity)
					: tmpDeletedCount;
				const tmpDeleteURLPartials = [];
				for (let i = 0; i < tmpDeleteCap; i += this.PageSize)
				{
					tmpDeleteURLPartials.push(this._appendDeletedQueryString(`${this.EntitySchema.TableName}s/FilteredTo/FBV~Deleted~EQ~1~FSF~${this.DefaultIdentifier}~ASC~ASC/${i}/${this.PageSize}`));
				}

				this.fable.Utility.eachLimit(tmpDeleteURLPartials, 1,
					(pURLPartial, fPageComplete) =>
					{
						this.fable.MeadowCloneRestClient.getJSON(pURLPartial,
							(pDownloadError, pResponse, pBody) =>
							{
								if (pDownloadError || !pBody || !Array.isArray(pBody) || pBody.length < 1)
								{
									return fPageComplete();
								}

								this.fable.Utility.eachLimit(pBody, this.SyncRecordConcurrency,
									(pEntityRecord, fRecordComplete) =>
									{
										const tmpRecordID = pEntityRecord[this.DefaultIdentifier];
										if (!tmpRecordID || tmpRecordID < 1)
										{
											return fRecordComplete();
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
															return fRecordComplete();
														});
													return;
												}

												if (pRecord.Deleted == 1)
												{
													// Already marked deleted locally
													return fRecordComplete();
												}

												// Record exists locally but is not deleted -- flag it, then sync its
												// columns.  doDelete comes first because it is the only write that can
												// set the delete audit columns: foxhound skips DeleteDate/DeleteIDUser on
												// every UPDATE, and stamps DeleteIDUser from the query rather than from
												// the record.  The doUpdate that follows carries the source's remaining
												// column values and leaves those stamps alone.
												const tmpDeleteQuery = this.Meadow.query;
												tmpDeleteQuery.addFilter(this.DefaultIdentifier, tmpRecordID);
												tmpDeleteQuery.setIDUser(libMeadowDeleteStamp.resolveDeletingIDUser(this.Meadow.schema, pEntityRecord));

												this.Meadow.doDelete(tmpDeleteQuery,
													(pDeleteError) =>
													{
														if (pDeleteError)
														{
															this.log.error(`Error stamping delete audit columns ${this.EntitySchema.TableName} ID ${tmpRecordID}: ${pDeleteError}`);
														}

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
																return fRecordComplete();
															});
													});
											});
									},
									(pRecordSyncError) =>
									{
										return fPageComplete();
									});
							});
					},
					(pDeleteSyncError) =>
					{
						this.fable.log.info(`Delete sync complete for ${this.EntitySchema.TableName} (${tmpDeletedCount} deleted records processed).`);
						if (this.syncResults)
						{
							this.syncResults.Deleted = tmpDeletedCount;
						}
						return fCallback();
					});
			});
	}

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
					let tmpErrorStr = (typeof(pReadError) === 'string') ? pReadError : JSON.stringify(pReadError);
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
		this.operation.createTimeStamp('EntityInitialSync');

		this.log.info(`Syncing ${this.EntitySchema.TableName} (PageSize: ${this.PageSize}, SyncDeletedRecords: ${this.SyncDeletedRecords})`);

		const tmpSyncState = (
			{
				Local: { MaxIDEntity: -1, RecordCount: 0 },
				Server: { MaxIDEntity: -1, RecordCount: 0 },
			});

		// Detect whether the table has a Deleted column
		if (this.EntitySchema.MeadowSchema && Array.isArray(this.EntitySchema.MeadowSchema.Schema))
		{
			for (let i = 0; i < this.EntitySchema.MeadowSchema.Schema.length; i++)
			{
				const tmpColumn = this.EntitySchema.MeadowSchema.Schema[i];
				if (tmpColumn.Type == 'Deleted' || tmpColumn.Column == 'Deleted')
				{
					tmpSyncState.HasDeletedColumn = true;
				}
			}
		}

		this.fable.Utility.waterfall(
			[
				(fStageComplete) =>
				{
					// Get the Max ID from local database
					const tmpQuery = this.Meadow.query;
					tmpQuery.setSort({ Column: this.DefaultIdentifier, Direction: 'Descending' });
					tmpQuery.setCap(1);
					if (!tmpSyncState.HasDeletedColumn)
					{
						tmpQuery.setDisableDeleteTracking(true);
					}
					this.Meadow.doRead(tmpQuery,
						(pReadError, pQuery, pRecord) =>
						{
							if (pReadError)
							{
								return fStageComplete(`Error reading local max entity ID ${this.EntitySchema.TableName}: ${pReadError}`);
							}
							if (pRecord)
							{
								tmpSyncState.Local.MaxIDEntity = pRecord[this.DefaultIdentifier];
							}
							return fStageComplete();
						});
				},
				(fStageComplete) =>
				{
					// Get the count from local database
					const tmpQuery = this.Meadow.query;
					if (!tmpSyncState.HasDeletedColumn)
					{
						tmpQuery.setDisableDeleteTracking(true);
					}
					this.Meadow.doCount(tmpQuery,
						(pCountError, pQuery, pCount) =>
						{
							if (pCountError)
							{
								return fStageComplete(`Error getting local count of ${this.EntitySchema.TableName}: ${pCountError}`);
							}
							tmpSyncState.Local.RecordCount = pCount;
							return fStageComplete();
						});
				},
				(fStageComplete) =>
				{
					// Get the Max ID from the server
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
							}
							return fStageComplete();
						});
				},
				(fStageComplete) =>
				{
					// Get the count from the server
					this.fable.MeadowCloneRestClient.getJSON(`${this.EntitySchema.TableName}s/Count`,
						(pError, pResponse, pBody) =>
						{
							if (pError)
							{
								this.fable.log.warn(`Could not get server count for ${this.EntitySchema.TableName} (${pError}); estimating from max ID.`);
								tmpSyncState.Server.RecordCount = tmpSyncState.Server.MaxIDEntity > 0 ? tmpSyncState.Server.MaxIDEntity : 0;
								return fStageComplete();
							}
							if (pBody && pBody.hasOwnProperty('Count'))
							{
								tmpSyncState.Server.RecordCount = pBody.Count;
							}
							return fStageComplete();
						});
				},
				(fStageComplete) =>
				{
					// The raw diff can be negative when local has more records
					// than the server (e.g. records were deleted server-side but
					// the local copy still has them).  Clamp the estimate to 0
					// so progress trackers and downstream reports never show a
					// negative total.
					let tmpRawEstimate = tmpSyncState.Server.RecordCount - tmpSyncState.Local.RecordCount;
					tmpSyncState.EstimatedRecordCount = Math.max(0, tmpRawEstimate);

					// Apply MaxRecordsPerEntity cap if configured
					tmpSyncState.RecordCap = (this.MaxRecordsPerEntity > 0)
						? Math.min(tmpSyncState.Server.RecordCount, this.MaxRecordsPerEntity)
						: tmpSyncState.Server.RecordCount;
					let tmpRecordCap = tmpSyncState.RecordCap;

					if (this.MaxRecordsPerEntity > 0 && tmpSyncState.EstimatedRecordCount > this.MaxRecordsPerEntity)
					{
						tmpSyncState.EstimatedRecordCount = this.MaxRecordsPerEntity;
					}

					this.operation.createProgressTracker(tmpSyncState.EstimatedRecordCount, `FullSync-${this.EntitySchema.TableName}`);
					this.operation.printProgressTrackerStatus(`FullSync-${this.EntitySchema.TableName}`);

					// Fast path: if there is nothing new to pull (estimate is
					// zero or negative), skip the download phase entirely.
					// Running the paginated loop would otherwise make one or
					// more requests just to receive an empty response and then
					// short-circuit with an "Error: Records depleted!" log —
					// noisy and a waste of round-trips.  Zero out RecordCap
					// as well so the advanced-ID-pagination loop
					// (which gates on RecordCap, not URLPartials) also skips.
					if (tmpSyncState.EstimatedRecordCount <= 0)
					{
						tmpSyncState.URLPartials = [];
						tmpSyncState.RecordCap = 0;
						if (tmpRawEstimate < 0)
						{
							this.fable.log.info(`${this.EntitySchema.TableName}: local has ${-tmpRawEstimate} more record(s) than server (local: ${tmpSyncState.Local.RecordCount}, server: ${tmpSyncState.Server.RecordCount}); nothing to download.`);
						}
						else
						{
							this.fable.log.info(`${this.EntitySchema.TableName}: record counts match (${tmpSyncState.Server.RecordCount}); nothing to download.`);
						}
						return fStageComplete();
					}

					if (this.UseAdvancedIDPagination)
					{
						this.fable.log.info(`${this.EntitySchema.TableName}: using advanced ID pagination (local: ${tmpSyncState.Local.RecordCount}/${tmpSyncState.Local.MaxIDEntity}, server: ${tmpSyncState.Server.RecordCount}/${tmpSyncState.Server.MaxIDEntity}, estimated new: ${tmpSyncState.EstimatedRecordCount}${this.MaxRecordsPerEntity > 0 ? `, capped at ${this.MaxRecordsPerEntity}` : ''})`);
					}
					else
					{
						// Generate paginated URL partials
						tmpSyncState.URLPartials = [];
						for (let i = 0; i < tmpRecordCap; i += this.PageSize)
						{
							tmpSyncState.URLPartials.push(`${this.EntitySchema.TableName}s/FilteredTo/FBV~${this.DefaultIdentifier}~GT~${tmpSyncState.Local.MaxIDEntity}~FSF~${this.DefaultIdentifier}~ASC~ASC/${i}/${this.PageSize}`);
						}

						this.fable.log.info(`${this.EntitySchema.TableName}: downloading ${tmpSyncState.URLPartials.length} pages (local: ${tmpSyncState.Local.RecordCount}/${tmpSyncState.Local.MaxIDEntity}, server: ${tmpSyncState.Server.RecordCount}/${tmpSyncState.Server.MaxIDEntity}, estimated new: ${tmpSyncState.EstimatedRecordCount}${this.MaxRecordsPerEntity > 0 ? `, capped at ${this.MaxRecordsPerEntity}` : ''})`);
					}

					return fStageComplete();
				},
				(fStageComplete) =>
				{
					let tmpPageIndex = 0;
					let tmpRecordsCreated = 0;
					let tmpRecordsSkipped = 0;
					let tmpRecordsErrored = 0;

					// Shared record-processing function used by both pagination modes
					const fProcessPageRecords = (pBody, fPageProcessComplete) =>
					{
						this.fable.Utility.eachLimit(pBody, this.SyncRecordConcurrency,
							(pEntityRecord, fRawEntitySyncComplete) =>
							{
								// node:sqlite resolves its callbacks synchronously, so the
								// per-record Meadow behavior chain (doCreate -> CollisionRename
								// -> doRead, threaded through async.waterfall/eachOfLimit) never
								// yields and the call stack grows with the record count until it
								// overflows on large syncs. Defer each record's completion so the
								// stack unwinds between records — the same guard the advanced-ID
								// pagination path applies with setImmediate(fFetchPage) below.
								const fEntitySyncComplete = (pError) => setImmediate(() => fRawEntitySyncComplete(pError));
								const tmpRecord = pEntityRecord;
								const tmpQuery = this.Meadow.query;

								if ((typeof(tmpRecord[this.DefaultIdentifier]) !== 'undefined') && (tmpRecord[this.DefaultIdentifier] > 0))
								{
									tmpQuery.addFilter(this.DefaultIdentifier, tmpRecord[this.DefaultIdentifier]);
								}

								if (!tmpSyncState.HasDeletedColumn)
								{
									tmpQuery.setDisableDeleteTracking(true);
								}

								this.Meadow.doRead(tmpQuery,
									(pReadError, pQuery, pRecord) =>
									{
										if (pReadError)
										{
											tmpRecordsErrored++;
											return fEntitySyncComplete();
										}
										if (!pRecord)
										{
											// Record not found -- create it
											const tmpRecordToCommit = this.marshalRecord(tmpRecord);

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
														let tmpErrorStr = (typeof(pCreateError) === 'string') ? pCreateError : JSON.stringify(pCreateError);
														if (tmpErrorStr.toLowerCase().indexOf('duplicate') > -1 || tmpErrorStr.toLowerCase().indexOf('unique') > -1)
														{
															// Duplicate key (likely GUID conflict) -- fall back to update
															this.log.warn(`${this.EntitySchema.TableName}: duplicate key on create for ID ${tmpRecord[this.DefaultIdentifier]}; falling back to update.`);
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
																		tmpRecordsErrored++;
																		this.log.error(`${this.EntitySchema.TableName}: fallback update also failed for ID ${tmpRecord[this.DefaultIdentifier]}: ${pUpdateError}`);
																		return fEntitySyncComplete();
																	}
																	tmpRecordsCreated++;
																	this.operation.incrementProgressTrackerStatus(`FullSync-${this.EntitySchema.TableName}`, 1);
																	return fEntitySyncComplete();
																});
															return;
														}
														tmpRecordsErrored++;
														this.log.error(`${this.EntitySchema.TableName}: doCreate error for ID ${tmpRecord[this.DefaultIdentifier]}: ${pCreateError}`);
														return fEntitySyncComplete();
													}
													tmpRecordsCreated++;
													this.operation.incrementProgressTrackerStatus(`FullSync-${this.EntitySchema.TableName}`, 1);
													return fEntitySyncComplete();
												});
										}
										else
										{
											tmpRecordsSkipped++;
											return fEntitySyncComplete();
										}
									});
							},
							(pEntitySyncError) =>
							{
								this.operation.printProgressTrackerStatus(`FullSync-${this.EntitySchema.TableName}`);
								if (pEntitySyncError)
								{
									this.log.error(`Problem or early completion syncing entity ${this.EntitySchema.TableName}: ${pEntitySyncError}`, pEntitySyncError);
								}
								return fPageProcessComplete(pEntitySyncError);
							});
					};

					const fSyncComplete = (pDownloadError) =>
					{
						this.fable.log.info(`${this.EntitySchema.TableName}: sync complete — created: ${tmpRecordsCreated}, skipped: ${tmpRecordsSkipped}, errors: ${tmpRecordsErrored}`);
						if (pDownloadError)
						{
							this.fable.log.error(`Error returned URL Partial .. this may not be an error: ${pDownloadError}`);
						}

						// Store sync results on the entity so callers can inspect the breakdown
						this.syncResults = (
							{
								Created: tmpRecordsCreated,
								Skipped: tmpRecordsSkipped,
								Errors: tmpRecordsErrored,
								Deleted: 0,
								ServerRecordCount: tmpSyncState.Server.RecordCount,
								LocalRecordCount: tmpSyncState.Local.RecordCount,
								ServerMaxID: tmpSyncState.Server.MaxIDEntity,
								LocalMaxID: tmpSyncState.Local.MaxIDEntity,
								EstimatedNew: tmpSyncState.EstimatedRecordCount
							});

						fStageComplete();
					};

					if (this.UseAdvancedIDPagination)
					{
						// Advanced ID pagination: use keyset pagination (WHERE ID > lastMaxID)
						// instead of OFFSET to avoid progressive table scan slowdown on large datasets.
						let tmpLastMaxID = tmpSyncState.Local.MaxIDEntity;
						let tmpTotalFetched = 0;

						const fFetchPage = () =>
						{
							if (tmpTotalFetched >= tmpSyncState.RecordCap)
							{
								return fSyncComplete();
							}

							tmpPageIndex++;
							let tmpURL = `${this.EntitySchema.TableName}s/FilteredTo/FBV~${this.DefaultIdentifier}~GT~${tmpLastMaxID}~FSF~${this.DefaultIdentifier}~ASC~ASC/0/${this.PageSize}`;

							this.fable.MeadowCloneRestClient.getJSON(tmpURL,
								(pDownloadError, pResponse, pBody) =>
								{
									if (pDownloadError)
									{
										this.fable.log.error(`${this.EntitySchema.TableName}: page ${tmpPageIndex} download error: ${pDownloadError}`);
										return fSyncComplete(pDownloadError);
									}
									if (pBody && Array.isArray(pBody) && pBody.length > 0)
									{
										// Track the max ID from this page for the next page filter
										for (let r = 0; r < pBody.length; r++)
										{
											if (pBody[r][this.DefaultIdentifier] > tmpLastMaxID)
											{
												tmpLastMaxID = pBody[r][this.DefaultIdentifier];
											}
										}
										tmpTotalFetched += pBody.length;

										fProcessPageRecords(pBody, (pProcessError) =>
										{
											if (pProcessError)
											{
												return fSyncComplete(pProcessError);
											}
											return setImmediate(fFetchPage);
										});
									}
									else
									{
										// No more records
										return fSyncComplete();
									}
								});
						};
						fFetchPage();
					}
					else
					{
						// Standard offset-based pagination
						this.fable.Utility.eachLimit(tmpSyncState.URLPartials, 1,
							(pURLPartial, fDownloadComplete) =>
							{
								tmpPageIndex++;

								this.fable.MeadowCloneRestClient.getJSON(pURLPartial,
									(pDownloadError, pResponse, pBody) =>
									{
										if (pDownloadError)
										{
											this.fable.log.error(`${this.EntitySchema.TableName}: page ${tmpPageIndex} download error: ${pDownloadError}`);
											return fDownloadComplete();
										}
										if (pBody && Array.isArray(pBody) && pBody.length > 0)
										{
											fProcessPageRecords(pBody, fDownloadComplete);
										}
										else
										{
											if (Array.isArray(pBody) && pBody.length == 0)
											{
												return fDownloadComplete(new Error('Records depleted!'));
											}
											return fDownloadComplete();
										}
									});
							},
							fSyncComplete);
					}
				},
			],
			(pError) =>
			{
				if (pError)
				{
					this.fable.log.error(`${this.EntitySchema.TableName}: sync error: ${pError}`);
				}

				if (this.SyncDeletedRecords)
				{
					return this.syncDeletedRecords(() => { return fCallback(); });
				}

				return fCallback();
			});
	}
}

module.exports = MeadowSyncEntityInitial;
