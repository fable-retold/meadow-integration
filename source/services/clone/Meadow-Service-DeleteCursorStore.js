/**
 * Meadow Delete Cursor Store
 *
 * Tiny JSON-file store for the resumable delete-sync cursor.  One file holds a
 * map keyed by table name; each entry is a few numbers (head/tail marks + a
 * caught-up flag + a last-sweep timestamp).  Deliberately NOT a database: the
 * payload is trivial, there is a single writer (the headless run is sequential),
 * and a human-readable file is easy to inspect and mount on a volume.
 *
 * The file must live on a path that survives between runs/containers for the
 * cursor to actually advance; if it doesn't, every load returns empty and the
 * delete sync simply falls back to a full sweep (safe, just not incremental).
 *
 * All operations are best-effort and never throw to the caller: a missing or
 * corrupt file reads as "no state" so the sync degrades to a full sweep rather
 * than failing.  Writes are atomic (temp file + rename) and merge-preserve other
 * tables' entries.
 *
 * @typedef {Object} DeleteCursorState
 * @property {number} HeadID        Highest deleted id already covered from the top (0 = not yet established).
 * @property {?number} TailID       Resume point for the downward catch-up sweep (null = sweep from the top).
 * @property {boolean} CaughtUp     True once the tail has drained to the bottom of the deleted set.
 * @property {number} LastSweepEpoch Epoch ms when the last full sweep completed (for the re-sweep cadence).
 */
const libFS = require('fs');
const libPath = require('path');

class MeadowDeleteCursorStore
{
	/**
	 * @param {string} pStatePath - Filesystem path to the JSON state file.
	 * @param {Object} [pLog] - Optional logger ({ warn }) for surfacing write failures.
	 */
	constructor(pStatePath, pLog)
	{
		this.statePath = pStatePath;
		this.log = pLog || null;
	}

	/**
	 * Read the entire state map. Missing/corrupt file → {} (graceful).
	 * @return {Object<string, DeleteCursorState>}
	 */
	readAll()
	{
		try
		{
			const tmpRaw = libFS.readFileSync(this.statePath, 'utf8');
			const tmpParsed = JSON.parse(tmpRaw);
			return (tmpParsed && typeof(tmpParsed) === 'object') ? tmpParsed : {};
		}
		catch (pError)
		{
			// ENOENT (first run) and parse errors both degrade to "no state".
			if (this.log && pError && pError.code !== 'ENOENT')
			{
				this.log.warn(`Delete cursor state unreadable at [${this.statePath}] (${pError.message}); treating as empty (full sweep).`);
			}
			return {};
		}
	}

	/**
	 * Get one table's cursor state, or null if none recorded.
	 * @param {string} pTableName
	 * @return {?DeleteCursorState}
	 */
	get(pTableName)
	{
		const tmpAll = this.readAll();
		return Object.prototype.hasOwnProperty.call(tmpAll, pTableName) ? tmpAll[pTableName] : null;
	}

	/**
	 * Persist one table's cursor state, preserving all other tables' entries.
	 * Atomic (temp + rename). Returns true on success, false on failure (never throws).
	 * @param {string} pTableName
	 * @param {DeleteCursorState} pState
	 * @return {boolean}
	 */
	set(pTableName, pState)
	{
		try
		{
			const tmpAll = this.readAll();
			tmpAll[pTableName] = pState;

			libFS.mkdirSync(libPath.dirname(this.statePath), { recursive: true });
			const tmpTempPath = `${this.statePath}.${process.pid}.tmp`;
			libFS.writeFileSync(tmpTempPath, JSON.stringify(tmpAll, null, '\t'), 'utf8');
			libFS.renameSync(tmpTempPath, this.statePath);
			return true;
		}
		catch (pError)
		{
			if (this.log)
			{
				this.log.warn(`Could not persist delete cursor for [${pTableName}] at [${this.statePath}] (${pError && pError.message}); progress will not carry to the next run.`);
			}
			return false;
		}
	}
}

module.exports = MeadowDeleteCursorStore;
