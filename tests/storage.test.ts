import { describe, expect, test } from 'bun:test'
import app from '../src/worker/index'
import type { Env } from '../src/worker/lib/types'
import { createStorage, TEST_KEY } from './helpers/memory-storage'

const { env, bucket } = createStorage()

const writeHeaders = { 'x-cabinet-key': TEST_KEY, 'content-type': 'application/json' }
const uploadHeaders = { 'x-cabinet-key': TEST_KEY }

async function call(path: string, init: RequestInit = {}, activeEnv: Env = env) {
  const response = await app.request(path, init, activeEnv)
  const text = await response.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: response.status, body }
}

async function upload(name: string, content: string) {
  const reply = await call(`/api/files?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: uploadHeaders,
    body: content,
  })
  expect(reply.status).toBe(201)
  return {
    file: reply.body.file as { id: string; name: string; revision: number },
    collection: reply.body.collections[0].name as string,
  }
}

async function recordsOf(fileId: string, collection: string, query = '') {
  const reply = await call(
    `/api/files/${fileId}/records/${encodeURIComponent(collection)}?limit=200${query}`,
  )
  expect(reply.status).toBe(200)
  return reply.body as {
    total: number
    records: { id: string; data: Record<string, unknown> }[]
  }
}

const filterQuery = (filters: unknown[]) => `&filter=${encodeURIComponent(JSON.stringify(filters))}`

describe('revision conflicts', () => {
  test('a stale If-Match is refused and the current revision is accepted', async () => {
    const { file, collection } = await upload('revisions.csv', 'sku,qty\nA-1,1\n')
    const { records } = await recordsOf(file.id, collection)
    const record = records[0]!
    const path = `/api/files/${file.id}/records/${collection}/${record.id}`

    const stale = await call(path, {
      method: 'PATCH',
      headers: { ...writeHeaders, 'if-match': '99' },
      body: JSON.stringify({ sku: 'A-1', qty: 2 }),
    })
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe('stale_revision')

    const unchanged = await call(`/api/files/${file.id}`)
    expect(unchanged.body.file.revision).toBe(1)
    expect((await recordsOf(file.id, collection)).records[0]!.data.qty).toBe(1)

    const saved = await call(path, {
      method: 'PATCH',
      headers: { ...writeHeaders, 'if-match': '1' },
      body: JSON.stringify({ sku: 'A-1', qty: 2 }),
    })
    expect(saved.status).toBe(200)
    expect(saved.body.data.qty).toBe(2)

    const bumped = await call(`/api/files/${file.id}`)
    expect(bumped.body.file.revision).toBe(2)
  })

  test('imports honour If-Match too', async () => {
    const { file, collection } = await upload('revisions-import.csv', 'sku,qty\nA-1,1\n')
    const stale = await call(
      `/api/files/${file.id}/collections/${collection}/import?mode=append&name=more.csv`,
      {
        method: 'POST',
        headers: { ...uploadHeaders, 'if-match': '7' },
        body: 'sku,qty\nB-2,2\n',
      },
    )
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe('stale_revision')
    expect((await recordsOf(file.id, collection)).total).toBe(1)
  })
})

describe('history', () => {
  test('a saved change can be rolled back to the version before it', async () => {
    const { file, collection } = await upload('history.csv', 'sku,qty\nA-1,1\n')
    const { records } = await recordsOf(file.id, collection)
    const path = `/api/files/${file.id}/records/${collection}/${records[0]!.id}`

    const saved = await call(path, {
      method: 'PATCH',
      headers: { ...writeHeaders, 'if-match': '1' },
      body: JSON.stringify({ sku: 'A-1', qty: 2 }),
    })
    expect(saved.status).toBe(200)

    const listed = await call(`/api/files/${file.id}/versions`)
    expect(listed.status).toBe(200)
    expect(listed.body.versions.length).toBeGreaterThanOrEqual(1)
    expect(listed.body.versions[0].reason).toBe('record updated')

    const restored = await call(
      `/api/files/${file.id}/versions/${listed.body.versions[0].id}/restore`,
      { method: 'POST', headers: writeHeaders },
    )
    expect(restored.status).toBe(200)
    expect(restored.body.file.revision).toBeGreaterThan(2)

    const after = await recordsOf(file.id, collection)
    expect(after.total).toBe(1)
    expect(after.records[0]!.data.qty).toBe(1)
  })
})

describe('trash and purge', () => {
  test('trashed files can be restored, and purged only once trashed', async () => {
    const active = await upload('keep.csv', 'sku,qty\nA-1,1\n')
    const refuse = await call(`/api/files/${active.file.id}/purge`, {
      method: 'DELETE',
      headers: uploadHeaders,
    })
    expect(refuse.status).toBe(409)
    expect(refuse.body.error.code).toBe('not_trashed')

    const doomed = await upload('doomed.csv', 'sku,qty\nB-2,2\n')
    const trashed = await call(`/api/files/${doomed.file.id}`, {
      method: 'DELETE',
      headers: uploadHeaders,
    })
    expect(trashed.status).toBe(200)
    expect(trashed.body).toEqual({ ok: true })

    const hidden = await call(`/api/files/${doomed.file.id}`)
    expect(hidden.status).toBe(404)
    expect(hidden.body.error.code).toBe('file_trashed')

    const trash = await call('/api/trash')
    expect(trash.body.files.map((file: { id: string }) => file.id)).toContain(doomed.file.id)

    const restored = await call(`/api/files/${doomed.file.id}/restore`, {
      method: 'POST',
      headers: uploadHeaders,
    })
    expect(restored.status).toBe(200)
    expect(restored.body.file.id).toBe(doomed.file.id)
    expect((await call(`/api/files/${doomed.file.id}`)).status).toBe(200)

    await call(`/api/files/${doomed.file.id}`, { method: 'DELETE', headers: uploadHeaders })
    const purged = await call(`/api/files/${doomed.file.id}/purge`, {
      method: 'DELETE',
      headers: uploadHeaders,
    })
    expect(purged.status).toBe(200)
    expect(purged.body).toEqual({ ok: true })

    const gone = await call(`/api/files/${doomed.file.id}`)
    expect(gone.status).toBe(404)
    expect(gone.body.error.code).toBe('file_not_found')
    expect(bucket.objects.has(`files/${doomed.file.id}`)).toBe(false)
    expect(bucket.objects.has(`originals/${doomed.file.id}`)).toBe(false)
    expect((await call('/api/trash')).body.files.map((file: { id: string }) => file.id)).not.toContain(
      doomed.file.id,
    )
  })

  test('emptying the trash purges every trashed file', async () => {
    const first = await upload('trash-one.csv', 'sku,qty\nA-1,1\n')
    const second = await upload('trash-two.csv', 'sku,qty\nB-2,2\n')
    for (const file of [first.file, second.file])
      await call(`/api/files/${file.id}`, { method: 'DELETE', headers: uploadHeaders })
    expect((await call('/api/trash')).body.files).toHaveLength(2)

    const emptied = await call('/api/trash', { method: 'DELETE', headers: uploadHeaders })
    expect(emptied.status).toBe(200)
    expect(emptied.body).toEqual({ ok: true, purged: 2 })
    expect((await call('/api/trash')).body.files).toHaveLength(0)

    for (const file of [first.file, second.file]) {
      expect((await call(`/api/files/${file.id}`)).status).toBe(404)
      expect(bucket.objects.has(`files/${file.id}`)).toBe(false)
    }
  })
})

describe('typed filters', () => {
  test('numbers, text, missing values and invalid filters behave as documented', async () => {
    const { file, collection } = await upload(
      'filters.csv',
      'sku,qty,note\nA-1,5,alpha\nB-2,12,beta\nC-3,30,\n',
    )

    const big = await recordsOf(file.id, collection, filterQuery([{ field: 'qty', op: 'gt', value: 10 }]))
    expect(big.total).toBe(2)
    expect(big.records.map((record) => record.data.sku)).toEqual(['B-2', 'C-3'])

    const text = await recordsOf(file.id, collection, filterQuery([{ field: 'note', op: 'eq', value: 'alpha' }]))
    expect(text.total).toBe(1)
    expect(text.records[0]!.data.sku).toBe('A-1')

    const missing = await recordsOf(file.id, collection, filterQuery([{ field: 'note', op: 'empty' }]))
    expect(missing.total).toBe(1)
    expect(missing.records[0]!.data.sku).toBe('C-3')

    const present = await recordsOf(file.id, collection, filterQuery([{ field: 'note', op: 'exists' }]))
    expect(present.total).toBe(2)

    const invalid = await call(
      `/api/files/${file.id}/records/${collection}?filter=${encodeURIComponent('[{"field":"qty","op":"near","value":1}]')}`,
    )
    expect(invalid.status).toBe(400)
    expect(invalid.body.error.code).toBe('invalid_filter')

    const broken = await call(
      `/api/files/${file.id}/records/${collection}?filter=${encodeURIComponent('{not json}')}`,
    )
    expect(broken.status).toBe(400)
  })

  test('LIKE wildcards in search text match literally', async () => {
    const { file, collection } = await upload(
      'wildcards.csv',
      'name,tag\nPercent,100%\nPlain,1000\nUnder,A_1\nOther,AB1\n',
    )
    const percent = await recordsOf(
      file.id,
      collection,
      filterQuery([{ field: 'tag', op: 'contains', value: '100%' }]),
    )
    expect(percent.total).toBe(1)
    expect(percent.records[0]!.data.name).toBe('Percent')

    const underscore = await recordsOf(
      file.id,
      collection,
      filterQuery([{ field: 'tag', op: 'contains', value: 'A_1' }]),
    )
    expect(underscore.total).toBe(1)
    expect(underscore.records[0]!.data.name).toBe('Under')

    const search = await recordsOf(file.id, collection, `&q=${encodeURIComponent('100%')}`)
    expect(search.total).toBe(1)
    expect(search.records[0]!.data.name).toBe('Percent')
  })
})

describe('validation rules', () => {
  test('unique rules reject duplicates on create and update', async () => {
    const { file, collection } = await upload('rules.csv', 'sku,qty\nA-1,1\nB-2,2\n')
    const base = `/api/files/${file.id}/collections/${collection}`
    const rows = `/api/files/${file.id}/records/${collection}`

    const rule = await call(`${base}/rules`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ field: 'sku', rule: 'unique' }),
    })
    expect(rule.status).toBe(201)
    expect(rule.body.rule.rule).toBe('unique')

    const duplicate = await call(rows, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ sku: 'A-1', qty: 9 }),
    })
    expect(duplicate.status).toBe(422)
    expect(duplicate.body.error.code).toBe('rule_violation')
    expect(duplicate.body.violations[0].rule).toBe('unique')

    const fresh = await call(rows, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ sku: 'C-3', qty: 3 }),
    })
    expect(fresh.status).toBe(201)

    const { records } = await recordsOf(file.id, collection)
    const b2 = records.find((record) => record.data.sku === 'B-2')!
    const update = await call(`${rows}/${b2.id}`, {
      method: 'PATCH',
      headers: writeHeaders,
      body: JSON.stringify({ sku: 'C-3', qty: 2 }),
    })
    expect(update.status).toBe(422)
    expect(update.body.violations[0].rule).toBe('unique')

    const listed = await call(`${base}/rules`)
    expect(listed.body.rules).toHaveLength(1)

    const validated = await call(`${base}/validate`)
    expect(validated.body).toMatchObject({ rules: 1, rows: 3, count: 0 })

    const missing = await call(`/api/files/${file.id}/collections/missing/rules`)
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('collection_not_found')
  })

  test('required rules reject rows that omit the field', async () => {
    const { file, collection } = await upload('required.csv', 'sku,qty\nA-1,1\n')
    const base = `/api/files/${file.id}/collections/${collection}`
    await call(`${base}/rules`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ field: 'qty', rule: 'required' }),
    })

    const missing = await call(`/api/files/${file.id}/records/${collection}`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ sku: 'B-2' }),
    })
    expect(missing.status).toBe(422)
    expect(missing.body.violations[0].rule).toBe('required')
  })
})

describe('import', () => {
  test('rows later in a batch are checked against the rows before them', async () => {
    const { file, collection } = await upload('batch-import.csv', 'sku,qty\nZ-9,1\n')
    const base = `/api/files/${file.id}/collections/${collection}`
    await call(`${base}/rules`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ field: 'sku', rule: 'unique' }),
    })

    const appended = await call(`${base}/import?mode=append&name=batch.csv`, {
      method: 'POST',
      headers: uploadHeaders,
      body: 'sku,qty\nA-1,1\nA-1,2\nB-2,3\n',
    })
    expect(appended.status).toBe(200)
    expect(appended.body).toMatchObject({ inserted: 2, updated: 0, skipped: 1 })
    expect(appended.body.violations[0].rule).toBe('unique')

    const afterAppend = await recordsOf(file.id, collection)
    expect(afterAppend.total).toBe(3)
    expect(afterAppend.records.map((record) => record.data.sku).sort()).toEqual([
      'A-1',
      'B-2',
      'Z-9',
    ])

    const upserted = await call(`${base}/import?mode=upsert&key=sku&name=batch-upsert.csv`, {
      method: 'POST',
      headers: uploadHeaders,
      body: 'sku,qty\nA-1,9\n',
    })
    expect(upserted.status).toBe(200)
    expect(upserted.body).toMatchObject({ inserted: 0, updated: 1, skipped: 0 })

    const afterUpsert = await recordsOf(file.id, collection)
    expect(afterUpsert.total).toBe(3)
    expect(afterUpsert.records.find((record) => record.data.sku === 'A-1')!.data.qty).toBe(9)
  })

  test('an import larger than one batch says how much it did not read', async () => {
    const { file, collection } = await upload('large-import.csv', 'sku,qty\nZ-9,1\n')
    const lines = Array.from({ length: 5001 }, (_, index) => `S-${index},${index}`)
    const reply = await call(
      `/api/files/${file.id}/collections/${collection}/import?mode=append&name=large.csv`,
      { method: 'POST', headers: uploadHeaders, body: `sku,qty\n${lines.join('\n')}\n` },
    )
    expect(reply.status).toBe(200)
    expect(reply.body.inserted).toBe(5000)
    expect(reply.body.truncated).toBe(true)
  })
})

describe('schema changes', () => {
  test('renaming a collection keeps its rules, views and share links', async () => {
    const { file, collection } = await upload('rename-links.csv', 'sku,qty\nA-1,1\n')
    const base = `/api/files/${file.id}/collections/${collection}`
    await call(`${base}/rules`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ field: 'sku', rule: 'unique' }),
    })
    const view = await call(`/api/files/${file.id}/views`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ collection, name: 'Everything', query: {} }),
    })
    expect(view.status).toBe(201)
    const share = await call(`/api/files/${file.id}/shares`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ collection }),
    })
    expect(share.status).toBe(201)

    const renamed = await call(`${base}/schema`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ action: 'rename', name: 'renamed' }),
    })
    expect(renamed.status).toBe(200)

    const rules = await call(`/api/files/${file.id}/collections/renamed/rules`)
    expect(rules.body.rules).toHaveLength(1)
    const views = await call(`/api/files/${file.id}/views`)
    expect(views.body.views[0].collection).toBe('renamed')
    const shares = await call(`/api/files/${file.id}/shares`)
    expect(shares.body.shares[0].collection).toBe('renamed')
    const shared = await call(new URL(share.body.url as string).pathname)
    expect(shared.status).toBe(200)
    expect(shared.body.collections[0].name).toBe('renamed')

    const dropped = await call(`/api/files/${file.id}/collections/renamed`, {
      method: 'DELETE',
      headers: uploadHeaders,
    })
    expect(dropped.status).toBe(200)
    expect((await call(`/api/files/${file.id}/shares`)).body.shares).toHaveLength(0)
    expect((await call(new URL(share.body.url as string).pathname)).status).toBe(404)
  })

  test('renaming a field moves its rules, and deleting it removes them', async () => {
    const { file, collection } = await upload('rename-field.csv', 'sku,qty\nA-1,1\nB-2,2\n')
    const base = `/api/files/${file.id}/collections/${collection}`
    const rows = `/api/files/${file.id}/records/${collection}`
    await call(`${base}/rules`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ field: 'sku', rule: 'unique' }),
    })

    const renamed = await call(`${base}/schema`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ action: 'rename_field', from: 'sku', to: 'code' }),
    })
    expect(renamed.status).toBe(200)
    expect((await call(`${base}/rules`)).body.rules[0].field).toBe('code')

    const duplicate = await call(rows, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ code: 'A-1' }),
    })
    expect(duplicate.status).toBe(422)
    expect(duplicate.body.violations[0].field).toBe('code')

    const dropped = await call(`${base}/schema`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ action: 'delete_field', field: 'code' }),
    })
    expect(dropped.status).toBe(200)
    expect((await call(`${base}/rules`)).body.rules).toHaveLength(0)

    const allowed = await call(rows, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ code: 'A-1' }),
    })
    expect(allowed.status).toBe(201)
  })

  test('retyping a field leaves empty values empty', async () => {
    const { file, collection } = await upload('retype.csv', 'sku,qty\nA-1,1\nB-2,\n')
    const base = `/api/files/${file.id}/collections/${collection}`
    const retyped = await call(`${base}/schema`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ action: 'retype', field: 'qty', type: 'number' }),
    })
    expect(retyped.status).toBe(200)
    expect(retyped.body.failed).toBe(0)
    const rows = await recordsOf(file.id, collection)
    expect(rows.records.find((row) => row.data.sku === 'A-1')!.data.qty).toBe(1)
    expect(rows.records.find((row) => row.data.sku === 'B-2')!.data.qty).toBeNull()
  })
})

describe('duplicates and dedupe', () => {
  test('dedupe removes real duplicates and leaves rows without the field alone', async () => {
    const { file, collection } = await upload(
      'dedupe.csv',
      'sku,note\nA-1,x\nA-1,y\nB-2,\nC-3,\n',
    )
    const base = `/api/files/${file.id}/collections/${collection}`
    const preview = await call(`${base}/duplicates?key=sku`)
    expect(preview.body.groups).toHaveLength(1)
    expect(preview.body.groups[0].count).toBe(2)

    const deduped = await call(`${base}/dedupe`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ key: 'sku' }),
    })
    expect(deduped.body).toMatchObject({ groups: 1, removed: 1 })
    expect((await recordsOf(file.id, collection)).total).toBe(3)

    const missing = await call(`${base}/dedupe`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ key: 'note' }),
    })
    expect(missing.body.removed).toBe(0)
    expect((await recordsOf(file.id, collection)).total).toBe(3)
  })
})

describe('audit events', () => {
  test('a malformed limit is ignored instead of failing', async () => {
    const { file } = await upload('events.csv', 'sku,qty\nA-1,1\n')
    const reply = await call(`/api/files/${file.id}/events?limit=lots`)
    expect(reply.status).toBe(200)
    expect(Array.isArray(reply.body.events)).toBe(true)
    const global = await call('/api/events?limit=-5')
    expect(global.status).toBe(200)
  })
})

describe('bulk operations', () => {
  test('dry runs report matches without changing rows, then patch and delete apply', async () => {
    const { file, collection } = await upload(
      'bulk.csv',
      'sku,qty\nA-1,1\nB-2,2\nC-3,3\n',
    )
    const base = `/api/files/${file.id}/collections/${collection}`
    const before = await recordsOf(file.id, collection)

    const preview = await call(`${base}/bulk`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ action: 'delete', q: 'A-1', dryRun: true }),
    })
    expect(preview.status).toBe(200)
    expect(preview.body).toMatchObject({ matched: 1, applied: 0, dryRun: true })
    expect((await recordsOf(file.id, collection)).total).toBe(3)

    const b2 = before.records.find((record) => record.data.sku === 'B-2')!
    const deleted = await call(`${base}/bulk`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ action: 'delete', ids: [b2.id] }),
    })
    expect(deleted.body).toMatchObject({ matched: 1, applied: 1 })
    expect((await recordsOf(file.id, collection)).total).toBe(2)

    const a1 = before.records.find((record) => record.data.sku === 'A-1')!
    const patched = await call(`${base}/bulk`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ action: 'patch', ids: [a1.id], patch: { qty: 99 } }),
    })
    expect(patched.body).toMatchObject({ matched: 1, applied: 1 })
    const after = await recordsOf(file.id, collection)
    expect(after.records.find((record) => record.data.sku === 'A-1')!.data).toEqual({
      sku: 'A-1',
      qty: 99,
    })

    const filtered = await call(`${base}/bulk`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({
        action: 'delete',
        filters: [{ field: 'qty', op: 'gte', value: 3 }],
        dryRun: true,
      }),
    })
    expect(filtered.body.matched).toBe(2)

    const nothing = await call(`${base}/bulk`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ action: 'delete', ids: [] }),
    })
    expect(nothing.body).toMatchObject({ matched: 0, applied: 0 })
    expect((await recordsOf(file.id, collection)).total).toBe(2)
  })

  test('a bulk patch that would break a unique rule changes nothing', async () => {
    const { file, collection } = await upload('bulk-rules.csv', 'sku,qty\nA-1,1\nB-2,2\n')
    const base = `/api/files/${file.id}/collections/${collection}`
    await call(`${base}/rules`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ field: 'sku', rule: 'unique' }),
    })
    const before = await recordsOf(file.id, collection)
    const a1 = before.records.find((record) => record.data.sku === 'A-1')!

    const conflict = await call(`${base}/bulk`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ action: 'patch', ids: [a1.id], patch: { sku: 'B-2' } }),
    })
    expect(conflict.status).toBe(422)
    expect(conflict.body.error.code).toBe('rule_violation')
    expect((await recordsOf(file.id, collection)).records.find((row) => row.id === a1.id)!.data.sku).toBe(
      'A-1',
    )

    const both = await call(`${base}/bulk`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({
        action: 'patch',
        ids: before.records.map((record) => record.id),
        patch: { sku: 'SAME' },
      }),
    })
    expect(both.status).toBe(422)
  })
})

describe('share links', () => {
  test('a share serves its file without the key and stops working when revoked', async () => {
    const { file } = await upload('shared.csv', 'sku,qty\nA-1,1\nB-2,2\n')

    const created = await call(`/api/files/${file.id}/shares`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ ttlHours: 2 }),
    })
    expect(created.status).toBe(201)
    expect(created.body.share.collection).toBeNull()
    const url = new URL(created.body.url as string)
    expect(url.pathname).toBe(`/api/share/${created.body.share.id}`)

    const listed = await call(`/api/files/${file.id}/shares`)
    expect(listed.body.shares.map((share: { id: string }) => share.id)).toContain(
      created.body.share.id,
    )

    const shared = await call(url.pathname)
    expect(shared.status).toBe(200)
    expect(shared.body.file.name).toBe('shared.csv')
    expect(shared.body.collections[0].recordCount).toBe(2)
    expect(shared.body.collections[0].records).toHaveLength(2)

    const protectedEnv = { ...env, CABINET_PROTECT_READS: 'true' } as Env
    expect((await call('/api/files', {}, protectedEnv)).status).toBe(401)
    expect((await call(url.pathname, {}, protectedEnv)).status).toBe(200)

    const revoked = await call(`/api/files/${file.id}/shares/${created.body.share.id}`, {
      method: 'DELETE',
      headers: uploadHeaders,
    })
    expect(revoked.status).toBe(200)
    const after = await call(url.pathname)
    expect(after.status).toBe(404)
    expect(after.body.error.code).toBe('share_not_found')
  })
})
