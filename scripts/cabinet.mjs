#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { CabinetClient } from './lib/cabinet-client.mjs'

const USAGE = `Cabinet CLI — talk to a running Cabinet API.

Environment:
  CABINET_URL    API base (default http://localhost:5173)
  CABINET_TOKEN  access key for writes

Commands:
  stats
  files
  open <file>
  records <file> <collection> [--limit N] [--q text] [--filter '<json array>']
  add <file> <collection> '<json object>'
  update <file> <collection> <recordId> '<json object>'
  rm <file> <collection> <recordId>
  read <file> [--ai]
  versions <file>
  restore <file> <versionId>
  import <file> <collection> <path> [--key field]
  ask <file> <collection> '<question>'
  events <file>
  trash
  delete <file>
  undelete <file>

<file> is a stored file id or its exact name.`

const args = process.argv.slice(2)
const flags = {}
const positional = []
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === '--ai') flags.ai = true
  else if (arg.startsWith('--')) {
    const key = arg.slice(2)
    const next = args[index + 1]
    if (next && !next.startsWith('--')) {
      flags[key] = next
      index += 1
    } else flags[key] = true
  } else positional.push(arg)
}

const client = new CabinetClient()
const [command, ...rest] = positional

const print = (value) => console.log(JSON.stringify(value, null, 2))

const jsonArg = (raw, label) => {
  try {
    const value = JSON.parse(raw ?? '')
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error(`${label} must be a JSON object.`)
    return value
  } catch {
    throw new Error(`${label} must be a JSON object, for example '{"name":"Ada"}'.`)
  }
}

async function main() {
  if (!command || command === 'help' || command === '--help') return console.log(USAGE)

  if (command === 'stats') return print(await client.stats())
  if (command === 'files') return print(await client.listFiles())
  if (command === 'trash') return print(await client.trash())

  const file = rest[0] ? await client.resolveFile(rest[0]) : null

  if (command === 'open') {
    if (!file) throw new Error('Which file?')
    return print(await client.detail(file.id))
  }
  if (command === 'records') {
    if (!file || !rest[1]) throw new Error('Usage: records <file> <collection>')
    const filters = flags.filter ? JSON.parse(flags.filter) : undefined
    return print(
      await client.records(file.id, rest[1], {
        limit: flags.limit ?? 50,
        q: flags.q,
        filter: filters ? JSON.stringify(filters) : undefined,
      }),
    )
  }
  if (command === 'add') {
    if (!file || !rest[1]) throw new Error('Usage: add <file> <collection> <json>')
    return print(await client.createRecord(file.id, rest[1], jsonArg(rest[2], 'The record')))
  }
  if (command === 'update') {
    if (!file || !rest[1] || !rest[2]) throw new Error('Usage: update <file> <collection> <recordId> <json>')
    return print(
      await client.updateRecord(file.id, rest[1], rest[2], jsonArg(rest[3], 'The record')),
    )
  }
  if (command === 'rm') {
    if (!file || !rest[1] || !rest[2]) throw new Error('Usage: rm <file> <collection> <recordId>')
    return print(await client.deleteRecord(file.id, rest[1], rest[2]))
  }
  if (command === 'read') {
    if (!file) throw new Error('Which file?')
    return print(await client.readFile(file.id, flags.ai ? 'ai' : 'heuristic'))
  }
  if (command === 'versions') {
    if (!file) throw new Error('Which file?')
    return print(await client.versions(file.id))
  }
  if (command === 'restore') {
    if (!file || !rest[1]) throw new Error('Usage: restore <file> <versionId>')
    return print(await client.restoreVersion(file.id, rest[1]))
  }
  if (command === 'import') {
    if (!file || !rest[1] || !rest[2]) throw new Error('Usage: import <file> <collection> <path>')
    const bytes = new Uint8Array(await readFile(rest[2]))
    const name = rest[2].split(/[\\/]/).pop()
    return print(await client.importFile(file.id, rest[1], bytes, name, flags.key))
  }
  if (command === 'ask') {
    if (!file || !rest[1]) throw new Error('Usage: ask <file> <collection> "<question>"')
    return print(await client.ask(file.id, rest[1], rest.slice(2).join(' ')))
  }
  if (command === 'events') {
    if (!file) throw new Error('Which file?')
    return print(await client.events(file.id))
  }
  if (command === 'delete') {
    if (!file) throw new Error('Which file?')
    return print(await client.trashFile(file.id))
  }
  if (command === 'undelete') {
    if (!file) throw new Error('Which file?')
    return print(await client.restoreFile(file.id))
  }

  throw new Error(`Unknown command “${command}”.\n\n${USAGE}`)
}

main().catch((error) => {
  console.error(`cabinet: ${error.message}`)
  process.exitCode = 1
})
