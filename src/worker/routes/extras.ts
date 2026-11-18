import type { Hono } from 'hono'
import { z } from 'zod'
import { AiError, planQuery, suggestFixes, suggestMapping } from '../lib/ai'
import { readDataset } from '../lib/parse'
import { fieldsOf } from '../lib/infer'
import * as store from '../lib/store'
import type { Env, Filter, Row, RuleName, Violation } from '../lib/types'
import { snapshotFile } from '../lib/writeback'
import {
  collectionExists,
  commit,
  detailOf,
  jsonBody,
  loadFile,
  ruleFailure,
  sourceGuard,
  staleRevision,
  type AppContext,
} from './helpers'
import { cleanFileName, collectionNameSchema, fail, rowSchema, validateRow } from './shared'

const FILTER_OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'exists', 'empty'] as const
const filterSchema = z.object({
  field: z.string().max(64),
  op: z.enum(FILTER_OPS).default('eq'),
  value: z.unknown().optional(),
})
const filtersSchema = z.array(filterSchema).max(12)

const KEY = /^[A-Za-z0-9_@#.$ /-]{1,64}$/
const RULES: RuleName[] = ['required', 'type', 'unique', 'one_of', 'min', 'max']

function download(bytes: ArrayBuffer, name: string): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${name.replace(/["\\]/g, '')}"`,
      'Cache-Control': 'no-store',
    },
  })
}

function aiFailure(c: AppContext, error: unknown): Response {
  if (error instanceof AiError)
    return fail(c, error.code === 'ai_not_configured' ? 400 : 502, error.code, error.message)
  throw error
}

/** A malformed ?limit must not turn into NaN, which SQLite cannot bind. */
function eventLimit(c: AppContext, fallback: number): number {
  const value = Number(c.req.query('limit'))
  return Number.isFinite(value) ? value : fallback
}

export function registerExtraRoutes(app: Hono<{ Bindings: Env }>) {
  const api = app as unknown as Hono<{ Bindings: Env }>

  /* --------------------------- source files -------------------------- */

  api.get('/api/files/:id/source', async (c) => {
    const loaded = await loadFile(c, c.req.param('id'))
    if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
    const object = await c.env.FILES.get(`files/${loaded.row.id}`)
    if (!object) return fail(c, 404, 'source_missing', 'The stored file is gone.')
    return download(await object.arrayBuffer(), loaded.row.name)
  })

  api.get('/api/files/:id/original', async (c) => {
    const loaded = await loadFile(c, c.req.param('id'))
    if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
    const object = await c.env.FILES.get(`originals/${loaded.row.id}`)
    if (!object) return fail(c, 404, 'original_missing', 'No untouched upload was kept for this file.')
    return download(await object.arrayBuffer(), `original-${loaded.row.name}`)
  })

  /* ---------------------------- versions ----------------------------- */

  api.get('/api/files/:id/versions', async (c) => {
    const loaded = await loadFile(c, c.req.param('id'))
    if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
    const versions = await store.listVersions(c.env.DB, loaded.row.id)
    return c.json({
      versions: versions.map((version) => ({
        id: version.id,
        revision: version.revision,
        size: version.size,
        format: version.format,
        reason: version.reason,
        createdAt: version.createdAt,
      })),
    })
  })

  api.post('/api/files/:id/versions/:versionId/restore', async (c) => {
    const loaded = await loadFile(c, c.req.param('id'))
    if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
    const stale = staleRevision(c, loaded.row)
    if (stale) return stale

    const version = await store.getVersion(c.env.DB, loaded.row.id, c.req.param('versionId'))
    if (!version) return fail(c, 404, 'version_not_found', 'That version is no longer kept.')
    const object = await c.env.FILES.get(version.bytes_key)
    if (!object) return fail(c, 404, 'version_missing', 'That version was pruned from storage.')
    const bytes = new Uint8Array(await object.arrayBuffer())

    // Keep the bytes currently on disk before they are replaced.
    await snapshotFile(c.env, loaded.file, 'before restore')

    await c.env.FILES.put(`files/${loaded.row.id}`, bytes, {
      httpMetadata: { contentType: 'application/octet-stream' },
    })
    const dataset = readDataset(loaded.row.name, bytes)
    await store.replaceCollections(c.env.DB, loaded.row.id, dataset.collections)
    await store.updateFileMeta(c.env.DB, loaded.row.id, {
      format: dataset.format,
      status: dataset.collections.length ? 'ready' : 'needs_ai',
      source: 'heuristic',
      notes: [
        ...dataset.notes,
        `Restored the version from ${new Date(version.created_at).toISOString()}.`,
      ],
      size: bytes.byteLength,
      sourceHash: version.hash,
    })
    const revision = await store.bumpRevision(c.env.DB, loaded.row.id)
    await store.logEvent(c.env.DB, {
      fileId: loaded.row.id,
      action: 'version.restored',
      detail: { versionId: version.id, revision },
    })

    const refreshed = await store.getFileRow(c.env.DB, loaded.row.id)
    if (!refreshed) return fail(c, 404, 'file_not_found', 'That file is not in the cabinet.')
    return c.json(await detailOf(c.env.DB, store.toStoredFile(refreshed)))
  })

  /* ------------------------------ trash ------------------------------ */

  api.get('/api/trash', async (c) => {
    const rows = await store.listFiles(c.env.DB, true)
    return c.json({
      files: rows.map((row) => ({
        ...store.toStoredFile(row),
        collectionCount: row.collection_count,
        recordCount: row.record_count,
      })),
    })
  })

  api.post('/api/files/:id/restore', async (c) => {
    const loaded = await loadFile(c, c.req.param('id'), true)
    if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
    if (!loaded.row.deleted_at) return fail(c, 409, 'not_trashed', 'That file is not in the trash.')
    await store.restoreFileRow(c.env.DB, loaded.row.id)
    await store.logEvent(c.env.DB, { fileId: loaded.row.id, action: 'file.restored' })
    const refreshed = await store.getFileRow(c.env.DB, loaded.row.id)
    if (!refreshed) return fail(c, 404, 'file_not_found', 'That file is not in the cabinet.')
    return c.json(await detailOf(c.env.DB, store.toStoredFile(refreshed)))
  })

  api.delete('/api/files/:id/purge', async (c) => {
    const loaded = await loadFile(c, c.req.param('id'), true)
    if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
    if (!loaded.row.deleted_at)
      return fail(c, 409, 'not_trashed', 'Move the file to the trash before deleting it for good.')
    for (const version of await store.listVersions(c.env.DB, loaded.row.id))
      await c.env.FILES.delete(version.bytesKey)
    await c.env.FILES.delete(`files/${loaded.row.id}`)
    await c.env.FILES.delete(`originals/${loaded.row.id}`)
    await store.deleteFileRecord(c.env.DB, loaded.row.id)
    await store.logEvent(c.env.DB, {
      action: 'file.purged',
      detail: { name: loaded.row.name },
    })
    return c.json({ ok: true })
  })

  api.delete('/api/trash', async (c) => {
    const rows = await store.listFiles(c.env.DB, true)
    let purged = 0
    for (const row of rows) {
      for (const version of await store.listVersions(c.env.DB, row.id))
        await c.env.FILES.delete(version.bytesKey)
      await c.env.FILES.delete(`files/${row.id}`)
      await c.env.FILES.delete(`originals/${row.id}`)
      await store.deleteFileRecord(c.env.DB, row.id)
      purged += 1
    }
    await store.logEvent(c.env.DB, { action: 'trash.emptied', detail: { purged } })
    return c.json({ ok: true, purged })
  })

  /* ----------------------------- schema ------------------------------ */

  const schemaBody = z.discriminatedUnion('action', [
    z.object({
      action: z.literal('rename_field'),
      from: z.string().max(64).regex(KEY),
      to: z.string().max(64).regex(KEY),
    }),
    z.object({ action: z.literal('delete_field'), field: z.string().max(64).regex(KEY) }),
    z.object({ action: z.literal('rename'), name: collectionNameSchema }),
    z.object({
      action: z.literal('retype'),
      field: z.string().max(64).regex(KEY),
      type: z.enum(['string', 'number', 'boolean']),
    }),
  ])

  api.post('/api/files/:id/collections/:collection/schema', async (c) => {
    const id = c.req.param('id')
    const collection = c.req.param('collection')
    const loaded = await loadFile(c, id)
    if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
    if (!(await collectionExists(c.env.DB, id, collection)))
      return fail(c, 404, 'collection_not_found', 'That collection does not exist.')
    const stale = staleRevision(c, loaded.row)
    if (stale) return stale
    const fresh = await sourceGuard(c, loaded.file)
    if (fresh) return fresh
    const body = await jsonBody(c, schemaBody)
    if (body instanceof Response) return body

    const rows = await store.allRecords(c.env.DB, id, collection)
    let changed = 0
    let failed = 0
    let target = collection

    if (body.action === 'rename') {
      if (body.name === collection) return fail(c, 400, 'no_change', 'The collection already has that name.')
      if (!(await store.renameCollection(c.env.DB, id, collection, body.name)))
        return fail(c, 409, 'collection_exists', 'A collection with that name already exists.')
      await store.updateFileMeta(c.env.DB, id, {
        notes: [...loaded.file.notes, `Collection ${collection} was renamed to ${body.name}.`],
      })
      await commit(c.env, loaded.file, {
        reason: 'collection renamed',
        action: 'collection.renamed',
        collection: body.name,
        detail: { from: collection, to: body.name },
      })
      target = body.name
      const refreshed = await store.getFileRow(c.env.DB, id)
      if (!refreshed) return fail(c, 404, 'file_not_found', 'That file is not in the cabinet.')
      return c.json({
        ...(await detailOf(c.env.DB, store.toStoredFile(refreshed))),
        changed: rows.length,
      })
    }

    if (body.action === 'rename_field') {
      if (body.from === body.to)
        return fail(c, 400, 'no_change', 'The field already has that name.')
      if (rows.some((row) => body.to in row.data))
        return fail(c, 409, 'field_exists', `“${body.to}” already exists in this collection.`)
      const updated = rows
        .filter((row) => body.from in row.data)
        .map((row) => {
          const { [body.from]: value, ...rest } = row.data
          return { id: row.id, data: { ...rest, [body.to]: value } }
        })
      await store.replaceRecordData(c.env.DB, updated)
      await store.renameRuleField(c.env.DB, id, collection, body.from, body.to)
      changed = updated.length
    } else if (body.action === 'delete_field') {
      const updated = rows
        .filter((row) => body.field in row.data)
        .map((row) => {
          const { [body.field]: _gone, ...rest } = row.data
          return { id: row.id, data: rest }
        })
      await store.replaceRecordData(c.env.DB, updated)
      await store.deleteFieldRules(c.env.DB, id, collection, body.field)
      changed = updated.length
    } else {
      const updated = []
      for (const row of rows) {
        if (!(body.field in row.data)) continue
        const value = row.data[body.field]
        if (value === null || value === undefined) continue
        let next: unknown
        if (body.type === 'string') next = String(value)
        else if (body.type === 'number') {
          const number = typeof value === 'number' ? value : Number(value)
          if (!Number.isFinite(number)) {
            failed += 1
            continue
          }
          next = number
        } else {
          if (typeof value === 'boolean') next = value
          else if (value === 'true' || value === 'false') next = value === 'true'
          else {
            failed += 1
            continue
          }
        }
        updated.push({ id: row.id, data: { ...row.data, [body.field]: next } })
      }
      await store.replaceRecordData(c.env.DB, updated)
      changed = updated.length
    }

    await commit(c.env, loaded.file, {
      reason: `schema ${body.action}`,
      action: 'schema.changed',
      collection: target,
      detail: { action: body.action, changed, failed },
    })
    const refreshed = await store.getFileRow(c.env.DB, id)
    if (!refreshed) return fail(c, 404, 'file_not_found', 'That file is not in the cabinet.')
    return c.json({ ...(await detailOf(c.env.DB, store.toStoredFile(refreshed))), changed, failed })
  })

  api.delete('/api/files/:id/collections/:collection', async (c) => {
    const id = c.req.param('id')
    const collection = c.req.param('collection')
    const loaded = await loadFile(c, id)
    if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
    if (!(await collectionExists(c.env.DB, id, collection)))
      return fail(c, 404, 'collection_not_found', 'That collection does not exist.')
    const stale = staleRevision(c, loaded.row)
    if (stale) return stale
    const fresh = await sourceGuard(c, loaded.file)
    if (fresh) return fresh
    await store.dropCollection(c.env.DB, id, collection)
    await commit(c.env, loaded.file, {
      reason: 'collection dropped',
      action: 'collection.dropped',
      collection,
    })
    const refreshed = await store.getFileRow(c.env.DB, id)
    if (!refreshed) return fail(c, 404, 'file_not_found', 'That file is not in the cabinet.')
    return c.json(await detailOf(c.env.DB, store.toStoredFile(refreshed)))
  })

  /* ----------------------------- import ------------------------------ */

  api.post('/api/files/:id/collections/:collection/import', async (c) => {
    const id = c.req.param('id')
    const collection = c.req.param('collection')
    const loaded = await loadFile(c, id)
    if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
    if (!(await collectionExists(c.env.DB, id, collection)))
      return fail(c, 404, 'collection_not_found', 'That collection does not exist.')
    const stale = staleRevision(c, loaded.row)
    if (stale) return stale
    const fresh = await sourceGuard(c, loaded.file)
    if (fresh) return fresh

    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (!bytes.byteLength) return fail(c, 400, 'empty_file', 'The import is empty.')
    const name = cleanFileName(c.req.query('name') ?? `${collection}.txt`)
    const dataset = readDataset(name, bytes)
    const source =
      dataset.collections.find((entry) => entry.name === collection) ?? dataset.collections[0]
    if (!source) return fail(c, 422, 'no_records', 'No records could be read from that file.')

    const mode = c.req.query('mode') === 'upsert' ? 'upsert' : 'append'
    const key = c.req.query('key') ?? ''
    if (mode === 'upsert' && !KEY.test(key))
      return fail(c, 400, 'invalid_key', 'Choose the field to match on for upsert.')

    const rules = await store.listRules(c.env.DB, id, collection)
    const existing = rules.length ? await store.allRecords(c.env.DB, id, collection) : []
    // Every accepted row joins this list straight away, so a later row in the
    // same batch is checked against the rows this import has already written.
    const visibleRows = existing.map((record) => ({ id: record.id, data: record.data }))

    let inserted = 0
    let updated = 0
    let skipped = 0
    const violations: { field: string; rule: string; message: string }[] = []

    const rows = source.records.slice(0, 5000)
    const truncated = source.records.length > rows.length

    for (const row of rows) {
      const checked = validateRow(row)
      if (!checked.ok) {
        skipped += 1
        violations.push({ field: '', rule: 'record', message: checked.message })
        continue
      }
      const match =
        mode === 'upsert'
          ? await store.findRecordByField(c.env.DB, id, collection, key, checked.row[key])
          : null
      const broken = store.ruleViolations(checked.row, rules, visibleRows, match?.id)
      if (broken.length) {
        skipped += 1
        violations.push(...broken)
        continue
      }
      if (match) {
        await store.updateRecord(c.env.DB, id, collection, match.id, checked.row)
        const known = visibleRows.find((entry) => entry.id === match.id)
        if (known) known.data = checked.row
        updated += 1
        continue
      }
      const created = await store.insertRecord(c.env.DB, id, collection, checked.row)
      visibleRows.push({ id: created.id, data: checked.row })
      inserted += 1
    }

    if (inserted || updated)
      await commit(c.env, loaded.file, {
        reason: `import (${mode})`,
        action: 'records.imported',
        collection,
        detail: { mode, key: key || null, inserted, updated, skipped, truncated },
      })

    return c.json({
      inserted,
      updated,
      skipped,
      truncated,
      violations: violations.slice(0, 20),
      revision: (await store.getFileRow(c.env.DB, id))?.revision ?? loaded.row.revision,
    })
  })

  /* ------------------------------ bulk ------------------------------- */

  const bulkBody = z.object({
    action: z.enum(['delete', 'patch']),
    q: z.string().max(200).optional(),
    filters: filtersSchema.optional(),
    ids: z.array(z.string()).max(500).optional(),
    patch: rowSchema.optional(),
    dryRun: z.boolean().optional(),
  })

  api.post('/api/files/:id/collections/:collection/bulk', async (c) => {
    const id = c.req.param('id')
    const collection = c.req.param('collection')
    const loaded = await loadFile(c, id)
    if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
    if (!(await collectionExists(c.env.DB, id, collection)))
      return fail(c, 404, 'collection_not_found', 'That collection does not exist.')
    const stale = staleRevision(c, loaded.row)
    if (stale) return stale
    const fresh = await sourceGuard(c, loaded.file)
    if (fresh) return fresh
    const body = await jsonBody(c, bulkBody)
    if (body instanceof Response) return body

    let patch: Row | undefined
    if (body.action === 'patch') {
      const checked = validateRow(body.patch)
      if (!checked.ok) return fail(c, 400, 'invalid_record', checked.message)
      patch = checked.row
    }

    const filter = { q: body.q, filters: body.filters as Filter[] | undefined, ids: body.ids }
    const matched = await store.countMatching(c.env.DB, id, collection, filter)
    const ids = await store.matchingIds(c.env.DB, id, collection, filter, 5000)

    if (patch) {
      const rules = await store.listRules(c.env.DB, id, collection)
      if (rules.length) {
        const rows = await store.allRecords(c.env.DB, id, collection)
        const selected = new Set(ids)
        // Check the rows as they would be after the patch, so a patch that
        // makes two rows collide on a unique field is refused before any write.
        const projected = rows.map((row) =>
          selected.has(row.id)
            ? { id: row.id, data: { ...row.data, ...patch } }
            : { id: row.id, data: row.data },
        )
        const violations: Violation[] = []
        for (const row of projected)
          if (selected.has(row.id))
            violations.push(...store.ruleViolations(row.data, rules, projected, row.id))
        if (violations.length) return ruleFailure(c, violations.slice(0, 20))
      }
    }

    if (body.dryRun)
      return c.json({ matched, applied: 0, dryRun: true, revision: loaded.row.revision })

    const applied =
      body.action === 'delete'
        ? await store.bulkDelete(c.env.DB, id, collection, ids)
        : await store.bulkPatch(c.env.DB, id, collection, ids, patch ?? {})

    if (applied)
      await commit(c.env, loaded.file, {
        reason: `bulk ${body.action}`,
        action: body.action === 'delete' ? 'records.bulk_deleted' : 'records.bulk_updated',
        collection,
        detail: { matched, applied, truncated: matched > ids.length },
      })

    return c.json({
      matched,
      applied,
      truncated: matched > ids.length,
      revision: (await store.getFileRow(c.env.DB, id))?.revision ?? loaded.row.revision,
    })
  })

  /* ---------------------------- duplicates --------------------------- */

  api.get('/api/files/:id/collections/:collection/duplicates', async (c) => {
    const id = c.req.param('id')
    const collection = c.req.param('collection')
    const loaded = await loadFile(c, id)
    if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
    if (!(await collectionExists(c.env.DB, id, collection)))
      return fail(c, 404, 'collection_not_found', 'That collection does not exist.')
    const key = c.req.query('key') ?? ''
    if (!KEY.test(key)) return fail(c, 400, 'invalid_key', 'Choose the field to compare on.')
    const groups = await store.duplicateGroups(c.env.DB, id, collection, key)
    return c.json({ key, groups: groups.map((group) => ({ ...group, ids: group.ids.slice(0, 50) })) })
  })

  api.post('/api/files/:id/collections/:collection/dedupe', async (c) => {
    const id = c.req.param('id')
    const collection = c.req.param('collection')
    const loaded = await loadFile(c, id)
    if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
    if (!(await collectionExists(c.env.DB, id, collection)))
      return fail(c, 404, 'collection_not_found', 'That collection does not exist.')
    const stale = staleRevision(c, loaded.row)
    if (stale) return stale
    const fresh = await sourceGuard(c, loaded.file)
    if (fresh) return fresh
    const body = await jsonBody(
      c,
      z.object({ key: z.string().max(64).regex(KEY), dryRun: z.boolean().optional() }),
    )
    if (body instanceof Response) return body

    const groups = await store.duplicateGroups(c.env.DB, id, collection, body.key)
    if (body.dryRun)
      return c.json({
        key: body.key,
        groups: groups.length,
        duplicates: groups.reduce((total, group) => total + Math.max(0, group.count - 1), 0),
        removed: 0,
      })

    let removed = 0
    for (const group of groups) {
      const ids = group.ids.slice(1)
      removed += await store.bulkDelete(c.env.DB, id, collection, ids)
    }
    if (removed)
      await commit(c.env, loaded.file, {
        reason: `dedupe on ${body.key}`,
        action: 'records.deduped',
        collection,
        detail: { key: body.key, groups: groups.length, removed },
      })
    return c.json({ key: body.key, groups: groups.length, removed })
  })

  /* ------------------------------ rules ------------------------------ */

  api.get('/api/files/:id/collections/:collection/rules', async (c) => {
    const loaded = await loadFile(c, c.req.param('id'))
    if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
    const collection = c.req.param('collection')
    if (!(await collectionExists(c.env.DB, loaded.row.id, collection)))
      return fail(c, 404, 'collection_not_found', 'That collection does not exist.')
    return c.json({ rules: await store.listRules(c.env.DB, loaded.row.id, collection) })
  })

  api.post('/api/files/:id/collections/:collection/rules', async (c) => {
    const id = c.req.param('id')
    const collection = c.req.param('collection')
    const loaded = await loadFile(c, id)
    if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
    if (!(await collectionExists(c.env.DB, id, collection)))
      return fail(c, 404, 'collection_not_found', 'That collection does not exist.')
    const body = await jsonBody(
      c,
      z.object({
        field: z.string().max(64).regex(KEY),
        rule: z.enum(RULES as [RuleName, ...RuleName[]]),
        value: z.unknown().optional(),
      }),
    )
    if (body instanceof Response) return body
    if (body.rule === 'one_of' && !Array.isArray(body.value))
      return fail(c, 400, 'invalid_rule', 'one_of needs a list of allowed values.')
    if ((body.rule === 'min' || body.rule === 'max') && !Number.isFinite(Number(body.value)))
      return fail(c, 400, 'invalid_rule', 'min and max need a number.')
    if (body.rule === 'type' && !['string', 'number', 'boolean'].includes(String(body.value)))
      return fail(c, 400, 'invalid_rule', 'type needs string, number or boolean.')
    const rule = await store.addRule(c.env.DB, {
      fileId: id,
      collection,
      field: body.field,
      rule: body.rule,
      value: body.value,
    })
    await store.logEvent(c.env.DB, {
      fileId: id,
      collection,
      action: 'rule.created',
      detail: { field: body.field, rule: body.rule },
    })
    return c.json({ rule }, 201)
  })

  api.delete('/api/files/:id/collections/:collection/rules/:ruleId', async (c) => {
    const removed = await store.deleteRule(
      c.env.DB,
      c.req.param('id'),
      c.req.param('collection'),
      c.req.param('ruleId'),
    )
    if (!removed) return fail(c, 404, 'rule_not_found', 'That rule no longer exists.')
    return c.json({ ok: true })
  })

  api.get('/api/files/:id/collections/:collection/validate', async (c) => {
    const id = c.req.param('id')
    const collection = c.req.param('collection')
    const loaded = await loadFile(c, id)
    if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
    if (!(await collectionExists(c.env.DB, id, collection)))
      return fail(c, 404, 'collection_not_found', 'That collection does not exist.')
    const rules = await store.listRules(c.env.DB, id, collection)
    if (!rules.length) return c.json({ rules: 0, violations: [], rows: 0 })
    const rows = await store.allRecords(c.env.DB, id, collection)
    const all = rows.map((row) => ({ id: row.id, data: row.data }))
    const violations: Violation[] = []
    for (const row of rows) {
      for (const violation of store.ruleViolations(row.data, rules, all, row.id))
        violations.push({ ...violation, recordId: row.id })
    }
    return c.json({
      rules: rules.length,
      rows: rows.length,
      violations: violations.slice(0, 200),
      count: violations.length,
    })
  })

  /* ------------------------------ views ------------------------------ */

  api.get('/api/files/:id/views', async (c) => {
    const loaded = await loadFile(c, c.req.param('id'))
    if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
    return c.json({ views: await store.listViews(c.env.DB, loaded.row.id) })
  })

  api.post('/api/files/:id/views', async (c) => {
    const loaded = await loadFile(c, c.req.param('id'))
    if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
    const body = await jsonBody(
      c,
      z.object({
        collection: collectionNameSchema,
        name: z.string().trim().min(1).max(80),
        query: z.record(z.string(), z.unknown()),
      }),
    )
    if (body instanceof Response) return body
    if (!(await collectionExists(c.env.DB, loaded.row.id, body.collection)))
      return fail(c, 404, 'collection_not_found', 'That collection does not exist.')
    const view = await store.addView(c.env.DB, {
      fileId: loaded.row.id,
      collection: body.collection,
      name: body.name,
      query: body.query,
    })
    return c.json({ view }, 201)
  })

  api.delete('/api/files/:id/views/:viewId', async (c) => {
    const loaded = await loadFile(c, c.req.param('id'))
    if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
    const removed = await store.deleteView(c.env.DB, loaded.row.id, c.req.param('viewId'))
    if (!removed) return fail(c, 404, 'view_not_found', 'That view no longer exists.')
    return c.json({ ok: true })
  })

  /* ----------------------------- shares ------------------------------ */

  api.get('/api/files/:id/shares', async (c) => {
    const loaded = await loadFile(c, c.req.param('id'))
    if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
    const shares = await store.listShares(c.env.DB, loaded.row.id)
    const origin = new URL(c.req.url).origin
    return c.json({
      shares: shares.map((share) => ({ ...share, url: `${origin}/api/share/${share.id}` })),
    })
  })

  api.post('/api/files/:id/shares', async (c) => {
    const loaded = await loadFile(c, c.req.param('id'))
    if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
    const body = await jsonBody(
      c,
      z.object({
        collection: collectionNameSchema.optional(),
        ttlHours: z.number().int().min(1).max(24 * 30).optional(),
      }),
    )
    if (body instanceof Response) return body
    if (body.collection && !(await collectionExists(c.env.DB, loaded.row.id, body.collection)))
      return fail(c, 404, 'collection_not_found', 'That collection does not exist.')
    const share = await store.addShare(c.env.DB, {
      fileId: loaded.row.id,
      collection: body.collection ?? null,
      ttlHours: body.ttlHours ?? 24,
    })
    await store.logEvent(c.env.DB, {
      fileId: loaded.row.id,
      action: 'share.created',
      detail: { collection: share.collection, expiresAt: share.expiresAt },
    })
    return c.json(
      { share, url: `${new URL(c.req.url).origin}/api/share/${share.id}` },
      201,
    )
  })

  api.delete('/api/files/:id/shares/:shareId', async (c) => {
    const loaded = await loadFile(c, c.req.param('id'))
    if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
    const removed = await store.deleteShare(c.env.DB, loaded.row.id, c.req.param('shareId'))
    if (!removed) return fail(c, 404, 'share_not_found', 'That link no longer exists.')
    return c.json({ ok: true })
  })

  /** Public, read-only snapshot behind an expiring token. */
  api.get('/api/share/:token', async (c) => {
    const share = await store.findShare(c.env.DB, c.req.param('token'))
    if (!share) return fail(c, 404, 'share_not_found', 'That link is invalid or has expired.')
    const row = await store.getActiveFileRow(c.env.DB, share.fileId)
    if (!row) return fail(c, 404, 'file_not_found', 'The shared file is no longer available.')

    const listed = share.collection
      ? (await store.listCollections(c.env.DB, share.fileId)).filter(
          (entry) => entry.name === share.collection,
        )
      : await store.listCollections(c.env.DB, share.fileId)
    if (share.collection && !listed.length)
      return fail(c, 404, 'collection_not_found', 'The shared collection is no longer in this file.')
    const collections = []
    for (const entry of listed) {
      const page = await store.queryRecords(c.env.DB, share.fileId, entry.name, {
        limit: 1000,
        offset: 0,
        direction: 'asc',
      })
      collections.push({
        name: entry.name,
        recordCount: page.total,
        records: page.records.map((record) => record.data),
      })
    }
    return c.json({
      file: {
        name: row.name,
        format: row.format,
        size: row.size,
        updatedAt: row.updated_at,
      },
      expiresAt: share.expiresAt,
      collections,
    })
  })

  /* ----------------------------- events ------------------------------ */

  api.get('/api/files/:id/events', async (c) => {
    const loaded = await loadFile(c, c.req.param('id'))
    if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
    return c.json({
      events: await store.listEvents(c.env.DB, {
        fileId: loaded.row.id,
        limit: eventLimit(c, 100),
      }),
    })
  })

  api.get('/api/events', async (c) => {
    return c.json({ events: await store.listEvents(c.env.DB, { limit: eventLimit(c, 200) }) })
  })

  /* ------------------------------- ask ------------------------------- */

  api.post('/api/files/:id/ask', async (c) => {
    const id = c.req.param('id')
    const loaded = await loadFile(c, id)
    if (!loaded.ok) return fail(c, 404, loaded.code, loaded.message)
    const body = await jsonBody(
      c,
      z.object({
        collection: collectionNameSchema,
        question: z.string().trim().min(2).max(300),
        mode: z.enum(['query', 'fixes', 'mapping']).default('query'),
        target: collectionNameSchema.optional(),
      }),
    )
    if (body instanceof Response) return body
    if (!(await collectionExists(c.env.DB, id, body.collection)))
      return fail(c, 404, 'collection_not_found', 'That collection does not exist.')

    const sample = await store.sampleRecords(c.env.DB, id, body.collection, 40)
    const fields = fieldsOf(sample.map((record) => record.data)).map((field) => field.name)
    if (!fields.length) return fail(c, 422, 'no_fields', 'This collection has no records to look at.')

    try {
      if (body.mode === 'query') {
        const plan = await planQuery(c.env, {
          name: loaded.row.name,
          collection: body.collection,
          fields,
          rows: sample.map((record) => record.data),
          question: body.question,
        })
        const page = await store.queryRecords(c.env.DB, id, body.collection, {
          limit: Math.min(plan.limit, 200),
          offset: 0,
          filters: plan.filters,
          sort: plan.sort,
          direction: plan.direction,
        })
        return c.json({
          mode: 'query',
          question: body.question,
          explanation: plan.explanation,
          plan: { filters: plan.filters, sort: plan.sort, direction: plan.direction, limit: plan.limit },
          redactions: plan.redactions,
          total: page.total,
          records: page.records.map((record) => record.data),
          revision: loaded.file.revision,
        })
      }

      if (body.mode === 'mapping') {
        if (!body.target || !(await collectionExists(c.env.DB, id, body.target)))
          return fail(c, 404, 'collection_not_found', 'Choose the collection to map onto.')
        const targetRows = await store.sampleRecords(c.env.DB, id, body.target, 40)
        const targetFields = fieldsOf(targetRows.map((record) => record.data)).map(
          (field) => field.name,
        )
        const result = await suggestMapping(c.env, {
          source: body.collection,
          target: body.target,
          sourceFields: fields,
          targetFields,
        })
        return c.json({ mode: 'mapping', ...result })
      }

      const rules = await store.listRules(c.env.DB, id, body.collection)
      const rows = await store.allRecords(c.env.DB, id, body.collection)
      const all = rows.map((row) => ({ id: row.id, data: row.data }))
      const violations: Violation[] = []
      for (const row of rows) {
        for (const violation of store.ruleViolations(row.data, rules, all, row.id))
          violations.push({ ...violation, recordId: row.id })
      }
      if (!violations.length)
        return c.json({ mode: 'fixes', fixes: [], notes: 'No rows break a rule.', violations: [] })
      const affected = rows.filter((row) =>
        violations.some((violation) => violation.recordId === row.id),
      )
      const result = await suggestFixes(c.env, {
        name: loaded.row.name,
        collection: body.collection,
        rows: affected.slice(0, 40),
        violations: violations.slice(0, 60),
      })
      return c.json({ mode: 'fixes', ...result, violations: violations.slice(0, 60) })
    } catch (error) {
      return aiFailure(c, error)
    }
  })
}
