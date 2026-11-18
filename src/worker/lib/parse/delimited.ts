export type DelimitedTable = {
  delimiter: string
  header: string[]
  rows: string[][]
}

const DELIMITERS = [',', '\t', ';', '|']

export function sniffDelimiter(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .find((candidate) => candidate.trim().length > 0) ?? ''
  let best = ','
  let bestCount = 0
  for (const delimiter of DELIMITERS) {
    const count = line.split(delimiter).length - 1
    if (count > bestCount) {
      best = delimiter
      bestCount = count
    }
  }
  return best
}

/** RFC 4180 style reader: quoted cells, escaped quotes, embedded newlines. */
export function readDelimited(text: string, delimiter = sniffDelimiter(text)): DelimitedTable {
  const rows: string[][] = []
  let cell = ''
  let row: string[] = []
  let quoted = false
  const source = text.replace(/^\uFEFF/, '')

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"'
          index += 1
        } else quoted = false
      } else cell += char
      continue
    }
    if (char === '"' && cell.length === 0) {
      quoted = true
      continue
    }
    if (char === delimiter) {
      row.push(cell)
      cell = ''
      continue
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1
      row.push(cell)
      cell = ''
      if (row.some((value) => value.trim().length > 0)) rows.push(row)
      row = []
      continue
    }
    cell += char
  }
  row.push(cell)
  if (row.some((value) => value.trim().length > 0)) rows.push(row)

  if (!rows.length) return { delimiter, header: [], rows: [] }
  const first = rows[0]!
  const rest = rows.slice(1)
  const hasHeader =
    rest.length > 0 &&
    first.every((cell) => cell.trim().length > 0) &&
    new Set(first.map((cell) => cell.trim().toLowerCase())).size === first.length &&
    first.some((cell) => !/^-?\d+([.,]\d+)?$/.test(cell.trim()))
  if (!hasHeader)
    return {
      delimiter,
      header: first.map((_, position) => `field_${position + 1}`),
      rows,
    }
  return { delimiter, header: first.map((cell) => cell.trim()), rows: rest }
}

/** Values stay typed so tables sort and filter sensibly after import. */
export function coerceCell(value: string): unknown {
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed) && trimmed.length < 16) {
    const number = Number(trimmed)
    if (Number.isFinite(number)) return number
  }
  return value
}
