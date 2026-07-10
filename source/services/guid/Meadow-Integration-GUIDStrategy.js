// Meadow-Integration-GUIDStrategy — compiles a high-level, per-entity GUID strategy into the structured
// spec the transform consumes (which `Service-TabularTransform.createRecordFromMapping` resolves per row
// via the GUID composer). This is the configurable brain behind context-aware import GUIDs.
//
// It does NOT touch fable or the DOM and produces only plain data (segment value-TEMPLATES, field names,
// length budgets) — so it is reusable by the CLI, the server endpoints, and the browser import wizard
// alike, and is trivially unit-testable.
//
// Three modes per entity AND per join, mapped onto the adapter's existing FK conventions:
//   - prefixed (default): compose `UI_<context…>_<own>`; own → `GUID<Entity>`. A join to a parent that
//       was uploaded in THIS run → `GUID<Parent>` (sync session GUIDMap); a join to a PRE-EXISTING parent
//       (crossSession) → `_GUID<Parent>` (async server `getEntityByGUID` lookup).
//   - raw: the source already carries a true Meadow GUID → `_GUID<Parent>` (join) / `GUID<Entity>` (own).
//   - rawid: the source already carries a real `ID<Parent>` → used directly.

const _DEFAULT_PREFIX = 'UI';
const _DEFAULT_SEPARATOR = '_';
const _DEFAULT_HASH_LENGTH = 10;

/** A `{~D:Record.<column>~}` value template (what the transform resolves per row). */
function valueTemplate(pColumn)
{
	return `{~D:Record.${pColumn}~}`;
}

/**
 * The value template for an entity's OWN key segment — the combinatorial-GUID input. Three shapes, in
 * precedence order: a user-typed pict template `OwnKeyTemplate` (any expression, e.g.
 * `{~D:Record.A~}-{~D:Record.B~}`); multiple columns `OwnKeyColumns` concatenated into one segment; or a
 * single `OwnKeyColumn` (the original behavior). The transform resolves the whole string per row via
 * fable's parseTemplate, so multiple `{~D:Record.X~}` tags in one segment just work.
 * @param {Record<string, any>} pEntityConfig
 * @returns {string}
 */
function ownValueTemplate(pEntityConfig)
{
	const tmpConfig = pEntityConfig || {};
	if (tmpConfig.OwnKeyTemplate)
	{
		return String(tmpConfig.OwnKeyTemplate);
	}
	if (Array.isArray(tmpConfig.OwnKeyColumns) && (tmpConfig.OwnKeyColumns.length > 0))
	{
		return tmpConfig.OwnKeyColumns.map((pColumn) => valueTemplate(pColumn)).join('');
	}
	if (tmpConfig.OwnKeyColumn)
	{
		return valueTemplate(tmpConfig.OwnKeyColumn);
	}
	return '';
}

/** Derive a short uppercase abbreviation for an entity with no catalog entry (initials / first letters). */
function _deriveAbbreviation(pEntityName)
{
	const tmpName = String(pEntityName || '');
	const tmpCapitals = tmpName.replace(/[^A-Z]/g, '');
	if (tmpCapitals.length >= 2)
	{
		return tmpCapitals.slice(0, 3);
	}
	return tmpName.slice(0, 3).toUpperCase();
}

/**
 * @param {string} pEntityName @param {Record<string, any>} pContext
 * @returns {string} the host-fixed abbreviation (catalog) or a derived fallback
 */
function abbreviationFor(pEntityName, pContext)
{
	const tmpCatalog = (pContext && pContext.Catalog) || {};
	const tmpEntry = tmpCatalog[pEntityName];
	if (tmpEntry && tmpEntry.Abbrev)
	{
		return String(tmpEntry.Abbrev);
	}
	return _deriveAbbreviation(pEntityName);
}

/**
 * The GUID column width for an entity, or 0 (unbounded) if unknown.
 *
 * Prefers the live schema width (`SchemaSizes`, populated for the entity actually being imported), then
 * falls back to the host catalog's declared `GUIDSize`. The fallback is LOAD-BEARING for JOIN compose:
 * when a child references a parent (e.g. Product → Material), only the CHILD's schema is loaded, so
 * `SchemaSizes` has no entry for the parent. Without the catalog width the parent's foreign-key GUID is
 * composed unbounded (never hashed) while the parent's OWN GUID was hashed to fit its column — so a long
 * key makes the two diverge and the cross-session match silently breaks. The catalog `GUIDSize` MUST
 * therefore match the parent's real GUID column width for long keys to resolve.
 */
function _maxLengthFor(pEntityName, pContext)
{
	const tmpSizes = (pContext && pContext.SchemaSizes) || {};
	const tmpSchemaSize = Number(tmpSizes[pEntityName] || 0);
	if (tmpSchemaSize > 0)
	{
		return tmpSchemaSize;
	}
	const tmpCatalog = (pContext && pContext.Catalog) || {};
	const tmpEntry = tmpCatalog[pEntityName];
	const tmpCatalogSize = tmpEntry ? Number(tmpEntry.GUIDSize || 0) : 0;
	return (tmpCatalogSize > 0) ? tmpCatalogSize : 0;
}

/** Build a compose spec (prefix + ordered segments + length budget) for an entity's fullGUID. */
function _composeSpec(pEntityName, pSegments, pContext)
{
	return {
		prefix: (pContext && (pContext.Prefix !== undefined)) ? pContext.Prefix : _DEFAULT_PREFIX,
		separator: (pContext && pContext.Separator) || _DEFAULT_SEPARATOR,
		hashLength: (pContext && pContext.HashLength) || _DEFAULT_HASH_LENGTH,
		maxLength: _maxLengthFor(pEntityName, pContext),
		segments: pSegments,
	};
}

/**
 * The ordered context + own segments for an entity's OWN fullGUID.
 * @returns {{segments:Array<any>, warnings:Array<string>}}
 */
function _ownSegments(pEntityName, pEntityConfig, pContext)
{
	const tmpWarnings = [];
	const tmpSegments = [];
	const tmpContextEntities = Array.isArray(pEntityConfig.ContextEntities) ? pEntityConfig.ContextEntities : [];
	const tmpContextKeyColumns = pEntityConfig.ContextKeyColumns || {};

	tmpContextEntities.forEach((pParentEntity) =>
	{
		const tmpKeyColumn = tmpContextKeyColumns[pParentEntity];
		if (!tmpKeyColumn)
		{
			tmpWarnings.push(`Context entity "${pParentEntity}" for "${pEntityName}" has no key column mapped — its segment will be empty.`);
		}
		tmpSegments.push({ abbrev: abbreviationFor(pParentEntity, pContext), valueTemplate: tmpKeyColumn ? valueTemplate(tmpKeyColumn) : '' });
	});

	const tmpOwnValue = ownValueTemplate(pEntityConfig);
	if (!tmpOwnValue)
	{
		tmpWarnings.push(`"${pEntityName}" has no own-key column mapped — its GUID cannot be stable, so re-imports will create duplicates. Map a natural-key column (e.g. a code), several columns, or a template.`);
	}
	tmpSegments.push({ abbrev: abbreviationFor(pEntityName, pContext), valueTemplate: tmpOwnValue });

	return { segments: tmpSegments, warnings: tmpWarnings };
}

/** Compile the OWN GUID descriptor (field name + compose spec / raw template) for one entity. */
function _compileOwn(pEntityName, pEntityConfig, pContext)
{
	const tmpGUIDName = `GUID${pEntityName}`;
	const tmpMode = pEntityConfig.Mode || 'prefixed';

	if (tmpMode === 'raw')
	{
		// Source carries a true Meadow GUID; with empty marshal prefixes it passes through GUID<Entity>.
		return { Own: { Mode: 'raw', FieldName: tmpGUIDName, ValueTemplate: valueTemplate(pEntityConfig.OwnGUIDColumn || pEntityConfig.OwnKeyColumn) }, warnings: [] };
	}
	if (tmpMode === 'rawid')
	{
		// rawid OWN is deferred: the comprehension is keyed by GUID<Entity>, so an ID-only own record has
		// no comprehension key. Use a join in rawid mode instead, or import such sheets via the raw path.
		return { Own: { Mode: 'prefixed', FieldName: tmpGUIDName, Compose: _composeSpec(pEntityName, _ownSegments(pEntityName, pEntityConfig, pContext).segments, pContext) },
			warnings: [ `"${pEntityName}" requested raw-ID own mode, which is not yet supported for the entity's own GUID — fell back to prefixed.` ] };
	}

	// prefixed (default)
	const tmpOwn = _ownSegments(pEntityName, pEntityConfig, pContext);
	return { Own: { Mode: 'prefixed', FieldName: tmpGUIDName, Compose: _composeSpec(pEntityName, tmpOwn.segments, pContext) }, warnings: tmpOwn.warnings };
}

/** The FK field name for a join, per the adapter's conventions. */
function joinFieldName(pParentEntity, pMode, pCrossSession)
{
	if (pMode === 'rawid')
	{
		return `ID${pParentEntity}`;
	}
	if (pMode === 'raw')
	{
		return `_GUID${pParentEntity}`;
	}
	// prefixed: sync (same-upload) vs async server lookup (pre-existing parent)
	return pCrossSession ? `_GUID${pParentEntity}` : `GUID${pParentEntity}`;
}

/** Compile one join (FK) descriptor for an entity. */
function _compileJoin(pParentEntity, pJoin, pContext)
{
	const tmpMode = pJoin.Mode || 'prefixed';
	const tmpCrossSession = !!pJoin.CrossSession;
	const tmpFieldName = joinFieldName(pParentEntity, tmpMode, tmpCrossSession);
	const tmpWarnings = [];

	if (tmpMode === 'raw' || tmpMode === 'rawid')
	{
		const tmpColumn = pJoin.GUIDColumn || pJoin.IDColumn || pJoin.KeyColumn;
		if (!tmpColumn)
		{
			tmpWarnings.push(`Join "${pParentEntity}" (${tmpMode}) has no source column mapped.`);
		}
		return { Join: { ParentEntity: pParentEntity, Mode: tmpMode, FieldName: tmpFieldName, ValueTemplate: tmpColumn ? valueTemplate(tmpColumn) : '' }, warnings: tmpWarnings };
	}

	// prefixed: recompute the PARENT's fullGUID from this row's columns (so it matches the parent's own GUID).
	if (!pJoin.KeyColumn)
	{
		tmpWarnings.push(`Join "${pParentEntity}" (prefixed) has no parent key column mapped — the foreign key will not resolve.`);
	}
	const tmpParentContextEntities = Array.isArray(pJoin.ContextEntities) ? pJoin.ContextEntities : [];
	const tmpParentContextKeyColumns = pJoin.ContextKeyColumns || {};
	const tmpSegments = tmpParentContextEntities.map((pGrandparent) => (
		{ abbrev: abbreviationFor(pGrandparent, pContext), valueTemplate: tmpParentContextKeyColumns[pGrandparent] ? valueTemplate(tmpParentContextKeyColumns[pGrandparent]) : '' }));
	tmpSegments.push({ abbrev: abbreviationFor(pParentEntity, pContext), valueTemplate: pJoin.KeyColumn ? valueTemplate(pJoin.KeyColumn) : '' });

	return { Join: { ParentEntity: pParentEntity, Mode: 'prefixed', FieldName: tmpFieldName, Compose: _composeSpec(pParentEntity, tmpSegments, pContext) }, warnings: tmpWarnings };
}

/**
 * Compile one entity's strategy (own GUID + joins).
 * @param {string} pEntityName @param {Record<string, any>} pEntityConfig @param {Record<string, any>} pContext
 * @returns {{Strategy:Record<string, any>, Warnings:Array<string>}}
 */
function compileEntity(pEntityName, pEntityConfig, pContext)
{
	const tmpConfig = pEntityConfig || {};
	const tmpWarnings = [];

	const tmpOwn = _compileOwn(pEntityName, tmpConfig, pContext);
	tmpWarnings.push(...tmpOwn.warnings);

	const tmpJoins = [];
	(Array.isArray(tmpConfig.Joins) ? tmpConfig.Joins : []).forEach((pJoin) =>
	{
		if (!pJoin || !pJoin.ParentEntity) { return; }
		const tmpCompiled = _compileJoin(pJoin.ParentEntity, pJoin, pContext);
		tmpJoins.push(tmpCompiled.Join);
		tmpWarnings.push(...tmpCompiled.warnings);
	});

	return {
		Strategy: { Entity: pEntityName, GUIDName: `GUID${pEntityName}`, Own: tmpOwn.Own, Joins: tmpJoins },
		Warnings: tmpWarnings,
	};
}

/**
 * Compile a whole import's GUID strategy.
 * @param {Record<string, any>} pConfig - { Prefix?, Separator?, HashLength?, Entities:{ <name>: <entityConfig> } }
 * @param {Record<string, any>} pContext - { Catalog:{ <entity>:{Abbrev,KeyField} }, SchemaSizes:{ <entity>:size } }
 * @returns {{Strategies:Record<string, any>, Warnings:Array<string>}}
 */
function compile(pConfig, pContext)
{
	const tmpConfig = pConfig || {};
	const tmpContext = Object.assign(
		{
			Prefix: (tmpConfig.Prefix !== undefined) ? tmpConfig.Prefix : _DEFAULT_PREFIX,
			Separator: tmpConfig.Separator || _DEFAULT_SEPARATOR,
			HashLength: tmpConfig.HashLength || _DEFAULT_HASH_LENGTH,
		},
		pContext || {});

	const tmpEntities = tmpConfig.Entities || {};
	const tmpStrategies = {};
	const tmpWarnings = [];
	Object.keys(tmpEntities).forEach((pEntityName) =>
	{
		const tmpCompiled = compileEntity(pEntityName, tmpEntities[pEntityName], tmpContext);
		tmpStrategies[pEntityName] = tmpCompiled.Strategy;
		tmpWarnings.push(...tmpCompiled.Warnings);
	});

	return { Strategies: tmpStrategies, Warnings: tmpWarnings };
}

module.exports = {
	compile,
	compileEntity,
	joinFieldName,
	abbreviationFor,
	valueTemplate,
	ownValueTemplate,
};
