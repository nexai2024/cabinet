import { coerceCell, readDelimited, sniffDelimiter } from './delimited'
import { collectionsFromValue, fileStem, fieldsOf, jsonSafe } from '../infer'
import { parseLoose, parseScriptModule } from './loose'
import { readText } from './text'
import { parseXmlDocument } from './xml'
import type { Collection, Dataset, Format } from '../types'

const EXTENSION_FORMATS: Record<string, Format> = {
  json: 'json',
  json5: 'json',
  geojson: 'json',
  jsonl: 'ndjson',
  ndjson: 'ndjson',
  csv: 'csv',
  tsv: 'tsv',
  tab: 'tsv',
  xml: 'xml',
  rss: 'xml',
  atom: 'xml',
  plist: 'xml',
  svg: 'xml',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'javascript',
  txt: 'text',
  text: 'text',
  log: 'text',
  md: 'text',
  dat: 'unknown',
  bin: 'binary',
  db: 'binary',
  sqlite: 'binary',
  pdf: 'binary',
  png: 'binary',
  jpg: 'binary',
  jpeg: 'binary',
  gif: 'binary',
  zip: 'binary',
}

export function extensionOf(name: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(name)
  return match ? match[1]!.toLowerCase() : ''
}

export function decodeText(bytes: Uint8Array): { text: string; binary: boolean } {
  const text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(bytes)
  if (text.includes('\u0000')) return { text, binary: true }
  const sample = text.slice(0, 20_000)
  let control = 0
  for (const char of sample) {
    const code = char.codePointAt(0)!
    if (code === 9 || code === 10 || code === 13) continue
    if (code < 32 || code === 0xfffd) control += 1
  }
  return { text, binary: sample.length > 0 && control / sample.length > 0.02 }
}

type Attempt = { value: unknown; method: string } | null

const attempt = (run: () => unknown, method: string): Attempt => {
  try {
    const value = run()
    if (value === null || value === undefined) return null
    if (typeof value === 'string' && !value.trim()) return null
    return { value, method }
  } catch {
    return null
  }
}

function collectionsFromTable(text: string, format: Format, name: string): Collection[] {
  const delimiter = format === 'tsv' ? '\t' : sniffDelimiter(text)
  const table = readDelimited(text, delimiter)
  if (!table.header.length || !table.rows.length) return []
  return [
    {
      name: fileStem(name),
      records: table.rows.map((row) =>
        Object.fromEntries(
          table.header.map((field, column) => [field, coerceCell(row[column] ?? '')]),
        ),
      ),
    },
  ]
}

function shape(format: Format, value: unknown, name: string, notes: string[]): Dataset {
  return {
    format,
    collections: collectionsFromValue(value, fileStem(name)),
    notes,
  }
}

/**
 * Read a file into collections. The extension picks the first reader, then
 * content sniffing takes over, so a JSON body named `.dat` still opens.
 */
function readDatasetRaw(name: string, bytes: Uint8Array): Dataset {
  const extension = extensionOf(name)
  const expected = EXTENSION_FORMATS[extension] ?? 'unknown'
  const { text, binary } = decodeText(bytes)
  const stem = fileStem(name)

  if (binary) {
    return {
      format: expected === 'binary' ? 'binary' : 'binary',
      collections: [],
      notes: [
        'This file contains binary data, so its structure needs the model to read it.',
      ],
    }
  }
  if (!text.trim()) {
    return { format: expected, collections: [], notes: ['The file is empty.'] }
  }

  const attempts: Attempt[] = []
  const trimmed = text.trimStart()
  const triesJson = () => attempt(() => JSON.parse(text), 'json')
  const triesScript = () => attempt(() => parseScriptModule(text), 'javascript')
  const triesXml = () => attempt(() => parseXmlDocument(text), 'xml')
  const triesLoose = () => attempt(() => parseLoose(text), 'loose literal')
  const triesNdjson = () => attempt(() => readNdjson(text), 'ndjson')
  const triesLines = () => attempt(() => readLines(text), 'lines')

  if (expected === 'json') attempts.push(triesJson(), triesLoose())
  else if (expected === 'ndjson') attempts.push(triesNdjson(), triesJson())
  else if (expected === 'javascript') attempts.push(triesScript(), triesJson())
  else if (expected === 'xml') attempts.push(triesXml())
  else if (expected === 'csv' || expected === 'tsv') {
    // A table cannot hold several collections, so writing one back may leave
    // JSON in a .csv; content wins over the extension there too.
    const json = trimmed.startsWith('{') || trimmed.startsWith('[') ? triesJson() : null
    if (json) {
      const dataset = shape('json', json.value, name, [
        'The body is JSON, so it was read as JSON.',
      ])
      if (dataset.collections.length) return dataset
    }
    const table = collectionsFromTable(text, expected, name)
    if (table.length)
      return {
        format: expected,
        collections: table,
        notes: [`Read ${table[0]!.records.length} rows as a table.`],
      }
    attempts.push(triesJson())
  } else if (expected === 'text') attempts.push(triesJson(), triesXml(), triesNdjson())

  // Content wins over the extension: sniff the rest, most specific first.
  attempts.push(triesJson(), triesScript(), triesXml(), triesNdjson())
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) attempts.unshift(triesJson())

  for (const result of attempts) {
    if (!result) continue
    const dataset = shape(expected === 'unknown' ? formatFor(result.method, extension) : expected, result.value, name, [
      `Read with the ${result.method} reader.`,
    ])
    if (dataset.collections.length) return dataset
  }

  const textGuess = readText(text)
  if (textGuess && textGuess.rows.length) {
    return {
      format: expected === 'unknown' ? 'text' : expected,
      collections: [{ name: stem, records: textGuess.rows }],
      notes: textGuess.notes,
    }
  }

  return {
    format: expected === 'unknown' ? 'text' : expected,
    collections: [],
    notes: ['No records could be read from this file without help from the model.'],
  }
}

function formatFor(method: string, extension: string): Format {
  if (method === 'json') return extension === 'ndjson' ? 'ndjson' : 'json'
  if (method === 'xml') return 'xml'
  if (method === 'javascript' || method === 'loose literal') return 'javascript'
  if (method === 'ndjson') return 'ndjson'
  return 'text'
}

function readNdjson(text: string): unknown {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length < 1) throw new SyntaxError('No lines')
  const values = lines.map((line) => JSON.parse(line) as unknown)
  return values
}

function readLines(text: string): unknown {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, position) => ({ line, position: position + 1 }))
  if (!rows.length) throw new SyntaxError('No lines')
  return rows
}

/** Opening a file is bounded by rows, not silently truncated. */
export const MAX_ROWS = 50_000

/**
 * Read a file into collections. The extension picks the first reader, then
 * content sniffing takes over, so a JSON body named `.dat` still opens.
 */
export function readDataset(name: string, bytes: Uint8Array): Dataset {
  return capDataset(readDatasetRaw(name, bytes))
}

function capDataset(dataset: Dataset): Dataset {
  let remaining = MAX_ROWS
  let dropped = 0
  const collections: Collection[] = []
  for (const collection of dataset.collections) {
    if (remaining <= 0) {
      dropped += collection.records.length
      continue
    }
    if (collection.records.length > remaining) {
      dropped += collection.records.length - remaining
      collections.push({ name: collection.name, records: collection.records.slice(0, remaining) })
      remaining = 0
      continue
    }
    collections.push(collection)
    remaining -= collection.records.length
  }
  const notes = [...dataset.notes]
  if (dropped)
    notes.push(
      `Opened the first ${MAX_ROWS} records only; ${dropped} more stayed unread in the file.`,
    )
  return { ...dataset, collections, notes }
}

export function fieldSummary(records: Record<string, unknown>[]) {
  return fieldsOf(records).map((field) => ({
    name: field.name,
    type: field.type,
    filled: field.filled,
  }))
}

export { jsonSafe }
