import { z } from 'zod'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { isPlainObject, jsonSafe } from '../lib/infer'
import type { Row } from '../lib/types'

export const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
})

export const json = <T extends z.ZodType>(schema: T) => ({
  'application/json': { schema },
})

/** Every write accepts the shared key as a bearer token or its own header. */
export const keySecurity: Array<Record<string, string[]>> = [
  { bearerAuth: [] },
  { cabinetKey: [] },
]

export const authResponses = {
  401: {
    description:
      'No access key was sent, or it does not match. Send it as an Authorization: Bearer token or an x-cabinet-key header.',
    content: json(errorSchema),
  },
  503: {
    description: 'The server has no CABINET_TOKEN set, so changes are disabled.',
    content: json(errorSchema),
  },
} as const

export function fail<S extends ContentfulStatusCode>(
  c: Context,
  status: S,
  code: string,
  message: string,
) {
  return c.json({ error: { code, message } }, status)
}

const KEY = /^[A-Za-z0-9_@#.$ /-]{1,64}$/
const MAX_ROW_BYTES = 16 * 1024

/**
 * Records are free-form JSON objects, so they are checked here rather than by
 * a generated OpenAPI schema: bounded size, bounded field count, safe names.
 */
export function validateRow(
  input: unknown,
): { ok: true; row: Row } | { ok: false; message: string } {
  if (!isPlainObject(input))
    return { ok: false, message: 'A record must be a JSON object.' }
  const entries = Object.entries(input)
  if (!entries.length)
    return { ok: false, message: 'A record needs at least one field.' }
  if (entries.length > 64)
    return { ok: false, message: 'A record can have at most 64 fields.' }
  for (const [key] of entries)
    if (!KEY.test(key))
      return {
        ok: false,
        message: `Field name "${key.slice(0, 40)}" is not allowed.`,
      }
  const safe = jsonSafe(input)
  if (!isPlainObject(safe)) return { ok: false, message: 'The record is not valid JSON.' }
  if (JSON.stringify(safe).length > MAX_ROW_BYTES)
    return { ok: false, message: 'A record can be at most 16 KB.' }
  return { ok: true, row: safe }
}

export const rowSchema = z.record(z.string(), z.any())

export const collectionNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9_]+$/, 'Use lowercase letters, numbers and underscores.')

export function cleanFileName(raw: string): string {
  const base = (raw.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return base.slice(0, 120)
}
