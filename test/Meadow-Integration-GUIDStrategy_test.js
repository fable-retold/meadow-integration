/*
	Unit tests for the GUID strategy compiler (Meadow-Integration-GUIDStrategy).

	Pure module — turns a per-entity strategy config + a host context catalog + schema GUID sizes into the
	structured spec the transform consumes. Verifies own/context composition, the per-join FK field-name
	selection (mapping to the adapter's GUID / _GUID / ID conventions), and the no-key warning.
*/

const Chai = require('chai');
const Expect = Chai.expect;

const libStrategy = require('../source/services/guid/Meadow-Integration-GUIDStrategy.js');
const libComposer = require('../source/services/guid/Meadow-Integration-GUIDComposer.js');

const CATALOG =
{
	Project: { Abbrev: 'P', KeyField: 'Code' },
	Contract: { Abbrev: 'C', KeyField: 'Number' },
	LineItem: { Abbrev: 'LI', KeyField: 'Code' },
};
const SIZES = { Project: 64, Contract: 64, LineItem: 64 };

const CONFIG =
{
	Prefix: 'UI',
	Entities:
	{
		Project: { Mode: 'prefixed', OwnKeyColumn: 'ProjectCode' },
		LineItem:
		{
			Mode: 'prefixed',
			OwnKeyColumn: 'LineId',
			ContextEntities: [ 'Contract', 'Project' ],
			ContextKeyColumns: { Contract: 'ContractNum', Project: 'ProjectCode' },
			Joins:
			[
				{ ParentEntity: 'Project', Mode: 'prefixed', KeyColumn: 'ProjectCode', CrossSession: true },
				{ ParentEntity: 'Contract', Mode: 'prefixed', KeyColumn: 'ContractNum', CrossSession: true },
			],
		},
	},
};

suite
(
	'Meadow Integration — GUID Strategy compiler',
	() =>
	{
		test
		(
			'compiles a top-level entity to a single-segment own GUID spec',
			() =>
			{
				const tmpResult = libStrategy.compile(CONFIG, { Catalog: CATALOG, SchemaSizes: SIZES });
				const tmpProject = tmpResult.Strategies.Project;
				Expect(tmpProject.GUIDName).to.equal('GUIDProject');
				Expect(tmpProject.Own.FieldName).to.equal('GUIDProject');
				Expect(tmpProject.Own.Compose.prefix).to.equal('UI');
				Expect(tmpProject.Own.Compose.maxLength).to.equal(64);
				Expect(tmpProject.Own.Compose.segments).to.have.length(1);
				Expect(tmpProject.Own.Compose.segments[0]).to.deep.equal({ abbrev: 'P', valueTemplate: '{~D:Record.ProjectCode~}' });
			}
		);
		test
		(
			'combinatorial own key: multiple columns concatenate into one own segment',
			() =>
			{
				const tmpConfig = { Prefix: 'UI', Entities: { Project: { Mode: 'prefixed', OwnKeyColumns: [ 'District', 'ProjectCode' ] } } };
				const tmpProject = libStrategy.compile(tmpConfig, { Catalog: CATALOG, SchemaSizes: SIZES }).Strategies.Project;
				Expect(tmpProject.Own.Compose.segments).to.have.length(1);
				Expect(tmpProject.Own.Compose.segments[0].valueTemplate).to.equal('{~D:Record.District~}{~D:Record.ProjectCode~}');
			}
		);
		test
		(
			'combinatorial own key: a user-typed pict template becomes the own segment verbatim (and wins over a single column)',
			() =>
			{
				const tmpConfig = { Prefix: 'UI', Entities: { Project: { Mode: 'prefixed', OwnKeyTemplate: '{~D:Record.District~}-{~D:Record.ProjectCode~}' } } };
				const tmpProject = libStrategy.compile(tmpConfig, { Catalog: CATALOG, SchemaSizes: SIZES }).Strategies.Project;
				Expect(tmpProject.Own.Compose.segments[0].valueTemplate).to.equal('{~D:Record.District~}-{~D:Record.ProjectCode~}');
				const tmpBoth = libStrategy.compile({ Prefix: 'UI', Entities: { Project: { OwnKeyColumn: 'X', OwnKeyTemplate: 'T{~D:Record.Y~}' } } }, { Catalog: CATALOG }).Strategies.Project;
				Expect(tmpBoth.Own.Compose.segments[0].valueTemplate).to.equal('T{~D:Record.Y~}');
			}
		);
		test
		(
			'composes the headline LineItem own GUID from context + own segments',
			() =>
			{
				const tmpLineItem = libStrategy.compile(CONFIG, { Catalog: CATALOG, SchemaSizes: SIZES }).Strategies.LineItem;
				const tmpSegments = tmpLineItem.Own.Compose.segments;
				Expect(tmpSegments).to.have.length(3);
				Expect(tmpSegments.map((s) => s.abbrev)).to.deep.equal([ 'C', 'P', 'LI' ]);
				// Resolve the templates against a sample row + run the composer → the headline string.
				const tmpRow = { ContractNum: '10', ProjectCode: '01278', LineId: '8675309' };
				const tmpResolved = tmpSegments.map((s) => ({ abbrev: s.abbrev, value: tmpRow[s.valueTemplate.replace('{~D:Record.', '').replace('~}', '')] }));
				Expect(libComposer.composeGUID({ prefix: 'UI', maxLength: 64, segments: tmpResolved })).to.equal('UI_C10_P01278_LI8675309');
			}
		);
		test
		(
			'a cross-session prefixed join emits `_GUID<Parent>` (async server lookup) + the parent compose spec',
			() =>
			{
				const tmpLineItem = libStrategy.compile(CONFIG, { Catalog: CATALOG, SchemaSizes: SIZES }).Strategies.LineItem;
				const tmpProjectJoin = tmpLineItem.Joins.find((j) => j.ParentEntity === 'Project');
				Expect(tmpProjectJoin.FieldName).to.equal('_GUIDProject');
				Expect(tmpProjectJoin.Compose.segments).to.deep.equal([ { abbrev: 'P', valueTemplate: '{~D:Record.ProjectCode~}' } ]);
				Expect(tmpProjectJoin.Compose.maxLength).to.equal(64);
			}
		);
		test
		(
			'join field-name selection covers all modes',
			() =>
			{
				Expect(libStrategy.joinFieldName('Project', 'prefixed', false)).to.equal('GUIDProject');   // same-upload, sync
				Expect(libStrategy.joinFieldName('Project', 'prefixed', true)).to.equal('_GUIDProject');    // cross-session, async
				Expect(libStrategy.joinFieldName('Project', 'raw', false)).to.equal('_GUIDProject');        // raw meadow GUID
				Expect(libStrategy.joinFieldName('Project', 'rawid', false)).to.equal('IDProject');         // raw id
			}
		);
		test
		(
			'a same-upload prefixed join emits sync `GUID<Parent>`',
			() =>
			{
				const tmpConfig = { Prefix: 'UI', Entities: { LineItem: { OwnKeyColumn: 'LineId', Joins: [ { ParentEntity: 'Project', Mode: 'prefixed', KeyColumn: 'ProjectCode', CrossSession: false } ] } } };
				const tmpJoin = libStrategy.compile(tmpConfig, { Catalog: CATALOG, SchemaSizes: SIZES }).Strategies.LineItem.Joins[0];
				Expect(tmpJoin.FieldName).to.equal('GUIDProject');
			}
		);
		test
		(
			'raw + rawid joins resolve a source column directly',
			() =>
			{
				const tmpConfig =
				{
					Entities:
					{
						LineItem:
						{
							OwnKeyColumn: 'LineId',
							Joins:
							[
								{ ParentEntity: 'Project', Mode: 'raw', GUIDColumn: 'ProjectGUID' },
								{ ParentEntity: 'Contract', Mode: 'rawid', IDColumn: 'ContractID' },
							],
						},
					},
				};
				const tmpJoins = libStrategy.compile(tmpConfig, { Catalog: CATALOG, SchemaSizes: SIZES }).Strategies.LineItem.Joins;
				Expect(tmpJoins[0]).to.deep.include({ FieldName: '_GUIDProject', Mode: 'raw', ValueTemplate: '{~D:Record.ProjectGUID~}' });
				Expect(tmpJoins[1]).to.deep.include({ FieldName: 'IDContract', Mode: 'rawid', ValueTemplate: '{~D:Record.ContractID~}' });
			}
		);
		test
		(
			'warns (does not throw) when an entity has no own-key column — the dup-on-reimport fallback',
			() =>
			{
				const tmpResult = libStrategy.compile({ Entities: { Widget: { Mode: 'prefixed' } } }, { Catalog: {}, SchemaSizes: {} });
				Expect(tmpResult.Warnings.join(' ')).to.match(/no own-key column/i);
				// still produces a usable strategy (derived abbreviation, unbounded length)
				Expect(tmpResult.Strategies.Widget.Own.FieldName).to.equal('GUIDWidget');
				Expect(tmpResult.Strategies.Widget.Own.Compose.segments[0].abbrev).to.equal('WID');
			}
		);
	}
);
