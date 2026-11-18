#!/usr/bin/env node
/**
 * Minimal Model Context Protocol server over stdio (newline-delimited JSON).
 * It exposes the Cabinet API as tools so an assistant can open files, query
 * collections and make guarded edits without hand-written curl.
 *
 * CABINET_URL and CABINET_TOKEN are read from the environment; stdout carries
 * protocol messages only, diagnostics go to stderr.
 */
import { CabinetClient } from './lib/cabinet-client.mjs'

const client = new CabinetClient()
const PROTOCOL_VERSION = '2024-11-05'

const tools = [
  {
    name: 'cabinet_list_files',
    description: 'List the data files Cabinet has opened, with collection and record counts.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'cabinet_open_file',
    description: 'Show one file, its collections and the fields of each collection.',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string', description: 'File id or exact file name' } },
      required: ['file'],
      additionalProperties: false,
    },
  },
  {
    name: 'cabinet_query_records',
    description:
      'Page through records. Supports substring search and typed filters such as [{"field":"qty","op":"gt","value":10}].',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        collection: { type: 'string' },
        q: { type: 'string' },
        filters: { type: 'array', items: { type: 'object' } },
        sort: { type: 'string' },
        direction: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'number' },
        offset: { type: 'number' },
      },
      required: ['file', 'collection'],
      additionalProperties: false,
    },
  },
  {
    name: 'cabinet_add_record',
    description: 'Add one record to a collection. Writes also update the stored file.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        collection: { type: 'string' },
        record: { type: 'object' },
      },
      required: ['file', 'collection', 'record'],
      additionalProperties: false,
    },
  },
  {
    name: 'cabinet_update_record',
    description: 'Replace a record with the given JSON object.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        collection: { type: 'string' },
        recordId: { type: 'string' },
        record: { type: 'object' },
      },
      required: ['file', 'collection', 'recordId', 'record'],
      additionalProperties: false,
    },
  },
  {
    name: 'cabinet_delete_record',
    description: 'Delete one record from a collection.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        collection: { type: 'string' },
        recordId: { type: 'string' },
      },
      required: ['file', 'collection', 'recordId'],
      additionalProperties: false,
    },
  },
  {
    name: 'cabinet_read_file',
    description: 'Read a stored file again, optionally handing it to the model.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        mode: { type: 'string', enum: ['heuristic', 'ai'] },
      },
      required: ['file'],
      additionalProperties: false,
    },
  },
  {
    name: 'cabinet_stats',
    description: 'Totals for files, collections, records and trashed files.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

async function callTool(name, args = {}) {
  if (name === 'cabinet_stats') return client.stats()
  if (name === 'cabinet_list_files') return client.listFiles()

  const file = await client.resolveFile(args.file)
  if (name === 'cabinet_open_file') return client.detail(file.id)
  if (name === 'cabinet_query_records')
    return client.records(file.id, args.collection, {
      limit: args.limit,
      offset: args.offset,
      q: args.q,
      sort: args.sort,
      dir: args.direction,
      filter: args.filters ? JSON.stringify(args.filters) : undefined,
    })
  if (name === 'cabinet_add_record')
    return client.createRecord(file.id, args.collection, args.record)
  if (name === 'cabinet_update_record')
    return client.updateRecord(file.id, args.collection, args.recordId, args.record)
  if (name === 'cabinet_delete_record')
    return client.deleteRecord(file.id, args.collection, args.recordId)
  if (name === 'cabinet_read_file') return client.readFile(file.id, args.mode ?? 'heuristic')
  throw new Error(`Unknown tool “${name}”.`)
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handle(message) {
  const { id, method, params } = message
  if (id === undefined) return // notification

  try {
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'cabinet', version: '1.0.0' },
      })
    }
    if (method === 'ping') return reply(id, {})
    if (method === 'tools/list') return reply(id, { tools })
    if (method === 'tools/call') {
      try {
        const result = await callTool(params?.name, params?.arguments ?? {})
        return reply(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: false,
        })
      } catch (error) {
        return reply(id, {
          content: [{ type: 'text', text: error.message }],
          isError: true,
        })
      }
    }
    return replyError(id, -32601, `Unsupported method: ${method}`)
  } catch (error) {
    return replyError(id, -32603, error.message)
  }
}

let queue = Promise.resolve()
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      process.stderr.write('cabinet-mcp: ignored a malformed line\n')
      continue
    }
    queue = queue.then(() => handle(message))
  }
})
process.stdin.on('end', () => {
  queue.then(() => process.stdout.write('', () => process.exit(0)))
})
