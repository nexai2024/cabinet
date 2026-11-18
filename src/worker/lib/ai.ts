import { z } from 'zod'
import { collectionsFromValue, isPlainObject, jsonSafe } from './infer'
import { redactForModel } from './redact'
import type { Collection, Env, Filter, FilterOp, Row } from './types'

const BASE_URL = 'https://freebuff.com/api/v1/paid'
const ALLOWED_MODELS = ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-5-mini'] as const
const DEFAULT_MODEL = 'gpt-4o-mini'
const MAX_SAMPLE = 12_000

export type AiFailure = 'ai_not_configured' | 'ai_failed' | 'ai_unreachable' | 'ai_unreadable'

export class AiError extends Error {
  constructor(
    readonly code: AiFailure,
    message: string,
  ) {
    super(message)
    this.name = 'AiError'
  }
}

function modelFor(env: Env): string {
  const requested = env.AI_MODEL?.trim()
  return ALLOWED_MODELS.find((candidate) => candidate === requested) ?? DEFAULT_MODEL
}

function redact(env: Env, text: string) {
  return redactForModel(text, env.AI_REDACT_PII !== 'false')
}

/** One validated JSON round trip to the model. */
async function callModel(env: Env, instructions: string, prompt: string): Promise<unknown> {
  if (!env.OPENAI_API_KEY)
    throw new AiError(
      'ai_not_configured',
      'Add OPENAI_API_KEY to let the model read unfamiliar files.',
    )
  const model = modelFor(env)

  let response: Response
  try {
    response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: instructions },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw new AiError('ai_unreachable', 'The model could not be reached. Try again.')
  }

  if (!response.ok)
    throw new AiError(
      'ai_failed',
      `The model returned an error (${response.status}). Check the API key and credits.`,
    )

  let content: unknown
  try {
    const payload = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[]
    }
    content = payload.choices?.[0]?.message?.content
  } catch {
    throw new AiError('ai_unreadable', 'The model response was not readable JSON.')
  }
  if (typeof content !== 'string' || !content.trim())
    throw new AiError('ai_unreadable', 'The model returned an empty response.')

  try {
    return JSON.parse(stripFences(content))
  } catch {
    throw new AiError('ai_unreadable', 'The model did not return usable JSON.')
  }
}

/* --------------------------- reading files -------------------------- */

const responseSchema = z.object({
  collections: z
    .array(
      z.object({
        name: z.string().min(1).max(64),
        records: z.array(z.record(z.string(), z.unknown())).max(200),
      }),
    )
    .min(1)
    .max(20),
  notes: z.string().max(500).optional(),
})

const INSTRUCTIONS = `You read data files whose format is unknown and return their structure as JSON.

Rules:
- Answer with one JSON object only, no prose and no code fences.
- Shape: {"collections":[{"name":"...","records":[{...}]}],"notes":"..."}
- A collection is a repeated group of records, like a table.
- Use the field names present in the file. Normalise nested groups into separate collections when the file repeats them.
- Every record must be a JSON object. Keep values as they appear: numbers stay numbers, booleans stay booleans.
- Do not invent records or fields. If the file holds a single record, return one record.
- Return at most 200 records per collection.
- Keep notes under 300 characters and describe how you read the file.`

export type AiResult = {
  collections: Collection[]
  notes: string[]
  model: string
  redactions: number
}

/**
 * Ask the model to infer a structure. Only the file's text sample leaves the
 * server, personal data is redacted first, and anything returned is validated.
 */
export async function inferWithAi(env: Env, name: string, text: string): Promise<AiResult> {
  const safe = redact(env, text.slice(0, MAX_SAMPLE))
  const parsed = await callModel(
    env,
    INSTRUCTIONS,
    `File name: ${name}\nFile contents${text.length > MAX_SAMPLE ? ' (truncated)' : ''}:\n\n${safe.text}`,
  )

  const validated = responseSchema.safeParse(parsed)
  if (!validated.success)
    throw new AiError('ai_unreadable', 'The model returned an unexpected structure.')

  const collections: Collection[] = []
  for (const collection of validated.data.collections) {
    const records = collection.records
      .map((record) => sanitize(record))
      .filter((record): record is Record<string, unknown> => record !== null)
    const normalized = records.length > 0 ? collectionsFromValue(records, collection.name) : []
    for (const entry of normalized) {
      if (entry.records.length)
        collections.push({ name: entry.name, records: entry.records })
    }
  }
  if (!collections.length)
    throw new AiError('ai_unreadable', 'The model found no records in this file.')

  const notes = [
    validated.data.notes?.trim() ||
      `The model read this file as ${collections.length} collection${collections.length === 1 ? '' : 's'}.`,
    `Inferred by ${modelFor(env)}.`,
  ]
  if (safe.count)
    notes.push(
      `Redacted ${safe.count} personal or secret value${safe.count === 1 ? '' : 's'} before sending.`,
    )

  return {
    collections: collections.slice(0, 20).map((collection) => ({
      name: collection.name,
      records: collection.records.slice(0, 500),
    })),
    notes,
    model: modelFor(env),
    redactions: safe.count,
  }
}

function sanitize(record: Record<string, unknown>): Record<string, unknown> | null {
  const safe = jsonSafe(record)
  if (!isPlainObject(safe)) return null
  const entries = Object.entries(safe).slice(0, 64)
  if (!entries.length) return null
  return Object.fromEntries(entries.map(([key, value]) => [key.slice(0, 64), value]))
}

/* --------------------------- query planning ------------------------- */

const OPS: FilterOp[] = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'exists', 'empty']

const querySchema = z.object({
  filters: z
    .array(
      z.object({
        field: z.string().max(64),
        op: z.string().max(16).optional(),
        value: z.unknown().optional(),
      }),
    )
    .max(12)
    .default([]),
  sort: z.string().max(64).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  explanation: z.string().max(500).optional(),
})

const QUERY_INSTRUCTIONS = `You translate a question about one data table into a filter plan. Answer with JSON only.

Shape: {"filters":[{"field":"...","op":"eq|ne|lt|lte|gt|gte|contains|exists|empty","value":...}],"sort":"field","direction":"asc|desc","limit":50,"explanation":"..."}

Rules:
- Use only the field names given. Never invent fields.
- Text matching uses eq (exact) or contains (substring, case-insensitive).
- Numeric and date comparisons use lt, lte, gt, gte with plain values.
- exists means the field has a value; empty means it is blank.
- Combine filters with AND. Leave filters empty when the question is just "show me rows".
- Keep limit at or below 200. Write a short explanation for the user.`

export type AiQueryPlan = {
  filters: Filter[]
  sort?: string
  direction: 'asc' | 'desc'
  limit: number
  explanation: string
  redactions: number
}

export async function planQuery(
  env: Env,
  input: {
    name: string
    collection: string
    fields: string[]
    rows: Row[]
    question: string
  },
): Promise<AiQueryPlan> {
  const sample = redact(
    env,
    JSON.stringify(input.rows.slice(0, 20), null, 1).slice(0, MAX_SAMPLE),
  )
  const parsed = await callModel(
    env,
    QUERY_INSTRUCTIONS,
    `File: ${input.name}\nCollection: ${input.collection}\nFields: ${input.fields.join(', ')}\nSample rows:\n\n${sample.text}\n\nQuestion: ${input.question}`,
  )
  const validated = querySchema.safeParse(parsed)
  if (!validated.success)
    throw new AiError('ai_unreadable', 'The model did not return a usable filter plan.')

  const fields = new Set(input.fields)
  const filters: Filter[] = []
  for (const entry of validated.data.filters) {
    if (!fields.has(entry.field)) continue
    const op = OPS.find((candidate) => candidate === entry.op) ?? 'eq'
    filters.push({ field: entry.field, op, value: entry.value })
  }
  const sort = validated.data.sort && fields.has(validated.data.sort) ? validated.data.sort : undefined
  return {
    filters,
    sort,
    direction: validated.data.direction === 'desc' ? 'desc' : 'asc',
    limit: validated.data.limit ?? 50,
    explanation: validated.data.explanation?.trim() || 'Matched the rows the model selected.',
    redactions: sample.count,
  }
}

/* --------------------------- fix suggestions ------------------------ */

const fixesSchema = z.object({
  fixes: z
    .array(
      z.object({
        recordId: z.string().max(64),
        field: z.string().max(64),
        value: z.unknown(),
        reason: z.string().max(300).optional(),
      }),
    )
    .max(50)
    .default([]),
  notes: z.string().max(500).optional(),
})

export type AiFix = { recordId: string; field: string; value: unknown; reason: string }

const FIX_INSTRUCTIONS = `You repair rows that break validation rules. Answer with JSON only.

Shape: {"fixes":[{"recordId":"...","field":"...","value":...,"reason":"..."}],"notes":"..."}

Rules:
- Only propose values for fields that appear in the violations.
- Use the recordId exactly as given; never invent records.
- Keep values in the same type the field already uses.
- At most 50 fixes. Explain each fix in one short sentence.
- If a value cannot be repaired safely, leave it out.`

export async function suggestFixes(
  env: Env,
  input: {
    name: string
    collection: string
    rows: { id: string; data: Row }[]
    violations: unknown
  },
): Promise<{ fixes: AiFix[]; notes: string; redactions: number }> {
  const sample = redact(
    env,
    JSON.stringify({ rows: input.rows.slice(0, 40), violations: input.violations }, null, 1).slice(
      0,
      MAX_SAMPLE,
    ),
  )
  const parsed = await callModel(
    env,
    FIX_INSTRUCTIONS,
    `File: ${input.name}\nCollection: ${input.collection}\nRows and violations:\n\n${sample.text}`,
  )
  const validated = fixesSchema.safeParse(parsed)
  if (!validated.success)
    throw new AiError('ai_unreadable', 'The model did not return usable fixes.')

  const known = new Set(input.rows.map((row) => row.id))
  return {
    fixes: validated.data.fixes
      .filter((fix) => known.has(fix.recordId))
      .map((fix) => ({
        recordId: fix.recordId,
        field: fix.field,
        value: fix.value,
        reason: fix.reason?.trim() || 'Adjusted to satisfy the rule.',
      })),
    notes: validated.data.notes?.trim() || '',
    redactions: sample.count,
  }
}

/* --------------------------- field mapping -------------------------- */

const mappingSchema = z.object({
  mapping: z.record(z.string(), z.string()).default({}),
  notes: z.string().max(500).optional(),
})

const MAPPING_INSTRUCTIONS = `You map fields from one table to the closest fields in another. Answer with JSON only.

Shape: {"mapping":{"sourceField":"targetField"},"notes":"..."}

Rules:
- Use only the source and target names given.
- Omit a source field when no target is a reasonable match.
- Do not map two sources to the same target.`

export async function suggestMapping(
  env: Env,
  input: { source: string; target: string; sourceFields: string[]; targetFields: string[] },
): Promise<{ mapping: Record<string, string>; notes: string; redactions: number }> {
  const parsed = await callModel(
    env,
    MAPPING_INSTRUCTIONS,
    `Source table ${input.source}: ${input.sourceFields.join(', ')}\nTarget table ${input.target}: ${input.targetFields.join(', ')}`,
  )
  const validated = mappingSchema.safeParse(parsed)
  if (!validated.success)
    throw new AiError('ai_unreadable', 'The model did not return a usable mapping.')

  const sources = new Set(input.sourceFields)
  const targets = new Set(input.targetFields)
  const used = new Set<string>()
  const mapping: Record<string, string> = {}
  for (const [from, to] of Object.entries(validated.data.mapping)) {
    if (!sources.has(from) || !targets.has(to) || used.has(to)) continue
    used.add(to)
    mapping[from] = to
  }
  return {
    mapping,
    notes: validated.data.notes?.trim() || '',
    redactions: 0,
  }
}

function stripFences(content: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(content)
  const body = fenced ? fenced[1]! : content
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return body.trim()
  return body.slice(start, end + 1)
}
