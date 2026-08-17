'use strict';

/**
 * Delete audit stamping for clone sync.
 *
 * FoxHound stamps the DeleteIDUser column from the QUERY (`query.IDUser`), never
 * from the record being written — and it skips DeleteDate/DeleteIDUser entirely
 * on UPDATE.  So propagating the source's deleting user into the clone means
 * lifting it off the source record and onto the delete query before doDelete.
 * Without that the clone records every propagated deletion as user 0.
 */

// Column name used when the entity's meadow schema doesn't type a DeleteIDUser
// column (the conventional name across the model).
const DEFAULT_DELETE_IDUSER_COLUMN = 'DeletingIDUser';

/**
 * Resolve the user id to stamp into the clone's DeleteIDUser column when
 * propagating an upstream deletion.
 *
 * @param {Array<object>} pMeadowSchema - the entity's meadow schema array (`Meadow.schema`)
 * @param {object} pSourceRecord - the server record being reconciled
 * @returns {number} a non-negative integer, safe to hand to FoxHound `setIDUser`
 */
function resolveDeletingIDUser(pMeadowSchema, pSourceRecord)
{
	if (!pSourceRecord)
	{
		return 0;
	}

	let tmpColumnName = DEFAULT_DELETE_IDUSER_COLUMN;

	if (Array.isArray(pMeadowSchema))
	{
		let tmpSchemaEntry = pMeadowSchema.find((pSchemaEntry) => { return pSchemaEntry && (pSchemaEntry.Type === 'DeleteIDUser'); });
		if (tmpSchemaEntry && tmpSchemaEntry.Column)
		{
			tmpColumnName = tmpSchemaEntry.Column;
		}
	}

	let tmpDeletingIDUser = parseInt(pSourceRecord[tmpColumnName], 10);

	if (!Number.isInteger(tmpDeletingIDUser) || (tmpDeletingIDUser < 0))
	{
		return 0;
	}

	return tmpDeletingIDUser;
}

module.exports = {
	DEFAULT_DELETE_IDUSER_COLUMN: DEFAULT_DELETE_IDUSER_COLUMN,
	resolveDeletingIDUser: resolveDeletingIDUser
};
