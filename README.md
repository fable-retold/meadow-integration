# Meadow Integration

> **[Read the Meadow-Integration Documentation](https://fable-retold.github.io/meadow-integration/)** - interactive docs with the full API reference.

A suite of tools for managing data into a centralized non-specific schema format called a **Comprehension**.

These tools are built to be usable from the command-line, as a web service, or within your own codebase.  This module presents these behaviors both as a suite of externally usable fable services, a command-line utility to use them and a set of web service behaviors.

## What is a Comprehension?

A Comprehension is a JSON object that stores entity records keyed by their GUID.  It acts as an intermediate format for integrating records from external systems (CSV, TSV, JSON) into Meadow entities.

```json
{
  "Book": {
    "Book_1": { "GUIDBook": "Book_1", "Title": "The Hunger Games", "Language": "eng" },
    "Book_2": { "GUIDBook": "Book_2", "Title": "Harry Potter", "Language": "eng" }
  }
}
```

## Quick Start

```shell
npm install
```

### Analyze a CSV

```shell
npm start -- csvcheck ./docs/examples/data/books.csv -o stats.json
```

### Transform a CSV into a Comprehension

```shell
npm start -- csvtransform ./docs/examples/data/books.csv \
  -e "Book" -n "GUIDBook" -g "Book_{~D:Record.id~}" \
  -o books.json
```

### Use a Mapping File

```shell
npm start -- csvtransform ./docs/examples/data/books.csv \
  -m ./docs/examples/bookstore/mapping_books_Book.json \
  -o books.json
```

### Merge Multiple Data Sources

```shell
npm start -- comprehensionintersect Set1.json -i Set2.json -e "MyEntity" -o merged.json
```

### Clone Data from a Remote API

```shell
npm start -- data-clone \
  --api_server "https://my-meadow-api.example.com/1.0/" \
  --api_username admin --api_password secret \
  --db_host 127.0.0.1 --db_name my_local_db \
  --schema_path ./schema/Model-Extended.json
```

## CLI Commands

| Command | Aliases | Description |
|---------|---------|-------------|
| `csvcheck` | | Analyze a CSV file for statistics |
| `csvtransform` | | Transform a CSV into a comprehension |
| `tsvtransform` | | Transform a TSV into a comprehension |
| `jsonarraytransform` | | Transform a JSON array into a comprehension |
| `comprehensionintersect` | | Merge two comprehension files |
| `comprehensionarray` | | Convert object comprehension to array |
| `objectarraytocsv` | | Export a JSON array to CSV |
| `load_comprehension` | | Push a comprehension to Meadow REST APIs |
| `data-clone` | `clone`, `sync` | Clone data from a Meadow API to a local database |
| `serve` | | Start the REST API server |

## REST API Server

Start the integration server to access all commands as HTTP endpoints:

```shell
npm start -- serve
npm start -- serve -p 3000
```

Then call any endpoint with `curl` or your HTTP client of choice:

```shell
# Analyze a CSV
curl -X POST http://localhost:8086/1.0/CSV/Check \
  -H "Content-Type: application/json" \
  -d '{ "File": "/absolute/path/to/books.csv" }'

# Transform records in-memory (no file needed)
curl -X POST http://localhost:8086/1.0/JSONArray/TransformRecords \
  -H "Content-Type: application/json" \
  -d '{
    "Records": [
      { "id": "1", "title": "The Hunger Games", "isbn": "439023483" },
      { "id": "2", "title": "Harry Potter", "isbn": "439554934" }
    ],
    "Entity": "Book",
    "GUIDTemplate": "Book_{~D:Record.id~}",
    "Mappings": { "Title": "{~D:Record.title~}", "ISBN": "{~D:Record.isbn~}" }
  }'

# Merge two comprehensions
curl -X POST http://localhost:8086/1.0/Comprehension/Intersect \
  -H "Content-Type: application/json" \
  -d '{
    "PrimaryComprehension": { "Book": { "Book_1": { "GUIDBook": "Book_1", "Title": "The Hunger Games" } } },
    "SecondaryComprehension": { "Book": { "Book_1": { "GUIDBook": "Book_1", "Rating": "4.3" } } }
  }'
```

See [REST API Reference](docs/rest-api-reference.md) for full endpoint documentation with sample request bodies for every operation.

## Examples

The `examples/` folder contains 10 runnable scripts demonstrating all major features:

```shell
cd examples

# Analyze CSV structure
./Example-001-CSV-Check.sh

# Transform with auto-detection
./Example-002-CSV-Transform-Implicit.sh

# Transform with CLI options
./Example-003-CSV-Transform-CLI-Options.sh

# Transform with mapping file
./Example-004-CSV-Transform-Mapping-File.sh

# Multi-entity bookstore (Book, Author, BookAuthorJoin)
./Example-005-Multi-Entity-Bookstore.sh

# Merge three Seattle neighborhood CSVs
./Example-006-Multi-CSV-Intersect.sh

# Convert comprehension to array
./Example-007-Comprehension-To-Array.sh

# Export comprehension to CSV
./Example-008-Comprehension-To-CSV.sh

# Transform from JSON array
./Example-009-JSON-Array-Transform.sh

# Programmatic API usage
node Example-010-Programmatic-API.js
```

## Mapping Files

Mapping files define how source columns become comprehension fields:

```json
{
  "Entity": "Book",
  "GUIDTemplate": "Book_{~D:Record.id~}",
  "Mappings": {
    "Title": "{~D:Record.title~}",
    "Language": "{~D:Record.language_code~}",
    "ISBN": "{~D:Record.isbn~}",
    "Genre": "Unknown"
  }
}
```

For multi-record generation (e.g. splitting comma-separated authors), use Solvers:

```json
{
  "Entity": "Author",
  "MultipleGUIDUniqueness": true,
  "Solvers": ["NewRecordsGUIDUniqueness = STRINGGETSEGMENTS(IncomingRecord.authors,\",\")"],
  "GUIDTemplate": "Author_{~PascalCaseIdentifier:Record._GUIDUniqueness~}",
  "Mappings": {
    "Name": "{~D:Record._GUIDUniqueness~}"
  }
}
```

## Architecture

```
External Data (CSV / TSV / JSON)          Meadow REST API (Source)
        |                                         |
        v                                         v
   TabularTransform Service               CloneRestClient Service
   -- column mapping via Pict templates    -- authenticate & read entities
        |                                         |
        v                                         v
   Comprehension Object                    Sync Service (Initial / Ongoing)
   -- entity records keyed by GUID         -- compare server vs local state
        |                                         |
        v                                         v
   Integration Adapter                     ConnectionManager Service
   -- marshal to Meadow schema             -- MySQL or MSSQL connection pool
        |                                         |
        v                                         v
   GUID Map                                Local Database
   -- track external <-> Meadow IDs        -- tables created from schema
        |
        v
   Meadow REST API (Destination)
   -- batch upsert / single upsert
```

## Data Synchronization

The `data-clone` command synchronizes entity data from a remote Meadow REST API into a local MySQL or MSSQL database. It authenticates with the source API, connects to a local database, loads a Meadow schema, and syncs each entity defined in the schema.

### Services

| Service | Description |
|---------|-------------|
| **ConnectionManager** | Manages database connection pools for MySQL and MSSQL. Handles table creation and index management on the local database. |
| **CloneRestClient** | Authenticates with a remote Meadow API and provides methods for reading, creating, updating, upserting, and deleting entities. Includes built-in entity caching and paginated batch downloads. |
| **Sync** | Orchestrates entity synchronization. Loads a Meadow schema, creates local tables if they do not exist, and iterates through each entity to sync records. |

### Sync Modes

| Mode | Description |
|------|-------------|
| **Initial** | Compares the max entity ID on the server against the local database and downloads all records with IDs greater than the local maximum. Designed for first-time bulk population. |
| **Ongoing** | Walks through all server records page by page, comparing `UpdateDate` timestamps. Creates missing records locally and updates records whose server timestamp is newer than the local copy. |
| **OngoingEventualConsistency** | Time-budgeted variant of Ongoing: bisects the id range newest-first within `BackSyncTimeLimit`, then pulls new tail records. Reconciles deleted records separately (see below). |
| **TrueUp** | Forward keyset walk of the whole server range to repair gaps/drift. |

### Deleted-record reconciliation

When `SyncDeletedRecords` is enabled, `OngoingEventualConsistency` reconciles server-side deletions into the local clone. Each deleted server row is matched to the local row by **identity only** — never by GUID, because GUIDs are not guaranteed unique in cloned data and a GUID match could soft-delete the wrong record — and flagged via `doDelete`. Rows whose id is not present locally are counted and skipped (not created). Processing is newest-first by the indexed id, within `BackSyncTimeLimit`.

#### Resumable cursor options

By default each run sweeps the deleted set newest-first from the top, which on a large backlog never reaches older records within the time budget. These options make the sweep resumable:

| Option | Description |
|--------|-------------|
| `DeleteCursorStatePath` | (Optional) Path to a JSON file persisting per-table head/tail id marks so each run resumes the deleted-record sweep instead of re-walking from the newest record. Unset = disabled. The file must persist between runs to be useful; a missing/corrupt file degrades safely to a full sweep. Holds only a few integers per table — no record data. |
| `DeleteResweepIntervalHours` | (Optional, default `168`) Once the backlog is drained, hours between full re-sweeps that catch deletions of older records landing in already-swept id ranges. |

With the cursor enabled, each run runs a cheap **head pass** (`id > headID`, new deletions since last run) then continues the **tail** (`id < tailID`) within budget, using keyset paging (no growing `OFFSET`). Options propagate via `MeadowSync` options / per-entity `SyncEntityOptions`, and the strategy also reads matching keys from `fable.settings`.

### CLI Options

```
data-clone [options]

Options:
  -a, --api_server <url>        Source Meadow API server URL
  -u, --api_username <user>     API username for authentication
  -p, --api_password <pass>     API password for authentication
  -d, --db_provider <provider>  Database provider: MySQL or MSSQL (default: MySQL)
  -dh, --db_host <host>         Database host address
  -dp, --db_port <port>         Database port
  -du, --db_username <user>     Database username
  -dw, --db_password <pass>     Database password
  -dn, --db_name <name>         Database name
  -sp, --schema_path <path>     Path to Meadow extended schema JSON file
  -s, --sync_mode <mode>        Sync mode: Initial or Ongoing (default: Initial)
  -w, --post_run_delay <min>    Minutes to wait after sync before exiting (default: 0)
```

### Configuration

The `data-clone` command reads configuration from a `.meadow.config.json` file. The CLI searches for this file starting from the current working directory and cascading up to the home directory (powered by `pict-service-commandlineutility` auto-gather). Command-line options override values from the config file.

```json
{
  "Source": {
    "ServerURL": "https://my-meadow-api.example.com/1.0/",
    "UserID": "admin",
    "Password": "secret"
  },
  "Destination": {
    "Provider": "MySQL",
    "MySQL": {
      "server": "127.0.0.1",
      "port": 3306,
      "user": "root",
      "password": "",
      "database": "meadow",
      "connectionLimit": 20
    },
    "MSSQL": {
      "server": "127.0.0.1",
      "port": 1433,
      "user": "sa",
      "password": "",
      "database": "meadow",
      "ConnectionPoolLimit": 20
    }
  },
  "SchemaPath": "./schema/Model-Extended.json",
  "Sync": {
    "DefaultSyncMode": "Initial",
    "PageSize": 100,
    "SyncEntityList": [],
    "SyncEntityOptions": {}
  }
}
```

Set `SyncEntityList` to an array of entity names to sync only a subset of the schema. When empty, all entities in the schema are synced.

### Docker

A `Dockerfile` and `docker-compose.yml` are provided for running `data-clone` in a container. The Docker image is based on `node:20-bookworm` and runs the sync via the `scripts/run.sh` entrypoint.

```shell
# Build the image
docker build -t retold/meadow-integration .

# Run with docker-compose (connects to a meadow_backend network)
docker-compose up
```

Place a `.meadow.config.json` in the mounted volume or use `Meadow-Config-Docker.json` at the project root (it is automatically copied into the container as the default configuration during the Docker build).

## Documentation

Full documentation is available at `docs/index.html` (powered by pict-docuserve):

- [CLI Reference](docs/cli-reference.md)
- [REST API Reference](docs/rest-api-reference.md)
- [Mapping Files](docs/mapping-files.md)
- [Comprehensions](docs/comprehensions.md)
- [Programmatic API](docs/programmatic-api.md)
- [Integration Adapter](docs/integration-adapter.md)
- [Examples Walkthrough](docs/examples-walkthrough.md)
- [Vocabulary](docs/vocabulary/)

## Testing

```shell
npm test
```

## Related Packages

- [meadow](https://github.com/fable-retold/meadow) - Data access and ORM
- [meadow-endpoints](https://github.com/fable-retold/meadow-endpoints) - Auto-generated REST endpoints
- [meadow-connection-mysql](https://github.com/fable-retold/meadow-connection-mysql) - MySQL database provider for Meadow
- [meadow-connection-mssql](https://github.com/fable-retold/meadow-connection-mssql) - MSSQL database provider for Meadow
- [orator](https://github.com/fable-retold/orator) - API server abstraction
- [fable](https://github.com/fable-retold/fable) - Application services framework
- [pict-service-commandlineutility](https://github.com/fable-retold/pict-service-commandlineutility) - CLI framework with cascading configuration

## License

MIT

## Contributing

Pull requests are welcome. For details on our code of conduct, contribution process, and testing requirements, see the [Retold Contributing Guide](https://github.com/stevenvelozo/retold/blob/main/docs/contributing.md).
