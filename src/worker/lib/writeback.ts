import { serializeForFile } from './serialize'
import * as store from './store'
import type { Collection, Env, Format } from './types'

const KEEP_VERSIONS = 20

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Copy the current file bytes into history before a change. Identical bytes are
 * not stored twice, and only the newest versions are kept.
 */
export async function snapshotFile(
  env: Env,
  file: store.StoredFile,
  reason: string,
): Promise<void> {
  const object = await env.FILES.get(`files/${file.id}`)
  if (!object) return
  const bytes = new Uint8Array(await object.arrayBuffer())
  const hash = await sha256Hex(bytes)
  const latest = await store.latestVersion(env.DB, file.id)
  if (latest?.hash === hash) return

  const id = crypto.randomUUID()
  const key = `files/${file.id}/versions/${id}`
  await env.FILES.put(key, bytes, {
    httpMetadata: { contentType: 'application/octet-stream' },
  })
  await store.addVersion(env.DB, {
    id,
    fileId: file.id,
    revision: file.revision,
    size: bytes.byteLength,
    format: file.format,
    hash,
    reason,
    bytesKey: key,
  })
  for (const stale of await store.pruneVersions(env.DB, file.id, KEEP_VERSIONS))
    await env.FILES.delete(stale)
}

/**
 * Write the database's collections back into the stored source file. The file's
 * own format is kept where it can represent the data.
 */
export async function syncFileContent(env: Env, fileId: string): Promise<void> {
  const row = await store.getFileRow(env.DB, fileId)
  if (!row) return
  const file = store.toStoredFile(row)
  if (file.binary) return

  const collections: Collection[] = []
  for (const entry of await store.listCollections(env.DB, fileId)) {
    const page = await store.queryRecords(env.DB, fileId, entry.name, {
      limit: Math.max(entry.record_count, 1),
      offset: 0,
      direction: 'asc',
    })
    collections.push({ name: entry.name, records: page.records.map((record) => record.data) })
  }

  const content = serializeForFile(file.name, file.format as Format, collections)
  const bytes = new TextEncoder().encode(content.text)
  await env.FILES.put(`files/${fileId}`, bytes, {
    httpMetadata: { contentType: 'application/octet-stream' },
  })

  let notes = file.notes
  if (content.format !== file.format)
    notes = [
      ...notes.filter((note) => !note.startsWith('Stored as JSON because')),
      `Stored as JSON because ${file.ext || 'this format'} cannot hold the current collections.`,
    ]
  if (
    content.format === 'javascript' &&
    !notes.some((note) => note.startsWith('This JavaScript module'))
  )
    notes = [
      ...notes,
      'This JavaScript module was rewritten as `export default`; code outside the data is kept in the original upload and in history.',
    ]

  await store.updateFileMeta(env.DB, fileId, {
    format: content.format,
    size: bytes.byteLength,
    sourceHash: await sha256Hex(bytes),
    notes,
  })
}
