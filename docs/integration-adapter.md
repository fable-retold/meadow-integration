# Integration Adapter

The Integration Adapter is the bridge between comprehension data and a running Meadow REST API.  It handles record marshaling, GUID generation, schema validation, batch operations, progress tracking, and retry logic.

## Overview

```
Source Records (from comprehension or external system)
        |
        v
    addSourceRecord()
        |
        v
    marshalRecord()  -- map external GUIDs to Meadow GUIDs
                     -- resolve _GUID fields via async server lookup
                     -- validate against Meadow schema
                     -- truncate strings to schema limits
                     -- strip reserved fields (CreateDate, etc.)
        |
        v
    pushRecordsToServer()  -- single or bulk upsert
                           -- automatic retry on failure
                           -- per-entity progress tracking
                           -- meta (cross-entity) progress tracking
        |
        v
    GUIDMap updated  -- Meadow IDs stored for cross-entity lookups
```

## REST Client Injection

The adapter supports flexible REST client injection. You can provide a client in three ways:

1. **Explicit injection** via `setRestClient(pClient)` or `options.Client`
2. **Auto-resolved** from `fable.MeadowCloneRestClient` (used by the CLI command)
3. **Legacy fallback** from `fable.EntityProvider` (backwards compatible)

```javascript
const adapter = libAdapter.getAdapter(myFable, 'Book', 'BK');
adapter.setRestClient(myFable.MeadowCloneRestClient);
```

The client should expose: `upsertEntity`, `upsertEntities`, `getEntityByGUID`, `getEntity`, `deleteEntity`, and `getJSON`.

## GUID Marshaling

External system GUIDs are transformed into deterministic Meadow GUIDs using this pattern:

```
{AdapterSetGUIDMarshalPrefix}-{EntityGUIDMarshalPrefix}-{ExternalGUID}
```

For example, with default settings and entity "Book":

```
External GUID: "12345"
Meadow GUID:   "INTG-DEF-E-Book-12345"
```

This ensures GUIDs are unique across integration sets and entities.

### GUID Length Validation

The adapter validates that generated GUIDs do not exceed the server's GUID column size. The maximum length is resolved from (in order):

1. **Explicit `GUIDMaxLength` option** -- positive integer overrides everything
2. **`GUIDColumnSizes` map** -- per-entity sizes passed in options (e.g. from a schema build step)
3. **Live server schema** -- fetched via `GET /Entity/Schema` by `loadSchema()`
4. **`DefaultGUIDColumnSize`** -- fallback (default: 36)

`integrateRecords()` calls `loadSchema()` before it marshals, so the schema-derived width is in place by the time GUIDs are checked. **Consumers that drive `marshalSourceRecords()` / `pushRecordsToServer()` themselves must call `loadSchema()` first** -- otherwise every entity is checked against `DefaultGUIDColumnSize` (36), which is narrower than most GUID columns and has nothing to do with the real one. `loadSchema()` is idempotent.

The width is read from `properties[GUID<Entity>].size` on the schema document (the shape meadow-endpoints returns), falling back to a `MeadowSchema.Schema` or top-level `Columns` array for other meadow-compatible servers.

When a GUID exceeds the maximum length:

- **Default behavior** (`AllowGUIDTruncation: false`): Throws an error showing the GUID, prefix, limit, and which of the four sources above the limit came from. When the limit is the unresolved `DefaultGUIDColumnSize`, the message says so explicitly -- that number is not the column's width.
- **Truncation mode** (`AllowGUIDTruncation: true`): The prefix is progressively truncated to fit while preserving the full external GUID. Use this for one-time imports where GUID stability is not required.

### Cross-Entity GUID Resolution

When a source record contains GUID fields for other entities, the adapter resolves them to Meadow IDs:

#### External GUIDs (`GUIDEntityName`)

Fields starting with `GUID` (without underscore) are treated as external system GUIDs. The adapter looks up the corresponding Meadow ID from the session's local External GUID Map:

```javascript
// Source: { GUIDBookAuthorJoin: "BAJ_1", GUIDBook: "Book_1", GUIDAuthor: "Author_5" }
// Adapter resolves:
//   GUIDBook "Book_1" -> ExternalGUIDMap -> Meadow GUID -> GUIDMap -> IDBook: 42
//   GUIDAuthor "Author_5" -> ExternalGUIDMap -> Meadow GUID -> GUIDMap -> IDAuthor: 17
```

This requires the referenced entity to have been integrated earlier in the same session.

#### Meadow GUIDs (`_GUIDEntityName`)

Fields starting with `_GUID` (underscore prefix) are treated as Meadow GUIDs that may already exist on the server. The adapter performs an **async server API lookup** via `getIDFromGUIDAsync`:

```javascript
// Source: { GUIDProduct: "Prod_1", _GUIDMaterial: "LADOTD-Material-9999M99999" }
// Adapter resolves:
//   _GUIDMaterial -> async GET /Material/By/GUIDMaterial/LADOTD-Material-9999M99999 -> IDMaterial: 5012
```

Use this for records that reference entities already on the server but not pushed in the current session.

#### Destination Field Overrides (`_Dest_IDEntity_*_Via_*`)

For explicit control over which ID field a resolved GUID maps to:

```javascript
// Source: { "_Dest_IDEntity_IDCustomField_Via_GUIDMaterial": "some-guid-value" }
// Adapter resolves the GUID via server lookup and sets:
//   record.IDCustomField = resolvedID
```

This is useful when the foreign key column name doesn't follow the standard `ID{EntityName}` pattern.

## Batch Processing

The adapter automatically switches between single and bulk upsert modes:

- **Below threshold** (`< RecordThresholdForBulkUpsert`, default 1000): Records are upserted one at a time
- **Above threshold**: Records are batched into groups of `BulkUpsertBatchSize` (default 100) and sent as bulk upserts

## Retry Logic

Failed upsert operations are retried up to `RecordPushRetryThreshold` times (default 5), with a hard cap of 50 retries. The adapter validates server responses to confirm:

1. The response contains the entity ID field
2. The ID is a positive number
3. The response GUID matches the sent GUID

If validation fails, the record is retried. Specific error types are handled without retry:

- **Duplicate entry errors** -- Logged as warnings and skipped
- **GUID length rejections** -- Logged as errors and skipped
- **Server create rejections** -- Logged as errors and skipped

When the retry threshold is exhausted, the adapter attempts a fallback read of the record by GUID to populate the GUID-to-ID mapping even if the upsert failed.

## Progress Tracking

### Per-Entity Progress

Every entity push creates a progress tracker via `fable.ProgressTrackerSet`. The tracker logs status at each record (single mode) or each batch (bulk mode).

### Meta Progress

For cross-entity progress tracking across an entire comprehension push, callers can set:

```javascript
adapter.MetaProgressTrackerHash = myTrackerHash;
adapter.MetaProgressTrackerLogInterval = 500; // log every ~500 records
```

The meta tracker uses a threshold-crossing interval check rather than exact modulo, so bulk increments (e.g. +100 per batch) reliably trigger logging when they cross an interval boundary.

## Schema Validation

When `integrateRecords()` is called, the adapter fetches the entity schema from the Meadow API (`GET /Entity/Schema`).  During marshaling:

- String fields are truncated to their schema-defined `size`
- Non-string fields are passed through
- When `SimpleMarshal` is true, all schema-matched fields are passed through without type coercion
- When `ForceMarshal` is true, fields not found in the schema are still included
- Reserved fields (`CreateDate`, `UpdateDate`, `Deleted`, `DeleteDate`) are always stripped

## Delete Operations

Records with `Deleted: true` in the source are queued for deletion.  The adapter looks up each record by GUID via the API, then issues a DELETE request using the Meadow ID.

## CLI Usage

The `load_comprehension` command wraps the Integration Adapter for CLI use:

```shell
npx meadow-integration load_comprehension ./my-comprehension.json \
  --api_server "https://api.example.com/1.0/" \
  --api_username "admin" \
  --api_password "admin_password" \
  --prefix "MY-PREFIX" \
  --batchsize 200 \
  --metaprogressinterval 500
```

This automatically creates adapters for every entity in the comprehension, injects the REST client and SessionManager credentials, and processes entities in sequence.

See [Comprehension Push Configuration](comprehension-push/configuration.md) for full CLI options and configuration details.

## Programmatic Usage

```javascript
const libMeadowIntegration = require('meadow-integration');
const libFable = require('fable');

let myFable = new libFable({ /* ... */ });

// Register the adapter service type
myFable.serviceManager.addServiceType('IntegrationAdapter',
    libMeadowIntegration.IntegrationAdapter);

// Get or create an adapter for 'Book'
let bookAdapter = libMeadowIntegration.IntegrationAdapter.getAdapter(
    myFable, 'Book', 'BK', { SimpleMarshal: true, ForceMarshal: true });

// Inject a REST client
bookAdapter.setRestClient(myRestClient);

// Add source records
bookAdapter.addSourceRecord({ GUIDBook: "Book_1", Title: "The Hunger Games" });
bookAdapter.addSourceRecord({ GUIDBook: "Book_2", Title: "Harry Potter" });

// Integrate (fetch schema, marshal, push)
bookAdapter.integrateRecords((pError) =>
{
    if (pError)
    {
        console.error('Integration failed:', pError);
        return;
    }
    console.log('Books integrated successfully.');
});
```

## Static Helper

The `getAdapter()` static method provides a convenient way to get or create an adapter:

```javascript
const libAdapter = require('meadow-integration').IntegrationAdapter;

// Gets existing adapter for 'Book' or creates a new one
let tmpAdapter = libAdapter.getAdapter(myFable, 'Book', 'BK');

// With custom options (e.g. SimpleMarshal, ForceMarshal, AllowGUIDTruncation)
let tmpAdapter = libAdapter.getAdapter(myFable, 'Book', 'BK',
    { SimpleMarshal: true, ForceMarshal: true, AllowGUIDTruncation: true });
```

## Adapter Options Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `Entity` | string | `"DefaultEntity"` | The Meadow entity name |
| `AdapterSetGUIDMarshalPrefix` | string or false | `false` (falls back to `"INTG-DEF"`) | Prefix for the adapter set in generated GUIDs |
| `EntityGUIDMarshalPrefix` | string or false | `false` (auto: `"E-{Entity}"`) | Per-entity prefix in generated GUIDs |
| `GUIDMaxLength` | number | `0` (auto-detect) | Maximum GUID length; 0 = resolve from schema |
| `GUIDColumnSizes` | object | `{}` | Per-entity GUID column sizes (entity name -> max size) |
| `DefaultGUIDColumnSize` | number | `36` | Fallback GUID column size, used only until `loadSchema()` resolves the real one |
| `AllowGUIDTruncation` | boolean | `false` | Allow prefix truncation for oversized GUIDs |
| `SimpleMarshal` | boolean | `false` | Pass through schema-matched fields without type coercion |
| `ForceMarshal` | boolean | `false` | Include fields not found in schema |
| `PerformUpserts` | boolean | `true` | Enable upsert operations |
| `PerformDeletes` | boolean | `true` | Enable delete operations |
| `RecordPushRetryThreshold` | number | `5` | Max retries per record/batch |
| `RecordThresholdForBulkUpsert` | number | `1000` | Record count above which bulk mode is used |
| `BulkUpsertBatchSize` | number | `100` | Records per bulk upsert batch |
| `ProgressLogInterval` | number | `100` | Per-entity progress log interval |
| `Client` | object | `null` | REST client instance (alternative to `setRestClient()`) |
