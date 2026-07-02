const libCLICommandLineCommand = require('pict-service-commandlineutility').ServiceCommandLineCommand;

const libFs = require('fs');
const libPath = require('path');

const libMeadowConnectionManager = require('../../services/clone/Meadow-Service-ConnectionManager.js');
const libMeadowCloneRestClient = require('../../services/clone/Meadow-Service-RestClient.js');
const libMeadowSync = require('../../services/clone/Meadow-Service-Sync.js');
const libSessionManagerSetup = require('../../Meadow-Integration-SessionManagerSetup.js');
const libIndexPolicy = require('../../services/clone/Meadow-Service-IndexPolicy.js');
const libIndexConvergence = require('../../services/clone/Meadow-Service-IndexConvergence.js');

// Resolve an env var with the standard `_FILE` suffix fallback for
// secrets — so docker / k8s secret mounts work without bespoke wiring.
// Returns undefined when neither the var nor its `_FILE` companion is
// set; existing JSON-config + CLI-override layers then take effect
// unchanged.
function _envOrFile(pVarName)
{
	let tmpValue = process.env[pVarName];
	if (tmpValue !== undefined && tmpValue !== '')
	{
		return tmpValue;
	}
	let tmpFilePath = process.env[pVarName + '_FILE'];
	if (tmpFilePath)
	{
		try
		{
			return libFs.readFileSync(tmpFilePath, 'utf8').replace(/\s+$/, '');
		}
		catch (pErr)
		{
			// Soft fail — fall through to undefined so the config-file
			// layer (or CLI flag) still has a chance.
			console.warn(`Meadow-Integration: ${pVarName}_FILE=${tmpFilePath} unreadable: ${pErr.message}`);
		}
	}
	return undefined;
}

class DataClone extends libCLICommandLineCommand
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.options.CommandKeyword = 'data-clone';
		this.options.Description = 'Clone data from a Meadow API source to a local database.';
		this.options.Aliases.push('clone');
		this.options.Aliases.push('sync');

		this.options.CommandOptions.push({ Name: '-a, --api_server [api_server]', Description: 'The source API server URL.' });
		this.options.CommandOptions.push({ Name: '-u, --api_username [api_username]', Description: 'The API username to authenticate with.' });
		this.options.CommandOptions.push({ Name: '-p, --api_password [api_password]', Description: 'The API password to authenticate with.' });

		this.options.CommandOptions.push({ Name: '-d, --db_provider [db_provider]', Description: 'The database provider (MySQL or MSSQL). Default is MySQL.', DefaultValue: 'MySQL' });
		this.options.CommandOptions.push({ Name: '--db_host [db_host]', Description: 'The database host address.' });
		this.options.CommandOptions.push({ Name: '--db_port [db_port]', Description: 'The database port.' });
		this.options.CommandOptions.push({ Name: '--db_username [db_username]', Description: 'The database username.' });
		this.options.CommandOptions.push({ Name: '--db_password [db_password]', Description: 'The database password.' });
		this.options.CommandOptions.push({ Name: '--db_name [db_name]', Description: 'The database name.' });

		this.options.CommandOptions.push({ Name: '--schema_path [schema_path]', Description: 'Path to the Meadow extended schema JSON file.' });

		this.options.CommandOptions.push({ Name: '-s, --sync_mode [sync_mode]', Description: 'The sync mode: "Initial" or "Ongoing". Default is "Initial".', DefaultValue: 'Initial' });

		this.options.CommandOptions.push({ Name: '-w, --post_run_delay [post_run_delay]', Description: 'Minutes to wait after sync before exiting. Default is 0.', DefaultValue: '0' });

		this.options.CommandOptions.push({ Name: '--index_config [index_config]', Description: 'Converge clone indexes before syncing. "all" applies the standard operational indexes to every table; or pass a path to a JSON index-policy file ({ StandardOperationalIndexes, PruneScope, TableIndexes }). Omit to leave indexes untouched.' });

		this.addCommand();
	}

	_resolveConfig()
	{
		const tmpConfig = JSON.parse(JSON.stringify(this.fable.ProgramConfiguration));

		// Layer 1: env vars (overlay on top of the config-file values).
		// Layer 2 (CLI flags) below still wins — keeps the existing
		// precedence intact for standalone CLI users.
		this._applyEnvOverrides(tmpConfig);

		// Apply command-line overrides for Source (API)
		if (!tmpConfig.Source)
		{
			tmpConfig.Source = {};
		}
		if (this.CommandOptions.api_server)
		{
			tmpConfig.Source.ServerURL = this.CommandOptions.api_server;
		}
		if (this.CommandOptions.api_username)
		{
			tmpConfig.Source.UserID = this.CommandOptions.api_username;
		}
		if (this.CommandOptions.api_password)
		{
			tmpConfig.Source.Password = this.CommandOptions.api_password;
		}

		// Apply command-line overrides for Destination (Database)
		if (!tmpConfig.Destination)
		{
			tmpConfig.Destination = {};
		}
		if (this.CommandOptions.db_provider)
		{
			tmpConfig.Destination.Provider = this.CommandOptions.db_provider;
		}
		if (!tmpConfig.Destination.Provider)
		{
			tmpConfig.Destination.Provider = 'MySQL';
		}

		const tmpProvider = tmpConfig.Destination.Provider;
		if (!tmpConfig.Destination[tmpProvider])
		{
			tmpConfig.Destination[tmpProvider] = {};
		}
		if (this.CommandOptions.db_host)
		{
			tmpConfig.Destination[tmpProvider].server = this.CommandOptions.db_host;
		}
		if (this.CommandOptions.db_port)
		{
			tmpConfig.Destination[tmpProvider].port = parseInt(this.CommandOptions.db_port);
		}
		if (this.CommandOptions.db_username)
		{
			tmpConfig.Destination[tmpProvider].user = this.CommandOptions.db_username;
		}
		if (this.CommandOptions.db_password)
		{
			tmpConfig.Destination[tmpProvider].password = this.CommandOptions.db_password;
		}
		if (this.CommandOptions.db_name)
		{
			tmpConfig.Destination[tmpProvider].database = this.CommandOptions.db_name;
		}

		// Schema path override
		if (this.CommandOptions.schema_path)
		{
			tmpConfig.SchemaPath = this.CommandOptions.schema_path;
		}

		// Final fallback: a bundled sample schema ships with the
		// package at <pkg>/schema/default.json (BookStore reference
		// model). Lets containerized launches succeed out of the box
		// even when no SchemaPath is configured, so operators get a
		// "yes it ran" smoke test before wiring their real schema.
		if (!tmpConfig.SchemaPath)
		{
			let tmpBundled = libPath.resolve(__dirname, '..', '..', '..', 'schema', 'default.json');
			if (libFs.existsSync(tmpBundled))
			{
				tmpConfig.SchemaPath = tmpBundled;
				this.log.info(`No SchemaPath configured; falling back to bundled default at ${tmpBundled}`);
			}
		}

		// Sync config
		if (!tmpConfig.Sync)
		{
			tmpConfig.Sync = {};
		}

		return tmpConfig;
	}

	// Overlay MEADOW_INTEGRATION_* env vars onto the config object in
	// place. Mutates pConfig; called between the config-file load and
	// the CLI-override pass so the layering stays predictable
	// (CLI > env > file > defaults). Honors the `_FILE` suffix on
	// secret-bearing keys.
	_applyEnvOverrides(pConfig)
	{
		// Source (API) ----------------------------------------------
		let tmpApiServer = _envOrFile('MEADOW_INTEGRATION_API_SERVER');
		let tmpApiUser   = _envOrFile('MEADOW_INTEGRATION_API_USERNAME');
		let tmpApiPass   = _envOrFile('MEADOW_INTEGRATION_API_PASSWORD');
		if (tmpApiServer || tmpApiUser || tmpApiPass)
		{
			if (!pConfig.Source) { pConfig.Source = {}; }
			if (tmpApiServer) { pConfig.Source.ServerURL = tmpApiServer; }
			if (tmpApiUser)   { pConfig.Source.UserID    = tmpApiUser; }
			if (tmpApiPass)   { pConfig.Source.Password  = tmpApiPass; }
		}

		// Destination (Database) ------------------------------------
		let tmpDbProvider = _envOrFile('MEADOW_INTEGRATION_DB_PROVIDER');
		let tmpDbHost     = _envOrFile('MEADOW_INTEGRATION_DB_HOST');
		let tmpDbPort     = _envOrFile('MEADOW_INTEGRATION_DB_PORT');
		let tmpDbUser     = _envOrFile('MEADOW_INTEGRATION_DB_USERNAME');
		let tmpDbPass     = _envOrFile('MEADOW_INTEGRATION_DB_PASSWORD');
		let tmpDbName     = _envOrFile('MEADOW_INTEGRATION_DB_NAME');
		let tmpHasDb = tmpDbProvider || tmpDbHost || tmpDbPort || tmpDbUser || tmpDbPass || tmpDbName;
		if (tmpHasDb)
		{
			if (!pConfig.Destination) { pConfig.Destination = {}; }
			if (tmpDbProvider) { pConfig.Destination.Provider = tmpDbProvider; }
			let tmpProviderKey = pConfig.Destination.Provider || 'MySQL';
			if (!pConfig.Destination[tmpProviderKey]) { pConfig.Destination[tmpProviderKey] = {}; }
			let tmpProviderCfg = pConfig.Destination[tmpProviderKey];
			if (tmpDbHost) { tmpProviderCfg.server   = tmpDbHost; }
			if (tmpDbPort) { tmpProviderCfg.port     = parseInt(tmpDbPort, 10); }
			if (tmpDbUser) { tmpProviderCfg.user     = tmpDbUser; }
			if (tmpDbPass) { tmpProviderCfg.password = tmpDbPass; }
			if (tmpDbName) { tmpProviderCfg.database = tmpDbName; }
		}

		// Schema path -----------------------------------------------
		let tmpSchemaPath = _envOrFile('MEADOW_INTEGRATION_SCHEMA_PATH');
		if (tmpSchemaPath) { pConfig.SchemaPath = tmpSchemaPath; }
	}

	onRunAsync(fCallback)
	{
		const tmpConfig = this._resolveConfig();

		// Validate required configuration
		if (!tmpConfig.Source || !tmpConfig.Source.ServerURL)
		{
			this.log.error('No source API server URL configured. Set Source.ServerURL in .meadow.config.json or use --api_server.');
			return fCallback(new Error('Missing Source.ServerURL configuration.'));
		}
		if (!tmpConfig.SchemaPath)
		{
			this.log.error('No schema path configured. Set SchemaPath in .meadow.config.json or use --schema_path.');
			return fCallback(new Error('Missing SchemaPath configuration.'));
		}

		const tmpProvider = tmpConfig.Destination.Provider;
		const tmpDbConfig = tmpConfig.Destination[tmpProvider];
		if (!tmpDbConfig || !tmpDbConfig.server || !tmpDbConfig.database)
		{
			this.log.error(`Database configuration incomplete for provider ${tmpProvider}. Set Destination.${tmpProvider} in .meadow.config.json or use --db_host/--db_name.`);
			return fCallback(new Error(`Missing ${tmpProvider} database configuration.`));
		}

		this.log.info(`Data Clone: ${tmpProvider} database [${tmpDbConfig.database}] from [${tmpConfig.Source.ServerURL}]`);

		// Load schema
		let tmpSchemaModel;
		try
		{
			const tmpSchemaPath = libPath.resolve(tmpConfig.SchemaPath);
			this.log.info(`Loading schema from ${tmpSchemaPath}...`);
			tmpSchemaModel = require(tmpSchemaPath);
		}
		catch (pError)
		{
			this.log.error(`Error loading schema from ${tmpConfig.SchemaPath}: ${pError.message}`);
			return fCallback(pError);
		}

		// Register and instantiate services
		this.fable.serviceManager.addServiceType('MeadowCloneRestClient', libMeadowCloneRestClient);
		this.fable.serviceManager.instantiateServiceProvider('MeadowCloneRestClient', tmpConfig.Source);

		this.fable.serviceManager.addServiceType('MeadowConnectionManager', libMeadowConnectionManager);
		this.fable.serviceManager.instantiateServiceProvider('MeadowConnectionManager', tmpConfig.Destination);

		this.fable.serviceManager.addServiceType('MeadowSync', libMeadowSync);

		// Initialize SessionManager if configured
		let tmpSessionManager = libSessionManagerSetup.initializeSessionManager(this.fable, tmpConfig.SessionManager);
		if (tmpSessionManager)
		{
			// Connect SessionManager to the clone RestClient so credentials are auto-injected
			libSessionManagerSetup.connectSessionManagerToRestClient(this.fable, this.fable.MeadowCloneRestClient.restClient);
		}

		this.fable.Utility.waterfall(
			[
				(fStageComplete) =>
				{
					// Authenticate SessionManager sessions (if configured)
					if (tmpSessionManager)
					{
						this.log.info('Authenticating SessionManager sessions...');
						libSessionManagerSetup.authenticateSessions(this.fable,
							(pError) =>
							{
								if (pError)
								{
									this.log.error('Error authenticating SessionManager sessions.', pError);
								}
								return fStageComplete();
							});
					}
					else
					{
						return fStageComplete();
					}
				},
				(fStageComplete) =>
				{
					// Authenticate with the source API using built-in credentials
					if (tmpConfig.Source.UserID && tmpConfig.Source.Password)
					{
						this.log.info('Authenticating with source API...');
						this.fable.MeadowCloneRestClient.authenticate(
							(pError, pResponse) =>
							{
								if (pError)
								{
									this.log.error('Error authenticating with source API.', pError);
								}
								else
								{
									this.log.info(`Authenticated with source API as [${tmpConfig.Source.UserID}] at [${tmpConfig.Source.ServerURL}]`);
								}
								return fStageComplete();
							});
					}
					else
					{
						this.log.info('No Source credentials configured; skipping built-in authentication.');
						return fStageComplete();
					}
				},
				(fStageComplete) =>
				{
					// Connect to database
					this.log.info(`Connecting to ${tmpProvider}...`);
					this.fable.MeadowConnectionManager.connect(
						(pError, pConnectionPool) =>
						{
							if (pError)
							{
								this.log.error(`Error connecting to ${tmpProvider}: ${pError}`, pError);
								return fStageComplete(pError);
							}
							return fStageComplete(null, pConnectionPool);
						});
				},
				(pConnectionPool, fStageComplete) =>
				{
					// Construct and configure the sync service
					const tmpSyncConfig = Object.assign(
						{
							ConnectionPool: pConnectionPool,
							PageSize: tmpConfig.Sync.PageSize || 100,
						},
						tmpConfig.Sync);

					this.fable.serviceManager.instantiateServiceProvider('MeadowSync', tmpSyncConfig, 'SyncService');

					const tmpSyncMode = this.CommandOptions.sync_mode || tmpConfig.Sync.DefaultSyncMode || 'Initial';
					switch (tmpSyncMode)
					{
						case 'Ongoing':
							this.fable.MeadowSync.SyncMode = 'Ongoing';
							break;
						case 'Initial':
						default:
							this.fable.MeadowSync.SyncMode = 'Initial';
							break;
					}

					this.log.info(`Sync mode: ${this.fable.MeadowSync.SyncMode}`);

					// Load the schema
					this.fable.MeadowSync.loadMeadowSchema(tmpSchemaModel,
						(pLoadSchemaError) =>
						{
							if (pLoadSchemaError)
							{
								this.log.error(`Error loading schema: ${pLoadSchemaError}`, pLoadSchemaError);
								return fStageComplete(pLoadSchemaError);
							}

							this.log.info(`${this.fable.MeadowSync.SyncEntityList.length} schema(s) loaded successfully.`);
							return fStageComplete();
						});
				},
				(fStageComplete) =>
				{
					// Converge indexes to the policy before syncing (opt-in via --index_config).
					this._convergeIndexes(tmpSchemaModel, fStageComplete);
				},
				(fStageComplete) =>
				{
					// Execute the sync
					this.fable.MeadowSync.syncAll(
						(pSyncError) =>
						{
							if (pSyncError)
							{
								this.log.error(`Error syncing: ${pSyncError}`, pSyncError);
								return fStageComplete(pSyncError);
							}
							this.log.info('Sync complete.');
							return fStageComplete();
						});
				},
			],
			(pError) =>
			{
				const tmpPostRunDelay = parseInt(this.CommandOptions.post_run_delay) || 0;
				if (tmpPostRunDelay > 0)
				{
					this.log.info(`Waiting ${tmpPostRunDelay} minutes before exiting...`);
				}
				setTimeout(() =>
				{
					fCallback(pError);
					setTimeout(() =>
					{
						process.exit(pError ? 1 : 0);
					}, 10000);
				}, tmpPostRunDelay * 60 * 1000);
			});
	}

	/**
	 * Converge the clone's indexes to the configured policy before syncing.
	 * Opt-in via --index_config: "all" applies the standard operational indexes
	 * to every table; a path loads a JSON index-policy file.  Uses the same
	 * IndexPolicy + IndexConvergence the headless DataCloner pipeline uses.
	 *
	 * @param {object} pSchemaModel - loaded Meadow schema ({ Tables: {...} })
	 * @param {Function} fCallback
	 */
	_convergeIndexes(pSchemaModel, fCallback)
	{
		let tmpIndexConfigArg = this.CommandOptions.index_config;
		if (!tmpIndexConfigArg)
		{
			return fCallback();
		}

		let tmpIndexConfig;
		if (String(tmpIndexConfigArg).toLowerCase() === 'all')
		{
			tmpIndexConfig = { StandardOperationalIndexes: true, PruneScope: 'managed' };
		}
		else
		{
			try
			{
				tmpIndexConfig = require(libPath.resolve(tmpIndexConfigArg));
			}
			catch (pReadError)
			{
				this.log.error(`Could not load --index_config ${tmpIndexConfigArg}: ${pReadError.message}`);
				return fCallback();
			}
		}

		let tmpProviderName = this.fable.MeadowConnectionManager && this.fable.MeadowConnectionManager.Provider;
		let tmpProvider = tmpProviderName ? this.fable[`Meadow${tmpProviderName}Provider`] : null;
		if (!tmpProvider || typeof(tmpProvider.introspectTableIndices) !== 'function')
		{
			this.log.warn(`Index convergence requested but provider '${tmpProviderName || '(unknown)'}' does not expose the index API; skipping.`);
			return fCallback();
		}

		let tmpTables = (pSchemaModel && pSchemaModel.Tables) ? pSchemaModel.Tables : {};
		// Converge only the tables actually deployed — respect SyncEntityList (a
		// subset clone) so we never introspect/converge a table that was never
		// created.  Mirrors loadMeadowSchema's filter and the headless endpoint's
		// "deployed tables only" scope.  Empty list = all tables in the schema.
		let tmpSyncList = (this.fable.MeadowSync && Array.isArray(this.fable.MeadowSync.SyncEntityList)) ? this.fable.MeadowSync.SyncEntityList : [];
		let tmpTableNames = (tmpSyncList.length > 0)
			? tmpSyncList.filter((pName) => { return tmpTables[pName]; })
			: Object.keys(tmpTables);
		let tmpPruneScope = tmpIndexConfig.PruneScope || libIndexConvergence.PRUNE_MANAGED;

		this.log.info(`Converging indexes for ${tmpTableNames.length} deployed table(s) (prune scope: ${tmpPruneScope})...`);

		this.fable.Utility.eachLimit(tmpTableNames, 1,
			(pTableName, fNextTable) =>
			{
				let tmpTableSchema = tmpTables[pTableName];
				let tmpDesired = libIndexPolicy.resolveDesiredIndexes(tmpTableSchema, tmpIndexConfig);
				libIndexConvergence.convergeTableIndexes(tmpProvider, tmpTableSchema, tmpDesired,
					{ PruneScope: tmpPruneScope, log: this.log },
					(pConvergeError, pResult) =>
					{
						if (pConvergeError)
						{
							this.log.warn(`Index convergence for ${pTableName} failed: ${pConvergeError}`);
						}
						else if (pResult && (pResult.created.length > 0 || pResult.dropped.length > 0))
						{
							this.log.info(`${pTableName} — created [${pResult.created.join(', ')}], dropped [${pResult.dropped.join(', ')}]`);
						}
						return fNextTable();
					});
			},
			() => { return fCallback(); });
	}
}

module.exports = DataClone;
