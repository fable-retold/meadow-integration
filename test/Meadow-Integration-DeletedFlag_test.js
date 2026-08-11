/*
	Unit tests for the integration adapter's Deleted-flag predicate.

	A source record's `Deleted` value arrives in whatever shape the source produced: MySQL's tinyint
	comes through mysql2 as 1/0, PostgreSQL gives a real boolean, and anything that has been through
	JSON, a CSV, a spreadsheet or a template arrives as the string "1".

	The adapter used to test `Deleted === true`, which honoured only one of those. Every other
	representation was silently treated as a live record — an upsert instead of a delete, reported as
	success. These tests pin the widened predicate, and pin just as hard that it did NOT become
	loosely truthy: a record must never turn into a delete by accident.
*/

const Chai = require('chai');
const Expect = Chai.expect;

const libIntegrationAdapter = require('../source/Meadow-Service-Integration-Adapter.js');

const isDeletedFlagSet = libIntegrationAdapter.isDeletedFlagSet;

suite
(
	'Meadow Integration Adapter - Deleted flag',
	() =>
	{
		suite
		(
			'representations that mean DELETED',
			() =>
			{
				test
				(
					'a real boolean, as PostgreSQL and any in-process caller produce',
					() =>
					{
						Expect(isDeletedFlagSet(true)).to.equal(true);
					}
				);
				test
				(
					'the number 1, as MySQL tinyint arrives through mysql2',
					() =>
					{
						Expect(isDeletedFlagSet(1)).to.equal(true);
					}
				);
				test
				(
					'any non-zero number, because tinyint is not constrained to 0 and 1',
					() =>
					{
						Expect(isDeletedFlagSet(2)).to.equal(true);
						Expect(isDeletedFlagSet(-1)).to.equal(true);
					}
				);
				test
				(
					'the string "1", as JSON, CSV, a spreadsheet cell or a template produces',
					() =>
					{
						Expect(isDeletedFlagSet('1')).to.equal(true);
					}
				);
				test
				(
					'the string "true", in any casing, and with surrounding whitespace',
					() =>
					{
						Expect(isDeletedFlagSet('true')).to.equal(true);
						Expect(isDeletedFlagSet('TRUE')).to.equal(true);
						Expect(isDeletedFlagSet('  True  ')).to.equal(true);
					}
				);
				test
				(
					'the abbreviations a human or a spreadsheet dropdown produces',
					() =>
					{
						Expect(isDeletedFlagSet('t')).to.equal(true);
						Expect(isDeletedFlagSet('y')).to.equal(true);
						Expect(isDeletedFlagSet('YES')).to.equal(true);
					}
				);
			}
		);

		suite
		(
			'representations that mean NOT deleted',
			() =>
			{
				test
				(
					'the falsy scalars, in every shape',
					() =>
					{
						Expect(isDeletedFlagSet(false)).to.equal(false);
						Expect(isDeletedFlagSet(0)).to.equal(false);
						Expect(isDeletedFlagSet('0')).to.equal(false);
						Expect(isDeletedFlagSet('false')).to.equal(false);
						Expect(isDeletedFlagSet('FALSE')).to.equal(false);
						Expect(isDeletedFlagSet('n')).to.equal(false);
						Expect(isDeletedFlagSet('no')).to.equal(false);
					}
				);
				test
				(
					'an empty or whitespace string, which is what a blank cell becomes',
					() =>
					{
						Expect(isDeletedFlagSet('')).to.equal(false);
						Expect(isDeletedFlagSet('   ')).to.equal(false);
					}
				);
				test
				(
					'an absent, null or undefined property — the overwhelmingly common case',
					() =>
					{
						Expect(isDeletedFlagSet(undefined)).to.equal(false);
						Expect(isDeletedFlagSet(null)).to.equal(false);
						Expect(isDeletedFlagSet(({}).Deleted)).to.equal(false);
					}
				);
				test
				(
					'a non-scalar, which no storage layer means as a flag',
					() =>
					{
						Expect(isDeletedFlagSet({})).to.equal(false);
						Expect(isDeletedFlagSet([])).to.equal(false);
						Expect(isDeletedFlagSet(new Date())).to.equal(false);
					}
				);
				test
				(
					'an arbitrary string is NOT a delete — the predicate is a whitelist, not truthiness',
					() =>
					{
						// This is the property that keeps the change safe: widening the SET side must
						// not make a record deletable by carrying any old value in the column.
						Expect(isDeletedFlagSet('deleted')).to.equal(false);
						Expect(isDeletedFlagSet('Deleted')).to.equal(false);
						Expect(isDeletedFlagSet('2026-08-11')).to.equal(false);
						Expect(isDeletedFlagSet('null')).to.equal(false);
					}
				);
			}
		);

		suite
		(
			'the regression this replaces',
			() =>
			{
				test
				(
					'a string "1" routes to the delete pass, where === true did not',
					() =>
					{
						// The comprehension loader projects every value as a string literal, so a
						// retirement pass emits Deleted: "1". Under the old strict check that was an
						// ordinary upsert: the record landed live, the load reported success, and the
						// retirement silently did nothing. Measured against 29,332 records.
						Expect(isDeletedFlagSet('1')).to.equal(true);
						Expect('1' === true).to.equal(false);
					}
				);
			}
		);
	}
);
