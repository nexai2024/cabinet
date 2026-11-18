import { jsonSafe } from './infer'
import type {
  AuditEvent,
  Collection,
  FileVersion,
  Filter,
  Rule,
  RuleName,
  SavedView,
  Share,
  Violation,
} from './types'

let schemaPromise: Promise<void> | null = null

export function ensureSchema(db: D1Database): Promise<void> {
  if (!schemaPromise)
    schemaPromise = (async () => {
      await db.batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS files (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          ext TEXT NOT NULL,
          format TEXT NOT NULL,
          size INTEGER NOT NULL,
          status TEXT NOT NULL,
          source TEXT NOT NULL,
          notes TEXT NOT NULL,
          binary INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS collections (
          file_id TEXT NOT NULL,
          name TEXT NOT NULL,
          position INTEGER NOT NULL,
          PRIMARY KEY (file_id, name)
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS records (
          id TEXT PRIMARY KEY,
          file_id TEXT NOT NULL,
          collection TEXT NOT NULL,
          data TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`),
        db.prepare(
          `CREATE INDEX IF NOT EXISTS records_by_collection ON records (file_id, collection)`,
        ),
        db.prepare(`CREATE TABLE IF NOT EXISTS file_versions (
          id TEXT PRIMARY KEY,
          file_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          size INTEGER NOT NULL,
          format TEXT NOT NULL,
          hash TEXT NOT NULL,
          reason TEXT NOT NULL,
          bytes_key TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`),
        db.prepare(
          `CREATE INDEX IF NOT EXISTS versions_by_file ON file_versions (file_id, created_at)`,
        ),
        db.prepare(`CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY,
          file_id TEXT,
          collection TEXT,
          record_id TEXT,
          action TEXT NOT NULL,
          detail TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`),
        db.prepare(`CREATE INDEX IF NOT EXISTS events_by_file ON events (file_id, created_at)`),
        db.prepare(`CREATE TABLE IF NOT EXISTS saved_views (
          id TEXT PRIMARY KEY,
          file_id TEXT NOT NULL,
          collection TEXT NOT NULL,
          name TEXT NOT NULL,
          query TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS shares (
          id TEXT PRIMARY KEY,
          file_id TEXT NOT NULL,
          collection TEXT,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`),
        db.prepare(`CREATE TABLE IF NOT EXISTS rules (
          id TEXT PRIMARY KEY,
          file_id TEXT NOT NULL,
          collection TEXT NOT NULL,
          field TEXT NOT NULL,
          rule TEXT NOT NULL,
          value TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`),
      ])
      await ensureColumns(db)
    })()
      .then(() => undefined)
      .catch((error: unknown) => {
        schemaPromise = null
        throw error
      })
  return schemaPromise
}

/** Older local databases need the newer file columns added in place. */
async function ensureColumns(db: D1Database) {
  const wanted: [string, string][] = [
    ['revision', 'INTEGER NOT NULL DEFAULT 1'],
    ['source_hash', "TEXT NOT NULL DEFAULT ''"],
    ['deleted_at', 'TEXT'],
  ]
  let existing: string[] = []
  try {
    const info = await db.prepare(`PRAGMA table_info(files)`).all<{ name: string }>()
    existing = (info.results ?? []).map((row) => row.name)
  } catch {
    existing = []
  }
  for (const [name, sql] of wanted) {
    if (existing.includes(name)) continue
    try {
      await db.prepare(`ALTER TABLE files ADD COLUMN ${name} ${sql}`).run()
    } catch {
      /* already added by a racing isolate */
    }
  }
}

export type StoredFile = {
  id: string
  name: string
  ext: string
  format: string
  size: number
  status: string
  source: string
  notes: string[]
  binary: boolean
  revision: number
  sourceHash: string
  deletedAt: string | null
  createdAt: string
  updatedAt: string
}

export type FileDbRow = {
  id: string
  name: string
  ext: string
  format: string
  size: number
  status: string
  source: string
  notes: string
  binary: number
  revision: number
  source_hash: string
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export function toStoredFile(row: FileDbRow): StoredFile {
  return {
    id: row.id,
    name: row.name,
    ext: row.ext,
    format: row.format,
    size: row.size,
    status: row.status,
    source: row.source,
    notes: safeNotes(row.notes),
    binary: row.binary === 1,
    revision: row.revision ?? 1,
    sourceHash: row.source_hash ?? '',
    deletedAt: row.deleted_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function safeNotes(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed))
      return parsed.filter((entry): entry is string => typeof entry === 'string')
  } catch {
    /* fall through to the raw string */
  }
  return raw ? [raw] : []
}

export type RecordRow = {
  id: string
  data: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

type RecordDbRow = {
  id: string
  data: string
  created_at: string
  updated_at: string
}

export function toRecordRow(row: RecordDbRow): RecordRow {
  let data: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(row.data) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      data = parsed as Record<string, unknown>
  } catch {
    data = {}
  }
  return {
    id: row.id,
    data,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/* ------------------------------ files ------------------------------ */

export async function listFiles(db: D1Database, trash = false) {
  await ensureSchema(db)
  const result = await db
    .prepare(
      `SELECT f.*,
        (SELECT COUNT(*) FROM collections c WHERE c.file_id = f.id) AS collection_count,
        (SELECT COUNT(*) FROM records r WHERE r.file_id = f.id) AS record_count
       FROM files f
       WHERE ${trash ? 'f.deleted_at IS NOT NULL' : 'f.deleted_at IS NULL'}
       ORDER BY f.updated_at DESC`,
    )
    .all<FileDbRow & { collection_count: number; record_count: number }>()
  return result.results ?? []
}

export async function getFileRow(db: D1Database, id: string) {
  await ensureSchema(db)
  return db.prepare(`SELECT * FROM files WHERE id = ?`).bind(id).first<FileDbRow>()
}

export async function getActiveFileRow(db: D1Database, id: string) {
  const row = await getFileRow(db, id)
  return row && !row.deleted_at ? row : null
}

export async function createFile(
  db: D1Database,
  input: {
    id: string
    name: string
    ext: string
    format: string
    size: number
    status: string
    source: string
    notes: string[]
    binary: boolean
    sourceHash: string
  },
) {
  await ensureSchema(db)
  const now = new Date().toISOString()
  await db
    .prepare(
      `INSERT INTO files (id, name, ext, format, size, status, source, notes, binary, revision, source_hash, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, ?, ?)`,
    )
    .bind(
      input.id,
      input.name,
      input.ext,
      input.format,
      input.size,
      input.status,
      input.source,
      JSON.stringify(input.notes),
      input.binary ? 1 : 0,
      input.sourceHash,
      now,
      now,
    )
    .run()
}

export async function updateFileMeta(
  db: D1Database,
  id: string,
  patch: {
    format?: string
    status?: string
    source?: string
    notes?: string[]
    size?: number
    sourceHash?: string
  },
) {
  await ensureSchema(db)
  const current = await getFileRow(db, id)
  if (!current) return
  await db
    .prepare(
      `UPDATE files SET format = ?, status = ?, source = ?, notes = ?, size = ?, source_hash = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(
      patch.format ?? current.format,
      patch.status ?? current.status,
      patch.source ?? current.source,
      JSON.stringify(patch.notes ?? safeNotes(current.notes)),
      patch.size ?? current.size,
      patch.sourceHash ?? current.source_hash,
      new Date().toISOString(),
      id,
    )
    .run()
}

/** Every data change bumps the revision that clients send back as If-Match. */
export async function bumpRevision(db: D1Database, id: string): Promise<number> {
  await ensureSchema(db)
  await db
    .prepare(`UPDATE files SET revision = revision + 1, updated_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), id)
    .run()
  const row = await db.prepare(`SELECT revision FROM files WHERE id = ?`).bind(id).first<{
    revision: number
  }>()
  return row?.revision ?? 1
}

export async function softDeleteFile(db: D1Database, id: string) {
  await ensureSchema(db)
  await db
    .prepare(`UPDATE files SET deleted_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), new Date().toISOString(), id)
    .run()
}

export async function restoreFileRow(db: D1Database, id: string) {
  await ensureSchema(db)
  await db
    .prepare(`UPDATE files SET deleted_at = NULL, revision = revision + 1, updated_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), id)
    .run()
}

export async function deleteFileRecord(db: D1Database, id: string) {
  await ensureSchema(db)
  await db.batch([
    db.prepare(`DELETE FROM records WHERE file_id = ?`).bind(id),
    db.prepare(`DELETE FROM collections WHERE file_id = ?`).bind(id),
    db.prepare(`DELETE FROM file_versions WHERE file_id = ?`).bind(id),
    db.prepare(`DELETE FROM rules WHERE file_id = ?`).bind(id),
    db.prepare(`DELETE FROM saved_views WHERE file_id = ?`).bind(id),
    db.prepare(`DELETE FROM shares WHERE file_id = ?`).bind(id),
    db.prepare(`DELETE FROM files WHERE id = ?`).bind(id),
  ])
}

/* -------------------------- collections --------------------------- */

/** Replace a file's inferred collections and rows in one pass. */
export async function replaceCollections(
  db: D1Database,
  fileId: string,
  collections: Collection[],
) {
  await ensureSchema(db)
  const now = new Date().toISOString()
  const statements: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM records WHERE file_id = ?`).bind(fileId),
    db.prepare(`DELETE FROM collections WHERE file_id = ?`).bind(fileId),
  ]
  collections.forEach((collection, position) => {
    statements.push(
      db
        .prepare(`INSERT INTO collections (file_id, name, position) VALUES (?, ?, ?)`)
        .bind(fileId, collection.name, position),
    )
    for (const record of collection.records) {
      statements.push(
        db
          .prepare(
            `INSERT INTO records (id, file_id, collection, data, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            fileId,
            collection.name,
            JSON.stringify(jsonSafe(record)),
            now,
            now,
          ),
      )
    }
  })
  for (let index = 0; index < statements.length; index += 75)
    await db.batch(statements.slice(index, index + 75))
  await db.prepare(`UPDATE files SET updated_at = ? WHERE id = ?`).bind(now, fileId).run()
}

export async function listCollections(db: D1Database, fileId: string) {
  await ensureSchema(db)
  const result = await db
    .prepare(
      `SELECT c.name AS name, COUNT(r.id) AS record_count
       FROM collections c
       LEFT JOIN records r ON r.file_id = c.file_id AND r.collection = c.name
       WHERE c.file_id = ?
       GROUP BY c.name
       ORDER BY c.position`,
    )
    .bind(fileId)
    .all<{ name: string; record_count: number }>()
  return result.results ?? []
}

export async function sampleRecords(
  db: D1Database,
  fileId: string,
  collection: string,
  limit = 120,
) {
  await ensureSchema(db)
  const result = await db
    .prepare(
      `SELECT id, data, created_at, updated_at FROM records
       WHERE file_id = ? AND collection = ? ORDER BY rowid LIMIT ?`,
    )
    .bind(fileId, collection, limit)
    .all<RecordDbRow>()
  return (result.results ?? []).map(toRecordRow)
}

/* ---------------------------- records ----------------------------- */

const FIELD = /^[A-Za-z0-9_@#.$ /-]{1,64}$/
const MAX_BULK = 5000

export type RecordQuery = {
  limit: number
  offset: number
  q?: string
  filters?: Filter[]
  sort?: string
  direction: 'asc' | 'desc'
}

export type RecordFilter = {
  ids?: string[]
  q?: string
  filters?: Filter[]
}

type Where = { clause: string; bindings: unknown[] }

function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, (match) => `\\${match}`)
}

function filterValue(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return value
  return String(value)
}

function recordWhere(fileId: string, collection: string, filter: RecordFilter): Where {
  const where = ['file_id = ?', 'collection = ?']
  const bindings: unknown[] = [fileId, collection]

  for (const entry of filter.filters ?? []) {
    if (!FIELD.test(entry.field)) continue
    const path = `json_extract(data, '$."${entry.field.replace(/"/g, '')}"')`
    const value = entry.value
    switch (entry.op) {
      case 'eq':
        if (value === null || value === undefined) where.push(`${path} IS NULL`)
        else {
          where.push(`${path} = ?`)
          bindings.push(filterValue(value))
        }
        break
      case 'ne':
        if (value === null || value === undefined) where.push(`${path} IS NOT NULL`)
        else {
          where.push(`${path} IS NOT ?`)
          bindings.push(filterValue(value))
        }
        break
      case 'lt':
      case 'lte':
      case 'gt':
      case 'gte': {
        const symbol = { lt: '<', lte: '<=', gt: '>', gte: '>=' }[entry.op]
        where.push(`${path} ${symbol} ?`)
        bindings.push(filterValue(value ?? ''))
        break
      }
      case 'contains':
        where.push(`CAST(${path} AS TEXT) LIKE ? ESCAPE '\\'`)
        bindings.push(`%${escapeLike(String(value ?? ''))}%`)
        break
      case 'exists':
        where.push(`${path} IS NOT NULL`)
        break
      case 'empty':
        where.push(`(${path} IS NULL OR ${path} = '')`)
        break
    }
  }

  if (filter.q?.trim()) {
    for (const token of filter.q.trim().split(/\s+/).slice(0, 8)) {
      where.push(`data LIKE ? ESCAPE '\\'`)
      bindings.push(`%${escapeLike(token)}%`)
    }
  }

  if (filter.ids) {
    // An explicit empty selection means "no rows", never "every row".
    if (!filter.ids.length) where.push('0 = 1')
    else {
      const ids = filter.ids.slice(0, 500)
      where.push(`id IN (${ids.map(() => '?').join(', ')})`)
      bindings.push(...ids)
    }
  }

  return { clause: where.join(' AND '), bindings }
}

export async function queryRecords(
  db: D1Database,
  fileId: string,
  collection: string,
  query: RecordQuery,
) {
  await ensureSchema(db)
  const where = recordWhere(fileId, collection, {
    q: query.q,
    filters: query.filters,
  })
  const order = orderClause(query.sort, query.direction)
  const total = await db
    .prepare(`SELECT COUNT(*) AS total FROM records WHERE ${where.clause}`)
    .bind(...where.bindings)
    .first<{ total: number }>()
  const rows = await db
    .prepare(
      `SELECT id, data, created_at, updated_at FROM records
       WHERE ${where.clause} ORDER BY ${order} LIMIT ? OFFSET ?`,
    )
    .bind(...where.bindings, query.limit, query.offset)
    .all<RecordDbRow>()
  return {
    total: total?.total ?? 0,
    records: (rows.results ?? []).map(toRecordRow),
  }
}

function orderClause(sort: string | undefined, direction: 'asc' | 'desc'): string {
  const dir = direction === 'desc' ? 'DESC' : 'ASC'
  if (!sort) return `rowid ${dir}`
  if (!FIELD.test(sort)) return `rowid ${dir}`
  const path = `$."${sort.replace(/"/g, '')}"`
  return `json_extract(data, '${path}') ${dir}, rowid ${dir}`
}

export async function countMatching(
  db: D1Database,
  fileId: string,
  collection: string,
  filter: RecordFilter,
) {
  await ensureSchema(db)
  const where = recordWhere(fileId, collection, filter)
  const row = await db
    .prepare(`SELECT COUNT(*) AS total FROM records WHERE ${where.clause}`)
    .bind(...where.bindings)
    .first<{ total: number }>()
  return row?.total ?? 0
}

export async function matchingIds(
  db: D1Database,
  fileId: string,
  collection: string,
  filter: RecordFilter,
  limit = MAX_BULK,
) {
  await ensureSchema(db)
  const where = recordWhere(fileId, collection, filter)
  const rows = await db
    .prepare(`SELECT id FROM records WHERE ${where.clause} ORDER BY rowid LIMIT ?`)
    .bind(...where.bindings, limit)
    .all<{ id: string }>()
  return (rows.results ?? []).map((row) => row.id)
}

export async function bulkPatch(
  db: D1Database,
  fileId: string,
  collection: string,
  ids: string[],
  patch: Record<string, unknown>,
) {
  await ensureSchema(db)
  let changed = 0
  const now = new Date().toISOString()
  for (let start = 0; start < ids.length; start += 100) {
    const slice = ids.slice(start, start + 100)
    const rows = await db
      .prepare(
        `SELECT id, data FROM records WHERE file_id = ? AND collection = ? AND id IN (${slice
          .map(() => '?')
          .join(', ')})`,
      )
      .bind(fileId, collection, ...slice)
      .all<{ id: string; data: string }>()
    const statements = (rows.results ?? []).map((row) => {
      let data: Record<string, unknown> = {}
      try {
        data = JSON.parse(row.data) as Record<string, unknown>
      } catch {
        data = {}
      }
      const merged = { ...data, ...patch }
      changed += 1
      return db
        .prepare(`UPDATE records SET data = ?, updated_at = ? WHERE id = ?`)
        .bind(JSON.stringify(jsonSafe(merged)), now, row.id)
    })
    if (statements.length) await db.batch(statements)
  }
  return changed
}

export async function bulkDelete(
  db: D1Database,
  fileId: string,
  collection: string,
  ids: string[],
) {
  await ensureSchema(db)
  let changed = 0
  for (let start = 0; start < ids.length; start += 100) {
    const slice = ids.slice(start, start + 100)
    const result = await db
      .prepare(
        `DELETE FROM records WHERE file_id = ? AND collection = ? AND id IN (${slice
          .map(() => '?')
          .join(', ')})`,
      )
      .bind(fileId, collection, ...slice)
      .run()
    changed += result.meta.changes ?? 0
  }
  return changed
}

export async function getRecord(
  db: D1Database,
  fileId: string,
  collection: string,
  recordId: string,
) {
  await ensureSchema(db)
  const row = await db
    .prepare(
      `SELECT id, data, created_at, updated_at FROM records
       WHERE id = ? AND file_id = ? AND collection = ?`,
    )
    .bind(recordId, fileId, collection)
    .first<RecordDbRow>()
  return row ? toRecordRow(row) : null
}

export async function insertRecord(
  db: D1Database,
  fileId: string,
  collection: string,
  data: Record<string, unknown>,
) {
  await ensureSchema(db)
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  await db
    .prepare(
      `INSERT INTO records (id, file_id, collection, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, fileId, collection, JSON.stringify(jsonSafe(data)), now, now)
    .run()
  await db.prepare(`UPDATE files SET updated_at = ? WHERE id = ?`).bind(now, fileId).run()
  return { id, data, createdAt: now, updatedAt: now } satisfies RecordRow
}

export async function findRecordByField(
  db: D1Database,
  fileId: string,
  collection: string,
  field: string,
  value: unknown,
) {
  await ensureSchema(db)
  if (!FIELD.test(field)) return null
  const path = `json_extract(data, '$."${field.replace(/"/g, '')}"')`
  const row = await db
    .prepare(
      `SELECT id, data, created_at, updated_at FROM records
       WHERE file_id = ? AND collection = ? AND ${path} = ? LIMIT 1`,
    )
    .bind(fileId, collection, filterValue(value))
    .first<RecordDbRow>()
  return row ? toRecordRow(row) : null
}

export async function updateRecord(
  db: D1Database,
  fileId: string,
  collection: string,
  recordId: string,
  data: Record<string, unknown>,
) {
  await ensureSchema(db)
  const now = new Date().toISOString()
  await db
    .prepare(
      `UPDATE records SET data = ?, updated_at = ? WHERE id = ? AND file_id = ? AND collection = ?`,
    )
    .bind(JSON.stringify(jsonSafe(data)), now, recordId, fileId, collection)
    .run()
  await db.prepare(`UPDATE files SET updated_at = ? WHERE id = ?`).bind(now, fileId).run()
  return getRecord(db, fileId, collection, recordId)
}

export async function deleteRecord(
  db: D1Database,
  fileId: string,
  collection: string,
  recordId: string,
) {
  await ensureSchema(db)
  const result = await db
    .prepare(`DELETE FROM records WHERE id = ? AND file_id = ? AND collection = ?`)
    .bind(recordId, fileId, collection)
    .run()
  return (result.meta.changes ?? 0) > 0
}

export async function addCollection(db: D1Database, fileId: string, name: string) {
  await ensureSchema(db)
  const existing = await db
    .prepare(`SELECT COUNT(*) AS total FROM collections WHERE file_id = ?`)
    .bind(fileId)
    .first<{ total: number }>()
  await db
    .prepare(
      `INSERT OR IGNORE INTO collections (file_id, name, position) VALUES (?, ?, ?)`,
    )
    .bind(fileId, name, existing?.total ?? 0)
    .run()
}

export async function renameCollection(
  db: D1Database,
  fileId: string,
  from: string,
  to: string,
) {
  await ensureSchema(db)
  const clash = await db
    .prepare(`SELECT 1 AS ok FROM collections WHERE file_id = ? AND name = ?`)
    .bind(fileId, to)
    .first<{ ok: number }>()
  if (clash) return false
  await db.batch([
    db.prepare(`UPDATE collections SET name = ? WHERE file_id = ? AND name = ?`).bind(to, fileId, from),
    db
      .prepare(`UPDATE records SET collection = ? WHERE file_id = ? AND collection = ?`)
      .bind(to, fileId, from),
    db
      .prepare(`UPDATE rules SET collection = ? WHERE file_id = ? AND collection = ?`)
      .bind(to, fileId, from),
    db
      .prepare(`UPDATE saved_views SET collection = ? WHERE file_id = ? AND collection = ?`)
      .bind(to, fileId, from),
    db
      .prepare(`UPDATE shares SET collection = ? WHERE file_id = ? AND collection = ?`)
      .bind(to, fileId, from),
  ])
  return true
}

export async function dropCollection(db: D1Database, fileId: string, name: string) {
  await ensureSchema(db)
  await db.batch([
    db.prepare(`DELETE FROM records WHERE file_id = ? AND collection = ?`).bind(fileId, name),
    db.prepare(`DELETE FROM collections WHERE file_id = ? AND name = ?`).bind(fileId, name),
    db.prepare(`DELETE FROM rules WHERE file_id = ? AND collection = ?`).bind(fileId, name),
    db.prepare(`DELETE FROM saved_views WHERE file_id = ? AND collection = ?`).bind(fileId, name),
    db.prepare(`DELETE FROM shares WHERE file_id = ? AND collection = ?`).bind(fileId, name),
  ])
}

/** All rows of a collection, for schema rewrites and exports. */
export async function allRecords(db: D1Database, fileId: string, collection: string) {
  await ensureSchema(db)
  const rows = await db
    .prepare(
      `SELECT id, data, created_at, updated_at FROM records
       WHERE file_id = ? AND collection = ? ORDER BY rowid`,
    )
    .bind(fileId, collection)
    .all<RecordDbRow>()
  return (rows.results ?? []).map(toRecordRow)
}

export async function replaceRecordData(
  db: D1Database,
  rows: { id: string; data: Record<string, unknown> }[],
) {
  await ensureSchema(db)
  const now = new Date().toISOString()
  for (let start = 0; start < rows.length; start += 75) {
    await db.batch(
      rows
        .slice(start, start + 75)
        .map((row) =>
          db
            .prepare(`UPDATE records SET data = ?, updated_at = ? WHERE id = ?`)
            .bind(JSON.stringify(jsonSafe(row.data)), now, row.id),
        ),
    )
  }
}

/* ----------------------------- versions ---------------------------- */

export async function addVersion(
  db: D1Database,
  input: {
    id: string
    fileId: string
    revision: number
    size: number
    format: string
    hash: string
    reason: string
    bytesKey: string
  },
) {
  await ensureSchema(db)
  await db
    .prepare(
      `INSERT INTO file_versions (id, file_id, revision, size, format, hash, reason, bytes_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.fileId,
      input.revision,
      input.size,
      input.format,
      input.hash,
      input.reason,
      input.bytesKey,
      new Date().toISOString(),
    )
    .run()
}

export async function listVersions(db: D1Database, fileId: string): Promise<(FileVersion & { bytesKey: string })[]> {
  await ensureSchema(db)
  const rows = await db
    .prepare(
      `SELECT id, file_id, revision, size, format, hash, reason, bytes_key, created_at
       FROM file_versions WHERE file_id = ? ORDER BY created_at DESC LIMIT 50`,
    )
    .bind(fileId)
    .all<{
      id: string
      file_id: string
      revision: number
      size: number
      format: string
      hash: string
      reason: string
      bytes_key: string
      created_at: string
    }>()
  return (rows.results ?? []).map((row) => ({
    id: row.id,
    fileId: row.file_id,
    revision: row.revision,
    size: row.size,
    format: row.format,
    hash: row.hash,
    reason: row.reason,
    bytesKey: row.bytes_key,
    createdAt: row.created_at,
  }))
}

export async function getVersion(db: D1Database, fileId: string, versionId: string) {
  await ensureSchema(db)
  return db
    .prepare(
      `SELECT id, file_id, revision, size, format, hash, reason, bytes_key, created_at
       FROM file_versions WHERE file_id = ? AND id = ?`,
    )
    .bind(fileId, versionId)
    .first<{
      id: string
      file_id: string
      revision: number
      size: number
      format: string
      hash: string
      reason: string
      bytes_key: string
      created_at: string
    }>()
}

export async function latestVersion(db: D1Database, fileId: string) {
  await ensureSchema(db)
  return db
    .prepare(
      `SELECT hash FROM file_versions WHERE file_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(fileId)
    .first<{ hash: string }>()
}

export async function pruneVersions(db: D1Database, fileId: string, keep = 20) {
  await ensureSchema(db)
  const rows = await db
    .prepare(
      `SELECT id, bytes_key FROM file_versions WHERE file_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?`,
    )
    .bind(fileId, keep)
    .all<{ id: string; bytes_key: string }>()
  const stale = rows.results ?? []
  if (!stale.length) return []
  for (let start = 0; start < stale.length; start += 50)
    await db.batch(
      stale
        .slice(start, start + 50)
        .map((row) => db.prepare(`DELETE FROM file_versions WHERE id = ?`).bind(row.id)),
    )
  return stale.map((row) => row.bytes_key)
}

/* ------------------------------ events ----------------------------- */

export async function logEvent(
  db: D1Database,
  input: {
    fileId?: string | null
    collection?: string | null
    recordId?: string | null
    action: string
    detail?: Record<string, unknown>
  },
) {
  await ensureSchema(db)
  await db
    .prepare(
      `INSERT INTO events (id, file_id, collection, record_id, action, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.fileId ?? null,
      input.collection ?? null,
      input.recordId ?? null,
      input.action,
      JSON.stringify(input.detail ?? {}),
      new Date().toISOString(),
    )
    .run()
}

export async function listEvents(
  db: D1Database,
  filter: { fileId?: string; limit?: number },
): Promise<AuditEvent[]> {
  await ensureSchema(db)
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500)
  const rows = filter.fileId
    ? await db
        .prepare(
          `SELECT * FROM events WHERE file_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .bind(filter.fileId, limit)
        .all<EventDbRow>()
    : await db
        .prepare(`SELECT * FROM events ORDER BY created_at DESC, rowid DESC LIMIT ?`)
        .bind(limit)
        .all<EventDbRow>()
  return (rows.results ?? []).map(toEvent)
}

type EventDbRow = {
  id: string
  file_id: string | null
  collection: string | null
  record_id: string | null
  action: string
  detail: string
  created_at: string
}

function toEvent(row: EventDbRow): AuditEvent {
  let detail: Record<string, unknown> = {}
  try {
    detail = JSON.parse(row.detail) as Record<string, unknown>
  } catch {
    detail = { raw: row.detail }
  }
  return {
    id: row.id,
    fileId: row.file_id,
    collection: row.collection,
    recordId: row.record_id,
    action: row.action,
    detail,
    createdAt: row.created_at,
  }
}

/* ------------------------------ views ------------------------------ */

export async function listViews(db: D1Database, fileId: string): Promise<SavedView[]> {
  await ensureSchema(db)
  const rows = await db
    .prepare(`SELECT * FROM saved_views WHERE file_id = ? ORDER BY created_at`)
    .bind(fileId)
    .all<{
      id: string
      file_id: string
      collection: string
      name: string
      query: string
      created_at: string
    }>()
  return (rows.results ?? []).map((row) => ({
    id: row.id,
    fileId: row.file_id,
    collection: row.collection,
    name: row.name,
    query: parseJson<Record<string, unknown>>(row.query),
    createdAt: row.created_at,
  }))
}

export async function addView(
  db: D1Database,
  input: { fileId: string; collection: string; name: string; query: Record<string, unknown> },
) {
  await ensureSchema(db)
  const id = crypto.randomUUID()
  await db
    .prepare(
      `INSERT INTO saved_views (id, file_id, collection, name, query, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.fileId, input.collection, input.name, JSON.stringify(input.query), new Date().toISOString())
    .run()
  return { id, ...input, createdAt: new Date().toISOString() }
}

export async function deleteView(db: D1Database, fileId: string, viewId: string) {
  await ensureSchema(db)
  const result = await db
    .prepare(`DELETE FROM saved_views WHERE id = ? AND file_id = ?`)
    .bind(viewId, fileId)
    .run()
  return (result.meta.changes ?? 0) > 0
}

/* ------------------------------ shares ----------------------------- */

export async function addShare(
  db: D1Database,
  input: { fileId: string; collection: string | null; ttlHours: number },
) {
  await ensureSchema(db)
  const id = crypto.randomUUID().replace(/-/g, '')
  const created = new Date()
  const expires = new Date(created.getTime() + input.ttlHours * 3_600_000)
  await db
    .prepare(
      `INSERT INTO shares (id, file_id, collection, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, input.fileId, input.collection, expires.toISOString(), created.toISOString())
    .run()
  return {
    id,
    fileId: input.fileId,
    collection: input.collection,
    expiresAt: expires.toISOString(),
    createdAt: created.toISOString(),
  } satisfies Share
}

export async function listShares(db: D1Database, fileId: string): Promise<Share[]> {
  await ensureSchema(db)
  const rows = await db
    .prepare(`SELECT * FROM shares WHERE file_id = ? ORDER BY created_at DESC`)
    .bind(fileId)
    .all<{
      id: string
      file_id: string
      collection: string | null
      expires_at: string
      created_at: string
    }>()
  return (rows.results ?? []).map((row) => ({
    id: row.id,
    fileId: row.file_id,
    collection: row.collection,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }))
}

export async function findShare(db: D1Database, token: string) {
  await ensureSchema(db)
  const row = await db
    .prepare(`SELECT * FROM shares WHERE id = ?`)
    .bind(token)
    .first<{
      id: string
      file_id: string
      collection: string | null
      expires_at: string
      created_at: string
    }>()
  if (!row) return null
  if (Date.parse(row.expires_at) < Date.now()) return null
  return {
    id: row.id,
    fileId: row.file_id,
    collection: row.collection,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  } satisfies Share
}

export async function deleteShare(db: D1Database, fileId: string, shareId: string) {
  await ensureSchema(db)
  const result = await db
    .prepare(`DELETE FROM shares WHERE id = ? AND file_id = ?`)
    .bind(shareId, fileId)
    .run()
  return (result.meta.changes ?? 0) > 0
}

/* ------------------------------- rules ----------------------------- */

export async function listRules(db: D1Database, fileId: string, collection: string): Promise<Rule[]> {
  await ensureSchema(db)
  const rows = await db
    .prepare(`SELECT * FROM rules WHERE file_id = ? AND collection = ? ORDER BY created_at`)
    .bind(fileId, collection)
    .all<{
      id: string
      field: string
      rule: string
      value: string
      created_at: string
    }>()
  return (rows.results ?? []).map((row) => ({
    id: row.id,
    field: row.field,
    rule: row.rule as RuleName,
    value: parseJson<unknown>(row.value),
    createdAt: row.created_at,
  }))
}

export async function addRule(
  db: D1Database,
  input: { fileId: string; collection: string; field: string; rule: RuleName; value: unknown },
) {
  await ensureSchema(db)
  const id = crypto.randomUUID()
  await db
    .prepare(
      `INSERT INTO rules (id, file_id, collection, field, rule, value, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.fileId,
      input.collection,
      input.field,
      input.rule,
      JSON.stringify(input.value ?? null),
      new Date().toISOString(),
    )
    .run()
  return { id, ...input, createdAt: new Date().toISOString() }
}

export async function renameRuleField(
  db: D1Database,
  fileId: string,
  collection: string,
  from: string,
  to: string,
) {
  await ensureSchema(db)
  await db
    .prepare(`UPDATE rules SET field = ? WHERE file_id = ? AND collection = ? AND field = ?`)
    .bind(to, fileId, collection, from)
    .run()
}

export async function deleteFieldRules(
  db: D1Database,
  fileId: string,
  collection: string,
  field: string,
) {
  await ensureSchema(db)
  await db
    .prepare(`DELETE FROM rules WHERE file_id = ? AND collection = ? AND field = ?`)
    .bind(fileId, collection, field)
    .run()
}

export async function deleteRule(db: D1Database, fileId: string, collection: string, ruleId: string) {
  await ensureSchema(db)
  const result = await db
    .prepare(`DELETE FROM rules WHERE id = ? AND file_id = ? AND collection = ?`)
    .bind(ruleId, fileId, collection)
    .run()
  return (result.meta.changes ?? 0) > 0
}

/** Check a row against the collection's rules; unique looks at the other rows. */
export function ruleViolations(
  row: Record<string, unknown>,
  rules: Rule[],
  others: { id: string; data: Record<string, unknown> }[],
  selfId?: string,
): Violation[] {
  const violations: Violation[] = []
  for (const rule of rules) {
    const value = row[rule.field]
    const empty = value === undefined || value === null || value === ''
    if (rule.rule === 'required') {
      if (empty) violations.push({ field: rule.field, rule: 'required', message: `${rule.field} is required.` })
      continue
    }
    if (empty) continue
    if (rule.rule === 'type') {
      const wanted = String(rule.value)
      const actual = Array.isArray(value) ? 'array' : typeof value
      if (actual !== wanted)
        violations.push({
          field: rule.field,
          rule: 'type',
          message: `${rule.field} must be a ${wanted}.`,
        })
    } else if (rule.rule === 'unique') {
      const match = others.find(
        (other) => other.id !== selfId && other.data[rule.field] === value,
      )
      if (match)
        violations.push({
          field: rule.field,
          rule: 'unique',
          message: `${rule.field} must be unique; ${String(value)} already exists.`,
        })
    } else if (rule.rule === 'one_of') {
      const allowed = Array.isArray(rule.value) ? rule.value : []
      if (!allowed.some((entry) => String(entry) === String(value)))
        violations.push({
          field: rule.field,
          rule: 'one_of',
          message: `${rule.field} must be one of ${allowed.join(', ')}.`,
        })
    } else if (rule.rule === 'min' || rule.rule === 'max') {
      const bound = Number(rule.value)
      const number = Number(value)
      if (!Number.isFinite(number)) continue
      if (rule.rule === 'min' && number < bound)
        violations.push({ field: rule.field, rule: 'min', message: `${rule.field} must be at least ${bound}.` })
      if (rule.rule === 'max' && number > bound)
        violations.push({ field: rule.field, rule: 'max', message: `${rule.field} may be at most ${bound}.` })
    }
  }
  return violations
}

/* ---------------------------- duplicates --------------------------- */

export async function duplicateGroups(
  db: D1Database,
  fileId: string,
  collection: string,
  field: string,
  limit = 100,
) {
  await ensureSchema(db)
  if (!FIELD.test(field)) return []
  const path = `json_extract(data, '$."${field.replace(/"/g, '')}"')`
  const rows = await db
    .prepare(
      `SELECT ${path} AS value, COUNT(*) AS count, GROUP_CONCAT(id) AS ids
       FROM records WHERE file_id = ? AND collection = ? AND ${path} IS NOT NULL
       GROUP BY value HAVING COUNT(*) > 1 ORDER BY count DESC LIMIT ?`,
    )
    .bind(fileId, collection, limit)
    .all<{ value: unknown; count: number; ids: string }>()
  return (rows.results ?? []).map((row) => ({
    value: row.value,
    count: row.count,
    ids: String(row.ids ?? '').split(',').filter(Boolean),
  }))
}

/* ------------------------------ stats ------------------------------ */

export async function stats(db: D1Database) {
  await ensureSchema(db)
  const row = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM files WHERE deleted_at IS NULL) AS files,
        (SELECT COUNT(*) FROM files WHERE deleted_at IS NOT NULL) AS trash,
        (SELECT COUNT(*) FROM collections c JOIN files f ON f.id = c.file_id WHERE f.deleted_at IS NULL) AS collections,
        (SELECT COUNT(*) FROM records r JOIN files f ON f.id = r.file_id WHERE f.deleted_at IS NULL) AS records,
        (SELECT COUNT(*) FROM events) AS events`,
    )
    .first<{ files: number; trash: number; collections: number; records: number; events: number }>()
  return row ?? { files: 0, trash: 0, collections: 0, records: 0, events: 0 }
}

export function parseJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null as T
  }
}
