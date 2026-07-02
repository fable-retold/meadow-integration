'use strict';

const Chai = require('chai');
const Expect = Chai.expect;

const libConvergence = require('../source/services/clone/Meadow-Service-IndexConvergence.js');
const libIndexPolicy = require('../source/services/clone/Meadow-Service-IndexPolicy.js');

const _DocSchema =
{
	TableName: 'Document',
	DefaultIdentifier: 'IDDocument',
	Columns:
	[
		{ Column: 'IDDocument',   DataType: 'ID'   },
		{ Column: 'GUIDDocument', DataType: 'GUID' },
		{ Column: 'Deleted',      DataType: 'Boolean' }
	]
};

// Desired set from the policy: (Deleted, IDDocument) composite + GUID lookup.
const _Desired = libIndexPolicy.resolveDesiredIndexes(_DocSchema, {});
const COMPOSITE = 'IX_M_SYNC_Document_Deleted_IDDocument';
const GUIDIDX = 'IX_M_SYNC_Document_GUIDDocument';

// Stub connection provider recording the create/drop call order.
function makeStubProvider(pActual, pFailCreateNames)
{
	let tmpFail = new Set(pFailCreateNames || []);
	let tmpCalls = [];
	return {
		calls: tmpCalls,
		introspectTableIndices: (pTable, fCallback) => { return fCallback(null, (pActual || []).slice()); },
		generateCreateIndexStatements: (pSchema) =>
		{
			return (pSchema.Indices || []).map((pIndex) =>
			{
				return { Name: pIndex.Name, Statement: `CREATE INDEX ${pIndex.Name}`, CheckStatement: `CHECK ${pIndex.Name}` };
			});
		},
		createIndex: (pStatement, fCallback) =>
		{
			tmpCalls.push('create:' + pStatement.Name);
			if (tmpFail.has(pStatement.Name)) { return fCallback(new Error('simulated create failure')); }
			return fCallback();
		},
		dropIndex: (pTableName, pIndexName, fCallback) =>
		{
			tmpCalls.push('drop:' + pIndexName);
			return fCallback();
		}
	};
}

suite('Meadow Integration - IndexConvergence',
	() =>
	{
		test('additive: creates the missing desired indexes, drops nothing',
			(fDone) =>
			{
				let tmpProvider = makeStubProvider([]);
				libConvergence.convergeTableIndexes(tmpProvider, _DocSchema, _Desired, { PruneScope: 'managed' },
					(pError, pResult) =>
					{
						try {
							Expect(pError).to.equal(null);
							Expect(pResult.created).to.have.members([ COMPOSITE, GUIDIDX ]);
							Expect(pResult.dropped).to.have.length(0);
							fDone();
						} catch (e) { fDone(e); }
					});
			});

		test('managed convergence: replaces precursor artifacts, create BEFORE drop',
			(fDone) =>
			{
				let tmpActual = [ { Name: 'Deleted', Columns: [ 'Deleted' ] }, { Name: 'GUIDDocument', Columns: [ 'GUIDDocument' ] } ];
				let tmpProvider = makeStubProvider(tmpActual);
				libConvergence.convergeTableIndexes(tmpProvider, _DocSchema, _Desired, { PruneScope: 'managed' },
					(pError, pResult) =>
					{
						try {
							Expect(pError).to.equal(null);
							Expect(pResult.created).to.have.members([ COMPOSITE, GUIDIDX ]);
							Expect(pResult.dropped).to.have.members([ 'Deleted', 'GUIDDocument' ]);
							// Ordering: every create precedes every drop.
							let tmpFirstDrop = tmpProvider.calls.findIndex((pCall) => pCall.indexOf('drop:') === 0);
							let tmpLastCreate = tmpProvider.calls.map((pCall, i) => pCall.indexOf('create:') === 0 ? i : -1).reduce((a, b) => Math.max(a, b), -1);
							Expect(tmpLastCreate).to.be.lessThan(tmpFirstDrop);
							fDone();
						} catch (e) { fDone(e); }
					});
			});

		test('no-loss-on-failure: a failed create suppresses ALL drops this run',
			(fDone) =>
			{
				let tmpActual = [ { Name: 'Deleted', Columns: [ 'Deleted' ] } ];
				let tmpProvider = makeStubProvider(tmpActual, [ COMPOSITE ]); // composite build fails
				libConvergence.convergeTableIndexes(tmpProvider, _DocSchema, _Desired, { PruneScope: 'managed' },
					(pError, pResult) =>
					{
						try {
							Expect(pError).to.equal(null);
							Expect(pResult.created).to.deep.equal([ GUIDIDX ]);   // the GUID one still built
							Expect(pResult.skipped).to.include(COMPOSITE);        // the failed create
							Expect(pResult.dropped).to.have.length(0);            // no drops — coverage preserved
							Expect(pResult.skipped).to.include('Deleted');        // the drop was deferred
							Expect(tmpProvider.calls.some((pCall) => pCall.indexOf('drop:') === 0)).to.equal(false);
							fDone();
						} catch (e) { fDone(e); }
					});
			});

		test("prune 'none' never drops, even a managed undeclared index",
			(fDone) =>
			{
				let tmpActual = [ { Name: 'Deleted', Columns: [ 'Deleted' ] } ];
				let tmpProvider = makeStubProvider(tmpActual);
				libConvergence.convergeTableIndexes(tmpProvider, _DocSchema, _Desired, { PruneScope: 'none' },
					(pError, pResult) =>
					{
						try {
							Expect(pError).to.equal(null);
							Expect(pResult.dropped).to.have.length(0);
							fDone();
						} catch (e) { fDone(e); }
					});
			});

		test("prune 'managed' leaves a truly external index untouched",
			(fDone) =>
			{
				let tmpActual = [ { Name: 'IX_dba_custom_reporting', Columns: [ 'Status' ] } ];
				let tmpProvider = makeStubProvider(tmpActual);
				libConvergence.convergeTableIndexes(tmpProvider, _DocSchema, _Desired, { PruneScope: 'managed' },
					(pError, pResult) =>
					{
						try {
							Expect(pError).to.equal(null);
							Expect(pResult.dropped).to.have.length(0);   // unmanaged → not dropped
							Expect(pResult.created).to.have.members([ COMPOSITE, GUIDIDX ]);
							fDone();
						} catch (e) { fDone(e); }
					});
			});

		test("prune 'all' drops any undeclared index",
			(fDone) =>
			{
				let tmpActual = [ { Name: 'IX_dba_custom_reporting', Columns: [ 'Status' ] } ];
				let tmpProvider = makeStubProvider(tmpActual);
				libConvergence.convergeTableIndexes(tmpProvider, _DocSchema, _Desired, { PruneScope: 'all' },
					(pError, pResult) =>
					{
						try {
							Expect(pError).to.equal(null);
							Expect(pResult.dropped).to.deep.equal([ 'IX_dba_custom_reporting' ]);
							fDone();
						} catch (e) { fDone(e); }
					});
			});
	});
