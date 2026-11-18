import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { z } from 'zod'
import { fieldsOf } from '../lib/infer'
import * as store from '../lib/store'
import type { Env, Violation } from '../lib/types'
import { sha256Hex, snapshotFile, syncFileContent } from '../lib/writeback'
import { fail } from './shared'

export type AppContext = Context<{ Bindings: Env }>
export type FileContext = { row: store.FileDbRow; file: store.StoredFile }
export type FileLookup =
  | ({ ok: true } & FileContext)
  | { ok: false; code: string; message: string }

export function jsonError(
  status: ContentfulStatusCode,
  code: string,
  message: string,
): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Load a file, refusing rows that are in the trash unless explicitly allowed. */
export async function loadFile(
  _c: AppContext,
  id: string,
  allowTrash = false,
): Promise<FileLookup> {
  const row = await store.getFileRow(_c.env.DB, id)
  if (!row)
    return { ok: false, code: 'file_not_found', message: 'That file is not in the cabinet.' }
  if (row.deleted_at && !allowTrash)
    return { ok: false, code: 'file_trashed', message: 'That file is in the trash. Restore it first.' }
  return { ok: true, row, file: store.toStoredFile(row) }
}

/** If-Match, when present, must name the revision the client last saw. */
export function staleRevision(c: AppContext, row: { revision: number }) {
  const header = c.req.header('if-match')
  if (!header) return null
  const wanted = Number(header.replace(/^W\//, '').replace(/"/g, '').trim())
  if (Number.isFinite(wanted) && wanted === row.revision) return null
  return fail(
    c,
    409,
    'stale_revision',
    `This file is at revision ${row.revision}; reload it before saving.`,
  )
}

/**
 * Refuse to overwrite a file that changed outside Cabinet. Repeating the
 * request with `x-cabinet-force: true` snapshots the outside version first.
 */
export async function sourceGuard(c: AppContext, file: store.StoredFile) {
  const object = await c.env.FILES.get(`files/${file.id}`)
  if (!object) return null
  const hash = await sha256Hex(new Uint8Array(await object.arrayBuffer()))
  if (!file.sourceHash || hash === file.sourceHash) return null
  if (c.req.header('x-cabinet-force') === 'true') {
    await snapshotFile(c.env, file, 'before overwriting a file changed outside Cabinet')
    return null
  }
  return fail(
    c,
    409,
    'source_changed',
    'The stored file changed outside Cabinet. Read it again, or repeat the request with x-cabinet-force: true.',
  )
}

export async function jsonBody<T>(c: AppContext, schema: z.ZodType<T>): Promise<T | Response> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return fail(c, 400, 'invalid_input', 'Send a JSON body.')
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success)
    return fail(c, 400, 'invalid_input', parsed.error.issues[0]?.message ?? 'Check the request fields.')
  return parsed.data
}

export async function detailOf(db: D1Database, file: store.StoredFile) {
  const listed = await store.listCollections(db, file.id)
  const collections = []
  for (const entry of listed) {
    const sample = await store.sampleRecords(db, file.id, entry.name, 200)
    collections.push({
      name: entry.name,
      recordCount: entry.record_count,
      fields: fieldsOf(sample.map((record) => record.data)),
    })
  }
  return { file, collections }
}

export async function collectionExists(db: D1Database, fileId: string, name: string) {
  const row = await db
    .prepare(`SELECT 1 AS ok FROM collections WHERE file_id = ? AND name = ?`)
    .bind(fileId, name)
    .first<{ ok: number }>()
  return Boolean(row)
}

/** Rules are optional; when a collection has them, writes must satisfy them. */
export async function violationsFor(
  db: D1Database,
  fileId: string,
  collection: string,
  row: Record<string, unknown>,
  selfId?: string,
): Promise<Violation[]> {
  const rules = await store.listRules(db, fileId, collection)
  if (!rules.length) return []
  const others = (await store.allRecords(db, fileId, collection)).map((record) => ({
    id: record.id,
    data: record.data,
  }))
  return store.ruleViolations(row, rules, others, selfId)
}

export function ruleFailure(c: AppContext, violations: Violation[]) {
  return c.json(
    {
      error: {
        code: 'rule_violation',
        message: violations[0]?.message ?? 'The record breaks a rule.',
      },
      violations,
    },
    422,
  )
}

/**
 * One place for the order every data change follows: history first, then the
 * revision bump, then the file write, then the audit event.
 */
export async function commit(
  env: Env,
  file: store.StoredFile,
  change: {
    reason: string
    action: string
    collection?: string | null
    recordId?: string | null
    detail?: Record<string, unknown>
    sync?: boolean
  },
): Promise<number> {
  await snapshotFile(env, file, change.reason)
  const revision = await store.bumpRevision(env.DB, file.id)
  if (change.sync !== false) await syncFileContent(env, file.id)
  await store.logEvent(env.DB, {
    fileId: file.id,
    collection: change.collection ?? null,
    recordId: change.recordId ?? null,
    action: change.action,
    detail: { ...change.detail, revision },
  })
  return revision
}
