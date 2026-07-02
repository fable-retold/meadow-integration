const libFableServiceProviderBase = require('fable-serviceproviderbase');

const defaultConnectionManagerOptions = (
	{
		Provider: 'MySQL',

		MySQL:
		{
			server: '127.0.0.1',
			port: 3306,
			user: 'root',
			password: '',
			database: 'meadow',
			connectionLimit: 20,
		},

		MSSQL:
		{
			server: '127.0.0.1',
			port: 1433,
			user: 'sa',
			password: '',
			database: 'meadow',
			ConnectionPoolLimit: 20,
		},
	});

class MeadowConnectionManager extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		const tmpOptions = Object.assign({}, defaultConnectionManagerOptions, pOptions);
		super(pFable, tmpOptions, pServiceHash);

		this.serviceType = 'MeadowConnectionManager';

		this.Provider = this.options.Provider;
		this.ConnectionPool = false;
		this._Connected = false;
	}

	get connected()
	{
		return this._Connected;
	}

	connect(fCallback)
	{
		switch (this.Provider)
		{
			case 'MySQL':
				return this._connectMySQL(fCallback);
			case 'MSSQL':
				return this._connectMSSQL(fCallback);
			default:
				return fCallback(new Error(`Unsupported database provider: ${this.Provider}`));
		}
	}

	_connectMySQL(fCallback)
	{
		try
		{
			const libMeadowConnectionMySQL = require('meadow-connection-mysql');
			const tmpConfig = Object.assign({}, this.options.MySQL);

			// meadow-mysql treats connectionLimit as a global setting
			if (tmpConfig.connectionLimit && typeof(this.fable.settings.connectionLimit) !== 'number')
			{
				this.fable.settings.connectionLimit = tmpConfig.connectionLimit;
			}

			// Apply MySQL settings to fable settings for meadow provider
			this.fable.settings.MySQL = tmpConfig;

			// Point the meadow ORM at this provider.  MeadowConnectionManager
			// connects the connector (fable.MeadowMSSQLProvider/MySQLProvider),
			// but the meadow instance built in Meadow-Service-Sync selects its
			// provider from fable.settings.MeadowProvider (default 'None').
			// Without this the ORM stays on the 'None' provider and createTable
			// (via provider.getProvider()) has nothing to call.  Set before the
			// sync service is instantiated so meadow picks it up.
			this.fable.settings.MeadowProvider = this.Provider;

			this.fable.serviceManager.addServiceType('MeadowMySQLProvider', libMeadowConnectionMySQL);
			this.fable.serviceManager.instantiateServiceProvider('MeadowMySQLProvider', tmpConfig);

			this.fable.MeadowMySQLProvider.connectAsync(
				(pError, pConnectionPool) =>
				{
					if (pError)
					{
						this.log.error(`Error connecting to MySQL: ${pError}`, pError);
						return fCallback(pError);
					}

					this.ConnectionPool = pConnectionPool;
					this._Connected = true;
					this.log.info('Connected to MySQL successfully.');
					return fCallback(null, pConnectionPool);
				});
		}
		catch (pError)
		{
			this.log.error(`Failed to load MySQL provider. Ensure meadow-connection-mysql is installed: ${pError.message}`);
			return fCallback(pError);
		}
	}

	_connectMSSQL(fCallback)
	{
		try
		{
			const libMeadowConnectionMSSQL = require('meadow-connection-mssql');
			const tmpConfig = Object.assign({}, this.options.MSSQL);

			// Apply MSSQL settings to fable settings for meadow provider
			this.fable.settings.MSSQL = tmpConfig;

			// Point the meadow ORM at this provider (see the MySQL branch for
			// the full rationale) — without it the ORM stays on 'None' and
			// createTable has no underlying connector to call.
			this.fable.settings.MeadowProvider = this.Provider;

			this.fable.serviceManager.addServiceType('MeadowMSSQLProvider', libMeadowConnectionMSSQL);
			this.fable.serviceManager.instantiateServiceProvider('MeadowMSSQLProvider', tmpConfig);

			this.fable.MeadowMSSQLProvider.connectAsync(
				(pError, pConnectionPool) =>
				{
					if (pError)
					{
						this.log.error(`Error connecting to MSSQL: ${pError}`, pError);
						return fCallback(pError);
					}

					this.ConnectionPool = pConnectionPool;
					this._Connected = true;
					this.log.info('Connected to MSSQL successfully.');
					return fCallback(null, pConnectionPool);
				});
		}
		catch (pError)
		{
			this.log.error(`Failed to load MSSQL provider. Ensure meadow-connection-mssql is installed: ${pError.message}`);
			return fCallback(pError);
		}
	}

	createIndex(pEntitySchema, pColumn, pIsUnique, fCallback)
	{
		switch (this.Provider)
		{
			case 'MySQL':
				return this._createMySQLIndex(pEntitySchema, pColumn, pIsUnique, fCallback);
			case 'MSSQL':
				return this._createMSSQLIndex(pEntitySchema, pColumn, pIsUnique, fCallback);
			default:
				return fCallback();
		}
	}

	_createMySQLIndex(pEntitySchema, pColumn, pIsUnique, fCallback)
	{
		if (!this.ConnectionPool)
		{
			this.log.error(`No connection pool available; skipping index creation for ${pEntitySchema.TableName}`);
			return fCallback();
		}

		const tmpTableName = pEntitySchema.TableName;

		if (!pColumn || (typeof(pColumn) != 'object') || !pColumn.hasOwnProperty('Column') || (typeof(pColumn.Column) != 'string') || (pColumn.Column.length < 1))
		{
			this.log.error(`No column information passed to createIndex for ${tmpTableName}; skipping index creation`);
			return fCallback();
		}

		const tmpColumnName = pColumn.Column;
		const tmpIndexName = `AK_${tmpTableName}_${tmpColumnName}`;
		const tmpIndexIsUnique = (typeof(pIsUnique) == 'boolean') ? pIsUnique : false;
		const tmpCheckIndexSQL = `
 SELECT COUNT(1) AS IndexCount FROM INFORMATION_SCHEMA.STATISTICS
	WHERE
		table_name = '${tmpTableName}'
		AND index_name='${tmpIndexName}'
		AND table_schema = DATABASE()
`;
		this.ConnectionPool.query(tmpCheckIndexSQL,
			(pError, pResult) =>
			{
				if (pError)
				{
					this.log.error(`Error checking for existing index ${tmpIndexName} on ${tmpTableName}:`, pError);
					return fCallback(pError);
				}

				const tmpIndexExists = pResult[0].IndexCount > 0;
				if (tmpIndexExists)
				{
					this.log.info(`Index ${tmpIndexName} already exists on ${tmpTableName}; skipping creation.`);
					return fCallback();
				}

				let tmpCreateIndexSQL = `CREATE `;
				if (tmpIndexIsUnique)
				{
					tmpCreateIndexSQL += `UNIQUE `;
				}
				tmpCreateIndexSQL += `INDEX ${tmpIndexName} ON ${tmpTableName} (${tmpColumnName})`;
				this.ConnectionPool.query(tmpCreateIndexSQL,
					(pCreateIndexError) =>
					{
						if (pCreateIndexError && pCreateIndexError.code !== 'ER_DUP_KEYNAME')
						{
							this.log.error(`Error creating index ${tmpIndexName} on ${tmpTableName}:`, pCreateIndexError);
							return fCallback(pCreateIndexError);
						}
						this.log.info(`Index ${tmpIndexName} created on ${tmpTableName}.`);
						return fCallback();
					});
			});
	}

	_createMSSQLIndex(pEntitySchema, pColumn, pIsUnique, fCallback)
	{
		if (!this.ConnectionPool)
		{
			this.log.error(`No connection pool available; skipping index creation for ${pEntitySchema.TableName}`);
			return fCallback();
		}

		const tmpTableName = pEntitySchema.TableName;

		if (!pColumn || (typeof(pColumn) != 'object') || !pColumn.hasOwnProperty('Column') || (typeof(pColumn.Column) != 'string') || (pColumn.Column.length < 1))
		{
			this.log.error(`No column information passed to createIndex for ${tmpTableName}; skipping index creation`);
			return fCallback();
		}

		const tmpColumnName = pColumn.Column;
		const tmpIndexSQL = `
			IF NOT EXISTS(SELECT * FROM sys.indexes WHERE name = '${tmpColumnName}' AND object_id = OBJECT_ID('${tmpTableName}'))
			BEGIN
				CREATE INDEX [${tmpColumnName}] ON [dbo].[${tmpTableName}] ([${tmpColumnName}])
			END;
		`;

		this.ConnectionPool.query(tmpIndexSQL)
			.then(() =>
			{
				this.log.info(`Index ${tmpColumnName} created on ${tmpTableName}.`);
				return fCallback();
			})
			.catch((pError) =>
			{
				this.log.error(`Error creating index for ${tmpTableName}: ${pError.message}`, { Error: pError });
				return fCallback();
			});
	}
}

module.exports = MeadowConnectionManager;

module.exports.default_configuration = defaultConnectionManagerOptions;
