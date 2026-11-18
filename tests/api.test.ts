import { describe, expect, test } from 'bun:test'
import app from '../src/worker/index'
import { readDataset } from '../src/worker/lib/parse'
import { serializeCollections, serializeForFile } from '../src/worker/lib/serialize'
import { redactText } from '../src/worker/lib/redact'
import { ruleViolations } from '../src/worker/lib/store'
import type { Collection, Env, Format, Rule } from '../src/worker/lib/types'

const read = (name: string, body: string) =>
  readDataset(name, new TextEncoder().encode(body))

const guarded = { CABINET_TOKEN: 'test-key' } as unknown as Env

const names = (name: string, body: string) =>
  read(name, body).collections.map((collection) => collection.name)

describe('reading files into collections', () => {
  test('JSON arrays and nested objects open as collections', () => {
    const nested = read(
      'archive.json',
      JSON.stringify({
        users: [
          { id: 1, name: 'Ada' },
          { id: 2, name: 'Grace' },
        ],
        orders: [{ id: 'A-1', total: 42.5 }],
      }),
    )
    expect(nested.format).toBe('json')
    expect(nested.collections.map((c) => c.name)).toEqual(['users', 'orders'])
    expect(nested.collections[0]!.records).toHaveLength(2)
    expect(nested.collections[1]!.records[0]).toEqual({ id: 'A-1', total: 42.5 })

    const list = read('people.json', '[{"name":"Ada"},{"name":"Grace"}]')
    expect(list.collections).toHaveLength(1)
    expect(list.collections[0]!.name).toBe('people')
    expect(list.collections[0]!.records[1]).toEqual({ name: 'Grace' })
  })

  test('NDJSON lines become records', () => {
    const dataset = read(
      'events.ndjson',
      '{"kind":"open","at":1}\n{"kind":"close","at":2}\n',
    )
    expect(dataset.collections[0]!.records).toEqual([
      { kind: 'open', at: 1 },
      { kind: 'close', at: 2 },
    ])
  })

  test('CSV and TSV keep a header and typed cells', () => {
    const csv = read('stock.csv', 'sku,qty,note\nA-1,12,"loose, boxed"\nB-2,0,\n')
    expect(csv.format).toBe('csv')
    expect(csv.collections[0]!.records).toEqual([
      { sku: 'A-1', qty: 12, note: 'loose, boxed' },
      { sku: 'B-2', qty: 0, note: null },
    ])

    const tsv = read('inventory.tsv', 'sku\tstock\nA-1\t12\n')
    expect(tsv.collections[0]!.records).toEqual([{ sku: 'A-1', stock: 12 }])
  })

  test('XML repeated elements become records', () => {
    const dataset = read(
      'library.xml',
      `<?xml version="1.0"?>
      <library>
        <book id="b1"><title>Dune</title><pages>412</pages></book>
        <book id="b2"><title>Solaris</title><pages>204</pages></book>
      </library>`,
    )
    expect(dataset.format).toBe('xml')
    const books = dataset.collections.find((collection) => collection.name === 'book')
    expect(books?.records).toHaveLength(2)
    expect(books?.records[0]).toMatchObject({ '@id': 'b1', title: 'Dune' })
  })

  test('JavaScript data modules are read without evaluating code', () => {
    const dataset = read(
      'seed.js',
      `// exported fixtures
       const data = { people: [{ name: 'Ada', tags: ['math'], active: true }] }
       export default data`,
    )
    expect(dataset.format).toBe('javascript')
    expect(dataset.collections[0]!.name).toBe('people')
    expect(dataset.collections[0]!.records[0]).toEqual({
      name: 'Ada',
      tags: ['math'],
      active: true,
    })
  })

  test('a .dat file with JSON inside is recognised by content', () => {
    expect(names('cache.dat', '{"rows":[{"a":1},{"a":2}]}')).toEqual(['rows'])
  })

  test('plain text falls back to key/value blocks, then lines', () => {
    const blocks = read('contact.txt', 'name: Ada\nrole: Engineer\n\nname: Grace\nrole: Admiral')
    expect(blocks.collections[0]!.records).toEqual([
      { name: 'Ada', role: 'Engineer' },
      { name: 'Grace', role: 'Admiral' },
    ])

    const lines = read('notes.txt', 'first note\nsecond note\n')
    expect(lines.collections[0]!.records[0]).toEqual({ line: 'first note', position: 1 })
  })

  test('binary data is stored but not guessed', () => {
    const dataset = readDataset('blob.dat', new Uint8Array([0, 1, 2, 3, 0, 255]))
    expect(dataset.format).toBe('binary')
    expect(dataset.collections).toHaveLength(0)
    expect(dataset.notes.join(' ')).toContain('binary')
  })
})

describe('exporting collections', () => {
  const collections = [
    {
      name: 'books',
      records: [
        { title: 'Dune & Sons', pages: 412 },
        { title: 'Solaris', pages: 204 },
      ],
    },
  ]

  test('JSON and NDJSON round-trip', () => {
    const json = JSON.parse(serializeCollections(collections, 'json')) as unknown
    expect(json).toEqual(collections[0]!.records)
    const lines = serializeCollections(collections, 'ndjson').trim().split('\n')
    expect(lines.map((line) => JSON.parse(line))).toEqual(collections[0]!.records)
  })

  test('CSV quotes separators and XML escapes markup', () => {
    expect(serializeCollections(collections, 'csv').split('\n')[0]).toBe('title,pages')
    expect(serializeCollections(collections, 'xml')).toContain('Dune &amp; Sons')
    expect(serializeCollections(collections, 'txt')).toContain('title: Solaris')
  })
})

describe('writing collections back into the file', () => {
  const rewrite = (name: string, format: Format, collections: Collection[]) => {
    const written = serializeForFile(name, format, collections)
    return { written, read: read(name, written.text) }
  }

  test('JSON keeps collection names and typed values', () => {
    const collections = [
      { name: 'users', records: [{ id: 1, name: 'Ada', tags: ['math'] }] },
      { name: 'orders', records: [{ id: 'A-1', total: 42.5 }] },
    ]
    const { written, read: dataset } = rewrite('archive.json', 'json', collections)
    expect(written.format).toBe('json')
    expect(dataset.format).toBe('json')
    expect(dataset.collections).toEqual(collections)
  })

  test('CSV and TSV stay tables', () => {
    const collections = [
      {
        name: 'stock',
        records: [
          { sku: 'A-1', qty: 12, note: null },
          { sku: 'B-2', qty: 0, note: 'loose, boxed' },
        ],
      },
    ]
    const csv = rewrite('stock.csv', 'csv', collections)
    expect(csv.written.format).toBe('csv')
    expect(csv.read.format).toBe('csv')
    expect(csv.read.collections).toEqual(collections)

    const tsv = rewrite('inventory.tsv', 'tsv', [
      { name: 'inventory', records: [{ sku: 'A-1', stock: 12 }] },
    ])
    expect(tsv.written.text).toBe('sku\tstock\nA-1\t12\n')
    expect(tsv.read.collections[0]!.records).toEqual([{ sku: 'A-1', stock: 12 }])
  })

  test('XML keeps repeated elements, attributes and numbers', () => {
    const collections = [
      {
        name: 'book',
        records: [
          { '@id': 'b1', title: 'Dune', pages: 412 },
          { '@id': 'b2', title: 'Solaris', pages: 204 },
        ],
      },
    ]
    const { written, read: dataset } = rewrite('library.xml', 'xml', collections)
    expect(written.format).toBe('xml')
    expect(dataset.collections).toEqual(collections)
  })

  test('NDJSON keeps one record per line', () => {
    const collections = [
      {
        name: 'events',
        records: [
          { kind: 'open', at: 1 },
          { kind: 'close', at: 2 },
        ],
      },
    ]
    const { written, read: dataset } = rewrite('events.ndjson', 'ndjson', collections)
    expect(written.text.trim().split('\n')).toHaveLength(2)
    expect(dataset.collections).toEqual(collections)
  })

  test('TXT keeps key/value blocks per record', () => {
    const collections = [
      {
        name: 'contacts',
        records: [
          { name: 'Ada', role: 'Engineer' },
          { name: 'Grace', role: 'Admiral' },
        ],
      },
    ]
    const { written, read: dataset } = rewrite('contacts.txt', 'text', collections)
    expect(written.format).toBe('text')
    expect(dataset.collections).toEqual(collections)
  })

  test('JavaScript data modules stay modules', () => {
    const collections = [{ name: 'people', records: [{ name: 'Ada', active: true }] }]
    const { written, read: dataset } = rewrite('seed.js', 'javascript', collections)
    expect(written.text.startsWith('export default')).toBe(true)
    expect(dataset.format).toBe('javascript')
    expect(dataset.collections).toEqual(collections)
  })

  test('formats that cannot hold the data fall back to JSON', () => {
    const multi: Collection[] = [
      { name: 'stock', records: [{ sku: 'A-1', qty: 12 }] },
      { name: 'notes', records: [{ body: 'restock soon' }] },
    ]
    const table = rewrite('stock.csv', 'csv', multi)
    expect(table.written.format).toBe('json')
    expect(table.read.collections).toEqual(multi)

    const nested = [{ name: 'book', records: [{ title: 'Dune', tags: ['sci-fi'] }] }]
    const xml = rewrite('library.xml', 'xml', nested)
    expect(xml.written.format).toBe('json')
    expect(xml.read.collections).toEqual(nested)
  })

  test('a file whose records are all deleted is emptied', () => {
    const written = serializeForFile('stock.csv', 'csv', [{ name: 'stock', records: [] }])
    expect(written.text).toBe('')
    expect(read('stock.csv', written.text).collections).toEqual([])
  })
})

describe('privacy and validation helpers', () => {
  test('redaction keeps the shape but hides personal data', () => {
    const result = redactText(
      'email: ada@example.com\nphone: +1 (555) 123-4567\nkey: sk-live-abcdefghijklmnop\nid: 42',
    )
    expect(result.text).toContain('[redacted-email]')
    expect(result.text).not.toContain('ada@example.com')
    expect(result.text).not.toContain('555')
    expect(result.text).not.toContain('sk-live')
    expect(result.text).toContain('id: 42')
    expect(result.count).toBeGreaterThanOrEqual(3)
  })

  test('rules reject missing, mistyped, duplicate and out-of-range values', () => {
    const rules: Rule[] = [
      { id: '1', field: 'sku', rule: 'required', value: null, createdAt: '' },
      { id: '2', field: 'qty', rule: 'type', value: 'number', createdAt: '' },
      { id: '3', field: 'sku', rule: 'unique', value: null, createdAt: '' },
      { id: '4', field: 'qty', rule: 'min', value: 1, createdAt: '' },
    ]
    const others = [{ id: 'a', data: { sku: 'A-1', qty: 3 } }]
    const missing = ruleViolations({ qty: 2 }, rules, others)
    expect(missing.map((violation) => violation.rule)).toContain('required')

    const duplicate = ruleViolations({ sku: 'A-1', qty: 2 }, rules, others)
    expect(duplicate.map((violation) => violation.rule)).toContain('unique')
    const self = ruleViolations({ sku: 'A-1', qty: 2 }, rules, others, 'a')
    expect(self.every((violation) => violation.rule !== 'unique')).toBe(true)

    const wrongType = ruleViolations({ sku: 'B-2', qty: 'many' }, rules, others)
    expect(wrongType.map((violation) => violation.rule)).toContain('type')

    const tooSmall = ruleViolations({ sku: 'B-2', qty: 0 }, rules, others)
    expect(tooSmall.map((violation) => violation.rule)).toContain('min')
  })
})

describe('the HTTP surface', () => {
  test('health reports what is configured', async () => {
    const response = await app.request('/api/health')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      ai: false,
      auth: false,
      reads: false,
      storage: { db: false, files: false },
    })
  })

  test('the OpenAPI document lists the file and record routes', async () => {
    const response = await app.request('/openapi.json')
    expect(response.status).toBe(200)
    const spec = (await response.json()) as { paths: Record<string, unknown> }
    expect(Object.keys(spec.paths)).toContain('/api/files')
    expect(Object.keys(spec.paths)).toContain('/api/files/{id}/records/{collection}')
    expect(Object.keys(spec.paths)).toContain('/api/files/{id}/records/{collection}/{recordId}')
  })

  test('the OpenAPI document explains how to send the access key', async () => {
    const response = await app.request('/openapi.json')
    expect(response.status).toBe(200)
    const spec = (await response.json()) as {
      components: { securitySchemes: Record<string, unknown> }
      paths: Record<string, Record<string, any>>
    }
    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    })
    expect(spec.components.securitySchemes.cabinetKey).toMatchObject({
      type: 'apiKey',
      in: 'header',
      name: 'x-cabinet-key',
    })
    const upload = spec.paths['/api/files'].post
    expect(upload.security).toEqual([{ bearerAuth: [] }, { cabinetKey: [] }])
    expect(Object.keys(upload.responses)).toEqual(expect.arrayContaining(['401', '503']))
    expect(spec.paths['/api/files'].get.security).toBeUndefined()
  })

  test('every API route is in the OpenAPI document', async () => {
    const response = await app.request('/openapi.json')
    expect(response.status).toBe(200)
    const spec = (await response.json()) as {
      paths: Record<string, Record<string, unknown>>
    }
    const methods = ['GET', 'POST', 'PATCH', 'DELETE', 'PUT']
    const documented = new Set(
      Object.entries(spec.paths).flatMap(([path, item]) =>
        Object.keys(item)
          .filter((method) => methods.includes(method.toUpperCase()))
          .map((method) => `${method.toUpperCase()} ${path}`),
      ),
    )
    const declared = app.routes
      .filter((route) => route.path.startsWith('/api/') && methods.includes(route.method))
      .map((route) => `${route.method} ${route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`)
    const missing = [...new Set(declared)].filter((entry) => !documented.has(entry))
    expect(missing).toEqual([])
  })

  test('unknown API routes answer with JSON errors', async () => {
    const response = await app.request('/api/missing')
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'not_found' } })
  })

  test('an upload without a name is rejected before touching storage', async () => {
    const response = await app.request(
      '/api/files',
      { method: 'POST', body: 'a,b', headers: { 'x-cabinet-key': 'test-key' } },
      guarded,
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_name' } })
  })
})

describe('the access key guard', () => {
  test('with no key configured, writes are refused', async () => {
    const response = await app.request('/api/files', { method: 'POST', body: 'a,b' })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: 'auth_not_configured' } })
  })

  test('a missing or wrong key is rejected', async () => {
    const missing = await app.request('/api/files', { method: 'POST', body: 'a,b' }, guarded)
    expect(missing.status).toBe(401)
    expect(await missing.json()).toMatchObject({ error: { code: 'unauthorized' } })

    const wrong = await app.request(
      '/api/files',
      { method: 'POST', body: 'a,b', headers: { 'x-cabinet-key': 'guessing' } },
      guarded,
    )
    expect(wrong.status).toBe(401)
  })

  test('the key is accepted as a header or a bearer token', async () => {
    const header = await app.request(
      '/api/files',
      { method: 'POST', body: 'a,b', headers: { 'x-cabinet-key': 'test-key' } },
      guarded,
    )
    expect(header.status).toBe(400)

    const bearer = await app.request(
      '/api/files',
      { method: 'POST', body: 'a,b', headers: { Authorization: 'Bearer test-key' } },
      guarded,
    )
    expect(bearer.status).toBe(400)
    expect(await bearer.json()).toMatchObject({ error: { code: 'invalid_name' } })
  })

  test('read protection can be switched on', async () => {
    const protectedEnv = {
      CABINET_TOKEN: 'test-key',
      CABINET_PROTECT_READS: 'true',
    } as unknown as Env
    const anonymous = await app.request('/api/missing', {}, protectedEnv)
    expect(anonymous.status).toBe(401)
    const keyed = await app.request(
      '/api/missing',
      { headers: { 'x-cabinet-key': 'test-key' } },
      protectedEnv,
    )
    expect(keyed.status).toBe(404)
    const health = await app.request('/api/health', {}, protectedEnv)
    expect(health.status).toBe(200)
  })

  test('reads stay open and report the guard', async () => {
    const spec = await app.request('/openapi.json', {}, guarded)
    expect(spec.status).toBe(200)
    const health = await app.request('/api/health', {}, guarded)
    expect(await health.json()).toMatchObject({ ok: true, auth: true })
  })
})
