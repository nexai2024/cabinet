import { Database } from 'bun:sqlite'
import type { Env } from '../../src/worker/lib/types'

export const TEST_KEY = 'test-key'

type Binding = string | number | boolean | null | Uint8Array
type Changes = { changes: number | bigint; lastInsertRowid: number | bigint }

const bindable = (value: unknown): Binding => {
  if (value === undefined) return null
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return value as Binding
}

const resultOf = (info: Changes) => ({
  success: true as const,
  meta: { changes: Number(info.changes ?? 0), last_row_id: Number(info.lastInsertRowid ?? 0) },
})

/** The subset of D1PreparedStatement the Worker uses. */
class Statement {
  constructor(
    private readonly database: Database,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]) {
    return new Statement(this.database, this.sql, params)
  }

  async first<T = Record<string, unknown>>(column?: string) {
    const row = this.database
      .query(this.sql)
      .get(...(this.params.map(bindable) as never[])) as Record<string, unknown> | null
    if (!row) return null
    return (column ? row[column] : row) as T
  }

  async all<T = Record<string, unknown>>() {
    const results = this.database
      .query(this.sql)
      .all(...(this.params.map(bindable) as never[])) as T[]
    return { results, success: true, meta: {} }
  }

  async run() {
    return resultOf(this.exec())
  }

  exec(): Changes {
    return this.database.query(this.sql).run(...(this.params.map(bindable) as never[]))
  }
}

/** D1 backed by SQLite, so the real schema and SQL are exercised. */
export class MemoryD1 {
  constructor(private readonly database: Database) {}

  prepare(sql: string) {
    return new Statement(this.database, sql)
  }

  async batch(statements: Statement[]) {
    const results: Changes[] = []
    this.database.transaction(() => {
      for (const statement of statements) results.push(statement.exec())
    })()
    return results.map(resultOf)
  }
}

const toBytes = (value: unknown): Uint8Array => {
  if (typeof value === 'string') return new TextEncoder().encode(value)
  if (value instanceof Uint8Array) return value.slice()
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
  throw new Error('Unsupported R2 value.')
}

/** R2 stand-in that keeps objects in memory and serves the body methods used. */
export class MemoryBucket {
  readonly objects = new Map<string, Uint8Array>()

  async put(key: string, value: unknown) {
    const bytes = toBytes(value)
    this.objects.set(key, bytes)
    return { key, size: bytes.byteLength }
  }

  async get(key: string) {
    const bytes = this.objects.get(key)
    if (!bytes) return null
    const copy = bytes.slice()
    return {
      key,
      size: copy.byteLength,
      httpMetadata: {},
      customMetadata: {},
      async arrayBuffer() {
        return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer
      },
      async text() {
        return new TextDecoder().decode(copy)
      },
    }
  }

  async delete(key: string) {
    this.objects.delete(key)
  }
}

export function createStorage() {
  const database = new Database(':memory:')
  const bucket = new MemoryBucket()
  const env = {
    DB: new MemoryD1(database) as unknown as D1Database,
    FILES: bucket as unknown as R2Bucket,
    CABINET_TOKEN: TEST_KEY,
  } as unknown as Env
  return { env, bucket, database }
}
