import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import { AiError, inferWithAi } from '../lib/ai'
import { fieldsOf } from '../lib/infer'
import { decodeText, extensionOf, readDataset } from '../lib/parse'
import {
  EXPORT_TYPES,
  exportFilename,
  serializeCollections,
  type ExportFormat,
} from '../lib/serialize'
import * as store from '../lib/store'
import type { Collection, Env, Filter, Format, Violation } from '../lib/types'
import { sha256Hex, snapshotFile } from '../lib/writeback'
import {
  collectionExists,
  commit,
  detailOf,
  loadFile,
  ruleFailure,
  sourceGuard,
  staleRevision,
  violationsFor,
} from './helpers'
import {
  authResponses,
  cleanFileName,
  collectionNameSchema,
  errorSchema,
  fail,
  json,
  keySecurity,
  rowSchema,
  validateRow,
} from './shared'

const EXPORT_FORMATS: ExportFormat[] = ['json', 'ndjson', 'csv', 'xml', 'txt']
const FILTER_OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'exists', 'empty'] as const

const filterSchema = z.object({
  field: z.string().max(64),
  op: z.enum(FILTER_OPS).default('eq'),
  value: z.unknown().optional(),
})

export const collectionSchema = z.object({
  name: z.string(),
  recordCount: z.number(),
  fields: z.array(z.object({ name: z.string(), type: z.string(), filled: z.number() })),
})

export const fileSchema = z.object({
  id: z.string(),
  name: z.string(),
  ext: z.string(),
  format: z.string(),
  size: z.number(),
  status: z.string(),
  source: z.string(),
  notes: z.array(z.string()),
  binary: z.boolean(),
  revision: z.number(),
  deletedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const detailSchema = z.object({ file: fileSchema, collections: z.array(collectionSchema) })

const recordSchema = z.object({
  id: z.string(),
  data: rowSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
})

const recordListSchema = z.object({
  records: z.array(recordSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  revision: z.number(),
  fields: collectionSchema.shape.fields,
})

export const violationSchema = z.object({
  recordId: z.string().optional(),
  field: z.string(),
  rule: z.string(),
  message: z.string(),
})

const ruleErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  violations: z.array(violationSchema),
})

export const paramsSchema = z.object({ id: z.string().min(1).max(64) })

function parseFilters(
  raw: string | undefined,
): { ok: true; filters: Filter[] } | { ok: false; message: string } {
  if (!raw) return { ok: true, filters: [] }
  try {
    const parsed = z.array(filterSchema).max(12).safeParse(JSON.parse(raw))
    if (!parsed.success) return { ok: false, message: 'Filters must be a JSON array of {field, op, value}.' }
    return { ok: true, filters: parsed.data as Filter[] }
  } catch {
    return { ok: false, message: 'The filter parameter is not valid JSON.' }
  }
}

export function registerFileRoutes(app: OpenAPIHono<{ Bindings: Env }>) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/files',
      summary: 'List stored files',
      request: { query: z.object({ trash: z.enum(['true']).optional() }) },
      responses: {
        200: {
          description: 'Every file with its collection and record counts.',
          content: json(
            z.object({
              files: z.array(
                fileSchema.extend({
                  collectionCount: z.number(),
                  recordCount: z.number(),
                }),
              ),
            }),
          ),
        },
      },
    }),
    async (c) => {
      const rows = await store.listFiles(c.env.DB, c.req.valid('query').trash === 'true')
      return c.json(
        {
          files: rows.map((row) => ({
            ...store.toStoredFile(row),
            collectionCount: row.collection_count,
            recordCount: row.record_count,
          })),
        },
        200,
      )
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/files',
      summary: 'Upload a file and read its collections',
      security: keySecurity,
      request: {
        query: z.object({ name: z.string().min(1).max(160).optional() }),
        headers: z.object({ 'x-file-name': z.string().min(1).max(160).optional() }),
      },
      responses: {
        ...authResponses,
        201: { description: 'The stored file with inferred collections.', content: json(detailSchema) },
        400: { description: 'Missing name or empty file.', content: json(errorSchema) },
        413: { description: 'File too large.', content: json(errorSchema) },
        500: { description: 'The file could not be stored.', content: json(errorSchema) },
      },
    }),
    async (c) => {
      const name = cleanFileName(
        c.req.valid('query').name ?? c.req.valid('header')['x-file-name'] ?? '',
      )
      if (!name)
        return fail(c, 400, 'invalid_name', 'Send ?name=<file name> or an x-file-name header.')
      const bytes = new Uint8Array(await c.req.arrayBuffer())
      if (!bytes.byteLength) return fail(c, 400, 'empty_file', 'The file is empty.')

      const dataset = readDataset(name, bytes)
      const id = crypto.randomUUID()
      const hash = await sha256Hex(bytes)
      await c.env.FILES.put(`files/${id}`, bytes, {
        httpMetadata: { contentType: 'application/octet-stream' },
      })
      // The upload is kept untouched so a rewrite always has a way back.
      await c.env.FILES.put(`originals/${id}`, bytes, {
        httpMetadata: { contentType: 'application/octet-stream' },
      })
      await store.createFile(c.env.DB, {
        id,
        name,
        ext: extensionOf(name),
        format: dataset.format,
        size: bytes.byteLength,
        status: dataset.collections.length ? 'ready' : 'needs_ai',
        source: 'heuristic',
        notes: dataset.notes,
        binary: dataset.format === 'binary',
        sourceHash: hash,
      })
      if (dataset.collections.length)
        await store.replaceCollections(c.env.DB, id, dataset.collections)
      else await autoInfer(c.env, id, name, bytes, dataset.format, dataset.notes, hash)

      await store.logEvent(c.env.DB, {
        fileId: id,
        action: 'file.uploaded',
        detail: { name, size: bytes.byteLength, format: dataset.format },
      })

      const row = await store.getFileRow(c.env.DB, id)
      if (!row) return fail(c, 500, 'internal_error', 'The file could not be stored.')
      return c.json(await detailOf(c.env.DB, store.toStoredFile(row)), 201)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/files/{id}',
      summary: 'Show one file and its collections',
      request: { params: paramsSchema },
      responses: {
        200: { description: 'The file with its collections and fields.', content: json(detailSchema) },
        404: { description: 'No such file.', content: json(errorSchema) },
      },
    }),
    async (c) => {
      const loaded = await loadFile(c, c.req.valid('param').id)
      if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
      return c.json(await detailOf(c.env.DB, loaded.file), 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/files/{id}',
      summary: 'Move a file to the trash',
      security: keySecurity,
      request: { params: paramsSchema },
      responses: {
        ...authResponses,
        200: { description: 'The file is in the trash.', content: json(z.object({ ok: z.boolean() })) },
        404: { description: 'No such file.', content: json(errorSchema) },
      },
    }),
    async (c) => {
      const loaded = await loadFile(c, c.req.valid('param').id)
      if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
      await store.softDeleteFile(c.env.DB, loaded.row.id)
      await store.logEvent(c.env.DB, {
        fileId: loaded.row.id,
        action: 'file.trashed',
        detail: { name: loaded.row.name },
      })
      return c.json({ ok: true }, 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/files/{id}/read',
      summary: 'Read the file again, or hand it to the model',
      security: keySecurity,
      request: {
        params: paramsSchema,
        body: {
          required: false,
          content: json(
            z.object({
              mode: z.enum(['heuristic', 'ai']).optional(),
              force: z.boolean().optional(),
            }),
          ),
        },
      },
      responses: {
        ...authResponses,
        200: { description: 'The file with refreshed collections.', content: json(detailSchema) },
        400: { description: 'No model key is configured.', content: json(errorSchema) },
        404: { description: 'No such file.', content: json(errorSchema) },
        409: {
          description: 'The original file is missing or changed outside Cabinet.',
          content: json(errorSchema),
        },
        422: { description: 'The model could not read the file.', content: json(errorSchema) },
        502: { description: 'The model service failed.', content: json(errorSchema) },
      },
    }),
    async (c) => {
      const loaded = await loadFile(c, c.req.valid('param').id)
      if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
      const { row, file } = loaded

      const stale = staleRevision(c, loaded.row)
      if (stale) return stale

      const object = await c.env.FILES.get(`files/${row.id}`)
      if (!object) return fail(c, 409, 'source_missing', 'The original file is no longer stored.')
      const bytes = new Uint8Array(await object.arrayBuffer())
      const hash = await sha256Hex(bytes)
      const body = c.req.valid('json')
      const force = body?.force === true || c.req.header('x-cabinet-force') === 'true'
      const changed = Boolean(row.source_hash) && hash !== row.source_hash
      if (changed && !force)
        return fail(
          c,
          409,
          'source_changed',
          'The stored file changed outside Cabinet. Send {"force":true} to read it again, or edit with x-cabinet-force.',
        )
      if (changed) await snapshotFile(c.env, file, 'file changed outside Cabinet')

      const mode = body?.mode ?? 'heuristic'
      let notes: string[] = []
      let format: Format = file.format as Format
      let source = 'heuristic'
      let status = 'ready'

      if (mode === 'ai') {
        const { text, binary } = decodeText(bytes)
        const trimmed = text.replace(/[^\x20-\x7E\s]/g, '')
        if (binary && trimmed.replace(/\s/g, '').length < 16)
          return fail(
            c,
            422,
            'no_readable_text',
            'This file has no readable text for the model to interpret.',
          )
        try {
          const result = await inferWithAi(c.env, row.name, text)
          await store.replaceCollections(c.env.DB, row.id, result.collections)
          notes = result.notes
          source = 'ai'
        } catch (error) {
          if (error instanceof AiError)
            return fail(
              c,
              error.code === 'ai_not_configured' ? 400 : 502,
              error.code,
              error.message,
            )
          throw error
        }
      } else {
        const dataset = readDataset(row.name, bytes)
        await store.replaceCollections(c.env.DB, row.id, dataset.collections)
        notes = dataset.notes
        format = dataset.format
        status = dataset.collections.length ? 'ready' : 'needs_ai'
      }

      await store.updateFileMeta(c.env.DB, row.id, {
        format,
        status,
        source,
        notes,
        size: bytes.byteLength,
        sourceHash: hash,
      })
      await store.bumpRevision(c.env.DB, row.id)
      await store.logEvent(c.env.DB, {
        fileId: row.id,
        action: 'file.read',
        detail: { mode, changed },
      })

      const refreshed = await store.getFileRow(c.env.DB, row.id)
      if (!refreshed) return fail(c, 404, 'file_not_found', 'That file is not in the cabinet.')
      return c.json(await detailOf(c.env.DB, store.toStoredFile(refreshed)), 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/files/{id}/collections',
      summary: 'Add an empty collection',
      security: keySecurity,
      request: {
        params: paramsSchema,
        body: { required: true, content: json(z.object({ name: collectionNameSchema })) },
      },
      responses: {
        ...authResponses,
        201: { description: 'The collection exists.', content: json(detailSchema) },
        404: { description: 'No such file.', content: json(errorSchema) },
        409: { description: 'That collection already exists, or the file changed.', content: json(errorSchema) },
      },
    }),
    async (c) => {
      const loaded = await loadFile(c, c.req.valid('param').id)
      if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
      const stale = staleRevision(c, loaded.row)
      if (stale) return stale
      const fresh = await sourceGuard(c, loaded.file)
      if (fresh) return fresh

      const { name } = c.req.valid('json')
      if (await collectionExists(c.env.DB, loaded.row.id, name))
        return fail(c, 409, 'collection_exists', 'A collection with that name already exists.')
      await store.addCollection(c.env.DB, loaded.row.id, name)
      await commit(c.env, loaded.file, {
        reason: 'collection created',
        action: 'collection.created',
        collection: name,
        detail: { name },
      })
      const refreshed = await store.getFileRow(c.env.DB, loaded.row.id)
      if (!refreshed) return fail(c, 404, 'file_not_found', 'That file is not in the cabinet.')
      return c.json(await detailOf(c.env.DB, store.toStoredFile(refreshed)), 201)
    },
  )

  app.get('/api/files/:id/export', async (c) => {
    const id = c.req.param('id')
    const requested = (c.req.query('format') ?? 'json').toLowerCase() as ExportFormat
    if (!EXPORT_FORMATS.includes(requested))
      return fail(c, 400, 'invalid_format', `Choose one of: ${EXPORT_FORMATS.join(', ')}.`)
    const row = await store.getActiveFileRow(c.env.DB, id)
    if (!row) return fail(c, 404, 'file_not_found', 'That file is not in the cabinet.')

    const collections: Collection[] = []
    for (const entry of await store.listCollections(c.env.DB, id)) {
      const records = []
      let offset = 0
      for (;;) {
        const page = await store.queryRecords(c.env.DB, id, entry.name, {
          limit: 1000,
          offset,
          direction: 'asc',
        })
        records.push(...page.records.map((record) => record.data))
        offset += 1000
        if (!page.records.length || offset >= page.total) break
      }
      collections.push({ name: entry.name, records })
    }
    const body = serializeCollections(collections, requested)
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': `${EXPORT_TYPES[requested]}; charset=utf-8`,
        'Content-Disposition': `attachment; filename="${exportFilename(row.name, requested)}"`,
        'Cache-Control': 'no-store',
      },
    })
  })

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/files/{id}/records/{collection}',
      summary: 'List records in a collection',
      request: {
        params: z.object({ id: z.string(), collection: z.string() }),
        query: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
          q: z.string().trim().max(200).optional(),
          filter: z.string().max(2000).optional(),
          sort: z.string().trim().max(64).optional(),
          dir: z.enum(['asc', 'desc']).default('asc'),
        }),
      },
      responses: {
        200: { description: 'Records plus the collection fields.', content: json(recordListSchema) },
        400: { description: 'Invalid filter.', content: json(errorSchema) },
        404: { description: 'No such file or collection.', content: json(errorSchema) },
      },
    }),
    async (c) => {
      const { id, collection } = c.req.valid('param')
      const loaded = await loadFile(c, id)
      if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
      if (!(await collectionExists(c.env.DB, id, collection)))
        return fail(c, 404, 'collection_not_found', 'That collection does not exist.')
      const query = c.req.valid('query')
      const filters = parseFilters(query.filter)
      if (!filters.ok) return fail(c, 400, 'invalid_filter', filters.message)
      const page = await store.queryRecords(c.env.DB, id, collection, {
        limit: query.limit,
        offset: query.offset,
        q: query.q,
        filters: filters.filters,
        sort: query.sort,
        direction: query.dir,
      })
      return c.json(
        {
          records: page.records,
          total: page.total,
          limit: query.limit,
          offset: query.offset,
          revision: loaded.file.revision,
          fields: fieldsOf(page.records.map((record) => record.data)),
        },
        200,
      )
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/files/{id}/records/{collection}',
      summary: 'Add a record',
      security: keySecurity,
      request: {
        params: z.object({ id: z.string(), collection: z.string() }),
        body: { required: true, content: json(rowSchema) },
      },
      responses: {
        ...authResponses,
        201: { description: 'The created record.', content: json(recordSchema) },
        400: { description: 'Invalid record.', content: json(errorSchema) },
        404: { description: 'No such file or collection.', content: json(errorSchema) },
        409: { description: 'Stale revision or the file changed outside Cabinet.', content: json(errorSchema) },
        422: { description: 'The record breaks a collection rule.', content: json(ruleErrorSchema) },
      },
    }),
    async (c) => {
      const { id, collection } = c.req.valid('param')
      const loaded = await loadFile(c, id)
      if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
      if (!(await collectionExists(c.env.DB, id, collection)))
        return fail(c, 404, 'collection_not_found', 'That collection does not exist.')
      const stale = staleRevision(c, loaded.row)
      if (stale) return stale
      const fresh = await sourceGuard(c, loaded.file)
      if (fresh) return fresh

      const checked = validateRow(c.req.valid('json'))
      if (!checked.ok) return fail(c, 400, 'invalid_record', checked.message)
      const violations = await violationsFor(c.env.DB, id, collection, checked.row)
      if (violations.length) return ruleFailure(c, violations)

      const created = await store.insertRecord(c.env.DB, id, collection, checked.row)
      await commit(c.env, loaded.file, {
        reason: 'record created',
        action: 'record.created',
        collection,
        recordId: created.id,
        detail: { fields: Object.keys(checked.row) },
      })
      return c.json(created, 201)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/files/{id}/records/{collection}/{recordId}',
      summary: 'Show one record',
      request: {
        params: z.object({ id: z.string(), collection: z.string(), recordId: z.string() }),
      },
      responses: {
        200: { description: 'The record.', content: json(recordSchema) },
        404: { description: 'No such record.', content: json(errorSchema) },
      },
    }),
    async (c) => {
      const { id, collection, recordId } = c.req.valid('param')
      const record = await store.getRecord(c.env.DB, id, collection, recordId)
      if (!record) return fail(c, 404, 'record_not_found', 'That record no longer exists.')
      return c.json(record, 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/files/{id}/records/{collection}/{recordId}',
      summary: 'Replace a record',
      security: keySecurity,
      request: {
        params: z.object({ id: z.string(), collection: z.string(), recordId: z.string() }),
        body: { required: true, content: json(rowSchema) },
      },
      responses: {
        ...authResponses,
        200: { description: 'The updated record.', content: json(recordSchema) },
        400: { description: 'Invalid record.', content: json(errorSchema) },
        404: { description: 'No such record.', content: json(errorSchema) },
        409: { description: 'Stale revision or the file changed outside Cabinet.', content: json(errorSchema) },
        422: { description: 'The record breaks a collection rule.', content: json(ruleErrorSchema) },
      },
    }),
    async (c) => {
      const { id, collection, recordId } = c.req.valid('param')
      const loaded = await loadFile(c, id)
      if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
      const existing = await store.getRecord(c.env.DB, id, collection, recordId)
      if (!existing) return fail(c, 404, 'record_not_found', 'That record no longer exists.')
      const stale = staleRevision(c, loaded.row)
      if (stale) return stale
      const fresh = await sourceGuard(c, loaded.file)
      if (fresh) return fresh

      const checked = validateRow(c.req.valid('json'))
      if (!checked.ok) return fail(c, 400, 'invalid_record', checked.message)
      const violations = await violationsFor(c.env.DB, id, collection, checked.row, recordId)
      if (violations.length) return ruleFailure(c, violations)

      const updated = await store.updateRecord(c.env.DB, id, collection, recordId, checked.row)
      await commit(c.env, loaded.file, {
        reason: 'record updated',
        action: 'record.updated',
        collection,
        recordId,
        detail: { fields: Object.keys(checked.row) },
      })
      return c.json(updated ?? existing, 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/files/{id}/records/{collection}/{recordId}',
      summary: 'Delete a record',
      security: keySecurity,
      request: {
        params: z.object({ id: z.string(), collection: z.string(), recordId: z.string() }),
      },
      responses: {
        ...authResponses,
        200: { description: 'The record was deleted.', content: json(z.object({ ok: z.boolean() })) },
        404: { description: 'No such record.', content: json(errorSchema) },
        409: { description: 'Stale revision or the file changed outside Cabinet.', content: json(errorSchema) },
      },
    }),
    async (c) => {
      const { id, collection, recordId } = c.req.valid('param')
      const loaded = await loadFile(c, id)
      if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
      const stale = staleRevision(c, loaded.row)
      if (stale) return stale
      const fresh = await sourceGuard(c, loaded.file)
      if (fresh) return fresh

      const removed = await store.deleteRecord(c.env.DB, id, collection, recordId)
      if (!removed) return fail(c, 404, 'record_not_found', 'That record no longer exists.')
      await commit(c.env, loaded.file, {
        reason: 'record deleted',
        action: 'record.deleted',
        collection,
        recordId,
      })
      return c.json({ ok: true }, 200)
    },
  )
}

/** When a file has no readable structure, ask the model once on upload. */
async function autoInfer(
  env: Env,
  id: string,
  name: string,
  bytes: Uint8Array,
  format: Format,
  notes: string[],
  hash: string,
) {
  if (!env.OPENAI_API_KEY || format === 'binary') return
  const { text } = decodeText(bytes)
  if (text.replace(/\s/g, '').length < 8) return
  try {
    const result = await inferWithAi(env, name, text)
    await store.replaceCollections(env.DB, id, result.collections)
    await store.updateFileMeta(env.DB, id, {
      status: 'ready',
      source: 'ai',
      notes: result.notes,
      sourceHash: hash,
    })
    await store.bumpRevision(env.DB, id)
    await store.logEvent(env.DB, {
      fileId: id,
      action: 'file.read',
      detail: { mode: 'ai', automatic: true },
    })
  } catch (error) {
    if (!(error instanceof AiError)) throw error
    await store.updateFileMeta(env.DB, id, { notes: [...notes, error.message] })
  }
}

export type { Violation }
