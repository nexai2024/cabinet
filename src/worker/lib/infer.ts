import type { Row } from './types'

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Collection names come from the file, so keep them URL-safe and unique. */
export function collectionName(raw: string, fallback = 'records'): string {
  const name = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
  return (name || fallback).slice(0, 48)
}

export function fileStem(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  const stem = base.replace(/\.[^.]*$/, '')
  return collectionName(stem, 'records')
}

export function toRows(values: unknown[]): Row[] {
  return values.map((value, position) => {
    if (isPlainObject(value)) return value
    if (Array.isArray(value)) return { value }
    return { value: value ?? null, position: position + 1 }
  })
}

/**
 * Turn any inferred value into named collections. Arrays of objects become
 * records; an object with array fields becomes several collections, which is
 * how nested files such as `{ "users": [...], "orders": [...] }` open up.
 */
export function collectionsFromValue(
  value: unknown,
  fallbackName: string,
): { name: string; records: Row[] }[] {
  const out: { name: string; records: Row[] }[] = []
  const used = new Set<string>()

  const push = (name: string, records: Row[]) => {
    if (!records.length) return
    const base = collectionName(name)
    let unique = base
    let suffix = 2
    while (used.has(unique)) unique = `${base}_${suffix++}`
    used.add(unique)
    out.push({ name: unique, records })
  }

  const read = (input: unknown, name: string, depth: number) => {
    if (Array.isArray(input)) {
      push(name, toRows(input))
      return
    }
    if (isPlainObject(input)) {
      const arrays = Object.entries(input).filter(([, entry]) => Array.isArray(entry))
      if (arrays.length) {
        for (const [key, entry] of arrays) push(key, toRows(entry as unknown[]))
        return
      }
      // A single-object wrapper (`{"library":{"book":[...]}}`, XML roots) is
      // descended so the repeated elements inside become the collections.
      const keys = Object.keys(input)
      if (keys.length === 1 && depth < 4 && isPlainObject(input[keys[0]!])) {
        read(input[keys[0]!], keys[0]!, depth + 1)
        return
      }
      push(name, [input])
      return
    }
    if (input === null || input === undefined) return
    push(name, [{ value: input }])
  }

  read(value, fallbackName, 0)
  return out
}

export function fieldType(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return 'array'
  if (isPlainObject(value)) return 'object'
  return typeof value
}

/** Union of keys across rows, ordered by how often they appear. */
export function fieldsOf(records: Row[]) {
  const seen = new Map<string, { name: string; type: string; filled: number }>()
  for (const record of records.slice(0, 200)) {
    for (const [key, value] of Object.entries(record)) {
      const current = seen.get(key)
      const type = fieldType(value)
      if (current) {
        current.filled += 1
        if (current.type === 'null' && type !== 'null') current.type = type
      } else seen.set(key, { name: key, type, filled: 1 })
    }
  }
  return [...seen.values()].sort((a, b) => b.filled - a.filled).slice(0, 60)
}

/** Keep stored records JSON-safe and bounded. */
export function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null))
  } catch {
    return null
  }
}
