'use strict';

const Chai = require('chai');
const Expect = Chai.expect;

const libIndexPolicy = require('../source/services/clone/Meadow-Service-IndexPolicy.js');

const _DocumentSchema =
{
	TableName: 'Document',
	DefaultIdentifier: 'IDDocument',
	Columns:
	[
		{ Column: 'IDDocument',   DataType: 'ID'   },
		{ Column: 'GUIDDocument', DataType: 'GUID' },
		{ Column: 'IDProject',    DataType: 'ForeignKey' },
		{ Column: 'Name',         DataType: 'String', Size: 128 },
		{ Column: 'Deleted',      DataType: 'Boolean' }
	]
};

// A join table with no Deleted column and no GUID column.
const _JoinSchema =
{
	TableName: 'DocumentPolyJoin',
	DefaultIdentifier: 'IDDocumentPolyJoin',
	Columns:
	[
		{ Column: 'IDDocumentPolyJoin', DataType: 'ID' },
		{ Column: 'IDDocument',         DataType: 'ForeignKey' }
	]
};

const byName = (pIndices, pName) => pIndices.find((pIndex) => { return pIndex.Name === pName; });

suite('Meadow Integration - IndexPolicy',
	() =>
	{
		suite('standard operational indexes',
			() =>
			{
				test('emits a NON-UNIQUE (Deleted, ID) composite for a soft-deletable table',
					() =>
					{
						let tmpIndices = libIndexPolicy.resolveDesiredIndexes(_DocumentSchema, {});
						let tmpComposite = byName(tmpIndices, 'IX_M_SYNC_Document_Deleted_IDDocument');
						Expect(tmpComposite, 'composite present').to.be.an('object');
						Expect(tmpComposite.Columns).to.deep.equal([ 'Deleted', 'IDDocument' ]);
						Expect(tmpComposite.Unique).to.equal(false);
					});

				test('emits a NON-UNIQUE GUID lookup index',
					() =>
					{
						let tmpIndices = libIndexPolicy.resolveDesiredIndexes(_DocumentSchema, {});
						let tmpGUID = byName(tmpIndices, 'IX_M_SYNC_Document_GUIDDocument');
						Expect(tmpGUID, 'GUID index present').to.be.an('object');
						Expect(tmpGUID.Columns).to.deep.equal([ 'GUIDDocument' ]);
						Expect(tmpGUID.Unique).to.equal(false);
					});

				test('emits nothing standard for a table with neither Deleted nor GUID',
					() =>
					{
						let tmpIndices = libIndexPolicy.resolveDesiredIndexes(_JoinSchema, {});
						Expect(tmpIndices.filter((pIndex) => { return pIndex.Name.indexOf('IX_M_SYNC_') === 0; })).to.have.length(0);
					});

				test('StandardOperationalIndexes:false opts out of the standard set',
					() =>
					{
						let tmpIndices = libIndexPolicy.resolveDesiredIndexes(_DocumentSchema, { StandardOperationalIndexes: false });
						Expect(tmpIndices).to.have.length(0);
					});
			});

		suite('caller-declared per-table extras',
			() =>
			{
				test('adds a configured extra index for the target table only',
					() =>
					{
						let tmpConfig = { TableIndexes: { Document: [ { Columns: [ 'IDProject', 'Deleted' ] } ] } };
						let tmpDoc = libIndexPolicy.resolveDesiredIndexes(_DocumentSchema, tmpConfig);
						let tmpExtra = byName(tmpDoc, 'IX_M_SYNC_Document_IDProject_Deleted');
						Expect(tmpExtra, 'configured extra present').to.be.an('object');
						Expect(tmpExtra.Columns).to.deep.equal([ 'IDProject', 'Deleted' ]);

						// A different table gets no extras from that config.
						let tmpJoin = libIndexPolicy.resolveDesiredIndexes(_JoinSchema, tmpConfig);
						Expect(tmpJoin.some((pIndex) => { return pIndex.Name.indexOf('IX_M_SYNC_DocumentPolyJoin_ID') === 0; })).to.equal(false);
					});

				test('honors an explicit Name and Unique on a configured extra',
					() =>
					{
						let tmpConfig = { TableIndexes: { Document: [ { Name: 'IX_custom_docname', Columns: 'Name', Unique: true } ] } };
						let tmpDoc = libIndexPolicy.resolveDesiredIndexes(_DocumentSchema, tmpConfig);
						let tmpExtra = byName(tmpDoc, 'IX_custom_docname');
						Expect(tmpExtra, 'named extra present').to.be.an('object');
						Expect(tmpExtra.Columns).to.deep.equal([ 'Name' ]);
						Expect(tmpExtra.Unique).to.equal(true);
					});

				test('skips a configured extra whose columns are not all present',
					() =>
					{
						let tmpConfig = { TableIndexes: { Document: [ { Columns: [ 'Name', 'NonexistentColumn' ] } ] } };
						let tmpDoc = libIndexPolicy.resolveDesiredIndexes(_DocumentSchema, tmpConfig);
						Expect(tmpDoc.some((pIndex) => { return pIndex.Columns.indexOf('NonexistentColumn') >= 0; })).to.equal(false);
					});
			});

		suite('isManagedIndexName (prune scope = managed)',
			() =>
			{
				test('recognizes policy, schema-managed, and legacy column-named indexes',
					() =>
					{
						Expect(libIndexPolicy.isManagedIndexName('IX_M_SYNC_Document_Deleted_IDDocument', _DocumentSchema)).to.equal(true);
						Expect(libIndexPolicy.isManagedIndexName('AK_M_GUIDDocument', _DocumentSchema)).to.equal(true);
						Expect(libIndexPolicy.isManagedIndexName('Deleted', _DocumentSchema)).to.equal(true);        // precursor artifact
						Expect(libIndexPolicy.isManagedIndexName('GUIDDocument', _DocumentSchema)).to.equal(true);   // precursor artifact
					});

				test('leaves a truly external hand-authored index untouched',
					() =>
					{
						Expect(libIndexPolicy.isManagedIndexName('IX_dba_custom_reporting', _DocumentSchema)).to.equal(false);
						Expect(libIndexPolicy.isManagedIndexName('PK_Document', _DocumentSchema)).to.equal(false);
					});
			});
	});
