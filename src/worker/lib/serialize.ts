import { fileStem } from './infer'
import type { Collection, Format, Row } from './types'

export type ExportFormat = 'json' | 'ndjson' | 'csv' | 'xml' | 'txt'

export const EXPORT_TYPES: Record<ExportFormat, string> = {
  json: 'application/json',
  ndjson: 'application/x-ndjson',
  csv: 'text/csv',
  xml: 'application/xml',
  txt: 'text/plain',
}

const EXTENSIONS: Record<ExportFormat, string> = {
  json: 'json',
  ndjson: 'ndjson',
  csv: 'csv',
  xml: 'xml',
  txt: 'txt',
}

export function exportFilename(name: string, format: ExportFormat): string {
  const base = (name.split(/[\\/]/).pop() ?? 'dataset')
    .replace(/\.[^.]*$/, '')
    .replace(/["\\]/g, '')
  return `${base || 'dataset'}.${EXTENSIONS[format]}`
}

/** Write collections back out in a file format the app can read again. */
export function serializeCollections(
  collections: Collection[],
  format: ExportFormat,
): string {
  if (format === 'json') {
    const payload =
      collections.length === 1
        ? collections[0]!.records
        : Object.fromEntries(collections.map((c) => [c.name, c.records]))
    return `${JSON.stringify(payload, null, 2)}\n`
  }

  if (format === 'ndjson') {
    if (collections.length === 1)
      return collections[0]!.records.map((row) => JSON.stringify(row)).join('\n') + '\n'
    return (
      collections
        .flatMap((collection) =>
          collection.records.map((row) =>
            JSON.stringify({ _collection: collection.name, ...row }),
          ),
        )
        .join('\n') + '\n'
    )
  }

  if (format === 'csv') {
    const collection = collections[0]
    if (!collection) return ''
    const header = collection.records.reduce<string[]>((keys, row) => {
      for (const key of Object.keys(row)) if (!keys.includes(key)) keys.push(key)
      return keys
    }, [])
    const lines = [header.map(csvCell).join(',')]
    for (const row of collection.records)
      lines.push(header.map((key) => csvCell(row[key])).join(','))
    return `${lines.join('\n')}\n`
  }

  if (format === 'xml') {
    const body =
      collections.length === 1
        ? collections[0]!.records
            .map((row) => `  <record>${xmlFields(row)}</record>`)
            .join('\n')
        : collections
            .map(
              (collection) =>
                `  <${xmlName(collection.name)}>\n${collection.records
                  .map((row) => `    <record>${xmlFields(row)}</record>`)
                  .join('\n')}\n  </${xmlName(collection.name)}>`,
            )
            .join('\n')
    return `<?xml version="1.0" encoding="UTF-8"?>\n<dataset>\n${body}\n</dataset>\n`
  }

  return (
    collections
      .flatMap((collection) =>
        collection.records.map((row) =>
          Object.entries(row)
            .map(([key, value]) => `${key}: ${displayValue(value)}`)
            .join('\n'),
        ),
      )
      .join('\n\n') + '\n'
  )
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text =
    typeof value === 'object' ? JSON.stringify(value) : String(value)
  return /[",\t\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function xmlFields(row: Record<string, unknown>): string {
  return Object.entries(row)
    .map(
      ([key, value]) =>
        `<${xmlName(key)}>${escapeXml(displayValue(value))}</${xmlName(key)}>`,
    )
    .join('')
}

function xmlName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_.-]/g, '_')
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `field_${cleaned}`
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * Re-encode collections in a file's own format so that the stored source file
 * carries the edits. Formats that cannot hold the data (several collections in
 * a CSV, nested values in XML) fall back to JSON, and the caller is told which
 * format was actually written.
 */
export function serializeForFile(
  name: string,
  format: Format,
  collections: Collection[],
): { text: string; format: Format } {
  if (!collections.some((collection) => collection.records.length))
    return { text: '', format }

  const single = collections.length === 1 ? collections[0] : undefined
  const named = Boolean(single && single.name === fileStem(name))

  if (format === 'csv' || format === 'tsv') {
    if (single && named && single.records.every(isTableRow))
      return { text: tableDocument(single, format === 'tsv' ? '\t' : ','), format }
    return { text: keyedJson(collections), format: 'json' }
  }

  if (format === 'xml') {
    if (single && single.records.every(isXmlRow))
      return { text: xmlDocument(single), format }
    return { text: keyedJson(collections), format: 'json' }
  }

  if (format === 'ndjson') {
    if (single && named)
      return {
        text: `${single.records.map((row) => JSON.stringify(row)).join('\n')}\n`,
        format,
      }
    return { text: `${JSON.stringify(keyedPayload(collections))}\n`, format }
  }

  if (format === 'javascript')
    return { text: `export default ${jsonBody(collections, named)}\n`, format }

  if (format === 'text') {
    if (single && named && single.records.every(isTextRow))
      return { text: textDocument(single.records), format }
    return { text: keyedJson(collections), format: 'json' }
  }

  return { text: jsonBody(collections, named), format: 'json' }
}

function keyedPayload(collections: Collection[]): Record<string, Row[]> {
  return Object.fromEntries(collections.map((collection) => [collection.name, collection.records]))
}

/** A bare array when the file is one collection named after the file, else keyed. */
function jsonBody(collections: Collection[], bare: boolean): string {
  const payload =
    bare && collections.length === 1 ? collections[0]!.records : keyedPayload(collections)
  return `${JSON.stringify(payload, null, 2)}\n`
}

function keyedJson(collections: Collection[]): string {
  return `${JSON.stringify(keyedPayload(collections), null, 2)}\n`
}

const isScalar = (value: unknown): boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

function isTableRow(row: Row): boolean {
  return Object.values(row).every(
    (value) => value === null || value === undefined || isScalar(value),
  )
}

function tableDocument(collection: Collection, delimiter: string): string {
  const header = collection.records.reduce<string[]>((keys, row) => {
    for (const key of Object.keys(row)) if (!keys.includes(key)) keys.push(key)
    return keys
  }, [])
  const lines = [header.map((key) => csvCell(key)).join(delimiter)]
  for (const row of collection.records)
    lines.push(header.map((key) => csvCell(row[key])).join(delimiter))
  return `${lines.join('\n')}\n`
}

const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/

function isXmlRow(row: Row): boolean {
  return Object.entries(row).every(([key, value]) => {
    if (!isScalar(value)) return false
    if (key === '#text') return true
    if (key.startsWith('@')) return XML_NAME.test(key.slice(1))
    return XML_NAME.test(key)
  })
}

function xmlDocument(collection: Collection): string {
  const lines = collection.records.map((row) => `  ${xmlRecord(collection.name, row)}`)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<dataset>\n${lines.join('\n')}\n</dataset>\n`
}

/** `@attr` keys become attributes and `#text` becomes the element text. */
function xmlRecord(name: string, row: Row): string {
  const attributes: string[] = []
  const children: string[] = []
  let text = ''
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith('@'))
      attributes.push(`${xmlName(key.slice(1))}="${escapeXml(displayValue(value))}"`)
    else if (key === '#text') text = escapeXml(displayValue(value))
    else children.push(`<${xmlName(key)}>${escapeXml(displayValue(value))}</${xmlName(key)}>`)
  }
  const attr = attributes.length ? ` ${attributes.join(' ')}` : ''
  const tag = xmlName(name)
  return children.length || text
    ? `<${tag}${attr}>${children.join('')}${text}</${tag}>`
    : `<${tag}${attr}/>`
}

function isTextRow(row: Row): boolean {
  const entries = Object.entries(row)
  if (entries.length < 2) return false
  return entries.every(([key, value]) => {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) return false
    if (value === null) return true
    if (typeof value === 'string') return value.length > 0 && !/[\r\n]/.test(value)
    return typeof value === 'number' || typeof value === 'boolean'
  })
}

function textDocument(records: Row[]): string {
  return (
    records
      .map((row) =>
        Object.entries(row)
          .map(([key, value]) => `${key}: ${displayValue(value)}`)
          .join('\n'),
      )
      .join('\n\n') + '\n'
  )
}
