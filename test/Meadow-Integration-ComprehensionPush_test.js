/*
	Integration tests for Comprehension Push via Integration Adapter

	Starts a retold-harness server backed by SQLite (in-memory), generates
	random Book data with fable's DataGeneration service, pushes a
	comprehension through the Integration Adapter, then reads the records
	back from the API to verify they were created.
*/

const Chai = require('chai');
const Expect = Chai.expect;

const libPath = require('path');
const libFable = require('fable');
const libMeadowConnectionSQLite = require('meadow-connection-sqlite');
const libRetoldDataService = require('retold-data-service');

const libIntegrationAdapter = require('../source/Meadow-Service-Integration-Adapter.js');
const libGUIDMap = require('../source/Meadow-Service-Integration-GUIDMap.js');
const libRestClient = require('../source/services/clone/Meadow-Service-RestClient.js');

// Use a unique port to avoid collisions with other test suites
const _APIServerPort = 19876;
const _ServerURL = `http://localhost:${_APIServerPort}/1.0/`;

let _Fable;
let _RetoldDataService;

suite
(
	'Comprehension Push – Random Books',
	function ()
	{
		suiteSetup
		(
			function (fDone)
			{
				this.timeout(15000);

				let tmpSettings = {
					Product: 'MeadowIntegrationPushTest',
					ProductVersion: '1.0.0',
					APIServerPort: _APIServerPort,
					SQLite:
					{
						SQLiteFilePath: ':memory:'
					},
					LogStreams:
					[
						{
							streamtype: 'console',
							level: 'fatal'
						}
					]
				};

				_Fable = new libFable(tmpSettings);

				// ---- SQLite provider ----
				_Fable.serviceManager.addServiceType('MeadowSQLiteProvider', libMeadowConnectionSQLite);
				_Fable.serviceManager.instantiateServiceProvider('MeadowSQLiteProvider');

				_Fable.MeadowSQLiteProvider.connectAsync(
					(pError) =>
					{
						if (pError)
						{
							return fDone(pError);
						}

						let tmpDB = _Fable.MeadowSQLiteProvider.db;

						// Create only the tables we need for this test
						tmpDB.exec(`
							CREATE TABLE IF NOT EXISTS User (
								IDUser INTEGER PRIMARY KEY AUTOINCREMENT,
								GUIDUser INTEGER DEFAULT 0,
								LoginID TEXT DEFAULT '',
								Password TEXT DEFAULT '',
								NameFirst TEXT DEFAULT '',
								NameLast TEXT DEFAULT '',
								FullName TEXT DEFAULT '',
								Config TEXT DEFAULT '',
								IDCustomer INTEGER DEFAULT 0,
								Email TEXT DEFAULT '',
								Phone TEXT DEFAULT '',
								Address TEXT DEFAULT '',
								City TEXT DEFAULT '',
								State TEXT DEFAULT '',
								Postal TEXT DEFAULT '',
								Country TEXT DEFAULT ''
							);
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
								ISBN TEXT DEFAULT '',
								Language TEXT DEFAULT '',
								ImageURL TEXT DEFAULT '',
								PublicationYear INTEGER DEFAULT 0,
								IDCustomer INTEGER DEFAULT 0
							);
							CREATE TABLE IF NOT EXISTS BookAuthorJoin (
								IDBookAuthorJoin INTEGER PRIMARY KEY AUTOINCREMENT,
								GUIDBookAuthorJoin TEXT DEFAULT '',
								IDBook INTEGER DEFAULT 0,
								IDAuthor INTEGER DEFAULT 0,
								IDCustomer INTEGER DEFAULT 0
							);
							CREATE TABLE IF NOT EXISTS Author (
								IDAuthor INTEGER PRIMARY KEY AUTOINCREMENT,
								GUIDAuthor TEXT DEFAULT '',
								CreateDate TEXT DEFAULT '',
								CreatingIDUser INTEGER DEFAULT 0,
								UpdateDate TEXT DEFAULT '',
								UpdatingIDUser INTEGER DEFAULT 0,
								Deleted INTEGER DEFAULT 0,
								DeleteDate TEXT DEFAULT '',
								DeletingIDUser INTEGER DEFAULT 0,
								Name TEXT DEFAULT '',
								IDUser INTEGER DEFAULT 0,
								IDCustomer INTEGER DEFAULT 0
							);
							CREATE TABLE IF NOT EXISTS BookPrice (
								IDBookPrice INTEGER PRIMARY KEY AUTOINCREMENT,
								GUIDBookPrice TEXT DEFAULT '',
								CreateDate TEXT DEFAULT '',
								CreatingIDUser INTEGER DEFAULT 0,
								UpdateDate TEXT DEFAULT '',
								UpdatingIDUser INTEGER DEFAULT 0,
								Deleted INTEGER DEFAULT 0,
								DeleteDate TEXT DEFAULT '',
								DeletingIDUser INTEGER DEFAULT 0,
								Price REAL DEFAULT 0,
								StartDate TEXT DEFAULT '',
								EndDate TEXT DEFAULT '',
								Discountable INTEGER DEFAULT 0,
								CouponCode TEXT DEFAULT '',
								IDBook INTEGER DEFAULT 0,
								IDCustomer INTEGER DEFAULT 0
							);
							CREATE TABLE IF NOT EXISTS BookStore (
								IDBookStore INTEGER PRIMARY KEY AUTOINCREMENT,
								GUIDBookStore TEXT DEFAULT '',
								CreateDate TEXT DEFAULT '',
								CreatingIDUser INTEGER DEFAULT 0,
								UpdateDate TEXT DEFAULT '',
								UpdatingIDUser INTEGER DEFAULT 0,
								Deleted INTEGER DEFAULT 0,
								DeleteDate TEXT DEFAULT '',
								DeletingIDUser INTEGER DEFAULT 0,
								Name TEXT DEFAULT '',
								Address TEXT DEFAULT '',
								City TEXT DEFAULT '',
								State TEXT DEFAULT '',
								Postal TEXT DEFAULT '',
								Country TEXT DEFAULT '',
								IDCustomer INTEGER DEFAULT 0,
								StoreType TEXT DEFAULT '',
								Phone TEXT DEFAULT '',
								Email TEXT DEFAULT ''
							);
							CREATE TABLE IF NOT EXISTS BookStoreInventory (
								IDBookStoreInventory INTEGER PRIMARY KEY AUTOINCREMENT,
								GUIDBookStoreInventory TEXT DEFAULT '',
								CreateDate TEXT DEFAULT '',
								CreatingIDUser INTEGER DEFAULT 0,
								UpdateDate TEXT DEFAULT '',
								UpdatingIDUser INTEGER DEFAULT 0,
								Deleted INTEGER DEFAULT 0,
								DeleteDate TEXT DEFAULT '',
								DeletingIDUser INTEGER DEFAULT 0,
								StockDate TEXT DEFAULT '',
								BookCount INTEGER DEFAULT 0,
								AggregateBookCount INTEGER DEFAULT 0,
								IDBook INTEGER DEFAULT 0,
								IDBookStore INTEGER DEFAULT 0,
								IDBookPrice INTEGER DEFAULT 0,
								StockingAssociate INTEGER DEFAULT 0,
								IDCustomer INTEGER DEFAULT 0
							);
							CREATE TABLE IF NOT EXISTS Review (
								IDReview INTEGER PRIMARY KEY AUTOINCREMENT,
								GUIDReview TEXT DEFAULT '',
								CreateDate TEXT DEFAULT '',
								CreatingIDUser INTEGER DEFAULT 0,
								UpdateDate TEXT DEFAULT '',
								UpdatingIDUser INTEGER DEFAULT 0,
								Deleted INTEGER DEFAULT 0,
								DeleteDate TEXT DEFAULT '',
								DeletingIDUser INTEGER DEFAULT 0,
								Text TEXT DEFAULT '',
								Rating INTEGER DEFAULT 0,
								IDBook INTEGER DEFAULT 0,
								IDUser INTEGER DEFAULT 0,
								IDCustomer INTEGER DEFAULT 0
							);
							CREATE TABLE IF NOT EXISTS Customer (
								IDCustomer INTEGER PRIMARY KEY AUTOINCREMENT,
								GUIDCustomer TEXT DEFAULT '',
								CreateDate TEXT DEFAULT '',
								CreatingIDUser INTEGER DEFAULT 0,
								UpdateDate TEXT DEFAULT '',
								UpdatingIDUser INTEGER DEFAULT 0,
								Deleted INTEGER DEFAULT 0,
								DeleteDate TEXT DEFAULT '',
								DeletingIDUser INTEGER DEFAULT 0,
								Name TEXT DEFAULT '',
								Description TEXT DEFAULT '',
								ContactName TEXT DEFAULT '',
								ContactEmail TEXT DEFAULT '',
								ContactPhone TEXT DEFAULT '',
								Address TEXT DEFAULT '',
								City TEXT DEFAULT '',
								State TEXT DEFAULT '',
								Postal TEXT DEFAULT '',
								Country TEXT DEFAULT '',
								Active INTEGER DEFAULT 0
							);
							CREATE TABLE IF NOT EXISTS BookStoreEmployee (
								IDBookStoreEmployee INTEGER PRIMARY KEY AUTOINCREMENT,
								GUIDBookStoreEmployee TEXT DEFAULT '',
								CreateDate TEXT DEFAULT '',
								CreatingIDUser INTEGER DEFAULT 0,
								UpdateDate TEXT DEFAULT '',
								UpdatingIDUser INTEGER DEFAULT 0,
								Deleted INTEGER DEFAULT 0,
								DeleteDate TEXT DEFAULT '',
								DeletingIDUser INTEGER DEFAULT 0,
								Title TEXT DEFAULT '',
								HireDate TEXT DEFAULT '',
								TerminationDate TEXT DEFAULT '',
								IsActive INTEGER DEFAULT 0,
								IDUser INTEGER DEFAULT 0,
								IDBookStore INTEGER DEFAULT 0,
								IDCustomer INTEGER DEFAULT 0
							);
							CREATE TABLE IF NOT EXISTS BookStoreSale (
								IDBookStoreSale INTEGER PRIMARY KEY AUTOINCREMENT,
								GUIDBookStoreSale TEXT DEFAULT '',
								CreateDate TEXT DEFAULT '',
								CreatingIDUser INTEGER DEFAULT 0,
								UpdateDate TEXT DEFAULT '',
								UpdatingIDUser INTEGER DEFAULT 0,
								Deleted INTEGER DEFAULT 0,
								DeleteDate TEXT DEFAULT '',
								DeletingIDUser INTEGER DEFAULT 0,
								SaleDate TEXT DEFAULT '',
								TotalAmount REAL DEFAULT 0,
								PaymentMethod TEXT DEFAULT '',
								TransactionID TEXT DEFAULT '',
								IDBookStore INTEGER DEFAULT 0,
								IDUser INTEGER DEFAULT 0,
								IDCustomer INTEGER DEFAULT 0
							);
							CREATE TABLE IF NOT EXISTS BookStoreSaleItem (
								IDBookStoreSaleItem INTEGER PRIMARY KEY AUTOINCREMENT,
								GUIDBookStoreSaleItem TEXT DEFAULT '',
								CreateDate TEXT DEFAULT '',
								CreatingIDUser INTEGER DEFAULT 0,
								UpdateDate TEXT DEFAULT '',
								UpdatingIDUser INTEGER DEFAULT 0,
								Deleted INTEGER DEFAULT 0,
								DeleteDate TEXT DEFAULT '',
								DeletingIDUser INTEGER DEFAULT 0,
								Quantity INTEGER DEFAULT 0,
								UnitPrice REAL DEFAULT 0,
								LineTotal REAL DEFAULT 0,
								IDBookStoreSale INTEGER DEFAULT 0,
								IDBook INTEGER DEFAULT 0,
								IDBookPrice INTEGER DEFAULT 0,
								IDCustomer INTEGER DEFAULT 0
							);
						`);

						// Seed a minimal user so CreatingIDUser 0 is fine
						let tmpInsertUser = tmpDB.prepare(
							`INSERT INTO User (IDUser, GUIDUser, LoginID, Password, NameFirst, NameLast, FullName, Config)
							 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
						tmpInsertUser.run(1, 1001, 'admin', 'hash123', 'Admin', 'User', 'Admin User', '{}');

						// ---- RetoldDataService ----
						_Fable.serviceManager.addServiceType('RetoldDataService', libRetoldDataService);
						_RetoldDataService = _Fable.serviceManager.instantiateServiceProvider('RetoldDataService',
							{
								FullMeadowSchemaPath: `${libPath.dirname(require.resolve('retold-harness/source/schemas/bookstore/Schema.json'))}/`,
								FullMeadowSchemaFilename: `Schema.json`,

								StorageProvider: 'SQLite',
								StorageProviderModule: 'meadow-connection-sqlite',

								AutoInitializeDataService: true,
								AutoStartOrator: true
							});

						_RetoldDataService.initializeService(
							(pInitError) =>
							{
								if (pInitError)
								{
									return fDone(pInitError);
								}
								return fDone();
							});
					});
			}
		);

		suiteTeardown
		(
			function (fDone)
			{
				this.timeout(5000);
				if (_Fable && _Fable.MeadowSQLiteProvider && _Fable.MeadowSQLiteProvider.db)
				{
					try { _Fable.MeadowSQLiteProvider.db.close(); }
					catch (pIgnore) { /* already closed */ }
				}
				if (_Fable && _Fable.OratorServiceServer && _Fable.OratorServiceServer.Active && _Fable.OratorServiceServer.server)
				{
					_Fable.OratorServiceServer.server.close(
						() =>
						{
							_Fable.OratorServiceServer.Active = false;
							fDone();
						});
				}
				else
				{
					fDone();
				}
			}
		);

		suite
		(
			'Generate and Push Random Books',
			function ()
			{
				let _GeneratedBooks = [];
				let _BookCount = 10;

				test
				(
					'Generate random book records using fable DataGeneration',
					function (fDone)
					{
						_Fable.instantiateServiceProviderIfNotExists('DataGeneration');
						let tmpDataGen = _Fable.DataGeneration;

						Expect(tmpDataGen).to.be.an('object');

						let tmpGenres = ['Science Fiction', 'Fantasy', 'Mystery', 'Romance', 'Thriller', 'Horror', 'Historical', 'Comedy'];
						let tmpTypes = ['Fiction', 'Non-Fiction'];
						let tmpLanguages = ['English', 'Spanish', 'French', 'German', 'Japanese'];

						for (let i = 0; i < _BookCount; i++)
						{
							// Combine random data to create fun book titles like "The Blue Tuesday Chronicles"
							let tmpTitle = `The ${tmpDataGen.randomColor()} ${tmpDataGen.randomDayOfWeek()} of ${tmpDataGen.randomName()} ${tmpDataGen.randomSurname()}`;
							let tmpGenre = tmpGenres[tmpDataGen.randomIntegerUpTo(tmpGenres.length)];
							let tmpType = tmpTypes[tmpDataGen.randomIntegerUpTo(tmpTypes.length)];
							let tmpLanguage = tmpLanguages[tmpDataGen.randomIntegerUpTo(tmpLanguages.length)];
							let tmpYear = tmpDataGen.randomIntegerBetween(1900, 2025);
							let tmpISBN = `978-${tmpDataGen.randomNumericString(10)}`;

							_GeneratedBooks.push(
								{
									GUIDBook: `RandBook-${i}`,
									Title: tmpTitle,
									Type: tmpType,
									Genre: tmpGenre,
									ISBN: tmpISBN,
									Language: tmpLanguage,
									PublicationYear: tmpYear
								});
						}

						Expect(_GeneratedBooks.length).to.equal(_BookCount);

						// Verify each book has the expected structure
						for (let i = 0; i < _GeneratedBooks.length; i++)
						{
							Expect(_GeneratedBooks[i]).to.have.property('GUIDBook');
							Expect(_GeneratedBooks[i]).to.have.property('Title');
							Expect(_GeneratedBooks[i].Title.length).to.be.greaterThan(0);
						}

						return fDone();
					}
				);

				test
				(
					'Push generated books through the Integration Adapter',
					function (fDone)
					{
						this.timeout(30000);

						// Register services on fable
						_Fable.serviceManager.addServiceType('IntegrationAdapter', libIntegrationAdapter);
						_Fable.serviceManager.addServiceType('MeadowGUIDMap', libGUIDMap);
						_Fable.serviceManager.addServiceType('MeadowCloneRestClient', libRestClient);

						// Create a REST client pointing at our in-memory harness server
						let tmpRestClient = _Fable.serviceManager.instantiateServiceProvider('MeadowCloneRestClient',
							{
								ServerURL: _ServerURL
							});

						Expect(tmpRestClient).to.be.an('object');

						// Create the adapter for the Book entity
						let tmpAdapter = _Fable.serviceManager.instantiateServiceProvider('IntegrationAdapter',
							{
								Entity: 'Book',
								AdapterSetGUIDMarshalPrefix: 'TEST',
								EntityGUIDMarshalPrefix: 'BK',
								ForceMarshal: true
							}, 'Book');

						tmpAdapter.setRestClient(tmpRestClient);

						Expect(tmpAdapter).to.be.an('object');
						Expect(tmpAdapter.Entity).to.equal('Book');

						// Add each generated book as a source record
						for (let i = 0; i < _GeneratedBooks.length; i++)
						{
							tmpAdapter.addSourceRecord(_GeneratedBooks[i]);
						}

						// Push the records to the server
						tmpAdapter.integrateRecords(
							(pError) =>
							{
								Expect(pError).to.not.be.an('Error');

								// Verify GUIDs were mapped
								let tmpGUIDMap = _Fable.MeadowGUIDMap;
								for (let i = 0; i < _GeneratedBooks.length; i++)
								{
									let tmpMeadowGUID = tmpGUIDMap.getMeadowGUIDFromExternalGUID('Book', _GeneratedBooks[i].GUIDBook);
									Expect(tmpMeadowGUID).to.be.a('string');
									Expect(tmpMeadowGUID).to.contain('TEST-');
									Expect(tmpMeadowGUID).to.contain('BK-');
								}

								return fDone();
							});
					}
				);

				test
				(
					'Read back the pushed books from the REST API',
					function (fDone)
					{
						this.timeout(15000);

						let tmpRestClient = _Fable.MeadowCloneRestClient;
						Expect(tmpRestClient).to.be.an('object');

						// Read each pushed book by its generated Meadow GUID
						let tmpGUIDMap = _Fable.MeadowGUIDMap;
						let tmpRemaining = _GeneratedBooks.length;
						let tmpVerified = 0;

						for (let i = 0; i < _GeneratedBooks.length; i++)
						{
							let tmpOriginal = _GeneratedBooks[i];
							let tmpMeadowGUID = tmpGUIDMap.getMeadowGUIDFromExternalGUID('Book', tmpOriginal.GUIDBook);

							tmpRestClient.getEntityByGUID('Book', tmpMeadowGUID,
								(pError, pBody) =>
								{
									Expect(pError).to.not.be.an('Error');
									Expect(pBody).to.be.an('object');
									Expect(pBody.IDBook).to.be.greaterThan(0);
									Expect(pBody.GUIDBook).to.equal(tmpMeadowGUID);
									Expect(pBody.Title).to.equal(tmpOriginal.Title);
									Expect(pBody.Genre).to.equal(tmpOriginal.Genre);
									Expect(pBody.Type).to.equal(tmpOriginal.Type);
									Expect(pBody.Language).to.equal(tmpOriginal.Language);
									Expect(pBody.ISBN).to.equal(tmpOriginal.ISBN);

									tmpVerified++;
									tmpRemaining--;

									if (tmpRemaining <= 0)
									{
										Expect(tmpVerified).to.equal(_BookCount);
										return fDone();
									}
								});
						}
					}
				);

				test
				(
					'Upsert existing books with updated titles',
					function (fDone)
					{
						this.timeout(30000);

						// Create a new adapter for the same entity (will re-use the GUIDMap)
						let tmpAdapter = libIntegrationAdapter.getAdapter(_Fable, 'Book', 'BK',
							{
								AdapterSetGUIDMarshalPrefix: 'TEST',
								ForceMarshal: true
							});

						tmpAdapter.setRestClient(_Fable.MeadowCloneRestClient);

						// Update the title of each generated book
						for (let i = 0; i < _GeneratedBooks.length; i++)
						{
							let tmpUpdated = Object.assign({}, _GeneratedBooks[i]);
							tmpUpdated.Title = `Updated: ${tmpUpdated.Title}`;
							tmpAdapter.addSourceRecord(tmpUpdated);
						}

						tmpAdapter.integrateRecords(
							(pError) =>
							{
								Expect(pError).to.not.be.an('Error');
								return fDone();
							});
					}
				);

				test
				(
					'Verify updated titles via REST API',
					function (fDone)
					{
						this.timeout(15000);

						let tmpRestClient = _Fable.MeadowCloneRestClient;
						let tmpGUIDMap = _Fable.MeadowGUIDMap;
						let tmpRemaining = _GeneratedBooks.length;
						let tmpVerified = 0;

						for (let i = 0; i < _GeneratedBooks.length; i++)
						{
							let tmpOriginal = _GeneratedBooks[i];
							let tmpMeadowGUID = tmpGUIDMap.getMeadowGUIDFromExternalGUID('Book', tmpOriginal.GUIDBook);

							tmpRestClient.getEntityByGUID('Book', tmpMeadowGUID,
								(pError, pBody) =>
								{
									Expect(pError).to.not.be.an('Error');
									Expect(pBody).to.be.an('object');
									Expect(pBody.GUIDBook).to.equal(tmpMeadowGUID);
									Expect(pBody.Title).to.equal(`Updated: ${tmpOriginal.Title}`);

									tmpVerified++;
									tmpRemaining--;

									if (tmpRemaining <= 0)
									{
										Expect(tmpVerified).to.equal(_BookCount);
										return fDone();
									}
								});
						}
					}
				);

				test
				(
					'Push authors and join records with FK resolution',
					function (fDone)
					{
						this.timeout(30000);

						// Generate some random authors
						_Fable.instantiateServiceProviderIfNotExists('DataGeneration');
						let tmpDataGen = _Fable.DataGeneration;

						// Create 3 random authors
						let tmpAuthors = [];
						for (let i = 0; i < 3; i++)
						{
							tmpAuthors.push(
								{
									GUIDAuthor: `RandAuthor-${i}`,
									Name: `${tmpDataGen.randomName()} ${tmpDataGen.randomSurname()}`
								});
						}

						// Push authors first
						let tmpAuthorAdapter = libIntegrationAdapter.getAdapter(_Fable, 'Author', 'AU',
							{
								AdapterSetGUIDMarshalPrefix: 'TEST',
								ForceMarshal: true
							});
						tmpAuthorAdapter.setRestClient(_Fable.MeadowCloneRestClient);

						for (let i = 0; i < tmpAuthors.length; i++)
						{
							tmpAuthorAdapter.addSourceRecord(tmpAuthors[i]);
						}

						tmpAuthorAdapter.integrateRecords(
							(pAuthorError) =>
							{
								Expect(pAuthorError).to.not.be.an('Error');

								// Now create BookAuthorJoin records that reference both
								// Book (via external GUID) and Author (via external GUID)
								let tmpJoinAdapter = libIntegrationAdapter.getAdapter(_Fable, 'BookAuthorJoin', 'BAJ',
									{
										AdapterSetGUIDMarshalPrefix: 'TEST',
										ForceMarshal: true
									});
								tmpJoinAdapter.setRestClient(_Fable.MeadowCloneRestClient);

								// Link first 3 books to the 3 authors
								for (let i = 0; i < 3; i++)
								{
									tmpJoinAdapter.addSourceRecord(
										{
											GUIDBookAuthorJoin: `RandJoin-${i}`,
											GUIDBook: `RandBook-${i}`,
											GUIDAuthor: `RandAuthor-${i}`
										});
								}

								tmpJoinAdapter.integrateRecords(
									(pJoinError) =>
									{
										Expect(pJoinError).to.not.be.an('Error');

										// Verify the join records were created with correct FK IDs
										let tmpGUIDMap = _Fable.MeadowGUIDMap;
										let tmpRestClient = _Fable.MeadowCloneRestClient;
										let tmpRemaining = 3;

										for (let i = 0; i < 3; i++)
										{
											let tmpJoinGUID = tmpGUIDMap.getMeadowGUIDFromExternalGUID('BookAuthorJoin', `RandJoin-${i}`);
											tmpRestClient.getEntityByGUID('BookAuthorJoin', tmpJoinGUID,
												(pReadError, pJoinBody) =>
												{
													Expect(pReadError).to.not.be.an('Error');
													Expect(pJoinBody).to.be.an('object');
													Expect(pJoinBody.IDBook).to.be.greaterThan(0);
													Expect(pJoinBody.IDAuthor).to.be.greaterThan(0);

													tmpRemaining--;
													if (tmpRemaining <= 0)
													{
														return fDone();
													}
												});
										}
									});
							});
					}
				);
			}
		);
	}
);
