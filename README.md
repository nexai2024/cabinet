# Cabinet

Open a data file, see the collections inside it, and edit every record. The
server reads the file, works out its structure, stores the rows and serves
complete CRUD over HTTP; the page in the browser only draws what the API
returns. Edits are written back into the file itself.

## Run

```sh
npm install        # or: bun install
npm run dev        # http://localhost:5173
npm run typecheck
npm run build
bun test
```

The dev server runs the actual Worker in workerd through Vite, with a local D1
database and R2 bucket, so nothing leaves the machine.

## Access key

Reads are public by default; every `POST`, `PATCH` and `DELETE` needs the shared
key. To protect reads as well, set `CABINET_PROTECT_READS=true` — health checks
and share links stay open.

```sh
cp .env.example .env     # then set CABINET_TOKEN to a long random string
npm run dev             # restart so the Worker picks it up
```

The Worker reads `CABINET_TOKEN` from its environment: `.env` locally,
`npx wrangler secret put CABINET_TOKEN` for a deployed Worker, or Sites →
Secrets. With no key configured, every mutation answers
`503 auth_not_configured`, so an exposed deployment stays read-only instead of
open.

Send the key with either header:

```sh
curl -X DELETE localhost:5173/api/files/$ID \
  -H "Authorization: Bearer $CABINET_TOKEN"

curl -X POST "localhost:5173/api/files?name=people.json" \
  -H "x-cabinet-key: $CABINET_TOKEN" --data-binary @people.json
```

In the browser, paste the key into **Access key** at the bottom of the left
rail. It is kept in `localStorage` and sent as `x-cabinet-key`; a rejected key
focuses that field. Keys are compared as SHA-256 digests, so a wrong guess is
not narrowed down by timing.

Write requests may also send `If-Match: <revision>`; a stale revision answers
`409 stale_revision`, so two open tabs cannot silently overwrite each other.

## What it reads

| Format | How it is read |
| --- | --- |
| JSON / JSON5 / GeoJSON | Arrays become collections; objects with array fields open as one collection per field |
| NDJSON / JSONL | One record per line |
| CSV / TSV | Header row kept as fields, `,` `;` `\t` `|` sniffed, quoted cells supported |
| XML | Repeated elements become records, attributes become `@field` values |
| JS / MJS / CJS | Exported object and array literals, parsed without evaluating code |
| TXT / LOG / MD | Key/value blocks, then delimited tables, then one record per line |
| Anything else | Content sniffing; unknown or binary files go to the model when a key is set |

Collection names come from the file's own keys, so `{ "users": [...] }` opens a
`users` collection and a bare array of objects takes the file name.

## API

All of it is JSON on the same origin; the core routes are described at
`/openapi.json`. Writes need the access key.

| Endpoint | What it does |
| --- | --- |
| `GET /api/health` | Service, model, key, read-protection and storage flags |
| `GET /api/stats` | File, trash, collection, record and event totals |
| `GET /api/files` | Every file with its counts (`?trash=true` lists the trash) |
| `POST /api/files?name=people.json` | Upload raw bytes (20 MB cap) and read them |
| `GET /api/files/{id}` | File details, revision, collections and fields |
| `DELETE /api/files/{id}` | Move a file to the trash |
| `POST /api/files/{id}/read` | Re-read (`{"mode":"heuristic"}`) or use the model (`{"mode":"ai"}`) |
| `GET /api/files/{id}/source` | Download the current stored file |
| `GET /api/files/{id}/original` | Download the untouched upload |
| `GET /api/files/{id}/versions` | Kept versions, newest first |
| `POST /api/files/{id}/versions/{versionId}/restore` | Roll the file back |
| `GET /api/files/{id}/events` | Audit trail for one file |
| `GET /api/events` | Recent events across the cabinet |
| `GET /api/trash` | Trashed files |
| `POST /api/files/{id}/restore` | Restore a trashed file |
| `DELETE /api/files/{id}/purge` | Delete a trashed file and its history for good |
| `DELETE /api/trash` | Empty the trash |
| `POST /api/files/{id}/collections` | Add an empty collection |
| `DELETE /api/files/{id}/collections/{collection}` | Drop a collection |
| `POST /api/files/{id}/collections/{collection}/schema` | `rename_field`, `delete_field`, `retype` or `rename` |
| `POST /api/files/{id}/collections/{collection}/import` | Append or upsert a file (`?mode=upsert&key=email`) |
| `POST /api/files/{id}/collections/{collection}/bulk` | Bulk delete/patch with `q`, `filters` or `ids`, plus `dryRun` |
| `GET /api/files/{id}/collections/{collection}/duplicates?key=` | Groups sharing a value |
| `POST /api/files/{id}/collections/{collection}/dedupe` | Keep the first row per group |
| `GET/POST /api/files/{id}/collections/{collection}/rules` | Validation rules |
| `DELETE .../rules/{ruleId}` | Remove a rule |
| `GET .../validate` | Current rule violations |
| `GET/POST /api/files/{id}/views` | Saved filters and sorts |
| `GET/POST /api/files/{id}/shares` | Read-only, expiring links |
| `GET /api/share/{token}` | Public snapshot behind a share link |
| `POST /api/files/{id}/ask` | `query`, `fixes` or `mapping` help from the model |
| `GET /api/files/{id}/records/{collection}` | Page, filter and sort (`limit`, `offset`, `q`, `filter`, `sort`, `dir`) |
| `POST /api/files/{id}/records/{collection}` | Create a record |
| `GET` / `PATCH` / `DELETE .../{recordId}` | Read, replace or delete one record |
| `GET /api/files/{id}/export?format=csv` | Write the collections out as JSON, NDJSON, CSV, XML or TXT |

Record bodies are plain JSON objects: at most 64 fields, 16 KB, and field names
limited to letters, numbers and `_ @ # . $ / -`.

`filter` is a JSON array of typed conditions, for example
`[{"field":"qty","op":"gt","value":10}]`; `op` is one of `eq`, `ne`, `lt`,
`lte`, `gt`, `gte`, `contains`, `exists`, `empty`. Search with `q` matches all
words across the record.

## Safety and history

- Every change snapshots the stored file first; the last 20 versions are kept in
  R2 and can be restored. The uploaded original is kept separately.
- Deleting a file moves it to the trash; purging is the only permanent delete.
- Each file has a `revision`. Writes accept `If-Match`, and every response
  reports the current revision.
- The SHA-256 of the stored bytes is recorded. If another program changed the
  file, writes answer `409 source_changed` instead of overwriting it; re-read the
  file or repeat with `x-cabinet-force: true`.
- Creating, replacing or deleting a record rewrites the stored file in its own
  format, so re-reading keeps the edits: JSON and JS stay JSON, CSV/TSV stay
  tables, XML stays XML (attributes round-trip as `@field`) and NDJSON stays one
  record per line. When a format cannot hold the data — several collections in a
  CSV, nested values in XML — the file is written as JSON and its `format`
  becomes `json`; readers accept JSON regardless of the extension.
- Uploading 50,000 records per file is the working limit; anything beyond that
  is reported in the file's notes rather than dropped silently.

## Data quality

Rules attach to a collection and are enforced on create, replace and import:
`required`, `type` (`string`/`number`/`boolean`), `unique`, `one_of` (list),
`min`, `max`. A violating write answers `422 rule_violation` with the list of
problems. `GET .../validate` reports existing violations, `.../duplicates`
groups rows sharing a key, and `.../dedupe` removes later copies.

Schema changes apply to every row and are written back to the file:
`{"action":"rename_field","from":"old","to":"new"}`,
`{"action":"delete_field","field":"tags"}`,
`{"action":"retype","field":"qty","type":"number"}` and
`{"action":"rename","name":"books"}`.

## Model inference

Unfamiliar files are handed to the model only when a key is configured:

```sh
cp .env.example .env    # then paste OPENAI_API_KEY
```

Before any text leaves the server, emails, phone numbers, card and account
numbers, JWTs and API-key-shaped secrets are replaced with `[redacted-…]`
placeholders; the file notes report how many were removed. Set
`AI_REDACT_PII=false` to disable this for a private model. `AI_MODEL` may be one
of `gpt-4o-mini`, `gpt-4.1-mini` or `gpt-5-mini`.

`POST /api/files/{id}/ask` adds three model helpers, each validated before use
and each proposing rather than applying changes:

- `query` turns a question into typed filters, then returns the matching rows.
- `fixes` proposes values for rows that break rules.
- `mapping` suggests how to map one collection's fields onto another's.

## CLI and MCP

```sh
export CABINET_URL=http://localhost:5173
export CABINET_TOKEN=...            # same key the Worker sees

node scripts/cabinet.mjs files
node scripts/cabinet.mjs records people contacts --limit 5
node scripts/cabinet.mjs add people contacts '{"name":"Ada"}'
node scripts/cabinet.mjs versions people
```

`node scripts/cabinet.mjs help` lists every command. `scripts/cabinet-mcp.mjs`
speaks Model Context Protocol over stdio with the same configuration and exposes
`cabinet_list_files`, `cabinet_open_file`, `cabinet_query_records`,
`cabinet_add_record`, `cabinet_update_record`, `cabinet_delete_record`,
`cabinet_read_file` and `cabinet_stats`.

## Storage

- D1 (`DB`): files, collections, records, versions, events, rules, views and
  shares; the schema is created on first use.
- R2 (`FILES`): the uploaded original, the current file bytes, and up to 20
  version snapshots per file.

Both bindings in `wrangler.jsonc` are local development bindings. Publishing
through Freebuff Sites needs `sites_add_storage` for `DB` (D1) and `FILES` (R2)
in the target environment, plus `CABINET_TOKEN` (and optionally
`CABINET_PROTECT_READS`) as secrets before the deployed API can store or guard
anything.

`CABINET_TOKEN` belongs in the Worker's secrets, never in the repo: `.env` is
gitignored and `.env.example` only shows the names.
