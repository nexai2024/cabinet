import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import type { Env } from '../lib/types'
import {
  collectionSchema,
  detailSchema,
  fileSchema,
  paramsSchema as idParams,
  violationSchema,
} from './files'
import { authResponses, errorSchema, json, keySecurity } from './shared'

type DocRoute = Parameters<typeof createRoute>[0]

const fileSummarySchema = fileSchema.extend({
  collectionCount: z.number(),
  recordCount: z.number(),
})

const versionSchema = z.object({
  id: z.string(),
  revision: z.number(),
  size: z.number(),
  format: z.string(),
  reason: z.string(),
  createdAt: z.string(),
})

const ruleSchema = z.object({
  id: z.string(),
  field: z.string(),
  rule: z.string(),
  value: z.any(),
  createdAt: z.string(),
})

const viewSchema = z.object({
  id: z.string(),
  fileId: z.string(),
  collection: z.string(),
  name: z.string(),
  query: z.record(z.string(), z.any()),
  createdAt: z.string(),
})

const shareSchema = z.object({
  id: z.string(),
  fileId: z.string(),
  collection: z.string().nullable(),
  expiresAt: z.string(),
  createdAt: z.string(),
})

const eventSchema = z.object({
  id: z.string(),
  fileId: z.string().nullable(),
  collection: z.string().nullable(),
  recordId: z.string().nullable(),
  action: z.string(),
  detail: z.record(z.string(), z.any()),
  createdAt: z.string(),
})

const filterSchema = z.object({
  field: z.string(),
  op: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'exists', 'empty']),
  value: z.any().optional(),
})

const collectionParams = z.object({ id: z.string(), collection: z.string() })
const versionParams = z.object({ id: z.string(), versionId: z.string() })
const ruleParams = z.object({ id: z.string(), collection: z.string(), ruleId: z.string() })
const viewParams = z.object({ id: z.string(), viewId: z.string() })
const shareParams = z.object({ id: z.string(), shareId: z.string() })
const tokenParams = z.object({ token: z.string() })

const writeHeaders = z.object({
  'x-cabinet-key': z.string().optional(),
  authorization: z.string().optional(),
  'if-match': z.string().optional(),
  'x-cabinet-force': z.string().optional(),
})

const binaryContent = {
  'application/octet-stream': {
    schema: z.string(),
  },
}

const schemaBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('rename_field'), from: z.string(), to: z.string() }),
  z.object({ action: z.literal('delete_field'), field: z.string() }),
  z.object({ action: z.literal('rename'), name: z.string() }),
  z.object({
    action: z.literal('retype'),
    field: z.string(),
    type: z.enum(['string', 'number', 'boolean']),
  }),
])

const bulkBody = z.object({
  action: z.enum(['delete', 'patch']),
  q: z.string().optional(),
  filters: z.array(filterSchema).optional(),
  ids: z.array(z.string()).optional(),
  patch: z.record(z.string(), z.any()).optional(),
  dryRun: z.boolean().optional(),
})

const dedupeBody = z.object({ key: z.string(), dryRun: z.boolean().optional() })

const ruleBody = z.object({
  field: z.string(),
  rule: z.enum(['required', 'type', 'unique', 'one_of', 'min', 'max']),
  value: z.any().optional(),
})

const viewBody = z.object({
  collection: z.string(),
  name: z.string(),
  query: z.record(z.string(), z.any()),
})

const shareBody = z.object({
  collection: z.string().optional(),
  ttlHours: z.number().int().min(1).max(720).optional(),
})

const askBody = z.object({
  collection: z.string(),
  question: z.string(),
  mode: z.enum(['query', 'fixes', 'mapping']).optional(),
  target: z.string().optional(),
})

const askResponse = z.union([
  z.object({
    mode: z.literal('query'),
    question: z.string(),
    explanation: z.string(),
    plan: z.object({
      filters: z.array(filterSchema),
      sort: z.string().optional(),
      direction: z.enum(['asc', 'desc']),
      limit: z.number(),
    }),
    redactions: z.number(),
    total: z.number(),
    records: z.array(z.record(z.string(), z.any())),
    revision: z.number(),
  }),
  z.object({
    mode: z.literal('mapping'),
    mapping: z.record(z.string(), z.string()),
    notes: z.string(),
    redactions: z.number(),
  }),
  z.object({
    mode: z.literal('fixes'),
    fixes: z.array(
      z.object({
        recordId: z.string(),
        field: z.string(),
        value: z.any(),
        reason: z.string(),
      }),
    ),
    notes: z.string(),
    redactions: z.number(),
    violations: z.array(violationSchema),
  }),
])

const routes: DocRoute[] = [
  {
    method: 'get',
    path: '/api/files/{id}/source',
    summary: 'Download the current stored file',
    request: { params: idParams },
    responses: {
      200: { description: 'The bytes as they are stored now.', content: binaryContent },
      404: { description: 'No such file or stored bytes.', content: json(errorSchema) },
    },
  },
  {
    method: 'get',
    path: '/api/files/{id}/original',
    summary: 'Download the untouched upload',
    request: { params: idParams },
    responses: {
      200: { description: 'The file exactly as it was uploaded.', content: binaryContent },
      404: { description: 'No such file or no kept upload.', content: json(errorSchema) },
    },
  },
  {
    method: 'get',
    path: '/api/files/{id}/export',
    summary: 'Download the collections as a data file',
    request: {
      params: idParams,
      query: z.object({
        format: z.enum(['json', 'ndjson', 'csv', 'xml', 'txt']).default('json'),
      }),
    },
    responses: {
      200: {
        description: 'Every collection in the requested format, sent as an attachment.',
        content: {
          'application/json': { schema: z.string() },
          'application/x-ndjson': { schema: z.string() },
          'text/csv': { schema: z.string() },
          'application/xml': { schema: z.string() },
          'text/plain': { schema: z.string() },
        },
      },
      400: { description: 'Unknown format.', content: json(errorSchema) },
      404: { description: 'No such file or it is in the trash.', content: json(errorSchema) },
    },
  },
  {
    method: 'get',
    path: '/api/files/{id}/versions',
    summary: 'List the versions kept for a file',
    request: { params: idParams },
    responses: {
      200: {
        description: 'Versions, newest first.',
        content: json(z.object({ versions: z.array(versionSchema) })),
      },
      404: { description: 'No such file.', content: json(errorSchema) },
    },
  },
  {
    method: 'post',
    path: '/api/files/{id}/versions/{versionId}/restore',
    summary: 'Roll the stored file back to a version',
    request: { params: versionParams, headers: writeHeaders },
    responses: {
      200: { description: 'The restored file and its collections.', content: json(detailSchema) },
      404: { description: 'No such file or version.', content: json(errorSchema) },
      409: { description: 'Stale revision.', content: json(errorSchema) },
    },
  },
  {
    method: 'get',
    path: '/api/trash',
    summary: 'List trashed files',
    responses: {
      200: {
        description: 'Files that can still be restored or purged.',
        content: json(z.object({ files: z.array(fileSummarySchema) })),
      },
    },
  },
  {
    method: 'post',
    path: '/api/files/{id}/restore',
    summary: 'Restore a file from the trash',
    request: { params: idParams, headers: writeHeaders },
    responses: {
      200: { description: 'The restored file.', content: json(detailSchema) },
      404: { description: 'No such file.', content: json(errorSchema) },
      409: { description: 'That file is not in the trash.', content: json(errorSchema) },
    },
  },
  {
    method: 'delete',
    path: '/api/files/{id}/purge',
    summary: 'Delete a trashed file and its history for good',
    request: { params: idParams, headers: writeHeaders },
    responses: {
      200: { description: 'The file is gone.', content: json(z.object({ ok: z.boolean() })) },
      404: { description: 'No such file.', content: json(errorSchema) },
      409: { description: 'Move the file to the trash first.', content: json(errorSchema) },
    },
  },
  {
    method: 'delete',
    path: '/api/trash',
    summary: 'Empty the trash',
    request: { headers: writeHeaders },
    responses: {
      200: {
        description: 'Every trashed file was purged.',
        content: json(z.object({ ok: z.boolean(), purged: z.number() })),
      },
    },
  },
  {
    method: 'post',
    path: '/api/files/{id}/collections/{collection}/schema',
    summary: 'Rename, retype or drop a field, or rename the collection',
    request: {
      params: collectionParams,
      body: { required: true, content: json(schemaBody) },
      headers: writeHeaders,
    },
    responses: {
      200: {
        description: 'The changed file, with how many rows changed or were skipped.',
        content: json(detailSchema.extend({ changed: z.number(), failed: z.number().optional() })),
      },
      400: { description: 'Invalid change.', content: json(errorSchema) },
      404: { description: 'No such file or collection.', content: json(errorSchema) },
      409: { description: 'Name clash, stale revision or an outside change.', content: json(errorSchema) },
    },
  },
  {
    method: 'delete',
    path: '/api/files/{id}/collections/{collection}',
    summary: 'Drop a collection and its records',
    request: { params: collectionParams, headers: writeHeaders },
    responses: {
      200: { description: 'The file without that collection.', content: json(detailSchema) },
      404: { description: 'No such file or collection.', content: json(errorSchema) },
      409: { description: 'Stale revision or an outside change.', content: json(errorSchema) },
    },
  },
  {
    method: 'post',
    path: '/api/files/{id}/collections/{collection}/import',
    summary: 'Append or upsert records from a file',
    request: {
      params: collectionParams,
      query: z.object({
        name: z.string().optional(),
        mode: z.enum(['append', 'upsert']).optional(),
        key: z.string().optional(),
      }),
      body: { required: true, content: binaryContent },
      headers: writeHeaders,
    },
    responses: {
      200: {
        description: 'How many rows were added, updated or rejected.',
        content: json(
          z.object({
            inserted: z.number(),
            updated: z.number(),
            skipped: z.number(),
            truncated: z.boolean(),
            violations: z.array(violationSchema),
            revision: z.number(),
          }),
        ),
      },
      400: { description: 'Missing key or empty import.', content: json(errorSchema) },
      404: { description: 'No such file or collection.', content: json(errorSchema) },
      409: { description: 'Stale revision or an outside change.', content: json(errorSchema) },
      422: { description: 'No records could be read.', content: json(errorSchema) },
    },
  },
  {
    method: 'post',
    path: '/api/files/{id}/collections/{collection}/bulk',
    summary: 'Patch or delete many records at once',
    request: {
      params: collectionParams,
      body: { required: true, content: json(bulkBody) },
      headers: writeHeaders,
    },
    responses: {
      200: {
        description: 'Matched and changed counts, plus the new revision.',
        content: json(
          z.object({
            matched: z.number(),
            applied: z.number(),
            dryRun: z.boolean().optional(),
            truncated: z.boolean().optional(),
            revision: z.number(),
          }),
        ),
      },
      400: { description: 'Invalid patch or body.', content: json(errorSchema) },
      404: { description: 'No such file or collection.', content: json(errorSchema) },
      409: { description: 'Stale revision or an outside change.', content: json(errorSchema) },
      422: { description: 'The patch would break a collection rule.', content: json(errorSchema) },
    },
  },
  {
    method: 'get',
    path: '/api/files/{id}/collections/{collection}/duplicates',
    summary: 'Group records that share a field value',
    request: {
      params: collectionParams,
      query: z.object({ key: z.string() }),
    },
    responses: {
      200: {
        description: 'Groups with more than one record.',
        content: json(
          z.object({
            key: z.string(),
            groups: z.array(
              z.object({ value: z.any(), count: z.number(), ids: z.array(z.string()) }),
            ),
          }),
        ),
      },
      400: { description: 'Choose a field to compare on.', content: json(errorSchema) },
      404: { description: 'No such file or collection.', content: json(errorSchema) },
    },
  },
  {
    method: 'post',
    path: '/api/files/{id}/collections/{collection}/dedupe',
    summary: 'Delete later copies of duplicate rows',
    request: {
      params: collectionParams,
      body: { required: true, content: json(dedupeBody) },
      headers: writeHeaders,
    },
    responses: {
      200: {
        description: 'Group and removal counts.',
        content: json(
          z.object({
            key: z.string(),
            groups: z.number(),
            duplicates: z.number().optional(),
            removed: z.number(),
          }),
        ),
      },
      400: { description: 'Invalid key.', content: json(errorSchema) },
      404: { description: 'No such file or collection.', content: json(errorSchema) },
      409: { description: 'Stale revision or an outside change.', content: json(errorSchema) },
    },
  },
  {
    method: 'get',
    path: '/api/files/{id}/collections/{collection}/rules',
    summary: 'List the validation rules of a collection',
    request: { params: collectionParams },
    responses: {
      200: {
        description: 'Rules in creation order.',
        content: json(z.object({ rules: z.array(ruleSchema) })),
      },
      404: { description: 'No such file or collection.', content: json(errorSchema) },
    },
  },
  {
    method: 'post',
    path: '/api/files/{id}/collections/{collection}/rules',
    summary: 'Add a validation rule',
    request: {
      params: collectionParams,
      body: { required: true, content: json(ruleBody) },
      headers: writeHeaders,
    },
    responses: {
      201: {
        description: 'The created rule.',
        content: json(z.object({ rule: ruleSchema })),
      },
      400: { description: 'Invalid rule.', content: json(errorSchema) },
      404: { description: 'No such file or collection.', content: json(errorSchema) },
    },
  },
  {
    method: 'delete',
    path: '/api/files/{id}/collections/{collection}/rules/{ruleId}',
    summary: 'Remove a validation rule',
    request: { params: ruleParams, headers: writeHeaders },
    responses: {
      200: { description: 'The rule is gone.', content: json(z.object({ ok: z.boolean() })) },
      404: { description: 'No such rule.', content: json(errorSchema) },
    },
  },
  {
    method: 'get',
    path: '/api/files/{id}/collections/{collection}/validate',
    summary: 'Report records that break the rules',
    request: { params: collectionParams },
    responses: {
      200: {
        description: 'Current violations, up to 200.',
        content: json(
          z.object({
            rules: z.number(),
            rows: z.number(),
            violations: z.array(violationSchema),
            count: z.number().optional(),
          }),
        ),
      },
      404: { description: 'No such file or collection.', content: json(errorSchema) },
    },
  },
  {
    method: 'get',
    path: '/api/files/{id}/views',
    summary: 'List saved views of a file',
    request: { params: idParams },
    responses: {
      200: {
        description: 'Saved filters and sorts.',
        content: json(z.object({ views: z.array(viewSchema) })),
      },
      404: { description: 'No such file.', content: json(errorSchema) },
    },
  },
  {
    method: 'post',
    path: '/api/files/{id}/views',
    summary: 'Save a view',
    request: {
      params: idParams,
      body: { required: true, content: json(viewBody) },
      headers: writeHeaders,
    },
    responses: {
      201: {
        description: 'The saved view.',
        content: json(z.object({ view: viewSchema })),
      },
      400: { description: 'Invalid view.', content: json(errorSchema) },
      404: { description: 'No such file or collection.', content: json(errorSchema) },
    },
  },
  {
    method: 'delete',
    path: '/api/files/{id}/views/{viewId}',
    summary: 'Delete a saved view',
    request: { params: viewParams, headers: writeHeaders },
    responses: {
      200: { description: 'The view is gone.', content: json(z.object({ ok: z.boolean() })) },
      404: { description: 'No such view.', content: json(errorSchema) },
    },
  },
  {
    method: 'get',
    path: '/api/files/{id}/shares',
    summary: 'List read-only links for a file',
    request: { params: idParams },
    responses: {
      200: {
        description: 'Share links with their public URLs.',
        content: json(
          z.object({ shares: z.array(shareSchema.extend({ url: z.string() })) }),
        ),
      },
      404: { description: 'No such file.', content: json(errorSchema) },
    },
  },
  {
    method: 'post',
    path: '/api/files/{id}/shares',
    summary: 'Create an expiring read-only link',
    request: {
      params: idParams,
      body: { required: true, content: json(shareBody) },
      headers: writeHeaders,
    },
    responses: {
      201: {
        description: 'The share and the URL to hand out.',
        content: json(z.object({ share: shareSchema, url: z.string() })),
      },
      400: { description: 'Invalid lifetime or body.', content: json(errorSchema) },
      404: { description: 'No such file or collection.', content: json(errorSchema) },
    },
  },
  {
    method: 'delete',
    path: '/api/files/{id}/shares/{shareId}',
    summary: 'Revoke a share link',
    request: { params: shareParams, headers: writeHeaders },
    responses: {
      200: { description: 'The link no longer works.', content: json(z.object({ ok: z.boolean() })) },
      404: { description: 'No such share.', content: json(errorSchema) },
    },
  },
  {
    method: 'get',
    path: '/api/share/{token}',
    summary: 'Read a shared file snapshot',
    request: { params: tokenParams },
    responses: {
      200: {
        description: 'The shared file and up to 1000 rows per collection.',
        content: json(
          z.object({
            file: z.object({
              name: z.string(),
              format: z.string(),
              size: z.number(),
              updatedAt: z.string(),
            }),
            expiresAt: z.string(),
            collections: z.array(
              z.object({
                name: z.string(),
                recordCount: z.number(),
                records: z.array(z.record(z.string(), z.any())),
              }),
            ),
          }),
        ),
      },
      404: { description: 'The link is invalid, expired or the file is gone.', content: json(errorSchema) },
    },
  },
  {
    method: 'get',
    path: '/api/files/{id}/events',
    summary: 'Audit trail for one file',
    request: {
      params: idParams,
      query: z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }),
    },
    responses: {
      200: {
        description: 'Recent events, newest first.',
        content: json(z.object({ events: z.array(eventSchema) })),
      },
      404: { description: 'No such file.', content: json(errorSchema) },
    },
  },
  {
    method: 'get',
    path: '/api/events',
    summary: 'Recent events across the cabinet',
    request: {
      query: z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }),
    },
    responses: {
      200: {
        description: 'Recent events, newest first.',
        content: json(z.object({ events: z.array(eventSchema) })),
      },
    },
  },
  {
    method: 'post',
    path: '/api/files/{id}/ask',
    summary: 'Ask the model about a collection',
    request: {
      params: idParams,
      body: { required: true, content: json(askBody) },
      headers: writeHeaders,
    },
    responses: {
      200: { description: 'Query results, proposed fixes or a field mapping.', content: json(askResponse) },
      400: { description: 'No model key is configured.', content: json(errorSchema) },
      404: { description: 'No such file or collection.', content: json(errorSchema) },
      422: { description: 'Nothing to look at.', content: json(errorSchema) },
      502: { description: 'The model service failed.', content: json(errorSchema) },
    },
  },
]

/**
 * The routes in `extras.ts` are plain Hono handlers that validate their own
 * bodies, so their documentation is registered here instead of through
 * `app.openapi`. A test asserts every `/api` route appears in this document.
 */
const MUTATING = new Set(['post', 'put', 'patch', 'delete'])

export function registerExtraDocs(app: OpenAPIHono<{ Bindings: Env }>) {
  for (const route of routes) {
    if (!MUTATING.has(route.method)) {
      app.openAPIRegistry.registerPath(createRoute(route) as never)
      continue
    }
    app.openAPIRegistry.registerPath(
      createRoute({
        ...route,
        security: keySecurity,
        responses: { ...authResponses, ...route.responses },
      } as never) as never,
    )
  }
}
