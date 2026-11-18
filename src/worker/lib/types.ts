export type Row = Record<string, unknown>

export type Collection = { name: string; records: Row[] }

export type Format =
  | 'json'
  | 'ndjson'
  | 'csv'
  | 'tsv'
  | 'xml'
  | 'javascript'
  | 'text'
  | 'binary'
  | 'unknown'

export type Dataset = {
  format: Format
  collections: Collection[]
  notes: string[]
}

export type FieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'object'
  | 'array'
  | 'empty'

export type FieldInfo = { name: string; type: FieldType; filled: number }

export type Env = {
  ASSETS: Fetcher
  DB: D1Database
  FILES: R2Bucket
  OPENAI_API_KEY?: string
  AI_MODEL?: string
  CABINET_TOKEN?: string
  CABINET_PROTECT_READS?: string
  AI_REDACT_PII?: string
}

export type FileStatus = 'ready' | 'needs_ai' | 'empty'

export type FilterOp =
  | 'eq'
  | 'ne'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'contains'
  | 'exists'
  | 'empty'

export type Filter = { field: string; op: FilterOp; value?: unknown }

export type RuleName = 'required' | 'type' | 'unique' | 'one_of' | 'min' | 'max'

export type Rule = {
  id: string
  field: string
  rule: RuleName
  value: unknown
  createdAt: string
}

export type Violation = {
  recordId?: string
  field: string
  rule: RuleName
  message: string
}

export type FileVersion = {
  id: string
  fileId: string
  revision: number
  size: number
  format: string
  hash: string
  reason: string
  createdAt: string
}

export type AuditEvent = {
  id: string
  fileId: string | null
  collection: string | null
  recordId: string | null
  action: string
  detail: Record<string, unknown>
  createdAt: string
}

export type SavedView = {
  id: string
  fileId: string
  collection: string
  name: string
  query: Record<string, unknown>
  createdAt: string
}

export type Share = {
  id: string
  fileId: string
  collection: string | null
  expiresAt: string
  createdAt: string
}
