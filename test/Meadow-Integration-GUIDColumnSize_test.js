/*
	Unit tests for how the adapter resolves GUIDMaxLength.

	Precedence is: explicit GUIDMaxLength option > GUIDColumnSizes[Entity] > DefaultGUIDColumnSize,
	with the live server schema adopted during integrateRecords() when no explicit option was set.

	The schema body used here is the document meadow-endpoints actually sends from GET /{Entity}/Schema
	-- DAL.jsonSchema, which carries widths on `properties[Column].size` (and a nested MeadowSchema.Schema
	array).  There is no top-level `Columns` array on that response.
*/

const Chai = require('chai');
const Expect = Chai.expect;

const libFable = require('fable');

const libEngine = require('../source/Meadow-Integration-Engine.js');

const endpointSchemaBody = (pEntity, pGUIDSize) =>
	({
		title: pEntity,
		type: 'object',
		properties:
		{
			[`ID${pEntity}`]: { type: 'integer', size: 'Default' },
			[`GUID${pEntity}`]: { type: 'string', size: String(pGUIDSize) },
			Name: { type: 'string', size: '128' }
		},
		required: [],
		MeadowSchema:
		{
			Scope: pEntity,
			DefaultIdentifier: `ID${pEntity}`,
			Schema:
			[
				{ Column: `ID${pEntity}`, Type: 'AutoIdentity', Size: 'Default' },
				{ Column: `GUID${pEntity}`, Type: 'AutoGUID', Size: String(pGUIDSize) },
				{ Column: 'Name', Type: 'String', Size: '128' }
			]
		}
	});

const stubClient = (pSchemaBody) =>
	({
		serverURL: 'http://localhost:8080/1.0/',
		getJSON: (pURL, fCallback) => { return fCallback(null, {}, pSchemaBody); },
		upsertEntity: (pEntity, pRecord, fCallback) => { return fCallback(null, {}, pRecord); },
		upsertEntities: (pEntity, pRecords, fCallback) => { return fCallback(null, {}, pRecords); }
	});

const newAdapter = (pOptions, pSchemaBody) =>
{
	const tmpFable = new libFable({ Product: 'GUIDColumnSizeTest', LogStreams: [ { streamtype: 'console', level: 'fatal' } ] });
	return new libEngine.MeadowIntegrationAdapter(tmpFable, Object.assign(
		{
			Entity: 'Lab',
			Client: stubClient(pSchemaBody || endpointSchemaBody('Lab', 64)),
			AdapterSetGUIDMarshalPrefix: '',
			EntityGUIDMarshalPrefix: '',
			SimpleMarshal: true,
			PerformDeletes: false
		}, pOptions || {}), 'GUIDColumnSizeTest');
};

const integrate = (pAdapter) =>
{
	return new Promise((resolve) => { pAdapter.integrateRecords((pError) => { return resolve(pError); }); });
};

suite
(
	'Meadow Integration — adapter GUID column size resolution',
	() =>
	{
		test
		(
			'an explicit GUIDMaxLength wins over everything',
			() =>
			{
				Expect(newAdapter({ GUIDMaxLength: 24, GUIDColumnSizes: { Lab: 64 } }).GUIDMaxLength).to.equal(24);
			}
		);
		test
		(
			'a GUIDColumnSizes entry wins over DefaultGUIDColumnSize',
			() =>
			{
				Expect(newAdapter({ GUIDColumnSizes: { Lab: 64 } }).GUIDMaxLength).to.equal(64);
			}
		);
		test
		(
			'with neither, construction falls back to DefaultGUIDColumnSize',
			() =>
			{
				Expect(newAdapter({}).GUIDMaxLength).to.equal(36);
			}
		);
		test
		(
			'integrateRecords adopts the GUID column width from the live meadow-endpoints schema',
			async () =>
			{
				const tmpAdapter = newAdapter({}, endpointSchemaBody('Lab', 64));
				await integrate(tmpAdapter);
				Expect(tmpAdapter.GUIDMaxLength).to.equal(64);
			}
		);
		test
		(
			'a GUID longer than the default but inside the real column width is accepted',
			async () =>
			{
				const tmpAdapter = newAdapter({}, endpointSchemaBody('Lab', 64));
				tmpAdapter.addSourceRecord({ GUIDLab: 'LADOTD-Lab-Design Build Lab Unit (GEC)', Name: 'Design Build Lab Unit (GEC)' });
				const tmpError = await integrate(tmpAdapter);
				Expect(tmpError, tmpError ? tmpError.message : '').to.not.be.an('Error');
				Expect(Object.keys(tmpAdapter._MarshaledRecords).length).to.equal(1);
			}
		);
		test
		(
			'a GUID longer than the real column width is still rejected',
			async () =>
			{
				const tmpAdapter = newAdapter({}, endpointSchemaBody('Lab', 36));
				tmpAdapter.addSourceRecord({ GUIDLab: 'LADOTD-Lab-Design Build Lab Unit (GEC)', Name: 'Design Build Lab Unit (GEC)' });
				const tmpError = await integrate(tmpAdapter);
				Expect(tmpError).to.be.an('Error');
			}
		);
		test
		(
			'an explicit GUIDMaxLength is not clobbered by the live schema',
			async () =>
			{
				const tmpAdapter = newAdapter({ GUIDMaxLength: 24 }, endpointSchemaBody('Lab', 64));
				await integrate(tmpAdapter);
				Expect(tmpAdapter.GUIDMaxLength).to.equal(24);
			}
		);
		test
		(
			'an explicit GUIDColumnSizes entry is not clobbered by the live schema',
			async () =>
			{
				const tmpAdapter = newAdapter({ GUIDColumnSizes: { Lab: 96 } }, endpointSchemaBody('Lab', 64));
				await integrate(tmpAdapter);
				Expect(tmpAdapter.GUIDMaxLength).to.equal(96);
			}
		);
		test
		(
			'loadSchema resolves the width for consumers that marshal without integrateRecords',
			async () =>
			{
				const tmpAdapter = newAdapter({}, endpointSchemaBody('Lab', 64));
				await new Promise((resolve) => { tmpAdapter.loadSchema(() => { return resolve(); }); });
				Expect(tmpAdapter.GUIDMaxLength).to.equal(64);
				Expect(tmpAdapter.GUIDMaxLengthResolved).to.equal(true);
			}
		);
		test
		(
			'a bare column array is accepted as an alternate schema shape',
			async () =>
			{
				const tmpAdapter = newAdapter({}, { Columns: [ { Column: 'GUIDLab', Type: 'AutoGUID', Size: '64' } ] });
				await new Promise((resolve) => { tmpAdapter.loadSchema(() => { return resolve(); }); });
				Expect(tmpAdapter.GUIDMaxLength).to.equal(64);
			}
		);
		test
		(
			'a schema with no width for the GUID column leaves the fallback in place, unresolved',
			async () =>
			{
				const tmpAdapter = newAdapter({}, { title: 'Lab', type: 'object', properties: { Name: { type: 'string', size: '128' } } });
				await new Promise((resolve) => { tmpAdapter.loadSchema(() => { return resolve(); }); });
				Expect(tmpAdapter.GUIDMaxLength).to.equal(36);
				Expect(tmpAdapter.GUIDMaxLengthResolved).to.equal(false);
			}
		);
		test
		(
			'the rejection message names where the limit came from, and flags an unresolved default',
			() =>
			{
				const tmpUnresolved = newAdapter({});
				Expect(() => { tmpUnresolved.generateMeadowGUIDFromExternalGUID('LADOTD-Lab-Design Build Lab Unit (GEC)'); })
					.to.throw('DefaultGUIDColumnSize fallback');
				Expect(() => { tmpUnresolved.generateMeadowGUIDFromExternalGUID('LADOTD-Lab-Design Build Lab Unit (GEC)'); })
					.to.throw('No column width was resolved');

				const tmpResolved = newAdapter({ GUIDColumnSizes: { Lab: 20 } });
				Expect(() => { tmpResolved.generateMeadowGUIDFromExternalGUID('LADOTD-Lab-Design Build Lab Unit (GEC)'); })
					.to.throw('GUIDColumnSizes option');
				Expect(() => { tmpResolved.generateMeadowGUIDFromExternalGUID('LADOTD-Lab-Design Build Lab Unit (GEC)'); })
					.to.not.throw('No column width was resolved');
			}
		);
	}
);
