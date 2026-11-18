import { readDelimited, coerceCell } from './delimited'
import type { Row } from '../types'

export type TextGuess = { rows: Row[]; notes: string[] } | null

const KEY_VALUE = /^\s*["']?([A-Za-z0-9_.\- ]{1,64})["']?\s*[:=]\s*(.*)$/

/**
 * Plain text has no schema, so a few common layouts are tried in order:
 * key/value blocks, then a delimited table, then one record per line.
 */
export function readText(text: string): TextGuess {
  const lines = text.split(/\r?\n/)
  const nonEmpty = lines.filter((line) => line.trim().length > 0)
  if (!nonEmpty.length) return null

  const blocks = text
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.split(/\r?\n/).filter((line) => line.trim().length > 0))
    .filter((block) => block.length > 0)

  const blockRows = blocks.map(readKeyValueBlock)
  if (blocks.length >= 1 && blockRows.every((row) => row && Object.keys(row).length >= 2))
    return {
      rows: blockRows as Row[],
      notes: [
        blocks.length === 1
          ? 'Read one record from key/value lines.'
          : `Read ${blocks.length} records from blank-line separated blocks.`,
      ],
    }

  const delimited = readDelimited(text)
  if (
    delimited.header.length > 1 &&
    delimited.rows.length > 0 &&
    delimited.rows.every((row) => row.length === delimited.header.length)
  )
    return {
      rows: delimited.rows.map((row, position) =>
        Object.fromEntries(
          delimited.header.map((field, column) => [
            field,
            coerceCell(row[column] ?? ''),
          ]),
        ),
      ),
      notes: [
        `Read a table with ${delimited.header.length} columns separated by ${
          delimited.delimiter === '\t' ? 'tabs' : `"${delimited.delimiter}"`
        }.`,
      ],
    }

  return {
    rows: nonEmpty.map((line, position) => ({ line: line.trim(), position: position + 1 })),
    notes: ['No structure was detected, so each non-empty line became a record.'],
  }
}

function readKeyValueBlock(block: string[]): Row | null {
  if (block.length < 2) return null
  const row: Row = {}
  for (const line of block) {
    const match = KEY_VALUE.exec(line)
    if (!match) return null
    const key = match[1]!.trim().replace(/\s+/g, '_')
    if (key in row) return null
    row[key] = coerceCell(match[2]!.trim())
  }
  return row
}
