const libFableServiceProviderBase = require('fable-serviceproviderbase');
const libMeadowSyncEntityInitial = require('./Meadow-Service-Sync-Entity-Initial.js');
const libMeadowSyncEntityOngoing = require('./Meadow-Service-Sync-Entity-Ongoing.js');
const libMeadowSyncEntityOngoingEventualConsistency = require('./Meadow-Service-Sync-Entity-OngoingEventualConsistency.js');
const libMeadowSyncEntityTrueUp = require('./Meadow-Service-Sync-Entity-TrueUp.js');
const libMeadowSyncEntityComparisonOnly = require('./Meadow-Service-Sync-Entity-ComparisonOnly.js');

class MeadowSync extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'MeadowSync';

		if (!this.fable.ServiceManager.servicesMap.hasOwnProperty('MeadowSyncEntityInitial'))
		{
			this.fable.ServiceManager.addServiceType('MeadowSyncEntityInitial', libMeadowSyncEntityInitial);
		}

		if (!this.fable.ServiceManager.servicesMap.hasOwnProperty('MeadowSyncEntityOngoing'))
		{
			this.fable.ServiceManager.addServiceType('MeadowSyncEntityOngoing', libMeadowSyncEntityOngoing);
		}

		if (!this.fable.ServiceManager.servicesMap.hasOwnProperty('MeadowSyncEntityOngoingEventualConsistency'))
		{
			this.fable.ServiceManager.addServiceType('MeadowSyncEntityOngoingEventualConsistency', libMeadowSyncEntityOngoingEventualConsistency);
		}

		if (!this.fable.ServiceManager.servicesMap.hasOwnProperty('MeadowSyncEntityTrueUp'))
		{
			this.fable.ServiceManager.addServiceType('MeadowSyncEntityTrueUp', libMeadowSyncEntityTrueUp);
		}

		if (!this.fable.ServiceManager.servicesMap.hasOwnProperty('MeadowSyncEntityComparisonOnly'))
		{
			this.fable.ServiceManager.addServiceType('MeadowSyncEntityComparisonOnly', libMeadowSyncEntityComparisonOnly);
		}

		// If this is empty, we will sync everything in the loaded Schema.
		// Otherwise, we will go through this list and sync them in this order.
		this.SyncEntityList = [];
		if (this.fable.ProgramConfiguration.hasOwnProperty('SyncEntityList') && Array.isArray(this.fable.ProgramConfiguration.SyncEntityList))
		{
			this.SyncEntityList = JSON.parse(JSON.stringify(this.fable.ProgramConfiguration.SyncEntityList));
		}
		else if (this.options.hasOwnProperty('SyncEntityList') && Array.isArray(this.options.SyncEntityList))
		{
			this.SyncEntityList = JSON.parse(JSON.stringify(this.options.SyncEntityList));
		}

		// Per-entity sync options.
		this.SyncEntityOptions = {};
		if (this.fable.ProgramConfiguration.hasOwnProperty('SyncEntityOptions') && typeof(this.fable.ProgramConfiguration.SyncEntityOptions) == 'object')
		{
			this.SyncEntityOptions = JSON.parse(JSON.stringify(this.fable.ProgramConfiguration.SyncEntityOptions));
		}
		else if (this.options.hasOwnProperty('SyncEntityOptions') && typeof(this.options.SyncEntityOptions) == 'object')
		{
			this.SyncEntityOptions = JSON.parse(JSON.stringify(this.options.SyncEntityOptions));
		}

		// When true, after syncing active records, also sync records marked Deleted=1 on the source.
		this.SyncDeletedRecords = false;
		if (this.fable.ProgramConfiguration.hasOwnProperty('SyncDeletedRecords'))
		{
			this.SyncDeletedRecords = !!this.fable.ProgramConfiguration.SyncDeletedRecords;
		}
		else if (this.options.hasOwnProperty('SyncDeletedRecords'))
		{
			this.SyncDeletedRecords = !!this.options.SyncDeletedRecords;
		}

		// When > 0, limit sync to at most this many records per entity.
		this.MaxRecordsPerEntity = 0;
		if (this.fable.ProgramConfiguration.hasOwnProperty('MaxRecordsPerEntity'))
		{
			this.MaxRecordsPerEntity = parseInt(this.fable.ProgramConfiguration.MaxRecordsPerEntity, 10) || 0;
		}
		else if (this.options.hasOwnProperty('MaxRecordsPerEntity'))
		{
			this.MaxRecordsPerEntity = parseInt(this.options.MaxRecordsPerEntity, 10) || 0;
		}

		// When true, use ID-based keyset pagination instead of OFFSET pagination.
		// This avoids table scans on large datasets by filtering WHERE ID > lastMaxID.
		this.UseAdvancedIDPagination = false;
		if (this.fable.ProgramConfiguration.hasOwnProperty('UseAdvancedIDPagination'))
		{
			this.UseAdvancedIDPagination = !!this.fable.ProgramConfiguration.UseAdvancedIDPagination;
		}
		else if (this.options.hasOwnProperty('UseAdvancedIDPagination'))
		{
			this.UseAdvancedIDPagination = !!this.options.UseAdvancedIDPagination;
		}

		// Tolerance window in milliseconds for cross-database timestamp precision differences.
		// Passed through to Ongoing sync entities for bisection date comparison.
		this.DateTimePrecisionMS = 1000;
		if (this.fable.ProgramConfiguration.hasOwnProperty('DateTimePrecisionMS'))
		{
			this.DateTimePrecisionMS = parseInt(this.fable.ProgramConfiguration.DateTimePrecisionMS, 10) || 1000;
		}
		else if (this.options.hasOwnProperty('DateTimePrecisionMS'))
		{
			this.DateTimePrecisionMS = parseInt(this.options.DateTimePrecisionMS, 10) || 1000;
		}

		// Optional query string appended to deleted record API requests for all entities.
		// Used to work around older APIs where FBV~Deleted~EQ~1 does not override the
		// automatic Deleted=0 filter (e.g. "includeDeleted=true").
		// Can be overridden per-entity via SyncEntityOptions.
		this.SyncDeletedRecordsQueryString = '';
		if (this.fable.ProgramConfiguration.hasOwnProperty('SyncDeletedRecordsQueryString'))
		{
			this.SyncDeletedRecordsQueryString = this.fable.ProgramConfiguration.SyncDeletedRecordsQueryString;
		}
		else if (this.options.hasOwnProperty('SyncDeletedRecordsQueryString'))
		{
			this.SyncDeletedRecordsQueryString = this.options.SyncDeletedRecordsQueryString;
		}

		// Milliseconds devoted to backwards bisection in OngoingEventualConsistency mode.
		this.BackSyncTimeLimit = 30000;
		if (this.fable.ProgramConfiguration.hasOwnProperty('BackSyncTimeLimit'))
		{
			this.BackSyncTimeLimit = parseInt(this.fable.ProgramConfiguration.BackSyncTimeLimit, 10) || 30000;
		}
		else if (this.options.hasOwnProperty('BackSyncTimeLimit'))
		{
			this.BackSyncTimeLimit = parseInt(this.options.BackSyncTimeLimit, 10) || 30000;
		}

		// Page size for the linear keyset-paginated walk in TrueUp mode.
		this.TrueUpPageSize = 500;
		if (this.fable.ProgramConfiguration.hasOwnProperty('TrueUpPageSize'))
		{
			this.TrueUpPageSize = parseInt(this.fable.ProgramConfiguration.TrueUpPageSize, 10) || 500;
		}
		else if (this.options.hasOwnProperty('TrueUpPageSize'))
		{
			this.TrueUpPageSize = parseInt(this.options.TrueUpPageSize, 10) || 500;
		}

		this.MeadowSchema = false;
		this.MeadowSchemaTableList = false;

		this.MeadowSyncEntities = {};

		this.SyncMode = 'Initial';

		this.fable._MeadowPrototype = require('meadow');
		this.fable.Meadow = this.fable._MeadowPrototype.new(this.fable, 'MeadowSync-Prototype');
	}

	loadMeadowSchema(pSchema, fCallback)
	{
		this.meadowSchema = pSchema;
		this.MeadowSchemaTableList = Object.keys(this.meadowSchema.Tables);

		this.log.info(`Loading schema for ${this.MeadowSchemaTableList.length} tables (mode: ${this.SyncMode})`);

		let tmpEntityIndex = 0;
		let tmpErrorCount = 0;
		let tmpSuccessCount = 0;

		this.fable.Utility.eachLimit(this.MeadowSchemaTableList, 5,
			(pEntitySchemaName, fSyncInitializationComplete) =>
			{
				tmpEntityIndex++;
				const tmpEntitySchema = this.meadowSchema.Tables[pEntitySchemaName];
				// If this is in the entity list or none is specified, create the sync entity object.
				if (this.SyncEntityList.length < 1 || this.SyncEntityList.indexOf(tmpEntitySchema.TableName) > -1)
				{
					const tmpSyncEntityOptions = {
						MeadowEntitySchema: tmpEntitySchema,
						ConnectionPool: this.options.ConnectionPool,
						PageSize: this.options.PageSize || 100,
						SyncDeletedRecords: this.SyncDeletedRecords,
						SyncDeletedRecordsQueryString: this.SyncDeletedRecordsQueryString,
						MaxRecordsPerEntity: this.MaxRecordsPerEntity,
						DateTimePrecisionMS: this.DateTimePrecisionMS,
						UseAdvancedIDPagination: this.UseAdvancedIDPagination,
						BackSyncTimeLimit: this.BackSyncTimeLimit,
						TrueUpPageSize: this.TrueUpPageSize,
						DeleteCursorStatePath: this.options.DeleteCursorStatePath,
						DeleteResweepIntervalHours: this.options.DeleteResweepIntervalHours,
					};

					// Apply per-entity option overrides if configured
					if (this.SyncEntityOptions.hasOwnProperty(tmpEntitySchema.TableName))
					{
						Object.assign(tmpSyncEntityOptions, this.SyncEntityOptions[tmpEntitySchema.TableName]);
					}

					let tmpSyncEntity;
					let tmpServiceTypeName;

					switch (this.SyncMode)
					{
						case 'Ongoing':
							tmpServiceTypeName = 'MeadowSyncEntityOngoing';
							break;
						case 'OngoingEventualConsistency':
							tmpServiceTypeName = 'MeadowSyncEntityOngoingEventualConsistency';
							break;
						case 'TrueUp':
							tmpServiceTypeName = 'MeadowSyncEntityTrueUp';
							break;
						case 'ComparisonOnly':
							tmpServiceTypeName = 'MeadowSyncEntityComparisonOnly';
							break;
						default:
							tmpServiceTypeName = 'MeadowSyncEntityInitial';
							break;
					}

					tmpSyncEntity = this.fable.serviceManager.instantiateServiceProvider(tmpServiceTypeName, tmpSyncEntityOptions, `SyncEntity-${tmpEntitySchema.TableName}`);

					this.MeadowSyncEntities[tmpEntitySchema.TableName] = tmpSyncEntity;

					return tmpSyncEntity.initialize((pInitError) =>
					{
						if (pInitError)
						{
							tmpErrorCount++;
							this.log.warn(`Failed to initialize ${tmpEntitySchema.TableName}: ${pInitError}`);
						}
						else
						{
							tmpSuccessCount++;
						}
						// Always continue to next entity regardless of individual errors
						return fSyncInitializationComplete();
					});
				}
				else
				{
					return fSyncInitializationComplete();
				}
			},
			(pSyncInitializationError) =>
			{
				if (pSyncInitializationError)
				{
					this.log.error(`MeadowSync Error creating sync objects: ${pSyncInitializationError}`, pSyncInitializationError);
				}

				this.log.info(`Entity sync objects created: ${tmpSuccessCount} succeeded, ${tmpErrorCount} failed.`);

				if (this.SyncEntityList.length < 1)
				{
					this.SyncEntityList = Object.keys(this.MeadowSyncEntities);
				}

				return fCallback(pSyncInitializationError);
			});
	}

	syncEntity(pEntityHash, fCallback)
	{
		if (!this.MeadowSyncEntities.hasOwnProperty(pEntityHash))
		{
			this.log.warn(`MeadowSync.syncEntity called for an entity that does not exist: ${pEntityHash}`);
			return fCallback();
		}

		this.MeadowSyncEntities[pEntityHash].sync((pError) =>
		{
			if (pError)
			{
				this.log.error(`Sync failed for ${pEntityHash}: ${pError}`);
			}
			return fCallback(pError);
		});
	}

	syncAll(fCallback)
	{
		this.fable.Utility.eachLimit(this.SyncEntityList, 1,
			(pEntityHash, fSyncEntityComplete) =>
			{
				this.syncEntity(pEntityHash, fSyncEntityComplete);
			},
			(pSyncError) =>
			{
				if (pSyncError)
				{
					this.log.error(`MeadowSync Error syncing entities: ${pSyncError}`, pSyncError);
				}
				this.log.info('Entity sync complete!');
				return fCallback(pSyncError);
			});
	}
}

module.exports = MeadowSync;
